//! KV.10 against a real OpenSSH server and a real kind cluster: the detection template, the
//! `get --raw` proxy path, RBAC and what is never requested. The pods are busybox `httpd` serving
//! fixed stand-in text, so this says nothing about real vLLM or DCGM output.
use super::{
    action_cluster_test::{Cluster, connect},
    ai_collect::{self, AiTargets, ScrapeStatus},
    runner::Link,
    settings::KubeSettings,
    state::KubeState,
};
use crate::storage::Store;
use std::{process::Command, sync::Arc, time::Duration};
use tokio::sync::Semaphore;

const NAMESPACE: &str = "kv10-ai";
const GPU_NAMESPACE: &str = "kv10-gpu";

/// A pod serving `text` at `/metrics` on 8000, logging every request it gets.
fn serving(name: &str, namespace: &str, annotations: &str, text: &str) -> String {
    // Stays on one line of the YAML block; `printf` turns it back into a line break.
    let text = text.replace('\n', "\\n");
    format!(
        r#"---
apiVersion: v1
kind: Pod
metadata:
  name: {name}
  namespace: {namespace}
  annotations: {{ {annotations} }}
spec:
  terminationGracePeriodSeconds: 1
  containers:
    - name: app
      image: "busybox:1.36"
      ports: [{{ containerPort: 8000 }}]
      command:
        - sh
        - -c
        - |
          mkdir -p /www/admin
          printf '{text}' > /www/metrics
          printf 'secret' > /www/admin/delete
          exec httpd -f -vv -p 8000 -h /www
"#
    )
}

const VLLM_TEXT: &str = "vllm:num_requests_running{model_name=\"stand-in\"} 3\nvllm:generation_tokens_total{model_name=\"stand-in\"} 42\n";
const DCGM_TEXT: &str =
    "DCGM_FI_DEV_GPU_UTIL{gpu=\"0\",UUID=\"GPU-a\",namespace=\"kv10-ai\",pod=\"annotated\"} 55\n";

fn manifest() -> String {
    let vllm = "podtree.io/monitor: vllm";
    let parts = [
        serving(
            "annotated",
            NAMESPACE,
            &format!("{vllm}, podtree.io/metrics-port: \"8000\""),
            VLLM_TEXT,
        ),
        serving("other-engine", NAMESPACE, vllm, "up 1"),
        serving(
            "bad-path",
            NAMESPACE,
            &format!("{vllm}, podtree.io/metrics-path: /admin/delete"),
            VLLM_TEXT,
        ),
        serving(
            "wrong-port",
            NAMESPACE,
            &format!("{vllm}, podtree.io/metrics-port: \"8999\""),
            VLLM_TEXT,
        ),
        // Neutral text: the rule searches the command line, and this script is on it.
        serving("plain", NAMESPACE, "", "up 1"),
        serving(
            "elsewhere",
            GPU_NAMESPACE,
            &format!("{vllm}, podtree.io/metrics-port: \"8000\""),
            VLLM_TEXT,
        ),
        serving(
            "dcgm-exporter-0",
            GPU_NAMESPACE,
            "podtree.io/metrics-port: \"8000\"",
            DCGM_TEXT,
        ),
    ]
    .join("");
    format!(
        "apiVersion: v1\nkind: Namespace\nmetadata: {{ name: {NAMESPACE} }}\n---\n\
         apiVersion: v1\nkind: Namespace\nmetadata: {{ name: {GPU_NAMESPACE} }}\n{parts}"
    )
}

const LIMITED: &str = r#"
apiVersion: v1
kind: ServiceAccount
metadata: { name: kv10-limited, namespace: kv10-ai }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: kv10-limited, namespace: kv10-ai }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [{ kind: ServiceAccount, name: kv10-limited, namespace: kv10-ai }]
"#;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs scripts/kube-fixture.sh; run with npm run test:kube-ai"]
async fn real_cluster_ai_reads_only_detected_endpoints() {
    let cluster = Cluster::from_env();
    let context = format!("kind-{}", cluster.name);
    cluster.kube(&format!(
        "delete namespace {NAMESPACE} {GPU_NAMESPACE} --ignore-not-found"
    ));
    cluster.apply(&manifest());
    for (namespace, name) in [
        (NAMESPACE, "annotated"),
        (NAMESPACE, "other-engine"),
        (NAMESPACE, "bad-path"),
        (NAMESPACE, "wrong-port"),
        (NAMESPACE, "plain"),
        (GPU_NAMESPACE, "elsewhere"),
        (GPU_NAMESPACE, "dcgm-exporter-0"),
    ] {
        cluster.kube(&format!(
            "-n {namespace} wait --for=condition=Ready pod/{name} --timeout=240s"
        ));
    }

    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("db")).unwrap());
    let (_manager, handle, _id) = connect(&store, dir.path().join("known_hosts"), &cluster).await;
    let settings = |namespace: &str, kubeconfig: &str| KubeSettings {
        context: context.clone(),
        namespace: namespace.into(),
        kubectl: "/opt/kube/bin/kubectl".into(),
        kubeconfig: kubeconfig.into(),
        operate: false,
    };
    let read = |namespace: &'static str, kubeconfig: &'static str, key: &'static str| {
        let (handle, kube) = (handle.clone(), settings(namespace, kubeconfig));
        let registry = AiTargets::default();
        async move {
            ai_collect::collect(
                &registry,
                Link::Ssh(handle),
                Arc::new(Semaphore::new(4)),
                key,
                &kube,
            )
            .await
        }
    };

    // The whole cluster, in read-only mode: `operate` is false above.
    let all = read("", "/opt/kube/config", "all").await;
    assert_eq!(all.state(), &KubeState::Ready);
    let annotated = all.pod_named("annotated").expect("annotated pod detected");
    assert_eq!(annotated.status(), ScrapeStatus::Ok);
    assert!(annotated.has_sample());
    assert!(all.pod_named("elsewhere").is_some());
    println!("PASS detection template and proxy read (stand-in text, parser only)");

    assert!(
        all.pod_named("plain").is_none(),
        "an unmarked pod is not read"
    );
    assert_eq!(
        all.pod_named("other-engine").unwrap().status(),
        ScrapeStatus::NoSupported
    );
    assert_eq!(
        all.pod_named("wrong-port").unwrap().status(),
        ScrapeStatus::Unreachable
    );
    let bad = all.pod_named("bad-path").unwrap();
    assert_eq!(bad.status(), ScrapeStatus::InvalidTarget);
    assert_eq!(bad.endpoint(), "");
    println!("PASS no match, wrong port and a forbidden path are told apart");

    // The pod's own log is the proof: an annotated path outside `/metrics` was never requested.
    let log = cluster.kube(&format!("-n {NAMESPACE} logs bad-path"));
    assert!(
        !log.contains("/admin/delete"),
        "the path was requested: {log}"
    );
    let served = cluster.kube(&format!("-n {NAMESPACE} logs annotated"));
    assert!(
        served.contains("/metrics"),
        "no request reached it: {served}"
    );
    println!("PASS the annotated path was never requested; the pod's log shows only /metrics");

    assert_eq!(all.exporters_ok(), 1);
    assert_eq!(all.devices(), 1);

    // Scoped to one namespace: its own vLLM pods, and exporters from anywhere.
    let scoped = read(NAMESPACE, "/opt/kube/config", "scoped").await;
    assert!(scoped.pod_named("annotated").is_some());
    assert!(scoped.pod_named("elsewhere").is_none());
    assert_eq!(scoped.exporters_ok(), 1);
    assert!(!scoped.gpu_restricted());
    println!("PASS a namespace scope keeps vLLM inside it and still finds exporters");

    // An account with `view`: it may list its namespace but has no `pods/proxy`.
    cluster.apply(LIMITED);
    let k = "/opt/kube/bin/kubectl --kubeconfig /opt/kube/config";
    let name = &cluster.name;
    assert_eq!(
        cluster.shell(&format!(
            "T=$({k} -n {NAMESPACE} create token kv10-limited --duration=1h) && cp /opt/kube/config /opt/kube/limited-ai && \
             {k} --kubeconfig /opt/kube/limited-ai config set-credentials kv10-limited --token=\"$T\" >/dev/null && \
             {k} --kubeconfig /opt/kube/limited-ai config set-context kind-{name} --cluster=kind-{name} --user=kv10-limited >/dev/null && \
             chown probe:probe /opt/kube/limited-ai && chmod 600 /opt/kube/limited-ai; echo $?"
        )),
        "0"
    );
    tokio::time::sleep(Duration::from_secs(2)).await;
    let limited = read(NAMESPACE, "/opt/kube/limited-ai", "limited").await;
    assert_eq!(limited.state(), &KubeState::Ready);
    assert_eq!(
        limited.pod_named("annotated").unwrap().status(),
        ScrapeStatus::Forbidden
    );
    assert!(limited.gpu_restricted());
    println!("PASS no pods/proxy reads as forbidden, and no cluster-wide list as restricted GPU");

    // The same read from this computer's kubectl, with no connection at all (KV.11).
    let config = dir.path().join("local-kubeconfig");
    let written = Command::new("kind")
        .args(["get", "kubeconfig", "--name", &cluster.name])
        .output()
        .unwrap();
    assert!(written.status.success(), "kind wrote no kubeconfig");
    std::fs::write(&config, written.stdout).unwrap();
    let found = Command::new("sh")
        .args(["-c", "command -v kubectl"])
        .output()
        .unwrap();
    let local = KubeSettings {
        context: context.clone(),
        namespace: String::new(),
        kubectl: String::from_utf8_lossy(&found.stdout).trim().into(),
        kubeconfig: config.to_string_lossy().into_owned(),
        operate: false,
    };
    local.validate_local().unwrap();
    let registry = AiTargets::default();
    let semaphore = Arc::new(Semaphore::new(4));
    let read = ai_collect::collect(&registry, Link::Local, semaphore, "local", &local).await;
    assert_eq!(read.state(), &KubeState::Ready);
    assert!(read.pod_named("annotated").unwrap().has_sample());
    assert_eq!(
        read.pod_named("bad-path").unwrap().status(),
        ScrapeStatus::InvalidTarget
    );
    assert_eq!(read.exporters_ok(), 1);
    let log = cluster.kube(&format!("-n {NAMESPACE} logs bad-path"));
    assert!(!log.contains("/admin/delete"), "the path was requested");
    println!("PASS a local kubeconfig detects and reads the same targets without a connection");

    cluster.kube(&format!(
        "delete namespace {NAMESPACE} {GPU_NAMESPACE} --ignore-not-found --wait=false"
    ));
}
