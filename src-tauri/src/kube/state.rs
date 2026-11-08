//! What a finished kubectl run means. Nothing else in the app reads kubectl's words (rules §6).
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum KubeState {
    Ready,
    KubectlMissing,
    ConfigMissing,
    ConfigUnreadable,
    AuthFailed,
    Forbidden,
    ContextMissing,
    Unreachable,
    /// The server would not open another channel on this connection (`MaxSessions`).
    ChannelLimit,
    /// The pod is gone: deleted, or replaced under a new name.
    NotFound,
    /// `top` has no metrics-server to read from. Requests and limits are shown instead.
    MetricsMissing,
    /// A query hit the app's time or output limit. Set by the runner, not read from kubectl's words.
    TimedOut,
    TooLarge,
    Unknown {
        message: String,
    },
}

const MAX_MESSAGE: usize = 300;

/// `E1108 12:02:11.123456 ...`: klog repeats these before the one line that means anything.
fn is_klog(line: &str) -> bool {
    let bytes = line.as_bytes();
    bytes.len() > 5
        && matches!(bytes[0], b'E' | b'W' | b'I' | b'F')
        && bytes[1..5].iter().all(u8::is_ascii_digit)
        && bytes[5] == b' '
}

/// kubectl exits 1 for nearly everything, so the last line that is not klog's decides.
pub fn classify(exit: Option<u32>, stderr: &[u8]) -> KubeState {
    if exit == Some(0) {
        return KubeState::Ready;
    }
    if matches!(exit, Some(126 | 127)) {
        return KubeState::KubectlMissing;
    }
    let text = String::from_utf8_lossy(stderr);
    let line = text
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty() && !is_klog(line))
        .unwrap_or_default();
    let has = |needle: &str| line.contains(needle);
    if has("You must be logged in to the server") {
        KubeState::AuthFailed
    } else if has("(NotFound)") {
        KubeState::NotFound
    } else if has("Error from server (Forbidden)") {
        KubeState::Forbidden
    } else if has("context was not found") {
        KubeState::ContextMissing
    } else if has("Metrics API not available")
        || has("metrics not available yet")
        || has("Metrics not available")
    {
        KubeState::MetricsMissing
    } else if has("was refused") || has("Unable to connect to the server") {
        KubeState::Unreachable
    } else if has("error loading config file") && has("permission denied") {
        KubeState::ConfigUnreadable
    } else if has("no such file or directory") && line.starts_with("error: stat") {
        KubeState::ConfigMissing
    } else {
        KubeState::Unknown {
            message: unknown_text(line, exit),
        }
    }
}

/// What the no-op `sh -c 'exit 0'` run in a container before opening a shell tab found.
#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShellCheck {
    Ready,
    /// A distroless image: `sh` itself could not start.
    NoShell,
    /// The container is not running, such as a crash loop between attempts.
    NotRunning,
    Blocked {
        state: KubeState,
    },
}

/// Measured against containerd in KV.4 (docs/verification/kubernetes-workspace.md).
pub fn classify_shell(exit: Option<u32>, stderr: &[u8]) -> ShellCheck {
    let state = classify(exit, stderr);
    let KubeState::Unknown { message } = &state else {
        return match state {
            KubeState::Ready => ShellCheck::Ready,
            state => ShellCheck::Blocked { state },
        };
    };
    if message.contains("exec: \"sh\"") || message.contains("executable file not found") {
        ShellCheck::NoShell
    } else if message.contains("container not found") || message.contains("not created or running")
    {
        ShellCheck::NotRunning
    } else {
        ShellCheck::Blocked { state }
    }
}

/// `--previous` with no earlier instance. Between restarts kubelet has already collected it, and
/// then the sentence comes on stdout with exit code 0.
pub fn no_previous_logs(exit: Option<u32>, stdout: &[u8], stderr: &[u8]) -> bool {
    let unavailable = stdout.starts_with(b"unable to retrieve container logs for");
    let missing = exit != Some(0)
        && String::from_utf8_lossy(stderr).contains("previous terminated container");
    unavailable || missing
}

fn unknown_text(line: &str, exit: Option<u32>) -> String {
    if line.is_empty() {
        return match exit {
            Some(code) => format!("kubectl이 종료 코드 {code}로 끝났습니다."),
            None => "kubectl 종료 상태를 알 수 없습니다.".into(),
        };
    }
    line.chars()
        .filter(|c| !c.is_control())
        .take(MAX_MESSAGE)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every line here is what real kubectl printed in KV.0 (docs/verification/kubernetes-workspace.md).
    #[test]
    fn reads_the_measured_kubectl_messages() {
        let cases = [
            (
                "error: You must be logged in to the server (the server has asked for the client to provide credentials)",
                KubeState::AuthFailed,
            ),
            (
                "Error from server (Forbidden): pods is forbidden: User \"probe\" cannot list resource \"pods\"",
                KubeState::Forbidden,
            ),
            (
                "Error in configuration: context was not found for specified context: nope",
                KubeState::ContextMissing,
            ),
            (
                "The connection to the server 127.0.0.1:1 was refused - did you specify the right host or port?",
                KubeState::Unreachable,
            ),
            (
                "Unable to connect to the server: context deadline exceeded (Client.Timeout exceeded while awaiting headers)",
                KubeState::Unreachable,
            ),
            (
                "error: error loading config file \"/etc/rancher/rke2/rke2.yaml\": open /etc/rancher/rke2/rke2.yaml: permission denied",
                KubeState::ConfigUnreadable,
            ),
            (
                "error: stat /home/probe/.kube/none: no such file or directory",
                KubeState::ConfigMissing,
            ),
            (
                "error: Metrics API not available",
                KubeState::MetricsMissing,
            ),
        ];
        for (line, expected) in cases {
            assert_eq!(classify(Some(1), line.as_bytes()), expected, "{line}");
        }
    }

    #[test]
    fn reads_the_measured_exec_and_log_messages() {
        let no_shell = "error: Internal error occurred: error executing command in container: failed to exec in container: failed to start exec \"f7\": OCI runtime exec failed: exec failed: unable to start container process: exec: \"sh\": executable file not found in $PATH";
        assert_eq!(
            classify_shell(Some(1), no_shell.as_bytes()),
            ShellCheck::NoShell
        );
        assert_eq!(
            classify_shell(
                Some(1),
                b"error: unable to upgrade connection: container not found (\"c\")"
            ),
            ShellCheck::NotRunning
        );
        assert_eq!(classify_shell(Some(0), b""), ShellCheck::Ready);
        assert_eq!(
            classify_shell(
                Some(1),
                b"Error from server (NotFound): pods \"nopod\" not found"
            ),
            ShellCheck::Blocked {
                state: KubeState::NotFound
            }
        );
        assert_eq!(
            classify(
                Some(1),
                b"error: error from server (NotFound): pods \"nopod\" not found in namespace \"m1\""
            ),
            KubeState::NotFound
        );
        assert!(no_previous_logs(
            Some(1),
            b"",
            b"Error from server (BadRequest): previous terminated container \"main\" in pod \"web\" not found"
        ));
        assert!(no_previous_logs(
            Some(0),
            b"unable to retrieve container logs for containerd://7b8c",
            b""
        ));
        assert!(!no_previous_logs(Some(0), b"crashing-now\n", b""));
        assert!(!no_previous_logs(Some(1), b"", b"error: something else"));
    }

    #[test]
    fn klog_lines_before_the_message_do_not_count() {
        let stderr = "E1108 12:02:11.000000   100 memcache.go:265] \"Unhandled Error\" err=\"Forbidden\"\n\
                      W1108 12:02:12.000000   100 loader.go:1] was refused\n\
                      error: You must be logged in to the server (Unauthorized)\n\n";
        assert_eq!(classify(Some(1), stderr.as_bytes()), KubeState::AuthFailed);
    }

    #[test]
    fn exit_codes_and_empty_output() {
        assert_eq!(
            classify(Some(0), b"E1108 12:02:11.0 warning"),
            KubeState::Ready
        );
        assert_eq!(
            classify(Some(127), b"sh: 1: kubectl: not found"),
            KubeState::KubectlMissing
        );
        assert_eq!(classify(Some(126), b""), KubeState::KubectlMissing);
        assert_eq!(
            classify(Some(1), b""),
            KubeState::Unknown {
                message: "kubectl이 종료 코드 1로 끝났습니다.".into()
            }
        );
        assert_eq!(
            classify(None, b""),
            KubeState::Unknown {
                message: "kubectl 종료 상태를 알 수 없습니다.".into()
            }
        );
    }

    #[test]
    fn an_unknown_line_is_shown_short_and_without_control_characters() {
        let line = format!("error: odd\u{1b}[31m {}", "x".repeat(1000));
        let KubeState::Unknown { message } = classify(Some(1), line.as_bytes()) else {
            panic!("expected Unknown");
        };
        assert_eq!(message.chars().count(), MAX_MESSAGE);
        assert!(!message.contains('\u{1b}'));
    }

    #[test]
    fn a_word_in_a_klog_line_is_not_mistaken_for_the_message() {
        assert!(is_klog("E1108 12:02:11.000000 x"));
        assert!(!is_klog("Error from server"));
        assert!(!is_klog("E110 x"));
    }
}
