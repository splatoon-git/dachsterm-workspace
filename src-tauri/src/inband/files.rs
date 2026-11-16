//! The only files an in-band transfer touches: new files in the folder the user picked, and the
//! files the user picked to send. A server's file name is reduced to a plain name in that
//! folder, never overwrites a file, and a file left half-written is removed.
use crate::storage::Result;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

const MAX_NAME: usize = 200;

/// A file name a server gave, made safe to create in the chosen folder: the last path part only,
/// without control characters or characters Windows refuses, and not a device name.
pub(super) fn safe_name(remote: &str) -> String {
    let last = remote.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = last
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut name = cleaned.trim().trim_matches('.').to_string();
    while name.len() > MAX_NAME {
        name.pop();
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || ((stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.len() == 4
            && stem.as_bytes()[3].is_ascii_digit());
    if name.is_empty() {
        "received".into()
    } else if reserved {
        format!("_{name}")
    } else {
        name
    }
}

/// `report.txt`, then `report (1).txt`, `report (2).txt`, …
fn numbered(name: &str, n: usize) -> String {
    if n == 0 {
        return name.into();
    }
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} ({n}).{ext}"),
        _ => format!("{name} ({n})"),
    }
}

/// Files coming in, created in the folder the user picked.
pub(super) struct Download {
    folder: PathBuf,
    /// The file being written, removed if the transfer stops before it is complete.
    partial: Option<PathBuf>,
}

pub(super) struct Incoming {
    file: tokio::fs::File,
    name: String,
    path: PathBuf,
}

impl Download {
    pub(super) fn new(folder: PathBuf) -> Self {
        Self {
            folder,
            partial: None,
        }
    }

    pub(super) fn folder(&self) -> &Path {
        &self.folder
    }

    /// Creates a new file for the server's name. An existing file is never opened.
    pub(super) async fn create(&mut self, remote: &str) -> Result<Incoming> {
        let base = safe_name(remote);
        for n in 0..1000 {
            let name = numbered(&base, n);
            let path = self.folder.join(&name);
            match tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .await
            {
                Ok(file) => {
                    self.partial = Some(path.clone());
                    return Ok(Incoming { file, name, path });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err(format!("{name}을 저장 폴더에 만들 수 없습니다.")),
            }
        }
        Err(format!("{base}과 같은 이름의 파일이 너무 많습니다."))
    }

    /// The file finished; it is no longer removed on a stop.
    pub(super) fn complete(&mut self, path: &Path) {
        if self.partial.as_deref() == Some(path) {
            self.partial = None;
        }
    }

    /// Removes the file left half-written when the transfer stopped.
    pub(super) async fn discard_partial(&mut self) {
        if let Some(path) = self.partial.take() {
            // Removing is best effort: the transfer already failed and says so.
            let _ = tokio::fs::remove_file(path).await;
        }
    }
}

impl Incoming {
    pub(super) fn name(&self) -> &str {
        &self.name
    }

    pub(super) async fn write(&mut self, data: &[u8]) -> Result<()> {
        self.file
            .write_all(data)
            .await
            .map_err(|_| format!("{}에 쓰지 못했습니다.", self.name))
    }

    /// Flushes the file and gives its name.
    pub(super) async fn finish(mut self, download: &mut Download) -> Result<String> {
        self.file
            .flush()
            .await
            .map_err(|_| format!("{}에 쓰지 못했습니다.", self.name))?;
        download.complete(&self.path);
        Ok(self.name)
    }
}

/// Files going out, in the order the user picked them.
pub(super) struct Upload {
    paths: std::collections::VecDeque<PathBuf>,
}

pub(super) struct Outgoing {
    file: tokio::fs::File,
    name: String,
    size: u64,
}

impl Upload {
    pub(super) fn new(paths: Vec<PathBuf>) -> Self {
        Self {
            paths: paths.into(),
        }
    }

    pub(super) fn len(&self) -> usize {
        self.paths.len()
    }

    pub(super) async fn next(&mut self) -> Result<Option<Outgoing>> {
        let Some(path) = self.paths.pop_front() else {
            return Ok(None);
        };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "file".into());
        let file = tokio::fs::File::open(&path)
            .await
            .map_err(|_| format!("{name}을 열 수 없습니다."))?;
        let meta = file
            .metadata()
            .await
            .map_err(|_| format!("{name}을 읽을 수 없습니다."))?;
        if !meta.is_file() {
            return Err(format!(
                "{name}은 파일이 아닙니다. 폴더는 보낼 수 없습니다."
            ));
        }
        Ok(Some(Outgoing {
            file,
            name,
            size: meta.len(),
        }))
    }
}

impl Outgoing {
    pub(super) fn name(&self) -> &str {
        &self.name
    }

    pub(super) fn size(&self) -> u64 {
        self.size
    }

    /// Up to `max` bytes from where the last read ended. Empty at the end.
    pub(super) async fn read(&mut self, max: usize) -> Result<Vec<u8>> {
        let mut buffer = vec![0; max];
        let n = self
            .file
            .read(&mut buffer)
            .await
            .map_err(|_| format!("{}을 읽을 수 없습니다.", self.name))?;
        buffer.truncate(n);
        Ok(buffer)
    }

    /// Up to `max` bytes at `offset`: ZMODEM asks again from where the receiver lost data.
    pub(super) async fn read_at(&mut self, offset: u64, max: usize) -> Result<Vec<u8>> {
        self.file
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|_| format!("{}을 읽을 수 없습니다.", self.name))?;
        self.read(max).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_name_becomes_a_plain_name_in_the_folder() {
        for (remote, local) in [
            ("report.txt", "report.txt"),
            ("../../etc/passwd", "passwd"),
            ("C:\\Windows\\win.ini", "win.ini"),
            ("..", "received"),
            ("", "received"),
            ("a\u{1b}[31mb", "a_[31mb"),
            ("x:y?.txt", "x_y_.txt"),
            ("CON.txt", "_CON.txt"),
            ("com1", "_com1"),
            ("  .hidden. ", "hidden"),
            ("한글 파일.bin", "한글 파일.bin"),
        ] {
            assert_eq!(safe_name(remote), local, "{remote:?}");
        }
        assert!(safe_name(&"가".repeat(300)).len() <= MAX_NAME);
        assert_eq!(numbered("report.txt", 2), "report (2).txt");
        assert_eq!(numbered("Makefile", 1), "Makefile (1)");
    }

    #[tokio::test]
    async fn never_overwrites_and_removes_a_half_written_file() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"keep").unwrap();
        let mut download = Download::new(dir.path().to_path_buf());
        let mut first = download.create("a.txt").await.unwrap();
        assert_eq!(first.name(), "a (1).txt");
        first.write(b"new").await.unwrap();
        assert_eq!(first.finish(&mut download).await.unwrap(), "a (1).txt");
        let mut second = download.create("../a.txt").await.unwrap();
        second.write(b"half").await.unwrap();
        download.discard_partial().await;
        assert_eq!(std::fs::read(dir.path().join("a.txt")).unwrap(), b"keep");
        assert_eq!(std::fs::read(dir.path().join("a (1).txt")).unwrap(), b"new");
        assert!(!dir.path().join("a (2).txt").exists());
    }
}
