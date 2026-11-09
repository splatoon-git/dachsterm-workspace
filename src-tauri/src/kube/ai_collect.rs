//! `kube_ai`: finds vLLM and GPU exporter pods and reads their metrics (design KV.10). The web view
//! names no port or path. Detection fills a list held here, and only what is on that list is read,
//! with `get --raw`, which is a GET and nothing else.
use super::{
    ai_detect::{AiKind, AiTarget, detect},
    ai_parse::{GpuDevice, VllmSeries, parse_gpu, parse_vllm},
    metrics::pod_proxy_path,
    runner::{Kubectl, Runner},
    settings::KubeSettings,
    state::{KubeState, ProxyRead, classify_proxy},
    templates,
};
use crate::{
    remote_exec::{Limits, quote},
    ssh::Host,
};
use russh::client;
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::Semaphore, task::JoinSet};

/// As the tree's pod list: the same size of answer.
const LIST_LIMITS: Limits = Limits {
    timeout: Duration::from_secs(20),
    max_output: 32 * 1024 * 1024,
};
const LIST_REQUEST_SECONDS: u32 = 15;
const READ_LIMITS: Limits = Limits {
    timeout: Duration::from_secs(5),
    max_output: 8 * 1024 * 1024,
};
const READ_REQUEST_SECONDS: u32 = 3;
/// How long a detection stands. A pod replaced in that time reads as unreachable until the next.
const STANDS: Duration = Duration::from_secs(30);
/// A cluster with nothing to read should cost next to nothing.
const STANDS_WHEN_EMPTY: Duration = Duration::from_secs(120);
const MAX_VLLM_PODS: usize = 64;
const MAX_EXPORTERS: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScrapeStatus {
    Ok,
    /// RBAC refused `pods/proxy`, or the endpoint has its own auth.
    Forbidden,
    Unreachable,
    /// The endpoint answered with something other than this engine's metrics.
    NoSupported,
    /// The pod's annotation names a path or port that is not allowed. Nothing was requested.
    InvalidTarget,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VllmSample {
    at_ms: u64,
    process_start: Option<f64>,
    series: Vec<VllmSeries>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VllmPod {
    namespace: String,
    pod: String,
    node: String,
    identity: String,
    status: ScrapeStatus,
    endpoint: String,
    sample: Option<VllmSample>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exporter {
    namespace: String,
    pod: String,
    node: String,
    status: ScrapeStatus,
    endpoint: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRead {
    state: KubeState,
    pods: Vec<VllmPod>,
    exporters: Vec<Exporter>,
    gpus: Vec<GpuDevice>,
    /// Targets left out by the limit on how many are read.
    capped: usize,
    /// GPU exporters outside the namespace could not be listed.
    gpu_restricted: bool,
    elapsed_ms: u64,
}

#[derive(Clone)]
struct Detected {
    settings: KubeSettings,
    at: Instant,
    targets: Arc<Vec<AiTarget>>,
    capped: usize,
    gpu_restricted: bool,
}

impl Detected {
    fn stands(&self, settings: &KubeSettings) -> bool {
        let life = if self.targets.is_empty() {
            STANDS_WHEN_EMPTY
        } else {
            STANDS
        };
        self.settings == *settings && self.at.elapsed() < life
    }
}

/// What detection found, per connection. It is both a cache and the list of what may be read.
#[derive(Default)]
pub struct AiTargets(Mutex<HashMap<String, Detected>>);

impl AiTargets {
    fn standing(&self, id: &str, settings: &KubeSettings) -> Option<Detected> {
        let found = self.0.lock().unwrap().get(id).cloned();
        found.filter(|detected| detected.stands(settings))
    }

    /// Older entries belong to closed connections or changed settings, so they go here too.
    fn keep(&self, id: &str, detected: Detected) {
        let mut all = self.0.lock().unwrap();
        all.retain(|_, entry| entry.at.elapsed() < STANDS_WHEN_EMPTY);
        all.insert(id.to_string(), detected);
    }
}

fn kubectl(kube: &KubeSettings) -> Kubectl<'_> {
    Kubectl {
        command: &kube.kubectl,
        kubeconfig: &kube.kubeconfig,
    }
}

fn list_command(kube: &KubeSettings, scope: &str) -> String {
    kubectl(kube).cluster_within(
        &kube.context,
        LIST_REQUEST_SECONDS,
        &format!(
            "get pods {scope} -o go-template={}",
            quote(templates::AI_PODS)
        ),
    )
}

/// Caps each kind on its own, so a thousand exporters cannot hide the model pods.
fn capped(mut targets: Vec<AiTarget>) -> (Vec<AiTarget>, usize) {
    targets.sort_by(|a, b| (&a.namespace, &a.pod).cmp(&(&b.namespace, &b.pod)));
    targets.dedup_by(|a, b| a.namespace == b.namespace && a.pod == b.pod);
    let before = targets.len();
    let mut vllm = 0;
    let mut exporters = 0;
    targets.retain(|target| {
        let (count, limit) = match target.kind {
            AiKind::Vllm => (&mut vllm, MAX_VLLM_PODS),
            AiKind::Dcgm => (&mut exporters, MAX_EXPORTERS),
        };
        *count += 1;
        *count <= limit
    });
    let left_out = before - targets.len();
    (targets, left_out)
}

async fn discover(runner: &Runner<'_>, kube: &KubeSettings) -> Result<Detected, KubeState> {
    let namespaced = !kube.namespace.is_empty();
    let scope = if namespaced {
        format!("-n {}", quote(&kube.namespace))
    } else {
        "-A".to_string()
    };
    let output = runner
        .kubectl_bounded(&list_command(kube, &scope), LIST_LIMITS)
        .await?;
    let rows = String::from_utf8_lossy(&output.stdout);
    let mut targets = detect(&rows, &kube.namespace, false);
    // Exporters usually live in their own namespace. Without that list the model pods still count.
    let mut gpu_restricted = false;
    if namespaced {
        match runner
            .kubectl_bounded(&list_command(kube, "-A"), LIST_LIMITS)
            .await
        {
            Ok(all) => targets.extend(detect(&String::from_utf8_lossy(&all.stdout), "", true)),
            Err(_) => gpu_restricted = true,
        }
    }
    let (targets, capped) = capped(targets);
    Ok(Detected {
        settings: kube.clone(),
        at: Instant::now(),
        targets: Arc::new(targets),
        capped,
        gpu_restricted,
    })
}

/// The whole of what the proxy is asked: a detected pod, one of its ports, its checked path.
fn read_command(kube: &KubeSettings, target: &AiTarget, port: u16, path: &str) -> String {
    let url = pod_proxy_path(&target.namespace, &target.pod, port, path, false);
    kubectl(kube).cluster_within(
        &kube.context,
        READ_REQUEST_SECONDS,
        &format!("get --raw {}", quote(&url)),
    )
}

fn endpoint_of(target: &AiTarget, port: u16, path: &str) -> String {
    pod_proxy_path(&target.namespace, &target.pod, port, path, false)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |at| u64::try_from(at.as_millis()).unwrap_or(u64::MAX))
}

enum Answer {
    Pod(VllmSample),
    Devices(Vec<GpuDevice>),
}

struct Scraped {
    status: ScrapeStatus,
    endpoint: String,
    answer: Option<Answer>,
}

fn understood(target: &AiTarget, text: &str, at_ms: u64) -> Option<Answer> {
    match target.kind {
        AiKind::Vllm => parse_vllm(text).map(|parsed| {
            Answer::Pod(VllmSample {
                at_ms,
                process_start: parsed.process_start,
                series: parsed.series,
            })
        }),
        AiKind::Dcgm => {
            let devices = parse_gpu(text, &target.node);
            (!devices.is_empty()).then_some(Answer::Devices(devices))
        }
    }
}

/// Tries the target's ports in turn, stopping at a refusal: another port would be refused too.
async fn scrape(runner: &Runner<'_>, kube: &KubeSettings, target: &AiTarget) -> Scraped {
    let Some(path) = target.path.as_deref().filter(|_| !target.ports.is_empty()) else {
        return Scraped {
            status: ScrapeStatus::InvalidTarget,
            endpoint: String::new(),
            answer: None,
        };
    };
    let mut status = ScrapeStatus::Unreachable;
    let mut endpoint = String::new();
    for port in target.ports.iter().copied() {
        endpoint = endpoint_of(target, port, path);
        let command = read_command(kube, target, port, path);
        let Ok(output) = runner.script(&command, READ_LIMITS).await else {
            status = ScrapeStatus::Unreachable;
            continue;
        };
        match classify_proxy(output.exit, &output.stderr) {
            ProxyRead::Blocked(KubeState::Forbidden | KubeState::AuthFailed) => {
                status = ScrapeStatus::Forbidden;
                break;
            }
            ProxyRead::Answered => {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Some(answer) = understood(target, &text, now_ms()) {
                    return Scraped {
                        status: ScrapeStatus::Ok,
                        endpoint,
                        answer: Some(answer),
                    };
                }
                status = ScrapeStatus::NoSupported;
            }
            _ => status = ScrapeStatus::Unreachable,
        }
    }
    Scraped {
        status,
        endpoint,
        answer: None,
    }
}

/// Four at a time per connection, shared with the worker watch (KV.9).
async fn scrape_all(
    handle: Arc<client::Handle<Host>>,
    slot: Arc<Semaphore>,
    kube: KubeSettings,
    targets: Arc<Vec<AiTarget>>,
) -> Vec<Scraped> {
    let mut running = JoinSet::new();
    for index in 0..targets.len() {
        let (handle, slot, kube, targets) =
            (handle.clone(), slot.clone(), kube.clone(), targets.clone());
        running.spawn(async move {
            let _turn = slot.acquire_owned().await;
            (
                index,
                scrape(&Runner::Ssh(&handle), &kube, &targets[index]).await,
            )
        });
    }
    let mut done: Vec<(usize, Scraped)> = Vec::with_capacity(targets.len());
    while let Some(finished) = running.join_next().await {
        if let Ok(item) = finished {
            done.push(item);
        }
    }
    done.sort_by_key(|(index, _)| *index);
    done.into_iter().map(|(_, item)| item).collect()
}

/// A device two exporters report counts once, or its utilisation would multiply.
fn merge_devices(found: Vec<Vec<GpuDevice>>) -> Vec<GpuDevice> {
    let mut seen = HashSet::new();
    let mut devices: Vec<GpuDevice> = found
        .into_iter()
        .flatten()
        .filter(|device| seen.insert((device.node.clone(), device.id.clone())))
        .collect();
    devices.sort_by(|a, b| (&a.node, &a.id).cmp(&(&b.node, &b.id)));
    devices
}

fn assemble(detected: &Detected, scraped: Vec<Scraped>, elapsed_ms: u64) -> AiRead {
    let mut pods = Vec::new();
    let mut exporters = Vec::new();
    let mut found = Vec::new();
    for (target, item) in detected.targets.iter().zip(scraped) {
        let (sample, devices) = match item.answer {
            Some(Answer::Pod(sample)) => (Some(sample), None),
            Some(Answer::Devices(devices)) => (None, Some(devices)),
            None => (None, None),
        };
        found.extend(devices);
        match target.kind {
            AiKind::Vllm => pods.push(VllmPod {
                namespace: target.namespace.clone(),
                pod: target.pod.clone(),
                node: target.node.clone(),
                identity: target.identity.clone(),
                status: item.status,
                endpoint: item.endpoint,
                sample,
            }),
            AiKind::Dcgm => exporters.push(Exporter {
                namespace: target.namespace.clone(),
                pod: target.pod.clone(),
                node: target.node.clone(),
                status: item.status,
                endpoint: item.endpoint,
            }),
        }
    }
    AiRead {
        state: KubeState::Ready,
        pods,
        exporters,
        gpus: merge_devices(found),
        capped: detected.capped,
        gpu_restricted: detected.gpu_restricted,
        elapsed_ms,
    }
}

fn failed(state: KubeState, elapsed_ms: u64) -> AiRead {
    AiRead {
        state,
        pods: Vec::new(),
        exporters: Vec::new(),
        gpus: Vec::new(),
        capped: 0,
        gpu_restricted: false,
        elapsed_ms,
    }
}

pub async fn collect(
    registry: &AiTargets,
    handle: Arc<client::Handle<Host>>,
    slot: Arc<Semaphore>,
    id: &str,
    kube: &KubeSettings,
) -> AiRead {
    let started = Instant::now();
    let elapsed = |at: Instant| u64::try_from(at.elapsed().as_millis()).unwrap_or(u64::MAX);
    let detected = match registry.standing(id, kube) {
        Some(detected) => detected,
        None => {
            let listed = {
                let _turn = slot.clone().acquire_owned().await;
                discover(&Runner::Ssh(&handle), kube).await
            };
            match listed {
                Ok(detected) => {
                    registry.keep(id, detected.clone());
                    detected
                }
                // Not kept: the next poll should try again rather than wait out the cache.
                Err(state) => return failed(state, elapsed(started)),
            }
        }
    };
    let scraped = scrape_all(handle, slot, kube.clone(), detected.targets.clone()).await;
    assemble(&detected, scraped, elapsed(started))
}

#[cfg(all(test, unix))]
impl VllmPod {
    pub(super) fn status(&self) -> ScrapeStatus {
        self.status
    }
    pub(super) fn endpoint(&self) -> &str {
        &self.endpoint
    }
    pub(super) fn has_sample(&self) -> bool {
        self.sample.is_some()
    }
}

#[cfg(all(test, unix))]
impl AiRead {
    pub(super) fn pod_named(&self, name: &str) -> Option<&VllmPod> {
        self.pods.iter().find(|item| item.pod == name)
    }
    pub(super) fn state(&self) -> &KubeState {
        &self.state
    }
    pub(super) fn exporters_ok(&self) -> usize {
        self.exporters
            .iter()
            .filter(|item| item.status == ScrapeStatus::Ok)
            .count()
    }
    pub(super) fn devices(&self) -> usize {
        self.gpus.len()
    }
    pub(super) fn gpu_restricted(&self) -> bool {
        self.gpu_restricted
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> KubeSettings {
        KubeSettings {
            context: "prod".into(),
            namespace: String::new(),
            kubectl: "kubectl".into(),
            kubeconfig: String::new(),
            operate: false,
        }
    }

    fn target(kind: AiKind, namespace: &str, pod: &str) -> AiTarget {
        AiTarget {
            kind,
            namespace: namespace.into(),
            pod: pod.into(),
            node: "gpu-1".into(),
            identity: "u|0".into(),
            ports: vec![8000],
            path: Some("/metrics".into()),
        }
    }

    fn detected(targets: Vec<AiTarget>) -> Detected {
        Detected {
            settings: settings(),
            at: Instant::now(),
            targets: Arc::new(targets),
            capped: 0,
            gpu_restricted: false,
        }
    }

    #[test]
    fn a_read_is_one_get_of_the_detected_pod_port_and_path() {
        let command = read_command(
            &settings(),
            &target(AiKind::Vllm, "ai", "serve-0"),
            8000,
            "/metrics",
        );
        assert_eq!(
            command,
            "kubectl --context 'prod' --request-timeout=3s get --raw '/api/v1/namespaces/ai/pods/serve-0:8000/proxy/metrics'"
        );
    }

    #[test]
    fn a_detection_stands_for_its_settings_and_its_time_only() {
        let registry = AiTargets::default();
        registry.keep("c1", detected(vec![target(AiKind::Vllm, "ai", "a")]));
        assert!(registry.standing("c1", &settings()).is_some());
        assert!(registry.standing("c2", &settings()).is_none());
        let mut other = settings();
        other.namespace = "ai".into();
        assert!(registry.standing("c1", &other).is_none());

        let mut old = detected(vec![target(AiKind::Vllm, "ai", "a")]);
        old.at = Instant::now() - STANDS - Duration::from_secs(1);
        assert!(!old.stands(&settings()));
    }

    #[test]
    fn finding_nothing_is_remembered_for_longer() {
        let mut empty = detected(Vec::new());
        empty.at = Instant::now() - STANDS - Duration::from_secs(1);
        assert!(empty.stands(&settings()));
        empty.at = Instant::now() - STANDS_WHEN_EMPTY - Duration::from_secs(1);
        assert!(!empty.stands(&settings()));
    }

    #[test]
    fn entries_of_connections_long_gone_are_dropped() {
        let registry = AiTargets::default();
        let mut stale = detected(Vec::new());
        stale.at = Instant::now() - STANDS_WHEN_EMPTY - Duration::from_secs(1);
        registry.0.lock().unwrap().insert("closed".into(), stale);
        registry.keep("live", detected(Vec::new()));
        let kept: Vec<String> = registry.0.lock().unwrap().keys().cloned().collect();
        assert_eq!(kept, ["live"]);
    }

    #[test]
    fn each_kind_has_its_own_limit_and_duplicates_count_once() {
        let mut targets: Vec<AiTarget> = (0..MAX_VLLM_PODS + 3)
            .map(|i| target(AiKind::Vllm, "ai", &format!("v-{i:03}")))
            .collect();
        targets
            .extend((0..MAX_EXPORTERS + 2).map(|i| target(AiKind::Dcgm, "gpu", &format!("e-{i}"))));
        targets.push(target(AiKind::Vllm, "ai", "v-000"));
        let (kept, left_out) = capped(targets);
        assert_eq!(left_out, 5);
        let count = |kind| kept.iter().filter(|t| t.kind == kind).count();
        assert_eq!(count(AiKind::Vllm), MAX_VLLM_PODS);
        assert_eq!(count(AiKind::Dcgm), MAX_EXPORTERS);
    }

    #[test]
    fn a_device_reported_by_two_exporters_counts_once() {
        let device = |node: &str, id: &str, util: f64| GpuDevice {
            node: node.into(),
            id: id.into(),
            util: Some(util),
            ..GpuDevice::default()
        };
        let merged = merge_devices(vec![
            vec![device("n2", "a", 1.0), device("n1", "a", 2.0)],
            vec![device("n1", "a", 99.0), device("n1", "b", 3.0)],
        ]);
        let shown: Vec<(&str, &str, Option<f64>)> = merged
            .iter()
            .map(|d| (d.node.as_str(), d.id.as_str(), d.util))
            .collect();
        assert_eq!(
            shown,
            [
                ("n1", "a", Some(2.0)),
                ("n1", "b", Some(3.0)),
                ("n2", "a", Some(1.0))
            ]
        );
    }

    #[test]
    fn a_pod_and_its_status_reach_the_screen() {
        let found = detected(vec![
            target(AiKind::Vllm, "ai", "serve-0"),
            target(AiKind::Dcgm, "gpu", "exporter"),
        ]);
        let read = assemble(
            &found,
            vec![
                Scraped {
                    status: ScrapeStatus::Forbidden,
                    endpoint: "/x".into(),
                    answer: None,
                },
                Scraped {
                    status: ScrapeStatus::Ok,
                    endpoint: "/y".into(),
                    answer: Some(Answer::Devices(vec![GpuDevice {
                        node: "gpu-1".into(),
                        id: "a".into(),
                        ..GpuDevice::default()
                    }])),
                },
            ],
            7,
        );
        assert_eq!(read.state, KubeState::Ready);
        assert_eq!(read.pods[0].status, ScrapeStatus::Forbidden);
        assert_eq!(read.exporters[0].status, ScrapeStatus::Ok);
        assert_eq!(read.gpus.len(), 1);
        assert_eq!(read.elapsed_ms, 7);
    }

    #[test]
    fn a_pods_sample_is_passed_on() {
        let found = detected(vec![target(AiKind::Vllm, "ai", "serve-0")]);
        let read = assemble(
            &found,
            vec![Scraped {
                status: ScrapeStatus::Ok,
                endpoint: "/x".into(),
                answer: Some(Answer::Pod(VllmSample {
                    at_ms: 5,
                    process_start: Some(1.0),
                    series: Vec::new(),
                })),
            }],
            1,
        );
        assert_eq!(read.pods[0].sample.as_ref().map(|s| s.at_ms), Some(5));
        assert!(read.gpus.is_empty());
    }

    /// `aiTypes.ts` declares these by hand, and a misspelled field would only read as unknown.
    #[test]
    fn the_answer_has_the_field_names_the_screen_reads() {
        let found = detected(vec![target(AiKind::Vllm, "ai", "serve-0")]);
        let read = assemble(
            &found,
            vec![Scraped {
                status: ScrapeStatus::Ok,
                endpoint: "/x".into(),
                answer: Some(Answer::Pod(VllmSample {
                    at_ms: 5,
                    process_start: Some(1.0),
                    series: vec![VllmSeries {
                        metric: crate::kube::ai_parse::VllmMetric::TtftSum,
                        model: "m".into(),
                        labels: "l".into(),
                        value: 2.0,
                    }],
                })),
            }],
            1,
        );
        let json = serde_json::to_value(&read).unwrap();
        assert_eq!(json["state"]["kind"], "ready");
        assert_eq!(json["gpuRestricted"], false);
        assert_eq!(json["elapsedMs"], 1);
        let sample = &json["pods"][0]["sample"];
        assert_eq!(sample["atMs"], 5);
        assert_eq!(sample["processStart"], 1.0);
        assert_eq!(sample["series"][0]["metric"], "ttftSum");
    }

    #[test]
    fn a_status_serializes_as_the_screen_expects() {
        let text = |status| serde_json::to_string(&status).unwrap();
        assert_eq!(text(ScrapeStatus::NoSupported), "\"noSupported\"");
        assert_eq!(text(ScrapeStatus::InvalidTarget), "\"invalidTarget\"");
    }
}
