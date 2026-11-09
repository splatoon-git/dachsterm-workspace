//! Runs kubectl on this computer for a local cluster (design KV.11). No shell is involved: Windows
//! has none to count on, so the command lines `Kubectl` builds are split back into arguments here,
//! and anything a shell would have interpreted is refused rather than passed along as text.
use crate::remote_exec::{Failure, Limits, Output, Streamed};
use std::{ffi::OsString, io::ErrorKind, ops::ControlFlow, path::Path, process::Stdio};
use tokio::{io::AsyncReadExt, process::Command};

/// What a shell would have started, as the arguments of one process.
#[derive(Debug, PartialEq)]
pub struct Invocation {
    pub program: String,
    pub args: Vec<String>,
    pub kubeconfig: Option<String>,
}

/// The words of a command line in the only syntax `Kubectl` and `quote` write: plain words and
/// single-quoted parts, with `\'` between them. `None` for anything else, such as a pipeline.
fn words(text: &str) -> Option<Vec<String>> {
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            ' ' => words.extend(word.take()),
            '\'' => {
                let word = word.get_or_insert_with(String::new);
                loop {
                    match chars.next()? {
                        '\'' => break,
                        c => word.push(c),
                    }
                }
            }
            '\\' if chars.next()? == '\'' => word.get_or_insert_with(String::new).push('\''),
            '\\' | '|' | '&' | ';' | '<' | '>' | '(' | ')' | '$' | '`' | '"' | '\n' | '#' | '*'
            | '?' | '~' | '{' | '}' => return None,
            c => word.get_or_insert_with(String::new).push(c),
        }
    }
    words.extend(word);
    Some(words)
}

/// `[KUBECONFIG=<word> ]<program> <args>`. The program is compared as text and not split into
/// words, because a path on this computer may contain spaces (`/Applications/Rancher Desktop.app`)
/// and the settings are the only source of it.
pub fn parse(command: &str, program: &str) -> Option<Invocation> {
    let (kubeconfig, rest) = match command.strip_prefix("KUBECONFIG=") {
        None => (None, command),
        Some(rest) => {
            let end = word_end(rest)?;
            let value = words(&rest[..end])?.into_iter().next()?;
            (Some(value), rest[end..].trim_start_matches(' '))
        }
    };
    let rest = rest.strip_prefix(program)?;
    if !(rest.is_empty() || rest.starts_with(' ')) {
        return None;
    }
    Some(Invocation {
        program: program.to_string(),
        args: words(rest)?,
        kubeconfig,
    })
}

/// Where the first word ends, counting a space inside single quotes as part of it.
fn word_end(text: &str) -> Option<usize> {
    let mut quoted = false;
    let mut chars = text.char_indices();
    while let Some((at, c)) = chars.next() {
        match c {
            '\'' => quoted = !quoted,
            '\\' if !quoted => {
                chars.next()?;
            }
            ' ' if !quoted => return Some(at),
            _ => {}
        }
    }
    (!quoted).then_some(text.len())
}

/// A kubeconfig's `exec` plugin is found through kubectl's PATH, and one is often installed next
/// to kubectl. The login shell's PATH is in this process already (`login_path`, macOS).
fn child_path(program: &str) -> Option<OsString> {
    let current = std::env::var_os("PATH").unwrap_or_default();
    let parent = Path::new(program).parent()?;
    let mut entries: Vec<_> = std::env::split_paths(&current).collect();
    if !entries.iter().any(|entry| entry == parent) {
        entries.push(parent.to_path_buf());
    }
    std::env::join_paths(entries).ok()
}

/// The environment a local kubectl gets on top of this process's, for pipes and PTYs alike.
pub fn environment(invocation: &Invocation) -> Vec<(OsString, OsString)> {
    let path = child_path(&invocation.program).map(|path| ("PATH".into(), path));
    let config = invocation
        .kubeconfig
        .as_ref()
        .map(|value| ("KUBECONFIG".into(), value.into()));
    path.into_iter().chain(config).collect()
}

/// Dropping the child kills kubectl, as closing the channel does on a server.
pub fn command(invocation: &Invocation) -> Command {
    let mut command = Command::new(&invocation.program);
    command
        .args(&invocation.args)
        .envs(environment(invocation))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    command
}

/// A kubectl that is not there reads like a shell's 127, which `classify` already knows.
pub fn missing(error: &std::io::Error) -> Option<u32> {
    match error.kind() {
        ErrorKind::NotFound => Some(127),
        ErrorKind::PermissionDenied => Some(126),
        _ => None,
    }
}

fn refused() -> Failure {
    Failure::Other("이 명령은 이 컴퓨터에서 실행할 수 없습니다.".into())
}

/// Like `remote_exec::stream_refusable`, for a process here. `max_output` limits only stderr.
pub async fn stream(
    program: &str,
    line: &str,
    limits: Limits,
    mut on_stdout: impl FnMut(&[u8]) -> ControlFlow<()>,
) -> Result<Streamed, Failure> {
    let invocation = parse(line, program).ok_or_else(refused)?;
    let work = async {
        let mut child = match command(&invocation).spawn() {
            Ok(child) => child,
            Err(error) => {
                return match missing(&error) {
                    Some(code) => Ok(Streamed {
                        stderr: Vec::new(),
                        exit: Some(code),
                    }),
                    None => Err(Failure::Other("kubectl을 실행하지 못했습니다.".into())),
                };
            }
        };
        let mut out = child.stdout.take().ok_or_else(refused)?;
        let mut err = child.stderr.take().ok_or_else(refused)?;
        let (mut out_open, mut err_open) = (true, true);
        let (mut out_buffer, mut err_buffer) = (vec![0; 32 * 1024], vec![0; 4 * 1024]);
        let mut stderr = Vec::new();
        while out_open || err_open {
            tokio::select! {
                read = out.read(&mut out_buffer), if out_open => match read {
                    Ok(n) if n > 0 => {
                        if on_stdout(&out_buffer[..n]).is_break() {
                            return Ok(Streamed { stderr, exit: None });
                        }
                    }
                    _ => out_open = false,
                },
                read = err.read(&mut err_buffer), if err_open => match read {
                    Ok(n) if n > 0 => {
                        stderr.extend_from_slice(&err_buffer[..n]);
                        if stderr.len() > limits.max_output {
                            return Err(Failure::TooLarge);
                        }
                    }
                    _ => err_open = false,
                },
            }
        }
        let status = child
            .wait()
            .await
            .map_err(|_| Failure::Other("kubectl이 끝나기를 기다리지 못했습니다.".into()))?;
        Ok(Streamed {
            stderr,
            exit: status.code().map(|code| code as u32),
        })
    };
    tokio::time::timeout(limits.timeout, work)
        .await
        .map_err(|_| Failure::TimedOut)?
}

pub async fn run(program: &str, line: &str, limits: Limits) -> Result<Output, Failure> {
    let mut stdout = Vec::new();
    let mut too_large = false;
    let done = stream(program, line, limits, |piece| {
        stdout.extend_from_slice(piece);
        too_large = stdout.len() > limits.max_output;
        if too_large {
            ControlFlow::Break(())
        } else {
            ControlFlow::Continue(())
        }
    })
    .await?;
    if too_large || stdout.len() + done.stderr.len() > limits.max_output {
        return Err(Failure::TooLarge);
    }
    Ok(Output {
        stdout,
        stderr: done.stderr,
        exit: done.exit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_exec::quote;
    #[cfg(unix)]
    use std::time::Duration;

    #[cfg(unix)]
    const LIMITS: Limits = Limits {
        timeout: Duration::from_secs(5),
        max_output: 1024,
    };

    #[test]
    fn a_quoted_kubeconfig_and_every_quoted_argument_come_back_whole() {
        // The quote inside makes `quote` write `'\''`, which must not end the word early.
        let config = "/Users/a b/it's.yaml";
        let line = format!(
            "KUBECONFIG={} /opt/kubectl --context {} get pods -o go-template={}",
            quote(config),
            quote("x'y"),
            quote("{{range .items}}$x | \"y\"\n{{end}}"),
        );
        let got = parse(&line, "/opt/kubectl").unwrap();
        assert_eq!(got.kubeconfig.as_deref(), Some(config));
        assert_eq!(
            got.args,
            [
                "--context",
                "x'y",
                "get",
                "pods",
                "-o",
                "go-template={{range .items}}$x | \"y\"\n{{end}}",
            ]
        );
    }

    #[test]
    fn a_program_path_with_spaces_is_not_split() {
        let program = "/Applications/Rancher Desktop.app/bin/kubectl";
        let got = parse(&format!("{program} config current-context"), program).unwrap();
        assert_eq!(got.program, program);
        assert_eq!(got.args, ["config", "current-context"]);
        assert_eq!(got.kubeconfig, None);
    }

    #[test]
    fn windows_paths_stay_literal_inside_quotes() {
        let config = r"C:\Users\me\.kube\config";
        let program = r"C:\tools\kubectl.exe";
        let line = format!("KUBECONFIG={} {program} get pods", quote(config));
        let got = parse(&line, program).unwrap();
        assert_eq!(got.kubeconfig.as_deref(), Some(config));
    }

    #[test]
    fn anything_a_shell_would_have_interpreted_is_refused() {
        for line in [
            "/k get pods | grep x",
            "/k get pods; reboot",
            "/k get $(id)",
            "/k get `id`",
            "/k get pods > /tmp/x",
            "/k get \"pods\"",
            "/k get 'unterminated",
            "/other get pods",
            "/kubectl-other get pods",
        ] {
            assert_eq!(parse(line, "/k"), None, "{line}");
        }
    }

    #[test]
    fn the_program_must_be_exactly_the_one_in_the_settings() {
        assert!(parse("/k2 get", "/k").is_none());
        assert!(parse("/k get", "/k").is_some());
    }

    #[test]
    fn the_programs_folder_joins_its_path_once() {
        let found = child_path("/some/where/kubectl").unwrap();
        let entries: Vec<_> = std::env::split_paths(&found).collect();
        let parent = Path::new("/some/where");
        assert_eq!(entries.iter().filter(|e| *e == parent).count(), 1);
    }

    #[cfg(unix)]
    fn script(dir: &tempfile::TempDir, body: &str) -> String {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.path().join("kubectl");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn output_exit_status_and_config_reach_the_caller() {
        let dir = tempfile::tempdir().unwrap();
        let program = script(&dir, "echo \"$KUBECONFIG:$1\"; echo oops >&2; exit 3");
        let line = format!("KUBECONFIG='/a b' {program} arg");
        let output = run(&program, &line, LIMITS).await.ok().unwrap();
        assert_eq!(output.stdout, b"/a b:arg\n");
        assert_eq!(output.stderr, b"oops\n");
        assert_eq!(output.exit, Some(3));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_kubectl_that_is_not_there_exits_like_a_shell_would_say() {
        let program = "/nonexistent/kubectl";
        let output = run(program, &format!("{program} get"), LIMITS)
            .await
            .ok()
            .unwrap();
        assert_eq!(output.exit, Some(127));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_limits_stop_a_process() {
        let dir = tempfile::tempdir().unwrap();
        let slow = script(&dir, "exec sleep 30");
        let short = Limits {
            timeout: Duration::from_millis(100),
            ..LIMITS
        };
        let started = std::time::Instant::now();
        assert!(matches!(
            run(&slow, &format!("{slow} x"), short).await,
            Err(Failure::TimedOut)
        ));
        assert!(started.elapsed() < Duration::from_secs(5));

        let dir = tempfile::tempdir().unwrap();
        let chatty = script(&dir, "head -c 4096 /dev/zero");
        assert!(matches!(
            run(&chatty, &format!("{chatty} x"), LIMITS).await,
            Err(Failure::TooLarge)
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_caller_can_stop_a_stream_and_kubectl_goes_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let mark = dir.path().join("late");
        let body = format!("echo first; sleep 1; touch {}", mark.display());
        let program = script(&dir, &body);
        let long = Limits {
            timeout: Duration::from_secs(10),
            ..LIMITS
        };
        let done = stream(&program, &format!("{program} x"), long, |_| {
            ControlFlow::Break(())
        })
        .await
        .ok()
        .unwrap();
        assert_eq!(done.exit, None);
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert!(
            !mark.exists(),
            "kubectl kept running after the stream stopped"
        );
    }
}
