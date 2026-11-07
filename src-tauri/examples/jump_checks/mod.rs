//! Actual OpenSSH transport checks; credentials remain in ephemeral fixture memory/files.
use super::*;
pub(super) fn routed(
    manager: &Arc<Connections>,
    store: &Arc<Store>,
    paths: &[PathBuf],
    target: Profile,
    hops: Vec<(Profile, Option<Zeroizing<String>>)>,
    secret: String,
) -> Result<Client> {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel(64);
    manager.start_route(
        id.clone(),
        target,
        Zeroizing::new(secret),
        hops,
        paths.to_vec(),
        Arc::new(move |e| tx.try_send(e).map_err(|_| "probe queue full".into())),
        store.clone(),
    )?;
    Ok(Client {
        id,
        rx,
        manager: manager.clone(),
        bytes: vec![],
    })
}
async fn ready(c: &mut Client, accept: bool) -> Result<usize> {
    let mut keys = 0;
    loop {
        match c.event().await? {
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
                assert_eq!(
                    fingerprint,
                    key.fingerprint(russh::keys::HashAlg::Sha256).to_string()
                );
                keys += 1;
                c.manager.control(&c.id)?.trust.send(Some(accept))?;
            }
            Event::AuthPrompt {
                challenge, prompts, ..
            } => {
                c.manager
                    .control(&c.id)?
                    .auth_reply
                    .send(dachsterm::ssh::AuthReply {
                        challenge,
                        responses: Zeroizing::new(
                            prompts.iter().map(|_| env("PASSWORD")).collect(),
                        ),
                    })
                    .await?;
            }
            Event::State { status, message } if status == "error" => return Err(message.into()),
            Event::State { status, .. } if status == "connected" => return Ok(keys),
            _ => {}
        }
    }
}
async fn services(c: &mut Client) -> Result<()> {
    use dachsterm::{
        monitoring::Monitors,
        tunnels::{Config, Tunnels},
    };
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
    };
    let tunnels = Arc::new(Tunnels::default());
    let base = Config {
        id: uuid::Uuid::new_v4().to_string(),
        profile_id: c.manager.control(&c.id)?.profile.id.clone(),
        name: "jump-test".into(),
        kind: "local".into(),
        port: 0,
        host: "127.0.0.1".into(),
        target_port: 9000,
        auto_start: false,
    };
    let local = tunnels
        .start(c.manager.clone(), c.id.clone(), base.clone())
        .await?;
    let port = tunnels
        .list()
        .into_iter()
        .find(|t| t.id == local)
        .unwrap()
        .port;
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await?;
    socket.write_all(b"jump").await?;
    let mut b = [0; 4];
    timeout(Duration::from_secs(5), socket.read_exact(&mut b)).await??;
    assert_eq!(&b, b"jump");
    drop(socket);
    let mut d = base.clone();
    d.id = uuid::Uuid::new_v4().to_string();
    d.kind = "dynamic".into();
    let dynamic = tunnels.start(c.manager.clone(), c.id.clone(), d).await?;
    let port = tunnels
        .list()
        .into_iter()
        .find(|t| t.id == dynamic)
        .unwrap()
        .port;
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await?;
    socket.write_all(&[5, 1, 0]).await?;
    let mut b = [0; 2];
    socket.read_exact(&mut b).await?;
    assert_eq!(b, [5, 0]);
    let mut request = vec![5, 1, 0, 3, 9];
    request.extend_from_slice(b"localhost");
    request.extend_from_slice(&9000u16.to_be_bytes());
    socket.write_all(&request).await?;
    let mut b = [0; 10];
    socket.read_exact(&mut b).await?;
    assert_eq!(b[1], 0);
    socket.write_all(b"hop").await?;
    let mut b = [0; 3];
    socket.read_exact(&mut b).await?;
    assert_eq!(&b, b"hop");
    drop(socket);
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let local_port = listener.local_addr()?.port();
    let echo = tokio::spawn(async move {
        let (mut s, _) = listener.accept().await.unwrap();
        let mut b = [0; 3];
        s.read_exact(&mut b).await.unwrap();
        s.write_all(&b).await.unwrap();
    });
    let mut r = base;
    r.id = uuid::Uuid::new_v4().to_string();
    r.kind = "remote".into();
    r.target_port = local_port;
    let remote = tunnels.start(c.manager.clone(), c.id.clone(), r).await?;
    let port = tunnels
        .list()
        .into_iter()
        .find(|t| t.id == remote)
        .unwrap()
        .port;
    let mut stream = c
        .manager
        .handle(&c.id)?
        .channel_open_direct_tcpip("127.0.0.1", port as u32, "127.0.0.1", 0)
        .await?
        .into_stream();
    stream.write_all(b"end").await?;
    let mut b = [0; 3];
    stream.read_exact(&mut b).await?;
    assert_eq!(&b, b"end");
    echo.await?;
    for t in [local, dynamic, remote] {
        tunnels.stop(&t);
    }
    let monitors = Arc::new(Monitors::default());
    monitors.configure(c.manager.clone(), c.id.clone(), true, 2, "all".into())?;
    timeout(Duration::from_secs(10), async {
        while !monitors.get(&c.id).is_some_and(|m| m.history.len() >= 2) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await?;
    monitors.configure(c.manager.clone(), c.id.clone(), false, 2, "all".into())?;
    println!("PASS jump Local/Remote/SOCKS5 echo and independent monitoring");
    Ok(())
}
pub async fn run() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let store = Arc::new(Store::open(&dir.path().join("db"))?);
    let manager = Arc::new(Connections::default());
    let paths = vec![dir.path().join("known_hosts")];
    let root = store.save(base(), None)?;
    let mut target = base();
    target.port = 22;
    target.name = "end".into();
    target.jump_ids = vec![root.id.clone()];
    let target = store.save(target, None)?;
    let mut one = routed(
        &manager,
        &store,
        &paths,
        target.clone(),
        vec![(root.clone(), None)],
        env("PASSWORD"),
    )?;
    assert_eq!(ready(&mut one, true).await?, 2);
    one.send("stty -echo; printf '\\nJUMP_ONE\\n'\n").await?;
    one.marker("JUMP_ONE\r\n").await?;
    services(&mut one).await?;
    one.stop().await?;
    println!("PASS one-hop PTY, two independent first-host decisions and interactive hop secret");
    let key = dir.path().join("key");
    std::fs::write(&key, env("RSA_KEY"))?;
    let mut middle = base();
    middle.host = "localhost".into();
    middle.port = 2223;
    middle.auth = "key".into();
    middle.key_path = key.to_string_lossy().into();
    middle.name = "middle MFA".into();
    let middle = store.save(middle, None)?;
    let mut two = target.clone();
    two.jump_ids = vec![root.id.clone(), middle.id.clone()];
    let two = store.save(two, None)?;
    let begin_two = || {
        routed(
            &manager,
            &store,
            &paths,
            two.clone(),
            vec![
                (root.clone(), Some(Zeroizing::new(env("PASSWORD")))),
                (middle.clone(), Some(Zeroizing::new(String::new()))),
            ],
            env("PASSWORD"),
        )
    };
    let mut c = begin_two()?;
    assert_eq!(ready(&mut c, true).await?, 1);
    c.send("stty -echo; printf '\\nJUMP_TWO\\n'\n").await?;
    c.marker("JUMP_TWO\r\n").await?;
    workspace_checks::files(manager.clone(), &c.id, &two.id).await?;
    services(&mut c).await?;
    c.stop().await?;
    println!(
        "PASS two-hop password + RSA/SHA-2 + keyboard-interactive MFA, PTY/SFTP/external-edit roundtrip"
    );
    let mut agent = root.clone();
    agent.auth = "agent".into();
    let agent = store.save(agent, None)?;
    let mut c = routed(
        &manager,
        &store,
        &paths,
        two.clone(),
        vec![
            (agent.clone(), None),
            (middle.clone(), Some(Zeroizing::new(String::new()))),
        ],
        env("PASSWORD"),
    )?;
    ready(&mut c, false).await?;
    c.stop().await?;
    println!("PASS local OS agent signing on jump host without forwarding");
    let mut bad = routed(
        &manager,
        &store,
        &paths,
        two.clone(),
        vec![
            (
                root.clone(),
                Some(Zeroizing::new("invalid-fixture-value".into())),
            ),
            (middle.clone(), Some(Zeroizing::new(String::new()))),
        ],
        env("PASSWORD"),
    )?;
    bad.error("1홉").await?;
    let mut canceled = begin_two()?;
    loop {
        if matches!(canceled.event().await?, Event::AuthPrompt { .. }) {
            break;
        }
    }
    canceled.stop().await?;
    println!("PASS hop authentication failure and MFA cancellation cleanup");
    // A dedicated byte bridge inside the fixture lets us cut only the middle transport.
    let fixture = env("CONTAINER");
    let bridge = "import asyncio,os\nopen('/run/probe/jump-bridge.pid','w').write(str(os.getpid()))\nasync def relay(r,w):\n try:\n  while data:=await r.read(32768):\n   w.write(data);await w.drain()\n finally:w.close()\nasync def client(r,w):\n rr,ww=await asyncio.open_connection('127.0.0.1',2223)\n await asyncio.gather(relay(r,ww),relay(rr,w))\nasync def main():\n s=await asyncio.start_server(client,'127.0.0.1',2224)\n async with s:await s.serve_forever()\nasyncio.run(main())";
    assert!(
        std::process::Command::new("docker")
            .args(["exec", "-d", &fixture, "python3", "-c", bridge])
            .status()?
            .success()
    );
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mut via = middle.clone();
    via.id.clear();
    via.port = 2224;
    let via = store.save(via, None)?;
    let mut end = two.clone();
    end.id.clear();
    end.jump_ids = vec![root.id.clone(), via.id.clone()];
    let end = store.save(end, None)?;
    let mut cut = routed(
        &manager,
        &store,
        &paths,
        end.clone(),
        vec![
            (root.clone(), Some(Zeroizing::new(env("PASSWORD")))),
            (via, Some(Zeroizing::new(String::new()))),
        ],
        env("PASSWORD"),
    )?;
    ready(&mut cut, true).await?;
    let mut survivor = begin(&manager, &store, &paths, agent, String::new())?;
    survivor.connected(false).await?;
    let live_tunnels = Arc::new(dachsterm::tunnels::Tunnels::default());
    live_tunnels
        .start(
            manager.clone(),
            cut.id.clone(),
            dachsterm::tunnels::Config {
                id: uuid::Uuid::new_v4().to_string(),
                profile_id: end.id.clone(),
                name: "cut".into(),
                kind: "local".into(),
                port: 0,
                host: "127.0.0.1".into(),
                target_port: 9000,
                auto_start: false,
            },
        )
        .await?;
    assert!(
        std::process::Command::new("docker")
            .args([
                "exec",
                &fixture,
                "sh",
                "-c",
                "kill $(cat /run/probe/jump-bridge.pid)"
            ])
            .status()?
            .success()
    );
    loop {
        let event = timeout(Duration::from_secs(20), cut.rx.recv())
            .await?
            .ok_or("cut event missing")?;
        if let Event::Data { seq, .. } = &event
            && let Ok(control) = manager.control(&cut.id)
        {
            let _ = control.ack.send(*seq);
        }
        if let Event::State { status, .. } = event
            && matches!(status.as_str(), "closed" | "error")
        {
            break;
        }
    }
    timeout(Duration::from_secs(8), async {
        while live_tunnels.list().iter().any(|t| t.status == "running") {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await?;
    assert!(manager.handle(&cut.id).is_err());
    survivor
        .send("stty -echo; printf '\\nCUT_ISOLATED\\n'\n")
        .await?;
    survivor.marker("CUT_ISOLATED\r\n").await?;
    survivor.stop().await?;
    let mut reconnected = begin_two()?;
    ready(&mut reconnected, false).await?;
    reconnected
        .send("stty -echo; printf '\\nNEW_JUMP_SHELL\\n'\n")
        .await?;
    reconnected.marker("NEW_JUMP_SHELL\r\n").await?;
    reconnected.stop().await?;
    println!(
        "PASS actual middle transport cut closes dependent tunnel, isolates direct connection, reconnects a new shell"
    );
    let trusted_text = std::fs::read_to_string(&paths[0])?;
    let mut text = trusted_text.clone();
    let changed = russh::keys::PublicKey::from_openssh(&env("HOST_KEY"))?;
    text = text
        .lines()
        .filter(|l| !l.starts_with("[localhost]:2223 "))
        .collect::<Vec<_>>()
        .join("\n");
    text.push_str(&format!("\n[localhost]:2223 {}\n", changed.to_openssh()?));
    std::fs::write(&paths[0], text)?;
    let mut blocked = begin_two()?;
    blocked.error("호스트키가 변경").await?;
    println!("PASS changed middle host key rejected before hop authentication");
    for port in [root.port, 22] {
        let host = if port == 22 {
            "127.0.0.1".to_string()
        } else {
            format!("[127.0.0.1]:{port}")
        };
        let mut text = trusted_text
            .lines()
            .filter(|l| !l.starts_with(&format!("{host} ")))
            .collect::<Vec<_>>()
            .join("\n");
        let changed = russh::keys::PublicKey::from_openssh(&env("RSA_HOST_KEY"))?;
        text.push_str(&format!("\n{host} {}\n", changed.to_openssh()?));
        std::fs::write(&paths[0], text)?;
        let mut blocked = begin_two()?;
        assert!(
            ready(&mut blocked, false)
                .await
                .is_err_and(|e| e.to_string().contains("호스트키가 변경"))
        );
    }
    std::fs::write(&paths[0], &trusted_text)?;
    println!("PASS first and final changed host keys blocked on routed connections");
    let stalled = "import socket,time\ns=socket.socket();s.bind(('127.0.0.1',2225));s.listen();open('/run/probe/stall-ready','w').close();c,_=s.accept();time.sleep(30)";
    assert!(
        std::process::Command::new("docker")
            .args(["exec", "-d", &fixture, "python3", "-c", stalled])
            .status()?
            .success()
    );
    for _ in 0..40 {
        if std::process::Command::new("docker")
            .args(["exec", &fixture, "test", "-f", "/run/probe/stall-ready"])
            .status()?
            .success()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let mut stalled = target.clone();
    stalled.id.clear();
    stalled.port = 2225;
    let stalled = store.save(stalled, None)?;
    let mut c = routed(
        &manager,
        &store,
        &paths,
        stalled,
        vec![(root.clone(), Some(Zeroizing::new(env("PASSWORD"))))],
        env("PASSWORD"),
    )?;
    c.error("SSH 협상 시간이 초과").await?;
    println!("PASS actual forwarded handshake timeout cleans the owned parent");
    // Restore first-hop password profile and verify an unrelated direct connection survives route failures.
    store.save(root.clone(), None)?;
    let mut direct = begin(&manager, &store, &paths, root, env("PASSWORD"))?;
    direct.connected(false).await?;
    direct
        .send("stty -echo; printf '\\nDIRECT_SURVIVES\\n'\n")
        .await?;
    direct.marker("DIRECT_SURVIVES\r\n").await?;
    direct.stop().await?;
    timeout(Duration::from_secs(5), async {
        while !manager.entries.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await?;
    assert!(manager.live.lock().unwrap().is_empty());
    assert!(manager.forwards.lock().unwrap().is_empty());
    println!("PASS direct regression and connection/forward map cleanup");
    Ok(())
}
