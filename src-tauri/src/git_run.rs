//! Runs Git for any tab with the same safety settings (GE.7). Over SSH and in WSL the commands
//! become one `sh` script; on this PC there may be no shell, so each runs on its own without one.
//!
//! Commands in one call run in order, stop at the first failure, and have a NUL byte between their
//! outputs. A failure is an ordinary `Output` with that command's exit code.
use crate::{
    git_status::check_folder,
    local::{Locals, Target},
    remote_exec::{self, Failure, Limits, Output, quote},
    source::{GitSource, Source},
    ssh::{Connections, Host},
    storage::Result,
};
use russh::client;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
};
use tokio::{
    io::{self, AsyncRead, AsyncReadExt},
    process::Command,
};

/// A repository's own settings must not start a program, and optional locks would collide with
/// the user's own Git commands. Pathspecs are read literally, so a file named `:(top)*` is that
/// file and not a pattern. Clean filters cannot be turned off by name and remain, which the user
/// guide states.
const SAFE_ENV: [(&str, &str); 3] = [
    ("LC_ALL", "C"),
    ("GIT_OPTIONAL_LOCKS", "0"),
    ("GIT_LITERAL_PATHSPECS", "1"),
];
const SAFE_CONFIG: [&str; 2] = ["-c", "core.fsmonitor=false"];

const MAX_ERROR: u64 = 64 * 1024;
/// The exit code of a command `sh` could not find. This PC's missing git reports the same.
pub(crate) const NO_GIT: u32 = 127;

/// Where the Git commands run, decided from a tab's source.
pub enum GitHost {
    Remote(Arc<client::Handle<Host>>),
    Wsl(Target),
    /// This PC's git, without a shell. `None` when none is installed.
    Native(Option<PathBuf>),
}

/// Stops before any Git command when a working tree file is over `max`. The output then starts
/// with `large <size>`, and otherwise with `diff`, each on a line of its own.
pub struct SizeGuard<'a> {
    pub path: &'a str,
    pub max: u64,
}

impl GitHost {
    pub fn ssh(connections: &Connections, id: &str) -> Result<Self> {
        Ok(Self::Remote(connections.handle(id)?))
    }

    pub async fn local(target: Target) -> Result<Self> {
        if target.kind == "wsl" {
            return Ok(Self::Wsl(target));
        }
        let program = tokio::task::spawn_blocking(crate::git_credential::git_program)
            .await
            .map_err(|e| e.to_string())?;
        Ok(Self::Native(program))
    }

    pub async fn resolve(
        connections: &Connections,
        locals: &Locals,
        source: &Source,
    ) -> Result<Self> {
        match source.for_git()? {
            GitSource::Ssh(id) => Self::ssh(connections, id),
            GitSource::Local(id) => Self::local(locals.target(id)?).await,
        }
    }

    /// Git prints this PC's real path, which is not always how the shell spells the folder.
    pub(crate) fn spells_folder(&self) -> bool {
        matches!(self, Self::Native(_))
    }

    /// What to tell the user when Git could not be found here.
    pub(crate) fn no_git_text(&self) -> &'static str {
        match self {
            Self::Remote(_) => "서버에 git이 없습니다.",
            Self::Wsl(_) => "WSL 배포판에 git이 없습니다.",
            Self::Native(_) => "이 PC에서 git을 찾지 못했습니다.",
        }
    }

    /// A shell reports the folder it is in, so it must be absolute. WSL folders are Linux paths.
    fn check_folder(&self, folder: &str) -> Result<()> {
        if !matches!(self, Self::Native(_)) {
            return check_folder(folder);
        }
        if !Path::new(folder).is_absolute() || folder.len() > 4096 || folder.contains('\0') {
            return Err("Git 저장소 폴더가 올바르지 않습니다.".into());
        }
        Ok(())
    }
}

/// The arguments after `git`, written out as owned strings.
pub(crate) fn args<const N: usize>(parts: [&str; N]) -> Vec<String> {
    parts.map(String::from).to_vec()
}

fn shell_command(args: &[String]) -> String {
    let env: Vec<String> = SAFE_ENV.iter().map(|(k, v)| format!("{k}={v}")).collect();
    let args: Vec<String> = args.iter().map(|a| quote(a)).collect();
    format!(
        "{} git {} {}",
        env.join(" "),
        SAFE_CONFIG.join(" "),
        args.join(" ")
    )
}

fn script(folder: &str, guard: Option<&SizeGuard>, commands: &[Vec<String>]) -> String {
    let mut script = format!("cd -- {} || exit 2\n", quote(folder));
    if let Some(SizeGuard { path, max }) = guard {
        let target = quote(path);
        // A file that cannot be read has no size and is left for Git to report, such as a deleted
        // one.
        script.push_str(&format!(
            "S=$(wc -c < {target} 2>/dev/null | tr -d ' ')\n\
             case $S in ''|*[!0-9]*) ;; *) if [ \"$S\" -gt {max} ]; then \
             printf 'large %s\\n' \"$S\"; exit 0; fi ;; esac\nprintf 'diff\\n'\n"
        ));
    }
    let lines: Vec<String> = commands.iter().map(|c| shell_command(c)).collect();
    script.push_str(&lines.join(" && printf '\\000' && "));
    script
}

/// `wsl.exe` runs the script in the distribution's own `sh` and git, since Windows git on
/// `\\wsl.localhost` is slow and refuses repositories owned by the Linux user.
pub(crate) fn wsl_args(target: &Target, script: String) -> Vec<String> {
    let distribution = target.id.strip_prefix("wsl:").unwrap_or(&target.name);
    ["--distribution", distribution, "--exec", "sh", "-c"]
        .map(String::from)
        .into_iter()
        .chain([script])
        .collect()
}

fn native_command(program: &Path, folder: &str, args: &[String]) -> Command {
    let mut command = Command::new(program);
    command
        .envs(SAFE_ENV)
        .arg("-C")
        .arg(folder)
        .args(SAFE_CONFIG)
        .args(args);
    command
}

/// Keeps at most `max` bytes and reads on to the end. A process writing to a pipe nobody empties
/// would wait forever, which a commit hook with a lot to say otherwise does.
async fn read_capped<R: AsyncRead + Unpin>(
    from: &mut R,
    max: u64,
    into: &mut Vec<u8>,
) -> io::Result<()> {
    (&mut *from).take(max).read_to_end(into).await?;
    io::copy(from, &mut io::sink()).await.map(|_| ())
}

/// One process, its output cut at the limit. The process is killed when the call is dropped.
async fn process(mut command: Command, max_output: usize) -> std::result::Result<Output, Failure> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|e| Failure::Other(format!("Git을 실행하지 못했습니다: {e}")))?;
    let (Some(mut stdout), Some(mut stderr)) = (child.stdout.take(), child.stderr.take()) else {
        return Err(Failure::Other("Git 출력을 읽을 수 없습니다.".into()));
    };
    let (mut out, mut err) = (Vec::new(), Vec::new());
    let (read_out, read_err) = tokio::join!(
        read_capped(&mut stdout, max_output as u64 + 1, &mut out),
        read_capped(&mut stderr, MAX_ERROR, &mut err),
    );
    if out.len() > max_output {
        return Err(Failure::TooLarge);
    }
    read_out
        .and(read_err)
        .map_err(|e| Failure::Other(format!("Git 출력을 읽지 못했습니다: {e}")))?;
    let status = child
        .wait()
        .await
        .map_err(|e| Failure::Other(format!("Git 종료를 확인하지 못했습니다: {e}")))?;
    Ok(Output {
        stdout: out,
        stderr: err,
        exit: status.code().and_then(|c| u32::try_from(c).ok()),
    })
}

/// What the shell's `cd || exit 2` and the size guard do in `script`.
async fn native(
    program: &Path,
    folder: &str,
    guard: Option<&SizeGuard<'_>>,
    commands: &[Vec<String>],
    max_output: usize,
) -> std::result::Result<Output, Failure> {
    let failed = |exit, stderr: &str| Output {
        stdout: Vec::new(),
        stderr: stderr.as_bytes().to_vec(),
        exit: Some(exit),
    };
    if !tokio::fs::metadata(folder).await.is_ok_and(|m| m.is_dir()) {
        return Ok(failed(2, "폴더에 들어갈 수 없습니다."));
    }
    let mut stdout = Vec::new();
    if let Some(SizeGuard { path, max }) = guard {
        let size = tokio::fs::metadata(Path::new(folder).join(path))
            .await
            .ok()
            .filter(|m| m.is_file())
            .map(|m| m.len());
        if let Some(size) = size.filter(|size| size > max) {
            return Ok(Output {
                stdout: format!("large {size}\n").into_bytes(),
                stderr: Vec::new(),
                exit: Some(0),
            });
        }
        stdout.extend_from_slice(b"diff\n");
    }
    let mut last = failed(0, "");
    for (index, args) in commands.iter().enumerate() {
        if index > 0 {
            stdout.push(0);
        }
        let left = max_output.saturating_sub(stdout.len());
        last = process(native_command(program, folder, args), left).await?;
        stdout.append(&mut last.stdout);
        if last.exit != Some(0) {
            break;
        }
    }
    last.stdout = stdout;
    Ok(last)
}

async fn run(
    host: &GitHost,
    folder: &str,
    guard: Option<&SizeGuard<'_>>,
    commands: &[Vec<String>],
    limits: Limits,
) -> std::result::Result<Output, Failure> {
    host.check_folder(folder).map_err(Failure::Other)?;
    let timeout = limits.timeout;
    let max_output = limits.max_output;
    let work = async {
        match host {
            GitHost::Remote(handle) => {
                remote_exec::run(handle, &script(folder, guard, commands), limits).await
            }
            GitHost::Wsl(target) => {
                let mut command = Command::new(&target.program);
                command.args(wsl_args(target, script(folder, guard, commands)));
                process(command, max_output).await
            }
            GitHost::Native(None) => Ok(Output {
                stdout: Vec::new(),
                stderr: host.no_git_text().as_bytes().to_vec(),
                exit: Some(NO_GIT),
            }),
            GitHost::Native(Some(program)) => {
                native(program, folder, guard, commands, max_output).await
            }
        }
    };
    tokio::time::timeout(timeout, work)
        .await
        .unwrap_or(Err(Failure::TimedOut))
}

/// Runs Git commands in `folder`. Each item is the arguments after `git`.
pub async fn git_run(
    host: &GitHost,
    folder: &str,
    commands: &[Vec<String>],
    limits: Limits,
) -> std::result::Result<Output, Failure> {
    run(host, folder, None, commands, limits).await
}

/// `git_run`, unless a file is over the guard's limit.
pub async fn git_run_guarded(
    host: &GitHost,
    folder: &str,
    guard: &SizeGuard<'_>,
    commands: &[Vec<String>],
    limits: Limits,
) -> std::result::Result<Output, Failure> {
    run(host, folder, Some(guard), commands, limits).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const LIMITS: Limits = Limits {
        timeout: Duration::from_secs(10),
        max_output: 1024 * 1024,
    };

    #[test]
    fn the_script_quotes_everything_and_keeps_the_safe_settings() {
        let commands = vec![args(["log", "$(reboot) x"]), args(["show", "it's"])];
        let text = script("/srv/a b", None, &commands);
        assert!(text.starts_with("cd -- '/srv/a b' || exit 2\n"), "{text}");
        assert!(text.contains("'log' '$(reboot) x' && printf '\\000' && "));
        assert!(text.contains("'show' 'it'\\''s'"));
        assert_eq!(text.matches("-c core.fsmonitor=false").count(), 2);
        assert_eq!(text.matches("GIT_OPTIONAL_LOCKS=0").count(), 2);
        assert_eq!(text.matches("GIT_LITERAL_PATHSPECS=1").count(), 2);
        assert_eq!(text.matches("LC_ALL=C").count(), 2);
    }

    #[test]
    fn the_guard_runs_first_and_quotes_its_path() {
        let guard = SizeGuard {
            path: "-x $(y)",
            max: 5,
        };
        let text = script("/r", Some(&guard), &[args(["diff"])]);
        assert!(text.contains("wc -c < '-x $(y)'"), "{text}");
        assert!(text.find("wc -c").unwrap() < text.find("'diff'").unwrap());
        assert!(text.contains("-gt 5"));
    }

    #[test]
    fn wsl_runs_one_script_in_its_distribution() {
        let wsl = Target::for_test("wsl:Ubuntu 22", "wsl");
        let run = wsl_args(&wsl, "S".into());
        assert_eq!(
            run,
            ["--distribution", "Ubuntu 22", "--exec", "sh", "-c", "S"]
        );
    }

    #[test]
    fn folders_are_checked_by_where_git_runs() {
        let wsl = GitHost::Wsl(Target::for_test("wsl:U", "wsl"));
        assert!(wsl.check_folder("/home/a").is_ok());
        assert!(wsl.check_folder("C:\\repo").is_err());
        let native = GitHost::Native(None);
        assert!(native.check_folder("relative").is_err());
        assert!(native.check_folder("").is_err());
        let absolute = if cfg!(windows) { "C:\\repo" } else { "/repo" };
        assert!(native.check_folder(absolute).is_ok());
    }

    #[tokio::test]
    async fn a_missing_git_reads_like_a_shell_that_cannot_find_it() {
        let folder = std::env::temp_dir();
        let host = GitHost::Native(None);
        let done = git_run(&host, folder.to_str().unwrap(), &[args(["status"])], LIMITS)
            .await
            .unwrap();
        assert_eq!(done.exit, Some(NO_GIT));
        assert_eq!(
            String::from_utf8_lossy(&done.stderr),
            "이 PC에서 git을 찾지 못했습니다."
        );
    }

    fn real_git() -> Option<GitHost> {
        crate::git_credential::git_program().map(|p| GitHost::Native(Some(p)))
    }

    /// Runs this PC's real git; skipped where none is installed.
    #[tokio::test]
    async fn runs_real_git_in_order_and_stops_at_a_failure() {
        let Some(host) = real_git() else { return };
        let repo = std::env::temp_dir().join(format!("dachsterm-run-{}", std::process::id()));
        std::fs::create_dir_all(&repo).unwrap();
        let folder = repo.to_str().unwrap();
        let init = git_run(&host, folder, &[args(["init", "-q"])], LIMITS).await;
        assert_eq!(init.unwrap().exit, Some(0));

        let both = [
            args(["rev-parse", "--is-inside-work-tree"]),
            args(["rev-parse", "--is-bare-repository"]),
        ];
        let done = git_run(&host, folder, &both, LIMITS).await.unwrap();
        assert_eq!(
            (done.exit, done.stdout.as_slice()),
            (Some(0), &b"true\n\0false\n"[..])
        );

        let stops = [args(["no-such-command"]), args(["rev-parse", "--git-dir"])];
        let failed = git_run(&host, folder, &stops, LIMITS).await.unwrap();
        assert_ne!(failed.exit, Some(0));
        assert!(failed.stdout.is_empty(), "the second command did not run");

        let gone = repo.join("gone");
        let exit = git_run(&host, gone.to_str().unwrap(), &both, LIMITS)
            .await
            .unwrap();
        assert_eq!(exit.exit, Some(2));

        let guard = SizeGuard {
            path: "big",
            max: 2,
        };
        let version = [args(["--version"])];
        std::fs::write(repo.join("big"), "12345").unwrap();
        let large = git_run_guarded(&host, folder, &guard, &version, LIMITS)
            .await
            .unwrap();
        assert_eq!(large.stdout, b"large 5\n");
        std::fs::write(repo.join("big"), "1").unwrap();
        let small = git_run_guarded(&host, folder, &guard, &version, LIMITS)
            .await
            .unwrap();
        assert!(small.stdout.starts_with(b"diff\ngit version"));
        std::fs::remove_dir_all(&repo).unwrap();
    }
}
