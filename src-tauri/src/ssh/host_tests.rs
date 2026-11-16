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
