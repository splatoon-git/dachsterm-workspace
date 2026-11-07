//! Agent forwarding for the final server of an SSH connection. Someone with rights on that server,
//! or a program running there, can ask the local agent to sign with the user's keys. So only the
//! connection that asked for forwarding gets a channel, only listing and signing reach the local
//! agent, and every signature waits for the user's answer in the app.
use crate::{
    AppState,
    agent_filter::{self, FAILURE, Purpose, Verdict},
    ssh::{Connections, Event},
    storage::{Profile, Result},
    windows::Broker,
};
use russh::{
    Channel, ChannelMsg, client,
    keys::{
        HashAlg, PublicKey,
        agent::client::{AgentClient, AgentStream},
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::oneshot,
    time::timeout,
};

pub const MAX_CHANNELS: usize = 8;
const ANSWER_TIME: Duration = Duration::from_secs(60);
const ALLOW_FOR: Duration = Duration::from_secs(600);
/// A local agent may ask for its own confirmation, so it gets longer than the user's answer.
const LOCAL_TIME: Duration = Duration::from_secs(120);
#[cfg(windows)]
const LOCAL_MISSING: &str = "이 PC의 SSH 인증 에이전트에 연결할 수 없어 키 전달을 거부했습니다. ssh-agent 서비스와 ssh-add 등록을 확인하세요.";
#[cfg(unix)]
const LOCAL_MISSING: &str =
    "SSH_AUTH_SOCK의 인증 에이전트에 연결할 수 없어 키 전달을 거부했습니다.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Deny,
    Once,
    /// Every signature on this connection for the next ten minutes.
    Connection,
}

/// What the approval card shows. Server text is already plain and short (`agent_filter::plain`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignRequest {
    pub request: String,
    pub session: String,
    pub key: String,
    pub fingerprint: String,
    pub login_user: Option<String>,
    pub namespace: Option<String>,
    pub host_key: Option<String>,
    pub seconds: u64,
}

/// Per connection, in memory only. Locks are never held across an await.
#[derive(Default)]
pub struct Agent {
    requested: AtomicBool,
    channels: AtomicUsize,
    notified: AtomicBool,
    allowed_until: Mutex<Option<Instant>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Decision>>>,
}

impl Agent {
    pub fn reply(&self, request: &str, decision: Decision) -> Result<()> {
        let sender = self
            .pending
            .lock()
            .unwrap()
            .remove(request)
            .ok_or("서명 요청이 이미 끝났습니다.")?;
        let _ = sender.send(decision);
        Ok(())
    }
    fn allowed(&self) -> bool {
        self.allowed_until
            .lock()
            .unwrap()
            .is_some_and(|until| Instant::now() < until)
    }
    /// No answer, a closed window or a moved terminal all end as a refusal.
    async fn approve(&self, broker: &Broker, mut request: SignRequest, wait: Duration) -> bool {
        if self.allowed() {
            return true;
        }
        let (sender, answer) = oneshot::channel();
        let id = uuid::Uuid::new_v4().to_string();
        request.request = id.clone();
        request.seconds = wait.as_secs();
        self.pending.lock().unwrap().insert(id.clone(), sender);
        let decision = if broker.send(Event::AgentSign(request)).is_ok() {
            timeout(wait, answer).await.ok().and_then(|r| r.ok())
        } else {
            None
        };
        self.pending.lock().unwrap().remove(&id);
        match decision {
            Some(Decision::Once) => true,
            Some(Decision::Connection) => {
                *self.allowed_until.lock().unwrap() = Some(Instant::now() + ALLOW_FOR);
                true
            }
            Some(Decision::Deny) | None => false,
        }
    }
    fn notice_once(&self, broker: &Broker, message: &str) {
        if !self.notified.swap(true, SeqCst) {
            let _ = broker.send(Event::AgentNotice {
                message: message.into(),
            });
        }
    }
}

/// Asks the final server for forwarding on the terminal channel, before the PTY and the shell.
pub async fn request(channel: &mut Channel<client::Msg>, manager: &Connections, id: &str) {
    let Ok(control) = manager.control(id) else {
        return;
    };
    if !control.profile.forward_agent {
        return;
    }
    let reply = async {
        channel.agent_forward(true).await.ok()?;
        loop {
            match channel.wait().await? {
                ChannelMsg::Success => return Some(true),
                ChannelMsg::Failure => return Some(false),
                _ => {}
            }
        }
    };
    if timeout(Duration::from_secs(10), reply).await.ok().flatten() == Some(true) {
        control.agent.requested.store(true, SeqCst);
    } else {
        control.agent.notice_once(
            &control.broker,
            "서버가 키 전달을 허용하지 않아 이 연결에서는 사용할 수 없습니다.",
        );
    }
}

/// A server's request alone never reaches the agent: a jump host, a connection with the option
/// off, and a connection whose server refused the request are all turned away.
fn accepts(host_asked: bool, profile: &Profile, agent: &Agent) -> bool {
    host_asked && profile.forward_agent && agent.requested.load(SeqCst)
}

/// The handler's only call. Dropping `reply` without accepting refuses the channel.
pub fn open(
    host_asked: bool,
    manager: &Connections,
    id: &str,
    channel: Channel<client::Msg>,
    reply: client::ChannelOpenHandle,
) {
    let Ok(control) = manager.control(id) else {
        return;
    };
    if !accepts(host_asked, &control.profile, &control.agent) {
        return;
    }
    let Some(slot) = Slot::take(&control.agent) else {
        return;
    };
    let mut stop = control.stop.subscribe();
    let mut relay = Relay {
        agent: control.agent.clone(),
        broker: control.broker.clone(),
        session: control.profile.name.clone(),
        host_key: None,
    };
    // Owned by the connection: it ends with the channel or when the connection stops.
    tokio::spawn(async move {
        let _slot = slot;
        let Ok(Some(mut local)) = timeout(Duration::from_secs(5), connect_local()).await else {
            relay.agent.notice_once(&relay.broker, LOCAL_MISSING);
            return;
        };
        reply.accept().await;
        let mut channel = channel;
        tokio::select! {
            _ = stop.wait_for(|stopped| *stopped) => {}
            _ = relay.run(&mut channel, &mut local) => {}
        }
        let _ = channel.close().await;
    });
}

type LocalStream = Box<dyn AgentStream + Send + Unpin>;

async fn connect_local() -> Option<LocalStream> {
    #[cfg(windows)]
    let client = AgentClient::connect_named_pipe(crate::ssh_auth::agent_pipe()).await;
    #[cfg(unix)]
    let client = AgentClient::connect_env().await;
    client.ok().map(AgentClient::into_inner)
}

struct Slot(Arc<Agent>);
impl Slot {
    fn take(agent: &Arc<Agent>) -> Option<Self> {
        agent
            .channels
            .try_update(SeqCst, SeqCst, |n| (n < MAX_CHANNELS).then_some(n + 1))
            .ok()?;
        Some(Slot(agent.clone()))
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.channels.fetch_sub(1, SeqCst);
    }
}

struct Relay {
    agent: Arc<Agent>,
    broker: Arc<Broker>,
    session: String,
    /// From the last `session-bind`: the server the remote client says it signs in to.
    host_key: Option<String>,
}

impl Relay {
    /// One request, one answer, in order. A bad frame or a broken local agent ends the channel.
    async fn run(&mut self, channel: &mut Channel<client::Msg>, local: &mut LocalStream) {
        let mut buffer = Vec::new();
        loop {
            match agent_filter::take_frame(&mut buffer) {
                Ok(Some(body)) => {
                    let Some(answer) = self.answer(&body, local).await else {
                        return;
                    };
                    if channel.data(&answer[..]).await.is_err() {
                        return;
                    }
                    continue;
                }
                Ok(None) => {}
                Err(_) => return,
            }
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => buffer.extend_from_slice(&data),
                Some(ChannelMsg::Eof | ChannelMsg::Close) | None => return,
                _ => {}
            }
        }
    }
    async fn answer(&mut self, body: &[u8], local: &mut LocalStream) -> Option<Vec<u8>> {
        let body = match agent_filter::classify(body) {
            Verdict::Refuse => return Some(FAILURE.to_vec()),
            Verdict::Forward => exchange(local, body).await?,
            Verdict::Bind { host_key } => {
                self.host_key = fingerprint(&host_key);
                exchange(local, body).await?
            }
            Verdict::Sign { key, purpose } => {
                let names = agent_filter::identities(
                    &exchange(local, &[agent_filter::REQUEST_IDENTITIES]).await?,
                );
                // A key the local agent does not hold cannot be signed. Nothing to ask about.
                let Some((_, comment)) = names.into_iter().find(|(k, _)| *k == key) else {
                    return Some(FAILURE.to_vec());
                };
                let request = SignRequest {
                    request: String::new(),
                    session: self.session.clone(),
                    key: comment,
                    fingerprint: fingerprint(&key).unwrap_or_default(),
                    login_user: match &purpose {
                        Purpose::Login { user } => Some(user.clone()),
                        _ => None,
                    },
                    namespace: match purpose {
                        Purpose::Signature { namespace } => Some(namespace),
                        _ => None,
                    },
                    host_key: self.host_key.clone(),
                    seconds: 0,
                };
                if !self.agent.approve(&self.broker, request, ANSWER_TIME).await {
                    return Some(FAILURE.to_vec());
                }
                exchange(local, body).await?
            }
        };
        Some(agent_filter::frame(&body))
    }
}

fn fingerprint(blob: &[u8]) -> Option<String> {
    let key = PublicKey::from_bytes(blob).ok()?;
    Some(key.fingerprint(HashAlg::Sha256).to_string())
}

/// Sends one request to the local agent and reads its answer body.
async fn exchange(local: &mut LocalStream, body: &[u8]) -> Option<Vec<u8>> {
    let work = async {
        local.write_all(&agent_filter::frame(body)).await.ok()?;
        let mut header = [0; 4];
        local.read_exact(&mut header).await.ok()?;
        let length = u32::from_be_bytes(header) as usize;
        if length == 0 || length > agent_filter::MAX_FRAME {
            return None;
        }
        let mut answer = vec![0; length];
        local.read_exact(&mut answer).await.ok()?;
        Some(answer)
    };
    timeout(LOCAL_TIME, work).await.ok().flatten()
}

#[tauri::command]
pub async fn agent_sign_reply(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
    request: String,
    decision: Decision,
) -> Result<()> {
    let control = state.connections.control(&id)?;
    control.broker.check(window.label())?;
    control.agent.reply(&request, decision)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn recorder() -> (Arc<Broker>, Arc<StdMutex<Vec<String>>>) {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let sink = seen.clone();
        let broker = Broker::new(Arc::new(move |event| {
            if let Event::AgentSign(request) = event {
                sink.lock().unwrap().push(request.request);
            }
            Ok(())
        }));
        (Arc::new(broker), seen)
    }
    fn request() -> SignRequest {
        SignRequest {
            request: String::new(),
            session: "s".into(),
            key: "me".into(),
            fingerprint: "SHA256:x".into(),
            login_user: None,
            namespace: None,
            host_key: None,
            seconds: 0,
        }
    }
    async fn answered(
        agent: &Arc<Agent>,
        broker: &Arc<Broker>,
        decision: Option<Decision>,
    ) -> bool {
        let (agent2, broker2) = (agent.clone(), broker.clone());
        let task = tokio::spawn(async move {
            agent2
                .approve(&broker2, request(), Duration::from_millis(300))
                .await
        });
        if let Some(decision) = decision {
            let id = loop {
                if let Some(id) = agent.pending.lock().unwrap().keys().next().cloned() {
                    break id;
                }
                tokio::task::yield_now().await;
            };
            agent.reply(&id, decision).unwrap();
        }
        task.await.unwrap()
    }

    #[tokio::test]
    async fn every_signature_waits_and_silence_refuses() {
        let agent = Arc::new(Agent::default());
        let (broker, seen) = recorder();
        assert!(!answered(&agent, &broker, Some(Decision::Deny)).await);
        assert!(answered(&agent, &broker, Some(Decision::Once)).await);
        assert!(!answered(&agent, &broker, None).await, "timeout refuses");
        assert_eq!(
            seen.lock().unwrap().len(),
            3,
            "once is not a standing allowance"
        );
        assert!(agent.pending.lock().unwrap().is_empty());
        assert!(agent.reply("gone", Decision::Once).is_err());
        assert!(answered(&agent, &broker, Some(Decision::Connection)).await);
        assert!(
            answered(&agent, &broker, None).await,
            "allowed for this connection"
        );
        assert_eq!(seen.lock().unwrap().len(), 4);
        *agent.allowed_until.lock().unwrap() = Some(Instant::now());
        assert!(
            !answered(&agent, &broker, None).await,
            "the allowance expires"
        );
    }

    #[test]
    fn sign_events_are_not_replayed_to_a_new_window() {
        let (broker, _) = recorder();
        broker
            .send(Event::State {
                status: "connected".into(),
                message: String::new(),
            })
            .unwrap();
        broker.send(Event::AgentSign(request())).unwrap();
        broker
            .send(Event::AgentNotice {
                message: "n".into(),
            })
            .unwrap();
        let replayed = Arc::new(StdMutex::new(Vec::new()));
        let sink = replayed.clone();
        broker
            .attach(
                "terminal-x".into(),
                Arc::new(move |event| {
                    sink.lock().unwrap().push(match event {
                        Event::State { status, .. } => status,
                        Event::Replay { .. } => "replay".into(),
                        _ => "other".into(),
                    });
                    Ok(())
                }),
            )
            .unwrap();
        assert_eq!(
            *replayed.lock().unwrap(),
            ["replay", "connected", "replay"],
            "the connected state survives and no request is replayed"
        );
    }

    #[test]
    fn only_the_connection_that_asked_accepts_a_channel() {
        let agent = Agent::default();
        let mut profile = crate::storage::tests::profile();
        profile.forward_agent = true;
        assert!(
            !accepts(true, &profile, &agent),
            "the server refused or was never asked"
        );
        agent.requested.store(true, SeqCst);
        assert!(accepts(true, &profile, &agent));
        assert!(!accepts(false, &profile, &agent), "a jump host");
        profile.forward_agent = false;
        assert!(!accepts(true, &profile, &agent), "the option is off");
    }

    #[test]
    fn a_connection_holds_at_most_eight_channels() {
        let agent = Arc::new(Agent::default());
        let slots: Vec<_> = (0..MAX_CHANNELS)
            .filter_map(|_| Slot::take(&agent))
            .collect();
        assert_eq!(slots.len(), MAX_CHANNELS);
        assert!(Slot::take(&agent).is_none());
        drop(slots);
        assert!(Slot::take(&agent).is_some());
    }
}
