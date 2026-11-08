//! The built-in agent (DX.11) against the real OpenSSH fixture. Key files are the fixture's
//! per-run keys written to the probe's temporary folder; this PC's agent and keys are never used.
//! "No system agent" points the agent path at a pipe or socket that does not exist.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use dachsterm::{
    agent_keys::{Ask, Reply, Source},
    storage::ForwardKey,
};
use std::path::Path;

enum Say {
    Plain(Decision),
    /// Allow, then type a wrong and the right Passphrase on the card.
    Unlock(Decision),
}

/// Like `run_answering`, but answers locked keys with the Passphrase and collects notices.
async fn run_with(
    c: &mut Client,
    script: &str,
    end: &str,
    mut decide: impl FnMut(&SignRequest) -> Say,
) -> Result<(String, Vec<SignRequest>, Vec<String>)> {
    c.send(&format!("{script}; printf '%s {end}\\n' $?\n"))
        .await?;
    let marker = format!(" {end}\r\n");
    let (mut asked, mut notices) = (Vec::new(), Vec::new());
    loop {
        if String::from_utf8_lossy(&c.bytes).contains(&marker) {
            let output = String::from_utf8_lossy(&c.bytes).into_owned();
            c.bytes.clear();
            return Ok((output, asked, notices));
        }
        match c.event().await? {
            Event::AgentSign(request) => {
                let agent = c.manager.control(&c.id)?.agent.clone();
                let id = request.request.clone();
                match decide(&request) {
                    Say::Plain(decision) => agent.reply(&id, decision)?,
                    Say::Unlock(decision) => {
                        assert!(request.passphrase, "a locked key asks for its Passphrase");
                        let needed = Reply::Passphrase {
                            reason: Ask::Needed,
                        };
                        assert_eq!(agent.answer(&id, decision, None).await?, needed);
                        let wrong = Some(Zeroizing::new(uuid::Uuid::new_v4().to_string()));
                        assert_eq!(
                            agent.answer(&id, decision, wrong).await?,
                            Reply::Passphrase { reason: Ask::Wrong }
                        );
                        let right = Some(Zeroizing::new(env("PASSPHRASE")));
                        assert_eq!(
                            agent.answer(&id, decision, right).await?,
                            Reply::Done { notice: None }
                        );
                    }
                }
                asked.push(request);
            }
            Event::AgentNotice { message } => notices.push(message),
            Event::State { status, message } if status == "error" => return Err(message.into()),
            _ => {}
        }
    }
}

fn public(name: &str) -> Result<russh::keys::PublicKey> {
    Ok(PrivateKey::from_openssh(env(name))?.public_key().clone())
}
fn fingerprint(name: &str) -> Result<String> {
    Ok(public(name)?.fingerprint(HashAlg::Sha256).to_string())
}
fn write_key(dir: &Path, file: &str, name: &str) -> Result<String> {
    let path = dir.join(file);
    std::fs::write(&path, env(name))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Points this process's agent path at nothing, as on a PC whose agent service is off.
struct NoSystemAgent(&'static str, Option<std::ffi::OsString>);
impl NoSystemAgent {
    fn new() -> Self {
        let (name, missing) = if cfg!(windows) {
            let pipe = format!(r"\\.\pipe\dachsterm-agent-{}-off", uuid::Uuid::new_v4());
            ("DACHSTERM_TEST_AGENT_PIPE", pipe)
        } else {
            let socket = format!("/tmp/dachsterm-agent-{}-off.sock", uuid::Uuid::new_v4());
            ("SSH_AUTH_SOCK", socket)
        };
        let saved = std::env::var_os(name);
        // SAFETY: the probe changes its environment only here, between connections. The app code
        // reads the variable when an agent channel opens, on the same tasks this probe awaits.
        unsafe { std::env::set_var(name, missing) };
        Self(name, saved)
    }
}
impl Drop for NoSystemAgent {
    fn drop(&mut self) {
        // SAFETY: as in `new`.
        unsafe {
            match &self.1 {
                Some(value) => std::env::set_var(self.0, value),
                None => std::env::remove_var(self.0),
            }
        }
    }
}

/// Asks the forwarded agent directly, as an old client would, and prints what it answered.
const RSA_ASK: &str = r#"import os, socket, struct, base64
def s(b): return struct.pack('>I', len(b)) + b
blob = base64.b64decode(open(os.path.expanduser('~/.ssh/dx11_rsa.pub')).read().split()[1])
def ask(flags):
    c = socket.socket(socket.AF_UNIX); c.connect(os.environ['SSH_AUTH_SOCK'])
    m = bytes([13]) + s(blob) + s(b'dx11 data') + struct.pack('>I', flags)
    c.sendall(s(m)); n = struct.unpack('>I', c.recv(4))[0]; r = b''
    while len(r) < n: r += c.recv(n - len(r))
    if r[0] != 14: return 'FAILURE'
    return r[9:9 + struct.unpack('>I', r[5:9])[0]].decode()
print('RSA_FLAGS', ask(0), ask(2), ask(4), ask(0))
"#;

pub async fn run(
    manager: &Arc<Connections>,
    store: &Arc<Store>,
    paths: &[PathBuf],
    dir: &Path,
) -> Result<()> {
    let login = write_key(dir, "dx11-login", "PLAIN_KEY")?;
    let git = write_key(dir, "dx11-git", "ENCRYPTED_KEY")?;
    let rsa = write_key(dir, "dx11-rsa", "RSA_KEY")?;
    let (login_fp, git_fp, rsa_fp) = (
        fingerprint("PLAIN_KEY")?,
        fingerprint("ENCRYPTED_KEY")?,
        fingerprint("RSA_KEY")?,
    );
    let never = |_: &SignRequest| -> Say { panic!("listing must not ask") };
    let forward = |path: &str| ForwardKey {
        path: path.into(),
        secret_ref: None,
    };

    let off = NoSystemAgent::new();
    let mut profile = base();
    profile.name = "builtin-agent".into();
    profile.auth = "key".into();
    profile.key_path = login.clone();
    profile.forward_agent = true;
    profile.forward_keys = vec![forward(&git), forward(&rsa)];
    let profile = store.save(profile, None)?;
    let mut c = begin(manager, store, paths, profile, String::new())?;
    assert_eq!(connect(&mut c).await?, None);
    c.send("stty -echo; printf '\\nBUILTIN_READY\\n'\n").await?;
    c.marker("BUILTIN_READY\r\n").await?;
    let (listed, _, notices) = run_with(&mut c, "ssh-add -l", "LIST_END", never).await?;
    assert_eq!(exit_code(&listed, "LIST_END"), Some(0));
    for fp in [&login_fp, &git_fp, &rsa_fp] {
        assert!(
            listed.contains(fp.as_str()),
            "the app's keys without a system agent"
        );
    }
    assert!(
        notices.is_empty(),
        "a missing system agent is skipped quietly"
    );
    let (removed, _, _) = run_with(&mut c, "ssh-add -D", "REMOVE_END", never).await?;
    assert_ne!(exit_code(&removed, "REMOVE_END"), Some(0));
    let (still, _, _) = run_with(&mut c, "ssh-add -l", "LIST_END", never).await?;
    assert!(
        [&login_fp, &git_fp, &rsa_fp]
            .iter()
            .all(|fp| still.contains(fp.as_str()))
    );
    println!("PASS built-in agent: login key and a Git-only key listed with no system agent");
    println!("PASS built-in agent: ssh-add -D cannot remove the app's keys");

    for (file, name) in [
        ("dx11_git.pub", "ENCRYPTED_KEY"),
        ("dx11_rsa.pub", "RSA_KEY"),
    ] {
        let line = public(name)?.to_openssh()?;
        let (wrote, _, _) = run_with(
            &mut c,
            &format!("mkdir -p ~/.ssh && printf '%s\\n' '{line}' > ~/.ssh/{file}"),
            "PUB_END",
            never,
        )
        .await?;
        assert_eq!(exit_code(&wrote, "PUB_END"), Some(0));
    }
    let setup = "rm -rf ~/dx11-remote.git ~/dx11-work && git init -q --bare ~/dx11-remote.git && \
         git init -q ~/dx11-work && cd ~/dx11-work && git config user.email p@example.invalid && \
         git config user.name probe";
    let (ready, _, _) = run_with(&mut c, setup, "SETUP_END", never).await?;
    assert_eq!(exit_code(&ready, "SETUP_END"), Some(0));
    // Only the chosen key may sign in, as a Git host that knows the Git key and not the login one.
    let push = |n: u32, key: &str| {
        format!(
            "echo {n} > f && git add f && git commit -qm c{n} && \
             GIT_SSH_COMMAND='{SSH} -o IdentitiesOnly=yes -i ~/.ssh/{key}' \
             git push -q ssh://probe@127.0.0.1/home/probe/dx11-remote.git HEAD:refs/heads/main"
        )
    };
    let remote =
        "test \"$(git rev-parse HEAD)\" = \"$(git --git-dir ~/dx11-remote.git rev-parse main)\"";
    let unlock_once = |_: &SignRequest| Say::Unlock(Decision::Once);
    let (pushed, asked, _) =
        run_with(&mut c, &push(1, "dx11_git.pub"), "PUSH_END", unlock_once).await?;
    assert_eq!(exit_code(&pushed, "PUSH_END"), Some(0), "approved push");
    assert_eq!(asked[0].fingerprint, git_fp);
    assert_eq!(asked[0].source, Source::App);
    assert_eq!(asked[0].seconds, 120);
    assert_eq!(
        asked[0].key, "dx11-git",
        "a key without a comment is named by its file"
    );
    let (same, _, _) = run_with(&mut c, remote, "SAME_END", never).await?;
    assert_eq!(exit_code(&same, "SAME_END"), Some(0));
    println!("PASS Git-only key: Passphrase on the card, approved push reaches the remote");

    let deny = |r: &SignRequest| {
        assert!(r.passphrase, "the key was dropped after the last signature");
        Say::Plain(Decision::Deny)
    };
    let (denied, asked, _) = run_with(&mut c, &push(2, "dx11_git.pub"), "PUSH_END", deny).await?;
    assert_ne!(
        exit_code(&denied, "PUSH_END"),
        Some(0),
        "a refused push fails"
    );
    assert!(!asked.is_empty());
    let (behind, _, _) = run_with(&mut c, remote, "SAME_END", never).await?;
    assert_ne!(
        exit_code(&behind, "SAME_END"),
        Some(0),
        "the remote must not move"
    );
    println!("PASS Git-only key: refusal fails the push and the remote is unchanged");

    let unlock_for = |_: &SignRequest| Say::Unlock(Decision::Connection);
    let (pushed, _, _) = run_with(&mut c, &push(3, "dx11_git.pub"), "PUSH_END", unlock_for).await?;
    assert_eq!(exit_code(&pushed, "PUSH_END"), Some(0));
    let (pushed, asked, _) = run_with(&mut c, &push(4, "dx11_git.pub"), "PUSH_END", never).await?;
    assert_eq!(exit_code(&pushed, "PUSH_END"), Some(0));
    assert!(asked.is_empty(), "unlocked for the allowed ten minutes");
    println!("PASS allowing for 10 minutes keeps the unlocked key and signs without asking");

    // The fixture's OpenSSH accepts only SHA-2 RSA signatures (no ssh-rsa), so this push proves
    // the app signed rsa-sha2. The probe script asks directly with each flag.
    let (pushed, _, _) = run_with(&mut c, &push(5, "dx11_rsa.pub"), "PUSH_END", never).await?;
    assert_eq!(exit_code(&pushed, "PUSH_END"), Some(0), "RSA push");
    let script = format!(
        "echo {} | base64 -d > /tmp/dx11-ask.py && python3 /tmp/dx11-ask.py",
        STANDARD.encode(RSA_ASK)
    );
    let (flags, asked, notices) = run_with(&mut c, &script, "ASK_END", never).await?;
    assert!(
        flags.contains("RSA_FLAGS FAILURE rsa-sha2-256 rsa-sha2-512 FAILURE"),
        "SHA-1 is refused, SHA-2 follows the flag"
    );
    assert!(asked.is_empty());
    assert_eq!(notices.len(), 1, "one SHA-1 notice per connection");
    assert!(notices[0].contains("SHA-1"));
    c.stop().await?;
    println!("PASS RSA signs rsa-sha2-256/512 by flag, SHA-1 requests are refused with one notice");

    // No app key and no system agent: nothing to forward, and the user is told how to fix it.
    let mut bare = base();
    bare.name = "builtin-none".into();
    bare.auth = "key".into();
    bare.key_path = login.clone();
    bare.forward_agent = true;
    bare.forward_login_key = false;
    let bare = store.save(bare, None)?;
    let mut c = begin(manager, store, paths, bare, String::new())?;
    assert_eq!(connect(&mut c).await?, None);
    c.send("stty -echo; printf '\\nNONE_READY\\n'\n").await?;
    c.marker("NONE_READY\r\n").await?;
    let (listed, _, notices) = run_with(&mut c, "ssh-add -l", "LIST_END", never).await?;
    assert_ne!(exit_code(&listed, "LIST_END"), Some(0));
    assert!(
        !listed.contains(&login_fp),
        "the login key is not offered when turned off"
    );
    assert_eq!(notices.len(), 1);
    assert!(notices[0].starts_with("전달할 키가 없습니다."));
    c.stop().await?;
    drop(off);
    println!("PASS no key to forward: the channel is refused with the setup notice");

    // With this PC's agent (the fixture's, holding the RSA key) the same key is listed once.
    let mut merged = base();
    merged.name = "builtin-merge".into();
    merged.forward_agent = true;
    merged.forward_keys = vec![forward(&rsa), forward(&git)];
    let merged = store.save(merged, None)?;
    let mut c = begin(manager, store, paths, merged, env("PASSWORD"))?;
    assert_eq!(connect(&mut c).await?, None);
    c.send("stty -echo; printf '\\nMERGE_READY\\n'\n").await?;
    c.marker("MERGE_READY\r\n").await?;
    let (listed, _, _) = run_with(&mut c, "ssh-add -l", "LIST_END", never).await?;
    assert_eq!(listed.matches(rsa_fp.as_str()).count(), 1, "no duplicate");
    assert_eq!(
        listed.matches("SHA256:").count(),
        2,
        "the RSA key and the Git key"
    );
    let (_, _, _) = run_with(&mut c, "cd ~/dx11-work", "CD_END", never).await?;
    let app_signs = |r: &SignRequest| {
        assert_eq!(r.source, Source::App, "a key in both places is the app's");
        Say::Plain(Decision::Once)
    };
    let (pushed, asked, _) =
        run_with(&mut c, &push(6, "dx11_rsa.pub"), "PUSH_END", app_signs).await?;
    assert_eq!(exit_code(&pushed, "PUSH_END"), Some(0));
    assert!(!asked.is_empty());
    c.stop().await?;
    println!("PASS with this PC's agent the keys merge without duplicates, the app's copy signs");
    Ok(())
}
