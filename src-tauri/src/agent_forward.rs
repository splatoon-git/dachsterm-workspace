//! Agent forwarding for the final server of an SSH connection. Someone with rights on that server,
//! or a program running there, can ask to sign with the user's keys. So only the connection that
//! asked for forwarding gets a channel, only listing and signing are answered, and every
//! signature waits for the user's answer in the app. Keys come from the app itself
//! (`agent_keys`, DX.11) and from this PC's SSH agent; `agent_relay` answers each request. The
//! approval state here is also a local tab's (DX.13).
use crate::{
    agent_filter,
    agent_keys::{AppKeys, Ask, Reply, Source},
    agent_relay::{self, Relay},
    approval::Notify,
    ssh::{Connections, Event},
    ssh_keys,
    storage::{Profile, Result},
};
use russh::{Channel, ChannelMsg, client, keys::PrivateKey};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst},
    },
    time::{Duration, Instant},
};
use tokio::{sync::oneshot, task::spawn_blocking, time::timeout};
use zeroize::Zeroizing;

pub const MAX_CHANNELS: usize = 8;
const ALLOW_FOR: Duration = Duration::from_secs(600);
const NO_KEYS: &str =
    "전달할 키가 없습니다. 세션 고급 옵션에서 키를 고르거나 이 PC의 SSH agent에 키를 등록하세요.";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Decision {
    Deny,
    Once,
    /// Every signature on this connection, or in this local tab, for the next ten minutes.
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

/// Where a chosen key file and its saved Passphrase are listed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KeyOwner {
    /// A session's keys to forward (DX.11), by profile ID.
    Session(String),
    /// The keys local tabs offer, in the app settings (DX.13).
    Local,
}

/// A chosen key file to unlock when the user allows the signature.
#[derive(Clone, Debug)]
pub struct Unlock {
    pub keys: KeyOwner,
    pub path: String,
}

struct Pending {
    sender: oneshot::Sender<Answer>,
    unlock: Option<Unlock>,
}
pub(crate) struct Answer {
    pub(crate) decision: Decision,
    pub(crate) key: Option<Arc<PrivateKey>>,
}

/// Per connection or local tab, in memory only. Locks are never held across an await.
#[derive(Default)]
pub struct Agent {
    requested: AtomicBool,
    channels: AtomicUsize,
    notified: AtomicBool,
    pub(crate) sha1_notified: AtomicBool,
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
        self.allowed_until()
            .is_some_and(|until| Instant::now() < until)
    }
    pub(crate) fn allowed_until(&self) -> Option<Instant> {
        *self.allowed_until.lock().unwrap()
    }
    /// No answer, a closed window or a moved terminal all end as a refusal. A standing allowance
    /// skips the card unless a key still has to be unlocked.
    pub(crate) async fn approve(
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
    pub(crate) fn notice_once(&self, flag: &AtomicBool, events: &dyn Notify, message: &str) {
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
        keys: KeyOwner::Session(control.profile.id.clone()),
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
            relay.system = agent_relay::connect_system().await;
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
            _ = run(&mut relay, &mut channel) => {}
        }
        let _ = channel.close().await;
    });
}

/// One of a connection's or a local tab's agent clients, counted while it lives.
pub struct Slot(Arc<Agent>);
impl Slot {
    pub fn take(agent: &Arc<Agent>) -> Option<Self> {
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

/// One request, one answer, in order. A bad frame ends the channel.
async fn run(relay: &mut Relay, channel: &mut Channel<client::Msg>) {
    let mut buffer = Vec::new();
    loop {
        match agent_filter::take_frame(&mut buffer) {
            Ok(Some(body)) => {
                let answer = relay.answer(&body).await;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::Broker;
    use russh::keys::HashAlg;
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
            keys: KeyOwner::Session("p".into()),
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
