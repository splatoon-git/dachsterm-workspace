//! `kube_metrics`: Prometheus text read through the API server's proxy (design KV.9). GET only, and
//! only paths shaped like a metrics endpoint. What comes back is untrusted and shown as text.
use super::{
    runner::{Kubectl, Runner},
    settings::{KubeSettings, check_namespace, check_node, check_pod},
    snapshot::shown,
    state::{KubeState, NoMetrics, ProxyRead, classify, classify_proxy},
};
use crate::{
    remote_exec::{Limits, quote},
    storage::Result,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};

const POD_READ: Limits = Limits {
    timeout: Duration::from_secs(10),
    max_output: 8 * 1024 * 1024,
};
const POD_REQUEST_SECONDS: u32 = 8;
/// A small test node already answers with 411KB (KV.0), and it is read for one pod on request.
const NODE_READ: Limits = Limits {
    timeout: Duration::from_secs(14),
    max_output: 32 * 1024 * 1024,
};
const NODE_REQUEST_SECONDS: u32 = 12;

const MAX_PATH: usize = 128;
const MAX_ONLY: usize = 16;
const MAX_SERIES: usize = 4000;
const MAX_METRIC_NAME: usize = 256;
const MAX_LABELS: usize = 512;
const MAX_CANDIDATES: usize = 8;

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum MetricsTarget {
    /// Where this pod might serve metrics, from its spec. Nothing is contacted yet.
    Candidates { namespace: String, pod: String },
    Pod {
        namespace: String,
        pod: String,
        port: u16,
        path: String,
        https: bool,
        /// The metric names to return. Empty counts the series and returns none, which is all a
        /// candidate check needs. Absent returns everything up to the limit.
        only: Option<Vec<String>>,
    },
    /// `container_threads` from the kubelet of the node this pod is on.
    Threads {
        namespace: String,
        pod: String,
        node: String,
    },
}

/// A path that names a metrics endpoint and nothing else the proxy could reach: no query, no `..`.
fn is_metrics_path(path: &str) -> bool {
    let Some(rest) = path.strip_prefix('/') else {
        return false;
    };
    let segments: Vec<&str> = rest.split('/').collect();
    let plain = |segment: &&str| {
        !segment.is_empty()
            && *segment != "."
            && *segment != ".."
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    let names_metrics = segments
        .last()
        .is_some_and(|last| last.contains("metrics") || last.contains("prometheus"));
    path.len() <= MAX_PATH && segments.iter().all(plain) && names_metrics
}

fn check_pod_names(namespace: &str, pod: &str) -> Result<()> {
    if namespace.is_empty() {
        return Err("파드의 namespace가 필요합니다.".into());
    }
    check_namespace(namespace)?;
    check_pod(pod)
}

impl MetricsTarget {
    pub fn check(&self) -> Result<()> {
        match self {
            Self::Candidates { namespace, pod } => check_pod_names(namespace, pod),
            Self::Threads {
                namespace,
                pod,
                node,
            } => {
                check_pod_names(namespace, pod)?;
                check_node(node)
            }
            Self::Pod {
                namespace,
                pod,
                port,
                path,
                only,
                ..
            } => {
                check_pod_names(namespace, pod)?;
                if *port == 0 {
                    return Err("포트 번호가 올바르지 않습니다.".into());
                }
                if !is_metrics_path(path) {
                    return Err(
                        "메트릭 경로는 /metrics처럼 metrics나 prometheus로 끝나는 경로만 쓸 수 있습니다."
                            .into(),
                    );
                }
                if only.as_ref().is_some_and(|names| {
                    names.len() > MAX_ONLY || names.iter().any(|n| n.len() > MAX_METRIC_NAME)
                }) {
                    return Err("메트릭 지정이 너무 많습니다.".into());
                }
                Ok(())
            }
        }
    }
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Series {
    name: String,
    labels: String,
    value: f64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    port: u16,
    path: String,
    https: bool,
    /// Declared by a `prometheus.io/*` annotation rather than guessed from a container port.
    annotated: bool,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerThreads {
    container: String,
    threads: u64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MetricsData {
    Candidates { items: Vec<Candidate> },
    Series { items: Vec<Series>, total: usize },
    Absent { reason: NoMetrics },
    Threads { containers: Vec<ContainerThreads> },
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetricsRead {
    state: KubeState,
    data: Option<MetricsData>,
    elapsed_ms: u64,
}

fn valid_metric_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':'))
        && !name.starts_with(|c: char| c.is_ascii_digit())
}

/// Index of the `}` that closes a label block starting at `{`. Values may hold escaped quotes.
fn label_end(text: &str) -> Option<usize> {
    let (mut quoted, mut escaped) = (false, false);
    for (index, c) in text.char_indices() {
        match c {
            _ if escaped => escaped = false,
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            '}' if !quoted => return Some(index),
            _ => {}
        }
    }
    None
}

fn parse_line(line: &str) -> Option<(&str, &str, f64)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let name_end = line.find(|c: char| c == '{' || c.is_whitespace())?;
    let (name, rest) = line.split_at(name_end);
    if !valid_metric_name(name) {
        return None;
    }
    let (labels, value) = if rest.starts_with('{') {
        let close = label_end(rest)?;
        (&rest[1..close], &rest[close + 1..])
    } else {
        ("", rest)
    };
    let value: f64 = value.split_whitespace().next()?.parse().ok()?;
    value.is_finite().then_some((name, labels, value))
}

/// The value of one label in a block such as `container="app",pod="a"`.
fn label_value(labels: &str, wanted: &str) -> Option<String> {
    let mut rest = labels.trim_start_matches([',', ' ']);
    while let Some(equals) = rest.find('=') {
        let key = rest[..equals].trim();
        let quoted = rest[equals + 1..].strip_prefix('"')?;
        let mut value = String::new();
        let mut chars = quoted.char_indices();
        let end = loop {
            let (index, c) = chars.next()?;
            match c {
                '"' => break index,
                '\\' => match chars.next()?.1 {
                    'n' => value.push('\n'),
                    other => value.push(other),
                },
                other => value.push(other),
            }
        };
        if key == wanted {
            return Some(value);
        }
        rest = quoted[end + 1..].trim_start_matches([',', ' ']);
    }
    None
}

fn parse_series(text: &str, only: Option<&[String]>) -> (Vec<Series>, usize) {
    let mut items = Vec::new();
    let mut total = 0;
    for (name, labels, value) in text.lines().filter_map(parse_line) {
        total += 1;
        let wanted = only.is_none_or(|names| names.iter().any(|n| n == name));
        if wanted && items.len() < MAX_SERIES {
            items.push(Series {
                name: shown(name, MAX_METRIC_NAME),
                labels: shown(labels, MAX_LABELS),
                value,
            });
        }
    }
    (items, total)
}

/// Keeps containers only: a row with an empty `container` is the cgroup total or the pause sandbox
/// (KV.0), and Docker's runtime calls that sandbox `POD`.
fn threads_of(text: &str, namespace: &str, pod: &str) -> Vec<ContainerThreads> {
    let mut found: Vec<ContainerThreads> = Vec::new();
    for line in text.lines().filter(|l| l.starts_with("container_threads{")) {
        let Some((_, labels, value)) = parse_line(line) else {
            continue;
        };
        let matches = |label: &str, expected: &str| {
            label_value(labels, label).is_some_and(|got| got == expected)
        };
        if !matches("namespace", namespace) || !matches("pod", pod) {
            continue;
        }
        let Some(container) = label_value(labels, "container") else {
            continue;
        };
        if container.is_empty() || container == "POD" {
            continue;
        }
        let threads = value as u64;
        match found.iter_mut().find(|item| item.container == container) {
            Some(item) => item.threads = threads,
            None => found.push(ContainerThreads {
                container: shown(&container, MAX_METRIC_NAME),
                threads,
            }),
        }
    }
    found.sort_by(|a, b| a.container.cmp(&b.container));
    found
}

fn add_candidate(items: &mut Vec<Candidate>, candidate: Candidate) {
    let known = items
        .iter()
        .any(|c| (c.port, &c.path, c.https) == (candidate.port, &candidate.path, candidate.https));
    if !known && items.len() < MAX_CANDIDATES {
        items.push(candidate);
    }
}

/// An annotation that names a bad port or path is skipped; the declared ports still count.
fn candidates_of(pod: &Value) -> Vec<Candidate> {
    let annotation = |key: &str| {
        pod.pointer("/metadata/annotations")
            .and_then(|a| a.get(key))
            .and_then(Value::as_str)
    };
    let mut items = Vec::new();
    let scrape = annotation("prometheus.io/scrape") != Some("false");
    let port = annotation("prometheus.io/port").and_then(|p| p.parse::<u16>().ok());
    if let (true, Some(port)) = (scrape, port.filter(|p| *p != 0)) {
        let path = annotation("prometheus.io/path").unwrap_or("/metrics");
        if is_metrics_path(path) {
            add_candidate(
                &mut items,
                Candidate {
                    port,
                    path: path.to_string(),
                    https: annotation("prometheus.io/scheme") == Some("https"),
                    annotated: true,
                },
            );
        }
    }
    let containers = pod
        .pointer("/spec/containers")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    for port in containers
        .iter()
        .filter_map(|c| c.get("ports").and_then(Value::as_array))
        .flatten()
    {
        let tcp = port
            .get("protocol")
            .and_then(Value::as_str)
            .unwrap_or("TCP")
            == "TCP";
        let number = port
            .get("containerPort")
            .and_then(Value::as_u64)
            .and_then(|n| u16::try_from(n).ok())
            .filter(|n| *n != 0);
        if let (true, Some(port)) = (tcp, number) {
            add_candidate(
                &mut items,
                Candidate {
                    port,
                    path: "/metrics".into(),
                    https: false,
                    annotated: false,
                },
            );
        }
    }
    items
}

fn pod_proxy_path(namespace: &str, pod: &str, port: u16, path: &str, https: bool) -> String {
    let scheme = if https { "https:" } else { "" };
    format!("/api/v1/namespaces/{namespace}/pods/{scheme}{pod}:{port}/proxy{path}")
}

fn kubectl(kube: &KubeSettings) -> Kubectl<'_> {
    Kubectl {
        command: &kube.kubectl,
        kubeconfig: &kube.kubeconfig,
    }
}

type Reading = (KubeState, Option<MetricsData>);

async fn read_candidates(
    runner: &Runner<'_>,
    kube: &KubeSettings,
    namespace: &str,
    pod: &str,
) -> Reading {
    let command = kubectl(kube).cluster(
        &kube.context,
        &format!("get pod {} -n {} -o json", quote(pod), quote(namespace)),
    );
    let output = match runner.kubectl_bounded(&command, POD_READ).await {
        Ok(output) => output,
        Err(state) => return (state, None),
    };
    match serde_json::from_slice::<Value>(&output.stdout) {
        Ok(spec) => (
            KubeState::Ready,
            Some(MetricsData::Candidates {
                items: candidates_of(&spec),
            }),
        ),
        Err(_) => (
            KubeState::Unknown {
                message: "파드 정보를 해석하지 못했습니다.".into(),
            },
            None,
        ),
    }
}

struct PodAddress<'a> {
    namespace: &'a str,
    pod: &'a str,
    port: u16,
    path: &'a str,
    https: bool,
}

async fn read_pod(
    runner: &Runner<'_>,
    kube: &KubeSettings,
    address: PodAddress<'_>,
    only: Option<&[String]>,
) -> Reading {
    let url = pod_proxy_path(
        address.namespace,
        address.pod,
        address.port,
        address.path,
        address.https,
    );
    let command = kubectl(kube).cluster_within(
        &kube.context,
        POD_REQUEST_SECONDS,
        &format!("get --raw {}", quote(&url)),
    );
    let output = match runner.script(&command, POD_READ).await {
        Ok(output) => output,
        Err(failed) => return (failed.into_state(), None),
    };
    match classify_proxy(output.exit, &output.stderr) {
        ProxyRead::Blocked(state) => (state, None),
        ProxyRead::Absent(reason) => (KubeState::Ready, Some(MetricsData::Absent { reason })),
        ProxyRead::Answered => {
            let text = String::from_utf8_lossy(&output.stdout);
            let (items, total) = parse_series(&text, only);
            let data = if total == 0 {
                MetricsData::Absent {
                    reason: NoMetrics::NotPrometheus,
                }
            } else {
                MetricsData::Series { items, total }
            };
            (KubeState::Ready, Some(data))
        }
    }
}

async fn read_threads(
    runner: &Runner<'_>,
    kube: &KubeSettings,
    namespace: &str,
    pod: &str,
    node: &str,
) -> Reading {
    let url = format!("/api/v1/nodes/{node}/proxy/metrics/cadvisor");
    let command = kubectl(kube).cluster_within(
        &kube.context,
        NODE_REQUEST_SECONDS,
        &format!("get --raw {}", quote(&url)),
    );
    let output = match runner.script(&command, NODE_READ).await {
        Ok(output) => output,
        Err(failed) => return (failed.into_state(), None),
    };
    match classify(output.exit, &output.stderr) {
        KubeState::Ready => {
            let text = String::from_utf8_lossy(&output.stdout);
            (
                KubeState::Ready,
                Some(MetricsData::Threads {
                    containers: threads_of(&text, namespace, pod),
                }),
            )
        }
        state => (state, None),
    }
}

pub async fn read(runner: &Runner<'_>, kube: &KubeSettings, target: &MetricsTarget) -> MetricsRead {
    let started = Instant::now();
    let (state, data) = match target {
        MetricsTarget::Candidates { namespace, pod } => {
            read_candidates(runner, kube, namespace, pod).await
        }
        MetricsTarget::Pod {
            namespace,
            pod,
            port,
            path,
            https,
            only,
        } => {
            let address = PodAddress {
                namespace,
                pod,
                port: *port,
                path,
                https: *https,
            };
            read_pod(runner, kube, address, only.as_deref()).await
        }
        MetricsTarget::Threads {
            namespace,
            pod,
            node,
        } => read_threads(runner, kube, namespace, pod, node).await,
    };
    MetricsRead {
        state,
        data,
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pod_target(path: &str, port: u16) -> MetricsTarget {
        MetricsTarget::Pod {
            namespace: "web".into(),
            pod: "api-1".into(),
            port,
            path: path.into(),
            https: false,
            only: None,
        }
    }

    #[test]
    fn only_metrics_shaped_paths_are_allowed() {
        for path in [
            "/metrics",
            "/actuator/prometheus",
            "/stats/prometheus",
            "/x/v1-metrics",
        ] {
            assert!(pod_target(path, 80).check().is_ok(), "{path}");
        }
        for path in [
            "metrics",
            "/",
            "/admin",
            "/metrics/",
            "/../metrics",
            "/a/../metrics",
            "/metrics?x=1",
            "/metrics;id",
            "/met rics",
            "/metrics#a",
            "/$(reboot)/metrics",
        ] {
            assert!(pod_target(path, 80).check().is_err(), "{path}");
        }
        assert!(pod_target("/metrics", 0).check().is_err());
        assert!(
            pod_target(&format!("/{}/metrics", "a".repeat(200)), 80)
                .check()
                .is_err()
        );
    }

    #[test]
    fn names_that_reach_the_proxy_url_are_checked() {
        let bad = MetricsTarget::Pod {
            namespace: "web".into(),
            pod: "$(reboot)".into(),
            port: 80,
            path: "/metrics".into(),
            https: false,
            only: None,
        };
        assert!(bad.check().is_err());
        let bad_node = MetricsTarget::Threads {
            namespace: "web".into(),
            pod: "api-1".into(),
            node: "a/../b".into(),
        };
        assert!(bad_node.check().is_err());
        let too_many = MetricsTarget::Pod {
            namespace: "web".into(),
            pod: "api-1".into(),
            port: 80,
            path: "/metrics".into(),
            https: false,
            only: Some(vec!["a".into(); MAX_ONLY + 1]),
        };
        assert!(too_many.check().is_err());
    }

    #[test]
    fn the_proxy_url_names_the_port_and_scheme() {
        assert_eq!(
            pod_proxy_path("web", "api-1", 8080, "/metrics", false),
            "/api/v1/namespaces/web/pods/api-1:8080/proxy/metrics"
        );
        assert_eq!(
            pod_proxy_path("web", "api-1", 8443, "/metrics", true),
            "/api/v1/namespaces/web/pods/https:api-1:8443/proxy/metrics"
        );
    }

    #[test]
    fn prometheus_text_is_read_with_labels_escapes_and_timestamps() {
        let text = "# HELP worker_busy Busy workers\n\
                    # TYPE worker_busy gauge\n\
                    worker_busy 8\n\
                    requests_total{code=\"200\",path=\"/a\\\"}\"} 12 1700000000000\n\
                    weird{a=\"b\"} NaN\n\
                    bucket_le{le=\"+Inf\"} +Inf\n\
                    1bad 2\n\
                    no_value\n\
                    open{a=\"b\" 3\n\
                    with_exemplar 5 # {trace=\"x\"} 1\n";
        let (items, total) = parse_series(text, None);
        assert_eq!(total, 3);
        assert_eq!(
            items[0],
            Series {
                name: "worker_busy".into(),
                labels: String::new(),
                value: 8.0
            }
        );
        assert_eq!(items[1].labels, "code=\"200\",path=\"/a\\\"}\"");
        assert_eq!(items[1].value, 12.0);
        assert_eq!(items[2].name, "with_exemplar");
    }

    #[test]
    fn a_candidate_check_counts_without_returning_and_a_watch_gets_its_names() {
        let text = "a 1\nb 2\nb{x=\"y\"} 3\nc 4\n";
        let none: Vec<String> = Vec::new();
        assert_eq!(parse_series(text, Some(&none)), (Vec::new(), 4));
        let (items, total) = parse_series(text, Some(&["b".to_string()]));
        assert_eq!(total, 4);
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn the_series_list_is_bounded_but_still_counted() {
        let text: String = (0..MAX_SERIES + 5).map(|i| format!("m{i} 1\n")).collect();
        let (items, total) = parse_series(&text, None);
        assert_eq!(items.len(), MAX_SERIES);
        assert_eq!(total, MAX_SERIES + 5);
    }

    /// The shape measured in KV.0: an empty `container` is the cgroup total or the pause sandbox.
    #[test]
    fn threads_keep_named_containers_of_this_pod_only() {
        let text = "# HELP container_threads Number of threads\n\
            container_threads{container=\"\",id=\"/a\",name=\"\",namespace=\"web\",pod=\"api-1\"} 99 1\n\
            container_threads{container=\"POD\",id=\"/b\",name=\"x\",namespace=\"web\",pod=\"api-1\"} 1 1\n\
            container_threads{container=\"app\",id=\"/c\",name=\"y\",namespace=\"web\",pod=\"api-1\"} 12 1\n\
            container_threads{container=\"side\",id=\"/d\",name=\"z\",namespace=\"web\",pod=\"api-1\"} 3 1\n\
            container_threads{container=\"app\",id=\"/e\",name=\"o\",namespace=\"web\",pod=\"api-2\"} 7 1\n\
            container_threads{container=\"app\",id=\"/f\",name=\"o\",namespace=\"other\",pod=\"api-1\"} 8 1\n\
            container_threads_max{container=\"app\",namespace=\"web\",pod=\"api-1\"} 512 1\n";
        assert_eq!(
            threads_of(text, "web", "api-1"),
            vec![
                ContainerThreads {
                    container: "app".into(),
                    threads: 12
                },
                ContainerThreads {
                    container: "side".into(),
                    threads: 3
                },
            ]
        );
    }

    #[test]
    fn label_values_are_unescaped_and_keys_matched_whole() {
        let labels = "pod=\"a\\\"b\", container=\"app\",my_container=\"no\"";
        assert_eq!(label_value(labels, "pod").as_deref(), Some("a\"b"));
        assert_eq!(label_value(labels, "container").as_deref(), Some("app"));
        assert_eq!(label_value(labels, "missing"), None);
    }

    #[test]
    fn candidates_come_from_annotations_then_declared_ports() {
        let pod = json!({
            "metadata": { "annotations": {
                "prometheus.io/scrape": "true",
                "prometheus.io/port": "9102",
                "prometheus.io/path": "/stats/prometheus",
                "prometheus.io/scheme": "https"
            }},
            "spec": { "containers": [
                { "ports": [
                    { "containerPort": 8080 },
                    { "containerPort": 53, "protocol": "UDP" },
                    { "containerPort": 8080, "protocol": "TCP" }
                ]},
                { "ports": [{ "containerPort": 9102 }] },
                { "name": "no-ports" }
            ]}
        });
        assert_eq!(
            candidates_of(&pod),
            vec![
                Candidate {
                    port: 9102,
                    path: "/stats/prometheus".into(),
                    https: true,
                    annotated: true
                },
                Candidate {
                    port: 8080,
                    path: "/metrics".into(),
                    https: false,
                    annotated: false
                },
                Candidate {
                    port: 9102,
                    path: "/metrics".into(),
                    https: false,
                    annotated: false
                },
            ]
        );
    }

    #[test]
    fn a_bad_annotation_is_skipped_and_scrape_false_is_respected() {
        let bad_path = json!({
            "metadata": { "annotations": {
                "prometheus.io/port": "9102",
                "prometheus.io/path": "/admin/delete"
            }},
            "spec": { "containers": [{ "ports": [{ "containerPort": 80 }] }] }
        });
        assert_eq!(candidates_of(&bad_path).len(), 1);
        assert_eq!(candidates_of(&bad_path)[0].port, 80);
        let off = json!({
            "metadata": { "annotations": {
                "prometheus.io/scrape": "false",
                "prometheus.io/port": "9102"
            }},
            "spec": { "containers": [] }
        });
        assert!(candidates_of(&off).is_empty());
        assert!(candidates_of(&json!({})).is_empty());
    }

    #[test]
    fn the_candidate_list_is_bounded() {
        let ports: Vec<Value> = (1..=20).map(|p| json!({ "containerPort": p })).collect();
        let pod = json!({ "spec": { "containers": [{ "ports": ports }] } });
        assert_eq!(candidates_of(&pod).len(), MAX_CANDIDATES);
    }
}
