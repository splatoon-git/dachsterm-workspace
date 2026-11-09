//! KV.6 against a real OpenSSH server and a real kind cluster: the app's own connection, profile
//! re-read and command lines, with the cluster's state read separately through `docker exec`.
//! Never print the fixture's passwords or the limited account's token.
use super::home::Home;
use super::{
    action::{self, Action, RolloutKind, permit},
    runner::Runner,
    settings::{KubeSettings, Workspace},
};
use crate::{
    ssh::{Connections, Event, Host},
    storage::{Store, tests::profile},
};
use russh::client;
use std::{
    process::Command,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::mpsc;
use zeroize::Zeroizing;

const NAMESPACE: &str = "kv6-control";

const MANIFEST: &str = r#"
apiVersion: v1
kind: Namespace
metadata: { name: kv6-control }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: kv6-control }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      terminationGracePeriodSeconds: 30
      containers: [{ name: app, image: "busybox:1.36", command: [sleep, "3600"] }]
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: db, namespace: kv6-control }
spec:
  serviceName: db
  replicas: 1
  selector: { matchLabels: { app: db } }
  template:
    metadata: { labels: { app: db } }
    spec:
      terminationGracePeriodSeconds: 1
      containers: [{ name: app, image: "busybox:1.36", command: [sleep, "3600"] }]
---
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: agent, namespace: kv6-control }
spec:
  selector: { matchLabels: { app: agent } }
  template:
    metadata: { labels: { app: agent } }
    spec:
      terminationGracePeriodSeconds: 1
      containers: [{ name: app, image: "busybox:1.36", command: [sleep, "3600"] }]
---
apiVersion: v1
kind: Pod
metadata: { name: lonely, namespace: kv6-control }
spec:
  terminationGracePeriodSeconds: 1
  containers: [{ name: app, image: "busybox:1.36", command: [sleep, "3600"] }]
"#;

const LIMITED: &str = r#"
apiVersion: v1
kind: ServiceAccount
metadata: { name: kv6-limited, namespace: kv6-control }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: kv6-limited, namespace: kv6-control }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [{ kind: ServiceAccount, name: kv6-limited, namespace: kv6-control }]
"#;

pub(super) struct Cluster {
    pub(super) name: String,
    pub(super) ssh: String,
    kubectl: String,
}

impl Cluster {
    pub(super) fn from_env() -> Self {
        let name = std::env::var("DACHSTERM_KUBE_FIXTURE").unwrap_or_else(|_| "kv6".into());
        Self {
            ssh: format!("{name}-ssh"),
            kubectl: format!(
                "/opt/kube/bin/kubectl --kubeconfig /opt/kube/config --context kind-{name}"
            ),
            name,
        }
    }

    /// As root in the server container, for setting up and for looking at the result.
    pub(super) fn shell(&self, script: &str) -> String {
        let output = Command::new("docker")
            .args(["exec", &self.ssh, "sh", "-c", script])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    pub(super) fn kube(&self, args: &str) -> String {
        self.shell(&format!("{} {args}", self.kubectl))
    }

    pub(super) fn apply(&self, yaml: &str) {
        let script = format!(
            "cat > /tmp/kv6.yaml <<'YAML'\n{yaml}\nYAML\n{} apply -f /tmp/kv6.yaml >/dev/null 2>&1; echo $?",
            self.kubectl
        );
        assert_eq!(self.shell(&script), "0", "manifest did not apply");
    }

    fn pods(&self, selector: &str) -> Vec<String> {
        let names = self.kube(&format!(
            "-n {NAMESPACE} get pods -l {selector} --field-selector=status.phase=Running \
             -o go-template='{{{{range .items}}}}{{{{if not .metadata.deletionTimestamp}}}}{{{{.metadata.name}}}}{{{{\"\\n\"}}}}{{{{end}}}}{{{{end}}}}'"
        ));
        names.lines().map(String::from).collect()
    }

    /// The stamp `rollout restart` writes, or empty before the first one.
    fn restarted_at(&self, resource: &str) -> String {
        let value = self.kube(&format!(
            "-n {NAMESPACE} get {resource} -o go-template='{{{{with .spec.template.metadata.annotations}}}}{{{{index . \"kubectl.kubernetes.io/restartedAt\"}}}}{{{{end}}}}'"
        ));
        if value == "<no value>" {
            String::new()
        } else {
            value
        }
    }

    fn uids(&self, selector: &str) -> Vec<String> {
        let found = self.kube(&format!(
            "-n {NAMESPACE} get pods -l {selector} --field-selector=status.phase=Running \
             -o go-template='{{{{range .items}}}}{{{{if not .metadata.deletionTimestamp}}}}{{{{.metadata.uid}}}}{{{{\"\\n\"}}}}{{{{end}}}}{{{{end}}}}'"
        ));
        found.lines().map(String::from).collect()
    }

    fn unschedulable(&self, node: &str) -> String {
        self.kube(&format!(
            "get node {node} -o go-template='{{{{.spec.unschedulable}}}}'"
        ))
    }
}

fn settle(what: &str, limit: Duration, mut done: impl FnMut() -> bool) {
    let start = Instant::now();
    while !done() {
        assert!(start.elapsed() < limit, "timed out: {what}");
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// The app's real connection path, to the fixture's real OpenSSH server.
pub(super) async fn connect(
    store: &Arc<Store>,
    known_hosts: std::path::PathBuf,
    cluster: &Cluster,
) -> (Arc<Connections>, Arc<client::Handle<Host>>, String) {
    let mapped = Command::new("docker")
        .args(["port", &cluster.ssh, "22/tcp"])
        .output()
        .unwrap();
    let mapped = String::from_utf8_lossy(&mapped.stdout);
    let port = mapped.lines().next().unwrap().rsplit(':').next().unwrap();
    let mut p = profile();
    p.name = "kv6-connection".into();
    p.host = "127.0.0.1".into();
    p.port = port.trim().parse().unwrap();
    p.username = "probe".into();
    p.auth = "password".into();
    p.protocol = "ssh".into();
    let p = store.save(p, None).unwrap();
    let password = Zeroizing::new(cluster.shell("cat /run/probe/password"));

    let manager = Arc::new(Connections::default());
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = mpsc::channel(256);
    manager
        .start(
            id.clone(),
            p,
            password,
            vec![known_hosts],
            Arc::new(move |event| tx.try_send(event).map_err(|_| "event receiver full".into())),
            store.clone(),
        )
        .unwrap();
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (events, control_id) = (manager.clone(), id.clone());
    tokio::spawn(async move {
        let mut ready = Some(ready_tx);
        while let Some(event) = rx.recv().await {
            let Ok(control) = events.control(&control_id) else {
                break;
            };
            match event {
                Event::HostKey { .. } => control.trust.send(Some(true)).unwrap(),
                Event::Data { seq, .. } => control.ack.send(seq).unwrap(),
                Event::State { status, message } => {
                    if status == "error" {
                        panic!("connection failed: {message}");
                    }
                    if status == "connected"
                        && let Some(ready) = ready.take()
                    {
                        ready.send(()).unwrap();
                    }
                }
                _ => {}
            }
        }
    });
    tokio::time::timeout(Duration::from_secs(30), ready_rx)
        .await
        .expect("connection timed out")
        .unwrap();
    let handle = manager.handle(&id).unwrap();
    (manager, handle, id)
}

fn kube_profile(store: &Store, name: &str, kube: KubeSettings) -> String {
    let mut p = profile();
    p.name = name.into();
    p.workspace = Workspace::Kubernetes;
    p.kube = Some(kube);
    store.save(p, None).unwrap().id
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs scripts/kube-fixture.sh; run with npm run test:kube-actions"]
async fn real_cluster_actions_reach_the_cluster_only_in_operate_mode() {
    let cluster = Cluster::from_env();
    let context = format!("kind-{}", cluster.name);
    let node = format!("{}-control-plane", cluster.name);
    cluster.kube(&format!("delete namespace {NAMESPACE} --ignore-not-found"));
    cluster.kube(&format!("uncordon {node}"));
    cluster.apply(MANIFEST);
    for resource in ["deployment/web", "statefulset/db", "daemonset/agent"] {
        cluster.kube(&format!(
            "-n {NAMESPACE} rollout status {resource} --timeout=240s"
        ));
    }
    cluster.kube(&format!(
        "-n {NAMESPACE} wait --for=condition=Ready pod/lonely --timeout=240s"
    ));

    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("db")).unwrap());
    let (manager, handle, _id) = connect(&store, dir.path().join("known_hosts"), &cluster).await;
    let runner = Runner::Ssh(&handle);
    let settings = |kubeconfig: &str, operate: bool| KubeSettings {
        context: context.clone(),
        namespace: String::new(),
        kubectl: "/opt/kube/bin/kubectl".into(),
        kubeconfig: kubeconfig.into(),
        operate,
    };
    let session = kube_profile(&store, "kv6", settings("/opt/kube/config", false));

    // Read-only: the stored profile refuses before anything reaches the server.
    let before = cluster.pods("app=web");
    assert_eq!(before.len(), 2);
    let delete_web = Action::DeletePod {
        namespace: NAMESPACE.into(),
        pod: before[0].clone(),
    };
    let refused = permit(
        &store,
        &Home::Profile(session.clone()),
        &context,
        &delete_web,
    )
    .unwrap_err();
    assert!(refused.contains("조회 모드"), "{refused}");
    assert_eq!(cluster.pods("app=web"), before);
    println!("PASS read-only mode refuses from the stored profile; pods unchanged");

    action::set_operate_mode(&store, &Home::Profile(session.clone()), true).unwrap();
    let run = |action: Action| {
        let kube = permit(&store, &Home::Profile(session.clone()), &context, &action).unwrap();
        let runner = &runner;
        async move { action::run(runner, &kube, &action).await }
    };

    // A delete does not wait out the 30-second grace period, and the owner replaces the pod.
    let started = Instant::now();
    run(delete_web.clone()).await.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "delete waited {:?}",
        started.elapsed()
    );
    settle("a replacement pod", Duration::from_secs(120), || {
        let now = cluster.pods("app=web");
        now.len() == 2 && !now.contains(&before[0])
    });
    println!("PASS delete of an owned pod returned at once and the owner replaced it");

    // Nothing brings back a pod without an owner.
    run(Action::DeletePod {
        namespace: NAMESPACE.into(),
        pod: "lonely".into(),
    })
    .await
    .unwrap();
    let lonely_gone = || {
        cluster
            .kube(&format!("-n {NAMESPACE} get pod lonely -o name"))
            .is_empty()
    };
    settle("the lone pod to go", Duration::from_secs(60), lonely_gone);
    std::thread::sleep(Duration::from_secs(5));
    assert!(lonely_gone(), "a pod without an owner came back");
    println!("PASS delete of a pod without an owner is permanent");

    // What the confirmation says about a static pod: the kubelet puts the mirror back.
    let mirror = format!("kube-scheduler-{node}");
    let container_of = || {
        cluster.kube(&format!(
            "-n kube-system get pod {mirror} -o go-template='{{{{(index .status.containerStatuses 0).containerID}}}}'"
        ))
    };
    let mirror_uid = || {
        cluster.kube(&format!(
            "-n kube-system get pod {mirror} -o go-template='{{{{.metadata.uid}}}}'"
        ))
    };
    // A mirror pod that was just recreated has not reported its container yet.
    let reported = || container_of().starts_with("containerd://");
    settle(
        "the mirror pod to report",
        Duration::from_secs(120),
        reported,
    );
    let (container, uid) = (container_of(), mirror_uid());
    assert_eq!(
        cluster.kube(&format!(
            "-n kube-system get pod {mirror} -o go-template='{{{{(index .metadata.ownerReferences 0).kind}}}}'"
        )),
        "Node"
    );
    run(Action::DeletePod {
        namespace: "kube-system".into(),
        pod: mirror.clone(),
    })
    .await
    .unwrap();
    // It waits out the mirror's 30-second grace period first: about a minute on kind.
    settle("the mirror pod to return", Duration::from_secs(180), || {
        let now = mirror_uid();
        !now.is_empty() && now != uid && reported()
    });
    assert_eq!(
        container_of(),
        container,
        "the static pod's container moved"
    );
    println!("PASS delete of a static pod's mirror: kubelet recreated it, container untouched");

    // Each rollout kind really rolls.
    for (workload, resource, name, selector) in [
        (RolloutKind::Deployment, "deployment/web", "web", "app=web"),
        (RolloutKind::StatefulSet, "statefulset/db", "db", "app=db"),
        (
            RolloutKind::DaemonSet,
            "daemonset/agent",
            "agent",
            "app=agent",
        ),
    ] {
        let before = cluster.uids(selector);
        assert_eq!(cluster.restarted_at(resource), "", "{resource}");
        run(Action::RolloutRestart {
            namespace: NAMESPACE.into(),
            workload,
            name: name.into(),
        })
        .await
        .unwrap();
        assert_ne!(
            cluster.restarted_at(resource),
            "",
            "{resource} has no restart stamp"
        );
        assert_eq!(
            cluster.shell(&format!(
                "{} -n {NAMESPACE} rollout status {resource} --timeout=240s >/dev/null 2>&1; echo $?",
                cluster.kubectl
            )),
            "0",
            "{resource} did not finish"
        );
        // A StatefulSet keeps its pod names, so a pod's identity is its UID.
        let now = cluster.uids(selector);
        assert_eq!(now.len(), before.len(), "{resource}");
        assert!(
            now.iter().all(|uid| !before.contains(uid)),
            "{resource} kept an old pod"
        );
        println!("PASS rollout restart of {resource} replaced its pods");
    }

    // Cordon changes what is scheduled, not what runs.
    let running = cluster.pods("app=web");
    run(Action::Cordon { node: node.clone() }).await.unwrap();
    assert_eq!(cluster.unschedulable(&node), "true");
    assert_eq!(cluster.pods("app=web"), running);
    cluster.kube(&format!(
        "-n {NAMESPACE} run after-cordon --image=busybox:1.36 --restart=Never --command -- sleep 3600"
    ));
    let phase = || {
        cluster.kube(&format!(
            "-n {NAMESPACE} get pod after-cordon -o go-template='{{{{.status.phase}}}}/{{{{.spec.nodeName}}}}'"
        ))
    };
    std::thread::sleep(Duration::from_secs(6));
    assert!(phase().starts_with("Pending/"), "{}", phase());
    println!("PASS cordon: running pods stayed and a new pod stayed Pending");

    run(Action::Uncordon { node: node.clone() }).await.unwrap();
    assert_eq!(cluster.unschedulable(&node), "<no value>");
    settle(
        "the pending pod to schedule",
        Duration::from_secs(120),
        || phase().ends_with(&node),
    );
    println!("PASS uncordon: the pending pod was scheduled");

    // RBAC decides, and a refusal comes back in the server's words.
    cluster.apply(LIMITED);
    assert_eq!(
        cluster.shell(&format!(
            "T=$({k} -n {NAMESPACE} create token kv6-limited --duration=1h) && cp /opt/kube/config /opt/kube/limited && \
             {k} --kubeconfig /opt/kube/limited config set-credentials kv6-limited --token=\"$T\" >/dev/null && \
             {k} --kubeconfig /opt/kube/limited config set-context kind-{name} --cluster=kind-{name} --user=kv6-limited >/dev/null && \
             chown probe:probe /opt/kube/limited && chmod 600 /opt/kube/limited; echo $?",
            k = "/opt/kube/bin/kubectl --kubeconfig /opt/kube/config --context kind-".to_string() + &cluster.name,
            name = cluster.name,
        )),
        "0"
    );
    let limited = kube_profile(&store, "kv6-limited", settings("/opt/kube/limited", true));
    let survivor = cluster.pods("app=web")[0].clone();
    let forbidden = Action::DeletePod {
        namespace: NAMESPACE.into(),
        pod: survivor.clone(),
    };
    let kube = permit(
        &store,
        &Home::Profile(limited.clone()),
        &context,
        &forbidden,
    )
    .unwrap();
    let error = action::run(&runner, &kube, &forbidden).await.unwrap_err();
    assert!(
        error.contains("forbidden") && error.contains("kv6-limited"),
        "{error}"
    );
    assert!(cluster.pods("app=web").contains(&survivor));
    println!("PASS RBAC refusal shown in the server's words: {error}");

    let error = run(Action::DeletePod {
        namespace: NAMESPACE.into(),
        pod: "no-such-pod".into(),
    })
    .await
    .unwrap_err();
    assert!(error.contains("not found"), "{error}");
    println!("PASS a missing target reports the server's words: {error}");

    manager.shutdown();
    cluster.kube(&format!("delete namespace {NAMESPACE} --wait=false"));
}
