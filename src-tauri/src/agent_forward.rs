//! Agent forwarding for the final server of an SSH connection. Someone with rights on that server,
//! or a program running there, can ask to sign with the user's keys. So only the connection that
//! asked for forwarding gets a channel, only listing and signing are answered, and every
//! signature waits for the user's answer in the app. Keys come from the app itself
//! (`agent_keys`, DX.11) and from this PC's SSH agent; this module picks the source.
use crate::{
    agent_filter::{self, FAILURE, Purpose, Verdict},
    agent_keys::{self, AppKeys, Ask, Identity, Origin, Reply, Source},
    approval::Notify,
    ssh::{Connections, Event},
    ssh_keys,
    storage::{ForwardKey, Profile, Result},
};
use russh::{
    Channel, ChannelMsg, client,
    keys::{
        HashAlg, PrivateKey, PublicKey,
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
    sync::{oneshot, watch},
    task::spawn_blocking,
    time::timeout,
};
use zeroize::Zeroizing;

pub const MAX_CHANNELS: usize = 8;
const ANSWER_TIME: Duration = Duration::from_secs(60);
/// A chosen key that needs its Passphrase typed on the card.
const PASSPHRASE_TIME: Duration = Duration::from_secs(120);
const ALLOW_FOR: Duration = Duration::from_secs(600);
/// A local agent may ask for its own confirmation, so it gets longer than the user's answer.
const LOCAL_TIME: Duration = Duration::from_secs(120);
/// `SSH_AGENT_SUCCESS`, length-prefixed.
const SUCCESS: [u8; 5] = [0, 0, 0, 1, 6];
const NO_KEYS: &str =
    "전달할 키가 없습니다. 세션 고급 옵션에서 키를 고르거나 이 PC의 SSH agent에 키를 등록하세요.";
const SHA1_REFUSED: &str = "RSA 키의 SHA-1 서명 요청을 거부했습니다. 서버의 SSH 클라이언트가 rsa-sha2-256/512를 쓰도록 업데이트하세요.";

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
    pub source: Source,
    /// Asked by a program in a local tab (DX.13), not by a server.
    pub local: bool,
    /// The key file is encrypted and not unlocked: allowing asks for its Passphrase.
    pub passphrase: bool,
    pub seconds: u64,
}

/// A chosen key file to unlock when the user allows the signature.
#[derive(Clone, Debug)]
pub struct Unlock {
    pub profile: String,
    pub path: String,
}

struct Pending {
    sender: oneshot::Sender<Answer>,
    unlock: Option<Unlock>,
}
struct Answer {
    decision: Decision,
    key: Option<Arc<PrivateKey>>,
}

/// Per connection, in memory only. Locks are never held across an await.
#[derive(Default)]
pub struct Agent {
    requested: AtomicBool,
    channels: AtomicUsize,
    notified: AtomicBool,
    sha1_notified: AtomicBool,
    allowed_until: Mutex<Option<Instant>>,
    pending: Mutex<HashMap<String, Pending>>,
    pub keys: AppKeys,
}

impl Agent {
    /// An answer that needs no key from the card. A request waiting for a Passphrase uses `answer`.
    pub fn reply(&self, request: &str, decision: Decision) -> Result<()> {
        if decision != Decision::Deny && self.unlock_of(request)?.is_some() {
            return Err("이 키는 Passphrase가 필요합니다.".into());
        }
        self.send(
            request,
            Answer {
                decision,
                key: None,
            },
        )
    }
    fn send(&self, request: &str, answer: Answer) -> Result<()> {
        let pending = self
            .pending
            .lock()
            .unwrap()
            .remove(request)
            .ok_or("서명 요청이 이미 끝났습니다.")?;
        let _ = pending.sender.send(answer);
        Ok(())
    }
    pub fn unlock_of(&self, request: &str) -> Result<Option<Unlock>> {
        Ok(self
            .pending
            .lock()
            .unwrap()
            .get(request)
            .ok_or("서명 요청이 이미 끝났습니다.")?
            .unlock
            .clone())
    }
    /// Unlocks a chosen key with `passphrase` and answers. A wrong one leaves the request open.
    pub async fn answer(
        &self,
        request: &str,
        decision: Decision,
        passphrase: Option<Zeroizing<String>>,
    ) -> Result<Reply> {
        let unlock = match self.unlock_of(request)? {
            Some(unlock) if decision != Decision::Deny => unlock,
            _ => {
                self.reply(request, decision)?;
                return Ok(Reply::Done { notice: None });
            }
        };
        let Some(passphrase) = passphrase else {
            return Ok(Reply::Passphrase {
                reason: Ask::Needed,
            });
        };
        let key = spawn_blocking(move || ssh_keys::load(&unlock.path, &passphrase))
            .await
            .map_err(|_| "개인키를 해독하지 못했습니다.")?;
        match key {
            Ok(key) => {
                self.send(
                    request,
                    Answer {
                        decision,
                        key: Some(Arc::new(key)),
                    },
                )?;
                Ok(Reply::Done { notice: None })
            }
            Err(ssh_keys::LoadError::Decode) => Ok(Reply::Passphrase { reason: Ask::Wrong }),
            Err(error) => Err(error.into()),
        }
    }
    fn allowed(&self) -> bool {
        self.allowed_until
            .lock()
            .unwrap()
            .is_some_and(|until| Instant::now() < until)
    }
    /// No answer, a closed window or a moved terminal all end as a refusal. A standing allowance
    /// skips the card unless a key still has to be unlocked.
    async fn approve(
        &self,
        events: &dyn Notify,
        mut request: SignRequest,
        unlock: Option<Unlock>,
        wait: Duration,
    ) -> Option<Answer> {
        if self.allowed() && unlock.is_none() {
            return Some(Answer {
                decision: Decision::Connection,
                key: None,
            });
        }
        let (sender, answer) = oneshot::channel();
        let id = uuid::Uuid::new_v4().to_string();
        request.request = id.clone();
        request.seconds = wait.as_secs();
        request.passphrase = unlock.is_some();
        self.pending
            .lock()
            .unwrap()
            .insert(id.clone(), Pending { sender, unlock });
        let answer = if events.notify(Event::AgentSign(request)).is_ok() {
            timeout(wait, answer).await.ok().and_then(|r| r.ok())
        } else {
            None
        };
        self.pending.lock().unwrap().remove(&id);
        let answer = answer.filter(|a| a.decision != Decision::Deny)?;
        if answer.decision == Decision::Connection {
            *self.allowed_until.lock().unwrap() = Some(Instant::now() + ALLOW_FOR);
        }
        Some(answer)
    }
    fn notice_once(&self, flag: &AtomicBool, events: &dyn Notify, message: &str) {
        if !flag.swap(true, SeqCst) {
            let _ = events.notify(Event::AgentNotice {
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
        // No channel will come, so the login key is not kept either.
        control.agent.keys.forget();
        control.agent.notice_once(
            &control.agent.notified,
            &*control.broker,
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
    let use_system = control.profile.forward_system_agent;
    let mut relay = Relay {
        agent: control.agent.clone(),
        events: control.broker.clone(),
        session: control.profile.name.clone(),
        profile: control.profile.id.clone(),
        login_path: control.profile.key_path.clone(),
        extras: control.profile.forward_keys.clone(),
        system: None,
        host_key: None,
        stop: stop.clone(),
    };
    // Owned by the connection: it ends with the channel or when the connection stops.
    tokio::spawn(async move {
        let _slot = slot;
        if use_system {
            relay.system = timeout(Duration::from_secs(5), connect_local())
                .await
                .ok()
                .flatten();
        }
        // Without this PC's agent the app's keys are enough. Only having none at all is reported.
        if relay.system.is_none() && relay.app_identities().await.is_empty() {
            relay
                .agent
                .notice_once(&relay.agent.notified, &*relay.events, NO_KEYS);
            return;
        }
        reply.accept().await;
        let mut channel = channel;
        tokio::select! {
            _ = stop.wait_for(|stopped| *stopped) => {}
            _ = relay.run(&mut channel) => {}
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
    events: Arc<dyn Notify>,
    session: String,
    profile: String,
    login_path: String,
    extras: Vec<ForwardKey>,
    /// This PC's SSH agent, when the session uses it and it answered.
    system: Option<LocalStream>,
    /// From the last `session-bind`: the server the remote client says it signs in to.
    host_key: Option<String>,
    stop: watch::Receiver<bool>,
}

impl Relay {
    /// One request, one answer, in order. A bad frame ends the channel.
    async fn run(&mut self, channel: &mut Channel<client::Msg>) {
        let mut buffer = Vec::new();
        loop {
            match agent_filter::take_frame(&mut buffer) {
                Ok(Some(body)) => {
                    let answer = self.answer(&body).await;
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
    /// A framed answer for one request body.
    async fn answer(&mut self, body: &[u8]) -> Vec<u8> {
        match agent_filter::classify(body) {
            Verdict::Refuse => FAILURE.to_vec(),
            Verdict::Forward => {
                agent_filter::frame(&agent_keys::identities_answer(&self.identities().await))
            }
            Verdict::Bind { host_key } => {
                self.host_key = fingerprint(&host_key);
                // This PC's agent records the binding for its own keys. The answer is the app's.
                let _ = self.system(body).await;
                SUCCESS.to_vec()
            }
            Verdict::Sign { key, purpose } => self.sign(body, key, purpose).await,
        }
    }
    // `&mut`: the system stream is `Send` but not `Sync`, so a shared borrow cannot cross an await.
    async fn app_identities(&mut self) -> Vec<Identity> {
        let login = self.agent.keys.login();
        let (path, extras) = (self.login_path.clone(), self.extras.clone());
        spawn_blocking(move || agent_keys::app_identities(login.as_deref(), &path, &extras))
            .await
            .unwrap_or_default()
    }
    async fn identities(&mut self) -> Vec<Identity> {
        let app = self.app_identities().await;
        let system = match self.system(&[agent_filter::REQUEST_IDENTITIES]).await {
            Some(body) => agent_filter::identities(&body),
            None => vec![],
        };
        agent_keys::merge(app, system)
    }
    /// One exchange with this PC's agent. A broken one is dropped; the app's keys keep working.
    async fn system(&mut self, body: &[u8]) -> Option<Vec<u8>> {
        let answer = exchange(self.system.as_mut()?, body).await;
        if answer.is_none() {
            self.system = None;
        }
        answer
    }
    async fn sign(&mut self, body: &[u8], key: Vec<u8>, purpose: Purpose) -> Vec<u8> {
        // A key nobody here holds cannot be signed. Nothing to ask about.
        let Some(identity) = self.identities().await.into_iter().find(|i| i.blob == key) else {
            return FAILURE.to_vec();
        };
        let Some((data, flags)) = agent_keys::sign_request(body) else {
            return FAILURE.to_vec();
        };
        if identity.source() == Source::App && agent_keys::refuses_sha1(&key, flags) {
            self.agent
                .notice_once(&self.agent.sha1_notified, &*self.events, SHA1_REFUSED);
            return FAILURE.to_vec();
        }
        let held = match &identity.origin {
            Origin::Login => self.agent.keys.login(),
            Origin::Extra(extra) => match self.agent.keys.unlocked(&key) {
                Some(key) => Some(key),
                // Read at the moment of signing and dropped right after.
                None if !extra.encrypted => {
                    let path = extra.path.clone();
                    spawn_blocking(move || ssh_keys::load(&path, "").ok().map(Arc::new))
                        .await
                        .ok()
                        .flatten()
                }
                None => None,
            },
            Origin::System => None,
        };
        let unlock = match &identity.origin {
            Origin::Extra(extra) if held.is_none() => Some(Unlock {
                profile: self.profile.clone(),
                path: extra.path.clone(),
            }),
            _ => None,
        };
        let wait = if unlock.is_some() {
            PASSPHRASE_TIME
        } else {
            ANSWER_TIME
        };
        let request = SignRequest {
            request: String::new(),
            session: self.session.clone(),
            key: identity.comment.clone(),
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
            source: identity.source(),
            local: false,
            passphrase: false,
            seconds: 0,
        };
        let Some(answer) = self
            .agent
            .approve(&*self.events, request, unlock, wait)
            .await
        else {
            return FAILURE.to_vec();
        };
        if identity.origin == Origin::System {
            return self
                .system(body)
                .await
                .map_or_else(|| FAILURE.to_vec(), |b| agent_filter::frame(&b));
        }
        if answer.decision == Decision::Connection
            && let Some(unlocked) = &answer.key
        {
            self.hold(key, unlocked.clone());
        }
        let Some(signer) = held.or(answer.key) else {
            return FAILURE.to_vec();
        };
        let data = data.to_vec();
        match spawn_blocking(move || agent_keys::sign(&signer, &data, flags)).await {
            Ok(Ok(response)) => agent_filter::frame(&response),
            _ => FAILURE.to_vec(),
        }
    }
    /// Keeps a key unlocked for "allow for 10 minutes" and no longer.
    fn hold(&self, blob: Vec<u8>, key: Arc<PrivateKey>) {
        let until = self
            .agent
            .allowed_until
            .lock()
            .unwrap()
            .unwrap_or_else(Instant::now);
        self.agent.keys.hold(blob, key, until);
        let agent = self.agent.clone();
        let mut stop = self.stop.clone();
        // Owned by the connection: ends when the allowance ends or the connection stops.
        tokio::spawn(async move {
            tokio::select! {
                _ = tokio::time::sleep_until(until.into()) => agent.keys.expire(),
                _ = stop.wait_for(|stopped| *stopped) => agent.keys.forget(),
            }
        });
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::Broker;
    use std::sync::Mutex as StdMutex;

    fn recorder() -> (Arc<Broker>, Arc<StdMutex<Vec<SignRequest>>>) {
        let seen = Arc::new(StdMutex::new(Vec::new()));
        let sink = seen.clone();
        let broker = Broker::new(Arc::new(move |event| {
            if let Event::AgentSign(request) = event {
                sink.lock().unwrap().push(request);
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
            source: Source::System,
            local: false,
            passphrase: false,
            seconds: 0,
        }
    }
    async fn pending(agent: &Agent) -> String {
        loop {
            if let Some(id) = agent.pending.lock().unwrap().keys().next().cloned() {
                return id;
            }
            tokio::task::yield_now().await;
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
                .approve(&*broker2, request(), None, Duration::from_millis(300))
                .await
                .is_some()
        });
        if let Some(decision) = decision {
            let id = pending(agent).await;
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

    #[tokio::test]
    async fn a_locked_key_is_unlocked_on_the_card_even_while_allowed() {
        let dir = tempfile::tempdir().unwrap();
        let phrase = uuid::Uuid::new_v4().to_string();
        let path = crate::ssh_keys::tests::generate(dir.path(), "git", &["-t", "ed25519"], &phrase);
        let agent = Arc::new(Agent::default());
        let (broker, seen) = recorder();
        *agent.allowed_until.lock().unwrap() = Some(Instant::now() + ALLOW_FOR);
        let unlock = Unlock {
            profile: "p".into(),
            path: path.clone(),
        };
        let (agent2, broker2) = (agent.clone(), broker.clone());
        let task = tokio::spawn(async move {
            agent2
                .approve(&*broker2, request(), Some(unlock), Duration::from_secs(30))
                .await
        });
        let id = pending(&agent).await;
        let shown = seen.lock().unwrap()[0].clone();
        assert!(shown.passphrase, "the card asks for the Passphrase");
        assert!(
            agent.reply(&id, Decision::Once).is_err(),
            "no key, no answer"
        );
        assert_eq!(
            agent.answer(&id, Decision::Once, None).await,
            Ok(Reply::Passphrase {
                reason: Ask::Needed
            })
        );
        let wrong = Some(Zeroizing::new("wrong".to_string()));
        assert_eq!(
            agent.answer(&id, Decision::Once, wrong).await,
            Ok(Reply::Passphrase { reason: Ask::Wrong }),
        );
        let right = Some(Zeroizing::new(phrase));
        assert_eq!(
            agent.answer(&id, Decision::Once, right).await,
            Ok(Reply::Done { notice: None })
        );
        let answer = task.await.unwrap().expect("allowed");
        let expected = crate::ssh_keys::load(&path, "").err();
        assert_eq!(expected, Some(crate::ssh_keys::LoadError::Decode));
        assert_eq!(
            answer
                .key
                .unwrap()
                .public_key()
                .fingerprint(HashAlg::Sha256)
                .to_string(),
            crate::ssh_keys::info(&path).unwrap().fingerprint.unwrap()
        );
        assert!(agent.pending.lock().unwrap().is_empty());
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
