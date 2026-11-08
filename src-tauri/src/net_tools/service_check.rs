//! Service check (TL.8): connects, and finds out what is actually answering. Runs the same over a
//! local socket and an SSH channel, so a server needs neither curl nor openssl.
use super::{
    SourceArg,
    dial::{ByteStream, Dialer, Failure},
    port_check::{Outcome, Verdict, explained, settled},
    service_http::{HttpReply, head_request, parse_reply, read_banner, read_head, text_lines},
    service_target::{self, Format, ServiceTarget},
    service_tls::{self, TlsStep},
};
use crate::{
    remote_exec::{self, Limits},
    ssh::{Connections, Host},
    storage::Result,
};
use russh::client;
use serde::Serialize;
use std::{collections::BTreeSet, net::IpAddr, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite, AsyncWriteExt},
    time::Instant,
};

const CONNECT_WAIT: Duration = Duration::from_secs(5);
const REPLY_WAIT: Duration = Duration::from_secs(5);
/// How long a server gets to speak first (design TL.8).
const BANNER_WAIT: Duration = Duration::from_secs(2);
const LOOKUP_LIMITS: Limits = Limits {
    timeout: Duration::from_secs(3),
    max_output: 4096,
};
const MAX_ADDRESSES: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Service {
    Http,
    Https,
    Tls,
    Banner,
    /// It connected, but nothing it sent shows what it is.
    None,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Resolve {
    /// The target was already an address.
    Literal,
    Measured {
        addresses: Vec<String>,
        ms: u64,
    },
    /// A server resolves as part of connecting, so there is no time to show.
    OnServer {
        addresses: Vec<String>,
    },
    Unresolved,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub host: String,
    pub port: u16,
    pub outcome: Outcome,
    pub detail: Option<String>,
    pub service: Service,
    /// Connecting through the last reply, on the connection that decided the result.
    pub elapsed_ms: Option<u64>,
    pub resolve: Resolve,
    pub connect_ms: Option<u64>,
    pub tls: Option<TlsStep>,
    pub http: Option<HttpReply>,
    /// What the server sent that was not an HTTP reply.
    pub banner: Vec<String>,
    pub attempts: u32,
}

struct Run<'a> {
    dialer: &'a Dialer,
    target: &'a ServiceTarget,
    report: Report,
    started: Instant,
}

impl Run<'_> {
    fn stamp(&mut self) {
        self.report.elapsed_ms = Some(self.started.elapsed().as_millis() as u64);
    }

    /// False when it failed, which is already in the report and ends the check.
    async fn open(&mut self) -> Option<Box<dyn ByteStream>> {
        self.report.attempts += 1;
        self.started = Instant::now();
        let seen = self.dialer.failures_seen();
        let traced = self
            .dialer
            .dial_traced(&self.target.host, self.target.port, CONNECT_WAIT)
            .await;
        if let Some(resolved) = traced.resolved {
            let addresses = shown(resolved.addresses.iter().map(IpAddr::to_string));
            self.report.resolve = if self.target.host.parse::<IpAddr>().is_ok() {
                Resolve::Literal
            } else {
                Resolve::Measured {
                    addresses,
                    ms: resolved.took.as_millis() as u64,
                }
            };
        }
        match traced.result {
            Ok(connected) => {
                self.report.outcome = Outcome::Open;
                self.report.detail = None;
                self.report.connect_ms = Some(traced.took.as_millis() as u64);
                Some(connected.into_stream())
            }
            Err(failure) => {
                let verdict = self.verdict(failure, seen).await;
                self.report.outcome = verdict.outcome;
                self.report.detail = verdict.detail;
                self.report.connect_ms = None;
                self.report.elapsed_ms = None;
                None
            }
        }
    }

    async fn verdict(&self, failure: Failure, seen: u64) -> Verdict {
        if failure == Failure::ConnectFailed
            && let Some(reason) = self.dialer.reason_after(seen).await
        {
            return explained(reason);
        }
        settled(Err(failure))
    }

    async fn exchange<S: AsyncRead + AsyncWrite + Unpin>(
        &mut self,
        stream: &mut S,
        secure: bool,
    ) -> bool {
        let request = head_request(&self.target.path, &self.target.host_header(secure));
        let sent =
            stream.write_all(request.as_bytes()).await.is_ok() && stream.flush().await.is_ok();
        if !sent {
            return false;
        }
        let bytes = read_head(stream, REPLY_WAIT).await;
        match parse_reply(&bytes) {
            Some(reply) => {
                self.report.http = Some(reply);
                self.report.banner.clear();
                true
            }
            None => {
                self.report.banner = text_lines(&bytes);
                false
            }
        }
    }

    /// True when it answered TLS. The reason it did not is kept for showing, or `auto` drops it.
    async fn tls(&mut self, ask_http: bool) -> bool {
        let Some(stream) = self.open().await else {
            return false;
        };
        match service_tls::handshake(stream, &self.target.host).await {
            Err(step) => {
                self.report.tls = Some(*step);
                self.stamp();
                false
            }
            Ok(mut shaken) => {
                self.report.tls = Some(shaken.step);
                self.report.service = Service::Tls;
                if ask_http && self.exchange(&mut shaken.stream, true).await {
                    self.report.service = Service::Https;
                }
                self.stamp();
                true
            }
        }
    }

    async fn http(&mut self) -> bool {
        let Some(mut stream) = self.open().await else {
            return false;
        };
        let answered = self.exchange(&mut stream, false).await;
        if answered {
            self.report.service = Service::Http;
        }
        self.stamp();
        answered
    }

    async fn banner(&mut self) -> bool {
        let Some(mut stream) = self.open().await else {
            return false;
        };
        let lines = text_lines(&read_banner(&mut stream, BANNER_WAIT).await);
        let spoke = !lines.is_empty();
        if spoke {
            self.report.banner = lines;
            self.report.service = Service::Banner;
        }
        self.stamp();
        spoke
    }

    /// One new connection for each try, at most three (design TL.8). A server that speaks first
    /// settles it, because answering a TLS hello or an HTTP request would only confuse it.
    async fn auto(&mut self) {
        if self.banner().await || self.report.outcome != Outcome::Open {
            return;
        }
        if self.tls(true).await || self.report.outcome != Outcome::Open {
            return;
        }
        // The TLS failure is what a plain HTTP port is expected to do, unless HTTP fails as well.
        let tls = self.report.tls.take();
        if !self.http().await && self.report.outcome == Outcome::Open {
            self.report.tls = tls;
        }
    }

    async fn go(mut self) -> Report {
        match self.target.format {
            Format::Auto => self.auto().await,
            Format::Banner => {
                self.banner().await;
            }
            Format::Http => {
                self.http().await;
            }
            Format::Https => {
                self.tls(true).await;
            }
            Format::Tls => {
                self.tls(false).await;
            }
        }
        self.report
    }
}

fn shown(addresses: impl Iterator<Item = String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    addresses
        .filter(|address| seen.insert(address.clone()))
        .take(MAX_ADDRESSES)
        .collect()
}

/// Only an address `getent` printed counts; the rest of its output came from the server.
fn read_lookup(output: &str) -> Vec<String> {
    shown(
        output
            .lines()
            .filter_map(|line| line.split_whitespace().next())
            .filter_map(|token| token.parse::<IpAddr>().ok())
            .map(|address| address.to_string()),
    )
}

/// What the server's own resolver says, when it has `getent`. Failing here costs only the display.
async fn server_lookup(handle: &client::Handle<Host>, host: &str) -> Vec<String> {
    let script = format!(
        "export LC_ALL=C PATH=\"$PATH:/usr/sbin:/sbin\"\ncommand -v getent >/dev/null 2>&1 && getent hosts {}\n",
        remote_exec::quote(host)
    );
    match remote_exec::run(handle, &script, LOOKUP_LIMITS).await {
        Ok(output) => read_lookup(&String::from_utf8_lossy(&output.stdout)),
        Err(_) => Vec::new(),
    }
}

fn blank_report(target: &ServiceTarget, remote: bool) -> Report {
    Report {
        host: target.host.clone(),
        port: target.port,
        outcome: Outcome::Unknown,
        detail: None,
        service: Service::None,
        elapsed_ms: None,
        resolve: if target.host.parse::<IpAddr>().is_ok() {
            Resolve::Literal
        } else if remote {
            Resolve::OnServer {
                addresses: Vec::new(),
            }
        } else {
            Resolve::Unresolved
        },
        connect_ms: None,
        tls: None,
        http: None,
        banner: Vec::new(),
        attempts: 0,
    }
}

async fn check(dialer: Dialer, target: ServiceTarget) -> Report {
    let handle = match &dialer {
        Dialer::Remote(remote) if target.host.parse::<IpAddr>().is_err() => {
            Some(remote.handle().clone())
        }
        _ => None,
    };
    let run = Run {
        report: blank_report(&target, matches!(dialer, Dialer::Remote(_))),
        dialer: &dialer,
        target: &target,
        started: Instant::now(),
    };
    let lookup = async {
        match &handle {
            Some(handle) => server_lookup(handle, &target.host).await,
            None => Vec::new(),
        }
    };
    let (found, mut report) = tokio::join!(lookup, run.go());
    if let Resolve::OnServer { addresses } = &mut report.resolve {
        *addresses = found;
    }
    report
}

/// The answer, or None when the job was cancelled. A remote channel still in use closes on drop.
pub async fn run(
    connections: Arc<Connections>,
    source: SourceArg,
    target: &str,
    format: Format,
    job_id: String,
) -> Result<Option<Report>> {
    let target = service_target::parse(target, format)?;
    let dialer = match source {
        SourceArg::Local => Dialer::Local,
        SourceArg::Remote { connection_id } => {
            Dialer::Remote(connections.net.dialer(&connections, &connection_id)?)
        }
    };
    let (cancel, _guard) = connections.net.jobs.begin(&connections, job_id)?;
    let mut cancelled = cancel.subscribe();
    tokio::select! {
        biased;
        _ = cancelled.wait_for(|stop| *stop) => Ok(None),
        report = check(dialer, target) => Ok(Some(report)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::AsyncReadExt, net::TcpListener, sync::oneshot};

    fn target(port: u16, format: Format) -> ServiceTarget {
        ServiceTarget {
            host: "127.0.0.1".into(),
            port,
            path: "/health".into(),
            format,
        }
    }

    async fn run_check(port: u16, format: Format) -> Report {
        check(Dialer::Local, target(port, format)).await
    }

    #[test]
    fn only_addresses_are_taken_from_getent() {
        assert_eq!(
            read_lookup(
                "10.0.0.5 db.example\n\x1b[31m oops\nfe80::1 db\n10.0.0.5 db\n\nnot-ip x\n"
            ),
            ["10.0.0.5", "fe80::1"]
        );
    }

    #[tokio::test]
    async fn a_closed_port_ends_after_one_try_with_its_reason() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let report = run_check(port, Format::Auto).await;
        assert_eq!(report.outcome, Outcome::Closed);
        assert_eq!(report.service, Service::None);
        assert_eq!(report.attempts, 1);
        assert_eq!(report.elapsed_ms, None);
    }

    #[tokio::test]
    async fn a_server_that_speaks_first_settles_it_on_the_first_connection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket.write_all(b"SSH-2.0-OpenSSH_9.6\r\n").await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let report = run_check(port, Format::Auto).await;
        assert_eq!(report.outcome, Outcome::Open);
        assert_eq!(report.service, Service::Banner);
        assert_eq!(report.banner, ["SSH-2.0-OpenSSH_9.6"]);
        assert_eq!(report.attempts, 1);
    }

    /// Answers each connection in turn the way a plain HTTP port does: silence, then for a TLS
    /// hello a bad request, then a real reply. Reports the last request.
    #[tokio::test]
    async fn automatic_falls_through_to_http_on_a_new_connection_each_time() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (seen, request) = oneshot::channel();
        tokio::spawn(async move {
            // The banner wait: says nothing and is hung up on.
            let (mut first, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            assert_eq!(first.read(&mut buffer).await.unwrap(), 0);
            // The TLS hello gets a plain-text answer, as nginx gives on an HTTP port.
            let (mut second, _) = listener.accept().await.unwrap();
            let count = second.read(&mut buffer).await.unwrap();
            assert_eq!(buffer[0], 0x16, "not a TLS hello ({count} bytes)");
            second
                .write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n")
                .await
                .unwrap();
            drop(second);
            let (mut third, _) = listener.accept().await.unwrap();
            let count = third.read(&mut buffer).await.unwrap();
            let _ = seen.send(String::from_utf8_lossy(&buffer[..count]).to_string());
            third
                .write_all(b"HTTP/1.1 204 No Content\r\nServer: probe\r\n\r\n")
                .await
                .unwrap();
        });
        let report = run_check(port, Format::Auto).await;
        assert_eq!(report.outcome, Outcome::Open);
        assert_eq!(report.service, Service::Http);
        assert_eq!(report.attempts, 3);
        assert_eq!(report.http.as_ref().unwrap().status, 204);
        assert_eq!(
            report.http.as_ref().unwrap().server.as_deref(),
            Some("probe")
        );
        assert!(
            report.tls.is_none(),
            "the expected TLS failure is not shown"
        );
        assert!(report.elapsed_ms.is_some());
        let request = request.await.unwrap();
        assert!(
            request.starts_with("HEAD /health HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(request.contains(&format!("Host: 127.0.0.1:{port}\r\n")));
    }

    #[tokio::test]
    async fn what_answers_but_is_not_http_is_shown_and_not_called_http() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 1024];
            let _ = socket.read(&mut buffer).await;
            socket.write_all(b"+OK redis\r\n").await.unwrap();
        });
        let report = run_check(port, Format::Http).await;
        assert_eq!(report.outcome, Outcome::Open);
        assert_eq!(report.service, Service::None);
        assert_eq!(report.banner, ["+OK redis"]);
        assert_eq!(report.attempts, 1);
    }

    #[tokio::test]
    async fn a_silent_port_is_connected_but_says_nothing_about_its_service() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (_socket, _) = listener.accept().await.unwrap();
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let report = run_check(port, Format::Banner).await;
        assert_eq!(report.outcome, Outcome::Open);
        assert_eq!(report.service, Service::None);
        assert!(report.banner.is_empty());
    }

    #[tokio::test]
    async fn a_tls_format_on_a_plain_port_says_it_is_not_tls() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 4096];
            let _ = socket.read(&mut buffer).await;
            socket
                .write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n")
                .await
                .unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let report = run_check(port, Format::Tls).await;
        assert_eq!(report.outcome, Outcome::Open);
        assert_eq!(report.service, Service::None);
        let tls = report.tls.expect("the failure is reported");
        assert_eq!(tls.failure, Some(service_tls::Failure::NotTls));
        assert_eq!(tls.version, None);
        assert_eq!(report.attempts, 1);
    }

    #[tokio::test]
    async fn cancelling_a_running_check_returns_nothing() {
        let connections = Arc::new(Connections::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _held = listener;
        let job = "cancel-me".to_string();
        let task = {
            let connections = connections.clone();
            let job = job.clone();
            tokio::spawn(async move {
                run(
                    connections,
                    SourceArg::Local,
                    &format!("127.0.0.1:{port}"),
                    Format::Banner,
                    job,
                )
                .await
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        connections.net.jobs.cancel(&job);
        assert_eq!(task.await.unwrap().unwrap().map(|report| report.port), None);
    }
}
