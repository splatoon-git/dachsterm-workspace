//! Runs many probes at once under a limit, for tools whose list can be long.
use std::{future::Future, time::Duration};
use tokio::{sync::watch, task::JoinSet};

const TICK: Duration = Duration::from_millis(250);

pub struct Run<I> {
    pub cancelled: bool,
    pub unstarted: Vec<I>,
}

/// Tries `items` at most `limit` at a time. `halted` stops new starts, and those already running
/// finish. Cancelling abandons them.
pub async fn run_limited<I, O, Fut>(
    items: Vec<I>,
    limit: usize,
    mut cancel: watch::Receiver<bool>,
    halted: impl Fn() -> bool,
    probe: impl Fn(I) -> Fut,
    mut finished: impl FnMut(O),
    mut tick: impl FnMut(),
) -> Run<I>
where
    Fut: Future<Output = O> + Send + 'static,
    O: Send + 'static,
{
    let mut waiting = items.into_iter();
    let mut running = JoinSet::new();
    let mut clock = tokio::time::interval(TICK);
    loop {
        while running.len() < limit && !halted() && !*cancel.borrow() {
            match waiting.next() {
                Some(item) => {
                    running.spawn(probe(item));
                }
                None => break,
            }
        }
        if running.is_empty() {
            break;
        }
        tokio::select! {
            biased;
            _ = cancel.wait_for(|stop| *stop) => {
                running.abort_all();
                return Run { cancelled: true, unstarted: Vec::new() };
            }
            joined = running.join_next() => {
                if let Some(Ok(output)) = joined {
                    finished(output);
                }
            }
            _ = clock.tick() => tick(),
        }
    }
    Run {
        cancelled: *cancel.borrow(),
        unstarted: waiting.collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    fn stopper() -> (watch::Sender<bool>, watch::Receiver<bool>) {
        watch::channel(false)
    }

    #[tokio::test]
    async fn never_runs_more_than_the_limit_at_once() {
        let (running, peak) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let (_stop, cancel) = stopper();
        let (r, p) = (running.clone(), peak.clone());
        let mut finished = 0;
        run_limited(
            (0..20).collect(),
            3,
            cancel,
            || false,
            move |_: i32| {
                let (r, p) = (r.clone(), p.clone());
                async move {
                    let now = r.fetch_add(1, Ordering::SeqCst) + 1;
                    p.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    r.fetch_sub(1, Ordering::SeqCst);
                }
            },
            |_| finished += 1,
            || {},
        )
        .await;
        assert_eq!(finished, 20);
        assert_eq!(peak.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn a_halt_stops_new_starts_and_returns_the_rest() {
        let (_stop, cancel) = stopper();
        let halted = Arc::new(AtomicBool::new(false));
        let setter = halted.clone();
        let run = run_limited(
            (0..10).collect(),
            1,
            cancel,
            move || halted.load(Ordering::SeqCst),
            move |item: i32| {
                let setter = setter.clone();
                async move {
                    if item == 2 {
                        setter.store(true, Ordering::SeqCst);
                    }
                }
            },
            |_| {},
            || {},
        )
        .await;
        assert!(!run.cancelled);
        assert_eq!(run.unstarted, (3..10).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn cancelling_abandons_what_is_running() {
        let (stop, cancel) = stopper();
        let mut finished = 0;
        let run = {
            let work = run_limited(
                vec![1, 2, 3],
                2,
                cancel,
                || false,
                |_: i32| std::future::pending::<()>(),
                |_| finished += 1,
                || {},
            );
            tokio::pin!(work);
            tokio::select! {
                run = &mut work => run,
                _ = tokio::time::sleep(Duration::from_millis(20)) => {
                    stop.send(true).unwrap();
                    work.await
                }
            }
        };
        assert!(run.cancelled);
        assert_eq!(finished, 0);
    }
}
