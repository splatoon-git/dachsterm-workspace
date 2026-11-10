//! The SSH connection behind a tool tab's remote source (TL.5). It stops after login: no PTY, shell,
//! session log, Git credentials, agent forwarding or tunnel auto-start.
use super::{
    Jobs,
    dial::{Gate, RemoteDialer},
};
use crate::{
    login_only,
    ssh::{Connections, Control, Event, Host, Sink},
    storage::{Profile, Result},
};
use russh::{ChannelOpenFailure, client};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant},
};
use tokio::sync::watch;

const IDLE_LIMIT: Duration = Duration::from_secs(5 * 60);

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
pub struct Links {
    entries: Mutex<HashMap<String, Link>>,
    /// By SSH connection ID. Weak, so a connection nothing is checking through costs nothing.
    gates: Mutex<HashMap<String, Weak<Gate>>>,
    pub jobs: Jobs,
}

impl Links {
    /// The connection ID behind a link and its handle, and one use: the idle clock starts over.
    fn connection(
        &self,
        connections: &Connections,
        id: &str,
    ) -> Result<(String, Arc<client::Handle<Host>>)> {
        let connection = match self.entries.lock().unwrap().get(id) {
            Some(Link::Owned { used }) => {
                used.send_replace(Instant::now());
                id.to_string()
            }
            Some(Link::Reused { connection, .. }) => connection.clone(),
            None => return Err("출발지 연결이 종료되었습니다.".into()),
        };
        let handle = connections.handle(&connection)?;
        Ok((connection, handle))
    }
    pub fn handle(&self, connections: &Connections, id: &str) -> Result<Arc<client::Handle<Host>>> {
        self.connection(connections, id).map(|(_, handle)| handle)
    }
    /// What a tool dials through. Every link to one SSH connection gets the same gate.
    pub fn dialer(&self, connections: &Connections, id: &str) -> Result<RemoteDialer> {
        let (connection, handle) = self.connection(connections, id)?;
        let mut gates = self.gates.lock().unwrap();
        gates.retain(|_, gate| gate.strong_count() > 0);
        let gate = match gates.get(&connection).and_then(Weak::upgrade) {
            Some(gate) => gate,
            None => {
                let gate = Arc::new(Gate::default());
                gates.insert(connection, Arc::downgrade(&gate));
                gate
            }
        };
        Ok(RemoteDialer::new(handle, gate))
    }
    /// From the connection's russh handler, about a channel that could not be opened.
    pub fn channel_failure(
        &self,
        connection: &str,
        reason: &ChannelOpenFailure,
        description: &str,
    ) {
        let gate = self
            .gates
            .lock()
            .unwrap()
            .get(connection)
            .and_then(Weak::upgrade);
        if let Some(gate) = gate {
            gate.record(reason, description);
        }
    }
    /// A running job counts as use, or a long check would be cut off at the idle limit.
    pub fn touch(&self, id: &str) {
        if let Some(Link::Owned { used }) = self.entries.lock().unwrap().get(id) {
            used.send_replace(Instant::now());
        }
    }
    pub fn owns(&self, id: &str) -> bool {
        matches!(
            self.entries.lock().unwrap().get(id),
            Some(Link::Owned { .. })
        )
    }
    fn forget(&self, id: &str) {
        self.entries.lock().unwrap().remove(id);
    }
    /// Ends the link. Only a connection the tool opened itself is closed with it.
    pub fn close(&self, connections: &Connections, id: &str) {
        let link = self.entries.lock().unwrap().remove(id);
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
        self.entries.lock().unwrap().insert(
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

/// Opens the tool's own connection, which closes after five minutes without use.
pub fn start(request: login_only::Start) -> Result<()> {
    let (used, clock) = watch::channel(Instant::now());
    let (id, connections) = (request.id.clone(), request.connections.clone());
    let owner = connections.clone();
    let ended = {
        let (id, connections) = (id.clone(), connections.clone());
        move || connections.net.forget(&id)
    };
    login_only::start(
        request,
        Some((clock, idle_limit())),
        move || {
            owner
                .net
                .entries
                .lock()
                .unwrap()
                .insert(id, Link::Owned { used });
        },
        ended,
    )
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
    async fn closing_a_reused_link_leaves_the_terminal_alone() {
        let connections = Arc::new(Connections::default());
        let (release, _released) = watch::channel(());
        connections.net.entries.lock().unwrap().insert(
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
