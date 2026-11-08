//! The SSH connection behind a tool tab's remote source (TL.5). It stops after login: no PTY, shell,
//! session log, Git credentials, agent forwarding or tunnel auto-start.
use crate::{
    ssh::{Connections, Control, Event, Host, Sink, route},
    storage::{Profile, Result, Store},
};
use russh::client;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::watch;
use zeroize::Zeroizing;

const IDLE_LIMIT: Duration = Duration::from_secs(5 * 60);
/// How often a held connection looks at whether it or a jump host has gone.
const HEALTH_INTERVAL: Duration = Duration::from_millis(200);

enum Link {
    /// The tool tab opened this connection, under the link's own ID, and ends it.
    Owned { used: watch::Sender<Instant> },
    /// A terminal's connection. Dropping `_release` ends the task that watches it, nothing more.
    Reused {
        connection: String,
        _release: watch::Sender<()>,
    },
}

#[derive(Default)]
pub struct Links(Mutex<HashMap<String, Link>>);

impl Links {
    /// The SSH connection behind a link, and one use of it: the idle clock starts over.
    pub fn handle(&self, connections: &Connections, id: &str) -> Result<Arc<client::Handle<Host>>> {
        let connection = match self.0.lock().unwrap().get(id) {
            Some(Link::Owned { used }) => {
                used.send_replace(Instant::now());
                id.to_string()
            }
            Some(Link::Reused { connection, .. }) => connection.clone(),
            None => return Err("출발지 연결이 종료되었습니다.".into()),
        };
        connections.handle(&connection)
    }
    fn owns(&self, id: &str) -> bool {
        matches!(self.0.lock().unwrap().get(id), Some(Link::Owned { .. }))
    }
    fn forget(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
    /// Ends the link. Only a connection the tool opened itself is closed with it.
    pub fn close(&self, connections: &Connections, id: &str) {
        let link = self.0.lock().unwrap().remove(id);
        if matches!(link, Some(Link::Owned { .. }))
            && let Ok(control) = connections.control(id)
        {
            let _ = control.stop.send(true);
        }
    }
    /// Shares a terminal's connection until the tab lets go or the terminal ends.
    pub fn reuse(
        &self,
        connections: &Arc<Connections>,
        id: String,
        (terminal, control): (String, Arc<Control>),
        sink: Sink,
    ) {
        let (release, mut released) = watch::channel(());
        self.0.lock().unwrap().insert(
            id.clone(),
            Link::Reused {
                connection: terminal,
                _release: release,
            },
        );
        let _ = sink(Event::State {
            status: "connected".into(),
            message: "연결됨 · 터미널 연결을 함께 씁니다.".into(),
        });
        let mut stopped = control.stop.subscribe();
        let connections = connections.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = stopped.wait_for(|stop| *stop) => {
                    connections.net.forget(&id);
                    let _ = sink(Event::State {
                        status: "closed".into(),
                        message: "함께 쓰던 터미널 연결이 종료되었습니다.".into(),
                    });
                }
                // The only value `_release` ever gives is its drop: the tab let go.
                _ = released.changed() => {}
            }
        });
    }
}

/// A terminal already connected to this exact target. A session edited since that terminal
/// connected may point elsewhere now, so the comparison is against what is saved.
pub fn reusable(connections: &Connections, profile: &Profile) -> Option<(String, Arc<Control>)> {
    let candidates: Vec<_> = connections
        .entries
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, control)| crate::commands::same_credential_target(&control.profile, profile))
        .map(|(id, control)| (id.clone(), control.clone()))
        .collect();
    candidates
        .into_iter()
        .find(|(id, _)| !connections.net.owns(id) && connections.handle(id).is_ok())
}

pub struct Start {
    pub connections: Arc<Connections>,
    pub id: String,
    pub profile: Profile,
    pub secret: Option<Zeroizing<String>>,
    pub hops: Vec<(Profile, Option<Zeroizing<String>>)>,
    pub paths: Vec<PathBuf>,
    pub sink: Sink,
    pub store: Arc<Store>,
}

pub fn start(request: Start) -> Result<()> {
    let Start {
        connections,
        id,
        profile,
        secret,
        hops,
        paths,
        sink,
        store,
    } = request;
    let (sink, mut channels) = connections.register(&id, &profile, &hops, sink, &store)?;
    let (used, clock) = watch::channel(Instant::now());
    connections
        .net
        .0
        .lock()
        .unwrap()
        .insert(id.clone(), Link::Owned { used });
    let mut stopped = channels.stop.clone();
    tokio::spawn(async move {
        let work = async {
            let route = route::open(
                route::Target {
                    profile: &profile,
                    secret,
                    hops,
                    paths: &paths,
                    forward_agent: false,
                },
                &mut channels,
                sink.clone(),
                &connections,
                &id,
            )
            .await?;
            route.publish(&connections, &id);
            sink(Event::State {
                status: "connected".into(),
                message: format!("연결됨 · {}", route.description),
            })?;
            hold(&route, clock).await
        };
        let result = tokio::select! {
            biased;
            _ = stopped.wait_for(|stop| *stop) => Ok("연결을 닫았습니다.".to_string()),
            result = work => result,
        };
        connections.finish(&id);
        connections.net.forget(&id);
        let (status, message) = match result {
            Ok(message) => ("closed", message),
            Err(message) => ("error", message),
        };
        let _ = sink(Event::State {
            status: status.into(),
            message,
        });
    });
    Ok(())
}

/// Keeps the logged-in connection until it breaks or stops being used.
async fn hold(route: &route::Route, clock: watch::Receiver<Instant>) -> Result<String> {
    let quiet = idle(clock, idle_limit());
    tokio::pin!(quiet);
    loop {
        tokio::select! {
            _ = &mut quiet => return Ok("5분간 쓰지 않아 연결을 닫았습니다.".into()),
            _ = tokio::time::sleep(HEALTH_INTERVAL) => {}
        }
        if let Some(hop) = route.broken_hop() {
            return Err(format!("{hop}홉 연결이 끊어졌습니다."));
        }
        if route.session.is_closed() {
            return Err("서버 연결이 끊어졌습니다.".into());
        }
    }
}

/// Finishes once `limit` passes with no use. Connecting time does not count, so the clock
/// starts when this is first polled.
async fn idle(mut clock: watch::Receiver<Instant>, limit: Duration) {
    let mut since = Instant::now();
    loop {
        let wait = tokio::time::sleep_until((since + limit).into());
        tokio::select! {
            _ = wait => return,
            changed = clock.changed() => {
                // The sender goes with the link, and the stop that follows ends this task.
                if changed.is_err() {
                    return std::future::pending().await;
                }
                since = *clock.borrow_and_update();
            }
        }
    }
}

fn idle_limit() -> Duration {
    #[cfg(debug_assertions)]
    if let Some(seconds) = std::env::var("DACHSTERM_TEST_NET_IDLE_SECONDS")
        .ok()
        .and_then(|value| value.parse().ok())
    {
        return Duration::from_secs(seconds);
    }
    IDLE_LIMIT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn idle_ends_after_the_limit() {
        let (_used, clock) = watch::channel(Instant::now());
        let started = Instant::now();
        idle(clock, Duration::from_millis(60)).await;
        assert!(started.elapsed() >= Duration::from_millis(60));
    }

    #[tokio::test]
    async fn a_use_restarts_the_idle_clock() {
        let (used, clock) = watch::channel(Instant::now());
        let started = Instant::now();
        let waiting = tokio::spawn(idle(clock, Duration::from_millis(200)));
        tokio::time::sleep(Duration::from_millis(120)).await;
        used.send_replace(Instant::now());
        waiting.await.unwrap();
        assert!(started.elapsed() >= Duration::from_millis(320));
    }

    #[tokio::test]
    async fn a_dropped_link_does_not_end_the_wait_by_itself() {
        let (used, clock) = watch::channel(Instant::now());
        let waiting = tokio::spawn(idle(clock, Duration::from_secs(60)));
        drop(used);
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!waiting.is_finished());
        waiting.abort();
    }

    #[tokio::test]
    async fn closing_a_reused_link_leaves_the_terminal_alone() {
        let connections = Arc::new(Connections::default());
        let (release, _released) = watch::channel(());
        connections.net.0.lock().unwrap().insert(
            "tool".into(),
            Link::Reused {
                connection: "terminal".into(),
                _release: release,
            },
        );
        assert!(!connections.net.owns("tool"));
        connections.net.close(&connections, "tool");
        assert!(connections.net.handle(&connections, "tool").is_err());
    }

    #[test]
    fn an_unknown_link_has_no_connection() {
        let connections = Connections::default();
        let error = connections.net.handle(&connections, "gone").err().unwrap();
        assert_eq!(error, "출발지 연결이 종료되었습니다.");
    }
}
