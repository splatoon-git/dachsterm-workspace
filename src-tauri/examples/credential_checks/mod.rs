//! HTTPS Git credentials (DX.12) with real OpenSSH and a real HTTPS Git server (tests/git-https):
//! the three sources of a value, a refusal, the server-side daemon, refusals of http, a foreign
//! socket and oversized or surplus requests, tmux, and older git versions. This PC's git runs with
//! the isolated HOME and `store` helper run-phase1 prepares, so the user's own credential manager
//! is never asked. Tokens exist only in the fixture and this process and are never printed.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use dachsterm::{
    git_credential::{
        Credential, CredentialRequest, Decision,
        commands::{self, Reply},
        protocol,
    },
    storage::GitCredential,
    vault::Vault,
};

pub const HOST: &str = "git.test:3000";
const NO_DAEMON: &str =
    "pgrep -f credential-cache--daemon >/dev/null && echo DAEMON_FOUND || echo DAEMON_NONE";

/// How a probe answers a card.
#[derive(Clone, Copy, Debug)]
enum Card {
    Deny,
    /// Allow without typing: the app's saved token or this PC's git must answer.
    Found(Decision),
    /// Nothing is found, so the card asks for the value, which the probe types.
    Typed(Decision),
}

struct Outcome {
    output: String,
    cards: Vec<CredentialRequest>,
    notices: Vec<String>,
}
impl Outcome {
    fn exit(&self, end: &str) -> Option<i32> {
        let line = self.output.lines().find(|l| l.trim_end().ends_with(end))?;
        line.split_whitespace().next()?.parse().ok()
    }
}

struct Session {
    client: Client,
    store: Arc<Store>,
    vault: Arc<Vault>,
    path: String,
}

fn typed() -> Credential {
    Credential {
        username: Zeroizing::new("probe".into()),
        password: Zeroizing::new(env("GIT_PASSWORD")),
    }
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The socket the shell line names: `case ... in *<path>*)`.
fn socket_of(line: &str) -> String {
    let start = line.find(" in *").expect("shell line") + 5;
    let end = line[start..].find("*)").expect("shell line") + start;
    line[start..end].to_string()
}

/// Names the step of a failure outside `Session::run`. The message is the app's own text.
fn failed(
    step: &'static str,
) -> impl FnOnce(Box<dyn std::error::Error>) -> Box<dyn std::error::Error> {
    move |e| {
        eprintln!("FAIL HTTPS credential step {step}: {e}");
        e
    }
}

/// Writes a small file on the server without typing quotes or line breaks into the shell.
fn upload(path: &str, content: &str) -> String {
    format!("echo {} | base64 -d > {path}", STANDARD.encode(content))
}

impl Session {
    /// Connects, trusting the fixture's host key, and returns the refusal notices on the way.
    async fn open(
        manager: &Arc<Connections>,
        store: &Arc<Store>,
        vault: &Arc<Vault>,
        paths: &[PathBuf],
        profile: Profile,
        secret: String,
    ) -> Result<(Self, Vec<String>)> {
        let mut client = begin(manager, store, paths, profile, secret)?;
        let mut notices = vec![];
        loop {
            match client.event().await? {
                Event::HostKey { .. } => manager.control(&client.id)?.trust.send(Some(true))?,
                Event::AgentNotice { message } => notices.push(message),
                Event::State { status, message } if status == "error" => {
                    return Err(message.into());
                }
                Event::State { status, .. } if status == "connected" => break,
                _ => {}
            }
        }
        let path = commands::shell_line(manager, &client.id)
            .map(|line| socket_of(&line))
            .unwrap_or_default();
        let session = Self {
            client,
            store: store.clone(),
            vault: vault.clone(),
            path,
        };
        Ok((session, notices))
    }
    /// What the app's shell hook adds, typed into the interactive shell as the hook would be.
    async fn ready(&mut self) -> Result<()> {
        let line =
            commands::shell_line(&self.client.manager, &self.client.id).ok_or("no socket")?;
        self.client
            .send(&format!(
                "stty -echo; export GIT_SSL_NO_VERIFY=1; {line}; {line}; printf '\\nCRED_READY\\n'\n"
            ))
            .await?;
        self.client.marker("CRED_READY\r\n").await?;
        let shown = self
            .run(
                "printf '%s\\n' \"$GIT_CONFIG_PARAMETERS\"",
                "VALUE_END",
                |_| Card::Deny,
            )
            .await?;
        assert!(
            shown.output.contains(&protocol::parameter(&self.path)),
            "the helper reaches git as one item"
        );
        assert_eq!(
            shown.output.matches("credential.helper=").count(),
            1,
            "typing the line twice adds it once"
        );
        Ok(())
    }
    async fn answer(&self, request: &CredentialRequest, card: Card) -> Result<()> {
        let call = |decision, value| {
            commands::answer(
                &self.client.manager,
                self.store.clone(),
                self.vault.clone(),
                &self.client.id,
                &request.request,
                decision,
                value,
            )
        };
        let done = Reply::Done { notice: None };
        match card {
            Card::Deny => assert_eq!(call(Decision::Deny, None).await?, done),
            Card::Found(decision) => {
                assert_eq!(call(decision, None).await?, done, "a value was found");
            }
            Card::Typed(decision) => {
                let asked = call(decision, None).await?;
                assert!(matches!(asked, Reply::Input { .. }), "{asked:?}");
                assert_eq!(call(decision, Some(typed())).await?, done);
            }
        }
        Ok(())
    }
    /// Runs one command and answers every card with `card` until the end marker arrives. A
    /// failure names its step; the message is the app's own text, never the terminal output.
    async fn run(
        &mut self,
        script: &str,
        end: &str,
        card: impl FnMut(&CredentialRequest) -> Card,
    ) -> Result<Outcome> {
        self.step(script, end, card).await.map_err(|e| {
            let text = String::from_utf8_lossy(&self.client.bytes);
            let asked = text.contains("Username for") || text.contains("Password for");
            eprintln!("FAIL HTTPS credential step {end}: {e} (git asked in the terminal: {asked})");
            e
        })
    }
    async fn step(
        &mut self,
        script: &str,
        end: &str,
        mut card: impl FnMut(&CredentialRequest) -> Card,
    ) -> Result<Outcome> {
        self.client
            .send(&format!("{script}; printf '%s {end}\\n' $?\n"))
            .await?;
        let marker = format!(" {end}\r\n");
        let (mut cards, mut notices) = (vec![], vec![]);
        loop {
            if String::from_utf8_lossy(&self.client.bytes).contains(&marker) {
                let output = String::from_utf8_lossy(&self.client.bytes).into_owned();
                self.client.bytes.clear();
                return Ok(Outcome {
                    output,
                    cards,
                    notices,
                });
            }
            match self.client.event().await? {
                Event::GitCredential(request) => {
                    let plan = card(&request);
                    self.answer(&request, plan).await?;
                    cards.push(request);
                }
                Event::AgentNotice { message } => notices.push(message),
                Event::State { status, message } if status == "error" => {
                    return Err(message.into());
                }
                _ => {}
            }
        }
    }
}

fn first_push(repo: &str) -> String {
    format!(
        "cd ~ && rm -rf {repo} && git init -q {repo} && cd {repo} && \
         git config user.email p@example.invalid && git config user.name probe && \
         echo 1 > f && git add f && git commit -qm c1 && {}",
        push(repo)
    )
}
fn next_push(repo: &str, n: u32) -> String {
    format!(
        "cd ~/{repo} && echo {n} > f && git commit -qam c{n} && {}",
        push(repo)
    )
}
fn push(repo: &str) -> String {
    format!("git push -q https://{HOST}/probe/{repo}.git HEAD:refs/heads/main")
}
fn fill(protocol: &str) -> String {
    format!(
        "printf 'protocol={protocol}\\nhost={HOST}\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill"
    )
}

fn credential_profile(name: &str) -> Profile {
    let mut profile = base();
    profile.name = name.into();
    profile.forward_git_credentials = true;
    profile
}

/// `keep` is a connection opened before these checks. It must outlive every one of them; its
/// queued events are taken here, so output it receives meanwhile is acknowledged.
pub async fn run(
    manager: &Arc<Connections>,
    store: &Arc<Store>,
    paths: &[PathBuf],
    mut keep: Option<&mut Client>,
) -> Result<()> {
    let mut survives = |step: &str| -> Result<()> {
        let Some(client) = keep.as_deref_mut() else {
            return Ok(());
        };
        while let Ok(event) = client.rx.try_recv() {
            match event {
                Event::Data { seq, .. } => {
                    let _ = manager.control(&client.id).map(|c| c.ack.send(seq));
                }
                Event::State { status, message } if status == "closed" || status == "error" => {
                    return Err(
                        format!("an earlier connection ended during {step}: {message}").into(),
                    );
                }
                _ => {}
            }
        }
        Ok(())
    };
    let vault = Arc::new(Vault::default());
    let open = |profile: Profile| {
        let profile = store.save(profile, None);
        let vault = vault.clone();
        async move { Session::open(manager, store, &vault, paths, profile?, env("PASSWORD")).await }
    };

    // Typed on the card, in the user's private runtime folder.
    let (mut s, notices) = open(credential_profile("cred-typed")).await?;
    assert!(notices.is_empty(), "the fixture allows socket forwarding");
    assert!(s.path.starts_with("/run/user/"), "XDG_RUNTIME_DIR is used");
    s.ready().await?;
    let mode = s
        .run(&format!("ls -l {}", s.path), "MODE_END", |_| Card::Deny)
        .await?;
    assert!(
        mode.output.contains("srw-------"),
        "only the user reaches it"
    );
    let pushed = s
        .run(&first_push("dx-main"), "PUSH_END", |_| {
            Card::Typed(Decision::Input)
        })
        .await?;
    assert_eq!(pushed.exit("PUSH_END"), Some(0), "a typed value pushes");
    assert_eq!(pushed.cards.len(), 1);
    assert_eq!(pushed.cards[0].host, HOST);
    assert!(pushed.cards[0].server_helpers.is_empty());
    let daemon = s
        .run(
            &format!(
                "printf 'protocol=https\\nhost={HOST}\\nusername=probe\\npassword=x\\n\\n' | git credential approve; \
                 printf 'protocol=https\\nhost={HOST}\\nusername=probe\\npassword=x\\n\\n' | git credential reject; {NO_DAEMON}"
            ),
            "DAEMON_END",
            |_| Card::Deny,
        )
        .await?;
    assert!(daemon.output.contains("DAEMON_NONE") && daemon.cards.is_empty());
    println!("PASS HTTPS credential: typed on the card, push, store and erase start no daemon");
    survives("step 1")?;

    // Git LFS asks three times for one push; "allow once" answers them with one card. The wait
    // lets the first push's allowance (30 seconds) end; output keeps the probe's event timer alive.
    let lfs = s
        .run(
            "cd ~/dx-main && git lfs install --local >/dev/null && git lfs track '*.bin' >/dev/null && \
             head -c 4096 /dev/urandom > a.bin && git add .gitattributes a.bin && git commit -qm lfs && \
             for i in 1 2 3 4; do sleep 8; echo wait$i; done && \
             git push -q https://git.test:3000/probe/dx-main.git HEAD:refs/heads/main",
            "LFS_END",
            |_| Card::Typed(Decision::Once),
        )
        .await?;
    assert_eq!(lfs.exit("LFS_END"), Some(0));
    assert_eq!(lfs.cards.len(), 1, "one card for an LFS push");
    s.client.stop().await?;
    println!("PASS HTTPS credential: an LFS push asks once");
    survives("step 2")?;

    // A token saved in the app.
    let reference = vault.save(store, &env("GIT_PASSWORD"))?;
    store.set_git_credential(GitCredential {
        protocol: "https".into(),
        host: HOST.into(),
        username: "probe".into(),
        secret_ref: reference.clone(),
    })?;
    let (mut s, _) = open(credential_profile("cred-saved")).await?;
    s.ready().await?;
    let saved = s
        .run(&next_push("dx-main", 2), "PUSH_END", |_| {
            Card::Found(Decision::Once)
        })
        .await?;
    assert_eq!(saved.exit("PUSH_END"), Some(0), "the saved token pushes");
    assert_eq!(saved.cards.len(), 1);
    store.forget_git_credential("https", HOST, "probe")?;
    // Other checks' journaled entries may fail here; this check only needs its own one gone.
    let _ = store.cleanup_credentials();
    assert!(
        dachsterm::credentials::get(&reference).is_err(),
        "the OS entry is removed"
    );
    s.client.stop().await.map_err(failed("saved-stop"))?;
    println!("PASS HTTPS credential: the app's saved token, then removed with its OS entry");
    survives("step 3")?;

    // This PC's `git credential fill`, with the isolated store helper.
    let local_store = std::env::var("DACHSTERM_PROBE_GIT_STORE")?;
    std::fs::write(
        &local_store,
        format!("https://probe:{}@{HOST}\n", env("GIT_PASSWORD")),
    )?;
    let (mut s, _) = open(credential_profile("cred-fill")).await?;
    s.ready().await?;
    let filled = s
        .run(&next_push("dx-main", 3), "PUSH_END", |_| {
            Card::Found(Decision::Once)
        })
        .await?;
    std::fs::write(&local_store, "")?;
    assert_eq!(filled.exit("PUSH_END"), Some(0), "this PC's git answers");
    assert_eq!(filled.cards.len(), 1);
    s.client.stop().await?;
    println!("PASS HTTPS credential: this PC's git credential fill with an isolated HOME");
    survives("step 4")?;

    // Refused: git asks in the terminal as it would without the app.
    let (mut s, _) = open(credential_profile("cred-deny"))
        .await
        .map_err(failed("deny-open"))?;
    s.ready().await?;
    s.client
        .send(&format!(
            "{}; printf '%s DENY_END\\n' $?\n",
            next_push("dx-main", 4)
        ))
        .await?;
    // git asks for both in the terminal; empty answers end the push as a failed sign-in.
    let (mut denied, mut user, mut password) = (0, false, false);
    loop {
        let text = String::from_utf8_lossy(&s.client.bytes).into_owned();
        if text.contains(" DENY_END\r\n") {
            assert!(!text.contains("0 DENY_END"), "the refused push fails");
            break;
        }
        if !user && text.contains("Username for 'https://git.test:3000'") {
            user = true;
            s.client.send("\n").await?;
        }
        if !password && text.contains("Password for 'https://git.test:3000'") {
            password = true;
            s.client.send("\n").await?;
        }
        let event = s.client.event().await.map_err(failed("deny-wait"))?;
        if let Event::GitCredential(request) = event {
            s.answer(&request, Card::Deny)
                .await
                .map_err(failed("deny-answer"))?;
            denied += 1;
        }
    }
    assert!(user, "git asked in the terminal");
    assert_eq!(denied, 1);
    s.client.bytes.clear();
    let old_path = s.path.clone();
    s.client.stop().await.map_err(failed("deny-stop"))?;
    println!("PASS HTTPS credential: refusing lets git ask in the terminal");
    survives("step 5")?;

    // Ten minutes for the connection, then what is refused.
    let (mut s, _) = open(credential_profile("cred-limits")).await?;
    let gone = s
        .run(
            &format!("test -e {old_path} && echo SOCKET_LEFT || echo SOCKET_GONE"),
            "GONE_END",
            |_| Card::Deny,
        )
        .await?;
    assert!(
        gone.output.contains("SOCKET_GONE"),
        "a closed connection removed its socket"
    );
    s.ready().await?;
    let first = s
        .run(&next_push("dx-main", 5), "PUSH5_END", |_| {
            Card::Typed(Decision::Connection)
        })
        .await?;
    let second = s
        .run(&next_push("dx-main", 6), "PUSH6_END", |_| Card::Deny)
        .await?;
    assert_eq!(
        (first.exit("PUSH5_END"), second.exit("PUSH6_END")),
        (Some(0), Some(0))
    );
    assert_eq!(
        (first.cards.len(), second.cards.len()),
        (1, 0),
        "allowed for the connection"
    );
    let http = s
        .run(
            &format!("{} >/dev/null 2>&1", fill("http")),
            "HTTP_END",
            |_| Card::Deny,
        )
        .await?;
    assert_ne!(http.exit("HTTP_END"), Some(0));
    assert!(http.cards.is_empty() && http.notices.iter().any(|n| n.contains("http")));
    let foreign = protocol::parameter("/tmp/dachsterm-git-rootowned");
    let owned = s
        .run(
            &format!(
                "GIT_CONFIG_PARAMETERS={} {} >/dev/null 2>&1; wc -c < /tmp/dx-rootsock.log",
                quote(&foreign),
                fill("https")
            ),
            "OWNER_END",
            |_| Card::Deny,
        )
        .await?;
    assert!(
        owned.output.lines().any(|l| l.trim() == "0"),
        "a socket of another user is never asked"
    );
    let limit = "import socket, sys\n\
        s = socket.socket(socket.AF_UNIX)\n\
        s.connect(sys.argv[1])\n\
        try:\n\
        \x20   s.sendall(b'action=get\\nprotocol=https\\nhost=git.test:3000\\nusername=' + b'a' * 70000 + b'\\n')\n\
        \x20   s.shutdown(socket.SHUT_WR)\n\
        \x20   s.settimeout(10)\n\
        \x20   print('LIMIT', len(s.recv(100)))\n\
        except Exception as e:\n\
        \x20   print('LIMIT', type(e).__name__)\n";
    let large = s
        .run(
            &format!(
                "{} && python3 /tmp/dx-limit.py {}",
                upload("/tmp/dx-limit.py", limit),
                s.path
            ),
            "LIMIT_END",
            |_| Card::Deny,
        )
        .await?;
    assert!(large.cards.is_empty() && large.output.contains("LIMIT "));
    assert!(
        !large.output.contains("LIMIT 1"),
        "no answer to a request over 64 KiB"
    );
    let fifth = "import socket, sys, time\n\
        held = []\n\
        for _ in range(4):\n\
        \x20   h = socket.socket(socket.AF_UNIX)\n\
        \x20   h.connect(sys.argv[1])\n\
        \x20   h.sendall(b'action=get\\n')\n\
        \x20   held.append(h)\n\
        time.sleep(1)\n\
        s = socket.socket(socket.AF_UNIX)\n\
        s.connect(sys.argv[1])\n\
        s.sendall(b'action=get\\nprotocol=https\\nhost=git.test:3000\\n')\n\
        s.shutdown(socket.SHUT_WR)\n\
        s.settimeout(10)\n\
        try:\n\
        \x20   print('FIFTH', len(s.recv(100)))\n\
        except Exception as e:\n\
        \x20   print('FIFTH', type(e).__name__)\n";
    let surplus = s
        .run(
            &format!(
                "{} && python3 /tmp/dx-fifth.py {}",
                upload("/tmp/dx-fifth.py", fifth),
                s.path
            ),
            "FIFTH_END",
            |_| Card::Deny,
        )
        .await?;
    assert!(
        surplus.cards.is_empty(),
        "the fifth channel is refused, not asked"
    );
    assert!(surplus.output.contains("FIFTH 0") || surplus.output.contains("FIFTH Connection"));
    let burst = s
        .run(
            &format!(
                "sleep 11; for i in $(seq 1 11); do {} >/dev/null 2>&1 && printf 'OK%s ' $i || printf 'NO%s ' $i; done",
                fill("https")
            ),
            "BURST_END",
            |_| Card::Deny,
        )
        .await?;
    assert!(
        burst.output.contains("OK9 OK10 NO11"),
        "the eleventh in ten seconds"
    );
    assert!(burst.cards.is_empty() && burst.notices.iter().any(|n| n.contains("반복")));
    s.client.stop().await?;
    println!(
        "PASS HTTPS credential: ten minutes per connection; http, a foreign socket, 64 KiB, a fifth channel and a burst are refused; a closed connection's socket is removed"
    );
    survives("limits")?;

    // The server user's own helper may keep a value: the card says so.
    let (mut s, _) = open(credential_profile("cred-helper")).await?;
    s.ready().await?;
    s.run(
        "git config --global credential.helper store",
        "SET_END",
        |_| Card::Deny,
    )
    .await?;
    s.client.stop().await?;
    let (mut s, _) = open(credential_profile("cred-helper")).await?;
    s.ready().await?;
    let warned = s
        .run(
            &format!("{} >/dev/null 2>&1", fill("https")),
            "WARN_END",
            |_| Card::Deny,
        )
        .await?;
    assert_eq!(warned.cards.len(), 1);
    assert_eq!(warned.cards[0].server_helpers, ["store"]);
    s.run(
        "git config --global --unset credential.helper; rm -f ~/.git-credentials",
        "UNSET_END",
        |_| Card::Deny,
    )
    .await?;
    s.client.stop().await?;
    println!("PASS HTTPS credential: the card names the server user's own helper");
    survives("step 6")?;

    tmux(
        manager,
        store,
        &vault,
        paths,
        credential_profile("cred-tmux"),
        env("PASSWORD"),
    )
    .await?;
    println!("PASS HTTPS credential: tmux 3.3 new windows and panes, also after reattaching");
    survives("step 7")?;
    Ok(())
}

/// The start command puts the helper into the session for new windows and panes, on old tmux
/// without `new-session -e` too, and a reattach points them at the new connection. tmux redraws
/// its screen, so commands are typed into the tmux pane and the results are read from files
/// through a second, plain shell on the same server.
async fn tmux(
    manager: &Arc<Connections>,
    store: &Arc<Store>,
    vault: &Arc<Vault>,
    paths: &[PathBuf],
    mut profile: Profile,
    secret: String,
) -> Result<()> {
    let mut plain = profile.clone();
    plain.name = format!("{}-reader", profile.name);
    plain.forward_git_credentials = false;
    let plain = store.save(plain, None)?;
    profile.tmux_session = "dxcred".into();
    let profile = store.save(profile, None)?;
    let (mut reader, _) = Session::open(manager, store, vault, paths, plain, secret.clone())
        .await
        .map_err(failed("tmux-reader"))?;
    reader
        .client
        .send("stty -echo; printf '\\nREADER_READY\\n'\n")
        .await?;
    reader.client.marker("READER_READY\r\n").await?;
    let wait = |file: &str, tag: &str| {
        format!(
            "for i in $(seq 1 20); do [ -s {file} ] && break; sleep 0.5; done; printf '{tag}='; cat {file}; echo"
        )
    };
    let window = "printf '%s' \"$GIT_CONFIG_PARAMETERS\" > /tmp/dx-tmux-env";
    let filled = format!(
        "export GIT_SSL_NO_VERIFY=1; {} > /tmp/dx-tmux-fill 2>&1",
        fill("https")
    );
    reader
        .run(
            &format!(
                "{} && {}",
                upload("/tmp/dx-tmux.sh", window),
                upload("/tmp/dx-tmux-fill.sh", &filled)
            ),
            "UPLOAD_END",
            |_| Card::Deny,
        )
        .await?;
    let mut previous = String::new();
    for round in 0..2 {
        let (mut s, _) = Session::open(
            manager,
            store,
            vault,
            paths,
            profile.clone(),
            secret.clone(),
        )
        .await
        .map_err(failed("tmux-open"))?;
        assert!(s.path != previous && !s.path.is_empty());
        let expected = protocol::parameter(&s.path);
        pump(&mut s, Duration::from_secs(2), None).await?;
        let checks: &[(&str, &str)] = if round == 0 {
            &[
                (
                    "printf '%s' \"$GIT_CONFIG_PARAMETERS\" > /tmp/dx-tmux-env",
                    "the first pane of a new tmux server",
                ),
                ("tmux new-window -d 'sh /tmp/dx-tmux.sh'", "a new window"),
                ("tmux split-window -d 'sh /tmp/dx-tmux.sh'", "a split pane"),
            ]
        } else {
            &[
                (
                    "tmux new-window -d 'sh /tmp/dx-tmux.sh'",
                    "a new window after reattaching",
                ),
                (
                    "tmux split-window -d 'sh /tmp/dx-tmux.sh'",
                    "a split pane after reattaching",
                ),
            ]
        };
        for (n, (typed, what)) in checks.iter().enumerate() {
            reader
                .run("rm -f /tmp/dx-tmux-env", "CLEAR_END", |_| Card::Deny)
                .await?;
            s.client.send(&format!("{typed}\n")).await?;
            pump(&mut s, Duration::from_secs(1), None).await?;
            let tag = format!("ENV{round}{n}");
            let read = reader
                .run(&wait("/tmp/dx-tmux-env", &tag), "ENV_END", |_| Card::Deny)
                .await?;
            assert!(
                read.output.contains(&format!("{tag}={expected}")),
                "round {round}: {what} gets this connection's socket"
            );
        }
        reader
            .run("rm -f /tmp/dx-tmux-fill", "CLEAR_END", |_| Card::Deny)
            .await?;
        s.client
            .send("tmux new-window -d 'sh /tmp/dx-tmux-fill.sh'\n")
            .await?;
        let cards = pump(
            &mut s,
            Duration::from_secs(20),
            Some(Card::Typed(Decision::Once)),
        )
        .await?;
        assert_eq!(cards, 1, "round {round}: git in a new window asks once");
        let got = reader
            .run(
                "for i in $(seq 1 20); do grep -q '^username=' /tmp/dx-tmux-fill && break; sleep 0.5; done; \
                 grep -q '^username=probe$' /tmp/dx-tmux-fill && echo FILL_GOT_VALUE",
                "FILL_END",
                |_| Card::Deny,
            )
            .await?;
        assert!(
            got.output.contains("FILL_GOT_VALUE"),
            "round {round}: git in a new window got the value"
        );
        previous = s.path.clone();
        s.client.stop().await.map_err(failed("tmux-stop"))?;
    }
    reader
        .run(
            "tmux kill-session -t dxcred; rm -f /tmp/dx-tmux-env /tmp/dx-tmux-fill",
            "KILL_END",
            |_| Card::Deny,
        )
        .await?;
    reader.client.stop().await?;
    Ok(())
}

/// Lets a tmux connection's output flow for `wait` and answers its cards with `card`. With a
/// card it returns after the first one; without, a card is a failure.
async fn pump(s: &mut Session, wait: Duration, card: Option<Card>) -> Result<usize> {
    let until = std::time::Instant::now() + wait;
    let mut cards = 0;
    while let Some(left) = until.checked_duration_since(std::time::Instant::now()) {
        let Ok(event) = timeout(left, s.client.event()).await else {
            break;
        };
        match event.map_err(failed("tmux-pump"))? {
            Event::GitCredential(request) => {
                let card = card.ok_or("an unexpected card")?;
                s.answer(&request, card).await?;
                cards += 1;
                break;
            }
            Event::State { status, message } if status == "error" => return Err(message.into()),
            _ => {}
        }
        s.client.bytes.clear();
    }
    Ok(cards)
}

/// Older and newer git and tmux (DX.12.0's images except Debian 12): a typed value pushes, no
/// daemon starts, and tmux's new windows get the helper.
pub async fn versions(
    manager: &Arc<Connections>,
    store: &Arc<Store>,
    paths: &[PathBuf],
) -> Result<()> {
    let Ok(servers) = std::env::var("DACHSTERM_PROBE_GIT_SERVERS") else {
        return Ok(());
    };
    let vault = Arc::new(Vault::default());
    for server in servers.split(',') {
        let mut parts = server.splitn(3, ':');
        let (label, port, password) = (
            parts.next().ok_or("server label")?,
            parts.next().ok_or("server port")?.parse()?,
            parts.next().ok_or("server password")?.to_string(),
        );
        eprintln!("HTTPS credential versions: {label}");
        let mut profile = credential_profile(&format!("cred-{label}"));
        profile.port = port;
        profile.timeout = 30;
        let profile = store.save(profile, None)?;
        let (mut s, notices) = Session::open(
            manager,
            store,
            &vault,
            paths,
            profile.clone(),
            password.clone(),
        )
        .await
        .map_err(failed("versions-open"))?;
        assert!(notices.is_empty(), "{label}: forwarding allowed");
        assert!(
            s.path.starts_with("/tmp/dachsterm-git-"),
            "{label}: no runtime folder"
        );
        s.ready().await.map_err(failed("versions-ready"))?;
        let version = s
            .run("git --version; tmux -V", "VERSION_END", |_| Card::Deny)
            .await?;
        let repo = format!("dx-{label}");
        let pushed = s
            .run(&first_push(&repo), "PUSH_END", |_| {
                Card::Typed(Decision::Once)
            })
            .await?;
        assert_eq!(pushed.exit("PUSH_END"), Some(0), "{label}: push");
        assert_eq!(pushed.cards.len(), 1, "{label}: one card");
        let daemon = s.run(NO_DAEMON, "DAEMON_END", |_| Card::Deny).await?;
        assert!(daemon.output.contains("DAEMON_NONE"), "{label}: no daemon");
        s.client.stop().await.map_err(failed("versions-stop"))?;
        tmux(manager, store, &vault, paths, profile, password).await?;
        let versions: Vec<&str> = version
            .output
            .lines()
            .filter_map(|l| {
                let at = l.find("git version").or_else(|| l.find("tmux "))?;
                Some(l[at..].trim_end())
            })
            .collect();
        println!(
            "PASS HTTPS credential on {label} ({}): push, no daemon, tmux windows",
            versions.join(", ")
        );
    }
    Ok(())
}
