//! `kube_log_stream`: follows several containers' logs at once for the live log board. All of them
//! share one SSH channel, because `MaxSessions` (default 10) is also spent on the shell, SFTP and
//! every other tab, and a board can follow 20 pods. Log text stays in memory (design §6).
mod local;

use super::{
    log_search::STATUS,
    logs::clean,
    runner::{Failed, Kubectl, Link},
    settings::{KubeSettings, check_container, check_namespace, check_pod, is_log_time},
    state::{KubeState, classify},
};
use crate::{
    remote_exec::{Limits, quote},
    storage::Result,
};
use serde::{Deserialize, Serialize};
use std::{
    ops::ControlFlow,
    time::{Duration, Instant},
};
use tauri::ipc::Channel;
use tokio::sync::watch;

/// Every source is one kubectl process on the server and one request on the API server.
const MAX_SOURCES: usize = 20;
const MAX_TAIL: u32 = 2000;
const MAX_FILTER_CHARS: usize = 200;
/// What `substr` keeps of a line on a server (`PREFIX_LINES`), and a local stream the same.
const MAX_LINE_BYTES: usize = 3800;
/// A board left open overnight should not follow forever.
const LIMITS: Limits = Limits {
    timeout: Duration::from_secs(12 * 60 * 60),
    max_output: 1024 * 1024,
};
/// One very chatty pod must not bury the screen or the IPC channel.
const MAX_LINES_PER_SECOND: usize = 3000;

/// Writes one prefixed line per log line. A line under `PIPE_BUF` (4096) written in one call stays
/// whole, so the sources sharing stdout cannot interleave inside a line: the newline is part of the
/// one `%s`, because mawk's unbuffered output writes each piece of a `print` separately.
/// `LC_ALL=C` makes `substr` count bytes. Anything that is not a timestamped log line is kubectl's
/// own message and always passes.
const PREFIX_LINES: &str = r#"{ if ($0 !~ /^[0-9][0-9][0-9][0-9]-/ || ENVIRON["DACHSTERM_FILTER"] == "" || index($0, ENVIRON["DACHSTERM_FILTER"])) { printf "%s", id " " substr($0, 1, 3800) "\n"; fflush() } }"#;

/// mawk, the default awk on Debian and Ubuntu, fills a block from a pipe before it reads a line, so
/// a quiet pod shows nothing for minutes without this. Other awks do not know the option.
const CHOOSE_AWK: &str =
    "a=awk\ncase \"$(awk -W version 2>&1 </dev/null)\" in *mawk*) a='awk -W interactive';; esac\n";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamSource {
    namespace: String,
    pod: String,
    container: String,
    tail: u32,
    /// Continue from this time instead of the last `tail` lines, after the board's pods changed.
    since: Option<String>,
    /// Only lines containing this text, applied on the server to save the SSH traffic.
    filter: Option<String>,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamLine {
    source: usize,
    time: String,
    text: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    /// The stream can now be cancelled.
    Started,
    Lines {
        lines: Vec<StreamLine>,
        dropped: usize,
    },
    SourceEnded {
        source: usize,
        state: KubeState,
    },
    Finished {
        state: KubeState,
    },
}

pub fn check(sources: &[StreamSource]) -> Result<()> {
    if sources.is_empty() {
        return Err("따라갈 파드가 없습니다.".into());
    }
    if sources.len() > MAX_SOURCES {
        return Err(format!("한 번에 {MAX_SOURCES}개까지 따라갈 수 있습니다."));
    }
    for source in sources {
        if source.namespace.is_empty() {
            return Err("파드의 namespace가 필요합니다.".into());
        }
        check_namespace(&source.namespace)?;
        check_pod(&source.pod)?;
        check_container(&source.container)?;
        if source
            .since
            .as_deref()
            .is_some_and(|time| !is_log_time(time))
        {
            return Err("잘못된 로그 시각입니다.".into());
        }
        let filter = source.filter.as_deref().unwrap_or_default();
        if filter.chars().count() > MAX_FILTER_CHARS || filter.chars().any(char::is_control) {
            return Err("잘못된 로그 필터입니다.".into());
        }
    }
    Ok(())
}

fn logs_line(kube: &KubeSettings, source: &StreamSource) -> String {
    let range = match &source.since {
        Some(time) => format!("--since-time={}", quote(time)),
        None => format!("--tail={}", source.tail.min(MAX_TAIL)),
    };
    Kubectl {
        command: &kube.kubectl,
        kubeconfig: &kube.kubeconfig,
    }
    .streaming(
        &kube.context,
        &format!(
            "logs -f {} -n {} -c {} {range} --timestamps",
            quote(&source.pod),
            quote(&source.namespace),
            quote(&source.container),
        ),
    )
}

/// One backgrounded `kubectl logs -f`. With no PTY nothing tells kubectl that the channel closed, so
/// a watcher reads this channel's stdin, which ends at that moment, and stops kubectl (KV.5).
fn source_script(kube: &KubeSettings, index: usize, source: &StreamSource) -> String {
    let logs = logs_line(kube, source);
    format!(
        "( {{ {logs} 2>&1 & k=$!; ( cat <&3 >/dev/null 2>&1; kill \"$k\" 2>/dev/null ) \
         >/dev/null 2>&1 & w=$!; wait \"$k\"; s=$?; kill \"$w\" 2>/dev/null; \
         printf '\\n{STATUS} %s\\n' \"$s\"; }} | DACHSTERM_FILTER={filter} LC_ALL=C $a -v id={index} \
         {program} ) &\n",
        filter = quote(source.filter.as_deref().unwrap_or_default()),
        program = quote(PREFIX_LINES),
    )
}

fn stream_script(kube: &KubeSettings, sources: &[StreamSource]) -> String {
    let body: String = sources
        .iter()
        .enumerate()
        .map(|(index, source)| source_script(kube, index, source))
        .collect();
    format!("exec 3<&0\n{CHOOSE_AWK}{body}wait\n")
}

#[derive(Default, Debug, PartialEq)]
struct Parsed {
    lines: Vec<StreamLine>,
    ended: Vec<(usize, KubeState)>,
}

struct Reader {
    pending: Vec<u8>,
    /// What each kubectl said that was not a log line, for the state it ends with.
    notes: Vec<Vec<u8>>,
}

impl Reader {
    fn new(sources: usize) -> Self {
        Self {
            pending: Vec::new(),
            notes: vec![Vec::new(); sources],
        }
    }

    fn push(&mut self, piece: &[u8]) -> Parsed {
        let mut parsed = Parsed::default();
        self.pending.extend_from_slice(piece);
        let Some(last) = self.pending.iter().rposition(|byte| *byte == b'\n') else {
            return parsed;
        };
        let rest = self.pending.split_off(last + 1);
        let complete = std::mem::replace(&mut self.pending, rest);
        for line in complete.split(|byte| *byte == b'\n') {
            self.line(line, &mut parsed);
        }
        parsed
    }

    fn line(&mut self, line: &[u8], parsed: &mut Parsed) {
        let Some(space) = line.iter().position(|byte| *byte == b' ') else {
            return;
        };
        let Some(source) = std::str::from_utf8(&line[..space])
            .ok()
            .and_then(|text| text.parse::<usize>().ok())
            .filter(|source| *source < self.notes.len())
        else {
            return;
        };
        let rest = &line[space + 1..];
        if let Some(code) = rest.strip_prefix(STATUS.as_bytes()) {
            let exit = std::str::from_utf8(code)
                .ok()
                .and_then(|text| text.trim().parse::<u32>().ok());
            parsed
                .ended
                .push((source, classify(exit, &self.notes[source])));
            return;
        }
        let split = rest.iter().position(|byte| *byte == b' ');
        let time = split
            .and_then(|at| std::str::from_utf8(&rest[..at]).ok())
            .filter(|time| is_log_time(time));
        match (time, split) {
            (Some(time), Some(at)) => parsed.lines.push(StreamLine {
                source,
                time: time.to_string(),
                text: clean(&rest[at + 1..]),
            }),
            _ if !rest.is_empty() && self.notes[source].len() < 4096 => {
                self.notes[source].extend_from_slice(rest);
                self.notes[source].push(b'\n');
            }
            _ => {}
        }
    }
}

struct Limiter {
    window: Instant,
    used: usize,
}

impl Limiter {
    /// The lines this second still has room for, and how many were left out.
    fn admit(&mut self, mut lines: Vec<StreamLine>, now: Instant) -> (Vec<StreamLine>, usize) {
        if now.duration_since(self.window) >= Duration::from_secs(1) {
            self.window = now;
            self.used = 0;
        }
        let room = MAX_LINES_PER_SECOND.saturating_sub(self.used);
        let dropped = lines.len().saturating_sub(room);
        lines.truncate(room);
        self.used += lines.len();
        (lines, dropped)
    }
}

/// `false` means the screen is gone and the stream should stop.
fn deliver(channel: &Channel<Event>, parsed: Parsed, limiter: &mut Limiter) -> bool {
    let Parsed { lines, ended } = parsed;
    let (lines, dropped) = limiter.admit(lines, Instant::now());
    if (!lines.is_empty() || dropped > 0) && channel.send(Event::Lines { lines, dropped }).is_err()
    {
        return false;
    }
    ended
        .into_iter()
        .all(|(source, state)| channel.send(Event::SourceEnded { source, state }).is_ok())
}

/// Ends when every source has ended, the connection drops or the board cancels. Dropping the
/// stream's future closes its channel, which is what stops kubectl on the server.
pub async fn run(
    link: Link,
    kube: KubeSettings,
    sources: Vec<StreamSource>,
    channel: Channel<Event>,
    mut cancel: watch::Receiver<bool>,
) {
    if channel.send(Event::Started).is_err() {
        return;
    }
    let runner = link.runner(&kube);
    let mut reader = Reader::new(sources.len());
    let mut limiter = Limiter {
        window: Instant::now(),
        used: 0,
    };
    let on_piece = |piece: &[u8]| {
        if deliver(&channel, reader.push(piece), &mut limiter) {
            ControlFlow::Continue(())
        } else {
            ControlFlow::Break(())
        }
    };
    let work = async {
        if runner.is_local() {
            local::follow(&kube, &sources, LIMITS, on_piece).await
        } else {
            let script = stream_script(&kube, &sources);
            runner.stream(&script, LIMITS, on_piece).await
        }
    };
    let result = tokio::select! {
        result = work => Some(result),
        _ = cancel.changed() => None,
    };
    let state = match result {
        None | Some(Ok(_)) => KubeState::Ready,
        Some(Err(failed @ (Failed::ChannelLimit | Failed::Stopped(_)))) => failed.into_state(),
    };
    let _ = channel.send(Event::Finished { state });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> KubeSettings {
        KubeSettings {
            context: "kind-x".into(),
            namespace: String::new(),
            kubectl: "/opt/kubectl".into(),
            kubeconfig: String::new(),
            operate: false,
        }
    }

    fn source(pod: &str) -> StreamSource {
        StreamSource {
            namespace: "web".into(),
            pod: pod.into(),
            container: "app".into(),
            tail: 100,
            since: None,
            filter: None,
        }
    }

    const TIME: &str = "2026-11-08T12:00:00.123456789Z";

    #[test]
    fn one_script_follows_every_source_and_never_times_out_the_stream() {
        let script = stream_script(&settings(), &[source("api-1"), source("api-2")]);
        assert!(script.starts_with("exec 3<&0\n"), "{script}");
        assert!(script.ends_with("wait\n"), "{script}");
        assert!(script.contains("awk -W interactive"), "{script}");
        assert!(script.contains("LC_ALL=C $a -v id=0"), "{script}");
        assert!(script.contains("logs -f 'api-1' -n 'web' -c 'app' --tail=100 --timestamps"));
        assert!(script.contains("logs -f 'api-2'"), "{script}");
        assert!(script.contains("-v id=1"), "{script}");
        assert!(!script.contains("request-timeout"), "{script}");
    }

    #[test]
    fn continuing_reads_from_the_last_time_and_the_tail_is_bounded() {
        let later = StreamSource {
            since: Some(TIME.into()),
            ..source("api-1")
        };
        let line = source_script(&settings(), 0, &later);
        assert!(line.contains(&format!("--since-time='{TIME}'")), "{line}");
        assert!(!line.contains("--tail"), "{line}");
        let huge = StreamSource {
            tail: u32::MAX,
            ..source("api-1")
        };
        assert!(source_script(&settings(), 0, &huge).contains("--tail=2000 "));
    }

    #[test]
    fn a_filter_reaches_the_server_only_as_quoted_text() {
        let filtered = StreamSource {
            filter: Some("[web-api-80]'; reboot".into()),
            ..source("api-1")
        };
        let line = source_script(&settings(), 0, &filtered);
        assert!(
            line.contains(r#"DACHSTERM_FILTER='[web-api-80]'\''; reboot'"#),
            "{line}"
        );
    }

    #[test]
    fn checks_names_times_filters_and_the_source_limit() {
        assert!(check(&[source("api-1")]).is_ok());
        assert!(check(&[]).is_err());
        assert!(check(&[source("$(reboot)")]).is_err());
        let many: Vec<StreamSource> = (0..=MAX_SOURCES)
            .map(|n| source(&format!("p{n}")))
            .collect();
        assert!(check(&many).is_err());
        let bad_time = StreamSource {
            since: Some("yesterday".into()),
            ..source("api-1")
        };
        assert!(check(&[bad_time]).is_err());
        let bad_filter = StreamSource {
            filter: Some("a\nb".into()),
            ..source("api-1")
        };
        assert!(check(&[bad_filter]).is_err());
    }

    #[test]
    fn lines_survive_being_split_across_pieces() {
        let mut reader = Reader::new(2);
        let line = format!("1 {TIME} hello world\n");
        let (head, tail) = line.as_bytes().split_at(10);
        assert_eq!(reader.push(head), Parsed::default());
        assert_eq!(
            reader.push(tail).lines,
            [StreamLine {
                source: 1,
                time: TIME.into(),
                text: "hello world".into(),
            }]
        );
    }

    #[test]
    fn kubectl_messages_explain_how_a_source_ended() {
        let mut reader = Reader::new(1);
        let parsed = reader.push(
            format!("0 Error from server (Forbidden): pods is forbidden\n0 \n0 {STATUS} 1\n")
                .as_bytes(),
        );
        assert!(parsed.lines.is_empty());
        assert_eq!(parsed.ended.len(), 1);
        assert_ne!(parsed.ended[0].1, KubeState::Ready);
    }

    #[test]
    fn a_container_that_finished_cleanly_is_not_an_error() {
        let mut reader = Reader::new(1);
        let parsed = reader.push(format!("0 {STATUS} 0\n").as_bytes());
        assert_eq!(parsed.ended, [(0, KubeState::Ready)]);
    }

    #[test]
    fn lines_for_an_unknown_source_and_terminal_sequences_do_not_reach_the_screen() {
        let mut reader = Reader::new(1);
        let parsed =
            reader.push(format!("7 {TIME} ghost\n0 {TIME} \x1b[31mred\x1b[0m\n").as_bytes());
        assert_eq!(parsed.lines.len(), 1);
        assert_eq!(parsed.lines[0].text, "red");
    }

    #[test]
    fn a_flood_is_cut_within_the_second_and_the_next_second_has_room() {
        let start = Instant::now();
        let mut limiter = Limiter {
            window: start,
            used: 0,
        };
        let lines = |count: usize| {
            (0..count)
                .map(|_| StreamLine {
                    source: 0,
                    time: TIME.into(),
                    text: String::new(),
                })
                .collect::<Vec<_>>()
        };
        let (kept, dropped) = limiter.admit(lines(MAX_LINES_PER_SECOND + 5), start);
        assert_eq!((kept.len(), dropped), (MAX_LINES_PER_SECOND, 5));
        let (kept, dropped) = limiter.admit(lines(1), start);
        assert_eq!((kept.len(), dropped), (0, 1));
        let (kept, dropped) = limiter.admit(lines(1), start + Duration::from_secs(1));
        assert_eq!((kept.len(), dropped), (1, 0));
    }

    /// The real script, shell, kubectl and API server, on the fixture's jump host. `docker exec -i`
    /// stands in for the SSH channel: closing either ends the script's stdin the same way.
    #[cfg(unix)]
    #[test]
    #[ignore = "needs scripts/kube-fixture.sh; run with npm run test:kube-stream"]
    fn real_cluster_streams_every_source_and_stops_when_the_channel_closes() {
        use std::{
            io::Read,
            process::{Command, Stdio},
            sync::{Arc, Mutex},
            thread::sleep,
        };
        let cluster = std::env::var("DACHSTERM_KUBE_FIXTURE").unwrap_or_else(|_| "kv13".into());
        let host = format!("{cluster}-ssh");
        let kube = KubeSettings {
            context: format!("kind-{cluster}"),
            namespace: String::new(),
            kubectl: "/opt/kube/bin/kubectl".into(),
            kubeconfig: "/opt/kube/config".into(),
            operate: false,
        };
        let on_host = |script: &str| {
            let output = Command::new("docker")
                .args(["exec", &host, "sh", "-c", script])
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        let kubectl = format!(
            "/opt/kube/bin/kubectl --kubeconfig /opt/kube/config --context kind-{cluster} -n default"
        );
        const LOOP: &str = "i=0; while :; do if [ $((i%2)) = 0 ]; then k=even; else k=odd; fi; echo \"$(hostname) $k $i\"; i=$((i+1)); sleep 0.2; done";
        on_host(&format!(
            "{kubectl} delete pod stream-a stream-b --ignore-not-found --now"
        ));
        for pod in ["stream-a", "stream-b"] {
            on_host(&format!(
                "{kubectl} run {pod} --image=busybox:1.36 --restart=Never --command -- sh -c '{LOOP}'; \
                 {kubectl} wait --for=condition=Ready pod/{pod} --timeout=120s"
            ));
        }
        let of = |pod: &str, filter: Option<&str>| StreamSource {
            namespace: "default".into(),
            pod: pod.into(),
            container: pod.into(),
            tail: 5,
            since: None,
            filter: filter.map(String::from),
        };
        let sources = [
            of("stream-a", None),
            of("stream-b", Some("even")),
            of("no-such-pod", None),
        ];
        let mut child = Command::new("docker")
            .args([
                "exec",
                "-i",
                &host,
                "sh",
                "-c",
                &stream_script(&kube, &sources),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let seen = Arc::new(Mutex::new(Parsed::default()));
        let collected = seen.clone();
        let reading = std::thread::spawn(move || {
            let mut reader = Reader::new(3);
            let mut piece = [0; 8192];
            while let Ok(count) = stdout.read(&mut piece) {
                if count == 0 {
                    break;
                }
                let parsed = reader.push(&piece[..count]);
                let mut all = collected.lock().unwrap();
                all.lines.extend(parsed.lines);
                all.ended.extend(parsed.ended);
            }
        });
        sleep(Duration::from_secs(5));
        let count_kubectl =
            "for p in /proc/[0-9]*; do cat $p/comm 2>/dev/null; done | grep -c '^kubectl$'";
        let running: u32 = on_host(count_kubectl).parse().unwrap();
        {
            let all = seen.lock().unwrap();
            let of_source = |source: usize| {
                all.lines
                    .iter()
                    .filter(|line| line.source == source)
                    .collect::<Vec<_>>()
            };
            let (first, second) = (of_source(0), of_source(1));
            assert!(first.len() >= 5, "stream-a gave {} lines", first.len());
            assert!(first.iter().all(|line| line.text.starts_with("stream-a ")));
            assert!(second.len() >= 3, "stream-b gave {} lines", second.len());
            assert!(second.iter().all(|line| line.text.contains(" even ")));
            assert!(of_source(2).is_empty());
            let missing: Vec<_> = all.ended.iter().filter(|(s, _)| *s == 2).collect();
            assert_eq!(missing.len(), 1, "{:?}", all.ended);
            assert_ne!(missing[0].1, KubeState::Ready);
            assert!(all.ended.iter().all(|(source, _)| *source == 2));
        }
        assert_eq!(
            running, 2,
            "only the two live pods should still be followed"
        );

        drop(stdin);
        let closed = Instant::now();
        while child.try_wait().unwrap().is_none() {
            assert!(
                closed.elapsed() < Duration::from_secs(15),
                "script kept running"
            );
            sleep(Duration::from_millis(100));
        }
        reading.join().unwrap();
        sleep(Duration::from_secs(1));
        let left = on_host(count_kubectl);
        on_host(&format!(
            "{kubectl} delete pod stream-a stream-b --now --wait=false"
        ));
        assert_eq!(left, "0", "kubectl left running on the server");
    }
}
