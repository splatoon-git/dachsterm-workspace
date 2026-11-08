//! Port check (TL.6): plain TCP connections only, closed as soon as they open.
use super::{
    SourceArg,
    dial::{Dialer, Failure, RemoteDialer, ServerReason, UNRESOLVED_LIMIT},
    fallback::{self, Tool},
    limited::{Run, run_limited},
    targets::{self, Plan},
};
use crate::{ssh::Connections, storage::Result};
use serde::Serialize;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::watch;

const LOCAL_LIMIT: usize = 64;
const REMOTE_LIMIT: usize = 16;
/// Exec channels count against the server's `MaxSessions` (default 10), which a terminal shares.
const FALLBACK_LIMIT: usize = 4;
const CONFIRM_LIMIT: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Open,
    Closed,
    NoResponse,
    Unreachable,
    Unknown,
    ClosedOrUnreachable,
    ClosedOrNoResponse,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdict {
    pub outcome: Outcome,
    pub detail: Option<String>,
}
impl Verdict {
    pub fn of(outcome: Outcome) -> Self {
        Self {
            outcome,
            detail: None,
        }
    }
    pub fn unknown(detail: impl Into<String>) -> Self {
        Self {
            outcome: Outcome::Unknown,
            detail: Some(detail.into()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    Direct,
    Bash,
    Nc,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Probing,
    Confirming,
    Fallback,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    Result {
        host: String,
        port: u16,
        outcome: Outcome,
        detail: Option<String>,
        method: Method,
    },
    Progress {
        done: usize,
        total: usize,
        waiting: bool,
        phase: Phase,
    },
    Notice {
        message: String,
    },
    Finished {
        cancelled: bool,
        message: Option<String>,
    },
}

/// Nothing runs until a check over several hosts has been confirmed.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Start {
    NeedsConfirmation {
        hosts: usize,
        ports: usize,
        attempts: usize,
    },
    Running,
}

pub type EventSink = Arc<dyn Fn(Event) -> Result<()> + Send + Sync>;

pub struct Request {
    pub source: SourceArg,
    pub targets: String,
    pub ports: String,
    pub timeout_seconds: u64,
    pub job_id: String,
    pub confirmed: bool,
    pub events: EventSink,
}

#[derive(Clone)]
struct Attempt {
    host: String,
    port: u16,
}

fn attempts(plan: Plan) -> Vec<Attempt> {
    let Plan { hosts, ports } = plan;
    hosts
        .into_iter()
        .flat_map(|host| {
            ports.iter().map(move |port| Attempt {
                host: host.clone(),
                port: *port,
            })
        })
        .collect()
}

/// Sends a job's events. A window that has gone away stops the job.
struct Report {
    events: EventSink,
    cancel: Arc<watch::Sender<bool>>,
    total: usize,
    done: AtomicUsize,
    waiting: AtomicBool,
    shown: watch::Sender<(usize, bool)>,
}
impl Report {
    fn send(&self, event: Event) {
        if (self.events)(event).is_err() {
            let _ = self.cancel.send(true);
        }
    }
    fn result(&self, attempt: &Attempt, verdict: Verdict, method: Method) {
        self.send(Event::Result {
            host: attempt.host.clone(),
            port: attempt.port,
            outcome: verdict.outcome,
            detail: verdict.detail,
            method,
        });
    }
    fn finish_one(&self) {
        self.done.fetch_add(1, Ordering::SeqCst);
    }
    /// Sends the count only when it changed, so a big job does not flood the window.
    fn progress(&self, phase: Phase) {
        let done = self.done.load(Ordering::SeqCst);
        let waiting = self.waiting.load(Ordering::SeqCst);
        if *self.shown.borrow() == (done, waiting) && done != self.total {
            return;
        }
        self.shown.send_replace((done, waiting));
        self.send(Event::Progress {
            done,
            total: self.total,
            waiting,
            phase,
        });
    }
}

async fn try_dial(
    dialer: Dialer,
    attempt: Attempt,
    wait: Duration,
) -> (Attempt, std::result::Result<(), Failure>) {
    let result = dialer.dial(&attempt.host, attempt.port, wait).await;
    let result = match result {
        Ok(connected) => {
            connected.close().await;
            Ok(())
        }
        Err(failure) => Err(failure),
    };
    (attempt, result)
}

/// What a result means once no second look is coming.
fn settled(result: std::result::Result<(), Failure>) -> Verdict {
    match result {
        Ok(()) => Verdict::of(Outcome::Open),
        Err(Failure::Refused) => Verdict::of(Outcome::Closed),
        Err(Failure::TimedOut) => Verdict::of(Outcome::NoResponse),
        Err(Failure::Unreachable) => Verdict::of(Outcome::Unreachable),
        Err(Failure::Unknown(detail)) => Verdict::unknown(detail),
        Err(Failure::ConnectFailed) => Verdict::of(Outcome::ClosedOrUnreachable),
        Err(Failure::Prohibited) => Verdict::unknown("서버가 이 연결을 금지했습니다."),
    }
}

fn explained(reason: ServerReason) -> Verdict {
    match reason {
        ServerReason::Refused => Verdict::of(Outcome::Closed),
        ServerReason::NoRoute => Verdict::of(Outcome::Unreachable),
        ServerReason::TimedOut => Verdict::of(Outcome::NoResponse),
        ServerReason::NameFailed => Verdict::unknown("서버에서 이름을 해석하지 못했습니다."),
        ServerReason::NotStarted => Verdict::unknown("서버가 연결을 시작하지 못했습니다."),
        ServerReason::Unrecognized => Verdict::unknown("서버가 알 수 없는 이유를 보냈습니다."),
    }
}

struct Job {
    report: Arc<Report>,
    cancel: watch::Receiver<bool>,
    wait: Duration,
}

#[derive(Default)]
struct Ending {
    cancelled: bool,
    message: Option<String>,
}
fn cancelled() -> Ending {
    Ending {
        cancelled: true,
        message: None,
    }
}

async fn local(job: &Job, list: Vec<Attempt>) -> Ending {
    let wait = job.wait;
    let report = job.report.clone();
    let ticking = job.report.clone();
    let run = run_limited(
        list,
        LOCAL_LIMIT,
        job.cancel.clone(),
        || false,
        move |attempt| try_dial(Dialer::Local, attempt, wait),
        move |(attempt, result): (Attempt, _)| {
            report.result(&attempt, settled(result), Method::Direct);
            report.finish_one();
        },
        move || ticking.progress(Phase::Probing),
    )
    .await;
    Ending {
        cancelled: run.cancelled,
        message: None,
    }
}

struct Sorted {
    /// `ConnectFailed`: closed or unreachable, until the server's description says which.
    pending: Vec<Attempt>,
    prohibited: Vec<Attempt>,
}

async fn probe_remote(
    job: &Job,
    remote: &RemoteDialer,
    list: Vec<Attempt>,
    touch: &(impl Fn() + Send + Sync),
) -> (Run<Attempt>, Sorted) {
    let mut sorted = Sorted {
        pending: Vec::new(),
        prohibited: Vec::new(),
    };
    let (wait, dialer) = (job.wait, Dialer::Remote(remote.clone()));
    let gate = remote.gate().clone();
    let report = job.report.clone();
    let ticking = job.report.clone();
    let halted = remote.clone();
    let saturating = remote.gate().clone();
    let run = run_limited(
        list,
        REMOTE_LIMIT,
        job.cancel.clone(),
        move || gate.exhausted() || halted.is_closed(),
        move |attempt| try_dial(dialer.clone(), attempt, wait),
        |(attempt, result): (Attempt, _)| {
            report.finish_one();
            match result {
                Err(Failure::ConnectFailed) => sorted.pending.push(attempt),
                Err(Failure::Prohibited) => sorted.prohibited.push(attempt),
                other => report.result(&attempt, settled(other), Method::Direct),
            }
        },
        || {
            touch();
            ticking
                .waiting
                .store(saturating.saturated(), Ordering::SeqCst);
            ticking.progress(Phase::Probing);
        },
    )
    .await;
    (run, sorted)
}

/// Opens each one alone, because a description can only be matched to a channel that way (TL.0).
async fn confirm(
    job: &Job,
    remote: &RemoteDialer,
    pending: Vec<Attempt>,
    prohibited: &mut Vec<Attempt>,
) -> bool {
    let dialer = Dialer::Remote(remote.clone());
    for attempt in pending {
        if *job.cancel.borrow() {
            return false;
        }
        let seen = remote.gate().failures_seen();
        let result = dialer.dial(&attempt.host, attempt.port, job.wait).await;
        let verdict = match result {
            Ok(connected) => {
                connected.close().await;
                Verdict::of(Outcome::Open)
            }
            Err(Failure::ConnectFailed) => match remote.gate().reason_after(seen).await {
                Some(reason) => explained(reason),
                None => Verdict::of(Outcome::ClosedOrUnreachable),
            },
            // It answered a moment ago, so a silence now does not make it a silent target.
            Err(Failure::TimedOut) => Verdict::of(Outcome::ClosedOrUnreachable),
            Err(Failure::Prohibited) => {
                prohibited.push(attempt);
                continue;
            }
            Err(other) => settled(Err(other)),
        };
        job.report.result(&attempt, verdict, Method::Direct);
    }
    true
}

async fn fall_back(job: &Job, remote: &RemoteDialer, prohibited: Vec<Attempt>) -> bool {
    job.report.waiting.store(false, Ordering::SeqCst);
    job.report.progress(Phase::Fallback);
    let tool = match fallback::detect(remote.handle()).await {
        Ok(Some(tool)) => tool,
        Ok(None) => {
            let verdict =
                Verdict::unknown("서버가 포워딩을 금지했고 대신 확인할 bash, nc도 없습니다.");
            for attempt in &prohibited {
                job.report.result(attempt, verdict.clone(), Method::Direct);
            }
            return true;
        }
        Err(message) => {
            for attempt in &prohibited {
                job.report
                    .result(attempt, Verdict::unknown(message.clone()), Method::Direct);
            }
            return true;
        }
    };
    let method = match tool {
        Tool::Bash => Method::Bash,
        Tool::Nc => Method::Nc,
    };
    let (handle, wait) = (remote.handle().clone(), job.wait);
    let report = job.report.clone();
    let run = run_limited(
        prohibited,
        FALLBACK_LIMIT,
        job.cancel.clone(),
        || false,
        move |attempt: Attempt| {
            let handle = handle.clone();
            async move {
                let verdict =
                    fallback::attempt(&handle, tool, &attempt.host, attempt.port, wait).await;
                (attempt, verdict)
            }
        },
        move |(attempt, verdict): (Attempt, Verdict)| report.result(&attempt, verdict, method),
        || {},
    )
    .await;
    !run.cancelled
}

async fn remote(
    job: &Job,
    remote: RemoteDialer,
    list: Vec<Attempt>,
    touch: impl Fn() + Send + Sync,
) -> Ending {
    let gate = remote.gate().clone();
    gate.clear_exhausted();
    let (run, sorted) = probe_remote(job, &remote, list, &touch).await;
    if run.cancelled {
        return cancelled();
    }
    let Sorted {
        pending,
        mut prohibited,
    } = sorted;
    let mut message = None;
    if !run.unstarted.is_empty() {
        let reason = if gate.exhausted() {
            "서버가 연결을 더 시작하지 못해 시도하지 않았습니다."
        } else {
            "출발지 연결이 끊어져 시도하지 못했습니다."
        };
        for attempt in &run.unstarted {
            job.report
                .result(attempt, Verdict::unknown(reason), Method::Direct);
        }
        if gate.exhausted() {
            let text = "서버가 연결을 더 시작하지 못함(자원 부족 또는 경로 없음)";
            job.report.send(Event::Notice {
                message: text.into(),
            });
            message = Some(text.to_string());
        }
    }
    job.report.waiting.store(false, Ordering::SeqCst);
    touch();
    if pending.len() > CONFIRM_LIMIT {
        for attempt in &pending {
            job.report.result(
                attempt,
                Verdict::of(Outcome::ClosedOrUnreachable),
                Method::Direct,
            );
        }
    } else if !pending.is_empty() {
        job.report.progress(Phase::Confirming);
        if !confirm(job, &remote, pending, &mut prohibited).await {
            return cancelled();
        }
    }
    touch();
    if !prohibited.is_empty() && !fall_back(job, &remote, prohibited).await {
        return cancelled();
    }
    Ending {
        cancelled: false,
        message,
    }
}

/// Validates and starts a check. Everything after this arrives as events.
pub fn start(connections: Arc<Connections>, request: Request) -> Result<Start> {
    let Request {
        source,
        targets,
        ports,
        timeout_seconds,
        job_id,
        confirmed,
        events,
    } = request;
    if !(1..=30).contains(&timeout_seconds) {
        return Err("시간 초과는 1~30초입니다.".into());
    }
    let plan = targets::plan(&targets, &ports)?;
    if plan.hosts.len() > 1 && !confirmed {
        return Ok(Start::NeedsConfirmation {
            hosts: plan.hosts.len(),
            ports: plan.ports.len(),
            attempts: plan.attempts(),
        });
    }
    let source = match source {
        SourceArg::Local => None,
        SourceArg::Remote { connection_id } => {
            let dialer = connections.net.dialer(&connections, &connection_id)?;
            Some((connection_id, dialer))
        }
    };
    let (cancel, guard) = connections.net.jobs.begin(&connections, job_id)?;
    let job = Job {
        report: Arc::new(Report {
            events,
            cancel: cancel.clone(),
            total: plan.attempts(),
            done: AtomicUsize::new(0),
            waiting: AtomicBool::new(false),
            shown: watch::Sender::new((usize::MAX, false)),
        }),
        cancel: cancel.subscribe(),
        wait: Duration::from_secs(timeout_seconds),
    };
    tokio::spawn(async move {
        let list = attempts(plan);
        let ending = match &source {
            None => local(&job, list).await,
            Some((link, dialer)) => {
                let touching = connections.clone();
                let link = link.clone();
                remote(&job, dialer.clone(), list, move || {
                    touching.net.touch(&link);
                })
                .await
            }
        };
        job.report.progress(Phase::Probing);
        let mut message = ending.message;
        if ending.cancelled
            && let Some((link, dialer)) = &source
            && dialer.gate().unresolved(UNRESOLVED_LIMIT) > 0
        {
            message = Some(cancel_cleanup(&connections, link, dialer));
        }
        job.report.send(Event::Finished {
            cancelled: ending.cancelled,
            message,
        });
        drop(guard);
    });
    Ok(Start::Running)
}

/// A channel the server has not answered cannot be closed from here; only ending the connection
/// clears it, and a terminal's connection is not this tool's to end.
fn cancel_cleanup(connections: &Arc<Connections>, link: &str, dialer: &RemoteDialer) -> String {
    let left = dialer.gate().unresolved(UNRESOLVED_LIMIT);
    if connections.net.owns(link) {
        connections.net.close(connections, link);
        format!("서버에 남은 시도 {left}개를 정리하려고 출발지 연결을 닫았습니다.")
    } else {
        format!("서버에 남은 시도 {left}개는 서버가 응답할 때까지 유지됩니다.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn five_results_and_two_undecided_ones() {
        assert_eq!(settled(Ok(())).outcome, Outcome::Open);
        assert_eq!(settled(Err(Failure::Refused)).outcome, Outcome::Closed);
        assert_eq!(settled(Err(Failure::TimedOut)).outcome, Outcome::NoResponse);
        assert_eq!(
            settled(Err(Failure::Unreachable)).outcome,
            Outcome::Unreachable
        );
        assert_eq!(
            settled(Err(Failure::Unknown("x".into()))).outcome,
            Outcome::Unknown
        );
        assert_eq!(
            settled(Err(Failure::ConnectFailed)).outcome,
            Outcome::ClosedOrUnreachable
        );
        assert_eq!(explained(ServerReason::Refused).outcome, Outcome::Closed);
        assert_eq!(
            explained(ServerReason::NoRoute).outcome,
            Outcome::Unreachable
        );
        assert_eq!(
            explained(ServerReason::TimedOut).outcome,
            Outcome::NoResponse
        );
        for reason in [
            ServerReason::NameFailed,
            ServerReason::NotStarted,
            ServerReason::Unrecognized,
        ] {
            assert_eq!(explained(reason).outcome, Outcome::Unknown);
        }
    }

    fn request(targets: &str, confirmed: bool, sink: EventSink, id: String) -> Request {
        Request {
            source: SourceArg::Local,
            targets: targets.into(),
            ports: "1".into(),
            timeout_seconds: 3,
            job_id: id,
            confirmed,
            events: sink,
        }
    }
    fn collecting() -> (Arc<Mutex<Vec<Event>>>, EventSink) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let writer = events.clone();
        let sink: EventSink = Arc::new(move |event| {
            writer.lock().unwrap().push(event);
            Ok(())
        });
        (events, sink)
    }

    #[tokio::test]
    async fn several_hosts_wait_for_confirmation_and_one_does_not() {
        let connections = Arc::new(Connections::default());
        let (events, sink) = collecting();
        let id = uuid::Uuid::new_v4().to_string();
        let answer = start(
            connections.clone(),
            request("127.0.0.1 127.0.0.2", false, sink.clone(), id.clone()),
        )
        .unwrap();
        assert_eq!(
            answer,
            Start::NeedsConfirmation {
                hosts: 2,
                ports: 1,
                attempts: 2
            }
        );
        assert!(events.lock().unwrap().is_empty());
        let answer = start(connections, request("127.0.0.1", false, sink, id)).unwrap();
        assert_eq!(answer, Start::Running);
        for _ in 0..200 {
            tokio::time::sleep(Duration::from_millis(25)).await;
            if matches!(events.lock().unwrap().last(), Some(Event::Finished { .. })) {
                break;
            }
        }
        let events = events.lock().unwrap();
        assert!(matches!(
            events.iter().find(|e| matches!(e, Event::Result { .. })),
            Some(Event::Result {
                outcome: Outcome::Closed,
                method: Method::Direct,
                ..
            })
        ));
        assert!(matches!(
            events.last(),
            Some(Event::Finished {
                cancelled: false,
                ..
            })
        ));
    }

    #[test]
    fn rejects_a_timeout_out_of_range_before_anything_starts() {
        let connections = Arc::new(Connections::default());
        let (_, sink) = collecting();
        for seconds in [0, 31] {
            let mut bad = request("127.0.0.1", true, sink.clone(), "id".into());
            bad.timeout_seconds = seconds;
            assert!(start(connections.clone(), bad).is_err());
        }
    }
}
