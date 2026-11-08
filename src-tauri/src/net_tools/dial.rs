//! One TCP connection to a target, from this PC or through an SSH server. The port check only asks
//! whether it opened; the service check reads and writes on `Connected::into_stream`.
use crate::ssh::Host;
use russh::{ChannelOpenFailure, client};
use std::{
    io::{self, ErrorKind},
    net::{IpAddr, SocketAddr},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::{TcpStream, lookup_host},
    sync::{Semaphore, TryAcquireError, oneshot, watch},
    time::{Instant, timeout, timeout_at},
};

/// A channel the server has not answered still holds a descriptor there (TL.0, about 124 seconds).
pub const UNRESOLVED_LIMIT: usize = 256;
/// russh wakes the caller first and tells the handler second, so the description can lag.
const DESCRIPTION_WAIT: Duration = Duration::from_secs(1);
/// Windows retries a refused connection for about two seconds (2056 ms on loopback). A shorter
/// wait would show every closed port as giving no response.
const WINDOWS_REFUSAL_TIME: Duration = Duration::from_millis(2500);

/// What an OpenSSH server said about a channel it could not open. Decided once, here: the text
/// comes from the server, so nothing else reads it and it is never shown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServerReason {
    Refused,
    NoRoute,
    TimedOut,
    NameFailed,
    /// `open failed`: the server could not even start connecting.
    NotStarted,
    Unrecognized,
}
impl ServerReason {
    pub fn parse(text: &str) -> Self {
        let text = text.to_ascii_lowercase();
        let has = |part: &str| text.contains(part);
        if has("connection refused") {
            Self::Refused
        } else if has("no route to host") || has("network is unreachable") {
            Self::NoRoute
        } else if has("timed out") {
            Self::TimedOut
        } else if has("name or service not known")
            || has("temporary failure in name resolution")
            || has("nodename nor servname")
        {
            Self::NameFailed
        } else if has("open failed") {
            Self::NotStarted
        } else {
            Self::Unrecognized
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Failure {
    Refused,
    TimedOut,
    Unreachable,
    Unknown(String),
    /// Remote: the server could not connect, and said why only to the connection's handler.
    ConnectFailed,
    /// Remote: the server's policy forbids this forwarding.
    Prohibited,
}

fn classify(error: &io::Error) -> Failure {
    match error.kind() {
        ErrorKind::ConnectionRefused => Failure::Refused,
        ErrorKind::TimedOut => Failure::TimedOut,
        ErrorKind::HostUnreachable | ErrorKind::NetworkUnreachable => Failure::Unreachable,
        _ => Failure::Unknown("이 PC에서 연결을 시도하지 못했습니다.".into()),
    }
}

/// Per SSH connection. It outlives one check, because what a check left unanswered still counts.
pub struct Gate {
    unresolved: Arc<Semaphore>,
    failures: watch::Sender<u64>,
    last: Mutex<Option<ServerReason>>,
    exhausted: AtomicBool,
}
impl Default for Gate {
    fn default() -> Self {
        Self::with_limit(UNRESOLVED_LIMIT)
    }
}
impl Gate {
    fn with_limit(limit: usize) -> Self {
        Self {
            unresolved: Arc::new(Semaphore::new(limit)),
            failures: watch::Sender::new(0),
            last: Mutex::new(None),
            exhausted: AtomicBool::new(false),
        }
    }
    pub fn record(&self, reason: &ChannelOpenFailure, description: &str) {
        let parsed = ServerReason::parse(description);
        if matches!(reason, ChannelOpenFailure::ConnectFailed) {
            *self.last.lock().unwrap() = Some(parsed);
            if parsed == ServerReason::NotStarted {
                self.exhausted.store(true, Ordering::SeqCst);
            }
        }
        self.failures.send_modify(|count| *count += 1);
    }
    pub fn failures_seen(&self) -> u64 {
        *self.failures.borrow()
    }
    /// The description of the one failure since `seen`. None when it did not come, or when another
    /// channel failed as well (a tunnel on a shared connection) and it cannot be told apart.
    pub async fn reason_after(&self, seen: u64) -> Option<ServerReason> {
        let mut failures = self.failures.subscribe();
        timeout(DESCRIPTION_WAIT, failures.wait_for(|count| *count > seen))
            .await
            .ok()?
            .ok()?;
        if self.failures_seen() != seen + 1 {
            return None;
        }
        *self.last.lock().unwrap()
    }
    pub fn exhausted(&self) -> bool {
        self.exhausted.load(Ordering::SeqCst)
    }
    pub fn clear_exhausted(&self) {
        self.exhausted.store(false, Ordering::SeqCst);
    }
    pub fn unresolved(&self, limit: usize) -> usize {
        limit.saturating_sub(self.unresolved.available_permits())
    }
    pub fn saturated(&self) -> bool {
        self.unresolved.available_permits() == 0
    }
}

/// An established connection. A remote one must be closed: dropping a channel leaves it open.
pub enum Connected {
    Local(TcpStream),
    Remote(russh::Channel<client::Msg>),
}
impl Connected {
    pub async fn close(self) {
        match self {
            Self::Local(stream) => drop(stream),
            Self::Remote(channel) => {
                let _ = channel.close().await;
            }
        }
    }
    /// Unlike the channel itself, russh's stream closes the channel when it is dropped.
    pub fn into_stream(self) -> Box<dyn ByteStream> {
        match self {
            Self::Local(stream) => Box::new(stream),
            Self::Remote(channel) => Box::new(channel.into_stream()),
        }
    }
}

pub trait ByteStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> ByteStream for T {}

/// What name resolution found. Only this PC can time it: a server resolves as part of connecting.
pub struct Resolved {
    pub addresses: Vec<IpAddr>,
    pub took: Duration,
}
/// A dial and how its time was spent. `resolved` stays with a connection that then failed.
pub struct Traced {
    pub resolved: Option<Resolved>,
    pub took: Duration,
    pub result: Result<Connected, Failure>,
}

#[derive(Clone)]
pub struct RemoteDialer {
    handle: Arc<client::Handle<Host>>,
    gate: Arc<Gate>,
}

#[derive(Clone)]
pub enum Dialer {
    Local,
    Remote(RemoteDialer),
}
impl Dialer {
    pub async fn dial(&self, host: &str, port: u16, wait: Duration) -> Result<Connected, Failure> {
        match self {
            Self::Local => local(host, port, wait).await,
            Self::Remote(remote) => remote.dial(host, port, wait).await,
        }
    }
    pub async fn dial_traced(&self, host: &str, port: u16, wait: Duration) -> Traced {
        match self {
            Self::Local => local_traced(host, port, wait).await,
            Self::Remote(remote) => {
                let started = Instant::now();
                let result = remote.dial(host, port, wait).await;
                Traced {
                    resolved: None,
                    took: started.elapsed(),
                    result,
                }
            }
        }
    }
    /// Marks a point before a dial, for asking afterwards why it failed.
    pub fn failures_seen(&self) -> u64 {
        match self {
            Self::Local => 0,
            Self::Remote(remote) => remote.gate.failures_seen(),
        }
    }
    /// Only a server explains a failure separately from reporting it.
    pub async fn reason_after(&self, seen: u64) -> Option<ServerReason> {
        match self {
            Self::Local => None,
            Self::Remote(remote) => remote.gate.reason_after(seen).await,
        }
    }
}

async fn resolve(host: &str, port: u16, deadline: Instant) -> Result<Vec<SocketAddr>, Failure> {
    Ok(timeout_at(deadline, lookup_host((host, port)))
        .await
        .map_err(|_| Failure::Unknown("이름 해석 시간이 초과되었습니다.".into()))?
        .map_err(|_| Failure::Unknown("이름을 해석하지 못했습니다.".into()))?
        .collect())
}

async fn connect_any(addresses: Vec<SocketAddr>, deadline: Instant) -> Result<Connected, Failure> {
    let mut failure = Failure::Unknown("이름을 해석하지 못했습니다.".into());
    for address in addresses {
        match timeout_at(deadline, TcpStream::connect(address)).await {
            Err(_) => return Err(Failure::TimedOut),
            Ok(Ok(stream)) => return Ok(Connected::Local(stream)),
            Ok(Err(error)) => failure = classify(&error),
        }
    }
    Err(failure)
}

fn local_deadline(wait: Duration) -> Instant {
    let wait = if cfg!(windows) {
        wait.max(WINDOWS_REFUSAL_TIME)
    } else {
        wait
    };
    Instant::now() + wait
}

async fn local(host: &str, port: u16, wait: Duration) -> Result<Connected, Failure> {
    let deadline = local_deadline(wait);
    connect_any(resolve(host, port, deadline).await?, deadline).await
}

async fn local_traced(host: &str, port: u16, wait: Duration) -> Traced {
    let deadline = local_deadline(wait);
    let started = Instant::now();
    let addresses = match resolve(host, port, deadline).await {
        Ok(addresses) => addresses,
        Err(failure) => {
            return Traced {
                resolved: None,
                took: started.elapsed(),
                result: Err(failure),
            };
        }
    };
    let resolved = Resolved {
        addresses: addresses.iter().map(SocketAddr::ip).collect(),
        took: started.elapsed(),
    };
    let connecting = Instant::now();
    let result = connect_any(addresses, deadline).await;
    Traced {
        resolved: Some(resolved),
        took: connecting.elapsed(),
        result,
    }
}

impl RemoteDialer {
    pub fn new(handle: Arc<client::Handle<Host>>, gate: Arc<Gate>) -> Self {
        Self { handle, gate }
    }
    pub fn handle(&self) -> &Arc<client::Handle<Host>> {
        &self.handle
    }
    pub fn gate(&self) -> &Arc<Gate> {
        &self.gate
    }
    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }
    /// `wait` starts once the server has room. The open itself runs in its own task until the
    /// server answers: abandoning it would leak the channel for the life of the connection (TL.0).
    async fn dial(&self, host: &str, port: u16, wait: Duration) -> Result<Connected, Failure> {
        let unresolved = self.gate.unresolved.clone();
        let permit = match unresolved.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(TryAcquireError::NoPermits) => unresolved
                .acquire_owned()
                .await
                .map_err(|_| Failure::Unknown("출발지 연결이 끊어졌습니다.".into()))?,
            Err(TryAcquireError::Closed) => {
                return Err(Failure::Unknown("출발지 연결이 끊어졌습니다.".into()));
            }
        };
        let (answer, answered) = oneshot::channel();
        let (handle, target) = (self.handle.clone(), host.to_string());
        // Held until the server answers: the next check on this connection must still count this
        // channel, and the handler still has to find the gate for its description.
        let gate = self.gate.clone();
        tokio::spawn(async move {
            let result = handle
                .channel_open_direct_tcpip(target, port as u32, "127.0.0.1", 0)
                .await;
            drop(permit);
            drop(gate);
            // Nobody is waiting any more, and this late channel is nobody else's to close.
            if let Err(Ok(channel)) = answer.send(result) {
                let _ = channel.close().await;
            }
        });
        match timeout(wait, answered).await {
            Err(_) => Err(Failure::TimedOut),
            Ok(Err(_)) => Err(Failure::Unknown("출발지 연결이 끊어졌습니다.".into())),
            Ok(Ok(Ok(channel))) => Ok(Connected::Remote(channel)),
            Ok(Ok(Err(russh::Error::ChannelOpenFailure(reason)))) => Err(match reason {
                ChannelOpenFailure::ConnectFailed => Failure::ConnectFailed,
                ChannelOpenFailure::AdministrativelyProhibited => Failure::Prohibited,
                _ => Failure::Unknown("서버가 이 연결을 열지 못했습니다.".into()),
            }),
            Ok(Ok(Err(_))) => Err(Failure::Unknown("출발지 연결이 끊어졌습니다.".into())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_openssh_says() {
        for (text, reason) in [
            ("Connection refused", ServerReason::Refused),
            ("No route to host", ServerReason::NoRoute),
            ("Network is unreachable", ServerReason::NoRoute),
            ("Connection timed out", ServerReason::TimedOut),
            ("Name or service not known", ServerReason::NameFailed),
            ("open failed", ServerReason::NotStarted),
            ("bash: connect: Connection refused\n", ServerReason::Refused),
            ("unexpected text from a server", ServerReason::Unrecognized),
            ("", ServerReason::Unrecognized),
        ] {
            assert_eq!(ServerReason::parse(text), reason, "{text}");
        }
    }

    #[test]
    fn classifies_socket_errors() {
        for (kind, failure) in [
            (ErrorKind::ConnectionRefused, Failure::Refused),
            (ErrorKind::TimedOut, Failure::TimedOut),
            (ErrorKind::HostUnreachable, Failure::Unreachable),
            (ErrorKind::NetworkUnreachable, Failure::Unreachable),
        ] {
            assert_eq!(classify(&kind.into()), failure);
        }
        assert!(matches!(
            classify(&ErrorKind::PermissionDenied.into()),
            Failure::Unknown(_)
        ));
    }

    async fn dial(host: &str, port: u16, wait: u64) -> Result<(), Failure> {
        let result = Dialer::Local
            .dial(host, port, Duration::from_secs(wait))
            .await;
        result.map(|_| ())
    }

    #[tokio::test]
    async fn a_listening_port_opens() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        assert_eq!(dial("127.0.0.1", port, 3).await, Ok(()));
    }

    #[tokio::test]
    async fn a_closed_port_is_refused_even_with_the_shortest_wait() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert_eq!(dial("127.0.0.1", port, 1).await, Err(Failure::Refused));
    }

    #[tokio::test]
    async fn a_name_that_does_not_resolve_is_not_called_closed() {
        let result = dial("no-such-host.invalid", 80, 5).await;
        assert!(matches!(result, Err(Failure::Unknown(_))), "{result:?}");
    }

    #[tokio::test]
    async fn a_traced_dial_separates_the_lookup_from_the_connection() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let traced = Dialer::Local
            .dial_traced("127.0.0.1", port, Duration::from_secs(3))
            .await;
        assert!(traced.result.is_ok());
        let resolved = traced.resolved.expect("a local dial times its lookup");
        assert_eq!(resolved.addresses, vec![IpAddr::from([127, 0, 0, 1])]);
    }

    fn failed(gate: &Gate, text: &str) {
        gate.record(&ChannelOpenFailure::ConnectFailed, text);
    }

    #[tokio::test]
    async fn a_description_is_found_even_when_it_comes_after_the_result() {
        let gate = Arc::new(Gate::default());
        let seen = gate.failures_seen();
        let writer = gate.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(40)).await;
            failed(&writer, "No route to host");
        });
        assert_eq!(gate.reason_after(seen).await, Some(ServerReason::NoRoute));
    }

    #[tokio::test]
    async fn two_failures_at_once_cannot_be_told_apart() {
        let gate = Gate::default();
        let seen = gate.failures_seen();
        failed(&gate, "Connection refused");
        failed(&gate, "No route to host");
        assert_eq!(gate.reason_after(seen).await, None);
    }

    #[tokio::test]
    async fn a_missing_description_stops_waiting() {
        let gate = Gate::default();
        assert_eq!(gate.reason_after(gate.failures_seen()).await, None);
    }

    #[test]
    fn only_a_failed_start_means_the_server_is_out_of_room() {
        let gate = Gate::default();
        failed(&gate, "Connection refused");
        gate.record(
            &ChannelOpenFailure::AdministrativelyProhibited,
            "open failed",
        );
        assert!(!gate.exhausted());
        failed(&gate, "open failed");
        assert!(gate.exhausted());
        gate.clear_exhausted();
        assert!(!gate.exhausted());
    }

    #[tokio::test]
    async fn the_gate_counts_what_the_server_has_not_answered() {
        let gate = Gate::with_limit(2);
        let held = gate.unresolved.clone().acquire_many_owned(2).await.unwrap();
        assert!(gate.saturated());
        assert_eq!(gate.unresolved(2), 2);
        drop(held);
        assert!(!gate.saturated());
        assert_eq!(gate.unresolved(2), 0);
    }
}
