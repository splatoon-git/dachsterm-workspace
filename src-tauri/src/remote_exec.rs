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
    let other = |message: &str| Refusable::Failure(Failure::Other(message.into()));
    let marker = format!("DACHSTERM-{}", uuid::Uuid::new_v4().simple());
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
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
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
    let (stdout, stderr, exit) = tokio::time::timeout(limits.timeout, work)
        .await
        .map_err(|_| Refusable::Failure(Failure::TimedOut))??;
    let stdout = after_marker(&stdout, marker.as_bytes())
        .ok_or_else(|| other("이 서버에서는 원격 명령을 실행할 수 없습니다."))?;
    Ok(Output {
        stdout,
        stderr,
        exit,
    })
}

#[cfg(test)]
mod tests {
    use super::{after_marker, quote};

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
