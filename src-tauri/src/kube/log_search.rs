//! `kube_log_search`: finds keywords in the logs of many pods. grep runs on the server, so a pod's
//! log is never brought over SSH whole. Results stay in memory and never reach session logs or
//! diagnostics (design §6).
use super::{
    log_keywords::Keywords,
    log_scheduler::{Finish, JobEnd, Note, Outcome, Schedule, run_jobs},
    logs::clean,
    runner::{Failed, Kubectl, Link, Runner},
    settings::{KubeSettings, check_container, check_namespace, check_pod, is_log_time},
    state::{KubeState, classify, no_previous_logs},
};
use crate::{
    remote_exec::{Limits, quote},
    storage::Result,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    ops::ControlFlow,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::sync::watch;

const MAX_PODS: usize = 100;
const MAX_LINES_PER_JOB: usize = 1000;
const MAX_LINES_TOTAL: usize = 5000;
const MAX_LINE_CHARS: usize = 4096;
/// Lines are capped by count, but one job's bytes must be too: a line has no length limit.
const MAX_JOB_BYTES: usize = 16 * 1024 * 1024;
const SCHEDULE: Schedule = Schedule {
    concurrent: 4,
    max_refusals: 5,
    retry_wait: Duration::from_millis(400),
    total_time: Duration::from_secs(60),
};
/// The schedule's total time ends a job first. This only bounds what is kept: stderr.
const JOB_LIMITS: Limits = Limits {
    timeout: Duration::from_secs(70),
    max_output: 1024 * 1024,
};
pub(super) const STATUS: &str = "DACHSTERM-KUBECTL-EXIT";
/// kubectl killed by SIGPIPE: `head` had enough lines and closed the pipe.
const CLOSED_BY_HEAD: u32 = 141;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchTarget {
    namespace: String,
    pod: String,
    containers: Vec<String>,
    /// Of `containers`, those whose previous instance is searched too.
    previous: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchRequest {
    targets: Vec<SearchTarget>,
    since: String,
    query: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    namespace: String,
    pod: String,
    container: String,
    previous: bool,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct Hit {
    time: String,
    text: String,
    clipped: bool,
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    Started {
        jobs: usize,
        omitted_pods: usize,
    },
    Lines {
        source: Source,
        lines: Vec<Hit>,
    },
    JobDone {
        source: Source,
        state: KubeState,
        matched: usize,
        truncated: bool,
    },
    /// The server refused a channel, so fewer jobs now run at once.
    Narrowed {
        concurrency: usize,
    },
    Finished {
        outcome: Outcome,
        unstarted: usize,
    },
}

pub struct Plan {
    sources: Vec<Source>,
    omitted_pods: usize,
    since: String,
    keywords: Keywords,
}

/// `15m`, `1h30m`: what `--since` takes, with no room for anything else.
fn check_since(since: &str) -> Result<()> {
    let bad = || "시간은 15m, 1h, 1h30m 형식으로 입력하세요.".to_string();
    if since.is_empty() || since.len() > 16 {
        return Err(bad());
    }
    let mut digits = 0;
    for c in since.chars() {
        match c {
            '0'..='9' => digits += 1,
            'h' | 'm' | 's' if digits > 0 => digits = 0,
            _ => return Err(bad()),
        }
    }
    if digits == 0 { Ok(()) } else { Err(bad()) }
}

/// Everything that reaches a command line is checked here, before any channel opens.
pub fn plan(request: SearchRequest) -> Result<Plan> {
    check_since(&request.since)?;
    let keywords = Keywords::parse(&request.query)?;
    if keywords.is_empty() {
        return Err("검색어를 입력하세요.".into());
    }
    let omitted_pods = request.targets.len().saturating_sub(MAX_PODS);
    let mut sources = Vec::new();
    for target in request.targets.into_iter().take(MAX_PODS) {
        check_pod(&target.pod)?;
        if target.namespace.is_empty() {
            return Err("파드의 namespace가 필요합니다.".into());
        }
        check_namespace(&target.namespace)?;
        for container in &target.containers {
            check_container(container)?;
            let previous = target.previous.contains(container);
            for previous in [false, true].into_iter().take(1 + usize::from(previous)) {
                sources.push(Source {
                    namespace: target.namespace.clone(),
                    pod: target.pod.clone(),
                    container: container.clone(),
                    previous,
                });
            }
        }
    }
    if sources.is_empty() {
        return Err("검색할 파드가 없습니다.".into());
    }
    Ok(Plan {
        sources,
        omitted_pods,
        since: request.since,
        keywords,
    })
}

fn logs_line(kube: &KubeSettings, source: &Source, since: &str) -> String {
    Kubectl {
        command: &kube.kubectl,
        kubeconfig: &kube.kubeconfig,
    }
    .streaming(
        &kube.context,
        &format!(
            "logs {} -n {} -c {} --since={} --timestamps{}",
            quote(&source.pod),
            quote(&source.namespace),
            quote(&source.container),
            quote(since),
            if source.previous { " --previous" } else { "" },
        ),
    )
}

/// A pipeline's exit status is `head`'s, so kubectl's is written after its stderr, on a line of its
/// own. With no PTY nothing tells kubectl that the channel closed, so a small watcher reads this
/// channel's stdin, which ends at that moment, and stops kubectl. Without it a cancelled search
/// would keep reading logs on the server until kubectl finished by itself.
fn job_script(kube: &KubeSettings, source: &Source, since: &str, keywords: &Keywords) -> String {
    let logs = logs_line(kube, source, since);
    format!(
        "exec 3<&0\n{{ {logs} & k=$!; ( cat <&3 >/dev/null 2>&1; kill \"$k\" 2>/dev/null ) \
         >/dev/null 2>&1 & w=$!; wait \"$k\"; s=$?; kill \"$w\" 2>/dev/null; \
         printf '\\n{STATUS} %s\\n' \"$s\" >&2; }}{} | head -n {}\n",
        keywords.stages("", true),
        MAX_LINES_PER_JOB + 1,
    )
}

/// kubectl's exit status and the stderr before it. `None` if it never got to report one.
pub(super) fn kubectl_status(stderr: &[u8]) -> (Option<u32>, &[u8]) {
    let text = String::from_utf8_lossy(stderr);
    let Some(line) = text.lines().rev().find(|line| line.starts_with(STATUS)) else {
        return (None, stderr);
    };
    let status = line[STATUS.len()..].trim().parse().ok();
    let end = stderr
        .windows(STATUS.len())
        .rposition(|window| window == STATUS.as_bytes())
        .unwrap_or(stderr.len());
    (status, &stderr[..end])
}

fn job_state(stderr: &[u8]) -> KubeState {
    let (status, rest) = kubectl_status(stderr);
    exit_state(status, rest)
}

/// What kubectl's own status and stderr mean, however they were learned.
fn exit_state(status: Option<u32>, rest: &[u8]) -> KubeState {
    if no_previous_logs(status, b"", rest) {
        return KubeState::Ready;
    }
    classify(
        if status == Some(CLOSED_BY_HEAD) {
            Some(0)
        } else {
            status
        },
        rest,
    )
}

/// `kubectl --timestamps` puts the time first. A line without one is kubelet's own message on
/// stdout, such as a previous instance it has already collected, and not part of the log.
fn parse_hit(line: &[u8], keywords: &Keywords) -> Option<Hit> {
    let at = line.iter().position(|byte| *byte == b' ')?;
    let time = std::str::from_utf8(&line[..at]).ok()?;
    if !is_log_time(time) {
        return None;
    }
    let text = clean(&line[at + 1..]);
    if !keywords.matches(&text) {
        return None;
    }
    let clipped = text.chars().count() > MAX_LINE_CHARS;
    Some(Hit {
        time: time.to_string(),
        text: if clipped {
            text.chars().take(MAX_LINE_CHARS).collect()
        } else {
            text
        },
        clipped,
    })
}

/// Turns one job's stdout into hits. On a server `head` already capped the line count and this
/// says it did. A local job has no grep in front of it, so its whole log passes through here and
/// only the lines that match count (design KV.11).
#[derive(Default)]
struct LineReader {
    pending: Vec<u8>,
    lines: usize,
    bytes: usize,
    truncated: bool,
    /// Every log line arrives, not only those grep passed.
    unfiltered: bool,
}
impl LineReader {
    fn hits(&mut self, complete: &[u8], keywords: &Keywords) -> Vec<Hit> {
        let mut hits = Vec::new();
        for line in complete.split(|byte| *byte == b'\n') {
            if line.is_empty() {
                continue;
            }
            let hit = parse_hit(line, keywords);
            if self.unfiltered && hit.is_none() {
                continue;
            }
            self.lines += 1;
            if self.lines > MAX_LINES_PER_JOB {
                self.truncated = true;
                break;
            }
            hits.extend(hit);
        }
        hits
    }
    fn push(&mut self, piece: &[u8], keywords: &Keywords) -> Vec<Hit> {
        self.bytes += piece.len();
        // Unfiltered bytes are read and let go, so only an endless line could add up.
        if (!self.unfiltered && self.bytes > MAX_JOB_BYTES) || self.pending.len() > MAX_JOB_BYTES {
            self.truncated = true;
        }
        self.pending.extend_from_slice(piece);
        let Some(last) = self.pending.iter().rposition(|byte| *byte == b'\n') else {
            return Vec::new();
        };
        let rest = self.pending.split_off(last + 1);
        let complete = std::mem::replace(&mut self.pending, rest);
        self.hits(&complete, keywords)
    }
    /// The last line, if the stream ended without its newline.
    fn finish(&mut self, keywords: &Keywords) -> Vec<Hit> {
        let rest = std::mem::take(&mut self.pending);
        self.hits(&rest, keywords)
    }
}

struct Sink {
    channel: Channel<Event>,
    left: Mutex<usize>,
    gone: AtomicBool,
}
impl Sink {
    fn send(&self, event: Event) {
        if self.channel.send(event).is_err() {
            self.gone.store(true, Ordering::SeqCst);
        }
    }
    fn over(&self) -> bool {
        *self.left.lock().unwrap() == 0 || self.gone.load(Ordering::SeqCst)
    }
    /// Hands over as many hits as the search's total limit still allows.
    fn deliver(&self, source: &Source, mut lines: Vec<Hit>) -> usize {
        let granted = {
            let mut left = self.left.lock().unwrap();
            let granted = lines.len().min(*left);
            *left -= granted;
            granted
        };
        if granted == 0 {
            return 0;
        }
        lines.truncate(granted);
        self.send(Event::Lines {
            source: source.clone(),
            lines,
        });
        granted
    }
}

struct Shared {
    link: Link,
    kube: KubeSettings,
    since: String,
    keywords: Keywords,
    sink: Sink,
}

async fn search_one(shared: Arc<Shared>, source: Source, refusals: u32) -> JobEnd<Source> {
    let runner: Runner<'_> = shared.link.runner(&shared.kube);
    let local = runner.is_local();
    let script = if local {
        logs_line(&shared.kube, &source, &shared.since)
    } else {
        job_script(&shared.kube, &source, &shared.since, &shared.keywords)
    };
    let mut reader = LineReader {
        unfiltered: local,
        ..LineReader::default()
    };
    let mut matched = 0;
    let mut stopped = false;
    let result = runner
        .stream(&script, JOB_LIMITS, |piece| {
            matched += shared
                .sink
                .deliver(&source, reader.push(piece, &shared.keywords));
            if reader.truncated || shared.sink.over() {
                stopped = true;
                return ControlFlow::Break(());
            }
            ControlFlow::Continue(())
        })
        .await;
    let state = match result {
        Err(Failed::ChannelLimit) => return JobEnd::Refused(source, refusals),
        Err(failed) => failed.into_state(),
        Ok(_) if stopped => KubeState::Ready,
        Ok(done) => {
            matched += shared
                .sink
                .deliver(&source, reader.finish(&shared.keywords));
            if local {
                exit_state(done.exit, &done.stderr)
            } else {
                job_state(&done.stderr)
            }
        }
    };
    shared.sink.send(Event::JobDone {
        source,
        state,
        matched,
        truncated: reader.truncated,
    });
    JobEnd::Done
}

pub async fn run(
    link: Link,
    kube: KubeSettings,
    plan: Plan,
    channel: Channel<Event>,
    cancel: watch::Receiver<bool>,
) {
    let Plan {
        sources,
        omitted_pods,
        since,
        keywords,
    } = plan;
    let shared = Arc::new(Shared {
        link,
        kube,
        since,
        keywords,
        sink: Sink {
            channel,
            left: Mutex::new(MAX_LINES_TOTAL),
            gone: AtomicBool::new(false),
        },
    });
    shared.sink.send(Event::Started {
        jobs: sources.len(),
        omitted_pods,
    });
    let (jobs, limit, notes) = (shared.clone(), shared.clone(), shared.clone());
    let Finish { outcome, unstarted } = run_jobs(
        sources,
        SCHEDULE,
        cancel,
        move || limit.sink.over(),
        move |source, refusals| search_one(jobs.clone(), source, refusals),
        move |note| {
            notes.sink.send(match note {
                Note::Narrowed(concurrency) => Event::Narrowed { concurrency },
                Note::GaveUp(source) => Event::JobDone {
                    source,
                    state: KubeState::ChannelLimit,
                    matched: 0,
                    truncated: false,
                },
            })
        },
    )
    .await;
    shared.sink.send(Event::Finished { outcome, unstarted });
}

/// The searches running now, so `kube_log_cancel` can reach one by its ID.
#[derive(Default)]
pub struct LogSearches(Mutex<HashMap<String, watch::Sender<bool>>>);

/// A running search's place in `LogSearches`, given up when the search ends.
pub struct Registered<'a> {
    searches: &'a LogSearches,
    id: String,
    pub cancel: watch::Receiver<bool>,
}
impl Drop for Registered<'_> {
    fn drop(&mut self) {
        self.searches.0.lock().unwrap().remove(&self.id);
    }
}

impl LogSearches {
    pub fn begin(&self, id: String) -> Registered<'_> {
        let (sender, cancel) = watch::channel(false);
        self.0.lock().unwrap().insert(id.clone(), sender);
        Registered {
            searches: self,
            id,
            cancel,
        }
    }

    /// A search that has already ended has nothing to cancel.
    pub fn cancel(&self, id: &str) {
        if let Some(stop) = self.0.lock().unwrap().get(id) {
            let _ = stop.send(true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(previous: bool) -> Source {
        Source {
            namespace: "web".into(),
            pod: "api-1".into(),
            container: "app".into(),
            previous,
        }
    }

    fn settings() -> KubeSettings {
        KubeSettings {
            context: "kind-x".into(),
            namespace: String::new(),
            kubectl: "/opt/kubectl".into(),
            kubeconfig: "/etc/k".into(),
            operate: false,
        }
    }

    fn keywords(query: &str) -> Keywords {
        Keywords::parse(query).unwrap()
    }

    fn target(pod: &str, containers: &[&str], previous: &[&str]) -> SearchTarget {
        SearchTarget {
            namespace: "web".into(),
            pod: pod.into(),
            containers: containers.iter().map(|c| c.to_string()).collect(),
            previous: previous.iter().map(|c| c.to_string()).collect(),
        }
    }

    fn request(targets: Vec<SearchTarget>, since: &str, query: &str) -> SearchRequest {
        SearchRequest {
            targets,
            since: since.into(),
            query: query.into(),
        }
    }

    const STAMP: &str = "2026-11-08T12:00:00.123456789Z";

    #[test]
    fn the_script_keeps_the_keyword_out_of_the_shell_and_stops_with_the_channel() {
        let script = job_script(&settings(), &source(true), "15m", &keywords("a'b !debug"));
        assert!(
            script.contains("--since='15m' --timestamps --previous"),
            "{script}"
        );
        assert!(script.contains("| grep -aiF -- 'a'\\''b'"), "{script}");
        assert!(script.contains("| grep -aivF -- 'debug'"), "{script}");
        assert!(script.ends_with("| head -n 1001\n"), "{script}");
        assert!(script.contains("--context 'kind-x'"), "{script}");
        // The stream must not be cut by kubectl's own timeout, and must stop with the channel.
        assert!(!script.contains("request-timeout"), "{script}");
        assert!(script.contains("cat <&3"), "{script}");
        assert!(script.contains("kill \"$k\""), "{script}");
    }

    #[test]
    fn a_local_job_is_one_kubectl_command_with_no_grep() {
        let line = logs_line(&settings(), &source(false), "15m");
        assert!(!line.contains("grep") && !line.contains('|'), "{line}");
        let run = crate::kube::local_run::parse(&line, "/opt/kubectl").unwrap();
        assert!(run.args.contains(&"--timestamps".to_string()));
    }

    #[test]
    fn a_local_reader_counts_only_matches_and_stops_after_the_limit() {
        let words = keywords("hit");
        let mut reader = LineReader {
            unfiltered: true,
            ..LineReader::default()
        };
        let noise = format!("{STAMP} nothing here\n").repeat(MAX_LINES_PER_JOB * 2);
        assert!(reader.push(noise.as_bytes(), &words).is_empty());
        assert!(!reader.truncated);
        let matches = format!("{STAMP} hit\n").repeat(MAX_LINES_PER_JOB + 1);
        assert_eq!(
            reader.push(matches.as_bytes(), &words).len(),
            MAX_LINES_PER_JOB
        );
        assert!(reader.truncated);
    }

    #[test]
    fn a_local_reader_may_read_more_than_a_server_would_send() {
        let words = keywords("hit");
        let mut reader = LineReader {
            unfiltered: true,
            ..LineReader::default()
        };
        let line = format!("{STAMP} {}\n", "x".repeat(1024));
        let log = line.repeat((MAX_JOB_BYTES / line.len()) + 2);
        assert!(reader.push(log.as_bytes(), &words).is_empty());
        assert!(!reader.truncated);
    }

    #[test]
    fn a_local_reader_gives_up_on_a_line_that_never_ends() {
        let mut reader = LineReader {
            unfiltered: true,
            ..LineReader::default()
        };
        reader.push(&vec![b'x'; MAX_JOB_BYTES + 1], &keywords("hit"));
        reader.push(b"more", &keywords("hit"));
        assert!(reader.truncated);
    }

    #[test]
    fn a_local_job_reads_kubectls_status_directly() {
        assert_eq!(exit_state(Some(0), b""), KubeState::Ready);
        assert_eq!(
            exit_state(
                Some(1),
                b"Error from server (NotFound): pods \"x\" not found\n"
            ),
            KubeState::NotFound
        );
        assert_eq!(exit_state(Some(127), b""), KubeState::KubectlMissing);
    }

    #[test]
    fn kubectls_own_exit_status_is_read_from_stderr() {
        let (status, rest) = kubectl_status(b"oops\n\nDACHSTERM-KUBECTL-EXIT 1\n");
        assert_eq!(status, Some(1));
        assert_eq!(rest, b"oops\n\n");
        assert_eq!(kubectl_status(b"nothing").0, None);
    }

    #[test]
    fn job_states_are_read_from_kubectl_and_not_from_the_pipeline() {
        assert_eq!(job_state(b"\nDACHSTERM-KUBECTL-EXIT 0\n"), KubeState::Ready);
        assert_eq!(
            job_state(b"\nDACHSTERM-KUBECTL-EXIT 141\n"),
            KubeState::Ready,
        );
        assert_eq!(
            job_state(
                b"Error from server (NotFound): pods \"x\" not found\n\nDACHSTERM-KUBECTL-EXIT 1\n"
            ),
            KubeState::NotFound,
        );
        assert_eq!(
            job_state(
                b"Error from server (BadRequest): previous terminated container \"a\" in pod \"b\" not found\n\nDACHSTERM-KUBECTL-EXIT 1\n"
            ),
            KubeState::Ready,
        );
    }

    #[test]
    fn a_hit_is_split_from_its_timestamp_and_checked_against_the_text() {
        let line = format!("{STAMP} ERROR boom\x1b[0m\r");
        let hit = parse_hit(line.as_bytes(), &keywords("error")).unwrap();
        assert_eq!(hit.time, STAMP);
        assert_eq!(hit.text, "ERROR boom");
        assert!(!hit.clipped);
        // The word was only in the timestamp, which grep also saw.
        assert_eq!(
            parse_hit(format!("{STAMP} quiet").as_bytes(), &keywords("123456")),
            None
        );
    }

    #[test]
    fn a_line_without_a_timestamp_is_not_a_log_line() {
        assert_eq!(
            parse_hit(b"unable to retrieve container logs for x", &keywords("x")),
            None
        );
    }

    #[test]
    fn a_long_line_is_clipped_and_says_so() {
        let line = format!("{STAMP} a{}", "b".repeat(MAX_LINE_CHARS + 50));
        let hit = parse_hit(line.as_bytes(), &keywords("a")).unwrap();
        assert!(hit.clipped);
        assert_eq!(hit.text.chars().count(), MAX_LINE_CHARS);
    }

    #[test]
    fn pieces_of_a_stream_are_joined_into_lines() {
        let words = keywords("hit");
        let mut reader = LineReader::default();
        let first = format!("{STAMP} hit one\n{STAMP} hi");
        let second = format!("t two\n{STAMP} hit three");
        assert_eq!(reader.push(first.as_bytes(), &words).len(), 1);
        assert_eq!(reader.push(second.as_bytes(), &words).len(), 1);
        let last = reader.finish(&words);
        assert_eq!(last[0].text, "hit three");
        assert!(!reader.truncated);
    }

    #[test]
    fn more_lines_than_a_job_may_keep_means_truncated() {
        let words = keywords("hit");
        let lines = format!("{STAMP} hit\n").repeat(MAX_LINES_PER_JOB + 1);
        let mut reader = LineReader::default();
        assert_eq!(
            reader.push(lines.as_bytes(), &words).len(),
            MAX_LINES_PER_JOB
        );
        assert!(reader.truncated);
    }

    #[test]
    fn more_bytes_than_a_job_may_hold_means_truncated() {
        let mut reader = LineReader::default();
        reader.push(&vec![b'x'; MAX_JOB_BYTES + 1], &keywords("hit"));
        assert!(reader.truncated);
    }

    #[test]
    fn a_plan_covers_each_container_and_previous_instances_when_asked() {
        let plan = plan(request(
            vec![target("api-1", &["app", "side"], &["app"])],
            "1h",
            "error",
        ))
        .unwrap();
        let sources: Vec<(&str, bool)> = plan
            .sources
            .iter()
            .map(|source| (source.container.as_str(), source.previous))
            .collect();
        assert_eq!(sources, [("app", false), ("app", true), ("side", false)]);
    }

    #[test]
    fn pods_over_the_limit_are_counted_and_left_out() {
        let targets = (0..MAX_PODS + 3)
            .map(|at| target(&format!("p-{at}"), &["app"], &[]))
            .collect();
        let plan = plan(request(targets, "15m", "x")).unwrap();
        assert_eq!(plan.sources.len(), MAX_PODS);
        assert_eq!(plan.omitted_pods, 3);
    }

    #[test]
    fn what_reaches_a_command_line_is_checked_first() {
        let good = || vec![target("api-1", &["app"], &[])];
        assert!(plan(request(good(), "15m", "x")).is_ok());
        assert!(plan(request(good(), "15m", "  ")).is_err());
        assert!(plan(request(good(), "15m; reboot", "x")).is_err());
        assert!(plan(request(good(), "15", "x")).is_err());
        assert!(plan(request(good(), "1h30m", "x")).is_ok());
        assert!(plan(request(vec![], "15m", "x")).is_err());
        assert!(
            plan(request(
                vec![target("$(reboot)", &["app"], &[])],
                "15m",
                "x"
            ))
            .is_err()
        );
        assert!(plan(request(vec![target("api-1", &["a;b"], &[])], "15m", "x")).is_err());
    }
}
