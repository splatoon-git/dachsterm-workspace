//! `kube_probe`: a fixed read-only script run inside a container (design KV.9, path B). It reads
//! `/proc` and writes nothing, and no other command can come through here. The output comes from
//! inside the container, so every field is bounded, and a line that does not parse is dropped.
use super::{
    runner::{Kubectl, Runner},
    settings::KubeSettings,
    snapshot::{fields, records, shown},
    state::{KubeState, ShellCheck, classify_shell},
};
use crate::remote_exec::{Limits, quote};
use serde::Serialize;
use std::time::Duration;

const LIMITS: Limits = Limits {
    timeout: Duration::from_secs(5),
    max_output: 1024 * 1024,
};
const REQUEST_SECONDS: u32 = 4;
const MAX_PROCESSES: usize = 2000;
const MAX_LISTEN_PORTS: usize = 64;
const MAX_NAME: usize = 64;
/// The kernel's USER_HZ: fixed at 100 for the `starttime` field on every Linux architecture in use.
const TICKS_PER_SECOND: u64 = 100;

/// Only the shell and its builtins, so an image with `sh` and nothing else still answers. A
/// command line is read only for nginx, and only to tell master from worker; it never leaves.
const SCRIPT: &str = r#"tab=$(printf '\t')
if read -r up x < /proc/uptime; then printf 'U\t%s\n' "$up"; fi
count=0
for dir in /proc/[0-9]*; do
  pid=${dir##*/}
  [ "$pid" = "$$" ] && continue
  [ -r "$dir/status" ] || continue
  count=$((count+1))
  if [ "$count" -gt 2000 ]; then echo T; break; fi
  name=; state=; threads=; role=; limit=; start=; fds=
  while IFS="$tab" read -r key val; do
    case $key in
      Name:) name=$val ;;
      State:) state=${val%% *} ;;
      Threads:) threads=$val; break ;;
    esac
  done < "$dir/status"
  if [ "$name" = nginx ]; then
    cmd=
    read -r cmd < "$dir/cmdline"
    case $cmd in *master*) role=master ;; *worker*) role=worker ;; esac
  fi
  set -- "$dir"/fd/*
  if [ "$1" != "$dir/fd/*" ]; then fds=$#; fi
  while read -r a b c soft rest; do
    if [ "$a $b $c" = "Max open files" ]; then limit=$soft; break; fi
  done < "$dir/limits"
  if read -r line < "$dir/stat"; then
    set -- ${line##*) }
    start=${20}
  fi
  printf 'P\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$pid" "$name" "$role" "$state" "$threads" "$fds" "$limit" "$start"
done 2>/dev/null
s1=0; s2=0; s3=0; s4=0; s5=0; s6=0; s7=0; s8=0; s9=0; sa=0; sb=0; listens=0
for file in /proc/net/tcp /proc/net/tcp6; do
  [ -r "$file" ] || continue
  while read -r slot local remote st queue rest; do
    case $st in
      01) s1=$((s1+1)) ;;
      02) s2=$((s2+1)) ;;
      03) s3=$((s3+1)) ;;
      04) s4=$((s4+1)) ;;
      05) s5=$((s5+1)) ;;
      06) s6=$((s6+1)) ;;
      07) s7=$((s7+1)) ;;
      08) s8=$((s8+1)) ;;
      09) s9=$((s9+1)) ;;
      0A)
        sa=$((sa+1))
        listens=$((listens+1))
        if [ "$listens" -le 512 ]; then printf 'L\t%s\t%s\n' "${local##*:}" "$queue"; fi
        ;;
      0B) sb=$((sb+1)) ;;
    esac
  done < "$file"
done 2>/dev/null
printf 'S\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$s1" "$s2" "$s3" "$s4" "$s5" "$s6" "$s7" "$s8" "$s9" "$sa" "$sb"
for file in /proc/net/netstat /proc/net/snmp; do
  [ -r "$file" ] || continue
  while read -r line; do
    case $line in TcpExt:*|Tcp:*) printf 'N\t%s\n' "$line" ;; esac
  done < "$file"
done 2>/dev/null
exit 0
"#;

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pid: u32,
    /// The process name; nginx is told apart as `nginx: master` and `nginx: worker`.
    name: String,
    state: String,
    threads: u32,
    /// `None` when this account cannot read another user's `/proc/<pid>/fd`.
    fds: Option<u32>,
    /// `None` for `unlimited`.
    fd_limit: Option<u64>,
    age_seconds: Option<u64>,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpStates {
    established: u32,
    syn_sent: u32,
    syn_recv: u32,
    fin_wait1: u32,
    fin_wait2: u32,
    time_wait: u32,
    close: u32,
    close_wait: u32,
    last_ack: u32,
    listen: u32,
    closing: u32,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListenPort {
    port: u16,
    /// The largest accept backlog among this port's sockets.
    backlog: u32,
    /// Connections waiting for `accept()` right now.
    queued: u32,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TcpCounters {
    listen_overflows: Option<u64>,
    listen_drops: Option<u64>,
    retransmitted: Option<u64>,
}

#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    processes: Vec<Process>,
    /// More processes than the script reports.
    truncated: bool,
    tcp: TcpStates,
    listen: Vec<ListenPort>,
    counters: TcpCounters,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProbeRead {
    Ready {
        runtime: Box<Runtime>,
        elapsed_ms: u64,
    },
    /// `sh` is not in this image.
    NoShell,
    NotRunning,
    /// Forbidden here means the account lacks `pods/exec`.
    Blocked {
        state: KubeState,
    },
}

fn parse_process(parts: [&str; 9], uptime: Option<f64>) -> Option<Process> {
    let [_, pid, name, role, state, threads, fds, limit, start] = parts;
    let pid: u32 = pid.parse().ok()?;
    let base = shown(name, MAX_NAME);
    let name = match role {
        "master" | "worker" => format!("{base}: {role}"),
        _ => base,
    };
    let age_seconds = uptime
        .zip(start.parse::<u64>().ok())
        .and_then(|(up, ticks)| {
            let age = up - (ticks / TICKS_PER_SECOND) as f64;
            (age >= 0.0).then_some(age as u64)
        });
    Some(Process {
        pid,
        name,
        state: shown(state, 4),
        threads: threads.parse().unwrap_or(0),
        fds: fds.parse().ok(),
        fd_limit: limit.parse().ok(),
        age_seconds,
    })
}

fn parse_states(parts: &[u32; 11]) -> TcpStates {
    let [
        established,
        syn_sent,
        syn_recv,
        fin_wait1,
        fin_wait2,
        time_wait,
        close,
        close_wait,
        last_ack,
        listen,
        closing,
    ] = *parts;
    TcpStates {
        established,
        syn_sent,
        syn_recv,
        fin_wait1,
        fin_wait2,
        time_wait,
        close,
        close_wait,
        last_ack,
        listen,
        closing,
    }
}

/// `TcpExt: name name ...` is followed by `TcpExt: value value ...`.
fn read_counters(lines: &[&str]) -> TcpCounters {
    let mut counters = TcpCounters::default();
    for [names, values] in lines.as_chunks::<2>().0 {
        let (Some((section, names)), Some((same, values))) =
            (names.split_once(':'), values.split_once(':'))
        else {
            continue;
        };
        if section != same {
            continue;
        }
        for (name, value) in names.split_whitespace().zip(values.split_whitespace()) {
            let slot = match (section, name) {
                ("TcpExt", "ListenOverflows") => &mut counters.listen_overflows,
                ("TcpExt", "ListenDrops") => &mut counters.listen_drops,
                ("Tcp", "RetransSegs") => &mut counters.retransmitted,
                _ => continue,
            };
            *slot = value.parse().ok();
        }
    }
    counters
}

/// `tx_queue:rx_queue` in hex, as `/proc/net/tcp` writes it. On a LISTEN socket `tx` is the accept
/// backlog and `rx` is how many connections are waiting for `accept()`.
fn parse_queue(queue: &str) -> Option<(u32, u32)> {
    let (backlog, queued) = queue.split_once(':')?;
    Some((
        u32::from_str_radix(backlog, 16).ok()?,
        u32::from_str_radix(queued, 16).ok()?,
    ))
}

fn merge_listen(ports: &mut Vec<ListenPort>, line: [&str; 3]) {
    let [_, port, queue] = line;
    let (Ok(port), Some((backlog, queued))) = (u16::from_str_radix(port, 16), parse_queue(queue))
    else {
        return;
    };
    if let Some(item) = ports.iter_mut().find(|item| item.port == port) {
        item.backlog = item.backlog.max(backlog);
        item.queued = item.queued.saturating_add(queued);
    } else if ports.len() < MAX_LISTEN_PORTS {
        ports.push(ListenPort {
            port,
            backlog,
            queued,
        });
    }
}

fn parse(text: &str) -> Runtime {
    let mut runtime = Runtime::default();
    let uptime = records(text)
        .find_map(|line| line.strip_prefix("U\t"))
        .and_then(|value| value.parse::<f64>().ok());
    let mut net_lines = Vec::new();
    for line in records(text) {
        let tag = line.split('\t').next().unwrap_or_default();
        match tag {
            "P" if runtime.processes.len() < MAX_PROCESSES => {
                if let Some(process) = fields::<9>(line).and_then(|p| parse_process(p, uptime)) {
                    runtime.processes.push(process);
                }
            }
            "T" => runtime.truncated = true,
            "L" => {
                if let Some(parts) = fields::<3>(line) {
                    merge_listen(&mut runtime.listen, parts);
                }
            }
            "S" => {
                let counts: Option<Vec<u32>> =
                    line.split('\t').skip(1).map(|v| v.parse().ok()).collect();
                if let Some(counts) = counts.and_then(|v| <[u32; 11]>::try_from(v).ok()) {
                    runtime.tcp = parse_states(&counts);
                }
            }
            "N" => net_lines.push(line.get(2..).unwrap_or_default()),
            _ => {}
        }
    }
    runtime.counters = read_counters(&net_lines);
    runtime.listen.sort_by_key(|item| item.port);
    runtime
}

pub async fn run(
    runner: &Runner<'_>,
    kube: &KubeSettings,
    namespace: &str,
    pod: &str,
    container: &str,
) -> ProbeRead {
    let started = std::time::Instant::now();
    let command = Kubectl {
        command: &kube.kubectl,
        kubeconfig: &kube.kubeconfig,
    }
    .cluster_within(
        &kube.context,
        REQUEST_SECONDS,
        &format!(
            "exec {} -n {} -c {} -- sh -c {}",
            quote(pod),
            quote(namespace),
            quote(container),
            quote(SCRIPT),
        ),
    );
    let output = match runner.script(&command, LIMITS).await {
        Ok(output) => output,
        Err(failed) => {
            return ProbeRead::Blocked {
                state: failed.into_state(),
            };
        }
    };
    match classify_shell(output.exit, &output.stderr) {
        ShellCheck::Ready => ProbeRead::Ready {
            runtime: Box::new(parse(&String::from_utf8_lossy(&output.stdout))),
            elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        },
        ShellCheck::NoShell => ProbeRead::NoShell,
        ShellCheck::NotRunning => ProbeRead::NotRunning,
        ShellCheck::Blocked { state } => ProbeRead::Blocked { state },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_script_writes_nothing_and_runs_no_programs() {
        let script = SCRIPT.replace("2>/dev/null", "");
        for needle in [
            ">/", "> /", "rm ", "kill", "curl", "wget", "$(cat", "eval", "`",
        ] {
            assert!(!script.contains(needle), "{needle}");
        }
        assert!(SCRIPT.contains(&format!("-gt {MAX_PROCESSES}")));
    }

    #[test]
    fn a_full_answer_is_read() {
        let text = "U\t1000.50\n\
            P\t1\tgunicorn\t\tS\t4\t12\t1024\t50000\n\
            P\t7\tnginx\tworker\tS\t1\t\tunlimited\t90000\n\
            P\t8\tnginx\tmaster\tS\t1\t3\t1024\t90000\n\
            L\t1F90\t00000080:00000002\n\
            L\t1F90\t00000020:00000001\n\
            L\t0050\t00000000:00000000\n\
            S\t10\t0\t2\t0\t0\t5\t0\t3\t0\t2\t0\n\
            N\tTcpExt: SyncookiesSent ListenOverflows ListenDrops\n\
            N\tTcpExt: 0 4 6\n\
            N\tTcp: RtoAlgorithm RetransSegs\n\
            N\tTcp: 1 21\n";
        let runtime = parse(text);
        assert_eq!(runtime.processes.len(), 3);
        assert_eq!(
            runtime.processes[0],
            Process {
                pid: 1,
                name: "gunicorn".into(),
                state: "S".into(),
                threads: 4,
                fds: Some(12),
                fd_limit: Some(1024),
                age_seconds: Some(500),
            }
        );
        assert_eq!(runtime.processes[1].name, "nginx: worker");
        assert_eq!(runtime.processes[1].fds, None);
        assert_eq!(runtime.processes[1].fd_limit, None);
        assert_eq!(runtime.processes[2].name, "nginx: master");
        assert_eq!(runtime.tcp.established, 10);
        assert_eq!(runtime.tcp.syn_recv, 2);
        assert_eq!(runtime.tcp.time_wait, 5);
        assert_eq!(runtime.tcp.close_wait, 3);
        assert_eq!(runtime.tcp.listen, 2);
        assert_eq!(
            runtime.listen,
            vec![
                ListenPort {
                    port: 80,
                    backlog: 0,
                    queued: 0
                },
                ListenPort {
                    port: 8080,
                    backlog: 128,
                    queued: 3
                },
            ]
        );
        assert_eq!(runtime.counters.listen_overflows, Some(4));
        assert_eq!(runtime.counters.listen_drops, Some(6));
        assert_eq!(runtime.counters.retransmitted, Some(21));
        assert!(!runtime.truncated);
    }

    #[test]
    fn a_hostile_or_partial_answer_cannot_break_anything() {
        let name = format!("x\u{1b}[31m{}", "y".repeat(500));
        let text = format!(
            "P\tnot-a-pid\tx\t\tS\t1\t1\t1\t1\n\
             P\t5\t{name}\t\tS\tmany\t\t\tNaN\n\
             P\t6\tshort\n\
             L\tZZ\t1:1\n\
             L\t0050\tnope\n\
             S\t1\t2\n\
             N\tTcpExt: a\n\
             N\tOther: 1\n\
             T\n"
        );
        let runtime = parse(&text);
        assert_eq!(runtime.processes.len(), 1);
        let process = &runtime.processes[0];
        assert_eq!(process.name.chars().count(), MAX_NAME);
        assert!(!process.name.contains('\u{1b}'));
        assert_eq!(process.threads, 0);
        assert_eq!(process.age_seconds, None);
        assert!(runtime.listen.is_empty());
        assert_eq!(runtime.tcp, TcpStates::default());
        assert_eq!(runtime.counters, TcpCounters::default());
        assert!(runtime.truncated);
    }

    #[test]
    fn the_process_list_and_listen_ports_are_bounded() {
        let mut text: String = (0..MAX_PROCESSES + 10)
            .map(|pid| format!("P\t{pid}\tw\t\tS\t1\t1\t1\t1\n"))
            .collect();
        for port in 1..200 {
            text.push_str(&format!("L\t{port:04X}\t0:0\n"));
        }
        let runtime = parse(&text);
        assert_eq!(runtime.processes.len(), MAX_PROCESSES);
        assert_eq!(runtime.listen.len(), MAX_LISTEN_PORTS);
    }

    #[test]
    fn an_empty_answer_is_an_empty_runtime() {
        assert_eq!(parse(""), Runtime::default());
    }

    #[test]
    fn process_ages_need_a_real_uptime() {
        let line = ["P", "1", "a", "", "S", "1", "1", "1", "100"];
        assert_eq!(parse_process(line, None).unwrap().age_seconds, None);
        assert_eq!(parse_process(line, Some(0.5)).unwrap().age_seconds, None);
        assert_eq!(
            parse_process(line, Some(61.0)).unwrap().age_seconds,
            Some(60)
        );
    }
}
