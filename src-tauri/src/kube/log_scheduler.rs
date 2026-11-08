//! Runs a log search's jobs a few at a time, fewer once the server refuses channels. `MaxSessions`
//! is shared with the shell and every other tab, so a refusal means this search is asking too much.
use serde::Serialize;
use std::{collections::VecDeque, future::Future, time::Duration};
use tokio::{
    sync::watch,
    task::JoinSet,
    time::{Instant, sleep, sleep_until},
};

pub enum JobEnd<T> {
    Done,
    /// The server would not open a channel for this job.
    Refused(T, u32),
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Done,
    Cancelled,
    TimedOut,
    TotalLimit,
}

pub enum Note<T> {
    Narrowed(usize),
    GaveUp(T),
}

#[derive(Clone, Copy)]
pub struct Schedule {
    pub concurrent: usize,
    pub max_refusals: u32,
    pub retry_wait: Duration,
    pub total_time: Duration,
}

pub struct Finish {
    pub outcome: Outcome,
    pub unstarted: usize,
}

pub async fn run_jobs<T, Fut>(
    items: Vec<T>,
    schedule: Schedule,
    mut cancel: watch::Receiver<bool>,
    over_limit: impl Fn() -> bool,
    start: impl Fn(T, u32) -> Fut,
    mut note: impl FnMut(Note<T>),
) -> Finish
where
    T: Send + 'static,
    Fut: Future<Output = JobEnd<T>> + Send + 'static,
{
    let mut waiting: VecDeque<(T, u32)> = items.into_iter().map(|item| (item, 0)).collect();
    let mut running = JoinSet::new();
    let mut limit = schedule.concurrent;
    let mut not_before = Instant::now();
    let deadline = sleep(schedule.total_time);
    tokio::pin!(deadline);
    let outcome = loop {
        if over_limit() {
            break Outcome::TotalLimit;
        }
        while running.len() < limit && Instant::now() >= not_before {
            let Some((item, refusals)) = waiting.pop_front() else {
                break;
            };
            running.spawn(start(item, refusals));
        }
        if running.is_empty() && waiting.is_empty() {
            break Outcome::Done;
        }
        tokio::select! {
            biased;
            _ = cancel.wait_for(|stop| *stop) => break Outcome::Cancelled,
            _ = &mut deadline => break Outcome::TimedOut,
            joined = running.join_next(), if !running.is_empty() => {
                if let Some(Ok(JobEnd::Refused(item, refusals))) = joined {
                    let refusals = refusals + 1;
                    if refusals >= schedule.max_refusals {
                        note(Note::GaveUp(item));
                    } else {
                        waiting.push_front((item, refusals));
                        let narrowed = limit.min(running.len().max(1));
                        if narrowed < limit {
                            limit = narrowed;
                            note(Note::Narrowed(limit));
                        }
                        not_before = Instant::now() + schedule.retry_wait;
                    }
                }
            }
            _ = sleep_until(not_before), if Instant::now() < not_before && !waiting.is_empty() => {}
        }
    };
    // Dropping a job closes its SSH channel, which also ends its kubectl on the server.
    running.abort_all();
    Finish {
        outcome,
        unstarted: waiting.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    const SCHEDULE: Schedule = Schedule {
        concurrent: 4,
        max_refusals: 3,
        retry_wait: Duration::from_millis(1),
        total_time: Duration::from_secs(5),
    };

    fn stopper() -> (watch::Sender<bool>, watch::Receiver<bool>) {
        watch::channel(false)
    }

    #[tokio::test]
    async fn no_more_than_the_limit_run_at_once() {
        let (_stop, cancel) = stopper();
        let (now, peak) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let (n, p) = (now.clone(), peak.clone());
        let finish = run_jobs(
            (0..20).collect(),
            SCHEDULE,
            cancel,
            || false,
            move |_: i32, _| {
                let (n, p) = (n.clone(), p.clone());
                async move {
                    p.fetch_max(n.fetch_add(1, Ordering::SeqCst) + 1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    n.fetch_sub(1, Ordering::SeqCst);
                    JobEnd::Done
                }
            },
            |_| {},
        )
        .await;
        assert_eq!(finish.outcome, Outcome::Done);
        assert_eq!(finish.unstarted, 0);
        assert_eq!(peak.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn a_refusal_lowers_the_limit_and_the_job_runs_again() {
        let (_stop, cancel) = stopper();
        let attempts = Arc::new(AtomicUsize::new(0));
        let counted = attempts.clone();
        let mut narrowed = Vec::new();
        let finish = run_jobs(
            (0..4).collect(),
            SCHEDULE,
            cancel,
            || false,
            move |item: i32, refusals| {
                let counted = counted.clone();
                async move {
                    counted.fetch_add(1, Ordering::SeqCst);
                    if item < 2 && refusals == 0 {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                        JobEnd::Refused(item, refusals)
                    } else {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        JobEnd::Done
                    }
                }
            },
            |note| {
                if let Note::Narrowed(limit) = note {
                    narrowed.push(limit);
                }
            },
        )
        .await;
        assert_eq!(finish.outcome, Outcome::Done);
        assert_eq!(attempts.load(Ordering::SeqCst), 6);
        assert_eq!(narrowed, [3, 2]);
    }

    #[tokio::test]
    async fn a_job_refused_every_time_gives_up_without_stopping_the_rest() {
        let (_stop, cancel) = stopper();
        let done = Arc::new(Mutex::new(Vec::new()));
        let finished = done.clone();
        let mut gave_up = Vec::new();
        let finish = run_jobs(
            vec![1, 2],
            SCHEDULE,
            cancel,
            || false,
            move |item: i32, refusals| {
                let finished = finished.clone();
                async move {
                    if item == 1 {
                        return JobEnd::Refused(item, refusals);
                    }
                    finished.lock().unwrap().push(item);
                    JobEnd::Done
                }
            },
            |note| {
                if let Note::GaveUp(item) = note {
                    gave_up.push(item);
                }
            },
        )
        .await;
        assert_eq!(finish.outcome, Outcome::Done);
        assert_eq!(*done.lock().unwrap(), [2]);
        assert_eq!(gave_up, [1]);
    }

    #[tokio::test]
    async fn cancelling_stops_what_is_running_and_counts_what_never_started() {
        let (stop, cancel) = stopper();
        let run = tokio::spawn(run_jobs(
            (0..6).collect(),
            SCHEDULE,
            cancel,
            || false,
            |_: i32, _| std::future::pending::<JobEnd<i32>>(),
            |_| {},
        ));
        tokio::time::sleep(Duration::from_millis(20)).await;
        stop.send(true).unwrap();
        let finish = run.await.unwrap();
        assert_eq!(finish.outcome, Outcome::Cancelled);
        assert_eq!(finish.unstarted, 2);
    }

    #[tokio::test]
    async fn the_total_time_and_the_line_limit_end_the_search() {
        let (_stop, cancel) = stopper();
        let timed_out = run_jobs(
            vec![1],
            Schedule {
                total_time: Duration::from_millis(10),
                ..SCHEDULE
            },
            cancel.clone(),
            || false,
            |_: i32, _| std::future::pending::<JobEnd<i32>>(),
            |_| {},
        )
        .await;
        assert_eq!(timed_out.outcome, Outcome::TimedOut);
        let full = run_jobs(
            vec![1],
            SCHEDULE,
            cancel,
            || true,
            |_: i32, _| std::future::pending::<JobEnd<i32>>(),
            |_| {},
        )
        .await;
        assert_eq!(full.outcome, Outcome::TotalLimit);
    }
}
