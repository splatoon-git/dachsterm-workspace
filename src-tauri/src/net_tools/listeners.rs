//! Port list (TL.7): which ports are in use where the tool runs. Commands are fixed strings that
//! take no user input, and nothing asks for root.
use super::listener_parse as parse;
use crate::{
    remote_exec::{self, Limits},
    ssh::Host,
    storage::Result,
};
use russh::client;
use serde::Serialize;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Protocol {
    Tcp,
    Udp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Process {
    Known {
        name: String,
        pid: Option<u32>,
    },
    /// A tool ran but cannot see this process, usually another account's.
    Denied,
    /// Nothing on that machine can name the owner.
    Unavailable,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listener {
    pub protocol: Protocol,
    pub address: String,
    pub port: u16,
    pub process: Process,
}

/// How the list was read, shown beside it because it decides how complete the list is.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    WindowsApi,
    MacLsof,
    Proc,
    ProcSs,
    ProcNetstat,
    RemoteLsof,
    RemoteNetstat,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub method: Method,
    pub listeners: Vec<Listener>,
}

const LINUX: &str = "export LC_ALL=C PATH=\"$PATH:/usr/sbin:/sbin\"\n\
    for t in tcp tcp6 udp udp6; do printf '@@table %s\\n' \"$t\"; cat \"/proc/net/$t\" 2>/dev/null; done\n\
    if command -v ss >/dev/null 2>&1; then printf '@@ss\\n'; ss -lntup 2>/dev/null\n\
    elif command -v netstat >/dev/null 2>&1; then printf '@@netstat\\n'; netstat -lntup 2>/dev/null\n\
    fi\n";
const OTHER: &str = "export LC_ALL=C PATH=\"$PATH:/usr/sbin:/sbin\"\n\
    if command -v lsof >/dev/null 2>&1; then printf '@@lsof\\n'; lsof -nP -iTCP -sTCP:LISTEN -iUDP -FpcPn 2>/dev/null; fi\n\
    if command -v netstat >/dev/null 2>&1; then printf '@@netstat\\n'; netstat -an 2>/dev/null; fi\n";
const LIMITS: Limits = Limits {
    timeout: Duration::from_secs(5),
    max_output: 4 * 1024 * 1024,
};

fn read_linux(output: &str) -> Option<Report> {
    let found = parse::sections(output);
    let table = parse::tables(&found)?;
    // Only a tool that printed sockets counts as having run. BusyBox's lsof is left out on purpose.
    let ss = found
        .get("ss")
        .map(|text| parse::ss(text))
        .filter(|s| !s.is_empty());
    let netstat = found
        .get("netstat")
        .map(|text| parse::netstat(text))
        .filter(|s| !s.is_empty());
    let (method, sockets) = match (ss, netstat) {
        (Some(sockets), _) => (Method::ProcSs, Some(sockets)),
        (None, Some(sockets)) => (Method::ProcNetstat, Some(sockets)),
        (None, None) => (Method::Proc, None),
    };
    Some(Report {
        method,
        listeners: parse::with_owners(table, sockets),
    })
}

fn read_other(output: &str) -> Option<Report> {
    let found = parse::sections(output);
    if let Some(sockets) = found
        .get("lsof")
        .map(|text| parse::lsof(text))
        .filter(|s| !s.is_empty())
    {
        return Some(Report {
            method: Method::RemoteLsof,
            listeners: parse::from_sockets(sockets, parse_missing()),
        });
    }
    let sockets = parse::netstat(found.get("netstat")?);
    (!sockets.is_empty()).then(|| Report {
        method: Method::RemoteNetstat,
        listeners: parse::from_sockets(sockets, parse_missing()),
    })
}

const fn parse_missing() -> Process {
    Process::Unavailable
}

pub async fn remote(handle: &client::Handle<Host>) -> Result<Report> {
    let output = remote_exec::run(handle, LINUX, LIMITS).await?;
    if let Some(report) = read_linux(&String::from_utf8_lossy(&output.stdout)) {
        return Ok(report);
    }
    let output = remote_exec::run(handle, OTHER, LIMITS).await?;
    read_other(&String::from_utf8_lossy(&output.stdout))
        .ok_or("이 서버에서는 포트 목록을 읽을 수 없습니다.".into())
}

#[cfg(windows)]
pub async fn local() -> Result<Report> {
    let listeners = tauri::async_runtime::spawn_blocking(super::listeners_windows::list)
        .await
        .map_err(|_| "포트 목록을 읽지 못했습니다.".to_string())??;
    Ok(Report {
        method: Method::WindowsApi,
        listeners,
    })
}

/// By absolute path: an app started from Finder has only the system `PATH`.
#[cfg(target_os = "macos")]
pub async fn local() -> Result<Report> {
    let output = tokio::time::timeout(
        LIMITS.timeout,
        tokio::process::Command::new("/usr/sbin/lsof")
            .args(["-nP", "-iTCP", "-sTCP:LISTEN", "-iUDP", "-FpcPn"])
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "포트 목록을 읽는 시간이 초과되었습니다.".to_string())?
    .map_err(|_| "포트 목록을 읽지 못했습니다.".to_string())?;
    let sockets = parse::lsof(&String::from_utf8_lossy(&output.stdout));
    Ok(Report {
        method: Method::MacLsof,
        listeners: parse::from_sockets(sockets, parse_missing()),
    })
}

#[cfg(not(any(windows, target_os = "macos")))]
pub async fn local() -> Result<Report> {
    Err("이 운영체제에서는 포트 목록을 읽을 수 없습니다.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TCP: &str =
        "  sl  local_address rem_address st\n   0: 00000000:0016 00000000:0000 0A 0\n";

    #[test]
    fn ss_is_used_when_it_printed_sockets() {
        let text = format!(
            "@@table tcp\n{TCP}@@ss\ntcp LISTEN 0 1 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=1,fd=3))\n"
        );
        let report = read_linux(&text).unwrap();
        assert_eq!(report.method, Method::ProcSs);
        assert!(matches!(report.listeners[0].process, Process::Known { .. }));
    }

    #[test]
    fn netstat_stands_in_for_ss() {
        let text =
            format!("@@table tcp\n{TCP}@@netstat\ntcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN 1/sshd\n");
        assert_eq!(read_linux(&text).unwrap().method, Method::ProcNetstat);
    }

    #[test]
    fn a_tool_that_printed_nothing_did_not_run() {
        let report = read_linux(&format!("@@table tcp\n{TCP}@@ss\n")).unwrap();
        assert_eq!(report.method, Method::Proc);
        assert_eq!(report.listeners[0].process, Process::Unavailable);
    }

    #[test]
    fn no_kernel_table_means_trying_the_other_tools() {
        assert!(read_linux("@@table tcp\n@@table udp\n@@ss\n").is_none());
        let report = read_other("@@lsof\np1\ncsshd\nf3\nPTCP\nn*:22\n").unwrap();
        assert_eq!(report.method, Method::RemoteLsof);
        let report =
            read_other("@@lsof\nsh 1 root 0u\n@@netstat\ntcp4 0 0 *.22 *.* LISTEN\n").unwrap();
        assert_eq!(report.method, Method::RemoteNetstat);
        assert_eq!(report.listeners[0].process, Process::Unavailable);
        assert!(read_other("").is_none());
    }

    #[test]
    fn the_scripts_stay_fixed_and_need_no_root() {
        for script in [LINUX, OTHER] {
            assert!(!script.contains("sudo"));
            assert!(script.contains("LC_ALL=C"));
        }
    }
}
