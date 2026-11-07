//! One bounded remote command on its own exec channel. New features run remote commands through
//! here. `archive.rs` (uses stdin) and `monitoring.rs` (periodic) keep their own policies.
use crate::{ssh::Host, storage::Result};
use russh::{ChannelMsg, client};
use std::time::Duration;

pub struct Limits {
    pub timeout: Duration,
    pub max_output: usize,
}
pub struct Output {
    pub stdout: Vec<u8>,
    pub exit: Option<u32>,
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
pub async fn run(handle: &client::Handle<Host>, script: &str, limits: Limits) -> Result<Output> {
    let marker = format!("DACHSTERM-{}", uuid::Uuid::new_v4().simple());
    let command = format!(
        "sh -c {}",
        quote(&format!("printf '%s\\n' {marker}\n{script}"))
    );
    let work = async {
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|_| "원격 명령 채널을 열 수 없습니다.")?;
        let mut open = OpenChannel(Some(channel));
        let channel = open.0.as_mut().unwrap();
        channel
            .exec(true, command)
            .await
            .map_err(|_| "원격 명령을 시작할 수 없습니다.")?;
        let (mut stdout, mut exit, mut size) = (Vec::new(), None, 0);
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    size += data.len();
                    stdout.extend_from_slice(&data);
                }
                ChannelMsg::ExtendedData { data, .. } => size += data.len(),
                ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                ChannelMsg::Failure => return Err("서버가 원격 명령을 거부했습니다.".to_string()),
                _ => {}
            }
            if size > limits.max_output {
                return Err("원격 명령 출력이 너무 큽니다.".to_string());
            }
        }
        Ok((stdout, exit))
    };
    let (stdout, exit) = tokio::time::timeout(limits.timeout, work)
        .await
        .map_err(|_| "원격 명령 시간이 초과되었습니다.")??;
    let stdout = after_marker(&stdout, marker.as_bytes())
        .ok_or("이 서버에서는 원격 명령을 실행할 수 없습니다.")?;
    Ok(Output { stdout, exit })
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
