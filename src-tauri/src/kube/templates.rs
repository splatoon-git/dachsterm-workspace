//! go-templates for `kube_snapshot`. Listing every namespace as `-o json` is 65.8MB where these are
//! 3.75MB (KV.0), because the fields are picked on the server. Records are one line of tab-separated
//! fields. Free text the API server does not restrict (reasons, messages) goes through `urlquery`
//! so it cannot break a line; `snapshot::decode` reverses it.

/// `name;ready;restarts;waiting;terminated;lastReason;lastFinished;lastExitCode|`
macro_rules! container_status {
    () => {
        concat!(
            "{{.name}};{{.ready}};{{.restartCount}};",
            "{{with .state}}{{with .waiting}}{{with .reason}}{{urlquery .}}{{end}}{{end}}{{end}};",
            "{{with .state}}{{with .terminated}}{{with .reason}}{{urlquery .}}{{end}}{{end}}{{end}};",
            "{{with .lastState}}{{with .terminated}}",
            "{{with .reason}}{{urlquery .}}{{end}};{{.finishedAt}};{{.exitCode}}",
            "{{else}};;{{end}}{{else}};;{{end}}|",
        )
    };
}

pub const PODS: &str = concat!(
    "{{range .items}}",
    "{{.metadata.namespace}}\t{{.metadata.name}}\t{{.spec.nodeName}}\t{{.status.phase}}\t",
    "{{with .status.reason}}{{urlquery .}}{{end}}\t",
    "{{.metadata.creationTimestamp}}\t{{.metadata.deletionTimestamp}}\t",
    "{{range .metadata.ownerReferences}}{{.kind}}/{{.name}},{{end}}\t",
    "{{range $k,$v := .metadata.labels}}{{$k}}={{$v}},{{end}}\t",
    "{{range .spec.containers}}",
    "{{with .resources.requests}}{{.cpu}};{{.memory}}{{else}};{{end}};",
    "{{with .resources.limits}}{{.cpu}};{{.memory}}{{else}};{{end}}|",
    "{{end}}\t",
    "{{range .status.initContainerStatuses}}",
    container_status!(),
    "{{end}}\t",
    "{{range .status.containerStatuses}}",
    container_status!(),
    "{{end}}\t",
    // What kubectl reads when no container is named. Status order is not spec order.
    "{{with .metadata.annotations}}{{index . \"kubectl.kubernetes.io/default-container\"}}{{end}}\t",
    "{{(index .spec.containers 0).name}}\n{{end}}",
);

pub const WORKLOADS: &str = concat!(
    "{{range .items}}{{.kind}}\t{{.metadata.namespace}}\t{{.metadata.name}}\t",
    "{{if eq .kind \"DaemonSet\"}}{{.status.desiredNumberScheduled}}\t{{.status.numberReady}}",
    "{{else}}{{.spec.replicas}}\t{{.status.readyReplicas}}{{end}}\n{{end}}",
);

/// Both kinds are five fields. An Endpoints record counts its addresses with one dot each, because
/// `len` fails on a subset without `notReadyAddresses`.
pub const SERVICES: &str = concat!(
    "{{range .items}}{{.kind}}\t{{.metadata.namespace}}\t{{.metadata.name}}\t",
    "{{if eq .kind \"Service\"}}{{.spec.type}}\t",
    "{{range $k,$v := .spec.selector}}{{$k}}={{$v}},{{end}}",
    "{{else}}{{range .subsets}}{{range .addresses}}.{{end}}{{end}}\t",
    "{{range .subsets}}{{range .notReadyAddresses}}.{{end}}{{end}}{{end}}\n{{end}}",
);

pub const NODES: &str = concat!(
    "{{range .items}}{{.metadata.name}}\t",
    "{{range .status.conditions}}{{if eq .type \"Ready\"}}{{.status}}{{end}}{{end}}\t",
    "{{.spec.unschedulable}}\t{{.status.allocatable.cpu}}\t{{.status.allocatable.memory}}\n{{end}}",
);

pub const EVENTS: &str = concat!(
    "{{range .items}}{{.metadata.namespace}}\t{{.involvedObject.kind}}\t{{.involvedObject.name}}\t",
    "{{with .reason}}{{urlquery .}}{{end}}\t",
    "{{.lastTimestamp}}\t{{.eventTime}}\t{{.metadata.creationTimestamp}}\t",
    "{{with .message}}{{urlquery .}}{{end}}\n{{end}}",
);

/// `kube_detail`'s events for one pod: Normal and Warning alike, unlike `EVENTS` above.
pub const POD_EVENTS: &str = concat!(
    "{{range .items}}{{.type}}\t",
    "{{with .reason}}{{urlquery .}}{{end}}\t{{.count}}\t",
    "{{.lastTimestamp}}\t{{.eventTime}}\t{{.metadata.creationTimestamp}}\t",
    "{{with .message}}{{urlquery .}}{{end}}\n{{end}}",
);
