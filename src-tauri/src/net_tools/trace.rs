//! Route trace (TL.9). It only says where replies stop. Firewalls usually do not answer, so the
//! conclusion never claims that a device blocked anything.
use super::{
    SourceArg,
    jobs::CancelSignal,
    targets,
    trace_parse::{self, Hop, Line},
};
use crate::{
    remote_exec::{self, Failure, Limits},
    ssh::{Connections, Host},
    storage::Result,
};
use russh::client;
use serde::Serialize;
use std::{
    collections::BTreeMap,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

const MAX_HOPS: u8 = 30;
const LIMITS: Limits = Limits {
    timeout: Duration::from_secs(60),
    max_output: 64 * 1024,
};
const PATH: &str = "export LC_ALL=C PATH=\"$PATH:/usr/sbin:/sbin\"\n";
const CUT_OFF: &str = "시간 제한(60초)에 걸려 여기까지만 확인했습니다.";
const TOO_LONG: &str = "출력이 너무 길어 여기까지만 확인했습니다.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    /// ICMP echo with a TTL, from Windows.
    Icmp,
    /// TCP to the checked port, the only method that follows that port's own policy.
    TcpPort,
    /// `traceroute`'s default UDP probes.
    Udp,
    Tracepath,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Conclusion {
    Reached,
    LastResponder {
        address: String,
    },
    NoReply,
    /// No usable tool on the source, or none of them was allowed to run.
    Unavailable,
    Failed {
        message: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    Method {
        method: Method,
    },
    Hop {
        hop: Hop,
    },
    Finished {
        cancelled: bool,
        conclusion: Option<Conclusion>,
        note: Option<String>,
    },
}

pub type EventSink = Arc<dyn Fn(Event) -> Result<()> + Send + Sync>;

pub struct Request {
    pub source: SourceArg,
    pub host: String,
    pub port: u16,
    pub job_id: String,
    pub events: EventSink,
}

/// Lines repeat a hop when a tool probes it twice. The one that named a device stays.
#[derive(Default)]
struct Route {
    hops: BTreeMap<u8, Hop>,
}
impl Route {
    fn add(&mut self, hop: Hop) -> Hop {
        let entry = self.hops.entry(hop.hop).or_insert_with(|| hop.clone());
        if entry.address.is_none() && hop.address.is_some() {
            *entry = hop.clone();
        }
        entry.reached |= hop.reached;
        entry.unreachable |= hop.unreachable;
        entry.clone()
    }
    fn conclusion(&self) -> Conclusion {
        if self.hops.values().any(|hop| hop.reached) {
            return Conclusion::Reached;
        }
        match self.hops.values().rev().find_map(|hop| hop.address.clone()) {
            Some(address) => Conclusion::LastResponder { address },
            None => Conclusion::NoReply,
        }
    }
    fn is_empty(&self) -> bool {
        self.hops.is_empty()
    }
}

/// How one run's lines are read and what it is shown as.
#[derive(Clone, Copy)]
struct Tool {
    method: Method,
    parse: fn(&str, Option<&str>) -> Line,
}
const TCP_TOOL: Tool = Tool {
    method: Method::TcpPort,
    parse: trace_parse::traceroute,
};
const UDP_TOOL: Tool = Tool {
    method: Method::Udp,
    parse: trace_parse::traceroute,
};
const TRACEPATH_TOOL: Tool = Tool {
    method: Method::Tracepath,
    parse: trace_parse::tracepath,
};

struct Tracer {
    events: EventSink,
    cancel: CancelSignal,
    route: Mutex<Route>,
    destination: Mutex<Option<String>>,
    name_failed: Mutex<bool>,
}
impl Tracer {
    fn send(&self, event: Event) {
        if (self.events)(event).is_err() {
            self.cancel.send_replace(true);
        }
    }
    fn hop(&self, hop: Hop, method: Method) {
        let (first, merged) = {
            let mut route = self.route.lock().unwrap();
            (route.is_empty(), route.add(hop))
        };
        if first {
            self.send(Event::Method { method });
        }
        self.send(Event::Hop { hop: merged });
    }
    fn line(&self, tool: Tool, line: &str) {
        if trace_parse::is_name_failure(line) {
            *self.name_failed.lock().unwrap() = true;
        }
        let destination = self.destination.lock().unwrap().clone();
        match (tool.parse)(line, destination.as_deref()) {
            Line::Destination(address) => *self.destination.lock().unwrap() = Some(address),
            Line::Hop(hop) => self.hop(hop, tool.method),
            Line::Other => {}
        }
    }
    fn has_hops(&self) -> bool {
        !self.route.lock().unwrap().is_empty()
    }
    fn name_failed(&self) -> bool {
        *self.name_failed.lock().unwrap()
    }
    fn conclusion(&self) -> Conclusion {
        self.route.lock().unwrap().conclusion()
    }
}

struct Ending {
    conclusion: Conclusion,
    note: Option<String>,
}

fn failed(message: impl Into<String>) -> Ending {
    Ending {
        conclusion: Conclusion::Failed {
            message: message.into(),
        },
        note: None,
    }
}

const fn unavailable() -> Ending {
    Ending {
        conclusion: Conclusion::Unavailable,
        note: None,
    }
}

#[derive(Debug, PartialEq, Eq)]
struct Tools {
    root: bool,
    traceroute: bool,
    tracepath: bool,
}

fn read_tools(output: &str) -> Tools {
    let mut lines = output.lines().map(str::trim);
    let root = lines.next() == Some("0");
    let found: Vec<&str> = lines.collect();
    Tools {
        root,
        traceroute: found.contains(&"traceroute"),
        tracepath: found.contains(&"tracepath"),
    }
}

/// Root may be able to send TCP. BusyBox has no `-T` and an unprivileged BusyBox `traceroute`
/// cannot open its socket; neither prints a hop, and that moves on to the next one (TL.0).
fn plan(tools: &Tools) -> Vec<Tool> {
    let mut list = Vec::new();
    if tools.traceroute {
        if tools.root {
            list.push(TCP_TOOL);
        }
        list.push(UDP_TOOL);
    }
    if tools.tracepath {
        list.push(TRACEPATH_TOOL);
    }
    list
}

fn script(method: Method, host: &str, port: u16) -> String {
    let host = remote_exec::quote(host);
    let probes = format!("-n -q 2 -w 1 -m {MAX_HOPS}");
    // The tools write their header to stderr on some systems, so it joins stdout here.
    match method {
        Method::TcpPort => format!("{PATH}traceroute -T {probes} -p {port} {host} 2>&1\n"),
        Method::Tracepath => format!("{PATH}tracepath -n {host} 2>&1\n"),
        Method::Udp | Method::Icmp => format!("{PATH}traceroute {probes} {host} 2>&1\n"),
    }
}

const DETECT: &str = "export LC_ALL=C PATH=\"$PATH:/usr/sbin:/sbin\"\n\
    id -u\n\
    command -v traceroute >/dev/null 2>&1 && echo traceroute\n\
    command -v tracepath >/dev/null 2>&1 && echo tracepath\n\
    true\n";

fn partial(result: std::result::Result<(), Failure>) -> Option<String> {
    match result {
        Ok(()) => None,
        Err(Failure::TimedOut) => Some(CUT_OFF.to_string()),
        Err(Failure::TooLarge) => Some(TOO_LONG.to_string()),
        Err(Failure::Other(message)) => Some(message),
    }
}

async fn remote(tracer: &Tracer, handle: &client::Handle<Host>, host: &str, port: u16) -> Ending {
    let limits = Limits {
        timeout: Duration::from_secs(5),
        ..LIMITS
    };
    let output = match remote_exec::run(handle, DETECT, limits).await {
        Ok(output) => output,
        Err(failure) => return failed(String::from(failure)),
    };
    let tools = read_tools(&String::from_utf8_lossy(&output.stdout));
    for tool in plan(&tools) {
        let result =
            remote_exec::run_lines(handle, &script(tool.method, host, port), LIMITS, |line| {
                tracer.line(tool, line);
            })
            .await;
        if tracer.has_hops() {
            return Ending {
                conclusion: tracer.conclusion(),
                note: partial(result),
            };
        }
        if tracer.name_failed() {
            return failed("서버에서 이름을 해석하지 못했습니다.");
        }
        match result {
            Ok(()) => {}
            Err(failure @ (Failure::TimedOut | Failure::Other(_))) => {
                return failed(String::from(failure));
            }
            // A tool that only printed too much has no hop to show either; the next may do better.
            Err(Failure::TooLarge) => {}
        }
    }
    unavailable()
}

#[cfg(windows)]
async fn local(tracer: Arc<Tracer>, host: &str, _port: u16) -> Ending {
    let addresses = match tokio::net::lookup_host((host, 0)).await {
        Ok(addresses) => addresses.map(|address| address.ip()).collect::<Vec<_>>(),
        Err(_) => return failed("이름을 해석하지 못했습니다."),
    };
    let Some(destination) = addresses.iter().find_map(|address| match address {
        IpAddr::V4(address) => Some(*address),
        IpAddr::V6(_) => None,
    }) else {
        return failed("이 PC의 경로 추적은 IPv4 대상만 지원합니다.");
    };
    let cancel = tracer.cancel.subscribe();
    let worker = tracer.clone();
    let done = tokio::task::spawn_blocking(move || {
        super::trace_windows::trace(destination, MAX_HOPS, cancel, |hop| {
            worker.hop(hop, Method::Icmp);
        })
    })
    .await;
    match done {
        Ok(Ok(())) => Ending {
            conclusion: tracer.conclusion(),
            note: None,
        },
        Ok(Err(message)) => failed(message),
        Err(_) => failed("경로 추적을 끝내지 못했습니다."),
    }
}

/// By absolute path: an app started from Finder has only the system `PATH`.
#[cfg(target_os = "macos")]
async fn local(tracer: Arc<Tracer>, host: &str, port: u16) -> Ending {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let quoted = remote_exec::quote(host);
    let probes = format!("-n -q 2 -w 1 -m {MAX_HOPS}");
    // TCP needs privileges some Macs may not grant, so it is tried first and falls back (TL.0).
    let attempts = [
        (
            TCP_TOOL,
            format!("exec /usr/sbin/traceroute {probes} -P tcp -p {port} {quoted} 2>&1"),
        ),
        (
            UDP_TOOL,
            format!("exec /usr/sbin/traceroute {probes} {quoted} 2>&1"),
        ),
    ];
    for (tool, command) in attempts {
        let child = tokio::process::Command::new("/bin/sh")
            .args(["-c", &command])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn();
        let Ok(mut child) = child else {
            return failed("경로 추적을 시작하지 못했습니다.");
        };
        let Some(stdout) = child.stdout.take() else {
            return failed("경로 추적을 시작하지 못했습니다.");
        };
        let mut lines = BufReader::new(stdout).lines();
        let read = tokio::time::timeout(LIMITS.timeout, async {
            while let Ok(Some(line)) = lines.next_line().await {
                tracer.line(tool, &line);
            }
        })
        .await;
        if tracer.has_hops() {
            return Ending {
                conclusion: tracer.conclusion(),
                note: read.is_err().then(|| CUT_OFF.to_string()),
            };
        }
        if tracer.name_failed() {
            return failed("이름을 해석하지 못했습니다.");
        }
    }
    unavailable()
}

/// Validates the target and starts. Everything after this arrives as events.
pub fn start(connections: Arc<Connections>, request: Request) -> Result<()> {
    let Request {
        source,
        host,
        port,
        job_id,
        events,
    } = request;
    let host = targets::single_host(host.trim())?;
    if port == 0 {
        return Err("포트는 1~65535 사이여야 합니다.".into());
    }
    let handle = match source {
        SourceArg::Local => None,
        SourceArg::Remote { connection_id } => {
            Some(connections.net.handle(&connections, &connection_id)?)
        }
    };
    let (cancel, guard) = connections.net.jobs.begin(&connections, job_id)?;
    let literal = host
        .parse::<IpAddr>()
        .ok()
        .map(|address| address.to_string());
    let tracer = Arc::new(Tracer {
        events,
        cancel: cancel.clone(),
        route: Mutex::default(),
        destination: Mutex::new(literal),
        name_failed: Mutex::new(false),
    });
    tokio::spawn(async move {
        let mut stopped = cancel.subscribe();
        let ending = tokio::select! {
            biased;
            _ = stopped.wait_for(|stop| *stop) => None,
            ending = async {
                match &handle {
                    Some(handle) => remote(&tracer, handle, &host, port).await,
                    None => local(tracer.clone(), &host, port).await,
                }
            } => Some(ending),
        };
        let (cancelled, conclusion, note) = match ending {
            Some(ending) => (false, Some(ending.conclusion), ending.note),
            None => (true, None, None),
        };
        tracer.send(Event::Finished {
            cancelled,
            conclusion,
            note,
        });
        drop(guard);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hop(hop: u8, address: Option<&str>, reached: bool) -> Hop {
        Hop {
            hop,
            address: address.map(str::to_string),
            rtt_ms: None,
            reached,
            unreachable: false,
        }
    }

    fn route(hops: Vec<Hop>) -> Route {
        let mut route = Route::default();
        for item in hops {
            route.add(item);
        }
        route
    }

    #[test]
    fn the_conclusion_names_only_the_last_device_that_replied() {
        assert_eq!(
            route(vec![
                hop(1, Some("10.0.0.1"), false),
                hop(2, Some("10.0.1.1"), false),
                hop(3, None, false),
                hop(4, None, false),
            ])
            .conclusion(),
            Conclusion::LastResponder {
                address: "10.0.1.1".into()
            }
        );
    }

    #[test]
    fn reaching_the_target_and_hearing_nothing_are_their_own_conclusions() {
        assert_eq!(
            route(vec![hop(1, Some("10.0.0.5"), true)]).conclusion(),
            Conclusion::Reached
        );
        assert_eq!(
            route(vec![hop(1, None, false)]).conclusion(),
            Conclusion::NoReply
        );
        assert_eq!(Route::default().conclusion(), Conclusion::NoReply);
    }

    #[test]
    fn a_repeated_hop_keeps_the_device_that_was_named() {
        let mut route = Route::default();
        route.add(hop(1, None, false));
        let merged = route.add(hop(1, Some("10.0.0.1"), false));
        assert_eq!(merged.address.as_deref(), Some("10.0.0.1"));
        let kept = route.add(hop(1, None, false));
        assert_eq!(kept.address.as_deref(), Some("10.0.0.1"));
        assert_eq!(route.hops.len(), 1);
    }

    #[test]
    fn root_tries_tcp_and_everyone_falls_back_in_order() {
        let order = |root, traceroute, tracepath| {
            plan(&Tools {
                root,
                traceroute,
                tracepath,
            })
            .iter()
            .map(|tool| tool.method)
            .collect::<Vec<_>>()
        };
        assert_eq!(
            order(true, true, true),
            [Method::TcpPort, Method::Udp, Method::Tracepath]
        );
        assert_eq!(order(false, true, true), [Method::Udp, Method::Tracepath]);
        assert_eq!(order(false, false, true), [Method::Tracepath]);
        assert_eq!(order(true, false, false), []);
    }

    #[test]
    fn what_a_server_has_is_read_from_fixed_lines() {
        assert_eq!(
            read_tools("0\ntraceroute\ntracepath\n"),
            Tools {
                root: true,
                traceroute: true,
                tracepath: true
            }
        );
        assert_eq!(
            read_tools("1000\ntracepath\n"),
            Tools {
                root: false,
                traceroute: false,
                tracepath: true
            }
        );
        assert_eq!(
            read_tools(""),
            Tools {
                root: false,
                traceroute: false,
                tracepath: false
            }
        );
    }

    #[test]
    fn the_target_is_quoted_and_the_commands_are_fixed() {
        assert_eq!(
            script(Method::TcpPort, "db.example", 5432),
            format!("{PATH}traceroute -T -n -q 2 -w 1 -m 30 -p 5432 'db.example' 2>&1\n")
        );
        assert_eq!(
            script(Method::Udp, "10.0.0.5", 1),
            format!("{PATH}traceroute -n -q 2 -w 1 -m 30 '10.0.0.5' 2>&1\n")
        );
        assert_eq!(
            script(Method::Tracepath, "10.0.0.5", 1),
            format!("{PATH}tracepath -n '10.0.0.5' 2>&1\n")
        );
    }

    #[test]
    fn only_a_validated_host_reaches_the_script() {
        for bad in ["-T", "a;id", "$(id)", "a b", ""] {
            assert!(targets::single_host(bad).is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn an_invalid_target_is_refused_before_anything_starts() {
        let connections = Arc::new(Connections::default());
        let events: EventSink = Arc::new(|_| Ok(()));
        let result = start(
            connections,
            Request {
                source: SourceArg::Local,
                host: "a;id".into(),
                port: 22,
                job_id: "x".into(),
                events,
            },
        );
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn cancelling_ends_with_no_conclusion() {
        let connections = Arc::new(Connections::default());
        let (sender, mut received) = tokio::sync::mpsc::unbounded_channel();
        let events: EventSink = Arc::new(move |event| {
            let _ = sender.send(event);
            Ok(())
        });
        start(
            connections.clone(),
            Request {
                source: SourceArg::Local,
                host: "192.0.2.1".into(),
                port: 22,
                job_id: "trace".into(),
                events,
            },
        )
        .unwrap();
        connections.net.jobs.cancel("trace");
        let finished = loop {
            match received.recv().await.expect("the job always finishes") {
                Event::Finished {
                    cancelled,
                    conclusion,
                    ..
                } => break (cancelled, conclusion),
                _ => continue,
            }
        };
        assert_eq!(finished, (true, None));
    }
}
