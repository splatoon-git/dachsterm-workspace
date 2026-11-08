//! HTTPS Git credentials for WSL tabs (DX.14). git in WSL cannot see this PC's credential manager,
//! so a WSL tab opened with the setting on gets one more helper: the app's own executable, run
//! through WSL interop as `dachsterm git-credential get` (`credential_helper`). It hands git's
//! request to this tab's pipe, and the tab answers like a server's forward (DX.12): the card in
//! this tab, then the app's saved token, this PC's Git helpers or a typed value. Nothing is
//! installed or written in WSL.
use super::{
    approval::{Forward, Slot},
    protocol, respond,
};
use crate::{
    approval::Notify,
    local::Target,
    remote_exec::quote,
    ssh::Sink,
    storage::{Result, Store},
};
use std::{sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::watch,
    time::timeout,
};
use zeroize::Zeroizing;

/// Where the helper finds the tab's pipe. It stays out of `WSLENV`: Windows programs started from
/// the tab inherit it from wsl.exe (DX.13.0), and Linux never sees it.
pub const PIPE_VARIABLE: &str = "DACHSTERM_CREDENTIAL_PIPE";
pub const PIPE_KIND: &str = "credential";
const PARAMETERS: &str = "GIT_CONFIG_PARAMETERS";
/// The helper's request reaches the pipe at once; a client that sends nothing is dropped.
const READ_TIME: Duration = Duration::from_secs(15);
/// After the answer, the helper reads it and closes its end.
const CLOSE_TIME: Duration = Duration::from_secs(5);
#[cfg(windows)]
const OPEN_FAILED: &str = "WSL 탭의 Git 자격 증명 통로를 만들지 못했습니다. 설정 › 에이전트에서 WSL 탭의 HTTPS Git 자격 증명을 끄면 탭을 열 수 있습니다.";

/// One WSL tab's pipe. Closing the tab, or dropping this, closes the pipe and forgets what the
/// tab's cards allowed.
pub struct Tab {
    forward: Arc<Forward>,
    stop: watch::Sender<bool>,
}
impl Tab {
    pub(super) fn forward(&self) -> Arc<Forward> {
        self.forward.clone()
    }
    pub fn close(&self) {
        self.stop.send_replace(true);
        self.forward.forget();
    }
}
impl Drop for Tab {
    fn drop(&mut self) {
        self.close();
    }
}

/// The open pipe and the variables the shell gets on top of `env`.
pub struct Started {
    pub tab: Tab,
    pub env: Vec<(String, String)>,
}

/// Opens the pipe before the tab's shell starts, when the tab is WSL and the setting is on. `env`
/// is what the shell already gets, so `WSLENV` is extended rather than replaced.
pub async fn start(
    store: Arc<Store>,
    target: &Target,
    env: &[(String, String)],
    events: Sink,
) -> Result<Option<Started>> {
    if target.kind != "wsl" {
        return Ok(None);
    }
    let settings = tokio::task::spawn_blocking(move || store.local_agent())
        .await
        .map_err(|_| "설정을 읽지 못했습니다.")??;
    if !settings.wsl_git_credentials {
        return Ok(None);
    }
    #[cfg(windows)]
    {
        use crate::{approval::Direct, local_agent::pipe};
        let exe = std::env::current_exe().map_err(|_| OPEN_FAILED)?;
        let opened = pipe::open(PIPE_KIND).map_err(|_| OPEN_FAILED)?;
        let user = UserEnv {
            wslenv: std::env::var("WSLENV").ok(),
            parameters: std::env::var(PARAMETERS).ok(),
        };
        let env = shell_env(&opened.name, &exe.to_string_lossy(), env, &user);
        let forward = Arc::new(Forward::new(opened.name.clone(), Vec::new(), true));
        let (stop, stopped) = watch::channel(false);
        let cards: Arc<dyn Notify> = Arc::new(Direct(events));
        let (session, clients, served) = (target.name.clone(), stopped.clone(), forward.clone());
        // Owned by the tab: ends when the tab closes.
        tokio::spawn(pipe::serve(opened, stopped, move |client| {
            spawn_client(&served, &cards, &session, client, clients.clone())
        }));
        Ok(Some(Started {
            tab: Tab { forward, stop },
            env,
        }))
    }
    #[cfg(not(windows))]
    {
        let _ = (env, events);
        Err("WSL 탭은 Windows에서만 열 수 있습니다.".into())
    }
}

/// The helper git in WSL runs, after the user's own. It passes `get` only (DX.12), and finds the
/// executable when it runs: `wslpath` knows where this distribution mounts Windows drives, and
/// fails quietly for a drive it cannot reach, so git goes on as it would without the app.
pub fn helper(exe: &str) -> String {
    format!(
        "!f() {{ [ \"$1\" = get ] || return 0; p=$(wslpath -u {} 2>/dev/null) && [ -x \"$p\" ] || return 0; exec \"$p\" git-credential get; }}; f",
        quote(exe)
    )
}

/// One `GIT_CONFIG_PARAMETERS` item. git reads the same single quoting as POSIX shells.
pub fn parameter(exe: &str) -> String {
    quote(&format!("credential.helper={}", helper(exe)))
}

/// What the app's own environment already says.
#[cfg_attr(not(windows), allow(dead_code))]
struct UserEnv {
    wslenv: Option<String>,
    parameters: Option<String>,
}

/// The pipe name for Windows programs, and the helper for Linux git through `WSLENV` (`/u`: from
/// Windows into WSL only). The item is appended to a `GIT_CONFIG_PARAMETERS` that already goes to
/// WSL; one that does not stays on the Windows side, so Linux git gets nothing else new.
#[cfg_attr(not(windows), allow(dead_code))]
fn shell_env(
    pipe: &str,
    exe: &str,
    env: &[(String, String)],
    user: &UserEnv,
) -> Vec<(String, String)> {
    let last = |name: &str| {
        env.iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.clone())
    };
    let wslenv = last("WSLENV")
        .or_else(|| user.wslenv.clone())
        .filter(|value| !value.is_empty());
    let named = |entry: &str| entry.split('/').next() == Some(PARAMETERS);
    let forwarded = wslenv.as_deref().is_some_and(|v| v.split(':').any(named));
    let item = parameter(exe);
    let existing = last(PARAMETERS)
        .or_else(|| user.parameters.clone())
        .filter(|value| forwarded && !value.trim().is_empty());
    let mut out = vec![
        (PIPE_VARIABLE.to_string(), pipe.to_string()),
        (
            PARAMETERS.to_string(),
            match existing {
                Some(existing) => format!("{existing} {item}"),
                None => item,
            },
        ),
    ];
    if !forwarded {
        out.push((
            "WSLENV".into(),
            match wslenv {
                Some(existing) => format!("{existing}:{PARAMETERS}/u"),
                None => format!("{PARAMETERS}/u"),
            },
        ));
    }
    out
}

/// A pipe name the helper may open: only this app's credential pipes.
pub fn usable_pipe(name: &str) -> bool {
    name.strip_prefix(r"\\.\pipe\dachsterm-credential-")
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// One message on the pipe: its length (u32, big-endian) and the bytes. The pipe has no
/// half-close like the server's socket, so both sides say how much follows.
pub fn frame(bytes: &[u8]) -> Zeroizing<Vec<u8>> {
    let mut framed = Zeroizing::new(Vec::with_capacity(4 + bytes.len()));
    framed.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    framed.extend_from_slice(bytes);
    framed
}

/// Reads one message of at most `max` bytes.
pub async fn read_frame<S: AsyncRead + Unpin>(
    stream: &mut S,
    max: usize,
) -> Option<Zeroizing<Vec<u8>>> {
    let mut header = [0; 4];
    stream.read_exact(&mut header).await.ok()?;
    let length = u32::from_be_bytes(header) as usize;
    if length > max {
        return None;
    }
    let mut bytes = Zeroizing::new(vec![0; length]);
    stream.read_exact(&mut bytes).await.ok()?;
    Some(bytes)
}

/// Four clients at once, like a server's forward (`MAX_CHANNELS`). More are closed right away.
#[cfg_attr(not(windows), allow(dead_code))]
fn spawn_client<S>(
    forward: &Arc<Forward>,
    cards: &Arc<dyn Notify>,
    session: &str,
    mut stream: S,
    mut stop: watch::Receiver<bool>,
) where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let Some(slot) = Slot::take(forward) else {
        return;
    };
    let (forward, cards, session) = (forward.clone(), cards.clone(), session.to_string());
    // Owned by the tab: ends with the client or when the tab closes.
    tokio::spawn(async move {
        let _slot = slot;
        tokio::select! {
            _ = stop.wait_for(|stopped| *stopped) => {}
            _ = serve(&forward, &*cards, &session, &mut stream) => {}
        }
    });
}

/// The helper sends git's request and reads one answer. An empty answer is "no value", and git
/// goes on to the terminal as it would without the app.
async fn serve<S: AsyncRead + AsyncWrite + Unpin>(
    forward: &Forward,
    cards: &dyn Notify,
    session: &str,
    stream: &mut S,
) {
    let Ok(Some(request)) = timeout(READ_TIME, read_frame(stream, protocol::MAX_REQUEST)).await
    else {
        return;
    };
    let answer = respond(forward, cards, session, &request)
        .await
        .unwrap_or_else(|| Zeroizing::new(Vec::new()));
    if stream.write_all(&frame(&answer)).await.is_err() {
        return;
    }
    // Closing first could drop an answer the helper has not read yet.
    let mut end = [0; 1];
    let _ = timeout(CLOSE_TIME, stream.read(&mut end)).await;
}

#[cfg(test)]
mod tests;
