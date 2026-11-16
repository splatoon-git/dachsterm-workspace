//! S.12: a server cannot open channels on a connection that never asked for them.
use super::Host;
use crate::{hostkeys, ssh::Connections, storage::tests::profile};
use russh::{
    ChannelOpenFailure, Error, client,
    keys::{Algorithm, PrivateKey, key::safe_rng},
    server,
};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::watch, time::timeout};

struct Server;
impl server::Handler for Server {
    type Error = Error;
    async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        _: russh::Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut server::Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }
}

fn refused<T>(opened: Result<T, Error>) -> bool {
    matches!(
        opened,
        Err(Error::ChannelOpenFailure(
            ChannelOpenFailure::AdministrativelyProhibited
        ))
    )
}

#[tokio::test]
async fn the_server_cannot_open_channels_the_app_did_not_ask_for() {
    let key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let known = dir.path().join("known_hosts");
    let p = profile();
    hostkeys::remember(&known, &p.host, p.port, key.public_key()).unwrap();
    let (trust_tx, trust) = watch::channel(None);
    let (waiting, _waiting_rx) = watch::channel(false);
    let (stop_tx, stop) = watch::channel(false);
    let host = Host {
        id: "s12".into(),
        profile: p.clone(),
        paths: vec![known],
        sink: Arc::new(|_| Ok(())),
        trust,
        trust_request: Arc::new(Mutex::new(None)),
        manager: Arc::new(Connections::default()),
        failure: Arc::new(Mutex::new(None)),
        waiting,
        stop,
        forward_agent: false,
        x11: None,
    };
    let (near, far) = tokio::io::duplex(1 << 16);
    let config = Arc::new(server::Config {
        keys: vec![key],
        ..Default::default()
    });
    let served = tokio::spawn(server::run_stream(config, far, Server));
    let mut client = client::connect_stream(Arc::new(client::Config::default()), near, host)
        .await
        .unwrap();
    assert!(
        client
            .authenticate_none(p.username.clone())
            .await
            .unwrap()
            .success()
    );
    let server = served.await.unwrap().unwrap().handle();
    let wait = Duration::from_secs(5);

    let x11 = timeout(wait, server.channel_open_x11("127.0.0.1", 6010)).await;
    assert!(refused(x11.unwrap()), "x11");
    let session = timeout(wait, server.channel_open_session()).await;
    assert!(refused(session.unwrap()), "session");
    let tcp = timeout(
        wait,
        server.channel_open_direct_tcpip("127.0.0.1", 22, "127.0.0.1", 40000),
    )
    .await;
    assert!(refused(tcp.unwrap()), "direct-tcpip");
    let socket = timeout(wait, server.channel_open_direct_streamlocal("/tmp/s12")).await;
    assert!(refused(socket.unwrap()), "direct-streamlocal");

    // The connection still works for what the app does ask for.
    assert!(
        timeout(wait, client.channel_open_session())
            .await
            .unwrap()
            .is_ok()
    );
    drop((trust_tx, stop_tx));
}

/// CG.9: a connection that asked for X11 takes the server's X11 channel, swaps the fake cookie
/// and relays to the local display; the cookie never leaves this PC and a wrong one is dropped.
#[tokio::test]
async fn an_x11_channel_reaches_the_local_display_only_with_the_fake_cookie() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    // A display number whose port is free: the fake X server.
    let (listener, number) = {
        let mut found = None;
        for n in 900..1000u16 {
            if let Ok(l) = tokio::net::TcpListener::bind(("127.0.0.1", 6000 + n)).await {
                found = Some((l, n));
                break;
            }
        }
        found.expect("a free port in 6900-6999")
    };
    let key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let known = dir.path().join("known_hosts");
    let p = profile();
    hostkeys::remember(&known, &p.host, p.port, key.public_key()).unwrap();
    let (_trust_tx, trust) = watch::channel(None);
    let (waiting, _waiting_rx) = watch::channel(false);
    let (_stop_tx, stop) = watch::channel(false);
    let sink: crate::ssh::Sink = Arc::new(|_| Ok(()));
    let display = format!("127.0.0.1:{number}");
    let host = Host {
        id: "x11".into(),
        profile: p.clone(),
        paths: vec![known],
        sink: sink.clone(),
        trust,
        trust_request: Arc::new(Mutex::new(None)),
        manager: Arc::new(Connections::default()),
        failure: Arc::new(Mutex::new(None)),
        waiting,
        stop,
        forward_agent: false,
        x11: Some(crate::x11::Forward::for_test(&display, None, sink)),
    };
    let (near, far) = tokio::io::duplex(1 << 16);
    let config = Arc::new(server::Config {
        keys: vec![key],
        ..Default::default()
    });
    let served = tokio::spawn(server::run_stream(config, far, Server));
    let mut client = client::connect_stream(Arc::new(client::Config::default()), near, host)
        .await
        .unwrap();
    assert!(
        client
            .authenticate_none(p.username.clone())
            .await
            .unwrap()
            .success()
    );
    let server = served.await.unwrap().unwrap().handle();
    let wait = Duration::from_secs(5);
    // An X client on the server presents the fake cookie (little-endian setup packet).
    let mut packet = vec![b'l', 0, 11, 0, 0, 0, 18, 0, 16, 0, 0, 0];
    packet.extend_from_slice(b"MIT-MAGIC-COOKIE-1\0\0");
    packet.extend_from_slice(&[7; 16]);
    let channel = timeout(wait, server.channel_open_x11("127.0.0.1", 6010))
        .await
        .unwrap()
        .unwrap();
    let mut remote = channel.into_stream();
    remote.write_all(&packet).await.unwrap();
    remote.write_all(b"ping").await.unwrap();
    let (mut local, _) = timeout(wait, listener.accept()).await.unwrap().unwrap();
    let mut seen = [0u8; 16];
    timeout(wait, local.read_exact(&mut seen))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        &seen[..12],
        &[b'l', 0, 11, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        "no cookie here"
    );
    assert_eq!(&seen[12..], b"ping");
    local.write_all(b"pong").await.unwrap();
    let mut back = [0u8; 4];
    timeout(wait, remote.read_exact(&mut back))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&back, b"pong");
    // A client with another cookie is closed before anything reaches the display.
    let mut wrong = packet.clone();
    wrong[32..48].copy_from_slice(&[8; 16]);
    let channel = timeout(wait, server.channel_open_x11("127.0.0.1", 6011))
        .await
        .unwrap()
        .unwrap();
    let mut remote = channel.into_stream();
    remote.write_all(&wrong).await.unwrap();
    let mut end = [0u8; 1];
    let closed = timeout(wait, remote.read(&mut end)).await.unwrap();
    assert!(matches!(closed, Ok(0) | Err(_)), "closed without an answer");
    assert!(
        timeout(Duration::from_millis(300), listener.accept())
            .await
            .is_err()
    );
}
