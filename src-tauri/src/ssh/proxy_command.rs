//! `ProxyCommand` (CG.2): the first connection of a route runs over a command's standard input
//! and output. The process belongs to the stream: dropping the stream kills it.
use crate::storage::{Profile, Result};
use std::{
    collections::VecDeque,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, ReadBuf},
    process::{Child, ChildStdin, ChildStdout},
};

/// The end of the command's standard error, shown when the connection fails. It may hold
/// secrets the command printed, so it goes to the status line only, never to the session log.
const TAIL: usize = 4 * 1024;

/// Replaces `%h`, `%p`, `%r`, `%n` and `%%`. The host and user were checked when the session was
/// saved, so they hold no spaces or shell characters.
pub fn expand(command: &str, p: &Profile) -> String {
    let mut out = String::with_capacity(command.len());
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('h' | 'n') => out.push_str(&p.host),
            Some('p') => out.push_str(&p.port.to_string()),
            Some('r') => out.push_str(&p.username),
            Some('%') => out.push('%'),
            // `check_command` refuses any other token before a session is saved.
            Some(other) => {
                out.push('%');
                out.push(other);
            }
            None => out.push('%'),
        }
    }
    out
}

/// What the command wrote to standard error, up to its last 4 KiB.
#[derive(Clone, Default)]
pub struct Stderr {
    bytes: Arc<Mutex<VecDeque<u8>>>,
    done: Arc<tokio::sync::Notify>,
    finished: Arc<std::sync::atomic::AtomicBool>,
}
impl Stderr {
    fn push(&self, data: &[u8]) {
        let mut bytes = self.bytes.lock().unwrap();
        bytes.extend(data);
        let excess = bytes.len().saturating_sub(TAIL);
        bytes.drain(..excess);
    }
    /// The last lines as one short, printable line, after the command has had a moment to
    /// finish writing them.
    pub async fn text(&self) -> Option<String> {
        if !self.finished.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = tokio::time::timeout(Duration::from_millis(500), self.done.notified()).await;
        }
        let bytes: Vec<u8> = self.bytes.lock().unwrap().iter().copied().collect();
        shown(&bytes)
    }
}
fn shown(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let joined = lines.join(" / ");
    let clean: String = joined.chars().filter(|c| !c.is_control()).collect();
    let chars: Vec<char> = clean.chars().collect();
    let start = chars.len().saturating_sub(300);
    let tail: String = chars[start..].iter().collect();
    (!tail.is_empty()).then_some(tail)
}

/// The command's standard output and input as one stream. Dropping it kills the process.
pub struct CommandStream {
    child: Child,
    stdout: ChildStdout,
    stdin: ChildStdin,
}
impl Drop for CommandStream {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}
impl AsyncRead for CommandStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdout).poll_read(cx, buf)
    }
}
impl AsyncWrite for CommandStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stdin).poll_write(cx, data)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdin).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdin).poll_shutdown(cx)
    }
}

/// Starts the expanded command line. macOS runs it with `/bin/sh -c "exec …"` like OpenSSH, so
/// no shell stays behind, with the `PATH` the app merged from the login shell at start.
pub fn spawn(line: &str) -> Result<(CommandStream, Stderr)> {
    let mut command = shell(line);
    command
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|_| "프록시 명령을 실행할 수 없습니다.")?;
    let (Some(stdin), Some(stdout), Some(mut err)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err("프록시 명령의 입출력을 열 수 없습니다.".into());
    };
    let stderr = Stderr::default();
    let tail = stderr.clone();
    // Ends when the process closes standard error, which it does when it exits or is killed.
    tokio::spawn(async move {
        let mut buffer = [0u8; 1024];
        while let Ok(n) = err.read(&mut buffer).await {
            if n == 0 {
                break;
            }
            tail.push(&buffer[..n]);
        }
        tail.finished
            .store(true, std::sync::atomic::Ordering::SeqCst);
        tail.done.notify_waiters();
    });
    Ok((
        CommandStream {
            child,
            stdout,
            stdin,
        },
        stderr,
    ))
}

#[cfg(unix)]
fn shell(line: &str) -> tokio::process::Command {
    let mut command = tokio::process::Command::new("/bin/sh");
    command.arg("-c").arg(format!("exec {line}"));
    command
}

/// Windows OpenSSH runs the line with `CreateProcessW` itself, without `cmd.exe`: the first word
/// is the program, found on `PATH`, and the rest goes to it as written. No console window opens.
#[cfg(windows)]
fn shell(line: &str) -> tokio::process::Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let line = line.trim_start();
    let (program, rest) = if let Some(quoted) = line.strip_prefix('"') {
        quoted.split_once('"').unwrap_or((quoted, ""))
    } else {
        line.split_once(char::is_whitespace).unwrap_or((line, ""))
    };
    let mut command = tokio::process::Command::new(program);
    command
        .as_std_mut()
        .raw_arg(rest.trim_start())
        .creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn tokens_take_the_session_values() {
        let mut p = crate::storage::tests::profile();
        p.host = "db.internal".into();
        p.port = 2222;
        p.username = "alice".into();
        assert_eq!(
            expand("ssh -W %h:%p -l %r jump # %n 100%%", &p),
            "ssh -W db.internal:2222 -l alice jump # db.internal 100%"
        );
    }
    #[test]
    fn stderr_keeps_a_short_printable_tail() {
        assert_eq!(
            shown(b"line one\r\n\x1b[31mred\x1b[0m\n\n"),
            Some("line one / [31mred[0m".into())
        );
        assert_eq!(shown(b"  \n"), None);
        let long = "x".repeat(1000);
        assert_eq!(shown(long.as_bytes()).unwrap().len(), 300);
        let stderr = Stderr::default();
        stderr.push(&vec![b'a'; TAIL + 10]);
        assert_eq!(stderr.bytes.lock().unwrap().len(), TAIL);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn the_stream_is_the_commands_stdio_and_stderr_is_kept() {
        let (mut stream, stderr) = spawn("sh -c 'echo oops >&2; cat'").unwrap();
        stream.write_all(b"ping\n").await.unwrap();
        let mut echoed = [0u8; 5];
        stream.read_exact(&mut echoed).await.unwrap();
        assert_eq!(&echoed, b"ping\n");
        drop(stream);
        assert_eq!(stderr.text().await.as_deref(), Some("oops"));
        let (mut missing, stderr) = spawn("/no/such/program %h").unwrap();
        let mut byte = [0u8; 1];
        assert_eq!(
            missing.read(&mut byte).await.unwrap(),
            0,
            "EOF when it exits"
        );
        assert!(stderr.text().await.unwrap().contains("/no/such/program"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn dropping_the_stream_kills_the_process() {
        let (stream, _) = spawn("sleep 30").unwrap();
        let pid = stream.child.id().unwrap();
        drop(stream);
        tokio::time::sleep(Duration::from_millis(300)).await;
        // Gone, or a zombie waiting for tokio's reaper: either way it no longer runs.
        let state = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&state.stdout);
        assert!(
            state.trim().is_empty() || state.trim().starts_with('Z'),
            "{state}"
        );
    }
}
