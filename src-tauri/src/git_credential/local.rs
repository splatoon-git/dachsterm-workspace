//! Where an allowed request's value comes from on this PC: a token saved in the app, then the
//! user's own Git credential helpers through `git credential fill`. Everything here blocks
//! (OS store, files, a child process) and runs off the async threads.
use super::{Credential, protocol::Request};
use crate::{
    AppState,
    storage::{GitCredential, Result, Store},
    vault::Vault,
};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

/// A credential manager may show its sign-in window and wait for the user.
pub const FILL_TIME: Duration = Duration::from_secs(120);
const APPROVE_TIME: Duration = Duration::from_secs(30);
const MAX_OUTPUT: u64 = 64 * 1024;
pub const MAX_USERNAME: usize = 256;
pub const MAX_PASSWORD: usize = 16384;

fn same_host(entry: &GitCredential, request: &Request) -> bool {
    entry.protocol == request.protocol
        && entry.host.eq_ignore_ascii_case(&request.host)
        && request
            .username
            .as_ref()
            .is_none_or(|u| *u == entry.username)
}

/// A token saved in the app for this host. A locked vault or a missing OS entry falls through to
/// the next source, as if nothing were saved.
fn saved(store: &Store, vault: &Vault, request: &Request) -> Option<Credential> {
    let entry = store
        .git_credentials()
        .ok()?
        .into_iter()
        .find(|entry| same_host(entry, request))?;
    let password = vault.get(store, &entry.secret_ref).ok()?;
    Some(Credential {
        username: Zeroizing::new(entry.username),
        password,
    })
}

/// The allowed request's value: saved in the app, then this PC's Git helpers.
pub fn find(store: &Store, vault: &Vault, request: &Request) -> Option<Credential> {
    if let Some(found) = saved(store, vault, request) {
        return Some(found);
    }
    let program = git_program()?;
    let found = fill(git(&program, "fill"), request)?;
    // The helper keeps what it just produced, so the next push does not sign in again.
    let _ = run(
        git(&program, "approve"),
        &described(request, Some(&found)),
        APPROVE_TIME,
    );
    Some(found)
}

/// "Save on this PC": the OS store first and without a lock, then the reference under
/// `mutation`. Only a value the user typed on the card gets here; a server's value never does.
pub fn save(state: &AppState, request: &Request, credential: &Credential) -> Result<()> {
    let reference = state.vault.save(&state.store, &credential.password)?;
    let _guard = state.mutation.lock().unwrap();
    let result = state.store.set_git_credential(GitCredential {
        protocol: request.protocol.clone(),
        host: request.host.to_ascii_lowercase(),
        username: credential.username.to_string(),
        secret_ref: reference,
    });
    let _ = state.store.cleanup_credentials();
    result
}

/// git's input format. Every value was checked for line breaks and controls before it got here.
fn described(request: &Request, credential: Option<&Credential>) -> Zeroizing<String> {
    let mut text = Zeroizing::new(format!(
        "protocol={}\nhost={}\n",
        request.protocol, request.host
    ));
    if let Some(path) = &request.path {
        text.push_str(&format!("path={path}\n"));
    }
    match credential {
        Some(found) => text.push_str(&format!(
            "username={}\npassword={}\n",
            *found.username, *found.password
        )),
        None => {
            if let Some(username) = &request.username {
                text.push_str(&format!("username={username}\n"));
            }
        }
    }
    text.push('\n');
    text
}

fn fill(command: Command, request: &Request) -> Option<Credential> {
    let output = run(command, &described(request, None), FILL_TIME)?;
    let text = std::str::from_utf8(&output).ok()?;
    let (mut username, mut password) = (None, None);
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("username=") {
            username = Some(Zeroizing::new(value.to_string()));
        } else if let Some(value) = line.strip_prefix("password=") {
            password = Some(Zeroizing::new(value.to_string()));
        }
    }
    let (username, password) = (username?, password?);
    let usable = super::protocol::usable_value(&username, MAX_USERNAME)
        && super::protocol::usable_value(&password, MAX_PASSWORD);
    usable.then_some(Credential { username, password })
}

/// `git credential <action>` with no console window and no terminal prompt. The user's own
/// settings, such as a credential manager's interactive mode, are left as they are.
fn git(program: &Path, action: &str) -> Command {
    let mut command = Command::new(program);
    command
        .args(["credential", action])
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

fn run(mut command: Command, input: &str, limit: Duration) -> Option<Zeroizing<Vec<u8>>> {
    let mut child = command.spawn().ok()?;
    let written = child.stdin.take()?.write_all(input.as_bytes()).is_ok();
    let stdout = child.stdout.take()?;
    let (done, result) = mpsc::channel();
    // Ends at EOF. A helper that left a process holding the pipe keeps it until that one exits.
    std::thread::spawn(move || {
        let mut output = Zeroizing::new(Vec::new());
        let read = stdout.take(MAX_OUTPUT).read_to_end(&mut output).is_ok();
        let _ = done.send(read.then_some(output));
    });
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => break None,
        }
    };
    let Some(status) = status else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    let output = result.recv_timeout(Duration::from_secs(2)).ok().flatten()?;
    (written && status.success()).then_some(output)
}

fn on_path(name: &str, skip: &[&str]) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .filter(|dir| dir.is_absolute() && !skip.iter().any(|s| dir == Path::new(s)))
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// The git this PC's tabs run: the user's pick from Settings, or else the automatic search.
pub fn git_program() -> Option<PathBuf> {
    crate::git_config::program::current()
}

/// This PC's git, never by bare name (engineering-rules §11).
#[cfg(windows)]
pub fn find_git_program() -> Option<PathBuf> {
    on_path("git.exe", &[]).or_else(|| {
        let installed = PathBuf::from(std::env::var_os("ProgramFiles")?)
            .join("Git")
            .join("cmd")
            .join("git.exe");
        installed.is_file().then_some(installed)
    })
}

/// `login_path` already put the user's terminal PATH and the Homebrew folders in front.
/// `/usr/bin/git` is only a stub that opens an installer while the Command Line Tools are missing.
#[cfg(target_os = "macos")]
pub fn find_git_program() -> Option<PathBuf> {
    on_path("git", &["/usr/bin"])
        .or_else(|| {
            ["/opt/homebrew/bin/git", "/usr/local/bin/git"]
                .map(PathBuf::from)
                .into_iter()
                .find(|p| p.is_file())
        })
        .or_else(|| command_line_tools().then(|| PathBuf::from("/usr/bin/git")))
}

#[cfg(target_os = "macos")]
pub fn command_line_tools() -> bool {
    Command::new("/usr/bin/xcode-select")
        .arg("-p")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn find_git_program() -> Option<PathBuf> {
    on_path("git", &[])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(username: Option<&str>) -> Request {
        Request {
            protocol: "https".into(),
            host: "git.test:3000".into(),
            path: None,
            username: username.map(Into::into),
        }
    }

    #[test]
    fn a_saved_token_matches_its_host_and_user() {
        let entry = GitCredential {
            protocol: "https".into(),
            host: "git.test:3000".into(),
            username: "me".into(),
            secret_ref: "r".into(),
        };
        assert!(same_host(&entry, &request(None)));
        assert!(same_host(&entry, &request(Some("me"))));
        assert!(!same_host(&entry, &request(Some("other"))));
        let mut upper = request(None);
        upper.host = "GIT.test:3000".into();
        assert!(same_host(&entry, &upper));
        let mut port = request(None);
        port.host = "git.test".into();
        assert!(!same_host(&entry, &port), "another port is another server");
    }

    #[test]
    fn git_reads_the_same_fields_back() {
        let mut asked = request(Some("me"));
        asked.path = Some("r.git".into());
        assert_eq!(
            *described(&asked, None),
            "protocol=https\nhost=git.test:3000\npath=r.git\nusername=me\n\n"
        );
    }

    /// The real `git credential` with an isolated HOME and a `store` helper; the user's own
    /// helpers and saved values are never touched. Skipped where git is not installed.
    #[test]
    fn fill_reads_an_isolated_store_and_gives_up_quietly() {
        let Some(program) = git_program() else {
            return;
        };
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join("gitconfig");
        let store = home.path().join("store");
        let token = uuid::Uuid::new_v4().simple().to_string();
        std::fs::write(&store, format!("https://me:{token}@git.test:3000\n")).unwrap();
        let store = store.display().to_string().replace('\\', "/");
        std::fs::write(
            &config,
            format!("[credential]\n\thelper = \"store --file '{store}'\"\n"),
        )
        .unwrap();
        let isolated = |action| {
            let mut command = git(&program, action);
            command
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", &config)
                .env("HOME", home.path())
                .env("XDG_CONFIG_HOME", home.path());
            command
        };
        let found = fill(isolated("fill"), &request(None)).expect("the stored value");
        assert_eq!(*found.username, "me");
        assert_eq!(*found.password, token);
        let mut missing = request(None);
        missing.host = "nothing.test".into();
        let started = Instant::now();
        assert!(fill(isolated("fill"), &missing).is_none());
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "no prompt waits"
        );
    }
}
