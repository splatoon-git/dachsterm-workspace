use crate::storage::{Profile, Result, Store};
use crate::terminal_output::{Other, pump};
use russh::{ChannelMsg, Disconnect, client};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    time::timeout,
};
use zeroize::Zeroizing;
mod event;
mod first_hop;
mod host;
mod host_key;
mod proxy_command;
pub(crate) mod route;
pub use event::{AuthPrompt, Event};
pub use host::Host;
pub use route::Secrets;

pub struct AuthReply {
    pub challenge: String,
    pub responses: Zeroizing<Vec<String>>,
}
pub type Sink = Arc<dyn Fn(Event) -> Result<()> + Send + Sync>;
pub enum Input {
    Data(Vec<u8>),
    Resize(u32, u32),
}
pub struct Control {
    pub auth_reply: mpsc::Sender<AuthReply>,
    pub profile: Profile,
    pub input: mpsc::Sender<Input>,
    pub stop: watch::Sender<bool>,
    pub trust: watch::Sender<Option<bool>>,
    pub trust_request: Arc<Mutex<Option<String>>>,
    pub ack: watch::Sender<u64>,
    pub broker: Arc<crate::windows::Broker>,
    pub agent: Arc<crate::agent_forward::Agent>,
}
#[derive(Default)]
pub struct Connections {
    pub logs: Arc<crate::session_log::Logs>,
    pub ftp: Mutex<HashMap<String, Arc<crate::ftp::Session>>>,
    pub entries: Mutex<HashMap<String, Arc<Control>>>,
    pub host_lock: Mutex<()>,
    pub forwards: Mutex<HashMap<(String, u16), crate::tunnels::Forwarded>>,
    pub live: Mutex<HashMap<String, std::sync::Weak<client::Handle<Host>>>>,
    pub launches: crate::terminal_start::Launches,
    pub git: crate::git_credential::Forwards,
    pub net: crate::net_tools::link::Links,
    pub streaming: Mutex<std::collections::HashSet<String>>,
    pub serial: crate::serial::Breaks,
}
impl Connections {
    pub fn handle(&self, id: &str) -> Result<Arc<client::Handle<Host>>> {
        self.live
            .lock()
            .unwrap()
            .get(id)
            .and_then(|h| h.upgrade())
            .filter(|h| !h.is_closed())
            .ok_or("연결이 준비되지 않았습니다.".into())
    }
    pub fn control(&self, id: &str) -> Result<Arc<Control>> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("연결이 종료되었습니다.".into())
    }
    pub fn shutdown(&self) {
        for c in self.entries.lock().unwrap().values() {
            let _ = c.stop.send(true);
        }
    }
    pub fn start(
        self: &Arc<Self>,
        id: String,
        profile: Profile,
        secret: Zeroizing<String>,
        paths: Vec<PathBuf>,
        sink: Sink,
        store: Arc<Store>,
    ) -> Result<()> {
        if !profile.jump_ids.is_empty() {
            return Err("경유 인증 경로가 필요합니다.".into());
        }
        self.start_route(id, profile, secret, Secrets::default(), paths, sink, store)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn start_route(
        self: &Arc<Self>,
        id: String,
        profile: Profile,
        secret: Zeroizing<String>,
        route: Secrets,
        paths: Vec<PathBuf>,
        sink: Sink,
        store: Arc<Store>,
    ) -> Result<()> {
        let (sink, channels) = self.register(&id, &profile, &route.hops, sink, &store)?;
        let mut stopped = channels.stop.clone();
        let manager = self.clone();
        tokio::spawn(async move {
            let (m, i, s) = (manager.clone(), id.clone(), sink.clone());
            let work = async {
                match profile.protocol.as_str() {
                    "ssh" => run(profile, secret, route, paths, s, channels, m, store, i).await,
                    "telnet" => crate::telnet::run(m, i, profile, s, channels, store).await,
                    "serial" => crate::serial::run(m, i, profile, s, channels, store).await,
                    _ => crate::ftp::run(m, i, profile, secret, s, channels.stop, store).await,
                }
            };
            // A stop first removes the server's credential socket, while the connection still exists.
            let stopping = crate::git_credential::stopping(&mut stopped, &manager, &id);
            let result = tokio::select! {biased;_ = stopping=>Ok(()),r=work=>r};
            manager.finish(&id);
            let (status, message) = match result {
                Ok(()) => ("closed", "연결이 종료되었습니다.".into()),
                Err(e) => ("error", e),
            };
            let _ = sink(Event::State {
                status: status.into(),
                message,
            });
        });
        Ok(())
    }
    /// Takes a connection slot and makes the channels its login answers arrive on. Terminals and
    /// the network tools both start here, so `trust_host` and `auth_reply` serve either.
    pub(crate) fn register(
        &self,
        id: &str,
        profile: &Profile,
        hops: &[(Profile, Option<Zeroizing<String>>)],
        sink: Sink,
        store: &Store,
    ) -> Result<(Sink, Receivers)> {
        profile.validate()?;
        let resolved = crate::routes::resolve(profile, &store.list()?.profiles)?;
        if resolved.len() != hops.len() + 1
            || resolved.iter().zip(hops).any(|(a, b)| a.id != b.0.id)
        {
            return Err("경유 경로가 변경되었습니다. 다시 연결하세요.".into());
        }
        let broker = Arc::new(crate::windows::Broker::new(sink));
        let event_broker = broker.clone();
        let sink: Sink = Arc::new(move |event| event_broker.send(event));
        let (input, rx) = mpsc::channel(64);
        let (auth_reply, replies) = mpsc::channel(1);
        let (stop, stopped) = watch::channel(false);
        let (trust, trusted) = watch::channel(None);
        let trust_request = Arc::new(Mutex::new(None));
        let (ack, acked) = watch::channel(0);
        let mut entries = self.entries.lock().unwrap();
        if entries.len() >= 32 {
            return Err("동시 연결은 최대 32개입니다.".into());
        }
        if entries.contains_key(id) {
            return Err("이미 사용 중인 연결 ID입니다.".into());
        }
        entries.insert(
            id.to_string(),
            Arc::new(Control {
                auth_reply,
                profile: profile.clone(),
                input,
                stop,
                trust,
                trust_request: trust_request.clone(),
                ack,
                broker,
                agent: Arc::default(),
            }),
        );
        Ok((
            sink,
            Receivers {
                replies,
                input: rx,
                trust: trusted,
                trust_request,
                ack: acked,
                stop: stopped,
            },
        ))
    }
    /// Gives the slot back when a connection's task ends, however it ended.
    pub(crate) fn finish(&self, id: &str) {
        if let Ok(control) = self.control(id) {
            let _ = control.stop.send(true);
        }
        self.logs.close(id);
        self.ftp.lock().unwrap().remove(id);
        self.streaming.lock().unwrap().remove(id);
        self.serial.remove(id);
        self.live.lock().unwrap().remove(id);
        self.entries.lock().unwrap().remove(id);
        self.launches.take(id);
    }
}
pub(crate) struct Receivers {
    replies: mpsc::Receiver<AuthReply>,
    pub(crate) input: mpsc::Receiver<Input>,
    trust: watch::Receiver<Option<bool>>,
    trust_request: Arc<Mutex<Option<String>>>,
    pub(crate) ack: watch::Receiver<u64>,
    pub(crate) stop: watch::Receiver<bool>,
}
#[allow(clippy::too_many_arguments)]
async fn run(
    p: Profile,
    secret: Zeroizing<String>,
    secrets: Secrets,
    paths: Vec<PathBuf>,
    sink: Sink,
    mut channels: Receivers,
    manager: Arc<Connections>,
    store: Arc<Store>,
    id: String,
) -> Result<()> {
    let route = route::open(
        route::Target {
            profile: &p,
            secret: Some(secret),
            route: secrets,
            paths: &paths,
            forward_agent: p.forward_agent,
        },
        &mut channels,
        sink.clone(),
        &manager,
        &id,
    )
    .await?;
    let Receivers {
        mut input, mut ack, ..
    } = channels;
    let session = &route.session;
    let git = crate::git_credential::start(session, &manager, &id).await;
    let channel = timeout(Duration::from_secs(p.timeout), async {
        let channel = route.open_shell(&manager, &id).await?;
        channel
            .request_pty(
                true,
                "xterm-256color",
                80,
                24,
                0,
                0,
                &[(russh::Pty::VERASE, 127), (russh::Pty::IUTF8, 1)],
            )
            .await?;
        let git = git.as_ref().map(|g| g.path());
        crate::terminal_start::begin(&channel, &p, manager.launches.take(&id), git).await?;
        Ok::<_, russh::Error>(channel)
    })
    .await
    .map_err(|_| "PTY 생성 시간이 초과되었습니다.")?
    .map_err(|_| "PTY를 열 수 없습니다.")?;
    route.publish(&manager, &id);
    manager.logs.register(&id, &p.encoding)?;
    crate::session_log::auto_start(
        &manager.logs,
        &store,
        &id,
        &format!("ssh:{}", p.id),
        &p.name,
    );
    store.touch(&p.id)?;
    sink(Event::State {
        status: "connected".into(),
        message: format!("연결됨 · {}", route.description),
    })?;
    let (mut reader, writer) = channel.split();
    let output = async {
        let send = |seq, bytes: Vec<u8>| {
            manager.logs.data(&id, &bytes);
            sink(Event::Data { seq, bytes })
        };
        // A refused shell keeps its old behavior. tmux cannot run without its PTY and exec.
        let other = |message| match message {
            ChannelMsg::Close => Other::End,
            ChannelMsg::Failure if !p.tmux_session.is_empty() => {
                Other::Fail("서버가 tmux 시작을 거부했습니다.".to_string())
            }
            _ => Other::Ignore,
        };
        let stalled = "터미널 렌더링 응답이 없어 연결을 종료했습니다.";
        pump(&mut reader, &mut ack, send, other, stalled).await?;
        if session.is_closed() {
            Err(crate::terminal_start::lost_message(&p).to_string())
        } else {
            Ok(())
        }
    };
    let input_loop = async {
        while let Some(command) = input.recv().await {
            let result = timeout(Duration::from_secs(10), async {
                match command {
                    Input::Data(bytes) => writer.data(&bytes[..]).await,
                    Input::Resize(cols, rows) => writer.window_change(cols, rows, 0, 0).await,
                }
            })
            .await;
            if !matches!(result, Ok(Ok(()))) {
                return Err("터미널 입력 전송에 실패했습니다.".to_string());
            }
        }
        Ok(())
    };
    let health = async {
        loop {
            tokio::time::sleep(Duration::from_millis(200)).await;
            if let Some(hop) = route.broken_hop() {
                return Err(format!(
                    "{hop}홉 연결이 끊어졌습니다. 종속 연결을 종료합니다. 재접속은 새 셸입니다."
                ));
            }
        }
    };
    let result = tokio::select! {r=output=>r,r=input_loop=>r,r=health=>r};
    crate::git_credential::finish(&manager, &id).await;
    let _ = timeout(
        Duration::from_secs(2),
        session.disconnect(Disconnect::ByApplication, "closed", "en"),
    )
    .await;
    result
}
