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
const CONFIG_MARKER: &str = "__DACHSTERM_LOGIN_KUBECONFIG__";
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
    let path = merge(login.as_ref().map(|l| l.path.as_str()), &current);
    // SAFETY: run() calls this first, while the process is still single-threaded.
    unsafe { std::env::set_var("PATH", path) };
    // A local cluster's kubeconfig is often chosen in the shell profile, like `PATH` (KV.11).
    if std::env::var_os("KUBECONFIG").is_none()
        && let Some(kubeconfig) = login.and_then(|l| l.kubeconfig)
    {
        // SAFETY: as above.
        unsafe { std::env::set_var("KUBECONFIG", kubeconfig) };
    }
}

/// What the user's terminal would know.
struct Login {
    path: String,
    kubeconfig: Option<String>,
}

fn ask_shell(shell: &str, timeout: Duration) -> Option<Login> {
    let report = format!("printf '{MARKER}%s\\n{CONFIG_MARKER}%s\\n' \"$PATH\" \"$KUBECONFIG\"");
    let mut child = Command::new(shell)
        .args(["-ilc", &report])
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
        let mut path = None;
        for line in lines.map_while(std::result::Result::ok) {
            let line = String::from_utf8_lossy(&line);
            if path.is_none() {
                path = parse(&line);
            } else if let Some((_, value)) = line.split_once(CONFIG_MARKER) {
                let kubeconfig = usable_config(value);
                let _ = found.send(Login {
                    path: path.take().unwrap_or_default(),
                    kubeconfig,
                });
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

fn usable_config(value: &str) -> Option<String> {
    (!value.is_empty() && !value.chars().any(char::is_control)).then(|| value.to_string())
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
        let login = ask_shell("/bin/zsh", TIMEOUT).unwrap();
        let path = login.path;
        assert!(path.split(':').any(|entry| entry == "/usr/bin"), "{path}");
    }

    #[test]
    fn the_shells_kubeconfig_comes_with_its_path() {
        let dir = tempfile::tempdir().unwrap();
        let shell = fake_shell(&dir, "KUBECONFIG=/a/config\nexport KUBECONFIG\neval \"$2\"");
        let login = ask_shell(&shell, TIMEOUT).unwrap();
        assert_eq!(login.kubeconfig.as_deref(), Some("/a/config"));
        let plain = fake_shell(&dir, "unset KUBECONFIG\neval \"$2\"");
        assert_eq!(ask_shell(&plain, TIMEOUT).unwrap().kubeconfig, None);
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
        assert!(ask_shell(&shell, Duration::from_millis(200)).is_none());
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(ask_shell("/nonexistent/shell", TIMEOUT).is_none());
    }
}
