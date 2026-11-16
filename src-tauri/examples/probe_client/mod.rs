//! The SSH terminal client the endurance probe drives: connect, trust, read to a marker, close.
//! `phase1_probe` keeps its own copy of the same client. Move both here before a third probe
//! needs one (engineering rules §4).
#![allow(dead_code)]
use dachsterm::{
    ssh::{Connections, Event, Input},
    storage::{Profile, Store},
};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::{sync::mpsc, time::timeout};
use zeroize::Zeroizing;
pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub fn env(name: &str) -> String {
    std::env::var(format!("DACHSTERM_PROBE_{name}")).expect("fixture input missing")
}
pub struct Client {
    pub id: String,
    pub rx: mpsc::Receiver<Event>,
    pub manager: Arc<Connections>,
    pub bytes: Vec<u8>,
}
impl Client {
    pub async fn event(&mut self) -> Result<Event> {
        let event = timeout(Duration::from_secs(20), self.rx.recv())
            .await?
            .ok_or("event stream ended")?;
        if let Event::Data { seq, bytes } = &event {
            self.manager.control(&self.id)?.ack.send(*seq)?;
            self.bytes.extend(bytes);
        }
        Ok(event)
    }
    pub async fn connected(&mut self, trust: bool) -> Result<()> {
        loop {
            match self.event().await? {
                Event::HostKey {
                    fingerprint,
                    algorithm,
                    ..
                } => {
                    let key =
                        russh::keys::PublicKey::from_openssh(&env(if algorithm.contains("rsa") {
                            "RSA_HOST_KEY"
                        } else {
                            "HOST_KEY"
                        }))?;
                    assert!(
                        fingerprint == key.fingerprint(russh::keys::HashAlg::Sha256).to_string(),
                        "fixture fingerprint mismatch"
                    );
                    self.manager.control(&self.id)?.trust.send(Some(trust))?;
                }
                Event::State { status, message } if status == "error" => return Err(message.into()),
                Event::State { status, .. } if status == "connected" => return Ok(()),
                _ => {}
            }
        }
    }
    pub async fn marker(&mut self, marker: &str) -> Result<String> {
        loop {
            if String::from_utf8_lossy(&self.bytes).contains(marker) {
                let output = String::from_utf8_lossy(&self.bytes).into_owned();
                self.bytes.clear();
                return Ok(output);
            }
            if let Event::State { status, .. } = self.event().await?
                && matches!(status.as_str(), "closed" | "error")
            {
                return Err("connection ended before output marker".into());
            }
        }
    }
    pub async fn send(&self, data: &str) -> Result<()> {
        self.manager
            .control(&self.id)?
            .input
            .send(Input::Data(data.as_bytes().to_vec()))
            .await?;
        Ok(())
    }
    pub async fn stop(&mut self) -> Result<()> {
        self.manager.control(&self.id)?.stop.send(true)?;
        loop {
            match timeout(Duration::from_secs(20), self.rx.recv())
                .await?
                .ok_or("close event missing")?
            {
                Event::Data { seq, .. } => {
                    // Data already queued before cancellation can arrive after Control
                    // removal. A closing client must not ACK through a deleted entry.
                    if let Ok(control) = self.manager.control(&self.id) {
                        let _ = control.ack.send(seq);
                    }
                }
                Event::State { status, .. } if status == "closed" => break,
                _ => {}
            }
        }
        assert!(self.manager.control(&self.id).is_err());
        Ok(())
    }
    pub async fn error(&mut self, expected: &str) -> Result<()> {
        loop {
            if let Event::State { status, message } = self.event().await?
                && status == "error"
            {
                assert!(message.contains(expected), "unexpected error category");
                return Ok(());
            }
        }
    }
}
pub fn begin(
    manager: &Arc<Connections>,
    store: &Arc<Store>,
    paths: &[PathBuf],
    profile: Profile,
    secret: String,
) -> Result<Client> {
    begin_with(manager, store, paths, profile, secret, None)
}
/// Like `begin`, with the one-time start command `connect` would hand over.
pub fn begin_with(
    manager: &Arc<Connections>,
    store: &Arc<Store>,
    paths: &[PathBuf],
    profile: Profile,
    secret: String,
    launch: Option<dachsterm::terminal_start::Launch>,
) -> Result<Client> {
    let id = uuid::Uuid::new_v4().to_string();
    if let Some(launch) = launch {
        manager.launches.put(&id, launch);
    }
    let (tx, rx) = mpsc::channel(64);
    manager.start(
        id.clone(),
        profile,
        Zeroizing::new(secret),
        paths.to_vec(),
        Arc::new(move |e| tx.try_send(e).map_err(|_| "probe receiver full".into())),
        store.clone(),
    )?;
    Ok(Client {
        id,
        rx,
        manager: manager.clone(),
        bytes: Vec::new(),
    })
}
pub fn base() -> Profile {
    Profile {
        id: String::new(),
        name: "fixture".into(),
        host: "127.0.0.1".into(),
        // The connect fixture probe gives each profile its own port.
        port: std::env::var("DACHSTERM_PROBE_PORT").map_or(22, |p| p.parse().unwrap()),
        username: "probe".into(),
        auth: "password".into(),
        protocol: "ssh".into(),
        tls_ca_path: String::new(),
        encoding: "utf-8".into(),
        key_path: String::new(),
        jump_ids: vec![],
        tags: vec![],
        sort_order: 0,
        group_id: None,
        favorite: true,
        timeout: 5,
        keepalive: 5,
        tmux_session: String::new(),
        workspace: Default::default(),
        kube: None,
        forward_agent: false,
        forward_login_key: true,
        forward_keys: vec![],
        forward_system_agent: true,
        forward_git_credentials: false,
        last_connected: None,
        has_secret: false,
        proxy: None,
    }
}

/// Fixture setup and checks the app itself never runs, on a channel of their own.
pub async fn shell(manager: &Connections, id: &str, script: &str) -> Result<String> {
    let mut channel = manager.handle(id)?.channel_open_session().await?;
    channel.exec(true, script).await?;
    let mut out = Vec::new();
    while let Some(message) = channel.wait().await {
        if let russh::ChannelMsg::Data { data } = message {
            out.extend_from_slice(&data);
        }
    }
    Ok(String::from_utf8(out)?)
}
