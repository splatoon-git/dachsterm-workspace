//! One bounded remote command on its own exec channel. Every remote command runs through here
//! except `archive.rs`, which sends its request on stdin and must not be cut off at its time limit
//! (see the DX.1 note in docs/design/developer-workflow.md).
use crate::ssh::Host;
use russh::{ChannelMsg, client};
use std::time::Duration;

#[derive(Clone, Copy)]
pub struct Limits {
    pub timeout: Duration,
    pub max_output: usize,
}
pub struct Output {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit: Option<u32>,
}

/// Callers that act on a limit, such as Git status stopping automatic queries, match on these
/// instead of on message text.
#[derive(Debug)]
pub enum Failure {
    TimedOut,
    TooLarge,
    Other(String),
}
impl From<Failure> for String {
    fn from(failure: Failure) -> Self {
        match failure {
            Failure::TimedOut => "원격 명령 시간이 초과되었습니다.".into(),
            Failure::TooLarge => "원격 명령 출력이 너무 큽니다.".into(),
            Failure::Other(message) => message,
        }
    }
}

/// For callers that handle "the server would not open another channel" (`MaxSessions`) on its own.
pub enum Refusable {
    ChannelRefused,
    Failure(Failure),
}

/// POSIX single-quote quoting.
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Everything before the first marker line came from the login shell's rc files.
fn after_marker(stdout: &[u8], marker: &[u8]) -> Option<Vec<u8>> {
    let mut line = 0;
    while line <= stdout.len() {
        let end = stdout[line..]
            .iter()
            .position(|b| *b == b'\n')
            .map_or(stdout.len(), |at| line + at);
        if stdout[line..end]
            .strip_suffix(b"\r")
            .unwrap_or(&stdout[line..end])
            == marker
        {
            return Some(stdout.get(end + 1..).unwrap_or_default().to_vec());
        }
        line = end + 1;
    }
    None
}

/// Closes the channel when the call times out or is cancelled. Dropping a channel does not.
struct OpenChannel(Option<russh::Channel<client::Msg>>);
impl Drop for OpenChannel {
    fn drop(&mut self) {
        if let Some(channel) = self.0.take() {
            tokio::spawn(async move {
                let _ = channel.close().await;
            });
        }
    }
}

/// `script` runs under `sh -c`, so fish or csh login shells see the same syntax.
pub async fn run(
    handle: &client::Handle<Host>,
    script: &str,
    limits: Limits,
) -> Result<Output, Failure> {
    run_refusable(handle, script, limits)
        .await
        .map_err(|failure| match failure {
            Refusable::ChannelRefused => Failure::Other("원격 명령 채널을 열 수 없습니다.".into()),
            Refusable::Failure(failure) => failure,
        })
}

pub async fn run_refusable(
    handle: &client::Handle<Host>,
    script: &str,
    limits: Limits,
) -> Result<Output, Refusable> {
    let marker = format!("DACHSTERM-{}", uuid::Uuid::new_v4().simple());
    let (stdout, stderr, exit) = execute(handle, script, limits, &marker, &mut |_| {}).await?;
    let stdout = after_marker(&stdout, marker.as_bytes()).ok_or_else(no_shell)?;
    Ok(Output {
        stdout,
        stderr,
        exit,
    })
}

/// For commands that report as they go: each stdout line arrives as soon as the server sends it,
/// so what came before a time limit is not lost with the rest. Returns the exit status.
pub async fn run_lines(
    handle: &client::Handle<Host>,
    script: &str,
    limits: Limits,
    mut on_line: impl FnMut(&str) + Send,
) -> Result<Option<u32>, Failure> {
    let marker = format!("DACHSTERM-{}", uuid::Uuid::new_v4().simple());
    let mut lines = Lines::new(&marker);
    let result = execute(handle, script, limits, &marker, &mut |data| {
        lines.feed(data, &mut on_line);
    })
    .await;
    let unmarked = !lines.past_marker;
    lines.finish(&mut on_line);
    let (_, _, exit) = result.map_err(|failure| match failure {
        Refusable::ChannelRefused => Failure::Other("원격 명령 채널을 열 수 없습니다.".into()),
        Refusable::Failure(failure) => failure,
    })?;
    if unmarked {
        return Err(Failure::Other(NO_SHELL.into()));
    }
    Ok(exit)
}

const NO_SHELL: &str = "이 서버에서는 원격 명령을 실행할 수 없습니다.";
fn no_shell() -> Refusable {
    Refusable::Failure(Failure::Other(NO_SHELL.into()))
}

/// Cuts a command's stdout into lines and drops everything up to the marker line.
struct Lines<'a> {
    marker: &'a [u8],
    past_marker: bool,
    pending: Vec<u8>,
}
impl<'a> Lines<'a> {
    fn new(marker: &'a str) -> Self {
        Self {
            marker: marker.as_bytes(),
            past_marker: false,
            pending: Vec::new(),
        }
    }
    fn line(&mut self, line: &[u8], on_line: &mut impl FnMut(&str)) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if self.past_marker {
            on_line(&String::from_utf8_lossy(line));
        } else if line == self.marker {
            self.past_marker = true;
        }
    }
    fn feed(&mut self, data: &[u8], on_line: &mut impl FnMut(&str)) {
        self.pending.extend_from_slice(data);
        let mut start = 0;
        while let Some(at) = self.pending[start..].iter().position(|b| *b == b'\n') {
            let line = self.pending[start..start + at].to_vec();
            self.line(&line, on_line);
            start += at + 1;
        }
        self.pending.drain(..start);
    }
    fn finish(mut self, on_line: &mut impl FnMut(&str)) {
        if !self.pending.is_empty() {
            let line = std::mem::take(&mut self.pending);
            self.line(&line, on_line);
        }
    }
}

async fn execute(
    handle: &client::Handle<Host>,
    script: &str,
    limits: Limits,
    marker: &str,
    on_stdout: &mut (dyn FnMut(&[u8]) + Send),
) -> Result<(Vec<u8>, Vec<u8>, Option<u32>), Refusable> {
    let other = |message: &str| Refusable::Failure(Failure::Other(message.into()));
    let command = format!(
        "sh -c {}",
        quote(&format!("printf '%s\\n' {marker}\n{script}"))
    );
    let work = async {
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|error| match error {
                russh::Error::ChannelOpenFailure(_) => Refusable::ChannelRefused,
                _ => other("원격 명령 채널을 열 수 없습니다."),
            })?;
        let mut open = OpenChannel(Some(channel));
        let channel = open.0.as_mut().unwrap();
        channel
            .exec(true, command)
            .await
            .map_err(|_| other("원격 명령을 시작할 수 없습니다."))?;
        let (mut stdout, mut stderr, mut exit) = (Vec::new(), Vec::new(), None);
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    on_stdout(&data);
                    stdout.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::Failure => return Err(other("서버가 원격 명령을 거부했습니다.")),
                _ => {}
            }
            if stdout.len() + stderr.len() > limits.max_output {
                return Err(Refusable::Failure(Failure::TooLarge));
            }
        }
        Ok((stdout, stderr, exit))
    };
    tokio::time::timeout(limits.timeout, work)
        .await
        .map_err(|_| Refusable::Failure(Failure::TimedOut))?
}

#[cfg(test)]
mod tests {
    use super::{Lines, after_marker, quote};

    fn collected(chunks: &[&[u8]]) -> Vec<String> {
        let mut seen = Vec::new();
        let mut lines = Lines::new("M");
        let mut record = |line: &str| seen.push(line.to_string());
        for chunk in chunks {
            lines.feed(chunk, &mut record);
        }
        lines.finish(&mut record);
        seen
    }

    #[test]
    fn lines_start_after_the_marker_and_survive_being_split() {
        assert_eq!(
            collected(&[b"motd\nM\r\none\ntw", b"o\r\n", b"three"]),
            ["one", "two", "three"]
        );
        assert!(collected(&[b"no marker here\n"]).is_empty());
    }

    #[test]
    fn quotes_for_posix_shells() {
        assert_eq!(quote("a'b"), "'a'\\''b'");
        assert_eq!(quote("$(reboot) `id`"), "'$(reboot) `id`'");
    }

    #[test]
    fn keeps_only_what_follows_the_marker_line() {
        assert_eq!(after_marker(b"M\nout\n", b"M").unwrap(), b"out\n");
        assert_eq!(
            after_marker(b"welcome\nbanner\nM\r\nout", b"M").unwrap(),
            b"out"
        );
        assert_eq!(after_marker(b"M", b"M").unwrap(), b"");
        // A marker text inside a line is not the marker line.
        assert_eq!(after_marker(b"say M here\nM\nreal", b"M").unwrap(), b"real");
        assert!(after_marker(b"% Invalid input", b"M").is_none());
        assert!(after_marker(b"", b"M").is_none());
    }
}
