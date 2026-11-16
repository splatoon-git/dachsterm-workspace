//! Reaches a profile's server through its jump hosts and logs in. A terminal opens a PTY on the
//! result; the network tools stop here (TL.5).
use super::{
    AuthReply, Connections, Event, Host, Receivers, Sink,
    first_hop::{self, Transport},
};
use crate::storage::{Profile, Result};
use russh::{Disconnect, client, keys::HashAlg};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    time::timeout,
};
use zeroize::Zeroizing;

// Cancellation and every early-return path explicitly disconnect the owned SSH task.
pub(crate) struct SessionGuard(Option<Arc<client::Handle<Host>>>);
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

/// What a route needs besides the session's own secret: its jump hosts with the secrets saved for
/// them, and the saved password of the proxy its first connection goes through (CG.1).
#[derive(Default)]
pub struct Secrets {
    pub hops: Vec<(Profile, Option<Zeroizing<String>>)>,
    pub proxy: Option<Zeroizing<String>>,
}

pub(crate) struct Target<'a> {
    pub profile: &'a Profile,
    /// `None` asks for it, as a jump host without a saved secret does.
    pub secret: Option<Zeroizing<String>>,
    pub route: Secrets,
    pub paths: &'a [PathBuf],
    pub forward_agent: bool,
}

/// A logged-in connection and the jump hosts that carry it.
pub(crate) struct Route {
    pub session: SessionGuard,
    hops: Vec<SessionGuard>,
    pub description: String,
    x11: Option<Arc<crate::x11::Forward>>,
}
impl Route {
    /// The shell's session channel with the forwarding the session asked for: X11 first, so its
    /// reply is the next one on the channel, then the agent.
    pub async fn open_shell(
        &self,
        manager: &Connections,
        id: &str,
    ) -> std::result::Result<russh::Channel<client::Msg>, russh::Error> {
        let mut channel = self.session.channel_open_session().await?;
        if let Some(x11) = &self.x11 {
            x11.request(&mut channel).await;
        }
        crate::agent_forward::request(&mut channel, manager, id).await;
        Ok(channel)
    }
    /// Makes the connection reachable through `Connections::handle`.
    pub fn publish(&self, manager: &Connections, id: &str) {
        manager.live.lock().unwrap().insert(
            id.to_string(),
            Arc::downgrade(self.session.0.as_ref().unwrap()),
        );
    }
    /// The 1-based number of a jump host whose connection has gone.
    pub fn broken_hop(&self) -> Option<usize> {
        self.hops.iter().position(|h| h.is_closed()).map(|i| i + 1)
    }
}

pub(crate) async fn open(
    target: Target<'_>,
    channels: &mut Receivers,
    sink: Sink,
    manager: &Arc<Connections>,
    id: &str,
) -> Result<Route> {
    let Target {
        profile: p,
        secret,
        route: Secrets { hops, proxy },
        paths,
        forward_agent,
    } = target;
    let mut proxy_secret = proxy;
    let x11 = crate::x11::Forward::new(p, sink.clone())?;
    sink(Event::State {
        status: "connecting".into(),
        message: "서버에 연결하고 있습니다.".into(),
    })?;
    let mut description = crate::routes::describe(hops.iter().map(|(h, _)| h).chain([p]));
    // Only the first connection's proxy is used: the later hops are reached through the earlier.
    if let Some(proxy) = hops.first().map_or(p, |(h, _)| h).proxy.as_ref() {
        description = format!("{} → {description}", proxy.label());
    }
    let mut route = hops;
    route.push((p.clone(), secret));
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
            message: format!("{description} · {label} 연결 중"),
        })?;
        manager.control(id)?.trust.send_replace(None);
        let mut stderr = None;
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
                let opened =
                    first_hop::open(&hop, proxy_secret.take(), &hop_sink, &mut channels.replies)
                        .await?;
                stderr = opened.stderr;
                opened.stream
            };
            let last = hop.id == p.id;
            let secret = match secret {
                Some(s) => s,
                None if matches!(hop.auth.as_str(), "password" | "key") => {
                    crate::ssh_auth::hop_secret(&hop, last, &hop_sink, &mut channels.replies)
                        .await?
                }
                None => Zeroizing::new(String::new()),
            };
            // Only the final server can match registered Remote forwarding IDs.
            let handler_id = if last {
                id.to_string()
            } else {
                format!("{id}-hop-{index}")
            };
            authenticate_hop(
                &hop,
                secret,
                stream,
                paths,
                hop_sink,
                &channels.trust,
                channels.trust_request.clone(),
                &channels.stop,
                manager,
                &handler_id,
                last && forward_agent,
                x11.clone().filter(|_| last),
                &mut channels.replies,
            )
            .await
        }
        .await;
        let work = match work {
            Ok(session) => session,
            // What a proxy command printed is usually the reason (`not found`, a refusal).
            Err(e) => {
                let detail = match &stderr {
                    Some(stderr) => stderr
                        .text()
                        .await
                        .map(|t| format!(" · 명령 표준 오류: {t}")),
                    None => None,
                };
                return Err(format!("{label} 실패 · {e}{}", detail.unwrap_or_default()));
            }
        };
        owned.push(work);
    }
    let session = owned.pop().ok_or("경유 경로가 비어 있습니다.")?;
    Ok(Route {
        session,
        hops: owned,
        description,
        x11,
    })
}

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
    forward_agent: bool,
    x11: Option<Arc<crate::x11::Forward>>,
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
        forward_agent,
        x11,
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
            crate::ssh_auth::agent(&mut session, &p.username, &p.agent_source).await
        } else if p.auth == "password" {
            session
                .authenticate_password(&p.username, secret.as_str())
                .await
                .map_err(|_| "비밀번호 인증에 실패했습니다.".to_string())
        } else {
            let key = crate::ssh_keys::load(&p.key_path, &secret)?;
            if forward_agent {
                crate::agent_keys::keep_login(manager, id, &key);
            }
            let cert = crate::ssh_cert::for_login(p, &key, &sink)?;
            crate::ssh_auth::key(&mut session, &p.username, key, cert).await
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
