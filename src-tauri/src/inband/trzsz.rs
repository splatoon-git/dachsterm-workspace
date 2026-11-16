//! trzsz (CG.8): `tsz` sends files to this app and `trz` takes files from it, in lines of the
//! form `#TYPE:value\n` over the terminal. Values are base64 of zlib-compressed bytes; numbers
//! are plain. This app always asks for the base64 mode, which survives Telnet, serial lines and
//! tmux, and does not send directories. Protocol as trzsz 1.1.7 (`trzsz/libs/transfer.py`).
use super::files::{Download, Upload};
use super::{Progress, Wire};
use crate::storage::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use flate2::{Compression, read::ZlibDecoder, write::ZlibEncoder};
use std::io::{Read, Write};

/// Raw bytes per `#DATA` line this app sends.
const CHUNK: usize = 32 * 1024;
/// A line longer than this is not trzsz; a 10 MiB chunk in base64 stays under it.
const MAX_LINE: usize = 16 * 1024 * 1024;

fn encode(bytes: &[u8]) -> String {
    let mut z = ZlibEncoder::new(Vec::new(), Compression::default());
    // Writing to a Vec cannot fail.
    let _ = z.write_all(bytes);
    STANDARD.encode(z.finish().unwrap_or_default())
}

fn decode(text: &str) -> Result<Vec<u8>> {
    let packed = STANDARD
        .decode(text.trim())
        .map_err(|_| "trzsz 응답 형식 오류".to_string())?;
    let mut out = Vec::new();
    ZlibDecoder::new(&packed[..])
        .take(MAX_LINE as u64)
        .read_to_end(&mut out)
        .map_err(|_| "trzsz 응답 형식 오류".to_string())?;
    Ok(out)
}

/// Reads `#TYPE:` lines from the wire, keeping what follows a line for the next one.
pub(super) struct Lines<'a, W: Wire> {
    wire: &'a mut W,
    buffer: Vec<u8>,
}

impl<'a, W: Wire> Lines<'a, W> {
    pub(super) fn new(wire: &'a mut W, first: Vec<u8>) -> Self {
        Self {
            wire,
            buffer: first,
        }
    }

    /// Whatever arrives next, for tests that act as the server.
    #[cfg(test)]
    pub(super) async fn raw(&mut self) -> Result<Vec<u8>> {
        let mut out = std::mem::take(&mut self.buffer);
        if out.is_empty() {
            out = self.wire.read().await?;
        }
        Ok(out)
    }

    #[cfg(test)]
    pub(super) async fn send_raw(&mut self, bytes: &[u8]) -> Result<()> {
        self.wire.write(bytes.to_vec()).await
    }

    /// The server's bytes after the last line read, for the screen.
    pub(super) fn rest(self) -> Vec<u8> {
        self.buffer
    }

    async fn line(&mut self) -> Result<String> {
        loop {
            if let Some(end) = self.buffer.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = self.buffer.drain(..=end).collect();
                let text = String::from_utf8_lossy(&line);
                return Ok(text
                    .trim_end_matches(['\r', '\n'])
                    .trim_matches('\0')
                    .to_string());
            }
            if self.buffer.len() > MAX_LINE {
                return Err("trzsz 응답이 너무 깁니다.".into());
            }
            let more = self.wire.read().await?;
            self.buffer.extend(more);
        }
    }

    /// The value of the next line of this type. A program in tmux may print status junk before
    /// the line, so only the last `#TYPE:` counts (as trzsz does).
    async fn expect(&mut self, typ: &str) -> Result<String> {
        let line = self.line().await?;
        let mark = format!("#{typ}:");
        if let Some(at) = line.rfind(&mark) {
            return Ok(line[at + mark.len()..].to_string());
        }
        for fail in ["#FAIL:", "#fail:"] {
            if let Some(at) = line.rfind(fail) {
                let why = decode(&line[at + fail.len()..])
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
                    .unwrap_or_default();
                return Err(format!("서버의 trzsz가 중단했습니다: {why}"));
            }
        }
        Err(format!("trzsz 응답 순서 오류({typ} 기대)"))
    }

    async fn number(&mut self, typ: &str) -> Result<u64> {
        self.expect(typ)
            .await?
            .trim()
            .parse()
            .map_err(|_| "trzsz 숫자 형식 오류".to_string())
    }

    async fn bytes(&mut self, typ: &str) -> Result<Vec<u8>> {
        decode(&self.expect(typ).await?)
    }

    async fn send(&mut self, typ: &str, value: &str) -> Result<()> {
        self.wire
            .write(format!("#{typ}:{value}\n").into_bytes())
            .await
    }

    async fn check(&mut self, expected: u64) -> Result<()> {
        if self.number("SUCC").await? != expected {
            return Err("trzsz 확인 값이 맞지 않습니다.".into());
        }
        Ok(())
    }
}

/// What this app tells the server it is: base64 only, no directories.
pub(super) fn action(confirm: bool) -> String {
    let json = serde_json::json!({
        "lang": "rs",
        "confirm": confirm,
        "version": "1.1.7",
        "support_dir": false,
        "binary": false,
        "protocol": 1,
    });
    encode(json.to_string().as_bytes())
}

/// `tsz`: files come from the server into `target`.
pub(super) async fn download<W: Wire>(
    lines: &mut Lines<'_, W>,
    target: &mut Download,
    progress: &mut Progress,
) -> Result<Vec<String>> {
    lines.send("ACT", &action(true)).await?;
    lines.bytes("CFG").await?;
    let count = lines.number("NUM").await?;
    lines.send("SUCC", &count.to_string()).await?;
    let mut saved = Vec::new();
    for _ in 0..count {
        let name = String::from_utf8_lossy(&lines.bytes("NAME").await?).into_owned();
        let mut file = target.create(&name).await?;
        lines.send("SUCC", &encode(file.name().as_bytes())).await?;
        let size = lines.number("SIZE").await?;
        lines.send("SUCC", &size.to_string()).await?;
        progress.file(file.name(), size);
        let mut md5 = md5::Context::new();
        let mut step = 0;
        while step < size {
            let data = lines.bytes("DATA").await?;
            file.write(&data).await?;
            md5.consume(&data);
            step += data.len() as u64;
            progress.step(step);
            lines.send("SUCC", &data.len().to_string()).await?;
        }
        let digest = lines.bytes("MD5").await?;
        if digest != md5.finalize().0 {
            return Err(format!("{}의 MD5가 맞지 않습니다.", file.name()));
        }
        lines.send("SUCC", &encode(&digest)).await?;
        saved.push(file.finish(target).await?);
    }
    lines
        .send(
            "EXIT",
            &encode(format!("Saved {} file(s)", saved.len()).as_bytes()),
        )
        .await?;
    Ok(saved)
}

/// `trz`: the chosen files go to the server.
pub(super) async fn upload<W: Wire>(
    lines: &mut Lines<'_, W>,
    files: &mut Upload,
    progress: &mut Progress,
) -> Result<Vec<String>> {
    lines.send("ACT", &action(true)).await?;
    lines.bytes("CFG").await?;
    let count = files.len() as u64;
    lines.send("NUM", &count.to_string()).await?;
    lines.check(count).await?;
    let mut sent = Vec::new();
    while let Some(mut file) = files.next().await? {
        lines.send("NAME", &encode(file.name().as_bytes())).await?;
        let remote = String::from_utf8_lossy(&lines.bytes("SUCC").await?).into_owned();
        let size = file.size();
        lines.send("SIZE", &size.to_string()).await?;
        lines.check(size).await?;
        progress.file(file.name(), size);
        let mut md5 = md5::Context::new();
        let mut step = 0;
        loop {
            let data = file.read(CHUNK).await?;
            if data.is_empty() {
                break;
            }
            md5.consume(&data);
            lines.send("DATA", &encode(&data)).await?;
            lines.check(data.len() as u64).await?;
            step += data.len() as u64;
            progress.step(step);
        }
        if step != size {
            return Err(format!("{}의 크기가 전송 중에 바뀌었습니다.", file.name()));
        }
        let digest = md5.finalize().0;
        lines.send("MD5", &encode(&digest)).await?;
        if lines.bytes("SUCC").await? != digest {
            return Err(format!("{}의 MD5 확인이 맞지 않습니다.", file.name()));
        }
        sent.push(remote);
    }
    lines
        .send(
            "EXIT",
            &encode(format!("Sent {} file(s)", sent.len()).as_bytes()),
        )
        .await?;
    Ok(sent)
}

/// Turns the server's transfer down: the server prints `Cancelled` and ends.
pub(super) async fn decline<W: Wire>(lines: &mut Lines<'_, W>) -> Result<()> {
    lines.send("ACT", &action(false)).await
}

/// Stops a transfer under way; the server deletes what it wrote and ends.
pub(super) fn stop_line() -> Vec<u8> {
    format!("#fail:{}\n", encode(b"Stopped")).into_bytes()
}

#[cfg(test)]
pub(super) mod tests {
    use super::super::testing::{pipe, progress, sample};
    use super::*;

    /// `tsz a.bin` as trzsz 1.1.7 runs it, on the server's end of the pipe.
    pub(in crate::inband) async fn tsz<W: Wire>(
        mut wire: W,
        name: &str,
        data: Vec<u8>,
    ) -> Result<String> {
        let mut lines = Lines::new(&mut wire, Vec::new());
        let act: serde_json::Value = serde_json::from_slice(&lines.bytes("ACT").await?).unwrap();
        assert_eq!(act["binary"], false);
        if act["confirm"] != true {
            return Ok("Cancelled".into());
        }
        lines
            .send("CFG", &encode(br#"{"lang":"py","protocol":1}"#))
            .await?;
        lines.send("NUM", "1").await?;
        lines.check(1).await?;
        lines.send("NAME", &encode(name.as_bytes())).await?;
        let local = String::from_utf8(lines.bytes("SUCC").await?).unwrap();
        lines.send("SIZE", &data.len().to_string()).await?;
        lines.check(data.len() as u64).await?;
        for chunk in data.chunks(1000) {
            lines.send("DATA", &encode(chunk)).await?;
            lines.check(chunk.len() as u64).await?;
        }
        let digest = md5::compute(&data).0;
        lines.send("MD5", &encode(&digest)).await?;
        assert_eq!(lines.bytes("SUCC").await?, digest);
        let exit = String::from_utf8(lines.bytes("EXIT").await?).unwrap();
        Ok(format!("{local}|{exit}"))
    }

    /// `trz` as trzsz 1.1.7 runs it: takes the files and answers each step.
    async fn trz<W: Wire>(mut wire: W) -> Result<Vec<(String, Vec<u8>)>> {
        let mut lines = Lines::new(&mut wire, Vec::new());
        lines.bytes("ACT").await?;
        lines.send("CFG", &encode(br#"{"lang":"py"}"#)).await?;
        let count = lines.number("NUM").await?;
        lines.send("SUCC", &count.to_string()).await?;
        let mut got = Vec::new();
        for _ in 0..count {
            let name = String::from_utf8(lines.bytes("NAME").await?).unwrap();
            lines.send("SUCC", &encode(name.as_bytes())).await?;
            let size = lines.number("SIZE").await?;
            lines.send("SUCC", &size.to_string()).await?;
            let mut data = Vec::new();
            while (data.len() as u64) < size {
                let chunk = lines.bytes("DATA").await?;
                lines.send("SUCC", &chunk.len().to_string()).await?;
                data.extend(chunk);
            }
            let digest = lines.bytes("MD5").await?;
            assert_eq!(digest, md5::compute(&data).0);
            lines.send("SUCC", &encode(&digest)).await?;
            got.push((name, data));
        }
        lines.bytes("EXIT").await?;
        Ok(got)
    }

    #[tokio::test]
    async fn receives_from_tsz_into_a_new_file_with_its_checksum() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.bin"), b"old").unwrap();
        let (mut ours, theirs) = pipe();
        let data = sample(70_000);
        let server = tokio::spawn(tsz(theirs, "../a.bin", data.clone()));
        let mut target = Download::new(dir.path().to_path_buf());
        let (mut progress, seen) = progress();
        let mut lines = Lines::new(&mut ours, Vec::new());
        let saved = download(&mut lines, &mut target, &mut progress)
            .await
            .unwrap();
        assert_eq!(saved, ["a (1).bin"]);
        assert_eq!(server.await.unwrap().unwrap(), "a (1).bin|Saved 1 file(s)");
        assert_eq!(std::fs::read(dir.path().join("a (1).bin")).unwrap(), data);
        assert_eq!(std::fs::read(dir.path().join("a.bin")).unwrap(), b"old");
        assert!(seen.lock().unwrap().iter().any(|n| n.total == 70_000));
    }

    #[tokio::test]
    async fn sends_the_picked_files_to_trz() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (sample(100_000), b"second\n".to_vec());
        std::fs::write(dir.path().join("big.bin"), &a).unwrap();
        std::fs::write(dir.path().join("note.txt"), &b).unwrap();
        let (mut ours, theirs) = pipe();
        let server = tokio::spawn(trz(theirs));
        let mut files = Upload::new(vec![
            dir.path().join("big.bin"),
            dir.path().join("note.txt"),
        ]);
        let (mut progress, _) = progress();
        let mut lines = Lines::new(&mut ours, Vec::new());
        let sent = upload(&mut lines, &mut files, &mut progress).await.unwrap();
        assert_eq!(sent, ["big.bin", "note.txt"]);
        let got = server.await.unwrap().unwrap();
        assert_eq!(
            got,
            [("big.bin".to_string(), a), ("note.txt".to_string(), b)]
        );
    }

    #[tokio::test]
    async fn a_refusal_cancels_and_a_server_failure_is_said() {
        let (mut ours, theirs) = pipe();
        let server = tokio::spawn(tsz(theirs, "x", vec![1]));
        decline(&mut Lines::new(&mut ours, Vec::new()))
            .await
            .unwrap();
        assert_eq!(server.await.unwrap().unwrap(), "Cancelled");
        let (mut ours, mut theirs) = pipe();
        let fail = format!("#ACT:x\n#FAIL:{}\n", encode(b"No permission"));
        theirs.write(fail.into_bytes()).await.unwrap();
        let mut lines = Lines::new(&mut ours, Vec::new());
        lines.bytes("ACT").await.ok();
        let err = lines.bytes("CFG").await.unwrap_err();
        assert!(err.contains("No permission"), "{err}");
    }

    #[tokio::test]
    async fn status_junk_before_a_line_is_skipped_as_tmux_prints_it() {
        let (mut ours, mut theirs) = pipe();
        theirs
            .write(b"\x1b[1;1Hjunk#NUM:3\r\n".to_vec())
            .await
            .unwrap();
        let mut lines = Lines::new(&mut ours, Vec::new());
        assert_eq!(lines.number("NUM").await.unwrap(), 3);
    }
}
