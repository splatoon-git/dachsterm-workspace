//! The app's only writes to a cluster (design KV.6). There is no path for any other command: a write
//! is one of these variants, and the words on its command line are fixed here.
//!
//! The screen is not trusted for any of it. Whether operate mode is on, and which kubectl, kubeconfig
//! and context a write goes to, come from the profile as it is stored at the moment of the write.
use super::{
    Workspace,
    runner::{Failed, Kubectl, Runner},
    settings::{KubeSettings, check_namespace, check_node, check_pod},
    state::server_refusal,
};
use crate::{
    remote_exec::{Failure, Limits, quote},
    storage::{Profile, Result, Store},
};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// The kinds `kubectl rollout restart` works on. A ReplicaSet, Job or bare pod has no rollout.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RolloutKind {
    Deployment,
    StatefulSet,
    DaemonSet,
}
impl RolloutKind {
    fn resource(self) -> &'static str {
        match self {
            RolloutKind::Deployment => "deployment",
            RolloutKind::StatefulSet => "statefulset",
            RolloutKind::DaemonSet => "daemonset",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    DeletePod {
        namespace: String,
        pod: String,
    },
    RolloutRestart {
        namespace: String,
        workload: RolloutKind,
        name: String,
    },
    Cordon {
        node: String,
    },
    Uncordon {
        node: String,
    },
}

impl Action {
    pub fn check(&self) -> Result<()> {
        let namespaced = |namespace: &str| {
            if namespace.is_empty() {
                return Err("대상의 namespace가 필요합니다.".to_string());
            }
            check_namespace(namespace)
        };
        match self {
            Action::DeletePod { namespace, pod } => {
                namespaced(namespace)?;
                check_pod(pod)
            }
            Action::RolloutRestart {
                namespace, name, ..
            } => {
                namespaced(namespace)?;
                check_pod(name).map_err(|_| "워크로드 이름이 올바르지 않습니다.".to_string())
            }
            Action::Cordon { node } | Action::Uncordon { node } => check_node(node),
        }
    }

    fn namespace(&self) -> Option<&str> {
        match self {
            Action::DeletePod { namespace, .. } | Action::RolloutRestart { namespace, .. } => {
                Some(namespace)
            }
            Action::Cordon { .. } | Action::Uncordon { .. } => None,
        }
    }

    /// Names have passed `check` and are quoted anyway. `--wait=false` because a delete otherwise
    /// waits out the pod's grace period; the tree shows the outcome.
    fn arguments(&self) -> String {
        match self {
            Action::DeletePod { namespace, pod } => {
                format!(
                    "delete pod {} -n {} --wait=false",
                    quote(pod),
                    quote(namespace)
                )
            }
            Action::RolloutRestart {
                namespace,
                workload,
                name,
            } => format!(
                "rollout restart {} -n {}",
                quote(&format!("{}/{name}", workload.resource())),
                quote(namespace),
            ),
            Action::Cordon { node } => format!("cordon {}", quote(node)),
            Action::Uncordon { node } => format!("uncordon {}", quote(node)),
        }
    }
}

/// What the screen shows. `Unavailable` is a tab with nothing stored to switch: a terminal session
/// showing the workspace from its tab menu, or a session that has not been set up yet.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OperateMode {
    On,
    Off,
    Unavailable,
}

fn stored_settings(profile: Profile) -> Option<KubeSettings> {
    match profile.workspace {
        Workspace::Kubernetes => profile.kube,
        Workspace::Terminal => None,
    }
}

pub fn operate_mode(store: &Store, profile_id: &str) -> Result<OperateMode> {
    Ok(match stored_settings(store.profile(profile_id)?) {
        Some(kube) if kube.operate => OperateMode::On,
        Some(_) => OperateMode::Off,
        None => OperateMode::Unavailable,
    })
}

/// The one place that writes `operate`. `kube_save` and the session form keep the stored value, and
/// importing a session file cannot set it (design §3.1).
pub fn set_operate_mode(store: &Store, profile_id: &str, on: bool) -> Result<OperateMode> {
    let mut profile = store.profile(profile_id)?;
    if profile.workspace != Workspace::Kubernetes {
        return Err("쿠버네티스 세션에서만 운영 모드를 바꿀 수 있습니다.".into());
    }
    let Some(kube) = profile.kube.as_mut() else {
        return Err("클러스터 설정을 마친 뒤에 운영 모드를 바꿀 수 있습니다.".into());
    };
    kube.operate = on;
    let secret = store.secret_ref(profile_id)?;
    store.save(profile, secret)?;
    operate_mode(store, profile_id)
}

/// The confirmation named a context, so a write must not land on another one: a second tab on the
/// same session may have changed it since this screen opened. Anything unreadable refuses.
pub fn permit(
    store: &Store,
    profile_id: &str,
    confirmed_context: &str,
    action: &Action,
) -> Result<KubeSettings> {
    let kube = stored_settings(store.profile(profile_id)?)
        .ok_or("쿠버네티스 세션에서만 제어할 수 있습니다.")?;
    if !kube.operate {
        return Err("조회 모드에서는 제어할 수 없습니다. 운영 모드를 켜고 다시 시도하세요.".into());
    }
    kube.validate()?;
    if kube.context != confirmed_context {
        return Err(
            "이 세션의 클러스터 설정이 바뀌었습니다. 탭을 다시 열고 대상을 확인하세요.".into(),
        );
    }
    if !kube.namespace.is_empty() && action.namespace().is_some_and(|ns| ns != kube.namespace) {
        return Err("이 세션에서 보는 namespace 밖의 대상은 제어할 수 없습니다.".into());
    }
    Ok(kube)
}

/// Below `LIMITS`, so a server that does not answer ends in kubectl's own error when it can.
const REQUEST_SECONDS: u32 = 15;
const LIMITS: Limits = Limits {
    timeout: Duration::from_secs(20),
    max_output: 64 * 1024,
};

fn command_line(kube: &KubeSettings, action: &Action) -> String {
    Kubectl {
        command: &kube.kubectl,
        kubeconfig: &kube.kubeconfig,
    }
    .cluster_within(&kube.context, REQUEST_SECONDS, &action.arguments())
}

fn outcome(exit: Option<u32>, stderr: &[u8]) -> Result<()> {
    if exit == Some(0) {
        Ok(())
    } else {
        Err(server_refusal(exit, stderr))
    }
}

/// Only a write that never started may say so. Once the command is on its way, it may have applied.
fn stopped_text(failed: Failed) -> String {
    match failed {
        Failed::ChannelLimit => {
            "서버의 동시 세션 한도에 걸려 실행하지 못했습니다. 잠시 뒤 다시 시도하세요.".into()
        }
        Failed::Stopped(Failure::TimedOut) => {
            "응답을 받지 못했습니다. 이미 적용됐을 수 있으니 트리에서 확인하세요.".into()
        }
        Failed::Stopped(failure) => format!(
            "{} 이미 적용됐을 수 있으니 트리에서 확인하세요.",
            String::from(failure)
        ),
    }
}

/// Runs once. RBAC decides what is allowed: there is no `auth can-i` first, and a refusal comes back
/// in the server's words.
pub async fn run(runner: &Runner<'_>, kube: &KubeSettings, action: &Action) -> Result<()> {
    let output = runner
        .script(&command_line(kube, action), LIMITS)
        .await
        .map_err(stopped_text)?;
    outcome(output.exit, &output.stderr)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::tests::profile;

    fn settings(context: &str, namespace: &str, operate: bool) -> KubeSettings {
        KubeSettings {
            context: context.into(),
            namespace: namespace.into(),
            kubectl: "/k".into(),
            kubeconfig: "/c".into(),
            operate,
        }
    }

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        (dir, store)
    }

    fn saved(store: &Store, kube: KubeSettings) -> String {
        let mut p = profile();
        p.workspace = Workspace::Kubernetes;
        p.kube = Some(kube);
        store.save(p, Some("secret-ref".into())).unwrap().id
    }

    fn delete(namespace: &str) -> Action {
        Action::DeletePod {
            namespace: namespace.into(),
            pod: "api-1".into(),
        }
    }

    #[test]
    fn each_action_has_one_fixed_command_line() {
        let kube = settings("kind-x", "", true);
        let line = |action: Action| command_line(&kube, &action);
        let prefix = "KUBECONFIG='/c' /k --context 'kind-x' --request-timeout=15s";
        assert_eq!(
            line(delete("web")),
            format!("{prefix} delete pod 'api-1' -n 'web' --wait=false")
        );
        assert_eq!(
            line(Action::RolloutRestart {
                namespace: "web".into(),
                workload: RolloutKind::StatefulSet,
                name: "db".into(),
            }),
            format!("{prefix} rollout restart 'statefulset/db' -n 'web'")
        );
        assert_eq!(
            line(Action::Cordon { node: "n1".into() }),
            format!("{prefix} cordon 'n1'")
        );
        assert_eq!(
            line(Action::Uncordon { node: "n1".into() }),
            format!("{prefix} uncordon 'n1'")
        );
    }

    #[test]
    fn names_that_could_reach_a_shell_or_a_flag_are_refused() {
        for bad in ["$(reboot)", "a;b", "--all", "a b", ""] {
            let delete = Action::DeletePod {
                namespace: "web".into(),
                pod: bad.into(),
            };
            assert!(delete.check().is_err(), "{bad:?}");
            assert!(
                Action::Cordon { node: bad.into() }.check().is_err(),
                "{bad:?}"
            );
            let restart = Action::RolloutRestart {
                namespace: "web".into(),
                workload: RolloutKind::Deployment,
                name: bad.into(),
            };
            assert!(restart.check().is_err(), "{bad:?}");
        }
        assert!(
            delete("").check().is_err(),
            "every namespace is not a target"
        );
        assert!(delete("web").check().is_ok());
    }

    #[test]
    fn only_the_four_actions_and_rollout_kinds_can_be_asked_for() {
        let parse = |json: &str| serde_json::from_str::<Action>(json);
        assert!(parse(r#"{"kind":"deletePod","namespace":"a","pod":"b"}"#).is_ok());
        assert!(
            parse(r#"{"kind":"rolloutRestart","namespace":"a","workload":"daemonSet","name":"b"}"#)
                .is_ok()
        );
        assert!(parse(r#"{"kind":"uncordon","node":"n"}"#).is_ok());
        assert!(parse(r#"{"kind":"drain","node":"n"}"#).is_err());
        assert!(parse(r#"{"kind":"cordon","node":"n","extra":"--force"}"#).is_err());
        assert!(
            parse(
                r#"{"kind":"rolloutRestart","namespace":"a","workload":"replicaSet","name":"b"}"#
            )
            .is_err()
        );
    }

    #[test]
    fn a_write_needs_operate_mode_in_the_stored_profile() {
        let (_dir, store) = store();
        let id = saved(&store, settings("a", "", false));
        let refused = permit(&store, &id, "a", &delete("web")).unwrap_err();
        assert!(refused.contains("조회 모드"), "{refused}");
        set_operate_mode(&store, &id, true).unwrap();
        assert!(permit(&store, &id, "a", &delete("web")).unwrap().operate);
        set_operate_mode(&store, &id, false).unwrap();
        assert!(permit(&store, &id, "a", &delete("web")).is_err());
    }

    #[test]
    fn a_write_runs_with_the_stored_settings() {
        let (_dir, store) = store();
        let id = saved(&store, settings("a", "", true));
        let kube = permit(&store, &id, "a", &delete("web")).unwrap();
        assert_eq!(kube.kubectl, "/k");
        assert_eq!(kube.kubeconfig, "/c");
    }

    #[test]
    fn a_write_is_refused_when_the_confirmed_context_is_not_the_stored_one() {
        let (_dir, store) = store();
        let id = saved(&store, settings("prod", "", true));
        let refused = permit(&store, &id, "dev", &delete("web")).unwrap_err();
        assert!(refused.contains("바뀌었습니다"), "{refused}");
    }

    #[test]
    fn a_session_narrowed_to_a_namespace_writes_only_there_but_nodes_stay_reachable() {
        let (_dir, store) = store();
        let id = saved(&store, settings("a", "web", true));
        assert!(permit(&store, &id, "a", &delete("web")).is_ok());
        assert!(permit(&store, &id, "a", &delete("kube-system")).is_err());
        let cordon = Action::Cordon { node: "n1".into() };
        assert!(permit(&store, &id, "a", &cordon).is_ok());
    }

    #[test]
    fn a_terminal_session_has_nothing_to_switch_and_cannot_write() {
        let (_dir, store) = store();
        let mut p = profile();
        p.kube = Some(settings("a", "", true));
        let id = store.save(p, None).unwrap().id;
        assert_eq!(operate_mode(&store, &id).unwrap(), OperateMode::Unavailable);
        assert!(set_operate_mode(&store, &id, true).is_err());
        assert!(permit(&store, &id, "a", &delete("web")).is_err());
    }

    #[test]
    fn a_kubernetes_session_not_set_up_yet_has_nothing_to_switch() {
        let (_dir, store) = store();
        let mut p = profile();
        p.workspace = Workspace::Kubernetes;
        let id = store.save(p, None).unwrap().id;
        assert_eq!(operate_mode(&store, &id).unwrap(), OperateMode::Unavailable);
        assert!(set_operate_mode(&store, &id, true).is_err());
    }

    #[test]
    fn a_missing_profile_refuses() {
        let (_dir, store) = store();
        assert!(permit(&store, "no-such-profile", "a", &delete("web")).is_err());
    }

    #[test]
    fn switching_the_mode_keeps_the_login_secret_and_the_other_settings() {
        let (_dir, store) = store();
        let id = saved(&store, settings("a", "web", false));
        assert_eq!(
            set_operate_mode(&store, &id, true).unwrap(),
            OperateMode::On
        );
        let stored = store.profile(&id).unwrap().kube.unwrap();
        assert_eq!(stored, settings("a", "web", true));
        assert_eq!(
            store.secret_ref(&id).unwrap().as_deref(),
            Some("secret-ref")
        );
    }

    #[test]
    fn a_failure_is_the_servers_own_words() {
        assert!(outcome(Some(0), b"").is_ok());
        let forbidden = b"Error from server (Forbidden): pods \"a\" is forbidden: User \"u\" cannot delete resource \"pods\"\n";
        assert_eq!(
            outcome(Some(1), forbidden).unwrap_err(),
            String::from_utf8_lossy(&forbidden[..forbidden.len() - 1])
        );
        assert!(outcome(None, b"").is_err(), "no exit status is not success");
    }

    #[test]
    fn a_write_that_may_have_landed_does_not_say_it_failed_cleanly() {
        let timed_out = stopped_text(Failed::Stopped(Failure::TimedOut));
        assert!(timed_out.contains("적용됐을 수"), "{timed_out}");
        assert!(!stopped_text(Failed::ChannelLimit).contains("적용됐을 수"));
    }
}
