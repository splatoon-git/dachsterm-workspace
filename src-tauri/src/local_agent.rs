//! The app's agent for local and WSL tabs (DX.13). A tab opened with the setting on gets its own
//! channel that only the current user can reach: a named pipe on Windows, a Unix socket in a 0700
//! folder elsewhere. Programs in the tab find it through `SSH_AUTH_SOCK`. The tab owns the channel
//! and closes it with itself. Requests are answered like a forwarded server's (`agent_relay`), and
//! signing with an app key asks on the tab's card.
#[cfg(windows)]
pub(crate) mod pipe;
pub mod settings;

pub(crate) use settings::{KEYS, keys_value};

use crate::{
    agent_filter,
    agent_forward::{Agent, KeyOwner, Slot},
    agent_relay::{self, Relay},
    approval::{Direct, Notify},
    local::Target,
    ssh::Sink,
    storage::{ForwardKey, Result, Store},
};
use std::sync::Arc;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::watch,
};

const OPEN_FAILED: &str = "앱의 SSH 키 통로를 만들지 못했습니다. 설정 › 에이전트에서 로컬 탭 키 제공을 끄면 탭을 열 수 있습니다.";

/// One tab's channel. Closing the tab, or dropping this, closes the channel.
pub struct Tab {
    pub agent: Arc<Agent>,
    stop: watch::Sender<bool>,
    #[cfg(unix)]
    socket: std::path::PathBuf,
    /// Removed with everything in it when the tab is gone.
    #[cfg(unix)]
    _folder: tempfile::TempDir,
}
impl Tab {
    pub fn close(&self) {
        self.stop.send_replace(true);
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.socket);
    }
}
impl Drop for Tab {
    fn drop(&mut self) {
        self.close();
    }
}

/// The open channel and the variables the shell gets on top of the target's own.
pub struct Started {
    pub tab: Tab,
    pub env: Vec<(String, String)>,
}

#[derive(Clone)]
struct Context {
    agent: Arc<Agent>,
    events: Arc<dyn Notify>,
    name: String,
    /// Read when the tab opens: a change in Settings applies to new tabs.
    keys: Vec<ForwardKey>,
}

/// Opens the tab's channel before its shell starts, when local tabs get the app's agent.
pub async fn start(store: Arc<Store>, target: &Target, events: Sink) -> Result<Option<Started>> {
    let settings = tokio::task::spawn_blocking(move || store.local_agent())
        .await
        .map_err(|_| "설정을 읽지 못했습니다.")??;
    if !settings.enabled {
        return Ok(None);
    }
    let (stop, stopped) = watch::channel(false);
    let context = Context {
        agent: Arc::default(),
        events: Arc::new(Direct(events)),
        name: target.name.clone(),
        keys: settings.keys,
    };
    let agent = context.agent.clone();
    #[cfg(windows)]
    {
        let opened = pipe::open("agent").map_err(|_| OPEN_FAILED)?;
        let env = shell_env(target, &opened.name, &UserEnv::read());
        let clients = stopped.clone();
        // Owned by the tab: ends when the tab closes.
        tokio::spawn(pipe::serve(opened, stopped, move |client| {
            spawn_client(&context, client, clients.clone())
        }));
        Ok(Some(Started {
            tab: Tab { agent, stop },
            env,
        }))
    }
    #[cfg(unix)]
    {
        let folder = folder()?;
        let socket = folder.path().join(SOCKET);
        let listener = tokio::net::UnixListener::bind(&socket).map_err(|_| OPEN_FAILED)?;
        let env = vec![(
            "SSH_AUTH_SOCK".into(),
            socket.to_string_lossy().into_owned(),
        )];
        // Owned by the tab: ends when the tab closes.
        tokio::spawn(serve_socket(listener, context, stopped));
        Ok(Some(Started {
            tab: Tab {
                agent,
                stop,
                socket,
                _folder: folder,
            },
            env,
        }))
    }
}

#[cfg(unix)]
const SOCKET: &str = "agent.sock";
/// `sun_path` holds 104 bytes on macOS, including the closing NUL.
#[cfg(unix)]
const MAX_SOCKET_PATH: usize = 104;

/// A private folder whose socket path fits. The per-user temporary folder first, `/tmp` if that
/// path is too long.
#[cfg(unix)]
fn folder() -> Result<tempfile::TempDir> {
    use std::{fs::Permissions, os::unix::fs::PermissionsExt};
    for base in [std::env::temp_dir(), "/tmp".into()] {
        let Ok(folder) = tempfile::Builder::new()
            .prefix("dachsterm-agent-")
            .permissions(Permissions::from_mode(0o700))
            .tempdir_in(&base)
        else {
            continue;
        };
        if std::fs::set_permissions(folder.path(), Permissions::from_mode(0o700)).is_ok()
            && folder.path().join(SOCKET).as_os_str().len() < MAX_SOCKET_PATH
        {
            return Ok(folder);
        }
    }
    Err(OPEN_FAILED.into())
}

/// What the app's own environment already says.
#[cfg(windows)]
struct UserEnv {
    git_ssh: bool,
    wslenv: Option<String>,
    system_ssh: Option<String>,
}
#[cfg(windows)]
impl UserEnv {
    fn read() -> Self {
        let system_ssh = std::env::var_os("SystemRoot")
            .map(|root| std::path::PathBuf::from(root).join(r"System32\OpenSSH\ssh.exe"))
            .filter(|path| path.is_file())
            .map(|path| path.to_string_lossy().into_owned());
        Self {
            git_ssh: std::env::var_os("GIT_SSH").is_some(),
            wslenv: std::env::var("WSLENV").ok(),
            system_ssh,
        }
    }
}

/// `SSH_AUTH_SOCK` for the pipe, and `GIT_SSH` for the system `ssh.exe`: the `ssh` bundled with
/// Git for Windows opens a pipe but cannot talk over it (DX.13.0). `GIT_SSH` comes last in git's
/// order, so the user's `GIT_SSH_COMMAND` and `core.sshCommand` still win, and an own `GIT_SSH`
/// is kept. In WSL `SSH_AUTH_SOCK` stays out of `WSLENV`: Windows programs started from the tab
/// inherit it from wsl.exe, while Linux keeps its own agent setting. Linux git reads `GIT_SSH`,
/// so it goes through `WSLENV` as a translated path.
#[cfg(windows)]
fn shell_env(target: &Target, pipe: &str, user: &UserEnv) -> Vec<(String, String)> {
    let mut env = vec![("SSH_AUTH_SOCK".to_string(), pipe.to_string())];
    let Some(ssh) = &user.system_ssh else {
        return env;
    };
    if target.kind != "wsl" {
        if !user.git_ssh {
            env.push(("GIT_SSH".into(), ssh.clone()));
        }
        return env;
    }
    let wslenv = target
        .env
        .iter()
        .rev()
        .find(|(key, _)| key == "WSLENV")
        .map(|(_, value)| value.clone())
        .or_else(|| user.wslenv.clone())
        .filter(|value| !value.is_empty());
    let named = |entry: &str| entry.split('/').next() == Some("GIT_SSH");
    if wslenv.as_deref().is_some_and(|v| v.split(':').any(named)) {
        return env;
    }
    env.push(("GIT_SSH".into(), ssh.clone()));
    env.push((
        "WSLENV".into(),
        match wslenv {
            Some(existing) => format!("{existing}:GIT_SSH/up"),
            None => "GIT_SSH/up".into(),
        },
    ));
    env
}

#[cfg(unix)]
async fn serve_socket(
    listener: tokio::net::UnixListener,
    context: Context,
    mut stop: watch::Receiver<bool>,
) {
    loop {
        let accepted = tokio::select! {
            _ = stop.wait_for(|stopped| *stopped) => return,
            accepted = listener.accept() => accepted,
        };
        if let Ok((stream, _)) = accepted {
            spawn_client(&context, stream, stop.clone());
        }
    }
}

/// Up to eight clients at once, like a forwarding connection. More are closed right away.
fn spawn_client<S>(context: &Context, mut stream: S, mut stop: watch::Receiver<bool>)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let Some(slot) = Slot::take(&context.agent) else {
        return;
    };
    let context = context.clone();
    // Owned by the tab: ends with the client or when the tab closes.
    tokio::spawn(async move {
        let _slot = slot;
        let mut relay = relay(context, agent_relay::connect_system().await, stop.clone());
        tokio::select! {
            _ = stop.wait_for(|stopped| *stopped) => {}
            _ = run(&mut relay, &mut stream) => {}
        }
    });
}

fn relay(
    context: Context,
    system: Option<agent_relay::LocalStream>,
    stop: watch::Receiver<bool>,
) -> Relay {
    Relay {
        agent: context.agent,
        events: context.events,
        session: context.name,
        keys: KeyOwner::Local,
        login_path: String::new(),
        extras: context.keys,
        system,
        host_key: None,
        stop,
    }
}

/// One request, one answer, in order, as on a forwarded channel. A bad frame ends the client.
async fn run<S: AsyncRead + AsyncWrite + Unpin>(relay: &mut Relay, stream: &mut S) {
    let mut buffer = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        match agent_filter::take_frame(&mut buffer) {
            Ok(Some(body)) => {
                let answer = relay.answer(&body).await;
                if stream.write_all(&answer).await.is_err() {
                    return;
                }
                continue;
            }
            Ok(None) => {}
            Err(_) => return,
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
        }
    }
}

#[cfg(test)]
mod tests;
