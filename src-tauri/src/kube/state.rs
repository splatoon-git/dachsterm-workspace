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
    } else if has("Error from server (Forbidden)") {
        KubeState::Forbidden
    } else if has("context was not found") {
        KubeState::ContextMissing
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
        ];
        for (line, expected) in cases {
            assert_eq!(classify(Some(1), line.as_bytes()), expected, "{line}");
        }
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
