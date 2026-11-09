//! What a Kubernetes PTY runs. `Script` staged the PodTree script and goes away in KV.12; the pod
//! tabs run one fixed command on an existing connection and need no staging.
use super::{Location, quote, stage};
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
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScriptLaunch {
    pub location: Location,
    pub context: String,
    pub namespace: String,
    pub operational: bool,
}

#[derive(Clone, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Launch {
    Script(ScriptLaunch),
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
    pub location: Location,
    pub command: String,
    pub labels: Labels,
    /// The staged script's folder, removed again if the PTY could not start.
    pub staged: Option<String>,
    /// Set for a local cluster's pod tab: this process runs in the PTY instead of `command`.
    pub local: Option<LocalPod>,
}

pub(super) struct LocalPod {
    pub invocation: Invocation,
    pub filter: Option<LineFilter>,
}

const LOCAL_LOCATION: &str = "kubeLocal";

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

fn pod_location(connection: &str, local: bool) -> Location {
    Location {
        kind: if local { LOCAL_LOCATION } else { "ssh" }.into(),
        id: connection.into(),
    }
}

fn script_title(launch: &ScriptLaunch, path: &str) -> String {
    format!(
        "PodTree · {} · {} · {} · 임시 경로 {path}",
        launch.context,
        if launch.namespace.is_empty() {
            "전체 namespace"
        } else {
            &launch.namespace
        },
        if launch.operational {
            "운영 모드"
        } else {
            "조회 모드"
        },
    )
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
        Launch::Script(script) => {
            let (path, command) = stage(state, script).await?;
            Prepared {
                location: script.location.clone(),
                command,
                labels: Labels {
                    title: script_title(script, &path),
                    closed: "PodTree 종료",
                    failed: "PodTree 프로세스가 실패했습니다. 터미널 안내를 확인하세요.",
                },
                staged: Some(path),
                local: None,
            }
        }
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
                location: pod_location(connection, is_local),
                command: shell_command(kube, namespace, pod, container),
                labels: Labels {
                    title: format!("{} · {namespace}/{pod} · {container}", kube.context),
                    closed: "파드 셸을 닫았습니다.",
                    failed: "파드 셸 연결이 끊겼습니다.",
                },
                staged: None,
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
                location: pod_location(connection, is_local),
                command,
                labels: Labels {
                    title: format!("{} · {namespace}/{pod} · {container} 로그", kube.context),
                    closed: "로그 따라가기가 끝났습니다.",
                    failed: "로그 따라가기가 끝났습니다.",
                },
                staged: None,
                local,
            }
        }
    })
}

pub(super) fn start_command(launch: &ScriptLaunch, path: &str) -> String {
    // A local command runs under the Bash that bash_target chose, while PATH may find another
    // (macOS /bin/bash is 3.2). SSH runs this in the remote login shell, where $BASH can be unset.
    let bash = if launch.location.kind == "local" {
        "\"$BASH\""
    } else {
        "bash"
    };
    format!(
        "export DACHSTERM_EMBEDDED=1 KUBECTL=kubectl; exec {bash} {} --context {} -n {} {}",
        quote(&format!("{path}/podtree.sh")),
        quote(&launch.context),
        quote(&launch.namespace),
        if launch.operational {
            ""
        } else {
            "--read-only"
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(kind: &str, operational: bool) -> ScriptLaunch {
        ScriptLaunch {
            location: Location {
                kind: kind.into(),
                id: "id".into(),
            },
            context: "prod".into(),
            namespace: "web".into(),
            operational,
        }
    }

    #[test]
    fn local_keeps_the_chosen_bash_and_ssh_uses_the_remote_path() {
        let local = start_command(&launch("local", false), "/tmp/d");
        assert!(
            local.contains("exec \"$BASH\" '/tmp/d/podtree.sh'"),
            "{local}"
        );
        let ssh = start_command(&launch("ssh", false), "/tmp/d");
        assert!(ssh.contains("exec bash '/tmp/d/podtree.sh'"), "{ssh}");
    }

    #[test]
    fn read_only_unless_operational() {
        assert!(start_command(&launch("ssh", false), "/d").ends_with("--read-only"));
        assert!(!start_command(&launch("ssh", true), "/d").contains("--read-only"));
    }

    #[test]
    fn the_screen_says_which_kind_of_tab_it_wants() {
        let script: Launch = serde_json::from_value(serde_json::json!({
            "kind": "script",
            "location": { "kind": "ssh", "id": "id" },
            "context": "prod",
            "namespace": "web",
            "operational": false,
        }))
        .unwrap();
        assert!(matches!(script, Launch::Script(_)));
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
}
