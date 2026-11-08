//! HTTPS Git credentials for the final server of an SSH connection (DX.12). The server's git asks
//! through its own `credential-cache` client on a socket this connection forwards, so nothing is
//! installed or written on the server. Only `get` reaches the app, and every answer waits for the
//! user's card. Unlike a signature, the value itself goes to the server, so each rule here leans
//! towards refusing: https only, the connection's own path, bounded requests and channels.
//! WSL tabs (DX.14) bring the same request through the app's own helper and a pipe (`wsl`).
mod approval;
pub mod commands;
mod local;
/// This PC's git, also used by the local Git status (DX.15).
#[cfg(target_os = "macos")]
pub(crate) use local::command_line_tools;
pub(crate) use local::{find_git_program, git_program};
pub mod protocol;
pub mod wsl;

use crate::{
    approval::Notify,
    remote_exec::{self, Limits, quote},
    ssh::{Connections, Event, Host},
};
use approval::{Forward, Slot};
use russh::{Channel, ChannelMsg, client};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::watch, time::timeout};
use zeroize::Zeroizing;

pub const MAX_CHANNELS: usize = 4;
const READ_TIME: Duration = Duration::from_secs(15);
const SETUP_TIME: Duration = Duration::from_secs(10);
const CLEANUP_TIME: Duration = Duration::from_secs(3);

const REFUSED: &str =
    "서버가 소켓 전달을 허용하지 않아 이 연결에서는 HTTPS Git 자격 증명을 전달할 수 없습니다.";
const HTTP_REFUSED: &str =
    "암호화되지 않은 http 저장소의 자격 증명 요청을 거부했습니다. https 주소를 쓰세요.";
const BURST_REFUSED: &str = "같은 저장소 서버의 자격 증명 요청이 짧은 시간에 반복되어 1분 동안 거부합니다. 토큰이 맞는지 확인하세요.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Deny,
    Once,
    /// The same host on this connection for the next ten minutes.
    Connection,
    /// Type the value on the card. Answered like `Once`.
    Input,
}

/// What the card shows. Server text is plain and short (`agent_filter::plain`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRequest {
    pub request: String,
    pub session: String,
    pub host: String,
    pub path: Option<String>,
    pub username: Option<String>,
    /// The server user's own helpers. git hands them the value after a push, and they may keep it.
    pub server_helpers: Vec<String>,
    /// From git in a WSL tab of this PC (DX.14), not from a server.
    pub local: bool,
    pub seconds: u64,
}

#[derive(Clone)]
pub struct Credential {
    pub username: Zeroizing<String>,
    pub password: Zeroizing<String>,
}

/// The forwards of all connections, owned by `Connections`.
#[derive(Default)]
pub struct Forwards(Mutex<HashMap<String, Arc<Forward>>>);
impl Forwards {
    fn get(&self, id: &str) -> Option<Arc<Forward>> {
        self.0.lock().unwrap().get(id).cloned()
    }
}

/// Kept by the terminal task. Dropping it, on any exit, forgets the connection's state.
pub struct Started {
    manager: Arc<Connections>,
    id: String,
    path: String,
}
impl Started {
    pub fn path(&self) -> &str {
        &self.path
    }
}
impl Drop for Started {
    fn drop(&mut self) {
        if let Some(forward) = self.manager.git.0.lock().unwrap().remove(&self.id) {
            forward.forget();
        }
    }
}

/// Reads `XDG_RUNTIME_DIR` when it is the user's own private folder, and the helpers the server
/// user set in their home folder. Nothing is changed on the server.
const LOCATE: &str = "d=${XDG_RUNTIME_DIR-}\n\
if [ -n \"$d\" ] && [ -d \"$d\" ] && [ -O \"$d\" ] && [ ! -L \"$d\" ]; then\n\
printf 'D %s\\n' \"$d\"; ls -ld \"$d\" | sed 's/^/M /'\n\
fi\n\
cd 2>/dev/null && git config --get-all credential.helper 2>/dev/null | sed 's/^/H /'";
const NAME_BYTES: usize = "/dachsterm-git-".len() + 32;

fn located(output: &[u8]) -> (String, Vec<String>) {
    let text = String::from_utf8_lossy(output);
    let (mut folder, mut private, mut helpers) = (None, false, Vec::new());
    for line in text.lines() {
        if let Some(dir) = line.strip_prefix("D ") {
            folder = Some(dir.trim_end_matches('/').to_string());
        } else if let Some(mode) = line.strip_prefix("M ") {
            // An ACL (`+`) could let others in; SELinux's `.` changes nothing.
            let mode = mode.split_whitespace().next().unwrap_or_default();
            private = mode == "drwx------" || mode == "drwx------.";
        } else if let Some(helper) = line.strip_prefix("H ") {
            let helper = crate::agent_filter::plain(helper.as_bytes());
            if !helper.is_empty() && helpers.len() < 8 {
                helpers.push(helper);
            }
        }
    }
    let folder = folder
        .filter(|f| {
            private && protocol::usable_path(f) && f.len() + NAME_BYTES <= protocol::MAX_SOCKET_PATH
        })
        .unwrap_or_else(|| "/tmp".into());
    (folder, helpers)
}

fn random_name() -> Option<String> {
    use aes_gcm::aead::{OsRng, rand_core::RngCore};
    let mut bytes = [0_u8; 16];
    OsRng.try_fill_bytes(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Opens the socket on the final server before its terminal starts, so the shell hook and the
/// tmux start command can name it. Jump hosts are never asked.
pub async fn start(
    handle: &client::Handle<Host>,
    manager: &Arc<Connections>,
    id: &str,
) -> Option<Started> {
    let control = manager.control(id).ok()?;
    if !control.profile.forward_git_credentials {
        return None;
    }
    let limits = Limits {
        timeout: SETUP_TIME,
        max_output: 65536,
    };
    let (folder, helpers) = match remote_exec::run(handle, LOCATE, limits).await {
        Ok(output) => located(&output.stdout),
        Err(_) => ("/tmp".into(), vec![]),
    };
    let path = format!("{folder}/dachsterm-git-{}", random_name()?);
    let forward = Arc::new(Forward::new(path.clone(), helpers, false));
    // Registered first: sshd may open a channel as soon as the forward exists.
    manager
        .git
        .0
        .lock()
        .unwrap()
        .insert(id.to_string(), forward);
    let started = Started {
        manager: manager.clone(),
        id: id.to_string(),
        path: path.clone(),
    };
    if matches!(
        timeout(SETUP_TIME, handle.streamlocal_forward(path)).await,
        Ok(Ok(()))
    ) {
        return Some(started);
    }
    drop(started);
    let _ = control.broker.send(Event::AgentNotice {
        message: REFUSED.into(),
    });
    None
}

/// sshd leaves the socket file behind after the forward ends (DX.12.0), so the app removes its
/// own one, and only that one, while the connection is still there.
pub async fn finish(manager: &Connections, id: &str) {
    let Some(forward) = manager.git.get(id) else {
        return;
    };
    let Some(path) = forward.path.lock().unwrap().take() else {
        return;
    };
    forward.forget();
    let Ok(handle) = manager.handle(id) else {
        return;
    };
    let _ = timeout(
        CLEANUP_TIME,
        handle.cancel_streamlocal_forward(path.clone()),
    )
    .await;
    let script = format!("[ -S {p} ] && rm -f -- {p}", p = quote(&path));
    let limits = Limits {
        timeout: CLEANUP_TIME,
        max_output: 4096,
    };
    let _ = remote_exec::run(&handle, &script, limits).await;
}

/// The stop branch of a connection's task: it runs before the task drops the connection.
pub async fn stopping(stopped: &mut watch::Receiver<bool>, manager: &Connections, id: &str) {
    let _ = stopped.changed().await;
    finish(manager, id).await;
}

/// The handler's only call. Dropping `reply` without accepting refuses the channel: a jump host,
/// another path, a connection without the option and a fifth channel are all turned away.
pub fn open(
    manager: &Connections,
    id: &str,
    path: &str,
    channel: Channel<client::Msg>,
    reply: client::ChannelOpenHandle,
) {
    let Some(forward) = manager.git.get(id) else {
        return;
    };
    if !forward.serves(path) {
        return;
    }
    let Ok(control) = manager.control(id) else {
        return;
    };
    let Some(slot) = Slot::take(&forward) else {
        return;
    };
    let mut stop = control.stop.subscribe();
    let (broker, session) = (control.broker.clone(), control.profile.name.clone());
    // Owned by the connection: it ends with the channel or when the connection stops.
    tokio::spawn(async move {
        let _slot = slot;
        reply.accept().await;
        let mut channel = channel;
        tokio::select! {
            _ = stop.wait_for(|stopped| *stopped) => {}
            _ = serve(&forward, &*broker, &session, &mut channel) => {}
        }
        let _ = channel.close().await;
    });
}

/// The client sends its request, closes its side and reads to the end. Closing without an
/// answer means "no value", and git goes on to its next helper or the terminal.
async fn serve(
    forward: &Forward,
    broker: &dyn Notify,
    session: &str,
    channel: &mut Channel<client::Msg>,
) {
    let Ok(Some(bytes)) = timeout(READ_TIME, read_request(channel)).await else {
        return;
    };
    let Some(answer) = respond(forward, broker, session, &bytes).await else {
        return;
    };
    if channel.data(&answer[..]).await.is_ok() {
        let _ = channel.eof().await;
    }
}

/// One request, from a server's socket or a WSL tab's pipe, to the answer git reads. `None` is
/// "no value": refused, unanswered or not found.
async fn respond(
    forward: &Forward,
    cards: &dyn Notify,
    session: &str,
    bytes: &[u8],
) -> Option<Zeroizing<Vec<u8>>> {
    let request = protocol::parse(bytes).ok()?;
    if request.protocol != "https" {
        forward.notice_once(&forward.http_notified, cards, HTTP_REFUSED);
        return None;
    }
    if forward.flooding(&request.host) {
        forward.notice_once(&forward.burst_notified, cards, BURST_REFUSED);
        return None;
    }
    let found = forward.credential(cards, session, request).await?;
    Some(protocol::answer(&found.username, &found.password))
}

async fn read_request(channel: &mut Channel<client::Msg>) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    loop {
        match channel.wait().await? {
            ChannelMsg::Data { data } => {
                bytes.extend_from_slice(&data);
                if bytes.len() > protocol::MAX_REQUEST {
                    return None;
                }
            }
            ChannelMsg::Eof => return Some(bytes),
            ChannelMsg::Close => return None,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests;
