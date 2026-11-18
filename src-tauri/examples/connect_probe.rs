// Connection-path checks of the product engine against `npm run connect:fixture` (CG): an HTTP
// CONNECT and a SOCKS5 proxy in front of an SSH server that only they and the jump host can reach.
// `scripts/run-connect-probe.mjs` runs it. No secret output.
#[path = "probe_client/mod.rs"]
mod probe_client;
use dachsterm::{
    ssh::{AuthReply, Connections, Event, Secrets},
    storage::{Profile, Proxy, Store},
};
use probe_client::{Client, Result, base};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::mpsc,
    time::timeout,
};
use zeroize::Zeroizing;

struct Fixture {
    dir: PathBuf,
    user: String,
    proxy: String,
}
impl Fixture {
    fn read(&self, name: &str) -> String {
        std::fs::read_to_string(self.dir.join(name))
            .expect("fixture file missing; run npm run connect:fixture -- up")
            .trim()
            .to_string()
    }
    fn host_key(&self, fingerprint: &str) -> bool {
        ["host_target.pub", "host_jump.pub"].iter().any(|name| {
            russh::keys::PublicKey::from_openssh(&self.read(name))
                .map(|k| k.fingerprint(russh::keys::HashAlg::Sha256).to_string() == fingerprint)
                .unwrap_or(false)
        })
    }
}

fn proxy(socks: bool, username: &str) -> Proxy {
    let (host, username, secret_ref) = ("127.0.0.1".to_string(), username.to_string(), None);
    if socks {
        Proxy::Socks5 {
            host,
            port: 41080,
            username,
            secret_ref,
        }
    } else {
        Proxy::Http {
            host,
            port: 43128,
            username,
            secret_ref,
        }
    }
}
/// The internal `target` server, reached only through `proxy` (or a jump host).
fn target(proxy: Option<Proxy>) -> Profile {
    let mut p = Profile {
        host: "target".into(),
        port: 22,
        name: "target".into(),
        // The fixture's tinyproxy took 18-37 s per CONNECT under load (CG.1), so the longest.
        timeout: 120,
        keepalive: 15,
        ..base()
    };
    p.proxy = proxy;
    p
}

struct Run<'a> {
    fx: &'a Fixture,
    store: Arc<Store>,
    manager: Arc<Connections>,
    paths: Vec<PathBuf>,
}
impl Run<'_> {
    fn start(&self, profile: Profile, route: Secrets) -> Result<Client> {
        // A key file login takes the secret as its Passphrase; the fixture keys have none.
        let secret = if profile.auth == "key" {
            String::new()
        } else {
            self.fx.user.clone()
        };
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = mpsc::channel(256);
        let secret = Zeroizing::new(secret);
        self.manager.start_route(
            id.clone(),
            profile,
            secret,
            route,
            self.paths.clone(),
            Arc::new(move |e| tx.try_send(e).map_err(|_| "probe queue full".into())),
            self.store.clone(),
        )?;
        Ok(Client {
            id,
            rx,
            manager: self.manager.clone(),
            bytes: vec![],
        })
    }
    /// Answers host keys and prompts until the connection is up. Returns the status message and
    /// the names of the prompts it answered.
    async fn ready(&self, c: &mut Client) -> std::result::Result<(String, Vec<String>), String> {
        let mut prompts = vec![];
        loop {
            // Longer than the profiles' 120-second timeout, so the product's own error arrives.
            let event = timeout(Duration::from_secs(150), c.rx.recv())
                .await
                .map_err(|_| "no event for 150 seconds")?
                .ok_or("event stream ended")?;
            if let Event::Data { seq, bytes } = &event {
                let control = c.manager.control(&c.id).map_err(|e| e.to_string())?;
                control.ack.send(*seq).map_err(|e| e.to_string())?;
                c.bytes.extend(bytes);
            }
            match event {
                Event::HostKey { fingerprint, .. } => {
                    assert!(self.fx.host_key(&fingerprint), "unknown host key");
                    let control = c.manager.control(&c.id).map_err(|e| e.to_string())?;
                    control.trust.send(Some(true)).map_err(|e| e.to_string())?;
                }
                Event::AuthPrompt {
                    challenge, name, ..
                } => {
                    let answer = if name.contains("프록시") {
                        self.fx.proxy.clone()
                    } else {
                        self.fx.user.clone()
                    };
                    prompts.push(name);
                    let control = c.manager.control(&c.id).map_err(|e| e.to_string())?;
                    control
                        .auth_reply
                        .send(AuthReply {
                            challenge,
                            responses: Zeroizing::new(vec![answer]),
                        })
                        .await
                        .map_err(|e| e.to_string())?;
                }
                Event::State { status, message } if status == "error" => return Err(message),
                // Notices other than the routine one, such as a certificate warning.
                Event::State { status, message }
                    if status == "authenticating" && !message.ends_with("인증 중입니다.") =>
                {
                    prompts.push(message)
                }
                Event::State { status, message } if status == "connected" => {
                    return Ok((message, prompts));
                }
                _ => {}
            }
        }
    }
    async fn failure(&self, profile: Profile, route: Secrets, expected: &str) -> Result<()> {
        let mut c = self.start(profile, route)?;
        let error = self
            .ready(&mut c)
            .await
            .expect_err("connected unexpectedly");
        assert!(
            error.contains(expected),
            "expected {expected:?}, got {error:?}"
        );
        Ok(())
    }
}

/// Terminal, SFTP, a Local tunnel and monitoring on one connection: the services that reuse it.
async fn services(c: &mut Client, profile_id: &str) -> Result<()> {
    use dachsterm::{
        monitoring::Monitors,
        tunnels::{Config, Tunnels},
    };
    c.send("stty -echo; printf '\\nHOST=%s\\n' \"$(hostname)\"\n")
        .await?;
    let output = c.marker("HOST=target\r\n").await?;
    assert!(output.contains("HOST=target"));
    let listing = dachsterm::sftp::list(&c.manager, &c.id, "/").await?;
    assert!(
        listing
            .entries
            .iter()
            .any(|e| e.name == "etc" && e.directory),
        "SFTP listing of / misses etc"
    );
    let tunnels = Arc::new(Tunnels::default());
    let config = Config {
        id: uuid::Uuid::new_v4().to_string(),
        profile_id: profile_id.into(),
        name: "proxy-local".into(),
        kind: "local".into(),
        port: 0,
        host: "127.0.0.1".into(),
        target_port: 22,
        auto_start: false,
    };
    let local = tunnels
        .start(c.manager.clone(), c.id.clone(), config)
        .await?;
    let port = (tunnels.list().into_iter().find(|t| t.id == local))
        .unwrap()
        .port;
    let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
    let mut banner = [0u8; 4];
    timeout(Duration::from_secs(10), socket.read_exact(&mut banner)).await??;
    assert_eq!(&banner, b"SSH-", "the tunnel reaches the target's sshd");
    socket.shutdown().await.ok();
    tunnels.stop(&local);
    let monitors = Arc::new(Monitors::default());
    monitors.configure(c.manager.clone(), c.id.clone(), true, 2, "all".into())?;
    timeout(Duration::from_secs(20), async {
        while !monitors.get(&c.id).is_some_and(|m| m.history.len() >= 2) {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await?;
    monitors.configure(c.manager.clone(), c.id.clone(), false, 2, "all".into())?;
    Ok(())
}

async fn run(dir: &Path) -> Result<()> {
    let fx = Fixture {
        dir: dir.into(),
        user: String::new(),
        proxy: String::new(),
    };
    let fx = Fixture {
        user: fx.read("user.password"),
        proxy: fx.read("proxy.password"),
        ..fx
    };
    let work = tempfile::tempdir()?;
    let run = Run {
        fx: &fx,
        store: Arc::new(Store::open(&work.path().join("sessions.sqlite3"))?),
        manager: Arc::new(Connections::default()),
        paths: vec![work.path().join("known_hosts")],
    };
    let saved = |p: Profile| run.store.save(p, None);

    // HTTP CONNECT, password asked at connect time.
    let http = saved(target(Some(proxy(false, "probe"))))?;
    let mut c = run.start(http.clone(), Secrets::default())?;
    let (message, prompts) = run.ready(&mut c).await.map_err(|e| e.to_string())?;
    assert!(
        message.contains("HTTP 프록시 경유 (127.0.0.1:43128)"),
        "{message}"
    );
    assert!(prompts.iter().any(|p| p.contains("프록시 암호")));
    services(&mut c, &http.id).await?;
    c.stop().await?;
    println!("PASS HTTP CONNECT (asked password): terminal, SFTP, Local tunnel, monitoring");

    // SOCKS5 with the saved password.
    let socks = saved(target(Some(proxy(true, "probe"))))?;
    let route = Secrets {
        hops: vec![],
        proxy: Some(Zeroizing::new(fx.proxy.clone())),
    };
    let mut c = run.start(socks.clone(), route)?;
    let (message, prompts) = run.ready(&mut c).await.map_err(|e| e.to_string())?;
    assert!(
        message.contains("SOCKS5 프록시 경유 (127.0.0.1:41080)"),
        "{message}"
    );
    assert!(prompts.is_empty(), "a saved password is not asked");
    services(&mut c, &socks.id).await?;
    c.stop().await?;
    println!(
        "PASS SOCKS5 (saved password, name resolved by the proxy): terminal, SFTP, Local tunnel, monitoring"
    );

    // SOCKS5 → jump host → target: the proxy belongs to the first jump host.
    let mut jump = target(Some(proxy(true, "probe")));
    jump.host = "jump".into();
    jump.name = "jump".into();
    let jump = saved(jump)?;
    let mut end = target(None);
    end.jump_ids = vec![jump.id.clone()];
    let end = saved(end)?;
    let route = Secrets {
        hops: vec![(jump.clone(), Some(Zeroizing::new(fx.user.clone())))],
        proxy: Some(Zeroizing::new(fx.proxy.clone())),
    };
    let mut c = run.start(end.clone(), route)?;
    let (message, _) = run.ready(&mut c).await.map_err(|e| e.to_string())?;
    assert!(
        message.starts_with("연결됨 · SOCKS5 프록시 경유 (127.0.0.1:41080) → jump"),
        "{message}"
    );
    services(&mut c, &end.id).await?;
    c.stop().await?;
    println!("PASS SOCKS5 → jump → target: terminal, SFTP, Local tunnel, monitoring");

    // Errors the user sees, with the answers measured in CG.0.
    const AUTH_FAILED: &str = "프록시 인증에 실패했습니다.";
    let wrong = |p: Profile| Secrets {
        hops: vec![],
        proxy: p
            .proxy
            .as_ref()
            .map(|_| Zeroizing::new("wrong-password".to_string())),
    };
    run.failure(http.clone(), wrong(http.clone()), AUTH_FAILED)
        .await?;
    run.failure(socks.clone(), wrong(socks.clone()), AUTH_FAILED)
        .await?;
    for socks in [false, true] {
        let anonymous = saved(target(Some(proxy(socks, ""))))?;
        run.failure(anonymous, Secrets::default(), "프록시가 인증을 요구합니다.")
            .await?;
    }
    let saved_proxy = || Secrets {
        hops: vec![],
        proxy: Some(Zeroizing::new(fx.proxy.clone())),
    };
    let mut port23 = target(Some(proxy(false, "probe")));
    port23.port = 23;
    let port23 = saved(port23)?;
    run.failure(
        port23,
        saved_proxy(),
        "프록시가 이 목적지를 허용하지 않습니다.",
    )
    .await?;
    for socks in [false, true] {
        let mut missing = target(Some(proxy(socks, "probe")));
        missing.host = "no-such-host.invalid".into();
        let missing = saved(missing)?;
        run.failure(
            missing,
            saved_proxy(),
            "프록시가 목적지에 연결하지 못했습니다(",
        )
        .await?;
    }
    let mut closed = target(Some(proxy(true, "probe")));
    if let Some(Proxy::Socks5 { port, .. }) = &mut closed.proxy {
        *port = 1;
    }
    let closed = saved(closed)?;
    run.failure(
        closed,
        saved_proxy(),
        "프록시(127.0.0.1:1)에 연결할 수 없습니다.",
    )
    .await?;
    println!(
        "PASS proxy errors: wrong password (HTTP 401, SOCKS 01 02), auth required (407, 05 FF), port refused (403), unknown host (500, SOCKS 1), closed proxy port"
    );
    certificates(&run).await?;
    commands(&run).await?;
    x11(&run).await
}

/// CG.9: X11 to the fixture's Xvfb (`127.0.0.1:40000`, cookie in the runner's `XAUTHORITY`).
async fn x11(run: &Run<'_>) -> Result<()> {
    let session = |forward: bool, display: &str| {
        let mut p = target(None);
        p.host = "127.0.0.1".into();
        p.port = 42222;
        p.name = format!("x11 {display}");
        p.forward_x11 = forward;
        p.x11_display = display.into();
        run.store.save(p, None)
    };
    // Runs `script` and returns the output up to `marker`, with any notices on the way.
    let shell =
        async |c: &mut Client, script: &str, marker: &str| -> Result<(String, Vec<String>)> {
            c.send(&format!("stty -echo; {script}; printf '\\n{marker}\\n'\n"))
                .await?;
            let mut notices = vec![];
            loop {
                if let Some(at) = String::from_utf8_lossy(&c.bytes).find(&format!("{marker}\r\n")) {
                    let out = String::from_utf8_lossy(&c.bytes)[..at].to_string();
                    c.bytes.clear();
                    return Ok((out, notices));
                }
                if let Event::AgentNotice { message } = c.event().await? {
                    notices.push(message);
                }
            }
        };
    let mut c = run.start(session(true, "127.0.0.1:40000")?, Secrets::default())?;
    run.ready(&mut c).await.map_err(|e| e.to_string())?;
    let (out, notices) = shell(
        &mut c,
        "echo DISPLAY=$DISPLAY; xdpyinfo 2>&1 | grep -m1 'vendor string'",
        "X11_DONE",
    )
    .await?;
    assert!(out.contains("DISPLAY=localhost:1"), "{out}");
    assert!(out.contains("The X.Org Foundation"), "{out}");
    assert!(notices.is_empty(), "{notices:?}");
    c.stop().await?;
    let mut c = run.start(session(false, "")?, Secrets::default())?;
    run.ready(&mut c).await.map_err(|e| e.to_string())?;
    let (out, _) = shell(&mut c, "echo \"D=[$DISPLAY]\"", "NO_X11").await?;
    assert!(out.contains("D=[]"), "{out}");
    c.stop().await?;
    // Nothing listens on port 65000: the X client fails and the tab is told once.
    let mut c = run.start(session(true, "127.0.0.1:59000")?, Secrets::default())?;
    run.ready(&mut c).await.map_err(|e| e.to_string())?;
    let (out, mut notices) =
        shell(&mut c, "xdpyinfo >/dev/null 2>&1; echo rc=$?", "X11_NONE").await?;
    assert!(out.contains("rc=1"), "{out}");
    if notices.is_empty()
        && let Ok(Ok(Some(Event::AgentNotice { message }))) =
            timeout(Duration::from_secs(5), c.rx.recv())
                .await
                .map(Ok::<_, ()>)
    {
        notices.push(message);
    }
    assert!(
        notices
            .iter()
            .any(|n| n.contains("X 서버(XQuartz, VcXsrv 등)를 먼저 실행하세요.")),
        "{notices:?}"
    );
    c.stop().await?;
    println!(
        "PASS X11: xdpyinfo through the fake cookie reaches Xvfb, no DISPLAY without forwarding, a missing X server is told"
    );
    Ok(())
}

/// CG.2: ProxyCommand. `nc` reaches the jump host; `ssh -W` through it reaches the internal
/// server; a missing program is named; a closed connection leaves no process. Windows has no
/// `nc` or `pgrep`, so it runs the `ssh -W` and missing-program steps; the process ending with
/// the stream is the unit test `windows_dropping_the_stream_kills_the_process`.
async fn commands(run: &Run<'_>) -> Result<()> {
    let plain = run.fx.dir.join("plain").to_string_lossy().into_owned();
    let with_command = |name: &str, host: &str, command: String| {
        let mut p = target(Some(Proxy::Command { command }));
        p.name = name.into();
        p.host = host.into();
        run.store.save(p, None)
    };
    #[cfg(unix)]
    nc_to_jump(run, &with_command).await?;
    // Not `/dev/null` or `NUL`: Windows OpenSSH wrote `NUL` as a file in the working directory.
    let known = run.fx.dir.join("proxy_known_hosts");
    let known = known.to_string_lossy();
    let ssh = format!(
        "ssh -i {plain} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no \
         -o UserKnownHostsFile={known} -o LogLevel=ERROR -p 42222 -W %h:%p probe@127.0.0.1"
    );
    let through = with_command("ssh -W", "target", ssh)?;
    let mut c = run.start(through.clone(), Secrets::default())?;
    run.ready(&mut c).await.map_err(|e| e.to_string())?;
    services(&mut c, &through.id).await?;
    c.stop().await?;
    println!("PASS ProxyCommand: ssh -W to target with SFTP, Local tunnel, monitoring");
    let missing = with_command("missing", "target", "dachsterm-no-such-proxy %h %p".into())?;
    let mut c = run.start(missing, Secrets::default())?;
    let error = run
        .ready(&mut c)
        .await
        .expect_err("a missing program connected");
    // macOS: the shell starts and says so on standard error. Windows: the program cannot start.
    let told = if cfg!(windows) {
        "프록시 명령을 실행할 수 없습니다: dachsterm-no-such-proxy"
    } else {
        "명령 표준 오류:"
    };
    assert!(
        error.contains(told) && error.contains("dachsterm-no-such-proxy"),
        "{error}"
    );
    println!("PASS ProxyCommand failure names the program: {error}");
    Ok(())
}

#[cfg(unix)]
async fn nc_to_jump(
    run: &Run<'_>,
    with_command: &impl Fn(&str, &str, String) -> dachsterm::storage::Result<Profile>,
) -> Result<()> {
    let pids = |pattern: &str| {
        let out = std::process::Command::new("pgrep")
            .args(["-f", pattern])
            .output();
        out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default()
    };
    let nc = with_command("nc", "jump", "nc 127.0.0.1 42222".into())?;
    let mut c = run.start(nc, Secrets::default())?;
    let (message, _) = run.ready(&mut c).await.map_err(|e| e.to_string())?;
    assert!(
        message.contains("명령으로 연결: nc → nc (jump:22)"),
        "{message}"
    );
    assert!(
        !pids("nc 127.0.0.1 42222").is_empty(),
        "nc runs while connected"
    );
    c.send("stty -echo; printf '\\nHOST=%s\\n' \"$(hostname)\"\n")
        .await?;
    c.marker("HOST=jump\r\n").await?;
    c.stop().await?;
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(
        pids("nc 127.0.0.1 42222").is_empty(),
        "nc is gone after the tab closes"
    );
    println!("PASS ProxyCommand: nc to the jump host (process ends with the tab)");
    Ok(())
}

/// CG.3: user certificates from the fixture CA. The `cert_*` keys are not in `authorized_keys`,
/// so only their certificate can log in.
async fn certificates(run: &Run<'_>) -> Result<()> {
    let key = |name: &str| run.fx.dir.join(name).to_string_lossy().into_owned();
    let login = |name: &str, cert: &str| {
        let mut p = target(None);
        p.host = "127.0.0.1".into();
        p.port = 42222;
        p.name = format!("jump {name}");
        p.auth = "key".into();
        p.key_path = key(name);
        p.cert_path = cert.into();
        run.store.save(p, None)
    };
    let hostname = async |c: &mut Client, expected: &str| -> Result<()> {
        c.send("stty -echo; printf '\\nHOST=%s\\n' \"$(hostname)\"\n")
            .await?;
        c.marker(&format!("HOST={expected}\r\n")).await?;
        c.stop().await
    };
    // Ed25519 beside its key (`-cert.pub`), RSA named in the session: SHA-2, not SHA-1.
    for (name, cert) in [
        ("cert_ed25519", String::new()),
        ("cert_rsa", key("cert_rsa-cert.pub")),
    ] {
        let mut c = run.start(login(name, &cert)?, Secrets::default())?;
        run.ready(&mut c)
            .await
            .map_err(|e| format!("{name}: {e}"))?;
        hostname(&mut c, "jump").await?;
    }
    // Through the SOCKS5 proxy to the internal server as well.
    let mut through = login("cert_ed25519", "")?;
    through.host = "target".into();
    through.port = 22;
    through.proxy = Some(proxy(true, "probe"));
    let through = run.store.save(through, None)?;
    let route = Secrets {
        hops: vec![],
        proxy: Some(Zeroizing::new(run.fx.proxy.clone())),
    };
    let mut c = run.start(through, route)?;
    run.ready(&mut c).await.map_err(|e| e.to_string())?;
    hostname(&mut c, "target").await?;
    println!(
        "PASS certificates: Ed25519 beside the key, RSA named (SHA-2), Ed25519 through SOCKS5"
    );

    // Expired: named stops before the server; beside the key it is skipped and the key alone is refused.
    let named = login("cert_expired", &key("cert_expired-cert.pub"))?;
    run.failure(named, Secrets::default(), "인증서가 만료되었습니다(만료 ")
        .await?;
    let beside = login("cert_expired", "")?;
    let mut c = run.start(beside, Secrets::default())?;
    let error = run
        .ready(&mut c)
        .await
        .expect_err("an expired certificate logged in");
    assert!(error.contains("인증이 거부되었습니다"), "{error}");
    // Another principal: a warning first, then the server's refusal.
    let other = login("cert_other", "")?;
    let mut c = run.start(other, Secrets::default())?;
    let mut notices = vec![];
    let error = loop {
        match c.event().await? {
            Event::HostKey { .. } => c.manager.control(&c.id)?.trust.send(Some(true))?,
            Event::State { status, message } if status == "authenticating" => notices.push(message),
            Event::State { status, message } if status == "error" => break message,
            Event::State { status, .. } if status == "connected" => panic!("logged in"),
            _ => {}
        }
    };
    assert!(
        notices
            .iter()
            .any(|n| n.contains("인증서 주체(someone-else)에 사용자 'probe'가 없어")),
        "{notices:?}"
    );
    assert!(error.contains("인증이 거부되었습니다"), "{error}");
    let mut mismatch = login("cert_ed25519", &key("cert_rsa-cert.pub"))?;
    mismatch.name = "mismatch".into();
    let mismatch = run.store.save(mismatch, None)?;
    run.failure(mismatch, Secrets::default(), "짝이 맞지 않습니다")
        .await?;
    println!(
        "PASS certificate checks: expired (named: local error; beside: skipped, key refused), other principal (warning, refused), wrong pair"
    );
    Ok(())
}

#[tokio::main]
async fn main() {
    let dir = std::env::var("DACHSTERM_CONNECT_FIXTURE").expect("DACHSTERM_CONNECT_FIXTURE");
    if let Err(e) = run(Path::new(&dir)).await {
        eprintln!("FAIL {e}");
        std::process::exit(1);
    }
}
