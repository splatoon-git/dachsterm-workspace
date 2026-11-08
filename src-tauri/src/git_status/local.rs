//! Git status of a folder in a local or WSL tab (DX.15). The query, limits and result are those
//! of a remote folder; only where Git runs differs: this PC's git for a local shell, and the
//! distribution's own git for WSL, since Windows git on `\\wsl.localhost` is slow and refuses
//! repositories owned by the Linux user.
use super::{GitStatus, MAX_OUTPUT, StopReason, TIMEOUT, check_folder, outcome, status_script};
use crate::{AppState, local::Target, remote_exec::Output, storage::Result};
use std::{path::Path, process::Stdio};
use tokio::{io::AsyncReadExt, process::Command};

const MAX_ERROR: u64 = 64 * 1024;

enum Ran {
    Done(Output),
    Stopped(StopReason),
}

/// A shell reports the folder it is in, so it must be absolute. WSL folders are Linux paths.
fn check_local_folder(target: &Target, folder: &str) -> Result<()> {
    if target.kind == "wsl" {
        return check_folder(folder);
    }
    if !Path::new(folder).is_absolute() || folder.len() > 4096 || folder.contains('\0') {
        return Err("Git 저장소 폴더가 올바르지 않습니다.".into());
    }
    Ok(())
}

/// `wsl.exe` runs the remote query script in the distribution, so both use one script.
fn wsl_args(target: &Target, folder: &str) -> Vec<String> {
    let distribution = target.id.strip_prefix("wsl:").unwrap_or(&target.name);
    ["--distribution", distribution, "--exec", "sh", "-c"]
        .map(String::from)
        .into_iter()
        .chain([status_script(folder)])
        .collect()
}

/// The settings of `SAFE_GIT`, given as arguments because no shell runs here.
fn native_git(program: &Path, folder: &str, args: &[&str]) -> Command {
    let mut command = Command::new(program);
    command
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(["-C", folder, "-c", "core.fsmonitor=false"])
        .args(args);
    command
}

/// Runs within the remote query's limits. A process past the time limit is killed on drop.
async fn run(mut command: Command) -> Result<Ran> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Git을 실행하지 못했습니다: {e}"))?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err("Git 출력을 읽을 수 없습니다.".into());
    };
    let work = async move {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let (mut stdout, mut stderr) = (stdout.take(MAX_OUTPUT as u64 + 1), stderr.take(MAX_ERROR));
        let (read_out, read_err) =
            tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
        if out.len() > MAX_OUTPUT {
            return Ok(Ran::Stopped(StopReason::TooLarge));
        }
        read_out
            .and(read_err)
            .map_err(|e| format!("Git 출력을 읽지 못했습니다: {e}"))?;
        let status = child
            .wait()
            .await
            .map_err(|e| format!("Git 종료를 확인하지 못했습니다: {e}"))?;
        Ok(Ran::Done(Output {
            stdout: out,
            stderr: err,
            exit: status.code().and_then(|c| u32::try_from(c).ok()),
        }))
    };
    tokio::time::timeout(TIMEOUT, work)
        .await
        .unwrap_or(Ok(Ran::Stopped(StopReason::Timeout)))
}

async fn native(folder: &str) -> Result<GitStatus> {
    let program = tokio::task::spawn_blocking(crate::git_credential::git_program)
        .await
        .map_err(|e| e.to_string())?;
    let Some(program) = program else {
        return Ok(GitStatus::NotRepo {
            detail: "이 PC에서 git을 찾지 못했습니다.".into(),
        });
    };
    let paths = ["rev-parse", "--show-toplevel", "--show-prefix"];
    let root = match run(native_git(&program, folder, &paths)).await? {
        Ran::Stopped(reason) => return Ok(GitStatus::Stopped { reason }),
        Ran::Done(output) if output.exit != Some(0) => return outcome(&output),
        Ran::Done(output) => root_as_shell_spells(folder, &String::from_utf8_lossy(&output.stdout)),
    };
    let status = ["status", "--porcelain=v2", "--branch", "-z"];
    match run(native_git(&program, folder, &status)).await? {
        Ran::Stopped(reason) => Ok(GitStatus::Stopped { reason }),
        Ran::Done(mut output) => {
            output.stdout.splice(0..0, format!("{root}\n").into_bytes());
            outcome(&output)
        }
    }
}

/// The repository root in the folder's own spelling, so the app can match the shell's folders
/// and the file panel's rows against it. Git prints the real path instead, which differs for a
/// Windows short name (`ADMINI~1`), a `subst` drive or a symbolic link on the way. Removing the
/// prefix Git reports from the folder gives the same root as the shell sees it.
fn root_as_shell_spells(folder: &str, rev_parse: &str) -> String {
    let mut lines = rev_parse.lines().map(|l| l.trim_end_matches('\r'));
    let toplevel = lines.next().unwrap_or_default().to_string();
    let depth = lines
        .next()
        .unwrap_or_default()
        .split('/')
        .filter(|s| !s.is_empty())
        .count();
    let mut spelled = folder.to_string();
    if cfg!(windows) {
        spelled = spelled.replace('\\', "/");
        if spelled.as_bytes().get(1) == Some(&b':') {
            spelled[..1].make_ascii_uppercase();
        }
    }
    let mut parts: Vec<&str> = spelled.trim_end_matches('/').split('/').collect();
    // A folder shorter than its own prefix cannot be cut; Git's own path is used then.
    if parts.len() <= depth {
        return toplevel;
    }
    parts.truncate(parts.len() - depth);
    match parts.join("/") {
        root if root.is_empty() || root.ends_with(':') => format!("{root}/"),
        root => root,
    }
}

pub async fn query(target: &Target, folder: &str) -> Result<GitStatus> {
    check_local_folder(target, folder)?;
    if target.kind != "wsl" {
        return native(folder).await;
    }
    let mut command = Command::new(&target.program);
    command.args(wsl_args(target, folder));
    match run(command).await? {
        Ran::Stopped(reason) => Ok(GitStatus::Stopped { reason }),
        Ran::Done(output) => outcome(&output),
    }
}

#[tauri::command]
pub async fn local_git_status(
    state: tauri::State<'_, AppState>,
    target_id: String,
    folder: String,
) -> Result<GitStatus> {
    let target = state.locals.target(&target_id)?;
    query(&target, &folder).await
}

#[cfg(test)]
mod tests {
    use super::{check_local_folder, query, root_as_shell_spells, wsl_args};

    #[test]
    fn the_root_keeps_the_folder_spelling() {
        let real = "/real/repo\nsrc/deep/\n";
        assert_eq!(
            root_as_shell_spells("/link/repo/src/deep", real),
            "/link/repo"
        );
        assert_eq!(
            root_as_shell_spells("/link/repo/src/deep/", real),
            "/link/repo"
        );
        assert_eq!(
            root_as_shell_spells("/link/repo", "/real/repo\n\n"),
            "/link/repo"
        );
        assert_eq!(root_as_shell_spells("/src", "/\nsrc/\n"), "/");
        assert_eq!(root_as_shell_spells("/", "/\n\n"), "/");
        assert_eq!(root_as_shell_spells("/a", "/r\nx/y/z/\n"), "/r");
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_root_keeps_short_names_and_uses_slashes() {
        let real = "C:/Users/Administrator/repo\nsrc/\n";
        assert_eq!(
            root_as_shell_spells(r"c:\Users\ADMINI~1\repo\src", real),
            "C:/Users/ADMINI~1/repo"
        );
        assert_eq!(root_as_shell_spells(r"C:\src", "C:/\nsrc/\n"), "C:/");
        assert_eq!(root_as_shell_spells(r"D:\", "D:/\n\n"), "D:/");
    }
    use crate::{git_status::GitStatus, local::Target};

    #[test]
    fn wsl_runs_the_remote_script_in_its_distribution() {
        let wsl = Target::for_test("wsl:Ubuntu 22", "wsl");
        let args = wsl_args(&wsl, "/home/a/it's");
        assert_eq!(
            args[..5],
            ["--distribution", "Ubuntu 22", "--exec", "sh", "-c"]
        );
        assert!(args[5].starts_with("cd -- '/home/a/it'\\''s' && "));
        assert!(check_local_folder(&wsl, "C:\\repo").is_err());
    }

    #[test]
    fn local_folders_must_be_absolute() {
        let shell = Target::for_test("shell", "shell");
        assert!(check_local_folder(&shell, "relative").is_err());
        assert!(check_local_folder(&shell, "").is_err());
        let absolute = if cfg!(windows) { "C:\\repo" } else { "/repo" };
        assert!(check_local_folder(&shell, absolute).is_ok());
    }

    fn git(folder: &std::path::Path, args: &[&str]) {
        let program = crate::git_credential::git_program().unwrap();
        let status = std::process::Command::new(program)
            .current_dir(folder)
            .args(args)
            .output()
            .unwrap();
        assert!(status.status.success(), "{args:?}");
    }

    /// Runs this PC's real git; skipped where none is installed.
    #[tokio::test]
    async fn reads_a_real_repository_and_quietly_skips_other_folders() {
        if crate::git_credential::git_program().is_none() {
            return;
        }
        let base = std::env::temp_dir().join(format!("dachsterm-git-{}", std::process::id()));
        let repo = base.join("repo 한글");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("src").join("new.txt"), "x").unwrap();
        let shell = Target::for_test("shell", "shell");
        let inside = repo.join("src");
        match query(&shell, inside.to_str().unwrap()).await.unwrap() {
            GitStatus::Repo {
                root,
                branch,
                entries,
                ..
            } => {
                // The temporary folder may be a Windows short name, which Git expands.
                assert!(root.ends_with("/repo 한글"), "{root}");
                assert!(
                    root.starts_with('/') || root.as_bytes()[1] == b':',
                    "{root}"
                );
                assert_eq!(branch.as_deref(), Some("main"));
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].path, "src/");
            }
            other => panic!("{other:?}"),
        }
        let outside = query(&shell, base.to_str().unwrap()).await.unwrap();
        assert!(matches!(outside, GitStatus::NotRepo { .. }), "{outside:?}");
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// Needs a WSL distribution with git: `DACHSTERM_WSL=<name> cargo test ... -- --ignored`.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore]
    async fn reads_a_repository_inside_wsl() {
        let name = std::env::var("DACHSTERM_WSL").expect("DACHSTERM_WSL");
        let wsl = std::path::PathBuf::from(std::env::var("SystemRoot").unwrap())
            .join("System32")
            .join("wsl.exe");
        let mut target = Target::for_test(&format!("wsl:{name}"), "wsl");
        target.program = wsl.clone();
        let folder = format!("/tmp/dachsterm git {} it's", std::process::id());
        let setup = "mkdir -p \"$1/src\" && cd \"$1\" && git init -q && touch src/new.txt";
        let made = std::process::Command::new(&wsl)
            .args([
                "--distribution",
                &name,
                "--exec",
                "sh",
                "-c",
                setup,
                "sh",
                &folder,
            ])
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");
        match query(&target, &format!("{folder}/src")).await.unwrap() {
            GitStatus::Repo { root, entries, .. } => {
                assert_eq!(root, folder);
                assert_eq!(entries[0].path, "src/");
            }
            other => panic!("{other:?}"),
        }
        let outside = query(&target, "/").await.unwrap();
        assert!(matches!(outside, GitStatus::NotRepo { .. }), "{outside:?}");
        std::process::Command::new(&wsl)
            .args(["--distribution", &name, "--exec", "rm", "-rf", &folder])
            .status()
            .unwrap();
    }
}
