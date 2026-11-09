//! What a pod tab's PTY runs: one fixed command on a connection that already exists.
use crate::{
    AppState,
    kube::{
        Invocation, Keywords, KubeSettings, LineFilter, check_names, check_target,
        is_local_connection, local_logs, local_shell, logs_command, shell_command,
    },
    storage::Result,
};
use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Launch {
    PodShell {
        connection: String,
        kube: KubeSettings,
        namespace: String,
        pod: String,
        container: String,
    },
    PodLogs {
        connection: String,
        kube: KubeSettings,
        namespace: String,
        pod: String,
        container: String,
        tail: u32,
        /// A log search's keywords. Empty follows the whole log.
        #[serde(default)]
        keywords: String,
    },
}

/// What the tab's state line says.
pub(super) struct Labels {
    pub title: String,
    pub closed: &'static str,
    pub failed: &'static str,
}

pub(super) struct Prepared {
    pub connection: String,
    pub command: String,
    pub labels: Labels,
    /// Set for a local cluster's pod tab: this process runs in the PTY instead of `command`.
    pub local: Option<LocalPod>,
}

pub(super) struct LocalPod {
    pub invocation: Invocation,
    pub filter: Option<LineFilter>,
}

/// What a PTY runs: the program, its arguments, added environment and an optional output filter.
pub(super) type PtyProcess = (
    std::path::PathBuf,
    Vec<String>,
    Vec<(std::ffi::OsString, std::ffi::OsString)>,
    Option<crate::kube::LineFilter>,
);

pub(super) fn pty_process(pod: LocalPod) -> PtyProcess {
    let LocalPod { invocation, filter } = pod;
    let env = crate::kube::environment(&invocation);
    (invocation.program.into(), invocation.args, env, filter)
}

fn check_pod_target(
    kube: &KubeSettings,
    namespace: &str,
    pod: &str,
    container: &str,
    local: bool,
) -> Result<()> {
    if local {
        kube.validate_local()?;
        check_names(namespace, pod, container)
    } else {
        check_target(kube, namespace, pod, container)
    }
}

pub(super) async fn prepare(state: &AppState, launch: &Launch) -> Result<Prepared> {
    Ok(match launch {
        Launch::PodShell {
            connection,
            kube,
            namespace,
            pod,
            container,
        } => {
            let is_local = is_local_connection(state, connection);
            check_pod_target(kube, namespace, pod, container, is_local)?;
            let local = if is_local {
                Some(LocalPod {
                    invocation: local_shell(kube, namespace, pod, container)?,
                    filter: None,
                })
            } else {
                None
            };
            Prepared {
                connection: connection.clone(),
                command: shell_command(kube, namespace, pod, container),
                labels: Labels {
                    title: format!("{} · {namespace}/{pod} · {container}", kube.context),
                    closed: "파드 셸을 닫았습니다.",
                    failed: "파드 셸 연결이 끊겼습니다.",
                },
                local,
            }
        }
        Launch::PodLogs {
            connection,
            kube,
            namespace,
            pod,
            container,
            tail,
            keywords,
        } => {
            let is_local = is_local_connection(state, connection);
            check_pod_target(kube, namespace, pod, container, is_local)?;
            let keywords = Keywords::parse(keywords)?;
            let command = logs_command(kube, namespace, pod, container, *tail, &keywords);
            let local = if is_local {
                let (invocation, filter) =
                    local_logs(kube, namespace, pod, container, *tail, keywords)?;
                Some(LocalPod { invocation, filter })
            } else {
                None
            };
            Prepared {
                connection: connection.clone(),
                command,
                labels: Labels {
                    title: format!("{} · {namespace}/{pod} · {container} 로그", kube.context),
                    closed: "로그 따라가기가 끝났습니다.",
                    failed: "로그 따라가기가 끝났습니다.",
                },
                local,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_screen_says_which_kind_of_tab_it_wants() {
        let shell: Launch = serde_json::from_value(serde_json::json!({
            "kind": "podShell",
            "connection": "c",
            "kube": { "context": "x", "namespace": "", "kubectl": "kubectl", "kubeconfig": "" },
            "namespace": "web",
            "pod": "api-1",
            "container": "app",
        }))
        .unwrap();
        assert!(matches!(shell, Launch::PodShell { .. }));
    }

    #[test]
    fn the_removed_script_launch_is_refused() {
        let script = serde_json::from_value::<Launch>(serde_json::json!({
            "kind": "script",
            "location": { "kind": "ssh", "id": "id" },
            "context": "prod",
            "namespace": "web",
            "operational": false,
        }));
        assert!(script.is_err());
    }
}
