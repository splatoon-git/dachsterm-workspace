//! The detached runner on the server (docs/design/agent-chat.md §2.1). The agent CLI runs under
//! `nohup` with its input on a FIFO and its output in a file, so a turn outlives the SSH connection
//! that started it and a later connection can read on from where the last one stopped.
use crate::{
    remote_exec::{self, Limits, Refusable, quote},
    ssh::Host,
    storage::Result,
};
use russh::client;
use std::{
    ops::ControlFlow,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};

/// Messages larger than this would not fit a command line; attachments go as uploaded paths.
pub const MAX_MESSAGE: usize = 64 * 1024;
/// One line of agent output. A tool result can be large, but not without bound.
const MAX_LINE: usize = 16 * 1024 * 1024;
const QUICK: Limits = Limits {
    timeout: Duration::from_secs(15),
    max_output: 64 * 1024,
};
/// Reading a runner's output has no natural end while the chat is open.
const ATTACHED: Limits = Limits {
    timeout: Duration::from_secs(60 * 60 * 24 * 365),
    max_output: 64 * 1024,
};
/// Exit status the scripts use for "the runner is gone", so callers never read stderr text.
const GONE: u32 = 3;

/// A runner's folder name: 32 lowercase hex digits the app made. Checked before it reaches a script.
pub fn valid_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn folder_of(id: &str) -> String {
    debug_assert!(valid_id(id));
    format!("\"$HOME/.cache/dachsterm/chat/{id}\"")
}

/// Finds a program the way the user's login shell would. A plain exec channel lacks `~/.local/bin`,
/// where the official installer puts `claude` (AC.1 measurement).
fn locate_script(program: &str) -> String {
    let lookup = quote(&format!("command -v {program}"));
    format!("\"${{SHELL:-/bin/sh}}\" -lc {lookup} 2>/dev/null </dev/null || command -v {program}")
}

/// The absolute path a lookup printed. rc files may print first, so only the last line counts.
fn located(stdout: &str) -> Option<String> {
    let line = stdout.trim_end().lines().last()?.trim();
    (line.starts_with('/') && !line.chars().any(char::is_control)).then(|| line.to_string())
}

/// A server folder for the chat, or why it cannot be used. Empty means the login folder.
pub fn folder_problem(folder: &str) -> Option<&'static str> {
    if folder.is_empty() {
        return None;
    }
    if !folder.starts_with('/') {
        return Some("서버 폴더는 /로 시작하는 경로로 입력하세요.");
    }
    if folder.len() > 4096 || folder.chars().any(char::is_control) {
        return Some("폴더 경로를 확인하세요.");
    }
    None
}

fn start_script(id: &str, folder: &str, argv: &[String]) -> String {
    let dir = folder_of(id);
    let into = if folder.is_empty() {
        "\"$HOME\"".to_string()
    } else {
        quote(folder)
    };
    let command: Vec<String> = argv.iter().map(|a| quote(a)).collect();
    format!(
        "umask 077\n\
         cd -- {into} || exit 4\n\
         mkdir -p {dir} && chmod 700 \"$HOME/.cache/dachsterm\" \"$HOME/.cache/dachsterm/chat\" {dir} || exit 5\n\
         mkfifo {dir}/in || exit 5\n\
         nohup sh -c 'exec \"$@\" <>\"$0/in\" >\"$0/out.jsonl\" 2>\"$0/err.log\"' {dir} {} >/dev/null 2>&1 </dev/null &\n\
         echo $! > {dir}/pid",
        command.join(" ")
    )
}

fn alive_check(dir: &str) -> String {
    format!("p=$(cat {dir}/pid 2>/dev/null) && kill -0 \"$p\" 2>/dev/null || exit {GONE}")
}

fn send_script(id: &str, line: &str) -> String {
    let dir = folder_of(id);
    format!(
        "{}\nprintf '%s\\n' {} > {dir}/in",
        alive_check(&dir),
        quote(line)
    )
}

/// Streams the output file from `offset` and ends once the agent has exited. The loop also stops
/// when `tail` dies, which it does on its next write after this channel has closed. An agent that
/// exited while no one was attached still has its last output read.
fn attach_script(id: &str, offset: u64) -> String {
    let dir = folder_of(id);
    let from = offset + 1;
    format!(
        "p=$(cat {dir}/pid 2>/dev/null) || exit {GONE}\n\
         if ! kill -0 \"$p\" 2>/dev/null; then tail -c +{from} {dir}/out.jsonl 2>/dev/null; exit 0; fi\n\
         tail -c +{from} -F {dir}/out.jsonl 2>/dev/null &\nt=$!\n\
         while kill -0 \"$p\" 2>/dev/null && kill -0 \"$t\" 2>/dev/null; do sleep 1; done\n\
         sleep 1\nkill \"$t\" 2>/dev/null\nexit 0"
    )
}

fn error_script(id: &str) -> String {
    format!("tail -c 1000 {}/err.log 2>/dev/null", folder_of(id))
}

fn stop_script(id: &str) -> String {
    let dir = folder_of(id);
    format!(
        "if p=$(cat {dir}/pid 2>/dev/null); then\n\
         kill \"$p\" 2>/dev/null\n\
         for _ in 1 2 3; do kill -0 \"$p\" 2>/dev/null || break; sleep 1; done\n\
         kill -9 \"$p\" 2>/dev/null\nfi\nrm -rf {dir}"
    )
}

type Handle = client::Handle<Host>;

pub async fn locate(handle: &Handle, program: &str) -> Result<String> {
    let output = remote_exec::run(handle, &locate_script(program), QUICK).await?;
    located(&String::from_utf8_lossy(&output.stdout)).ok_or_else(|| {
        format!(
            "서버에서 {program}을(를) 찾을 수 없습니다. 서버에 설치하고 로그인한 뒤 다시 여세요."
        )
    })
}

pub async fn start(handle: &Handle, id: &str, folder: &str, argv: &[String]) -> Result<()> {
    let output = remote_exec::run(handle, &start_script(id, folder, argv), QUICK).await?;
    match output.exit {
        Some(0) => Ok(()),
        Some(4) => Err("서버 폴더로 이동할 수 없습니다.".into()),
        _ => Err("서버에 실행 폴더를 만들 수 없습니다.".into()),
    }
}

pub async fn send(handle: &Handle, id: &str, line: &str) -> Result<()> {
    let output = remote_exec::run(handle, &send_script(id, line), QUICK).await?;
    match output.exit {
        Some(0) => Ok(()),
        Some(GONE) => Err("에이전트가 종료되어 보낼 수 없습니다.".into()),
        _ => Err("메시지를 보내지 못했습니다.".into()),
    }
}

/// The end of the agent's error output, for telling the user why it stopped.
pub async fn last_error(handle: &Handle, id: &str) -> Option<String> {
    let output = remote_exec::run(handle, &error_script(id), QUICK)
        .await
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!text.is_empty()).then_some(text)
}

pub async fn stop(handle: &Handle, id: &str) -> Result<()> {
    remote_exec::run(handle, &stop_script(id), QUICK).await?;
    Ok(())
}

/// How reading the output ended.
pub enum Attached {
    /// The agent exited.
    Exited,
    /// The reader stopped it, for example because the chat was closed.
    Stopped,
}

/// Reads complete output lines from `offset`. `offset` moves past each line as it is handed on,
/// with nothing to wait for in between, so a later attach starts exactly where this one stopped
/// even if this one is cancelled.
pub async fn attach(
    handle: &Handle,
    id: &str,
    offset: &AtomicU64,
    mut on_line: impl FnMut(&str) -> ControlFlow<()> + Send,
) -> Result<Attached> {
    let mut lines = LineBuffer::default();
    let mut stopped = false;
    let script = attach_script(id, offset.load(Ordering::SeqCst));
    let result = remote_exec::stream_refusable(handle, &script, ATTACHED, |data| {
        let flow = lines.feed(data, &mut |line| {
            offset.fetch_add(line.len() as u64 + 1, Ordering::SeqCst);
            on_line(&String::from_utf8_lossy(line))
        });
        if flow.is_break() {
            stopped = true;
        }
        flow
    })
    .await;
    if lines.too_long {
        return Err("에이전트 출력의 한 줄이 너무 깁니다.".into());
    }
    match result {
        Ok(_) if stopped => Ok(Attached::Stopped),
        // The script ends only once the agent has exited, or with `GONE` if it already had.
        Ok(_) => Ok(Attached::Exited),
        Err(Refusable::ChannelRefused) => Err("원격 명령 채널을 열 수 없습니다.".into()),
        Err(Refusable::Failure(failure)) => Err(failure.into()),
    }
}

/// Cuts output into lines. Unlike `remote_exec`'s splitter it bounds a line, since the output is
/// the server's, and leaves an unfinished last line unread so the next attach can start at it.
#[derive(Default)]
pub(super) struct LineBuffer {
    pending: Vec<u8>,
    pub(super) too_long: bool,
}
impl LineBuffer {
    pub(super) fn feed(
        &mut self,
        data: &[u8],
        on_line: &mut impl FnMut(&[u8]) -> ControlFlow<()>,
    ) -> ControlFlow<()> {
        self.pending.extend_from_slice(data);
        let mut start = 0;
        while let Some(at) = self.pending[start..].iter().position(|b| *b == b'\n') {
            let flow = on_line(&self.pending[start..start + at]);
            start += at + 1;
            if flow.is_break() {
                self.pending.drain(..start);
                return flow;
            }
        }
        self.pending.drain(..start);
        if self.pending.len() > MAX_LINE {
            self.too_long = true;
            return ControlFlow::Break(());
        }
        ControlFlow::Continue(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn accepts_only_app_made_ids() {
        assert!(valid_id(ID));
        for bad in [
            "",
            "0123",
            "0123456789ABCDEF0123456789abcdef",
            "../../etc/passwd/aaaaaaaaaaaaaaaa",
        ] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn takes_the_last_absolute_line_of_a_lookup() {
        assert_eq!(
            located("/home/p/.local/bin/claude\n").unwrap(),
            "/home/p/.local/bin/claude"
        );
        assert_eq!(
            located("welcome\n/usr/bin/codex").unwrap(),
            "/usr/bin/codex"
        );
        for bad in ["", "claude", "alias claude='x'", "/usr/bin/claude\nmenu"] {
            assert!(located(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn checks_folders() {
        assert!(folder_problem("").is_none());
        assert!(folder_problem("/home/p/work").is_none());
        assert!(folder_problem("work").is_some());
        assert!(folder_problem("/tmp/a\nb").is_some());
    }

    #[test]
    fn quotes_every_argument_and_the_folder() {
        let argv = [
            "/x/claude".to_string(),
            "--a".to_string(),
            "it's".to_string(),
        ];
        let script = start_script(ID, "/w/o'k", &argv);
        assert!(script.contains("cd -- '/w/o'\\''k' || exit 4"));
        assert!(script.contains("'/x/claude' '--a' 'it'\\''s'"));
        assert!(script.contains(&format!("\"$HOME/.cache/dachsterm/chat/{ID}\"/in")));
        assert!(start_script(ID, "", &argv).contains("cd -- \"$HOME\""));
    }

    #[test]
    fn a_message_is_one_quoted_argument() {
        let script = send_script(ID, "{\"text\":\"$(reboot) '\"}");
        assert!(script.contains("printf '%s\\n' '{\"text\":\"$(reboot) '\\''\"}'"));
        assert!(script.contains(&format!("exit {GONE}")));
    }

    #[test]
    fn attach_starts_after_the_bytes_already_read() {
        assert!(attach_script(ID, 0).contains("tail -c +1 -F"));
        assert!(attach_script(ID, 41).contains("tail -c +42 -F"));
    }

    #[test]
    fn attach_reads_what_an_agent_wrote_before_it_exited() {
        let script = attach_script(ID, 41);
        let dir = format!("\"$HOME/.cache/dachsterm/chat/{ID}\"");
        assert!(script.contains(&format!(
            "then tail -c +42 {dir}/out.jsonl 2>/dev/null; exit 0; fi"
        )));
        assert!(script.starts_with(&format!("p=$(cat {dir}/pid 2>/dev/null) || exit {GONE}")));
    }

    #[test]
    fn lines_keep_an_unfinished_tail_and_stop_when_asked() {
        let mut buffer = LineBuffer::default();
        let mut seen = Vec::new();
        let mut take = |line: &[u8]| {
            seen.push(String::from_utf8_lossy(line).to_string());
            ControlFlow::Continue(())
        };
        let _ = buffer.feed(b"one\ntw", &mut take);
        let _ = buffer.feed(b"o\nthr", &mut take);
        assert_eq!(seen, ["one", "two"]);
        assert_eq!(buffer.pending, b"thr");

        let mut buffer = LineBuffer::default();
        let mut count = 0;
        let flow = buffer.feed(b"a\nb\nc\n", &mut |_| {
            count += 1;
            if count == 2 {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        });
        assert!(flow.is_break());
        assert_eq!(count, 2);
    }
}
