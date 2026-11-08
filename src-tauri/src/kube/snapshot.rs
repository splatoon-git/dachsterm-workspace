//! `kube_snapshot`: one kind of cluster data per call, so the screen can poll each kind on its own
//! period. Cluster output is untrusted: lengths are bounded here and values are shown as text.
use super::{
    runner::{Kubectl, Runner},
    settings::KubeSettings,
    state::KubeState,
    templates,
};
use crate::remote_exec::{Limits, quote};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// 5,115 pods took about 6 seconds with no network delay (KV.0).
const LIMITS: Limits = Limits {
    timeout: Duration::from_secs(20),
    max_output: 32 * 1024 * 1024,
};
/// Inside the 20 seconds above, so kubectl's own error is what a slow API server normally produces.
/// The 8 seconds of the setup checks would cut a large list off long before that limit.
const REQUEST_TIMEOUT_SECONDS: u32 = 18;
const MAX_LINE: usize = 256 * 1024;
const MAX_FIELD: usize = 512;
const MAX_MESSAGE: usize = 2048;
const MAX_EVENTS: usize = 500;
/// `{{.field}}` prints this for a key the object does not have.
const NO_VALUE: &str = "<no value>";

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Pods,
    Workloads,
    Services,
    Nodes,
    PodUsage,
    NodeUsage,
    Events,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerState {
    name: String,
    ready: bool,
    restarts: u32,
    waiting: String,
    terminated: String,
    last_reason: String,
    last_finished: String,
    last_exit_code: Option<i32>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pod {
    namespace: String,
    name: String,
    node: String,
    phase: String,
    reason: String,
    created: String,
    deleting: bool,
    owner_kind: String,
    owner_name: String,
    labels: BTreeMap<String, String>,
    container_count: usize,
    cpu_request: Option<u64>,
    memory_request: Option<u64>,
    cpu_limit: Option<u64>,
    memory_limit: Option<u64>,
    init_containers: Vec<ContainerState>,
    containers: Vec<ContainerState>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workload {
    kind: String,
    namespace: String,
    name: String,
    desired: u32,
    ready: u32,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    namespace: String,
    name: String,
    service_type: String,
    selector: BTreeMap<String, String>,
    ready_endpoints: usize,
    not_ready_endpoints: usize,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    name: String,
    ready: bool,
    unschedulable: bool,
    cpu_allocatable: Option<u64>,
    memory_allocatable: Option<u64>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PodUsage {
    namespace: String,
    name: String,
    cpu: u64,
    memory: u64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeUsage {
    name: String,
    cpu: u64,
    memory: u64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    namespace: String,
    object_kind: String,
    object_name: String,
    reason: String,
    time: String,
    message: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", content = "items", rename_all = "camelCase")]
pub enum Data {
    Pods(Vec<Pod>),
    Workloads(Vec<Workload>),
    Services(Vec<Service>),
    Nodes(Vec<Node>),
    PodUsage(Vec<PodUsage>),
    NodeUsage(Vec<NodeUsage>),
    Events(Vec<Event>),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    state: KubeState,
    data: Option<Data>,
    /// Milliseconds since the Unix epoch, when the run finished.
    collected_at: u64,
    /// Time on the server only, not time spent waiting for a slot. The next poll is based on it.
    elapsed_ms: u64,
}

fn arguments(kind: Kind, namespace: &str) -> String {
    let scope = if namespace.is_empty() {
        "-A".to_string()
    } else {
        format!("-n {}", quote(namespace))
    };
    let template = |text: &str| format!("-o go-template={}", quote(text));
    match kind {
        Kind::Pods => format!("get pods {scope} {}", template(templates::PODS)),
        Kind::Workloads => format!(
            "get deployments,statefulsets,daemonsets {scope} {}",
            template(templates::WORKLOADS)
        ),
        Kind::Services => format!(
            "get services,endpoints {scope} {}",
            template(templates::SERVICES)
        ),
        Kind::Nodes => format!("get nodes {}", template(templates::NODES)),
        Kind::PodUsage => format!("top pods {scope} --no-headers"),
        Kind::NodeUsage => "top nodes --no-headers".to_string(),
        Kind::Events => format!(
            "get events {scope} --field-selector type=Warning {}",
            template(templates::EVENTS)
        ),
    }
}

pub async fn collect(runner: &Runner<'_>, kube: &KubeSettings, kind: Kind) -> Snapshot {
    let kubectl = Kubectl {
        command: &kube.kubectl,
        kubeconfig: &kube.kubeconfig,
    };
    let command = kubectl.cluster_within(
        &kube.context,
        REQUEST_TIMEOUT_SECONDS,
        &arguments(kind, &kube.namespace),
    );
    let started = Instant::now();
    let result = runner.kubectl_bounded(&command, LIMITS).await;
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let (state, data) = match result {
        Ok(output) => match parse(
            kind,
            &String::from_utf8_lossy(&output.stdout),
            &kube.namespace,
        ) {
            Some(data) => (KubeState::Ready, Some(data)),
            None => (malformed(), None),
        },
        Err(state) => (state, None),
    };
    Snapshot {
        state,
        data,
        collected_at: now_ms(),
        elapsed_ms,
    }
}

fn malformed() -> KubeState {
    KubeState::Unknown {
        message: "kubectl 출력 형식이 예상과 다릅니다.".into(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// `None` is a record this code does not understand. The templates above decide the shape, so that
/// means something is wrong rather than one odd object, and the last good data stays on screen.
pub fn parse(kind: Kind, text: &str, namespace: &str) -> Option<Data> {
    Some(match kind {
        Kind::Pods => Data::Pods(lines(text, pod)?),
        Kind::Workloads => Data::Workloads(lines(text, workload)?),
        Kind::Services => Data::Services(services(text)?),
        Kind::Nodes => Data::Nodes(lines(text, node)?),
        Kind::PodUsage => Data::PodUsage(usages(text, |line| pod_usage(line, namespace))?),
        Kind::NodeUsage => Data::NodeUsage(usages(text, node_usage)?),
        Kind::Events => Data::Events(events(text)?),
    })
}

pub(super) fn records(text: &str) -> impl Iterator<Item = &str> {
    text.lines()
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .filter(|line| !line.is_empty())
}

pub(super) fn fields<const N: usize>(line: &str) -> Option<[&str; N]> {
    if line.len() > MAX_LINE {
        return None;
    }
    line.split('\t').collect::<Vec<_>>().try_into().ok()
}

fn lines<T>(text: &str, parse: fn(&str) -> Option<T>) -> Option<Vec<T>> {
    records(text).map(parse).collect()
}

/// Text shown to the user, with the control characters and length a cluster could send removed.
pub(super) fn shown(value: &str, limit: usize) -> String {
    if value == NO_VALUE {
        return String::new();
    }
    value
        .chars()
        .filter(|c| !c.is_control())
        .take(limit)
        .collect()
}

fn text(value: &str) -> String {
    shown(value, MAX_FIELD)
}

/// Reverses Go's `urlquery`.
pub(super) fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = |index: usize| bytes.get(index).and_then(|b| (*b as char).to_digit(16));
        match (bytes[at], hex(at + 1), hex(at + 2)) {
            (b'%', Some(high), Some(low)) => {
                out.push((high * 16 + low) as u8);
                at += 3;
            }
            (b'+', ..) => {
                out.push(b' ');
                at += 1;
            }
            (byte, ..) => {
                out.push(byte);
                at += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn is_true(value: &str) -> bool {
    value.eq_ignore_ascii_case("true")
}

/// A missing count is zero: a Deployment with no ready replica has no `readyReplicas` at all.
pub(super) fn count(value: &str) -> Option<u32> {
    if value.is_empty() || value == NO_VALUE {
        Some(0)
    } else {
        value.parse().ok()
    }
}

/// `k=v,k=v,` where the API server has already restricted both sides.
fn pairs(value: &str) -> BTreeMap<String, String> {
    value
        .split(',')
        .filter_map(|pair| pair.split_once('='))
        .map(|(key, value)| (text(key), text(value)))
        .collect()
}

fn scaled(number: &str, unit: f64) -> Option<u64> {
    let value: f64 = number.parse().ok()?;
    // Rounded first, so `128974848000m` does not come out one byte high from binary fractions.
    (value.is_finite() && value >= 0.0).then(|| ((value * unit * 1e3).round() / 1e3).ceil() as u64)
}

/// A CPU quantity in millicores: `250m`, `2`, `1.5`, `31415926n`.
pub fn cpu_millis(value: &str) -> Option<u64> {
    const SUFFIXES: [(&str, f64); 4] = [("n", 1e-6), ("u", 1e-3), ("m", 1.0), ("k", 1e6)];
    SUFFIXES
        .iter()
        .find_map(|(suffix, unit)| Some((value.strip_suffix(suffix)?, *unit)))
        .map_or_else(
            || scaled(value, 1000.0),
            |(number, unit)| scaled(number, unit),
        )
}

/// A memory quantity in bytes: `64Mi`, `1G`, `129M`, `128974848000m`, `1e3`.
pub fn memory_bytes(value: &str) -> Option<u64> {
    const BINARY: [(&str, f64); 6] = [
        ("Ki", 1024.0),
        ("Mi", 1_048_576.0),
        ("Gi", 1_073_741_824.0),
        ("Ti", 1_099_511_627_776.0),
        ("Pi", 1_125_899_906_842_624.0),
        ("Ei", 1_152_921_504_606_846_976.0),
    ];
    const DECIMAL: [(&str, f64); 7] = [
        ("m", 1e-3),
        ("k", 1e3),
        ("M", 1e6),
        ("G", 1e9),
        ("T", 1e12),
        ("P", 1e15),
        ("E", 1e18),
    ];
    BINARY
        .iter()
        .chain(DECIMAL.iter())
        .find_map(|(suffix, unit)| Some((value.strip_suffix(suffix)?, *unit)))
        .map_or_else(|| scaled(value, 1.0), |(number, unit)| scaled(number, unit))
}

fn add(total: &mut Option<u64>, value: &str, read: fn(&str) -> Option<u64>) {
    if let Some(amount) = read(value) {
        *total = Some(total.unwrap_or(0).saturating_add(amount));
    }
}

fn container_states(value: &str) -> Option<Vec<ContainerState>> {
    value
        .split('|')
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            let [
                name,
                ready,
                restarts,
                waiting,
                terminated,
                last_reason,
                last_finished,
                last_exit_code,
            ] = entry.split(';').collect::<Vec<_>>().try_into().ok()?;
            Some(ContainerState {
                name: text(name),
                ready: is_true(ready),
                restarts: count(restarts)?,
                waiting: text(&decode(waiting)),
                terminated: text(&decode(terminated)),
                last_reason: text(&decode(last_reason)),
                last_finished: text(last_finished),
                last_exit_code: last_exit_code.parse().ok(),
            })
        })
        .collect()
}

fn pod(line: &str) -> Option<Pod> {
    let [
        namespace,
        name,
        node,
        phase,
        reason,
        created,
        deleting,
        owners,
        labels,
        resources,
        init_states,
        states,
    ] = fields::<12>(line)?;
    let (owner_kind, owner_name) = owners
        .split(',')
        .next()
        .and_then(|owner| owner.split_once('/'))
        .unwrap_or_default();
    let (mut cpu_request, mut memory_request, mut cpu_limit, mut memory_limit) =
        (None, None, None, None);
    let mut container_count = 0;
    for entry in resources.split('|').filter(|entry| !entry.is_empty()) {
        let [request_cpu, request_memory, limit_cpu, limit_memory] =
            entry.split(';').collect::<Vec<_>>().try_into().ok()?;
        container_count += 1;
        add(&mut cpu_request, request_cpu, cpu_millis);
        add(&mut memory_request, request_memory, memory_bytes);
        add(&mut cpu_limit, limit_cpu, cpu_millis);
        add(&mut memory_limit, limit_memory, memory_bytes);
    }
    Some(Pod {
        namespace: text(namespace),
        name: text(name),
        node: text(node),
        phase: text(phase),
        reason: text(&decode(reason)),
        created: text(created),
        deleting: !shown(deleting, 1).is_empty(),
        owner_kind: text(owner_kind),
        owner_name: text(owner_name),
        labels: pairs(labels),
        container_count,
        cpu_request,
        memory_request,
        cpu_limit,
        memory_limit,
        init_containers: container_states(init_states)?,
        containers: container_states(states)?,
    })
}

fn workload(line: &str) -> Option<Workload> {
    let [kind, namespace, name, desired, ready] = fields::<5>(line)?;
    Some(Workload {
        kind: text(kind),
        namespace: text(namespace),
        name: text(name),
        desired: count(desired)?,
        ready: count(ready)?,
    })
}

/// A Service and its Endpoints arrive as separate records with the same name.
fn services(text_output: &str) -> Option<Vec<Service>> {
    let mut merged: BTreeMap<(String, String), Service> = BTreeMap::new();
    for line in records(text_output) {
        let [kind, namespace, name, first, second] = fields::<5>(line)?;
        let entry = merged
            .entry((text(namespace), text(name)))
            .or_insert_with_key(|(namespace, name)| Service {
                namespace: namespace.clone(),
                name: name.clone(),
                ..Service::default()
            });
        match kind {
            "Service" => {
                entry.service_type = text(first);
                entry.selector = pairs(second);
            }
            "Endpoints" => {
                entry.ready_endpoints = first.len();
                entry.not_ready_endpoints = second.len();
            }
            _ => return None,
        }
    }
    // An Endpoints object without a Service is possible and has nothing to group.
    Some(
        merged
            .into_values()
            .filter(|service| !service.service_type.is_empty())
            .collect(),
    )
}

fn node(line: &str) -> Option<Node> {
    let [name, ready, unschedulable, cpu, memory] = fields::<5>(line)?;
    Some(Node {
        name: text(name),
        ready: is_true(ready),
        unschedulable: is_true(unschedulable),
        cpu_allocatable: cpu_millis(cpu),
        memory_allocatable: memory_bytes(memory),
    })
}

fn usages<T>(text: &str, parse: impl Fn(&[&str]) -> Option<Option<T>>) -> Option<Vec<T>> {
    let mut items = Vec::new();
    for line in records(text) {
        if line.len() > MAX_LINE {
            return None;
        }
        let columns: Vec<&str> = line.split_whitespace().collect();
        items.extend(parse(&columns)?);
    }
    Some(items)
}

/// The inner `None` is a pod with no sample yet, which `top` prints as `<unknown>`.
fn pod_usage(columns: &[&str], namespace: &str) -> Option<Option<PodUsage>> {
    let (found, name, cpu, memory) = match *columns {
        [found, name, cpu, memory] if namespace.is_empty() => (found, name, cpu, memory),
        [name, cpu, memory] if !namespace.is_empty() => (namespace, name, cpu, memory),
        _ => return None,
    };
    if cpu == "<unknown>" || memory == "<unknown>" {
        return Some(None);
    }
    Some(Some(PodUsage {
        namespace: text(found),
        name: text(name),
        cpu: cpu_millis(cpu)?,
        memory: memory_bytes(memory)?,
    }))
}

fn node_usage(columns: &[&str]) -> Option<Option<NodeUsage>> {
    let [name, cpu, _, memory, _] = *columns else {
        return None;
    };
    if cpu == "<unknown>" || memory == "<unknown>" {
        return Some(None);
    }
    Some(Some(NodeUsage {
        name: text(name),
        cpu: cpu_millis(cpu)?,
        memory: memory_bytes(memory)?,
    }))
}

/// Newest first and capped: a busy cluster keeps thousands of warnings for an hour.
fn events(text_output: &str) -> Option<Vec<Event>> {
    let mut items = lines(text_output, event)?;
    items.sort_by(|a, b| b.time.cmp(&a.time));
    items.truncate(MAX_EVENTS);
    Some(items)
}

fn event(line: &str) -> Option<Event> {
    let [
        namespace,
        object_kind,
        object_name,
        reason,
        last,
        event_time,
        created,
        message,
    ] = fields::<8>(line)?;
    let time = [last, event_time, created]
        .into_iter()
        .map(text)
        .find(|value| !value.is_empty())
        .unwrap_or_default();
    Some(Event {
        namespace: text(namespace),
        object_kind: text(object_kind),
        object_name: text(object_name),
        reason: text(&decode(reason)),
        time,
        message: shown(&decode(message), MAX_MESSAGE),
    })
}

#[cfg(test)]
mod tests;
