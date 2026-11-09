//! The live log board on a local cluster (design KV.11). One kubectl per source with no pipeline:
//! what `source_script`'s awk does on a server is done here, and the result has the same line
//! format, so `Reader` needs no second path. Dropping `follow`'s future ends every kubectl.
use super::{Failed, KubeSettings, MAX_LINE_BYTES, STATUS, StreamSource, logs_line};
use crate::{
    kube::local_run,
    remote_exec::{Failure, Limits, Streamed},
};
use std::ops::ControlFlow;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    sync::mpsc,
    task::JoinSet,
};

/// Lines waiting for the screen. A kubectl blocks on a full pipe, which is what limits a flood.
const QUEUE: usize = 256;

/// One line, without its newline. `false` once the stream has ended. A line longer than the limit
/// is cut there, the same as `substr` on a server.
async fn next_line<R: AsyncRead + Unpin>(
    reader: &mut BufReader<R>,
    line: &mut Vec<u8>,
) -> std::io::Result<bool> {
    line.clear();
    let mut any = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(any);
        }
        any = true;
        let newline = available.iter().position(|byte| *byte == b'\n');
        let end = newline.unwrap_or(available.len());
        let room = MAX_LINE_BYTES.saturating_sub(line.len()).min(end);
        line.extend_from_slice(&available[..room]);
        let consumed = newline.map_or(end, |at| at + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(true);
        }
    }
}

fn is_timestamped(line: &[u8]) -> bool {
    line.len() > 4 && line[..4].iter().all(u8::is_ascii_digit) && line[4] == b'-'
}

/// Anything that is not a timestamped log line is kubectl's own message and always passes.
fn passes(line: &[u8], filter: &[u8]) -> bool {
    !is_timestamped(line)
        || filter.is_empty()
        || line.windows(filter.len()).any(|window| window == filter)
}

fn prefixed(index: usize, line: &[u8]) -> Vec<u8> {
    let mut piece = format!("{index} ").into_bytes();
    piece.extend_from_slice(line);
    piece.push(b'\n');
    piece
}

async fn forward<R: AsyncRead + Unpin>(
    reader: R,
    index: usize,
    filter: &[u8],
    out: &mpsc::Sender<Vec<u8>>,
) {
    let mut reader = BufReader::new(reader);
    let mut line = Vec::new();
    while let Ok(true) = next_line(&mut reader, &mut line).await {
        if passes(&line, filter) && out.send(prefixed(index, &line)).await.is_err() {
            return;
        }
    }
}

async fn follow_one(
    command: tokio::process::Command,
    index: usize,
    filter: String,
    out: mpsc::Sender<Vec<u8>>,
) {
    let mut command = command;
    let status = match command.spawn() {
        Err(error) => local_run::missing(&error).unwrap_or(1),
        Ok(mut child) => {
            let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
            if let (Some(stdout), Some(stderr)) = (stdout, stderr) {
                tokio::join!(
                    forward(stdout, index, filter.as_bytes(), &out),
                    forward(stderr, index, filter.as_bytes(), &out),
                );
            }
            child
                .wait()
                .await
                .ok()
                .and_then(|status| status.code())
                .map_or(1, |code| code as u32)
        }
    };
    let _ = out
        .send(prefixed(index, format!("{STATUS} {status}").as_bytes()))
        .await;
}

fn refused() -> Failed {
    Failed::Stopped(Failure::Other(
        "이 명령은 이 컴퓨터에서 실행할 수 없습니다.".into(),
    ))
}

/// Ends when every source has ended, the time limit passes or `on_piece` stops it.
pub(super) async fn follow(
    kube: &KubeSettings,
    sources: &[StreamSource],
    limits: Limits,
    mut on_piece: impl FnMut(&[u8]) -> ControlFlow<()>,
) -> Result<Streamed, Failed> {
    let mut followers = JoinSet::new();
    let (out, mut lines) = mpsc::channel(QUEUE);
    for (index, source) in sources.iter().enumerate() {
        let line = logs_line(kube, source);
        let invocation = local_run::parse(&line, &kube.kubectl).ok_or_else(refused)?;
        followers.spawn(follow_one(
            local_run::command(&invocation),
            index,
            source.filter.clone().unwrap_or_default(),
            out.clone(),
        ));
    }
    drop(out);
    let work = async {
        while let Some(piece) = lines.recv().await {
            if on_piece(&piece).is_break() {
                break;
            }
        }
    };
    tokio::time::timeout(limits.timeout, work)
        .await
        .map_err(|_| Failed::Stopped(Failure::TimedOut))?;
    Ok(Streamed {
        stderr: Vec::new(),
        exit: Some(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_filter_applies_only_to_log_lines() {
        assert!(passes(b"2026-11-08T12:00:00Z hit one", b"hit"));
        assert!(!passes(b"2026-11-08T12:00:00Z miss", b"hit"));
        assert!(passes(b"Error from server: not a log line", b"hit"));
        assert!(passes(b"2026-11-08T12:00:00Z anything", b""));
    }

    #[test]
    fn lines_reach_the_reader_in_the_servers_format() {
        assert_eq!(
            prefixed(3, b"2026-11-08T12:00:00Z hello"),
            b"3 2026-11-08T12:00:00Z hello\n"
        );
    }

    #[tokio::test]
    async fn a_line_is_read_whole_and_a_long_one_is_cut() {
        let long = "y".repeat(MAX_LINE_BYTES + 100);
        let text = format!("first\n{long}\nlast");
        let mut reader = BufReader::new(text.as_bytes());
        let mut line = Vec::new();
        assert!(next_line(&mut reader, &mut line).await.unwrap());
        assert_eq!(line, b"first");
        assert!(next_line(&mut reader, &mut line).await.unwrap());
        assert_eq!(line.len(), MAX_LINE_BYTES);
        assert!(next_line(&mut reader, &mut line).await.unwrap());
        assert_eq!(line, b"last");
        assert!(!next_line(&mut reader, &mut line).await.unwrap());
    }
}
