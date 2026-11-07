#[path = "queue/checks.rs"]
mod queue_checks;
// Runs the actual product engine against the ephemeral OpenSSH fixture. No secret output.
mod agent_checks;
mod jump_checks;
mod workspace_checks;
use dachsterm::{
    credentials, hostkeys,
    ssh::{Connections, Event, Input},
    storage::{Profile, Store},
};
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::{sync::mpsc, time::timeout};
use zeroize::Zeroizing;
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn env(name: &str) -> String {
    std::env::var(format!("DACHSTERM_PROBE_{name}")).expect("fixture input missing")
}
struct Client {
    id: String,
    rx: mpsc::Receiver<Event>,
    manager: Arc<Connections>,
    bytes: Vec<u8>,
}
impl Client {
    async fn event(&mut self) -> Result<Event> {
        let event = timeout(Duration::from_secs(20), self.rx.recv())
            .await?
            .ok_or("event stream ended")?;
        if let Event::Data { seq, bytes } = &event {
            self.manager.control(&self.id)?.ack.send(*seq)?;
            self.bytes.extend(bytes);
        }
        Ok(event)
    }
    async fn connected(&mut self, trust: bool) -> Result<()> {
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
    async fn marker(&mut self, marker: &str) -> Result<String> {
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
    async fn send(&self, data: &str) -> Result<()> {
        self.manager
            .control(&self.id)?
            .input
            .send(Input::Data(data.as_bytes().to_vec()))
            .await?;
        Ok(())
    }
    async fn stop(&mut self) -> Result<()> {
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
    async fn error(&mut self, expected: &str) -> Result<()> {
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
fn begin(
    manager: &Arc<Connections>,
    store: &Arc<Store>,
    paths: &[PathBuf],
    profile: Profile,
    secret: String,
) -> Result<Client> {
    let id = uuid::Uuid::new_v4().to_string();
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
fn base() -> Profile {
    Profile {
        id: String::new(),
        name: "fixture".into(),
        host: "127.0.0.1".into(),
        port: env("PORT").parse().unwrap(),
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
        forward_agent: false,
        last_connected: None,
        has_secret: false,
    }
}
fn stress_seconds() -> u64 {
    std::env::var("DACHSTERM_PROBE_STRESS_SECONDS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0)
        .min(86400)
}
async fn stress(
    manager: &Arc<Connections>,
    store: &Arc<Store>,
    paths: &[PathBuf],
    p: &Profile,
) -> Result<()> {
    let seconds = stress_seconds();
    if seconds == 0 {
        return Ok(());
    }
    let started = std::time::Instant::now();
    let baseline_connections = manager.entries.lock().unwrap().len();
    let baseline_handles = manager.live.lock().unwrap().len();
    let mut cycles = 0;
    let mut samples = Vec::new();
    while started.elapsed().as_secs() < seconds || cycles < 30 {
        let mut client = begin(manager, store, paths, p.clone(), env("PASSWORD"))?;
        client.connected(false).await.map_err(|_| {
            eprintln!("FAIL stress cycle {}: connect", cycles + 1);
            "stress connect"
        })?;
        client
            .send(
                "stty -echo; python3 -c \"print('x' * 1048576)\"; printf '\\nSTRESS_COMPLETE\\n'\n",
            )
            .await
            .map_err(|_| {
                eprintln!("FAIL stress cycle {}: input", cycles + 1);
                "stress input"
            })?;
        client.marker("STRESS_COMPLETE\r\n").await.map_err(|_| {
            eprintln!("FAIL stress cycle {}: output", cycles + 1);
            "stress output"
        })?;
        client.stop().await.map_err(|_| {
            eprintln!("FAIL stress cycle {}: close", cycles + 1);
            "stress close"
        })?;
        drop(client);
        assert_eq!(
            manager.entries.lock().unwrap().len(),
            baseline_connections,
            "connection leak"
        );
        assert_eq!(
            manager.live.lock().unwrap().len(),
            baseline_handles,
            "handle leak"
        );
        cycles += 1;
        if cycles % 10 == 0 {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let output = std::process::Command::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", &format!("$p=Get-Process -Id {}; Write-Output ($p.PrivateMemorySize64.ToString()+','+$p.HandleCount.ToString())", std::process::id())]).creation_flags(0x08000000).output()?;
                if !output.status.success() {
                    return Err("resource sampling failed".into());
                }
                let values: Vec<u64> = String::from_utf8(output.stdout)?
                    .trim()
                    .split(',')
                    .map(str::parse)
                    .collect::<std::result::Result<_, _>>()?;
                if values.len() != 2 {
                    return Err("resource sample format".into());
                }
                samples.push((started.elapsed().as_secs(), values[0], values[1]));
                if samples.len() > 1 {
                    // Regression budget after warm-up; not a proof of absence of long-term leaks.
                    assert!(
                        values[0] <= samples[0].1 + 96 * 1024 * 1024,
                        "private memory growth exceeds budget"
                    );
                    assert!(
                        values[1] <= samples[0].2 + 128,
                        "handle growth exceeds budget"
                    );
                }
            }
            println!("PASS stress {cycles} connect/output/close cycles");
            std::fs::create_dir_all("target/verification")?;
            std::fs::write(
                "target/verification/ssh-stress.json",
                serde_json::to_vec_pretty(
                    &serde_json::json!({"completed": false, "seconds":started.elapsed().as_secs(), "cycles":cycles, "samplesSecondsPrivateBytesHandles":samples}),
                )?,
            )?;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    #[cfg(not(windows))]
    let _: &mut Vec<(u64, u64, u64)> = &mut samples;
    std::fs::create_dir_all("target/verification")?;
    std::fs::write(
        "target/verification/ssh-stress.json",
        serde_json::to_vec_pretty(
            &serde_json::json!({"completed":true, "seconds": started.elapsed().as_secs(), "cycles":cycles, "bytesPerCycle":1048576, "samplesSecondsPrivateBytesHandles": samples, "scope":"product SSH engine; not WebView2 or physical sleep"}),
        )?,
    )?;
    println!("PASS bounded SSH stress and resource budgets");
    Ok(())
}
async fn run() -> Result<()> {
    if std::env::var_os("DACHSTERM_PROBE_JUMPS").is_some() {
        return jump_checks::run().await;
    }
    let dir = tempfile::tempdir()?;
    let paths = vec![dir.path().join("known_hosts")];
    let store = Arc::new(Store::open(&dir.path().join("sessions.sqlite3"))?);
    let manager = Arc::new(Connections::default());
    let p = store.save(base(), None)?;
    let mut rejected = begin(&manager, &store, &paths, p.clone(), env("PASSWORD"))?;
    assert!(rejected.connected(false).await.is_err());
    assert!(!paths[0].exists());
    println!("PASS product first-host rejection / no persistence");
    let mut first = begin(&manager, &store, &paths, p.clone(), env("PASSWORD"))?;
    first.connected(true).await?;
    queue_checks::run(manager.clone(), &first.id, "/tmp").await?;
    println!("PASS queue suite cleanup");
    workspace_checks::files(manager.clone(), &first.id, &store.list()?.profiles[0].id).await?;
    workspace_checks::services(manager.clone(), &first.id, &p.id).await?;
    first.send("stty -echo; printf '\\nREADY_ONE\\n'\n").await?;
    first.marker("READY_ONE\r\n").await?;
    first
        .manager
        .control(&first.id)?
        .input
        .send(Input::Resize(111, 37))
        .await?;
    first.send("stty size; printf '한글 UTF-8\\n'\n").await?;
    let output = first.marker("한글 UTF-8\r\n").await?;
    assert!(output.contains("37 111"), "PTY size mismatch");
    assert!(store.profile(&p.id)?.last_connected.is_some());
    println!(
        "PASS product first-host acceptance / known_hosts / PTY UTF-8 / resize / recent timestamp"
    );
    let mut bad = begin(
        &manager,
        &store,
        &paths,
        p.clone(),
        uuid::Uuid::new_v4().to_string(),
    )?;
    bad.error("인증이 거부").await?;
    println!("PASS product bad authentication (no trust prompt)");
    let secret_ref = uuid::Uuid::new_v4().to_string();
    credentials::set(&secret_ref, &env("PASSWORD"))?;
    let saved = store.save(p.clone(), Some(secret_ref.clone()))?;
    assert!(saved.has_secret);
    assert!(*credentials::get(&secret_ref)? == env("PASSWORD"));
    let restored = Store::open(&dir.path().join("sessions.sqlite3"))?;
    assert!(restored.profile(&saved.id)?.has_secret);
    for entry in std::fs::read_dir(dir.path())? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            let bytes = std::fs::read(entry.path())?;
            assert!(
                !bytes
                    .windows(env("PASSWORD").len())
                    .any(|w| w == env("PASSWORD").as_bytes()),
                "plaintext secret persisted"
            );
        }
    }
    let vault = dachsterm::vault::Vault::default();
    let master = Zeroizing::new(uuid::Uuid::new_v4().to_string());
    store.0.lock().unwrap().execute_batch("CREATE TRIGGER vault_rollback BEFORE UPDATE OF secret_ref ON profiles BEGIN SELECT RAISE(ABORT,'test rollback'); END;")?;
    assert!(vault.configure(&store, None, &master).is_err());
    assert!(!vault.status(&store)?.enabled);
    assert!(store.secret_ref(&saved.id)?.as_deref() == Some(&secret_ref));
    assert!(*credentials::get(&secret_ref)? == env("PASSWORD"));
    store
        .0
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER vault_rollback")?;
    store.cleanup_credentials()?;
    vault.configure(&store, None, &master)?;
    let encrypted_ref = store.secret_ref(&saved.id)?.unwrap();
    assert!(encrypted_ref.starts_with("vault-"));
    assert!(*credentials::get(&encrypted_ref)? != env("PASSWORD"));
    assert!(*vault.get(&store, &encrypted_ref)? == env("PASSWORD"));
    store.cleanup_credentials()?;
    assert!(credentials::get(&secret_ref).is_err());
    vault.lock();
    assert!(vault.get(&store, &encrypted_ref).is_err());
    vault.unlock(&store, &master)?;
    assert!(*vault.get(&store, &encrypted_ref)? == env("PASSWORD"));
    store.save(p.clone(), None)?;
    store.cleanup_credentials()?;
    assert!(credentials::get(&encrypted_ref).is_err());
    println!(
        "PASS native OS credential, master vault encryption, transactional migration rollback, lock/unlock and cleanup"
    );
    let mut clients = vec![first];
    let rsa_path = dir.path().join("rsa-ring");
    std::fs::write(&rsa_path, env("RSA_KEY"))?;
    let mut rsa_profile = base();
    rsa_profile.auth = "key".into();
    rsa_profile.key_path = rsa_path.to_string_lossy().into();
    let rsa_profile = store.save(rsa_profile, None)?;
    let mut rsa_client = begin(&manager, &store, &paths, rsa_profile, String::new())?;
    rsa_client.connected(false).await?;
    rsa_client.send("printf 'RSA_RING_OK\\n'\r").await?;
    rsa_client.marker("RSA_RING_OK").await?;
    rsa_client.stop().await?;
    println!("PASS RSA SHA-2 authentication using ring");
    {
        use russh::keys::{
            signature::Verifier,
            ssh_key::{Algorithm, HashAlg, Signature},
        };
        let key = russh::keys::PublicKey::from_openssh(&env("RSA_HOST_KEY"))?;
        for hash in [Some(HashAlg::Sha256), Some(HashAlg::Sha512), None] {
            let forged = Signature::new(Algorithm::Rsa { hash }, vec![0; 384])?;
            assert!(Verifier::verify(&key, b"modified handshake", &forged).is_err());
        }
    }
    println!("PASS RSA verifier rejects forged SHA-2 and legacy SHA-1 signatures");
    for (fixture, encrypted) in [
        ("RSA_ENCRYPTED_KEY", true),
        ("RSA_PEM_KEY", false),
        ("RSA_PKCS8_KEY", true),
    ] {
        let path = dir.path().join(fixture);
        std::fs::write(&path, env(fixture))?;
        let mut profile = base();
        profile.auth = "key".into();
        profile.key_path = path.to_string_lossy().into();
        let profile = store.save(profile, None)?;
        let mut client = begin(
            &manager,
            &store,
            &paths,
            profile.clone(),
            if encrypted {
                env("PASSPHRASE")
            } else {
                String::new()
            },
        )?;
        client.connected(false).await?;
        client.stop().await?;
        if encrypted {
            let mut invalid = begin(
                &manager,
                &store,
                &paths,
                profile,
                uuid::Uuid::new_v4().to_string(),
            )?;
            invalid.error("Passphrase").await?;
        }
    }
    println!("PASS encrypted OpenSSH RSA, PEM, encrypted PKCS8 and wrong passphrase rejection");
    #[cfg(windows)]
    {
        let mut profile = base();
        profile.auth = "agent".into();
        let profile = store.save(profile, None)?;
        let mut client = begin(&manager, &store, &paths, profile, String::new())?;
        client.connected(false).await?;
        client.stop().await?;
        println!("PASS real OpenSSH agent RSA SHA-2 signing through isolated Windows pipe");
    }
    let mut mfa = base();
    mfa.auth = "key".into();
    mfa.key_path = rsa_path.to_string_lossy().into();
    mfa.port = env("MFA_PORT").parse()?;
    mfa.forward_agent = true;
    let mfa = store.save(mfa, None)?;
    let mut client = begin(&manager, &store, &paths, mfa.clone(), String::new())?;
    let mut challenged = false;
    let mut notice = None;
    loop {
        match client.event().await? {
            Event::HostKey { fingerprint, .. } => {
                let key = russh::keys::PublicKey::from_openssh(&env("RSA_HOST_KEY"))?;
                assert_eq!(
                    fingerprint,
                    key.fingerprint(russh::keys::HashAlg::Sha256).to_string()
                );
                manager.control(&client.id)?.trust.send(Some(true))?;
            }
            Event::AgentNotice { message } => notice = Some(message),
            Event::AuthPrompt {
                challenge, prompts, ..
            } => {
                challenged = true;
                let responses = prompts.iter().map(|_| env("PASSWORD")).collect();
                manager
                    .control(&client.id)?
                    .auth_reply
                    .send(dachsterm::ssh::AuthReply {
                        challenge,
                        responses: Zeroizing::new(responses),
                    })
                    .await
                    .map_err(|_| "reply queue closed")?;
            }
            Event::State { status, message } if status == "error" => return Err(message.into()),
            Event::State { status, .. } if status == "connected" => break,
            _ => {}
        }
    }
    assert!(challenged);
    assert!(agent_checks::refused(notice.as_deref()));
    client.stop().await?;
    let mut client = begin(&manager, &store, &paths, mfa, String::new())?;
    loop {
        if matches!(client.event().await?, Event::AuthPrompt { .. }) {
            break;
        }
    }
    client.stop().await?;
    println!(
        "PASS RSA-only host verification, RSA SHA256 + PAM MFA, cancellation during challenge"
    );
    println!("PASS a server refusing agent forwarding is reported once and the shell still opens");
    agent_checks::run(&manager, &store, &paths).await?;
    for i in 1..5 {
        let mut profile = base();
        profile.name = format!("fixture-{i}");
        let mut secret = env("PASSWORD");
        if i >= 2 {
            profile.auth = "key".into();
            let path = dir.path().join(format!("key-{i}"));
            std::fs::write(
                &path,
                env(match i {
                    2 => "PLAIN_KEY",
                    3 => "PLAIN_KEY",
                    _ => "ENCRYPTED_KEY",
                }),
            )?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
            }
            profile.key_path = path.to_string_lossy().into();
            secret = if i < 4 {
                String::new()
            } else {
                env("PASSPHRASE")
            };
        }
        let profile = store.save(profile, None)?;
        if i == 4 {
            let mut bad = begin(
                &manager,
                &store,
                &paths,
                profile.clone(),
                uuid::Uuid::new_v4().to_string(),
            )?;
            bad.error("Passphrase").await?;
        }
        let mut c = begin(&manager, &store, &paths, profile, secret)?;
        c.connected(false).await?;
        c.send("stty -echo; printf '\\nREADY_TAB\\n'\n").await?;
        c.marker("READY_TAB\r\n").await?;
        clients.push(c);
    }
    assert!(manager.entries.lock().unwrap().len() == 5);
    for (i, c) in clients.iter_mut().enumerate() {
        c.send(&format!("printf 'ISOLATED_{i}\\n'\n")).await?;
        c.marker(&format!("ISOLATED_{i}\r\n")).await?;
    }
    clients[2].stop().await?;
    clients.remove(2);
    clients[0].send("printf 'SURVIVES_CLOSE\\n'\n").await?;
    clients[0].marker("SURVIVES_CLOSE\r\n").await?;
    println!(
        "PASS five product connections / password, plain and encrypted Ed25519 / wrong passphrase / isolation / close"
    );
    // Backpressure: one frame stays outstanding until explicit xterm acknowledgement.
    let c = &mut clients[0];
    c.send("python3 -c 'print(\"x\"*1048576)'\n").await?;
    let outstanding = loop {
        if let Event::Data { seq, bytes } = timeout(Duration::from_secs(10), c.rx.recv())
            .await?
            .ok_or("output ended")?
        {
            assert!(bytes.len() <= 32768);
            break seq;
        }
    };
    assert!(
        timeout(Duration::from_millis(200), c.rx.recv())
            .await
            .is_err(),
        "output exceeded one outstanding frame"
    );
    c.manager.control(&c.id)?.ack.send(outstanding)?;
    c.stop().await?;
    clients.remove(0);
    println!("PASS bounded output backpressure / cancel while output blocked");
    let mut reconnected = begin(&manager, &store, &paths, p.clone(), env("PASSWORD"))?;
    reconnected.connected(false).await?;
    reconnected
        .send("stty -echo; printf '\\nNEW_SHELL\\n'\n")
        .await?;
    reconnected.marker("NEW_SHELL\r\n").await?;
    reconnected.stop().await?;
    println!("PASS reconnect creates a new authenticated shell");
    if stress_seconds() > 0 {
        // These idle clients no longer drain their output ACKs. Close them before
        // measuring cycles, rather than mistaking their normal ACK timeout for a leak.
        for client in &mut clients {
            client.stop().await?;
        }
        clients.clear();
    }
    stress(&manager, &store, &paths, &p).await?;
    let changed = russh::keys::PublicKey::from_openssh(&env("RSA_HOST_KEY"))?;
    std::fs::write(
        &paths[0],
        format!("[127.0.0.1]:{} {}\n", p.port, changed.to_openssh()?),
    )?;
    let mut blocked = begin(&manager, &store, &paths, p.clone(), env("PASSWORD"))?;
    blocked.error("호스트키가 변경").await?;
    println!("PASS changed host key blocked before authentication (including algorithm change)");
    let key = russh::keys::PublicKey::from_openssh(&env("HOST_KEY"))?;
    std::fs::write(
        &paths[0],
        format!("@revoked [127.0.0.1]:{} {}\n", p.port, key.to_openssh()?),
    )?;
    assert!(hostkeys::check(&paths, &p.host, p.port, &key).is_err());
    println!("PASS revoked known_hosts key rejected");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let mut stalled = base();
    stalled.port = listener.local_addr()?.port();
    let stalled = store.save(stalled, None)?;
    let mut timed = begin(&manager, &store, &paths, stalled, String::new())?;
    let (_socket, _) = listener.accept().await?;
    timed.error("협상 시간이 초과").await?;
    println!("PASS SSH handshake timeout without host prompt");
    manager.shutdown();
    timeout(Duration::from_secs(5), async {
        while !manager.entries.lock().unwrap().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await?;
    println!("PASS application shutdown removes every active connection");
    Ok(())
}
#[tokio::main]
async fn main() {
    if timeout(Duration::from_secs(600 + stress_seconds()), run())
        .await
        .is_ok_and(|r| r.is_ok())
    {
        println!("PASS Phase 1 product engine probes");
    } else {
        eprintln!("FAIL Phase 1 product engine; payload redacted, inspect last PASS");
        std::process::exit(1);
    }
}
