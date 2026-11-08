//! One agent client, answered by the app: a server's forwarded channel (`agent_forward`, DX.2,
//! DX.11) or a program in a local tab (`local_agent`, DX.13). Listing merges the app's keys with
//! this PC's SSH agent; signing with an app key always waits for the card. A server also needs the
//! card for this PC's agent, but a local program could reach that agent before this app existed,
//! so a local tab passes those requests on without one.
use crate::{
    agent_filter::{self, FAILURE, Purpose, Verdict},
    agent_forward::{Agent, Decision, KeyOwner, SignRequest, Unlock},
    agent_keys::{self, Identity, Origin, Source},
    approval::Notify,
    ssh_keys,
    storage::ForwardKey,
};
use russh::keys::{
    HashAlg, PrivateKey, PublicKey,
    agent::client::{AgentClient, AgentStream},
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::watch,
    task::spawn_blocking,
    time::timeout,
};

const ANSWER_TIME: Duration = Duration::from_secs(60);
/// A chosen key that needs its Passphrase typed on the card.
const PASSPHRASE_TIME: Duration = Duration::from_secs(120);
/// A local agent may ask for its own confirmation, so it gets longer than the user's answer.
const LOCAL_TIME: Duration = Duration::from_secs(120);
/// `SSH_AGENT_SUCCESS`, length-prefixed.
const SUCCESS: [u8; 5] = [0, 0, 0, 1, 6];
const SHA1_REFUSED: &str = "RSA 키의 SHA-1 서명 요청을 거부했습니다. 서버의 SSH 클라이언트가 rsa-sha2-256/512를 쓰도록 업데이트하세요.";
const SHA1_REFUSED_LOCAL: &str = "RSA 키의 SHA-1 서명 요청을 거부했습니다. 이 PC의 SSH 클라이언트가 rsa-sha2-256/512를 쓰도록 업데이트하세요.";

pub type LocalStream = Box<dyn AgentStream + Send + Unpin>;

/// This PC's SSH agent, if it answers. Never the app's own pipe or socket.
pub async fn connect_system() -> Option<LocalStream> {
    let connect = async {
        #[cfg(windows)]
        let client = AgentClient::connect_named_pipe(crate::ssh_auth::agent_pipe()).await;
        #[cfg(unix)]
        let client = AgentClient::connect_env().await;
        client.ok().map(AgentClient::into_inner)
    };
    timeout(Duration::from_secs(5), connect)
        .await
        .ok()
        .flatten()
}

pub struct Relay {
    pub agent: Arc<Agent>,
    pub events: Arc<dyn Notify>,
    /// The session's name, or the local tab's.
    pub session: String,
    pub keys: KeyOwner,
    /// The session's login key file; empty for a local tab.
    pub login_path: String,
    pub extras: Vec<ForwardKey>,
    /// This PC's SSH agent, when it is used and answered.
    pub system: Option<LocalStream>,
    /// From the last `session-bind`: the server the client says it signs in to.
    pub host_key: Option<String>,
    pub stop: watch::Receiver<bool>,
}

impl Relay {
    fn local(&self) -> bool {
        self.keys == KeyOwner::Local
    }
    /// A framed answer for one request body.
    pub async fn answer(&mut self, body: &[u8]) -> Vec<u8> {
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
    pub async fn app_identities(&mut self) -> Vec<Identity> {
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
    async fn by_system(&mut self, body: &[u8]) -> Vec<u8> {
        self.system(body)
            .await
            .map_or_else(|| FAILURE.to_vec(), |b| agent_filter::frame(&b))
    }
    async fn sign(&mut self, body: &[u8], key: Vec<u8>, purpose: Purpose) -> Vec<u8> {
        // A key nobody here holds cannot be signed. Nothing to ask about.
        let Some(identity) = self.identities().await.into_iter().find(|i| i.blob == key) else {
            return FAILURE.to_vec();
        };
        if identity.origin == Origin::System && self.local() {
            return self.by_system(body).await;
        }
        let Some((data, flags)) = agent_keys::sign_request(body) else {
            return FAILURE.to_vec();
        };
        if identity.source() == Source::App && agent_keys::refuses_sha1(&key, flags) {
            let message = if self.local() {
                SHA1_REFUSED_LOCAL
            } else {
                SHA1_REFUSED
            };
            self.agent
                .notice_once(&self.agent.sha1_notified, &*self.events, message);
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
                keys: self.keys.clone(),
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
            local: self.local(),
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
            return self.by_system(body).await;
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
        let until = self.agent.allowed_until().unwrap_or_else(Instant::now);
        self.agent.keys.hold(blob, key, until);
        let agent = self.agent.clone();
        let mut stop = self.stop.clone();
        // Owned by the connection or tab: ends when the allowance ends or the owner stops.
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
