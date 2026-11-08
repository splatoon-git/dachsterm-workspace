//! Command lines for the pod shell and log-follow tabs (design §3.3), and the check that decides
//! whether a shell tab is worth opening. Every name here was checked by `check_target`.
use super::{
    log_keywords::Keywords,
    runner::{Kubectl, Runner},
    settings::{KubeSettings, check_container, check_namespace, check_pod},
    state::{KubeState, ShellCheck, classify_shell},
};
use crate::{
    remote_exec::{Limits, quote},
    storage::Result,
};
use std::time::Duration;

/// The same fallback as PodTree: bash when the image has it, otherwise sh.
const SHELL: &str = "command -v bash >/dev/null 2>&1 && exec bash || exec sh";

const PROBE: Limits = Limits {
    timeout: Duration::from_secs(12),
    max_output: 64 * 1024,
};

pub fn check_target(
    kube: &KubeSettings,
    namespace: &str,
    pod: &str,
    container: &str,
) -> Result<()> {
    kube.validate()?;
    if namespace.is_empty() {
        return Err("파드의 namespace가 필요합니다.".into());
    }
    check_namespace(namespace)?;
    check_pod(pod)?;
    check_container(container)
}

fn kubectl(kube: &KubeSettings) -> Kubectl<'_> {
    Kubectl {
        command: &kube.kubectl,
        kubeconfig: &kube.kubeconfig,
    }
}

/// Runs under `sh -c` like every other remote command, so a fish or csh login shell is not a
/// problem, and the PTY's hangup still ends kubectl.
fn under_sh(command: String) -> String {
    format!("sh -c {}", quote(&command))
}

pub fn shell_command(kube: &KubeSettings, namespace: &str, pod: &str, container: &str) -> String {
    under_sh(kubectl(kube).streaming(
        &kube.context,
        &format!(
            "exec -it {} -n {} -c {} -- sh -c {}",
            quote(pod),
            quote(namespace),
            quote(container),
            quote(SHELL),
        ),
    ))
}

pub fn logs_command(
    kube: &KubeSettings,
    namespace: &str,
    pod: &str,
    container: &str,
    tail: u32,
    keywords: &Keywords,
) -> String {
    let follow = kubectl(kube).streaming(
        &kube.context,
        &format!(
            "logs -f --tail={} {} -n {} -c {}",
            tail.clamp(1, super::logs::MAX_TAIL),
            quote(pod),
            quote(namespace),
            quote(container),
        ),
    );
    under_sh(format!(
        "{follow}{}",
        keywords.stages("--line-buffered ", false)
    ))
}

/// Runs a no-op in the container. A shell the image does not have, a container that is not running
/// and a server refusing the channel all become one sentence by the tree instead of a dead tab.
pub async fn probe(
    runner: &Runner<'_>,
    kube: &KubeSettings,
    namespace: &str,
    pod: &str,
    container: &str,
) -> ShellCheck {
    let command = kubectl(kube).cluster(
        &kube.context,
        &format!(
            "exec {} -n {} -c {} -- sh -c 'exit 0'",
            quote(pod),
            quote(namespace),
            quote(container),
        ),
    );
    match runner.script(&command, PROBE).await {
        Ok(output) => classify_shell(output.exit, &output.stderr),
        Err(failed) => match failed.into_state() {
            KubeState::Ready => ShellCheck::Ready,
            state => ShellCheck::Blocked { state },
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> KubeSettings {
        KubeSettings {
            context: "kind-x".into(),
            namespace: String::new(),
            kubectl: "/opt/kubectl".into(),
            kubeconfig: "/etc/k".into(),
            operate: false,
        }
    }

    #[test]
    fn the_shell_has_no_request_timeout_and_names_its_context() {
        let line = shell_command(&settings(), "web", "api-1", "app");
        assert!(line.starts_with("sh -c 'KUBECONFIG="), "{line}");
        assert!(!line.contains("request-timeout"), "{line}");
        assert!(line.contains("--context"), "{line}");
        assert!(line.contains("exec -it"), "{line}");
        assert!(line.contains("exec bash || exec sh"), "{line}");
    }

    #[test]
    fn following_a_log_is_bounded_and_streams() {
        let line = logs_command(
            &settings(),
            "web",
            "api-1",
            "app",
            999_999,
            &Keywords::default(),
        );
        assert!(line.contains("logs -f --tail=5000"), "{line}");
        assert!(!line.contains("request-timeout"), "{line}");
        assert!(!line.contains("grep"), "{line}");
    }

    #[test]
    fn following_with_keywords_filters_line_by_line() {
        let keywords = Keywords::parse("error !debug").unwrap();
        let line = logs_command(&settings(), "web", "api-1", "app", 500, &keywords);
        assert!(line.contains("grep --line-buffered -aiF --"), "{line}");
        assert!(line.contains("grep --line-buffered -aivF --"), "{line}");
    }

    #[test]
    fn names_that_reach_a_command_line_are_checked_first() {
        let kube = settings();
        assert!(check_target(&kube, "web", "api-1", "app").is_ok());
        assert!(check_target(&kube, "", "api-1", "app").is_err());
        assert!(check_target(&kube, "web", "$(reboot)", "app").is_err());
        assert!(check_target(&kube, "web", "api-1", "a;b").is_err());
    }
}
