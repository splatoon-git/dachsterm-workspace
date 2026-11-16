//! ZMODEM (CG.8) over the terminal, with the `zmodem2` state machines: `sz` on the server sends
//! to this app, `rz` on the server takes from it. This module owns only the I/O around them.
use super::files::{Download, Incoming, Outgoing, Upload};
use super::{Progress, Wire};
use crate::storage::Result;
use std::time::Duration;
use zmodem2::{Action, Event, FileInfo, Position, Receiver, Sender};

/// How long without a byte from the server before the protocol's own retry.
const STEP: Duration = Duration::from_secs(5);
/// Retries without progress before the transfer is given up.
const MAX_SILENT_STEPS: u32 = 8;
/// What a stop sends: ten CAN and ten backspaces, as lrzsz sends it.
pub(super) fn cancel_sequence() -> Vec<u8> {
    [[0x18u8; 10], [0x08u8; 10]].concat()
}

fn failed(e: zmodem2::Error) -> String {
    format!("ZMODEM 오류({e}). tmux 안에서는 ZMODEM이 깨지므로 trzsz(tsz·trz)를 쓰세요.")
}

/// Bytes from the server not yet taken by the state machine.
struct Input {
    pending: Vec<u8>,
    silent: u32,
}

impl Input {
    /// More server bytes, or `None` when a retry step passed without any.
    async fn more<W: Wire>(&mut self, wire: &mut W) -> Result<bool> {
        match wire.read_for(STEP).await? {
            Some(bytes) => {
                self.pending.extend(bytes);
                self.silent = 0;
                Ok(true)
            }
            None => {
                self.silent += 1;
                if self.silent > MAX_SILENT_STEPS {
                    return Err("서버가 응답하지 않아 ZMODEM 전송을 멈췄습니다.".into());
                }
                Ok(false)
            }
        }
    }
}

/// After `SessionCompleted` the state machine may still hold its last bytes ("OO", the final
/// ZFIN): `poll` gives events before wire bytes, so they go out here.
async fn flush<W: Wire>(wire: &mut W, mut next: impl FnMut() -> Option<Vec<u8>>) -> Result<()> {
    while let Some(bytes) = next() {
        wire.write(bytes).await?;
    }
    Ok(())
}

/// What a `poll` asked for, copied out so the state machine can be called again.
enum Step {
    Wire(Vec<u8>),
    WriteFile(Vec<u8>),
    ReadFile(u64, usize),
    Started(Vec<u8>),
    FileDone,
    SessionDone,
    Aborted,
    Idle,
}

fn step(action: Action<'_>) -> Step {
    match action {
        Action::WriteWire(b) => Step::Wire(b.to_vec()),
        Action::WriteFile(b) => Step::WriteFile(b.to_vec()),
        Action::ReadFile { offset, max_len } => Step::ReadFile(offset.get().into(), max_len),
        Action::Event(Event::FileStarted(info)) => Step::Started(info.name.to_vec()),
        Action::Event(Event::FileCompleted) => Step::FileDone,
        Action::Event(Event::SessionCompleted) => Step::SessionDone,
        Action::Event(Event::Aborted) => Step::Aborted,
        _ => Step::Idle,
    }
}

/// `sz`: files from the server into `target`. `first` holds the server's first header.
/// Returns the saved names and the server's bytes after the session.
pub(super) async fn download<W: Wire>(
    wire: &mut W,
    first: Vec<u8>,
    target: &mut Download,
    progress: &mut Progress,
) -> Result<(Vec<String>, Vec<u8>)> {
    // The SSH, Telnet and serial paths all deliver in order, so the sender may stream.
    let mut rx = Receiver::with_flow_control(0, true).map_err(failed)?;
    rx.set_manual_file_accept(true);
    let mut input = Input {
        pending: first,
        silent: 0,
    };
    let mut file: Option<Incoming> = None;
    let mut written = 0u64;
    let mut saved = Vec::new();
    loop {
        match step(rx.poll()) {
            Step::Wire(bytes) => {
                wire.write(bytes.clone()).await?;
                rx.wire_written(bytes.len());
            }
            Step::WriteFile(bytes) => {
                let current = file.as_mut().ok_or("ZMODEM 순서 오류")?;
                current.write(&bytes).await?;
                rx.file_written(bytes.len()).map_err(failed)?;
                written += bytes.len() as u64;
                progress.step(written);
            }
            Step::Started(name) => {
                let created = target.create(&String::from_utf8_lossy(&name)).await?;
                // The size is not needed to receive; the bar shows bytes until it ends.
                progress.file(created.name(), 0);
                file = Some(created);
                written = 0;
                rx.accept_file_at(0).map_err(failed)?;
            }
            Step::FileDone => {
                if let Some(done) = file.take() {
                    saved.push(done.finish(target).await?);
                }
            }
            Step::SessionDone => {
                flush(wire, || match step(rx.poll()) {
                    Step::Wire(b) => {
                        rx.wire_written(b.len());
                        Some(b)
                    }
                    _ => None,
                })
                .await?;
                break;
            }
            Step::Aborted => return Err("서버가 ZMODEM 전송을 취소했습니다.".into()),
            Step::ReadFile(..) => return Err("ZMODEM 순서 오류".into()),
            Step::Idle => {
                if !input.pending.is_empty() {
                    let used = rx.submit_wire(&input.pending).map_err(failed)?;
                    input.pending.drain(..used);
                    if used > 0 {
                        continue;
                    }
                }
                if !input.more(wire).await? {
                    rx.timeout().map_err(failed)?;
                }
            }
        }
    }
    // `sz` sends its "OO" after the last header; take it here, not on the screen.
    let wait = tokio::time::Instant::now() + Duration::from_millis(500);
    while !input.pending.windows(2).any(|w| w == b"OO") {
        let left = wait.saturating_duration_since(tokio::time::Instant::now());
        match wire.read_for(left).await? {
            Some(more) if !left.is_zero() => input.pending.extend(more),
            Some(more) => {
                input.pending.extend(more);
                break;
            }
            None => break,
        }
    }
    Ok((saved, after_session(input.pending)))
}

/// The server's bytes after a session, for the screen: without the header's line end and XON,
/// nor `sz`'s "OO" (over and out).
fn after_session(mut rest: Vec<u8>) -> Vec<u8> {
    let skip = rest
        .iter()
        .position(|b| !matches!(b, b'\r' | b'\n' | 0x8a | 0x11 | b'O'))
        .unwrap_or(rest.len());
    rest.drain(..skip.min(6));
    rest
}

/// `rz`: the chosen files to the server. `first` holds the server's ZRINIT.
pub(super) async fn upload<W: Wire>(
    wire: &mut W,
    first: Vec<u8>,
    files: &mut Upload,
    progress: &mut Progress,
) -> Result<(Vec<String>, Vec<u8>)> {
    let mut tx = Sender::new().map_err(failed)?;
    tx.set_streaming_window(usize::MAX);
    let mut input = Input {
        pending: first,
        silent: 0,
    };
    let mut current: Option<Outgoing> = files.next().await?;
    let mut sent = Vec::new();
    match &current {
        Some(f) => {
            let info = FileInfo::new(f.name().as_bytes(), Some(size(f)?)).with_mode(0o100_644);
            tx.start_file(info).map_err(failed)?;
            progress.file(f.name(), f.size());
        }
        None => tx.finish().map_err(failed)?,
    }
    loop {
        match step(tx.poll()) {
            Step::Wire(bytes) => {
                wire.write(bytes.clone()).await?;
                tx.wire_written(bytes.len());
            }
            Step::ReadFile(offset, max) => {
                let f = current.as_mut().ok_or("ZMODEM 순서 오류")?;
                let data = f.read_at(offset, max).await?;
                if data.is_empty() {
                    return Err(format!("{}이 전송 중에 줄었습니다.", f.name()));
                }
                progress.step(offset + data.len() as u64);
                tx.submit_file(&data).map_err(failed)?;
            }
            Step::FileDone => {
                if let Some(done) = current.take() {
                    sent.push(done.name().to_string());
                }
                current = files.next().await?;
                match &current {
                    Some(f) => {
                        let info =
                            FileInfo::new(f.name().as_bytes(), Some(size(f)?)).with_mode(0o100_644);
                        tx.start_file(info).map_err(failed)?;
                        progress.file(f.name(), f.size());
                    }
                    None => tx.finish().map_err(failed)?,
                }
            }
            Step::SessionDone => {
                flush(wire, || match step(tx.poll()) {
                    Step::Wire(b) => {
                        tx.wire_written(b.len());
                        Some(b)
                    }
                    _ => None,
                })
                .await?;
                break;
            }
            Step::Aborted => return Err("서버가 ZMODEM 전송을 취소했습니다.".into()),
            Step::WriteFile(_) | Step::Started(_) => return Err("ZMODEM 순서 오류".into()),
            Step::Idle => {
                if !input.pending.is_empty() {
                    let used = tx.submit_wire(&input.pending).map_err(failed)?;
                    input.pending.drain(..used);
                    if used > 0 {
                        continue;
                    }
                }
                if !input.more(wire).await? {
                    tx.timeout().map_err(failed)?;
                }
            }
        }
    }
    Ok((sent, after_session(input.pending)))
}

/// ZMODEM carries sizes in 32 bits.
fn size(f: &Outgoing) -> Result<Position> {
    u32::try_from(f.size()).map(Position::new).map_err(|_| {
        format!(
            "{}은 4GiB를 넘어 ZMODEM으로 보낼 수 없습니다. trz를 쓰세요.",
            f.name()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::super::testing::{pipe, progress, sample};
    use super::*;

    /// `sz` with the other `zmodem2` state machine on the server's end of the pipe.
    async fn sz<W: Wire>(mut wire: W, files: Vec<(String, Vec<u8>)>) -> Result<()> {
        let mut tx = Sender::new().map_err(failed)?;
        let mut queue = files.into_iter();
        let mut current = queue.next();
        if let Some((name, data)) = &current {
            let size = Position::new(data.len() as u32);
            tx.start_file(FileInfo::new(name.as_bytes(), Some(size)))
                .map_err(failed)?;
        }
        let mut pending = Vec::new();
        loop {
            match step(tx.poll()) {
                Step::Wire(b) => {
                    wire.write(b.clone()).await?;
                    tx.wire_written(b.len());
                }
                Step::ReadFile(offset, max) => {
                    let data = &current.as_ref().unwrap().1;
                    let end = (offset as usize + max).min(data.len());
                    tx.submit_file(&data[offset as usize..end])
                        .map_err(failed)?;
                }
                Step::FileDone => {
                    current = queue.next();
                    match &current {
                        Some((name, data)) => {
                            let size = Position::new(data.len() as u32);
                            tx.start_file(FileInfo::new(name.as_bytes(), Some(size)))
                                .map_err(failed)?;
                        }
                        None => tx.finish().map_err(failed)?,
                    }
                }
                Step::SessionDone => {
                    flush(&mut wire, || match step(tx.poll()) {
                        Step::Wire(b) => {
                            tx.wire_written(b.len());
                            Some(b)
                        }
                        _ => None,
                    })
                    .await?;
                    wire.write(b"after\r\n".to_vec()).await?;
                    return Ok(());
                }
                Step::Idle => {
                    if pending.is_empty() {
                        match wire.read_for(STEP).await? {
                            Some(b) => pending.extend(b),
                            None => tx.timeout().map_err(failed)?,
                        }
                    }
                    let used = tx.submit_wire(&pending).map_err(failed)?;
                    pending.drain(..used);
                }
                _ => return Err("unexpected".into()),
            }
        }
    }

    /// `rz` with the other state machine: collects what arrives.
    async fn rz<W: Wire>(mut wire: W) -> Result<Vec<(String, Vec<u8>)>> {
        let mut rx = Receiver::new().map_err(failed)?;
        let mut got: Vec<(String, Vec<u8>)> = Vec::new();
        let mut pending = Vec::new();
        loop {
            match step(rx.poll()) {
                Step::Wire(b) => {
                    wire.write(b.clone()).await?;
                    rx.wire_written(b.len());
                }
                Step::WriteFile(b) => {
                    got.last_mut().unwrap().1.extend(&b);
                    rx.file_written(b.len()).map_err(failed)?;
                }
                Step::Started(name) => got.push((String::from_utf8(name).unwrap(), Vec::new())),
                Step::FileDone => {}
                Step::SessionDone => {
                    flush(&mut wire, || match step(rx.poll()) {
                        Step::Wire(b) => {
                            rx.wire_written(b.len());
                            Some(b)
                        }
                        _ => None,
                    })
                    .await?;
                    // The sender's "OO" follows; a real `rz` reads it before it exits.
                    let _ = wire.read_for(Duration::from_millis(200)).await;
                    return Ok(got);
                }
                Step::Idle => {
                    if pending.is_empty() {
                        match wire.read_for(STEP).await? {
                            Some(b) => pending.extend(b),
                            None => rx.timeout().map_err(failed)?,
                        }
                    }
                    let used = rx.submit_wire(&pending).map_err(failed)?;
                    pending.drain(..used);
                }
                _ => return Err("unexpected".into()),
            }
        }
    }

    #[tokio::test]
    async fn receives_files_from_sz_and_leaves_what_follows_for_the_screen() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (sample(65_536), sample(3000));
        let (mut ours, theirs) = pipe();
        let server = tokio::spawn(sz(
            theirs,
            vec![("dir/a.bin".into(), a.clone()), ("b.bin".into(), b.clone())],
        ));
        // The detector hands over the server's first header with the rest of the stream.
        let mut target = Download::new(dir.path().to_path_buf());
        let (mut progress, _) = progress();
        let (saved, rest) = download(&mut ours, Vec::new(), &mut target, &mut progress)
            .await
            .unwrap();
        server.await.unwrap().unwrap();
        assert_eq!(saved, ["a.bin", "b.bin"]);
        assert_eq!(std::fs::read(dir.path().join("a.bin")).unwrap(), a);
        assert_eq!(std::fs::read(dir.path().join("b.bin")).unwrap(), b);
        // Anything after the session that already arrived is the screen's.
        assert!(rest.is_empty() || rest.starts_with(b"after"), "{rest:?}");
        assert_eq!(after_session(b"\r\x8a\x11OOafter".to_vec()), b"after");
    }

    #[tokio::test]
    async fn sends_the_picked_files_to_rz() {
        let dir = tempfile::tempdir().unwrap();
        let a = sample(65_536 + 17);
        std::fs::write(dir.path().join("a.bin"), &a).unwrap();
        std::fs::write(dir.path().join("empty"), b"").unwrap();
        let (mut ours, theirs) = pipe();
        let server = tokio::spawn(rz(theirs));
        let mut files = Upload::new(vec![dir.path().join("a.bin"), dir.path().join("empty")]);
        let (mut progress, _) = progress();
        let (sent, _) = upload(&mut ours, Vec::new(), &mut files, &mut progress)
            .await
            .unwrap();
        assert_eq!(sent, ["a.bin", "empty"]);
        let got = server.await.unwrap().unwrap();
        assert_eq!(
            got,
            [("a.bin".to_string(), a), ("empty".to_string(), Vec::new())]
        );
    }
}
