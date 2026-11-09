//! `kube_detail`: the panel beside the tree. Cluster output is untrusted, so text is bounded and
//! shown as text. YAML and environment values stay in memory; Secret objects are never read.
use super::{
    quantity::{cpu_millis, memory_bytes},
    runner::{Kubectl, Runner},
    settings::KubeSettings,
    snapshot::{count, decode, fields, records, shown},
    state::KubeState,
    templates,
};
use crate::remote_exec::{Limits, quote};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{collections::BTreeSet, time::Duration};

const LIMITS: Limits = Limits {
    timeout: Duration::from_secs(15),
    max_output: 8 * 1024 * 1024,
};
const REQUEST_TIMEOUT_SECONDS: u32 = 12;
const MAX_FIELD: usize = 512;
const MAX_MESSAGE: usize = 2048;
const MAX_EVENTS: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DetailKind {
    Overview,
    Events,
    Yaml,
    Relations,
}

#[derive(Clone, Copy)]
pub struct PodTarget<'a> {
    pub namespace: &'a str,
    pub pod: &'a str,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Termination {
    reason: String,
    message: String,
    exit_code: Option<i64>,
    started_at: String,
    finished_at: String,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDetail {
    name: String,
    image: String,
    ready: bool,
    restarts: u64,
    /// `running`, `waiting`, `terminated`, or empty before the container has any status.
    state: String,
    reason: String,
    message: String,
    exit_code: Option<i64>,
    started_at: String,
    finished_at: String,
    /// Changes when the container restarts, which is how a cut shell tells that apart from `exit`.
    container_id: String,
    last: Option<Termination>,
    cpu_request: Option<u64>,
    memory_request: Option<u64>,
    cpu_limit: Option<u64>,
    memory_limit: Option<u64>,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    namespace: String,
    name: String,
    uid: String,
    phase: String,
    reason: String,
    message: String,
    node: String,
    pod_ip: String,
    host_ip: String,
    qos_class: String,
    created: String,
    deleting: bool,
    owner_kind: String,
    owner_name: String,
    default_container: String,
    labels: Map<String, Value>,
    init_containers: Vec<ContainerDetail>,
    containers: Vec<ContainerDetail>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodEvent {
    event_type: String,
    reason: String,
    count: u32,
    time: String,
    message: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceLink {
    name: String,
    /// `true` while this pod's address is in the service's ready set.
    in_rotation: Option<bool>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressLink {
    name: String,
    hosts: Vec<String>,
    services: Vec<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section<T> {
    state: KubeState,
    items: Vec<T>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relations {
    services: Section<ServiceLink>,
    ingresses: Section<IngressLink>,
    network_policies: Section<String>,
    pvcs: Vec<String>,
    config_maps: Vec<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DetailData {
    Overview(Box<Overview>),
    Events { items: Vec<PodEvent> },
    Yaml { text: String },
    Relations(Box<Relations>),
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Detail {
    state: KubeState,
    data: Option<DetailData>,
}

fn text_at(value: &Value, pointer: &str) -> String {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map_or_else(String::new, |text| shown(text, MAX_FIELD))
}

fn message_at(value: &Value, pointer: &str) -> String {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .map_or_else(String::new, |text| shown(text, MAX_MESSAGE))
}

fn termination(value: &Value) -> Termination {
    Termination {
        reason: text_at(value, "/reason"),
        message: message_at(value, "/message"),
        exit_code: value.pointer("/exitCode").and_then(Value::as_i64),
        started_at: text_at(value, "/startedAt"),
        finished_at: text_at(value, "/finishedAt"),
    }
}

fn amount(value: &Value, pointer: &str, read: fn(&str) -> Option<u64>) -> Option<u64> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .and_then(read)
}

fn container_detail(spec: &Value, statuses: &[Value]) -> ContainerDetail {
    let name = text_at(spec, "/name");
    let status = statuses.iter().find(|item| text_at(item, "/name") == name);
    let mut detail = ContainerDetail {
        image: text_at(spec, "/image"),
        cpu_request: amount(spec, "/resources/requests/cpu", cpu_millis),
        memory_request: amount(spec, "/resources/requests/memory", memory_bytes),
        cpu_limit: amount(spec, "/resources/limits/cpu", cpu_millis),
        memory_limit: amount(spec, "/resources/limits/memory", memory_bytes),
        name,
        ..ContainerDetail::default()
    };
    let Some(status) = status else {
        return detail;
    };
    detail.ready = status
        .pointer("/ready")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    detail.restarts = status
        .pointer("/restartCount")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    detail.container_id = text_at(status, "/containerID");
    for state in ["running", "waiting", "terminated"] {
        let Some(found) = status.pointer(&format!("/state/{state}")) else {
            continue;
        };
        detail.state = state.into();
        detail.reason = text_at(found, "/reason");
        detail.message = message_at(found, "/message");
        detail.exit_code = found.pointer("/exitCode").and_then(Value::as_i64);
        detail.started_at = text_at(found, "/startedAt");
        detail.finished_at = text_at(found, "/finishedAt");
    }
    detail.last = status.pointer("/lastState/terminated").map(termination);
    detail
}

fn list<'a>(value: &'a Value, pointer: &str) -> &'a [Value] {
    value
        .pointer(pointer)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn overview_of(pod: &Value) -> Overview {
    let owner = list(pod, "/metadata/ownerReferences").first();
    let details = |specs: &str, statuses: &str| -> Vec<ContainerDetail> {
        list(pod, specs)
            .iter()
            .map(|spec| container_detail(spec, list(pod, statuses)))
            .collect()
    };
    Overview {
        namespace: text_at(pod, "/metadata/namespace"),
        name: text_at(pod, "/metadata/name"),
        uid: text_at(pod, "/metadata/uid"),
        phase: text_at(pod, "/status/phase"),
        reason: text_at(pod, "/status/reason"),
        message: message_at(pod, "/status/message"),
        node: text_at(pod, "/spec/nodeName"),
        pod_ip: text_at(pod, "/status/podIP"),
        host_ip: text_at(pod, "/status/hostIP"),
        qos_class: text_at(pod, "/status/qosClass"),
        created: text_at(pod, "/metadata/creationTimestamp"),
        deleting: pod.pointer("/metadata/deletionTimestamp").is_some(),
        owner_kind: owner.map_or_else(String::new, |owner| text_at(owner, "/kind")),
        owner_name: owner.map_or_else(String::new, |owner| text_at(owner, "/name")),
        default_container: text_at(
            pod,
            "/metadata/annotations/kubectl.kubernetes.io~1default-container",
        ),
        labels: pod
            .pointer("/metadata/labels")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default(),
        init_containers: details("/spec/initContainers", "/status/initContainerStatuses"),
        containers: details("/spec/containers", "/status/containerStatuses"),
    }
}

fn event(line: &str) -> Option<PodEvent> {
    let [
        event_type,
        reason,
        times,
        last,
        event_time,
        created,
        message,
    ] = fields::<7>(line)?;
    let time = [last, event_time, created]
        .into_iter()
        .map(|value| shown(value, MAX_FIELD))
        .find(|value| !value.is_empty())
        .unwrap_or_default();
    Some(PodEvent {
        event_type: shown(event_type, MAX_FIELD),
        reason: shown(&decode(reason), MAX_FIELD),
        count: count(times)?,
        time,
        message: shown(&decode(message), MAX_MESSAGE),
    })
}

fn events_of(text: &str) -> Option<Vec<PodEvent>> {
    let mut items = records(text).map(event).collect::<Option<Vec<_>>>()?;
    items.sort_by(|a, b| b.time.cmp(&a.time));
    items.truncate(MAX_EVENTS);
    Some(items)
}

/// Exact `matchLabels` equality. A missing or empty selector matches nothing for a Service.
fn labels_match(wanted: &Map<String, Value>, labels: &Map<String, Value>) -> bool {
    wanted
        .iter()
        .all(|(key, value)| labels.get(key) == Some(value))
}

/// An empty `podSelector` selects every pod in the namespace.
fn pod_selector_matches(selector: &Value, labels: &Map<String, Value>) -> bool {
    let exact = selector.pointer("/matchLabels").and_then(Value::as_object);
    if !exact.is_none_or(|wanted| labels_match(wanted, labels)) {
        return false;
    }
    list(selector, "/matchExpressions")
        .iter()
        .all(|expression| {
            let key = expression
                .pointer("/key")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let values = list(expression, "/values");
            let found = labels.get(key);
            match expression.pointer("/operator").and_then(Value::as_str) {
                Some("In") => found.is_some_and(|value| values.contains(value)),
                Some("NotIn") => found.is_none_or(|value| !values.contains(value)),
                Some("Exists") => found.is_some(),
                Some("DoesNotExist") => found.is_none(),
                _ => false,
            }
        })
}

fn sorted(items: BTreeSet<String>) -> Vec<String> {
    items.into_iter().filter(|item| !item.is_empty()).collect()
}

fn pvcs_of(pod: &Value) -> Vec<String> {
    sorted(
        list(pod, "/spec/volumes")
            .iter()
            .map(|volume| text_at(volume, "/persistentVolumeClaim/claimName"))
            .collect(),
    )
}

fn config_maps_of(pod: &Value) -> Vec<String> {
    let mut names = BTreeSet::new();
    for volume in list(pod, "/spec/volumes") {
        names.insert(text_at(volume, "/configMap/name"));
        for source in list(volume, "/projected/sources") {
            names.insert(text_at(source, "/configMap/name"));
        }
    }
    for specs in ["/spec/containers", "/spec/initContainers"] {
        for container in list(pod, specs) {
            for from in list(container, "/envFrom") {
                names.insert(text_at(from, "/configMapRef/name"));
            }
            for env in list(container, "/env") {
                names.insert(text_at(env, "/valueFrom/configMapKeyRef/name"));
            }
        }
    }
    sorted(names)
}

/// `true` in the ready addresses, `false` in the not-ready ones, `None` when the pod is in neither.
fn rotation(endpoints: Option<&Value>, ip: &str) -> Option<bool> {
    let has = |pointer: &str| {
        endpoints.is_some_and(|endpoints| {
            list(endpoints, "/subsets").iter().any(|subset| {
                list(subset, pointer)
                    .iter()
                    .any(|address| text_at(address, "/ip") == ip)
            })
        })
    };
    if has("/addresses") {
        Some(true)
    } else if has("/notReadyAddresses") {
        Some(false)
    } else {
        None
    }
}

fn service_links(items: &[Value], labels: &Map<String, Value>, ip: &str) -> Vec<ServiceLink> {
    let kind = |item: &Value| text_at(item, "/kind");
    let name = |item: &Value| text_at(item, "/metadata/name");
    items
        .iter()
        .filter(|item| kind(item) == "Service")
        .filter(|service| {
            service
                .pointer("/spec/selector")
                .and_then(Value::as_object)
                .is_some_and(|wanted| !wanted.is_empty() && labels_match(wanted, labels))
        })
        .map(|service| {
            let endpoints = items
                .iter()
                .find(|item| kind(item) == "Endpoints" && name(item) == name(service));
            ServiceLink {
                in_rotation: rotation(endpoints, ip),
                name: name(service),
            }
        })
        .collect()
}

fn ingress_links(items: &[Value], services: &[ServiceLink]) -> Vec<IngressLink> {
    let matched = |name: &str| services.iter().any(|service| service.name == name);
    let mut links = Vec::new();
    for ingress in items {
        let mut backends = BTreeSet::new();
        let mut hosts = BTreeSet::new();
        backends.insert(text_at(ingress, "/spec/defaultBackend/service/name"));
        for rule in list(ingress, "/spec/rules") {
            hosts.insert(text_at(rule, "/host"));
            for path in list(rule, "/http/paths") {
                backends.insert(text_at(path, "/backend/service/name"));
            }
        }
        let services: Vec<String> = sorted(backends)
            .into_iter()
            .filter(|name| matched(name))
            .collect();
        if !services.is_empty() {
            links.push(IngressLink {
                name: text_at(ingress, "/metadata/name"),
                hosts: sorted(hosts),
                services,
            });
        }
    }
    links
}

fn parsed(text: &[u8]) -> Option<Value> {
    serde_json::from_slice(text).ok()
}

fn malformed() -> KubeState {
    KubeState::Unknown {
        message: "kubectl 출력 형식이 예상과 다릅니다.".into(),
    }
}

async fn run(runner: &Runner<'_>, kube: &KubeSettings, args: &str) -> Result<Vec<u8>, KubeState> {
    let kubectl = Kubectl {
        command: &kube.kubectl,
        kubeconfig: &kube.kubeconfig,
    };
    let command = kubectl.cluster_within(&kube.context, REQUEST_TIMEOUT_SECONDS, args);
    runner
        .kubectl_bounded(&command, LIMITS)
        .await
        .map(|output| output.stdout)
}

async fn items(
    runner: &Runner<'_>,
    kube: &KubeSettings,
    namespace: &str,
    resources: &str,
) -> Result<Vec<Value>, KubeState> {
    let stdout = run(
        runner,
        kube,
        &format!("get {resources} -n {} -o json", quote(namespace)),
    )
    .await?;
    let value = parsed(&stdout).ok_or_else(malformed)?;
    Ok(list(&value, "/items").to_vec())
}

fn section<T>(found: Result<Vec<T>, KubeState>) -> Section<T> {
    match found {
        Ok(items) => Section {
            state: KubeState::Ready,
            items,
        },
        Err(state) => Section {
            state,
            items: Vec::new(),
        },
    }
}

/// Each lookup can be refused on its own, and a refused one only empties its own section.
async fn relations_of(
    runner: &Runner<'_>,
    kube: &KubeSettings,
    target: PodTarget<'_>,
    pod: &Value,
) -> Relations {
    let labels = pod
        .pointer("/metadata/labels")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let ip = text_at(pod, "/status/podIP");
    let services = items(runner, kube, target.namespace, "services,endpoints")
        .await
        .map(|found| service_links(&found, &labels, &ip));
    let matched: &[ServiceLink] = services.as_ref().map_or(&[], Vec::as_slice);
    let ingresses = items(
        runner,
        kube,
        target.namespace,
        "ingresses.networking.k8s.io",
    )
    .await
    .map(|found| ingress_links(&found, matched));
    let network_policies = items(
        runner,
        kube,
        target.namespace,
        "networkpolicies.networking.k8s.io",
    )
    .await
    .map(|found| {
        found
            .iter()
            .filter(|policy| {
                policy
                    .pointer("/spec/podSelector")
                    .is_some_and(|selector| pod_selector_matches(selector, &labels))
            })
            .map(|policy| text_at(policy, "/metadata/name"))
            .collect()
    });
    Relations {
        services: section(services),
        ingresses: section(ingresses),
        network_policies: section(network_policies),
        pvcs: pvcs_of(pod),
        config_maps: config_maps_of(pod),
    }
}

fn pod_args(target: PodTarget<'_>, output: &str) -> String {
    format!(
        "get pod {} -n {} -o {output}",
        quote(target.pod),
        quote(target.namespace)
    )
}

fn events_args(target: PodTarget<'_>) -> String {
    format!(
        "get events -n {} --field-selector {} -o go-template={}",
        quote(target.namespace),
        quote(&format!(
            "involvedObject.kind=Pod,involvedObject.name={}",
            target.pod
        )),
        quote(templates::POD_EVENTS),
    )
}

async fn pod_json(
    runner: &Runner<'_>,
    kube: &KubeSettings,
    target: PodTarget<'_>,
) -> Result<Value, KubeState> {
    let stdout = run(runner, kube, &pod_args(target, "json")).await?;
    parsed(&stdout).ok_or_else(malformed)
}

async fn load(
    runner: &Runner<'_>,
    kube: &KubeSettings,
    target: PodTarget<'_>,
    kind: DetailKind,
) -> Result<DetailData, KubeState> {
    Ok(match kind {
        DetailKind::Overview => DetailData::Overview(Box::new(overview_of(
            &pod_json(runner, kube, target).await?,
        ))),
        DetailKind::Events => {
            let stdout = run(runner, kube, &events_args(target)).await?;
            DetailData::Events {
                items: events_of(&String::from_utf8_lossy(&stdout)).ok_or_else(malformed)?,
            }
        }
        DetailKind::Yaml => DetailData::Yaml {
            text: String::from_utf8_lossy(&run(runner, kube, &pod_args(target, "yaml")).await?)
                .into_owned(),
        },
        DetailKind::Relations => {
            let pod = pod_json(runner, kube, target).await?;
            DetailData::Relations(Box::new(relations_of(runner, kube, target, &pod).await))
        }
    })
}

pub async fn read(
    runner: &Runner<'_>,
    kube: &KubeSettings,
    target: PodTarget<'_>,
    kind: DetailKind,
) -> Detail {
    match load(runner, kube, target, kind).await {
        Ok(data) => Detail {
            state: KubeState::Ready,
            data: Some(data),
        },
        Err(state) => Detail { state, data: None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pod() -> Value {
        json!({
            "metadata": {
                "namespace": "web", "name": "api-1", "uid": "u1",
                "creationTimestamp": "2026-11-08T10:00:00Z",
                "labels": { "app": "api", "tier": "front" },
                "annotations": { "kubectl.kubernetes.io/default-container": "main" },
                "ownerReferences": [{ "kind": "ReplicaSet", "name": "api-7f9c" }]
            },
            "spec": {
                "nodeName": "n1",
                "volumes": [
                    { "persistentVolumeClaim": { "claimName": "data" } },
                    { "configMap": { "name": "cfg" } },
                    { "projected": { "sources": [{ "configMap": { "name": "kube-root-ca.crt" } }] } }
                ],
                "containers": [
                    {
                        "name": "main", "image": "api:1",
                        "resources": { "requests": { "cpu": "250m", "memory": "64Mi" }, "limits": { "memory": "128Mi" } },
                        "envFrom": [{ "configMapRef": { "name": "env-cfg" } }],
                        "env": [{ "valueFrom": { "configMapKeyRef": { "name": "key-cfg" } } }]
                    },
                    { "name": "side", "image": "pause:3" }
                ]
            },
            "status": {
                "phase": "Running", "podIP": "10.0.0.5",
                "containerStatuses": [{
                    "name": "main", "ready": false, "restartCount": 3,
                    "containerID": "containerd://aaa",
                    "state": { "waiting": { "reason": "CrashLoopBackOff", "message": "back-off" } },
                    "lastState": { "terminated": { "reason": "OOMKilled", "exitCode": 137,
                        "startedAt": "2026-11-08T10:01:00Z", "finishedAt": "2026-11-08T10:02:00Z" } }
                }]
            }
        })
    }

    #[test]
    fn overview_keeps_what_the_screen_and_the_cause_view_need() {
        let overview = overview_of(&pod());
        assert_eq!(overview.uid, "u1");
        assert_eq!(overview.default_container, "main");
        assert_eq!(overview.owner_kind, "ReplicaSet");
        let main = &overview.containers[0];
        assert_eq!(main.state, "waiting");
        assert_eq!(main.reason, "CrashLoopBackOff");
        assert_eq!(main.restarts, 3);
        assert_eq!(main.cpu_request, Some(250));
        assert_eq!(main.memory_limit, Some(128 * 1024 * 1024));
        let last = main.last.as_ref().unwrap();
        assert_eq!(last.reason, "OOMKilled");
        assert_eq!(last.exit_code, Some(137));
        let side = &overview.containers[1];
        assert_eq!(side.state, "");
        assert_eq!(side.restarts, 0);
    }

    #[test]
    fn events_read_the_template_and_put_the_newest_first() {
        let line = |time: &str, reason: &str| {
            format!(
                "Warning\t{reason}\t3\t{time}\t<no value>\t2026-11-08T09:00:00Z\tBack-off+restarting"
            )
        };
        let text = format!(
            "{}\n{}\n",
            line("2026-11-08T10:00:00Z", "BackOff"),
            line("2026-11-08T11:00:00Z", "Failed")
        );
        let items = events_of(&text).unwrap();
        assert_eq!(items[0].reason, "Failed");
        assert_eq!(items[0].count, 3);
        assert_eq!(items[1].message, "Back-off restarting");
        assert!(events_of("too\tfew\n").is_none());
    }

    #[test]
    fn newer_events_without_a_count_read_as_zero() {
        let text = "Normal\tScheduled\t<no value>\t<no value>\t2026-11-08T09:00:00Z\t2026-11-08T09:00:00Z\tok\n";
        assert_eq!(events_of(text).unwrap()[0].count, 0);
    }

    #[test]
    fn services_match_by_selector_and_report_rotation() {
        let labels = pod()["metadata"]["labels"].as_object().unwrap().clone();
        let items = vec![
            json!({ "kind": "Service", "metadata": { "name": "api" }, "spec": { "selector": { "app": "api" } } }),
            json!({ "kind": "Service", "metadata": { "name": "other" }, "spec": { "selector": { "app": "x" } } }),
            json!({ "kind": "Service", "metadata": { "name": "headless" }, "spec": {} }),
            json!({ "kind": "Endpoints", "metadata": { "name": "api" }, "subsets": [
                { "notReadyAddresses": [{ "ip": "10.0.0.5" }], "addresses": [{ "ip": "10.0.0.6" }] }
            ] }),
        ];
        let links = service_links(&items, &labels, "10.0.0.5");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].name, "api");
        assert_eq!(links[0].in_rotation, Some(false));
        assert_eq!(rotation(items.get(3), "10.0.0.6"), Some(true));
        assert_eq!(rotation(items.get(3), "10.0.0.7"), None);
    }

    #[test]
    fn network_policy_selectors_follow_kubernetes_rules() {
        let labels = pod()["metadata"]["labels"].as_object().unwrap().clone();
        let matches = |selector: Value| pod_selector_matches(&selector, &labels);
        assert!(matches(json!({})));
        assert!(matches(json!({ "matchLabels": { "app": "api" } })));
        assert!(!matches(json!({ "matchLabels": { "app": "x" } })));
        assert!(matches(
            json!({ "matchExpressions": [{ "key": "tier", "operator": "In", "values": ["front", "b"] }] })
        ));
        assert!(!matches(
            json!({ "matchExpressions": [{ "key": "tier", "operator": "NotIn", "values": ["front"] }] })
        ));
        assert!(matches(
            json!({ "matchExpressions": [{ "key": "tier", "operator": "Exists" }] })
        ));
        assert!(!matches(
            json!({ "matchExpressions": [{ "key": "none", "operator": "Exists" }] })
        ));
        assert!(matches(
            json!({ "matchExpressions": [{ "key": "none", "operator": "DoesNotExist" }] })
        ));
    }

    #[test]
    fn ingresses_are_linked_through_the_pods_services() {
        let services = [ServiceLink {
            name: "api".into(),
            in_rotation: Some(true),
        }];
        let items = vec![
            json!({ "metadata": { "name": "shop" }, "spec": { "rules": [{ "host": "a.test", "http": { "paths": [{ "backend": { "service": { "name": "api" } } }] } }] } }),
            json!({ "metadata": { "name": "unrelated" }, "spec": { "rules": [{ "host": "b.test", "http": { "paths": [{ "backend": { "service": { "name": "web" } } }] } }] } }),
        ];
        let links = ingress_links(&items, &services);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].name, "shop");
        assert_eq!(links[0].hosts, ["a.test"]);
    }

    #[test]
    fn storage_and_config_names_come_from_the_pod() {
        assert_eq!(pvcs_of(&pod()), ["data"]);
        assert_eq!(
            config_maps_of(&pod()),
            ["cfg", "env-cfg", "key-cfg", "kube-root-ca.crt"]
        );
    }

    #[test]
    fn events_are_asked_for_this_pod_only() {
        let target = PodTarget {
            namespace: "web",
            pod: "api-1",
        };
        let args = events_args(target);
        assert!(
            args.contains("'involvedObject.kind=Pod,involvedObject.name=api-1'"),
            "{args}"
        );
        assert_eq!(pod_args(target, "yaml"), "get pod 'api-1' -n 'web' -o yaml");
    }
}
