//! `kube_logs`: a bounded log read for the panel beside the tree. Following a log is a terminal tab
//! (design §3.3). Log text stays in memory and never reaches session logs or diagnostics (design §6).
use super::{
    runner::{Kubectl, Runner},
    settings::KubeSettings,
    state::{KubeState, classify, no_previous_logs},
};
use crate::remote_exec::{Limits, quote};
use serde::Serialize;
use std::time::Duration;

const LIMITS: Limits = Limits {
    timeout: Duration::from_secs(20),
    max_output: 8 * 1024 * 1024,
};
const REQUEST_TIMEOUT_SECONDS: u32 = 18;
/// Enforced by kubectl, so one verbose container cannot fill the connection.
const LIMIT_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_TAIL: u32 = 5000;

pub struct LogRequest<'a> {
    pub namespace: &'a str,
    pub pod: &'a str,
    pub container: &'a str,
    pub tail: u32,
    pub previous: bool,
    /// Read from this time forward, with timestamps, instead of the last `tail` lines. For the lines
    /// around one search result; passed `is_log_time`.
    pub since_time: Option<&'a str>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Logs {
    state: KubeState,
    text: String,
    /// Whether `text` is from the previous instance.
    previous: bool,
    /// The previous instance was asked for and does not exist, so `text` is the current one.
    previous_missing: bool,
    truncated: bool,
}

/// Drops terminal sequences and other control characters: logs are shown as plain text.
pub(super) fn clean(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for inner in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&inner) {
                        break;
                    }
                }
            }
        } else if c == '\n' || c == '\t' || !c.is_control() {
            out.push(c);
        }
    }
    out
}

fn arguments(request: &LogRequest<'_>, previous: bool) -> String {
    let range = match request.since_time {
        Some(time) => format!("--since-time={} --timestamps", quote(time)),
        None => format!("--tail={}", request.tail.clamp(1, MAX_TAIL)),
    };
    format!(
        "logs {} -n {} -c {} {range} --limit-bytes={LIMIT_BYTES}{}",
        quote(request.pod),
        quote(request.namespace),
        quote(request.container),
        if previous { " --previous" } else { "" },
    )
}

enum Read {
    Text { text: String, truncated: bool },
    NoPrevious,
    Failed(KubeState),
}

async fn read(
    runner: &Runner<'_>,
    kube: &KubeSettings,
    request: &LogRequest<'_>,
    previous: bool,
) -> Read {
    let kubectl = Kubectl {
        command: &kube.kubectl,
        kubeconfig: &kube.kubeconfig,
    };
    let command = kubectl.cluster_within(
        &kube.context,
        REQUEST_TIMEOUT_SECONDS,
        &arguments(request, previous),
    );
    match runner.script(&command, LIMITS).await {
        Err(failed) => Read::Failed(failed.into_state()),
        Ok(output) if previous && no_previous_logs(output.exit, &output.stdout, &output.stderr) => {
            Read::NoPrevious
        }
        Ok(output) => match classify(output.exit, &output.stderr) {
            KubeState::Ready => Read::Text {
                truncated: output.stdout.len() >= LIMIT_BYTES,
                text: clean(&output.stdout),
            },
            state => Read::Failed(state),
        },
    }
}

fn logs_from(read: Read, previous: bool, previous_missing: bool) -> Logs {
    let (state, text, truncated) = match read {
        Read::Text { text, truncated } => (KubeState::Ready, text, truncated),
        Read::Failed(state) => (state, String::new(), false),
        // Reading the current instance never answers this; `fetch` only passes it on for `previous`.
        Read::NoPrevious => (KubeState::Ready, String::new(), false),
    };
    Logs {
        state,
        text,
        previous,
        previous_missing,
        truncated,
    }
}

/// With no earlier instance the current log is shown instead (design KV.4).
pub async fn fetch(runner: &Runner<'_>, kube: &KubeSettings, request: LogRequest<'_>) -> Logs {
    if request.previous {
        match read(runner, kube, &request, true).await {
            Read::NoPrevious => {}
            found => return logs_from(found, true, false),
        }
        return logs_from(read(runner, kube, &request, false).await, false, true);
    }
    logs_from(read(runner, kube, &request, false).await, false, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(tail: u32) -> LogRequest<'static> {
        LogRequest {
            namespace: "web",
            pod: "api-1",
            container: "app",
            tail,
            previous: false,
            since_time: None,
        }
    }

    #[test]
    fn arguments_are_bounded_and_quoted() {
        assert_eq!(
            arguments(&request(100), true),
            "logs 'api-1' -n 'web' -c 'app' --tail=100 --limit-bytes=4194304 --previous"
        );
        assert!(arguments(&request(0), false).contains("--tail=1 "));
        assert!(arguments(&request(u32::MAX), false).contains("--tail=5000 "));
    }

    #[test]
    fn reading_around_a_time_takes_the_lines_after_it_with_timestamps() {
        let around = LogRequest {
            since_time: Some("2026-11-08T12:00:00Z"),
            ..request(100)
        };
        let line = arguments(&around, false);
        assert!(
            line.contains("--since-time='2026-11-08T12:00:00Z' --timestamps"),
            "{line}"
        );
        assert!(!line.contains("--tail"), "{line}");
    }

    #[test]
    fn terminal_sequences_do_not_reach_the_screen() {
        assert_eq!(
            clean(b"\x1b[31mred\x1b[0m\tok\r\nnext\x07\n"),
            "red\tok\nnext\n"
        );
        assert_eq!(clean(b"bad \xff byte\n"), "bad \u{fffd} byte\n");
    }
}
