//! Waiting for the card and what an answer allows: one card per host, the time limits, the
//! reuse of an allowed value, and the cut-off for repeated requests.
use super::{Credential, CredentialRequest, Decision, MAX_CHANNELS, protocol};
use crate::{approval::Notify as Cards, ssh::Event, storage::Result};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst},
    },
    time::{Duration, Instant},
};
use tokio::{
    sync::{Notify, oneshot},
    time::sleep_until,
};

pub(super) const ANSWER_TIME: Duration = Duration::from_secs(60);
/// "Allow once" also answers the rest of the same push: an LFS push asks three times (DX.12.0).
pub(super) const ONCE_REUSE: Duration = Duration::from_secs(30);
pub(super) const ALLOW_FOR: Duration = Duration::from_secs(600);
/// An old git-lfs repeats `get` endlessly while the server refuses the value (DX.12.0), about
/// 40 a second. One LFS push asks three times, so two pushes in a row stay below this.
pub(super) const BURST: usize = 10;
pub(super) const BURST_WINDOW: Duration = Duration::from_secs(10);
pub(super) const BURST_BLOCK: Duration = Duration::from_secs(60);
pub(super) const ENDED: &str = "자격 증명 요청이 이미 끝났습니다.";
/// Typing a token on the card.
pub(super) const INPUT_TIME: Duration = Duration::from_secs(120);

/// One connection's forward, or one WSL tab's pipe (DX.14), in memory only. Locks are never held
/// across an await.
pub struct Forward {
    pub(super) path: Mutex<Option<String>>,
    pub(super) helpers: Vec<String>,
    /// A WSL tab: the value goes to git in this PC's WSL, and the card says so.
    pub(super) local: bool,
    pub(super) channels: AtomicUsize,
    pub(super) pending: Mutex<HashMap<String, Pending>>,
    pub(super) allowed: Mutex<Vec<Allowance>>,
    pub(super) recent: Mutex<HashMap<String, Vec<Instant>>>,
    pub(super) blocked: Mutex<HashMap<String, Instant>>,
    /// Hosts with a card on screen. A later request for one waits and may reuse its answer.
    pub(super) asking: Mutex<HashSet<String>>,
    pub(super) turn: Notify,
    pub(super) http_notified: AtomicBool,
    pub(super) burst_notified: AtomicBool,
}

pub(super) enum Answer {
    Deny,
    Allow(Decision, Credential),
}

pub(super) struct Pending {
    pub(super) sender: oneshot::Sender<Answer>,
    pub(super) ask: protocol::Request,
    pub(super) deadline: Instant,
    pub(super) fetching: bool,
}

pub(super) struct Allowance {
    pub(super) host: String,
    pub(super) credential: Credential,
    pub(super) until: Instant,
}

impl Forward {
    pub(super) fn new(path: String, helpers: Vec<String>, local: bool) -> Self {
        Self {
            path: Mutex::new(Some(path)),
            helpers,
            local,
            channels: AtomicUsize::new(0),
            pending: Mutex::default(),
            allowed: Mutex::default(),
            recent: Mutex::default(),
            blocked: Mutex::default(),
            asking: Mutex::default(),
            turn: Notify::new(),
            http_notified: AtomicBool::new(false),
            burst_notified: AtomicBool::new(false),
        }
    }
    /// Only the path this connection asked for. sshd names it on every channel it opens.
    pub(super) fn serves(&self, path: &str) -> bool {
        self.path.lock().unwrap().as_deref() == Some(path)
    }
    /// Waiting requests end as refusals and allowed values leave memory.
    pub(super) fn forget(&self) {
        self.pending.lock().unwrap().clear();
        self.allowed.lock().unwrap().clear();
    }
    pub(super) fn notice_once(&self, flag: &AtomicBool, cards: &dyn Cards, message: &str) {
        if !flag.swap(true, SeqCst) {
            let _ = cards.notify(Event::AgentNotice {
                message: message.into(),
            });
        }
    }
    /// Counts every `get`, answered from an allowance or not: an allowance would otherwise send
    /// the same token again and again to a server that keeps refusing it.
    pub(super) fn flooding(&self, host: &str) -> bool {
        let (host, now) = (host.to_ascii_lowercase(), Instant::now());
        let mut blocked = self.blocked.lock().unwrap();
        if blocked.get(&host).is_some_and(|until| now < *until) {
            return true;
        }
        let mut recent = self.recent.lock().unwrap();
        let times = recent.entry(host.clone()).or_default();
        times.retain(|at| now.duration_since(*at) < BURST_WINDOW);
        times.push(now);
        if times.len() > BURST {
            times.clear();
            blocked.insert(host, now + BURST_BLOCK);
            return true;
        }
        false
    }
    pub(super) fn allowed_for(&self, request: &protocol::Request) -> Option<Credential> {
        let now = Instant::now();
        let mut allowed = self.allowed.lock().unwrap();
        allowed.retain(|a| now < a.until);
        allowed
            .iter()
            .find(|a| {
                a.host.eq_ignore_ascii_case(&request.host)
                    && request
                        .username
                        .as_ref()
                        .is_none_or(|u| **u == *a.credential.username)
            })
            .map(|a| a.credential.clone())
    }
    pub(super) fn allow(&self, decision: Decision, host: &str, credential: &Credential) {
        let reuse = if decision == Decision::Connection {
            ALLOW_FOR
        } else {
            ONCE_REUSE
        };
        self.allowed.lock().unwrap().push(Allowance {
            host: host.to_string(),
            credential: credential.clone(),
            until: Instant::now() + reuse,
        });
    }
    /// One card per host at a time. A request that waited first looks at what the card allowed.
    pub(super) async fn credential(
        &self,
        cards: &dyn Cards,
        session: &str,
        request: protocol::Request,
    ) -> Option<Credential> {
        let host = request.host.to_ascii_lowercase();
        loop {
            if let Some(found) = self.allowed_for(&request) {
                return Some(found);
            }
            let turn = self.turn.notified();
            tokio::pin!(turn);
            turn.as_mut().enable();
            if self.asking.lock().unwrap().insert(host.clone()) {
                break;
            }
            turn.await;
        }
        let _asking = Asking(self, host);
        match self.approve(cards, session, request.clone()).await? {
            Answer::Allow(decision, credential) => {
                self.allow(decision, &request.host, &credential);
                Some(credential)
            }
            Answer::Deny => None,
        }
    }
    /// No answer, a closed window or a moved terminal all end as a refusal, and git then asks in
    /// the terminal as it would without the app.
    pub(super) async fn approve(
        &self,
        cards: &dyn Cards,
        session: &str,
        ask: protocol::Request,
    ) -> Option<Answer> {
        let plain = |text: &str| crate::agent_filter::plain(text.as_bytes());
        let (sender, mut receiver) = oneshot::channel();
        let id = uuid::Uuid::new_v4().to_string();
        let event = CredentialRequest {
            request: id.clone(),
            session: session.to_string(),
            host: plain(&ask.host),
            path: ask.path.as_deref().map(plain),
            username: ask.username.as_deref().map(plain),
            server_helpers: self.helpers.clone(),
            local: self.local,
            seconds: ANSWER_TIME.as_secs(),
        };
        self.pending.lock().unwrap().insert(
            id.clone(),
            Pending {
                sender,
                ask,
                deadline: Instant::now() + ANSWER_TIME,
                fetching: false,
            },
        );
        let answer = if cards.notify(Event::GitCredential(event)).is_ok() {
            self.wait(&id, &mut receiver).await
        } else {
            None
        };
        self.pending.lock().unwrap().remove(&id);
        answer
    }
    /// The card's answer, or none by the deadline. Fetching a value or typing one moves it.
    pub(super) async fn wait(
        &self,
        id: &str,
        receiver: &mut oneshot::Receiver<Answer>,
    ) -> Option<Answer> {
        loop {
            let Some(deadline) = self.pending.lock().unwrap().get(id).map(|p| p.deadline) else {
                return receiver.await.ok();
            };
            tokio::select! {
                answer = &mut *receiver => return answer.ok(),
                _ = sleep_until(deadline.into()) => {
                    let moved = self.pending.lock().unwrap().get(id).is_some_and(|p| p.deadline > deadline);
                    if !moved {
                        return None;
                    }
                }
            }
        }
    }
    pub(super) fn with<T>(
        &self,
        request: &str,
        f: impl FnOnce(&mut Pending) -> Result<T>,
    ) -> Result<T> {
        f(self.pending.lock().unwrap().get_mut(request).ok_or(ENDED)?)
    }
    pub(super) fn extend(&self, request: &str, by: Duration) -> Result<()> {
        self.with(request, |p| {
            p.deadline = Instant::now() + by;
            Ok(())
        })
    }
    /// One fetch per request: a second press while a sign-in window is open is refused.
    pub(super) fn begin_fetch(&self, request: &str) -> Result<protocol::Request> {
        self.with(request, |p| {
            if p.fetching {
                return Err("이미 값을 가져오고 있습니다.".into());
            }
            p.fetching = true;
            p.deadline = Instant::now() + super::local::FILL_TIME + Duration::from_secs(10);
            Ok(p.ask.clone())
        })
    }
    pub(super) fn end_fetch(&self, request: &str) {
        let _ = self.with(request, |p| {
            p.fetching = false;
            Ok(())
        });
    }
    pub(super) fn send(&self, request: &str, answer: Answer) -> Result<()> {
        let pending = self.pending.lock().unwrap().remove(request).ok_or(ENDED)?;
        let _ = pending.sender.send(answer);
        Ok(())
    }
}

struct Asking<'a>(&'a Forward, String);
impl Drop for Asking<'_> {
    fn drop(&mut self) {
        self.0.asking.lock().unwrap().remove(&self.1);
        self.0.turn.notify_waiters();
    }
}

pub(super) struct Slot(pub(super) Arc<Forward>);
impl Slot {
    pub(super) fn take(forward: &Arc<Forward>) -> Option<Self> {
        forward
            .channels
            .try_update(SeqCst, SeqCst, |n| (n < MAX_CHANNELS).then_some(n + 1))
            .ok()?;
        Some(Slot(forward.clone()))
    }
}
impl Drop for Slot {
    fn drop(&mut self) {
        self.0.channels.fetch_sub(1, SeqCst);
    }
}
