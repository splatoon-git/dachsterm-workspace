//! `dachsterm git-credential <action>` (DX.14): the helper git runs in a WSL tab, through WSL
//! interop. `main` branches here before the app starts, so it shows no window and takes no
//! instance lock. `get` hands git's request to the tab's pipe (`DACHSTERM_CREDENTIAL_PIPE`) and
//! prints the answer for git. Any other action, a missing pipe or any failure prints nothing and
//! ends with 0, and git goes on as it would without the app.
use crate::git_credential::{protocol::MAX_REQUEST, wsl};
use std::{
    ffi::{OsStr, OsString},
    io::{BufRead, Read, Write},
};
use zeroize::Zeroizing;

pub const ARGUMENT: &str = "git-credential";
/// A user name and a token fit well within this (the card allows 256 bytes and 16 KiB).
#[cfg_attr(not(windows), allow(dead_code))]
const MAX_ANSWER: usize = 64 * 1024;

/// `Some(exit code)` when the app was started as the helper.
pub fn from_args(mut args: impl Iterator<Item = OsString>) -> Option<i32> {
    let _program = args.next();
    if args.next()? != ARGUMENT {
        return None;
    }
    // `store` carries the password git just used, and `erase` has nothing for the app: neither is
    // even read (DX.12).
    if args.next().as_deref() == Some(OsStr::new("get")) {
        get();
    }
    Some(0)
}

fn get() {
    let Some(pipe) = std::env::var(wsl::PIPE_VARIABLE)
        .ok()
        .filter(|name| wsl::usable_pipe(name))
    else {
        return;
    };
    let Some(request) = read_request(std::io::stdin().lock()) else {
        return;
    };
    let Some(answer) = ask(&pipe, &request) else {
        return;
    };
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(&answer);
    let _ = out.flush();
}

/// git's request as the app's parser reads a `credential-cache` one: `action=get` first, then
/// git's lines up to the blank line that ends them.
fn read_request(input: impl BufRead) -> Option<Zeroizing<Vec<u8>>> {
    // Sized once, so no copy of a line is left behind by a reallocation.
    let mut request = Zeroizing::new(Vec::with_capacity(MAX_REQUEST));
    request.extend_from_slice(b"action=get\n");
    for line in input.split(b'\n') {
        let line = Zeroizing::new(line.ok()?);
        if line.is_empty() {
            break;
        }
        if request.len() + line.len() + 1 > MAX_REQUEST {
            return None;
        }
        request.extend_from_slice(&line);
        request.push(b'\n');
    }
    Some(request)
}

/// One message from the pipe: its length (u32, big-endian), then the bytes (`wsl::frame`).
#[cfg_attr(not(windows), allow(dead_code))]
fn read_frame(stream: &mut impl Read, max: usize) -> Option<Zeroizing<Vec<u8>>> {
    let mut header = [0; 4];
    stream.read_exact(&mut header).ok()?;
    let length = u32::from_be_bytes(header) as usize;
    if length > max {
        return None;
    }
    let mut bytes = Zeroizing::new(vec![0; length]);
    stream.read_exact(&mut bytes).ok()?;
    Some(bytes)
}

/// Sends the request and waits for the tab's answer, which may take as long as the card does.
/// The tab closing on the way ends the pipe, and with it the wait.
#[cfg(windows)]
fn ask(pipe: &str, request: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    let mut stream = open(pipe)?;
    stream.write_all(&wsl::frame(request)).ok()?;
    read_frame(&mut stream, MAX_ANSWER)
}

/// WSL tabs exist on Windows only, so elsewhere there is never a pipe to ask.
#[cfg(not(windows))]
fn ask(_pipe: &str, _request: &[u8]) -> Option<Zeroizing<Vec<u8>>> {
    None
}

/// The tab's pipe as a client. The app may identify the helper but never act as it.
#[cfg(windows)]
fn open(pipe: &str) -> Option<std::fs::File> {
    use std::{
        os::windows::fs::OpenOptionsExt,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::Foundation::ERROR_PIPE_BUSY;
    /// `SECURITY_IDENTIFICATION` in winbase.h (`SecurityIdentification << 16`).
    const IDENTIFICATION: u32 = 1 << 16;
    // All instances busy: four other requests of the same tab are being answered.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .security_qos_flags(IDENTIFICATION)
            .open(pipe)
        {
            Ok(file) => return Some(file),
            Err(e)
                if e.raw_os_error() == Some(ERROR_PIPE_BUSY as i32)
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> impl Iterator<Item = OsString> {
        list.iter()
            .map(OsString::from)
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn only_the_helper_argument_skips_the_app() {
        assert_eq!(from_args(args(&["dachsterm.exe"])), None);
        assert_eq!(from_args(args(&["dachsterm.exe", "--other"])), None);
        // No pipe in this test's environment: every action ends quietly with 0.
        assert_eq!(
            from_args(args(&["dachsterm.exe", ARGUMENT, "store"])),
            Some(0)
        );
        assert_eq!(
            from_args(args(&["dachsterm.exe", ARGUMENT, "erase"])),
            Some(0)
        );
        assert_eq!(from_args(args(&["dachsterm.exe", ARGUMENT])), Some(0));
    }

    #[test]
    fn reads_gits_request_up_to_the_blank_line() {
        let input: &[u8] = b"protocol=https\nhost=git.test\nusername=me\n\nignored=1\n";
        let request = read_request(input).unwrap();
        assert_eq!(
            &request[..],
            b"action=get\nprotocol=https\nhost=git.test\nusername=me\n"
        );
        let parsed = crate::git_credential::protocol::parse(&request).unwrap();
        assert_eq!(parsed.host, "git.test");
        // git may close its side without the blank line.
        assert!(read_request(&b"protocol=https\nhost=h"[..]).is_some());
        let huge = format!("host={}\n", "a".repeat(MAX_REQUEST));
        assert!(read_request(huge.as_bytes()).is_none());
    }

    #[test]
    fn frames_round_trip_within_their_limit() {
        let framed = wsl::frame(b"username=me\npassword=t\n");
        let mut reader = &framed[..];
        assert_eq!(
            &read_frame(&mut reader, MAX_ANSWER).unwrap()[..],
            b"username=me\npassword=t\n"
        );
        let mut reader = &framed[..];
        assert!(read_frame(&mut reader, 3).is_none(), "longer than allowed");
        let mut cut = &framed[..framed.len() - 1];
        assert!(read_frame(&mut cut, MAX_ANSWER).is_none(), "cut short");
        let mut empty = &wsl::frame(b"")[..];
        assert!(read_frame(&mut empty, MAX_ANSWER).unwrap().is_empty());
    }

    /// The helper against a real pipe made like a tab's, answered by a stand-in for the tab.
    #[cfg(windows)]
    #[tokio::test(flavor = "multi_thread")]
    async fn asks_the_tabs_pipe_and_returns_its_answer() {
        use crate::local_agent::pipe;
        use tokio::io::AsyncWriteExt;
        let opened = pipe::open(wsl::PIPE_KIND).unwrap();
        let name = opened.name.clone();
        assert!(wsl::usable_pipe(&name), "{name}");
        let (_stop, stopped) = tokio::sync::watch::channel(false);
        tokio::spawn(pipe::serve(opened, stopped, |mut client| {
            tokio::spawn(async move {
                let request = wsl::read_frame(&mut client, MAX_REQUEST).await.unwrap();
                let answer: &[u8] = if request.starts_with(b"action=get\n") {
                    b"username=me\npassword=t\n"
                } else {
                    b""
                };
                client.write_all(&wsl::frame(answer)).await.unwrap();
                let _ = tokio::io::AsyncReadExt::read(&mut client, &mut [0; 1]).await;
            });
        }));
        let request = read_request(&b"protocol=https\nhost=h\n\n"[..]).unwrap();
        let answer = tokio::task::spawn_blocking(move || ask(&name, &request))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&answer[..], b"username=me\npassword=t\n");
        let missing = r"\\.\pipe\dachsterm-credential-00000000000000000000000000000000";
        assert!(ask(missing, b"action=get\n").is_none(), "no such pipe");
    }
}
