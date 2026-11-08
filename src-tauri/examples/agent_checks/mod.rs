//! Agent forwarding against the real OpenSSH fixture: listing, the filter, approval, a real
//! `git push`, a jump route, and refusal on connections that did not ask. The local agent is the
//! fixture's own agent behind an isolated pipe or socket, so no key on this PC is used.
use super::*;
pub mod builtin;
use dachsterm::agent_forward::{Decision, SignRequest};
use russh::{
    ChannelMsg,
    keys::{HashAlg, PrivateKey, PublicKey},
};

const SSH: &str = "ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o BatchMode=yes -o LogLevel=ERROR";

fn key_fingerprint(name: &str) -> Result<String> {
    Ok(PublicKey::from_openssh(&env(name))?
        .fingerprint(HashAlg::Sha256)
        .to_string())
}

/// Runs one command and answers every sign request with `decide` until its end marker arrives.
async fn run_answering(
    c: &mut Client,
    script: &str,
    end: &str,
    mut decide: impl FnMut(&SignRequest) -> Decision,
) -> Result<(String, Vec<SignRequest>)> {
    c.send(&format!("{script}; printf '%s {end}\\n' $?\n"))
        .await?;
    let marker = format!(" {end}\r\n");
    let mut asked = Vec::new();
    loop {
        if String::from_utf8_lossy(&c.bytes).contains(&marker) {
            let output = String::from_utf8_lossy(&c.bytes).into_owned();
            c.bytes.clear();
            return Ok((output, asked));
        }
        match c.event().await? {
            Event::AgentSign(request) => {
                let decision = decide(&request);
                c.manager
                    .control(&c.id)?
                    .agent
                    .reply(&request.request, decision)?;
                asked.push(request);
            }
            Event::AgentNotice { message } => return Err(message.into()),
            Event::State { status, message } if status == "error" => return Err(message.into()),
            _ => {}
        }
    }
}

fn exit_code(output: &str, end: &str) -> Option<i32> {
    let line = output.lines().find(|l| l.trim_end().ends_with(end))?;
    line.split_whitespace().next()?.parse().ok()
}

/// Connects and records whether the server refused forwarding, without hiding other events.
async fn connect(c: &mut Client) -> Result<Option<String>> {
    let mut notice = None;
    loop {
        match c.event().await? {
            Event::HostKey { fingerprint, .. } => {
                assert!(
                    [
                        key_fingerprint("HOST_KEY")?,
                        key_fingerprint("RSA_HOST_KEY")?
                    ]
                    .contains(&fingerprint)
                );
                c.manager.control(&c.id)?.trust.send(Some(true))?;
            }
            Event::AgentNotice { message } => notice = Some(message),
            Event::State { status, message } if status == "error" => return Err(message.into()),
            Event::State { status, .. } if status == "connected" => return Ok(notice),
            _ => {}
        }
    }
}

pub async fn run(manager: &Arc<Connections>, store: &Arc<Store>, paths: &[PathBuf]) -> Result<()> {
    let mine = PrivateKey::from_openssh(env("RSA_KEY"))?
        .public_key()
        .fingerprint(HashAlg::Sha256)
        .to_string();
    let hosts = [
        key_fingerprint("HOST_KEY")?,
        key_fingerprint("RSA_HOST_KEY")?,
    ];
    let mut on = base();
    on.name = "agent-forward".into();
    on.forward_agent = true;
    let on = store.save(on, None)?;
    let mut c = begin(manager, store, paths, on.clone(), env("PASSWORD"))?;
    assert_eq!(
        connect(&mut c).await?,
        None,
        "the fixture allows forwarding"
    );
    c.send("stty -echo; printf '\\nAGENT_READY\\n'\n").await?;
    c.marker("AGENT_READY\r\n").await?;
    let never = |_: &SignRequest| -> Decision { panic!("listing must not ask") };

    let (listed, _) = run_answering(&mut c, "ssh-add -l", "LIST_END", never).await?;
    assert!(listed.contains(&mine), "the server must see the local key");
    assert_eq!(exit_code(&listed, "LIST_END"), Some(0));
    let (removed, _) = run_answering(&mut c, "ssh-add -D", "REMOVE_END", never).await?;
    assert_ne!(
        exit_code(&removed, "REMOVE_END"),
        Some(0),
        "removal must fail"
    );
    let (still, _) = run_answering(&mut c, "ssh-add -l", "LIST_END", never).await?;
    assert!(
        still.contains(&mine),
        "the server must not remove local keys"
    );
    println!("PASS agent forwarding: server lists the local key, ssh-add -D cannot remove it");

    let setup = format!(
        "rm -rf ~/dx-remote.git ~/dx-work && git init -q --bare ~/dx-remote.git && \
         git init -q ~/dx-work && cd ~/dx-work && git config user.email p@example.invalid && \
         git config user.name probe && export GIT_SSH_COMMAND='{SSH}'"
    );
    let (ready, _) = run_answering(&mut c, &setup, "SETUP_END", never).await?;
    assert_eq!(exit_code(&ready, "SETUP_END"), Some(0));
    let push = |n: u32| {
        format!(
            "echo {n} > f && git add f && git commit -qm c{n} && \
             git push -q ssh://probe@127.0.0.1/home/probe/dx-remote.git HEAD:refs/heads/main"
        )
    };
    let remote =
        "test \"$(git rev-parse HEAD)\" = \"$(git --git-dir ~/dx-remote.git rev-parse main)\"";

    let (pushed, asked) = run_answering(&mut c, &push(1), "PUSH_END", |_| Decision::Once).await?;
    assert_eq!(
        exit_code(&pushed, "PUSH_END"),
        Some(0),
        "an approved push succeeds"
    );
    assert!(!asked.is_empty(), "a push must ask first");
    let request = &asked[0];
    assert_eq!(request.fingerprint, mine);
    assert_eq!(request.login_user.as_deref(), Some("probe"));
    assert_eq!(request.session, "agent-forward");
    assert!(!request.key.is_empty(), "the local key comment");
    assert!(request.host_key.as_ref().is_some_and(|k| hosts.contains(k)));
    assert_eq!(request.seconds, 60);
    let (same, _) = run_answering(&mut c, remote, "SAME_END", never).await?;
    assert_eq!(exit_code(&same, "SAME_END"), Some(0));
    println!("PASS approved signature: real git push, key, user and session-bind host shown");

    let (denied, asked) = run_answering(&mut c, &push(2), "PUSH_END", |_| Decision::Deny).await?;
    assert_ne!(
        exit_code(&denied, "PUSH_END"),
        Some(0),
        "a refused push fails"
    );
    assert!(!asked.is_empty());
    let (behind, _) = run_answering(&mut c, remote, "SAME_END", never).await?;
    assert_ne!(
        exit_code(&behind, "SAME_END"),
        Some(0),
        "the remote must not move"
    );
    println!("PASS refused signature: git push fails and the remote is unchanged");

    let (pushed, _) = run_answering(&mut c, &push(3), "PUSH_END", |_| Decision::Connection).await?;
    assert_eq!(exit_code(&pushed, "PUSH_END"), Some(0));
    let (pushed, asked) = run_answering(&mut c, &push(4), "PUSH_END", never).await?;
    assert_eq!(exit_code(&pushed, "PUSH_END"), Some(0));
    assert!(asked.is_empty());
    println!("PASS allowing for this connection signs again without asking");
    c.stop().await?;

    let mut off = base();
    off.name = "agent-off".into();
    let off = store.save(off, None)?;
    let mut c = begin(manager, store, paths, off, env("PASSWORD"))?;
    assert_eq!(connect(&mut c).await?, None);
    c.send("stty -echo; printf '\\nOFF_READY\\n'\n").await?;
    c.marker("OFF_READY\r\n").await?;
    let (listed, _) = run_answering(&mut c, "ssh-add -l", "LIST_END", never).await?;
    assert!(!listed.contains(&mine));
    assert_ne!(exit_code(&listed, "LIST_END"), Some(0));
    // The server is made to open an agent channel on this connection: it must be refused.
    let handle = manager.handle(&c.id)?;
    let mut channel = handle.channel_open_session().await?;
    channel.agent_forward(true).await?;
    channel
        .exec(true, "ssh-add -l; printf 'RC=%s\\n' $?")
        .await?;
    let mut forced = Vec::new();
    timeout(Duration::from_secs(20), async {
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    forced.extend_from_slice(&data)
                }
                ChannelMsg::Close => break,
                _ => {}
            }
        }
    })
    .await?;
    let forced = String::from_utf8_lossy(&forced);
    assert!(
        !forced.contains(&mine),
        "an unrequested agent channel must be refused"
    );
    assert!(forced.contains("RC=") && !forced.contains("RC=0"));
    c.stop().await?;
    println!("PASS option off: no agent, and a server-opened agent channel is refused");

    // The jump host has the option on in its own profile and must still never get the agent.
    let mut hop = base();
    hop.name = "agent-hop".into();
    hop.forward_agent = true;
    let hop = store.save(hop, None)?;
    let mut target = base();
    target.name = "agent-final".into();
    target.port = 22;
    target.forward_agent = true;
    target.jump_ids = vec![hop.id.clone()];
    let target = store.save(target, None)?;
    let mut c = jump_checks::routed(
        manager,
        store,
        paths,
        target,
        vec![(hop, Some(Zeroizing::new(env("PASSWORD"))))],
        env("PASSWORD"),
    )?;
    assert_eq!(connect(&mut c).await?, None);
    c.send("stty -echo; printf '\\nJUMP_READY\\n'\n").await?;
    c.marker("JUMP_READY\r\n").await?;
    let (listed, _) = run_answering(&mut c, "ssh-add -l", "LIST_END", never).await?;
    assert!(
        listed.contains(&mine),
        "the final server gets the agent through a jump host"
    );
    c.stop().await?;
    println!("PASS jump route forwards the agent to the final server only");
    Ok(())
}

/// The refusing server (`AllowAgentForwarding no`) is the MFA fixture; see `phase1_probe`.
pub fn refused(notice: Option<&str>) -> bool {
    notice.is_some_and(|m| m.contains("허용하지 않아"))
}
