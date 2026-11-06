//! A Finder-launched app gets launchd's minimal PATH, without Homebrew or the user's own tool
//! directories. PodTree and editors need the PATH the user sees in a terminal.
use std::{
    collections::HashSet,
    io::{BufRead, BufReader, Read},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};

const MARKER: &str = "__DACHSTERM_LOGIN_PATH__";
const TIMEOUT: Duration = Duration::from_secs(3);
const MAX_OUTPUT: u64 = 1024 * 1024;
const COMMON_DIRECTORIES: &str = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin";

/// Must run before any other thread starts, because it changes the process environment.
pub fn apply() {
    // A terminal launch already inherited the user's PATH.
    if std::env::var_os("TERM").is_some() {
        return;
    }
    let shell = portable_pty::CommandBuilder::new_default_prog().get_shell();
    let login = ask_shell(&shell, TIMEOUT);
    let current = std::env::var("PATH").unwrap_or_default();
    let path = merge(login.as_deref(), &current);
    // SAFETY: run() calls this first, while the process is still single-threaded.
    unsafe { std::env::set_var("PATH", path) };
}

fn ask_shell(shell: &str, timeout: Duration) -> Option<String> {
    let mut child = Command::new(shell)
        .args(["-ilc", &format!("printf '{MARKER}%s\\n' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (found, result) = mpsc::channel();
    // Stops at the marker or EOF. If a profile's background job keeps the pipe open without
    // printing the marker, this thread lasts only until that job exits.
    std::thread::spawn(move || {
        let lines = BufReader::new(stdout.take(MAX_OUTPUT)).split(b'\n');
        for line in lines.map_while(std::result::Result::ok) {
            if let Some(path) = parse(&String::from_utf8_lossy(&line)) {
                let _ = found.send(path);
                return;
            }
        }
    });
    let path = result.recv_timeout(timeout).ok();
    let _ = child.kill();
    let _ = child.wait();
    path
}

fn parse(line: &str) -> Option<String> {
    let (_, value) = line.split_once(MARKER)?;
    let usable = value.split(':').any(|entry| entry.starts_with('/'))
        && !value.chars().any(char::is_control);
    usable.then(|| value.to_string())
}

fn merge(login: Option<&str>, current: &str) -> String {
    let mut seen = HashSet::new();
    [login.unwrap_or_default(), COMMON_DIRECTORIES, current]
        .iter()
        .flat_map(|path| path.split(':'))
        .filter(|entry| !entry.is_empty() && seen.insert(*entry))
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fake_shell(dir: &tempfile::TempDir, body: &str) -> String {
        let path = dir.path().join("shell");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn parse_ignores_profile_output_and_unusable_values() {
        assert_eq!(parse(&format!("{MARKER}/a:/b")).as_deref(), Some("/a:/b"));
        assert_eq!(parse(&format!("noise{MARKER}/a")).as_deref(), Some("/a"));
        assert_eq!(parse("/a:/b"), None);
        assert_eq!(parse(MARKER), None);
        assert_eq!(parse(&format!("{MARKER}/a\u{1b}[0m")), None);
    }

    #[test]
    fn merge_prefers_login_order_and_keeps_current_entries() {
        assert_eq!(
            merge(Some("/custom:/usr/bin"), "/usr/bin:/bin"),
            format!("/custom:/usr/bin:{COMMON_DIRECTORIES}:/bin")
        );
        assert_eq!(
            merge(None, "/usr/bin"),
            format!("{COMMON_DIRECTORIES}:/usr/bin")
        );
    }

    #[test]
    fn reads_path_from_the_real_login_shell() {
        let path = ask_shell("/bin/zsh", TIMEOUT).unwrap();
        assert!(path.split(':').any(|entry| entry == "/usr/bin"), "{path}");
    }

    #[test]
    fn profile_noise_and_background_jobs_do_not_delay_the_answer() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(&dir, "echo noise\nsleep 30 &\neval \"$2\"");
        assert!(ask_shell(&shell, TIMEOUT).is_some());
    }

    #[test]
    fn hung_shell_and_missing_shell_fall_back() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(&dir, "exec sleep 30");
        let started = std::time::Instant::now();
        assert_eq!(ask_shell(&shell, Duration::from_millis(200)), None);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(ask_shell("/nonexistent/shell", TIMEOUT), None);
    }
}
