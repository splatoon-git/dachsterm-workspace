//! The agent on this PC (design §9.7): a child process with pipes. There is no network to lose, so
//! there is no detached runner; it ends with the chat, or with the app when its input closes.
use super::runner::LineBuffer;
use crate::storage::Result;
use std::{
    ops::ControlFlow,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
};

const MAX_ERROR: usize = 1000;

pub struct LocalAgent {
    stdin: tokio::sync::Mutex<ChildStdin>,
    child: std::sync::Mutex<Child>,
}

/// The program's file names as it may be installed on this OS, preferred first. On Windows an npm
/// install (how `codex` is usually installed) leaves only a `.cmd` launcher; `Command` runs one
/// through `cmd.exe` and refuses arguments it cannot quote safely, and the agents' are fixed.
fn file_names(program: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![format!("{program}.exe"), format!("{program}.cmd")]
    } else {
        vec![program.to_string()]
    }
}

/// Where to look: `PATH`, which `login_path` has already filled on macOS, `~/.local/bin`, where the
/// official installer puts `claude` on every OS, and on Windows npm's global folder, which an app
/// started before the install may not have on its `PATH`.
fn search_dirs() -> Vec<PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    dirs.extend(dirs::home_dir().map(|home| home.join(".local").join("bin")));
    if cfg!(windows) {
        dirs.extend(std::env::var_os("APPDATA").map(|data| PathBuf::from(data).join("npm")));
    }
    dirs
}

/// The first of `names` found in `dirs`. An earlier name wins over an earlier folder, so a real
/// executable anywhere is taken before a launcher script.
fn find(names: &[String], dirs: &[PathBuf]) -> Option<PathBuf> {
    names.iter().find_map(|name| {
        dirs.iter()
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    })
}

pub fn locate(program: &str) -> Result<PathBuf> {
    find(&file_names(program), &search_dirs()).ok_or_else(|| {
        format!("이 PC에서 {program}을(를) 찾을 수 없습니다. 설치하고 로그인한 뒤 다시 여세요.")
    })
}

/// The folder to start in. Empty means the home folder.
pub fn folder(folder: &str) -> Result<PathBuf> {
    if folder.is_empty() {
        return dirs::home_dir().ok_or_else(|| "홈 폴더를 찾을 수 없습니다.".into());
    }
    let path = Path::new(folder);
    if path.is_absolute() && path.is_dir() {
        Ok(path.to_path_buf())
    } else {
        Err("이 PC에서 그 폴더를 찾을 수 없습니다.".into())
    }
}

pub fn start(
    program: &Path,
    args: &[String],
    folder: &Path,
) -> Result<(LocalAgent, ChildStdout, ChildStderr)> {
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(folder)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // No console window behind a GUI app.
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| "에이전트를 실행할 수 없습니다.".to_string())?;
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err("에이전트를 실행할 수 없습니다.".into());
    };
    let agent = LocalAgent {
        stdin: tokio::sync::Mutex::new(stdin),
        child: std::sync::Mutex::new(child),
    };
    Ok((agent, stdout, stderr))
}

impl LocalAgent {
    pub async fn send(&self, line: &str) -> Result<()> {
        let mut stdin = self.stdin.lock().await;
        let written = async {
            stdin.write_all(line.as_bytes()).await?;
            stdin.write_all(b"\n").await?;
            stdin.flush().await
        };
        written
            .await
            .map_err(|_| "에이전트가 종료되어 보낼 수 없습니다.".into())
    }
    pub fn stop(&self) {
        // Already gone is fine: there is nothing left to stop.
        let _ = self.child.lock().unwrap().start_kill();
    }
}

/// How reading ended: `Ok(true)` when the agent's output closed, `Ok(false)` when the reader
/// stopped it.
pub async fn read_lines(
    mut stdout: impl AsyncRead + Unpin,
    mut on_line: impl FnMut(&str) -> ControlFlow<()>,
) -> Result<bool> {
    let mut lines = LineBuffer::default();
    let mut chunk = vec![0; 64 * 1024];
    loop {
        let read = stdout.read(&mut chunk).await.unwrap_or(0);
        if read == 0 {
            return Ok(true);
        }
        let flow = lines.feed(&chunk[..read], &mut |line| {
            on_line(&String::from_utf8_lossy(line))
        });
        if lines.too_long {
            return Err("에이전트 출력의 한 줄이 너무 깁니다.".into());
        }
        if flow.is_break() {
            return Ok(false);
        }
    }
}

/// The end of what the agent wrote to stderr, for telling the user why it stopped.
pub async fn error_tail(mut stderr: ChildStderr) -> Option<String> {
    let mut kept = Vec::new();
    let mut chunk = vec![0; 8192];
    while let Ok(read) = stderr.read(&mut chunk).await {
        if read == 0 {
            break;
        }
        kept.extend_from_slice(&chunk[..read]);
        if kept.len() > MAX_ERROR {
            kept.drain(..kept.len() - MAX_ERROR);
        }
    }
    let text = String::from_utf8_lossy(&kept).trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_an_executable_before_a_launcher_script() {
        let root = std::env::temp_dir().join(format!("dachsterm-locate-{}", uuid::Uuid::new_v4()));
        let (npm, bin) = (root.join("npm"), root.join("bin"));
        std::fs::create_dir_all(&npm).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(npm.join("codex.cmd"), "").unwrap();
        let names = ["codex.exe".to_string(), "codex.cmd".to_string()];
        let dirs = [npm.clone(), bin.clone()];
        assert_eq!(find(&names, &dirs), Some(npm.join("codex.cmd")));
        std::fs::write(bin.join("codex.exe"), "").unwrap();
        assert_eq!(find(&names, &dirs), Some(bin.join("codex.exe")));
        assert_eq!(find(&["claude.exe".to_string()], &dirs), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn rejects_relative_and_missing_folders() {
        assert!(folder("relative/path").is_err());
        assert!(folder("/definitely/not/here/dachsterm").is_err());
        assert!(folder("").is_ok());
        let here = std::env::temp_dir();
        assert_eq!(folder(here.to_str().unwrap()).unwrap(), here);
    }

    #[tokio::test]
    async fn reads_lines_until_the_output_closes() {
        let mut seen = Vec::new();
        let closed = read_lines(&b"one\ntwo\npartial"[..], |line| {
            seen.push(line.to_string());
            ControlFlow::Continue(())
        })
        .await
        .unwrap();
        assert!(closed);
        assert_eq!(seen, ["one", "two"]);
    }

    #[tokio::test]
    async fn stops_when_the_reader_does() {
        let closed = read_lines(&b"a\nb\n"[..], |_| ControlFlow::Break(()))
            .await
            .unwrap();
        assert!(!closed);
    }
}
