use crate::{
    hostkeys,
    storage::{Profile, Result, Store},
};
use russh::{
    ChannelMsg, Disconnect, client,
    keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate, decode_secret_key},
};
use serde::Serialize;
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

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Replay {
        active: bool,
    },
    AuthPrompt {
        challenge: String,
        name: String,
        instructions: String,
        prompts: Vec<AuthPrompt>,
    },
    State {
        status: String,
        message: String,
    },
    HostKey {
        challenge: String,
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
    },
    Data {
        seq: u64,
        bytes: Vec<u8>,
    },
}
#[derive(Clone, Serialize)]
pub struct AuthPrompt {
    pub prompt: String,
    pub echo: bool,
}
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
}
#[derive(Default)]
pub struct Connections {
    pub logs: Arc<crate::session_log::Logs>,
    pub ftp: Mutex<HashMap<String, Arc<crate::ftp::Session>>>,
    pub entries: Mutex<HashMap<String, Arc<Control>>>,
    pub host_lock: Mutex<()>,
    pub forwards: Mutex<HashMap<(String, u16), crate::tunnels::Forwarded>>,
    pub live: Mutex<HashMap<String, std::sync::Weak<client::Handle<Host>>>>,
}
impl Connections {
    pub fn ftp_session(&self, id: &str) -> Result<Arc<crate::ftp::Session>> {
        self.ftp
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("FTP 연결이 종료되었습니다.".into())
    }
    pub fn ready(&self, id: &str) -> Result<()> {
        if self.control(id)?.profile.protocol == "ssh" {
            self.handle(id)?;
        } else {
            self.ftp_session(id)?;
        }
        Ok(())
    }

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
        self.start_route(id, profile, secret, vec![], paths, sink, store)
    }
    #[allow(clippy::too_many_arguments)]
    pub fn start_route(
        self: &Arc<Self>,
        id: String,
        profile: Profile,
        secret: Zeroizing<String>,
        hops: Vec<(Profile, Option<Zeroizing<String>>)>,
        paths: Vec<PathBuf>,
        sink: Sink,
        store: Arc<Store>,
    ) -> Result<()> {
        profile.validate()?;
        let resolved = crate::routes::resolve(&profile, &store.list()?.profiles)?;
        if resolved.len() != hops.len() + 1
            || resolved.iter().zip(&hops).any(|(a, b)| a.id != b.0.id)
        {
            return Err("경유 경로가 변경되었습니다. 다시 연결하세요.".into());
        }
        let broker = Arc::new(crate::windows::Broker::new(sink));
        let event_broker = broker.clone();
        let sink: Sink = Arc::new(move |event| event_broker.send(event));
        let (input, rx) = mpsc::channel(64);
        let (auth_reply, replies) = mpsc::channel(1);
        let (stop, mut stopped) = watch::channel(false);
        let host_stop = stopped.clone();
        let (trust, trusted) = watch::channel(None);
        let trust_request = Arc::new(Mutex::new(None));
        let (ack, acked) = watch::channel(0);
        {
            let mut entries = self.entries.lock().unwrap();
            if entries.len() >= 32 {
                return Err("동시 연결은 최대 32개입니다.".into());
            }
            if entries.contains_key(&id) {
                return Err("이미 사용 중인 연결 ID입니다.".into());
            }
            entries.insert(
                id.clone(),
                Arc::new(Control {
                    auth_reply,
                    profile: profile.clone(),
                    input,
                    stop,
                    trust,
                    trust_request: trust_request.clone(),
                    ack,
                    broker,
                }),
            );
        }
        let manager = self.clone();
        tokio::spawn(async move {
            let channels = Receivers {
                replies,
                input: rx,
                trust: trusted,
                trust_request,
                ack: acked,
                stop: host_stop,
            };
            let work = async {
                if profile.protocol == "ssh" {
                    run(
                        profile,
                        secret,
                        hops,
                        paths,
                        sink.clone(),
                        channels,
                        manager.clone(),
                        store,
                        id.clone(),
                    )
                    .await
                } else {
                    crate::ftp::run(
                        manager.clone(),
                        id.clone(),
                        profile,
                        secret,
                        sink.clone(),
                        channels.stop,
                        store,
                    )
                    .await
                }
            };
            let result = tokio::select! {biased;_ = stopped.changed()=>Ok(()),r=work=>r};
            if let Ok(control) = manager.control(&id) {
                let _ = control.stop.send(true);
            }
            manager.logs.close(&id);
            manager.ftp.lock().unwrap().remove(&id);
            manager.live.lock().unwrap().remove(&id);
            manager.entries.lock().unwrap().remove(&id);
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
}
pub struct Host {
    id: String,
    profile: Profile,
    paths: Vec<PathBuf>,
    sink: Sink,
    trust: watch::Receiver<Option<bool>>,
    trust_request: Arc<Mutex<Option<String>>>,
    manager: Arc<Connections>,
    failure: Arc<Mutex<Option<String>>>,
    waiting: watch::Sender<bool>,
    stop: watch::Receiver<bool>,
}
impl client::Handler for Host {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> std::result::Result<bool, Self::Error> {
        let result = self.verify(key).await;
        match result {
            Ok(value) => Ok(value),
            Err(message) => {
                *self.failure.lock().unwrap() = Some(message);
                Ok(false)
            }
        }
    }
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _: &str,
        port: u32,
        _: &str,
        _: u32,
        reply: client::ChannelOpenHandle,
        _: &mut client::Session,
    ) -> std::result::Result<(), Self::Error> {
        let route = self
            .manager
            .forwards
            .lock()
            .unwrap()
            .get(&(self.id.clone(), port as u16))
            .cloned();
        if let Some(route) = route
            && route.try_send(channel).is_ok()
        {
            reply.accept().await;
        }
        Ok(())
    }
}
impl Host {
    async fn verify(&mut self, key: &PublicKeyOrCertificate) -> Result<bool> {
        if key.certificate().is_some() {
            return Err("호스트 인증서는 아직 지원되지 않습니다.".into());
        }
        let key = &key.public_key();
        if hostkeys::check(&self.paths, &self.profile.host, self.profile.port, key)? {
            return Ok(true);
        }
        let _ = self.waiting.send(true);
        let challenge = uuid::Uuid::new_v4().to_string();
        *self.trust_request.lock().unwrap() = Some(challenge.clone());
        (self.sink)(Event::HostKey {
            challenge,
            host: self.profile.host.clone(),
            port: self.profile.port,
            algorithm: key.algorithm().to_string(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        })?;
        tokio::select! {
            biased;
            _ = self.stop.changed() => return Err("호스트키 확인이 취소되었습니다.".into()),
            result = timeout(Duration::from_secs(120), self.trust.changed()) => {
                result.map_err(|_| "호스트키 확인 시간이 초과되었습니다.")?.map_err(|_| "호스트키 확인이 취소되었습니다.")?;
            }
        }
        self.trust_request.lock().unwrap().take();
        if *self.trust.borrow() != Some(true) {
            return Err("호스트키 신뢰를 거부했습니다.".into());
        }
        let _ = self.waiting.send(false);
        let _guard = self.manager.host_lock.lock().unwrap();
        // Recheck under the writer lock: simultaneous first connections cannot overwrite trust.
        if !hostkeys::check(&self.paths, &self.profile.host, self.profile.port, key)? {
            hostkeys::remember(&self.paths[0], &self.profile.host, self.profile.port, key)?;
        }
        Ok(true)
    }
}
// Cancellation and every early-return path explicitly disconnect the owned SSH task.
struct SessionGuard(Option<Arc<client::Handle<Host>>>);
impl std::ops::Deref for SessionGuard {
    type Target = client::Handle<Host>;
    fn deref(&self) -> &Self::Target {
        self.0.as_ref().unwrap()
    }
}
impl std::ops::DerefMut for SessionGuard {
    fn deref_mut(&mut self) -> &mut Self::Target {
        Arc::get_mut(self.0.as_mut().unwrap()).unwrap()
    }
}
impl Drop for SessionGuard {
    fn drop(&mut self) {
        if let Some(session) = self.0.take() {
            tokio::spawn(async move {
                let _ = timeout(
                    Duration::from_secs(2),
                    session.disconnect(Disconnect::ByApplication, "closed", "en"),
                )
                .await;
            });
        }
    }
}
struct Receivers {
    replies: mpsc::Receiver<AuthReply>,
    input: mpsc::Receiver<Input>,
    trust: watch::Receiver<Option<bool>>,
    trust_request: Arc<Mutex<Option<String>>>,
    ack: watch::Receiver<u64>,
    stop: watch::Receiver<bool>,
}
#[allow(clippy::too_many_arguments)]
async fn run(
    p: Profile,
    secret: Zeroizing<String>,
    hops: Vec<(Profile, Option<Zeroizing<String>>)>,
    paths: Vec<PathBuf>,
    sink: Sink,
    channels: Receivers,
    manager: Arc<Connections>,
    store: Arc<Store>,
    id: String,
) -> Result<()> {
    let Receivers {
        mut replies,
        mut input,
        trust,
        trust_request,
        mut ack,
        stop,
    } = channels;
    sink(Event::State {
        status: "connecting".into(),
        message: "서버에 연결하고 있습니다.".into(),
    })?;
    let route_text = crate::routes::describe(hops.iter().map(|(h, _)| h).chain([&p]));
    let mut route = hops;
    route.push((p.clone(), Some(secret)));
    let mut owned: Vec<SessionGuard> = Vec::new();
    for (index, (hop, secret)) in route.into_iter().enumerate() {
        let label = format!("{}홉 {} ({}:{})", index + 1, hop.name, hop.host, hop.port);
        let base_sink = sink.clone();
        let context = label.clone();
        let hop_sink: Sink = Arc::new(move |mut event| {
            match &mut event {
                Event::State { message, .. } => *message = format!("{context} · {message}"),
                Event::AuthPrompt { name, .. } => *name = format!("{context} · {name}"),
                _ => {}
            }
            base_sink(event)
        });
        sink(Event::State {
            status: "connecting".into(),
            message: format!("{route_text} · {label} 연결 중"),
        })?;
        manager.control(&id)?.trust.send_replace(None);
        let work = async {
            let stream: Box<dyn Transport> = if let Some(parent) = owned.last() {
                Box::new(
                    timeout(
                        Duration::from_secs(hop.timeout),
                        parent.channel_open_direct_tcpip(
                            &hop.host,
                            hop.port as u32,
                            "127.0.0.1",
                            0,
                        ),
                    )
                    .await
                    .map_err(|_| "경유 채널 시간 초과")?
                    .map_err(|_| "경유 채널을 열 수 없습니다. 포워딩 허용과 목적지를 확인하세요.")?
                    .into_stream(),
                )
            } else {
                Box::new(
                    timeout(
                        Duration::from_secs(hop.timeout),
                        tokio::net::TcpStream::connect((hop.host.as_str(), hop.port)),
                    )
                    .await
                    .map_err(|_| "접속 시간이 초과되었습니다.")?
                    .map_err(|_| "서버에 연결할 수 없습니다.")?,
                )
            };
            let secret = match secret {
                Some(s) => s,
                None if matches!(hop.auth.as_str(), "password" | "key") => {
                    crate::ssh_auth::hop_secret(&hop, &hop_sink, &mut replies).await?
                }
                None => Zeroizing::new(String::new()),
            };
            // Only the final server can match registered Remote forwarding IDs.
            let handler_id = if hop.id == p.id {
                id.clone()
            } else {
                format!("{id}-hop-{index}")
            };
            authenticate_hop(
                &hop,
                secret,
                stream,
                &paths,
                hop_sink,
                &trust,
                trust_request.clone(),
                &stop,
                &manager,
                &handler_id,
                &mut replies,
            )
            .await
        }
        .await
        .map_err(|e| format!("{label} 실패 · {e}"))?;
        owned.push(work);
    }
    let session = owned.pop().ok_or("경유 경로가 비어 있습니다.")?;
    let channel = timeout(Duration::from_secs(p.timeout), async {
        let channel = session.channel_open_session().await?;
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
        crate::terminal_start::begin(&channel, &p).await?;
        Ok::<_, russh::Error>(channel)
    })
    .await
    .map_err(|_| "PTY 생성 시간이 초과되었습니다.")?
    .map_err(|_| "PTY를 열 수 없습니다.")?;
    manager
        .live
        .lock()
        .unwrap()
        .insert(id.clone(), Arc::downgrade(session.0.as_ref().unwrap()));
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
        message: format!("연결됨 · {route_text}"),
    })?;
    let (mut reader, writer) = channel.split();
    let output = async {
        let mut seq = 0_u64;
        while let Some(message) = reader.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    for chunk in data.chunks(32768) {
                        seq += 1;
                        manager.logs.data(&id, chunk);
                        sink(Event::Data {
                            seq,
                            bytes: chunk.to_vec(),
                        })?;
                        timeout(Duration::from_secs(30), async {
                            while *ack.borrow_and_update() < seq {
                                ack.changed().await.map_err(|_| "출력 구독 종료")?;
                            }
                            Ok::<_, String>(())
                        })
                        .await
                        .map_err(|_| "터미널 렌더링 응답이 없어 연결을 종료했습니다.")??;
                    }
                }
                ChannelMsg::Close => break,
                // A refused shell keeps its old behavior. tmux cannot run without its PTY and exec.
                ChannelMsg::Failure if !p.tmux_session.is_empty() => {
                    return Err("서버가 tmux 시작을 거부했습니다.".to_string());
                }
                _ => {}
            }
        }
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
            if let Some(i) = owned.iter().position(|h| h.is_closed()) {
                return Err(format!(
                    "{}홉 연결이 끊어졌습니다. 종속 연결을 종료합니다. 재접속은 새 셸입니다.",
                    i + 1
                ));
            }
        }
    };
    let result = tokio::select! {r=output=>r,r=input_loop=>r,r=health=>r};
    let _ = timeout(
        Duration::from_secs(2),
        session.disconnect(Disconnect::ByApplication, "closed", "en"),
    )
    .await;
    result
}

trait Transport: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}
impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> Transport for T {}
#[allow(clippy::too_many_arguments)]
async fn authenticate_hop(
    p: &Profile,
    secret: Zeroizing<String>,
    stream: Box<dyn Transport>,
    paths: &[PathBuf],
    sink: Sink,
    trust: &watch::Receiver<Option<bool>>,
    trust_request: Arc<Mutex<Option<String>>>,
    stop: &watch::Receiver<bool>,
    manager: &Arc<Connections>,
    id: &str,
    replies: &mut mpsc::Receiver<AuthReply>,
) -> Result<SessionGuard> {
    let mut preferred = russh::Preferred::default();
    preferred.key.to_mut().extend([
        russh::keys::Algorithm::Rsa {
            hash: Some(HashAlg::Sha512),
        },
        russh::keys::Algorithm::Rsa {
            hash: Some(HashAlg::Sha256),
        },
    ]);
    let config = client::Config {
        preferred,
        keepalive_interval: Some(Duration::from_secs(p.keepalive)),
        keepalive_max: 3,
        channel_buffer_size: 8,
        window_size: 256 * 1024,
        maximum_packet_size: 32768,
        ..Default::default()
    };
    let failure = Arc::new(Mutex::new(None));

    let (waiting_tx, mut waiting) = watch::channel(false);
    let handler = Host {
        id: id.to_string(),
        profile: p.clone(),
        paths: paths.to_vec(),
        sink: sink.clone(),
        trust: {
            let mut t = trust.clone();
            t.borrow_and_update();
            t
        },
        manager: manager.clone(),
        trust_request,
        failure: failure.clone(),
        waiting: waiting_tx,
        stop: stop.clone(),
    };
    let handshake = client::connect_stream(Arc::new(config), stream, handler);
    tokio::pin!(handshake);
    let connected = loop {
        tokio::select! {
            result = &mut handshake => break result,
            _ = waiting.changed() => {},
            _ = tokio::time::sleep(Duration::from_secs(p.timeout)), if !*waiting.borrow() => return Err("SSH 협상 시간이 초과되었습니다.".into()),
        }
    };
    let mut session = SessionGuard(Some(Arc::new(connected.map_err(|_| {
        failure
            .lock()
            .unwrap()
            .take()
            .unwrap_or("SSH 협상에 실패했습니다.".into())
    })?)));
    sink(Event::State {
        status: "authenticating".into(),
        message: "인증 중입니다.".into(),
    })?;
    let authentication = async {
        if p.auth == "interactive" {
            session
                .authenticate_none(&p.username)
                .await
                .map_err(|_| "인증 협상 실패".to_string())
        } else if p.auth == "agent" {
            crate::ssh_auth::agent(&mut session, &p.username).await
        } else if p.auth == "password" {
            session
                .authenticate_password(&p.username, secret.as_str())
                .await
                .map_err(|_| "비밀번호 인증에 실패했습니다.".to_string())
        } else {
            let metadata =
                std::fs::metadata(&p.key_path).map_err(|_| "개인키 파일을 읽을 수 없습니다.")?;
            if metadata.len() > 1024 * 1024 {
                return Err("개인키 파일이 너무 큽니다.".into());
            }
            use std::io::Read;
            let mut encoded = Zeroizing::new(String::new());
            std::fs::File::open(&p.key_path)
                .map_err(|_| "개인키 파일을 읽을 수 없습니다.")?
                .take(1024 * 1024 + 1)
                .read_to_string(&mut encoded)
                .map_err(|_| "개인키 파일을 읽을 수 없습니다.")?;
            if encoded.len() > 1024 * 1024 {
                return Err("개인키 파일이 너무 큽니다.".into());
            }
            let key = decode_secret_key(&encoded, (!secret.is_empty()).then_some(secret.as_str()))
                .map_err(|_| ())
                .or_else(|_| crate::rsa_auth::decode_pem(&encoded, &secret))
                .map_err(|_| "개인키 또는 Passphrase를 확인하세요.")?;
            if key.algorithm().is_rsa() {
                let mut signer = crate::rsa_auth::RsaSigner::new(&key)?;
                let hash = session
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|_| "RSA SHA-2 협상에 실패했습니다.")?
                    .flatten()
                    .unwrap_or(HashAlg::Sha512);
                let result = session
                    .authenticate_publickey_with(
                        &p.username,
                        key.public_key().clone(),
                        Some(hash),
                        &mut signer,
                    )
                    .await
                    .map_err(|_| "RSA SHA-2 개인키 인증에 실패했습니다.".to_string())?;
                if hash == HashAlg::Sha512
                    && matches!(
                        result,
                        client::AuthResult::Failure {
                            partial_success: false,
                            ..
                        }
                    )
                {
                    return session
                        .authenticate_publickey_with(
                            &p.username,
                            key.public_key().clone(),
                            Some(HashAlg::Sha256),
                            &mut signer,
                        )
                        .await
                        .map_err(|_| "RSA SHA-2 개인키 인증에 실패했습니다.".into());
                }
                return Ok(result);
            }
            session
                .authenticate_publickey(
                    &p.username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), None),
                )
                .await
                .map_err(|_| "개인키 인증에 실패했습니다.".into())
        }
    };
    let auth = timeout(Duration::from_secs(p.timeout), authentication)
        .await
        .map_err(|_| "인증 시간이 초과되었습니다.")??;
    drop(secret);
    let partial = matches!(&auth, russh::client::AuthResult::Failure { partial_success: true, remaining_methods } if remaining_methods.contains(&russh::MethodKind::KeyboardInteractive));
    let accepted = if p.auth == "interactive" && !auth.success() || partial {
        crate::ssh_auth::interactive(&mut session, &p.username, &sink, replies).await?
    } else {
        auth.success()
    };
    if !accepted {
        return Err("인증이 거부되었습니다. 사용자와 인증정보를 확인하세요.".into());
    }
    Ok(session)
}
