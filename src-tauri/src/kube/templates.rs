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

pub const PVCS: &str =
    "{{range .items}}{{.metadata.namespace}}\t{{.metadata.name}}\t{{.status.phase}}\n{{end}}";

/// The last field is `time;reason`, and empty unless the Job has given up.
pub const JOBS: &str = concat!(
    "{{range .items}}{{.metadata.namespace}}\t{{.metadata.name}}\t",
    "{{.metadata.creationTimestamp}}\t",
    "{{range .metadata.ownerReferences}}{{.kind}}/{{.name}},{{end}}\t",
    "{{range .status.conditions}}{{if and (eq .type \"Failed\") (eq .status \"True\")}}",
    "{{.lastTransitionTime}};{{with .reason}}{{urlquery .}}{{end}}{{end}}{{end}}\n{{end}}",
);

pub const HPAS: &str = concat!(
    "{{range .items}}{{.metadata.namespace}}\t{{.metadata.name}}\t",
    "{{.spec.scaleTargetRef.kind}}\t{{.spec.scaleTargetRef.name}}\t",
    "{{.spec.maxReplicas}}\t{{.status.currentReplicas}}\n{{end}}",
);

/// `kube_ingress`. Seven fields, with `host;path;pathType;service;port|` for each path. A path is
/// the one value here the API server leaves free, so it goes through `urlquery`.
pub const INGRESSES: &str = concat!(
    "{{range .items}}{{.metadata.namespace}}\t{{.metadata.name}}\t",
    "{{with .spec.ingressClassName}}{{.}}{{else}}{{with .metadata.annotations}}",
    "{{index . \"kubernetes.io/ingress.class\"}}{{end}}{{end}}\t",
    "{{range .status.loadBalancer.ingress}}{{with .ip}}{{.}}{{end}}{{with .hostname}}{{.}}{{end}},{{end}}\t",
    "{{range .spec.tls}}{{with .secretName}}{{.}}{{end}};{{range .hosts}}{{.}},{{end}}|{{end}}\t",
    "{{with .spec.defaultBackend}}{{with .service}}{{.name}};",
    "{{with .port}}{{if .number}}{{.number}}{{else}}{{.name}}{{end}}{{end}}{{end}}{{end}}\t",
    "{{range .spec.rules}}{{$h := .host}}{{with .http}}{{range .paths}}",
    "{{$h}};{{with .path}}{{urlquery .}}{{end}};{{.pathType}};",
    "{{with .backend.service}}{{.name}};",
    "{{with .port}}{{if .number}}{{.number}}{{else}}{{.name}}{{end}}{{end}}{{else}};{{end}}|",
    "{{end}}{{else}}{{$h}};;;;|{{end}}{{end}}\n{{end}}",
);

/// Names only. `-o name` would leave out the namespace when listing every namespace.
pub const SECRET_NAMES: &str =
    "{{range .items}}{{.metadata.namespace}}\t{{.metadata.name}}\n{{end}}";

pub const INGRESS_CONTROLLERS: &str = concat!(
    "{{range .items}}{{.metadata.namespace}}\t{{.metadata.name}}\t",
    "{{with .metadata.annotations}}{{index . \"kubectl.kubernetes.io/default-container\"}}{{end}}\t",
    "{{(index .spec.containers 0).name}}\n{{end}}",
);

/// One annotation's value, or nothing. `with`, because `index` prints `<no value>` for a missing
/// key. Annotation values are free text, so they go through `urlquery`.
macro_rules! annotation {
    ($key:literal) => {
        concat!(
            "{{with .metadata.annotations}}{{with index . \"",
            $key,
            "\"}}{{urlquery .}}{{end}}{{end}}"
        )
    };
}

/// `kube_ai`'s detection: thirteen fields. Images, commands and arguments are free text, and only
/// the last three are searched, so they share one field with a space between each.
pub const AI_PODS: &str = concat!(
    "{{range .items}}{{.metadata.namespace}}\t{{.metadata.name}}\t{{.spec.nodeName}}\t",
    "{{.status.phase}}\t{{.metadata.uid}}\t",
    "{{range .status.containerStatuses}}{{.restartCount}},{{end}}\t",
    "{{range .spec.containers}}{{range .ports}}{{.containerPort}},{{end}}{{end}}\t",
    "{{range .spec.containers}}{{urlquery .image}} ",
    "{{range .command}}{{urlquery .}} {{end}}{{range .args}}{{urlquery .}} {{end}}{{end}}\t",
    annotation!("podtree.io/monitor"),
    "\t",
    annotation!("podtree.io/metrics-port"),
    "\t",
    annotation!("podtree.io/metrics-path"),
    "\t",
    annotation!("prometheus.io/port"),
    "\t",
    annotation!("prometheus.io/path"),
    "\n{{end}}",
);

/// `kube_detail`'s events for one pod: Normal and Warning alike, unlike `EVENTS` above.
pub const POD_EVENTS: &str = concat!(
    "{{range .items}}{{.type}}\t",
    "{{with .reason}}{{urlquery .}}{{end}}\t{{.count}}\t",
    "{{.lastTimestamp}}\t{{.eventTime}}\t{{.metadata.creationTimestamp}}\t",
    "{{with .message}}{{urlquery .}}{{end}}\n{{end}}",
);
