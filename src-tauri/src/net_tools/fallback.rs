//! Tries a port with a command on the server, for servers whose policy forbids forwarding. The only
//! user input in these scripts is a validated host, quoted, and a number.
use super::{
    dial::ServerReason,
    port_check::{Outcome, Verdict},
};
use crate::{
    remote_exec::{self, Limits},
    ssh::Host,
};
use russh::client;
use std::time::Duration;

const DETECT: &str = "export PATH=\"$PATH:/usr/sbin:/sbin\"\n\
    if command -v bash >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then echo bash\n\
    elif command -v nc >/dev/null 2>&1; then echo nc\n\
    fi\n";
const OVERHEAD: Duration = Duration::from_secs(5);
const MAX_OUTPUT: usize = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tool {
    Bash,
    Nc,
}

pub async fn detect(handle: &client::Handle<Host>) -> Result<Option<Tool>, String> {
    let limits = Limits {
        timeout: OVERHEAD,
        max_output: MAX_OUTPUT,
    };
    let output = remote_exec::run(handle, DETECT, limits).await?;
    Ok(match String::from_utf8_lossy(&output.stdout).trim() {
        "bash" => Some(Tool::Bash),
        "nc" => Some(Tool::Nc),
        _ => None,
    })
}

fn script(tool: Tool, host: &str, port: u16, seconds: u64) -> String {
    let host = remote_exec::quote(host);
    // English error text, which is all that `read` understands.
    match tool {
        Tool::Bash => format!(
            "export LC_ALL=C PATH=\"$PATH:/usr/sbin:/sbin\"\n\
             timeout {seconds} bash -c 'exec 3<>\"/dev/tcp/$1/$2\"' _ {host} {port}\n"
        ),
        Tool::Nc => format!(
            "export LC_ALL=C PATH=\"$PATH:/usr/sbin:/sbin\"\nnc -z -w {seconds} {host} {port}\n"
        ),
    }
}

fn read(tool: Tool, exit: Option<u32>, stderr: &str) -> Verdict {
    match (tool, exit) {
        (_, Some(0)) => Verdict::of(Outcome::Open),
        // `nc -z` gives the same status for refused and silent ports (TL.0).
        (Tool::Nc, Some(1)) => Verdict::of(Outcome::ClosedOrNoResponse),
        (Tool::Bash, Some(124 | 143)) => Verdict::of(Outcome::NoResponse),
        (Tool::Bash, Some(1)) => match ServerReason::parse(stderr) {
            ServerReason::Refused => Verdict::of(Outcome::Closed),
            ServerReason::NoRoute => Verdict::of(Outcome::Unreachable),
            ServerReason::TimedOut => Verdict::of(Outcome::NoResponse),
            ServerReason::NameFailed => Verdict::unknown("서버에서 이름을 해석하지 못했습니다."),
            _ => Verdict::unknown("서버의 명령이 이유를 알리지 않았습니다."),
        },
        _ => Verdict::unknown("서버의 명령이 예상과 다르게 끝났습니다."),
    }
}

pub async fn attempt(
    handle: &client::Handle<Host>,
    tool: Tool,
    host: &str,
    port: u16,
    wait: Duration,
) -> Verdict {
    let seconds = wait.as_secs().max(1);
    let limits = Limits {
        timeout: wait + OVERHEAD,
        max_output: MAX_OUTPUT,
    };
    match remote_exec::run(handle, &script(tool, host, port, seconds), limits).await {
        Ok(output) => read(tool, output.exit, &String::from_utf8_lossy(&output.stderr)),
        Err(failure) => Verdict::unknown(String::from(failure)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_the_host_and_keeps_the_script_fixed() {
        let bash = script(Tool::Bash, "db.example", 5432, 3);
        assert!(bash.contains("timeout 3 bash -c"));
        assert!(bash.ends_with("_ 'db.example' 5432\n"));
        let nc = script(Tool::Nc, "::1", 22, 4);
        assert!(nc.ends_with("nc -z -w 4 '::1' 22\n"));
        assert!(script(Tool::Nc, "a'b", 1, 1).contains("'a'\\''b'"));
    }

    #[test]
    fn bash_tells_refused_from_silent() {
        let outcome = |exit, stderr| read(Tool::Bash, exit, stderr).outcome;
        assert_eq!(outcome(Some(0), ""), Outcome::Open);
        assert_eq!(
            outcome(Some(1), "bash: connect: Connection refused\n"),
            Outcome::Closed
        );
        assert_eq!(
            outcome(Some(1), "bash: connect: No route to host\n"),
            Outcome::Unreachable
        );
        assert_eq!(outcome(Some(124), ""), Outcome::NoResponse);
        assert_eq!(outcome(Some(143), ""), Outcome::NoResponse);
        assert_eq!(outcome(Some(1), "other\n"), Outcome::Unknown);
        assert_eq!(outcome(None, ""), Outcome::Unknown);
    }

    #[test]
    fn nc_cannot_tell_refused_from_silent() {
        let outcome = |exit| read(Tool::Nc, exit, "").outcome;
        assert_eq!(outcome(Some(0)), Outcome::Open);
        assert_eq!(outcome(Some(1)), Outcome::ClosedOrNoResponse);
        assert_eq!(outcome(Some(127)), Outcome::Unknown);
    }
}
