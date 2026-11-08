use super::*;
use crate::{
    agent_forward::{Decision, SignRequest},
    ssh::Event,
    ssh_keys::{self, tests::generate},
};
use russh::keys::{signature::Verifier, ssh_key::Signature};
use std::sync::Mutex;
use tokio::io::{DuplexStream, duplex};

const LIST: u8 = 11;
const ANSWER: u8 = 12;
const SIGN: u8 = 13;
const SIGNED: u8 = 14;
const FAILURE: u8 = 5;

fn string(out: &mut Vec<u8>, value: &[u8]) {
    out.extend_from_slice(&(value.len() as u32).to_be_bytes());
    out.extend_from_slice(value);
}
fn sign_body(blob: &[u8], data: &[u8]) -> Vec<u8> {
    let mut body = vec![SIGN];
    string(&mut body, blob);
    string(&mut body, data);
    body.extend_from_slice(&0u32.to_be_bytes());
    body
}
async fn ask(client: &mut DuplexStream, body: &[u8]) -> Vec<u8> {
    client.write_all(&agent_filter::frame(body)).await.unwrap();
    let mut header = [0; 4];
    client.read_exact(&mut header).await.unwrap();
    let mut answer = vec![0; u32::from_be_bytes(header) as usize];
    client.read_exact(&mut answer).await.unwrap();
    answer
}

type Seen = Arc<Mutex<Vec<SignRequest>>>;
fn context(keys: Vec<ForwardKey>) -> (Context, Seen) {
    let seen: Seen = Arc::default();
    let sink = seen.clone();
    let events: Sink = Arc::new(move |event| {
        if let Event::AgentSign(request) = event {
            sink.lock().unwrap().push(request);
        }
        Ok(())
    });
    let context = Context {
        agent: Arc::default(),
        events: Arc::new(Direct(events)),
        name: "Windows PowerShell".into(),
        keys,
    };
    (context, seen)
}
/// The tab's side of one client, with an optional stand-in for this PC's agent.
fn serve(context: Context, system: Option<agent_relay::LocalStream>) -> DuplexStream {
    let (client, mut server) = duplex(64 * 1024);
    let (_, stop) = watch::channel(false);
    let mut relay = relay(context, system, stop);
    tokio::spawn(async move { run(&mut relay, &mut server).await });
    client
}
async fn card(seen: &Seen) -> SignRequest {
    loop {
        if let Some(request) = seen.lock().unwrap().first().cloned() {
            return request;
        }
        tokio::task::yield_now().await;
    }
}

#[tokio::test]
async fn an_app_key_signs_only_after_the_tab_card_allows_it() {
    let dir = tempfile::tempdir().unwrap();
    let path = generate(dir.path(), "git", &["-t", "ed25519"], "");
    let key = ssh_keys::load(&path, "").unwrap();
    let blob = key.public_key().to_bytes().unwrap();
    let (context, seen) = context(vec![ForwardKey {
        path,
        secret_ref: None,
    }]);
    let agent = context.agent.clone();
    let mut client = serve(context, None);
    let list = ask(&mut client, &[LIST]).await;
    assert_eq!(list[0], ANSWER);
    assert_eq!(agent_filter::identities(&list).len(), 1);

    let data = b"session-id and userauth request";
    let waiting = tokio::spawn(async move {
        let answer = ask(&mut client, &sign_body(&blob, data)).await;
        (answer, client)
    });
    let request = card(&seen).await;
    assert!(request.local, "the card names the tab");
    assert_eq!(request.session, "Windows PowerShell");
    agent.reply(&request.request, Decision::Once).unwrap();
    let (answer, mut client) = waiting.await.unwrap();
    assert_eq!(answer[0], SIGNED);
    let signature = Signature::try_from(&answer[5..]).unwrap();
    Verifier::verify(key.public_key(), data, &signature).unwrap();

    seen.lock().unwrap().clear();
    let blob = key.public_key().to_bytes().unwrap();
    let waiting = tokio::spawn(async move { ask(&mut client, &sign_body(&blob, data)).await });
    let request = card(&seen).await;
    agent.reply(&request.request, Decision::Deny).unwrap();
    assert_eq!(waiting.await.unwrap(), [FAILURE], "refused");
}

#[tokio::test]
async fn keys_cannot_be_added_removed_or_locked_from_the_tab() {
    let (context, _) = context(vec![]);
    let mut client = serve(context, None);
    // Add, remove all, the old RSA remove all (`ssh-add -D` sends both), lock.
    for kind in [17, 19, 9, 22] {
        assert_eq!(ask(&mut client, &[kind]).await, [FAILURE], "{kind}");
    }
    let list = ask(&mut client, &[LIST]).await;
    assert!(agent_filter::identities(&list).is_empty(), "no keys yet");
    client.write_all(&[0xff; 4]).await.unwrap();
    let mut rest = Vec::new();
    client.read_to_end(&mut rest).await.unwrap();
    assert!(rest.is_empty(), "a bad frame closes the client");
}

/// This PC's agent: one key it signs itself.
async fn system_agent(mut stream: DuplexStream, blob: Vec<u8>) {
    let mut buffer = Vec::new();
    let mut chunk = [0; 4096];
    loop {
        while let Ok(Some(body)) = agent_filter::take_frame(&mut buffer) {
            let answer = match body[0] {
                LIST => {
                    let mut out = vec![ANSWER, 0, 0, 0, 1];
                    string(&mut out, &blob);
                    string(&mut out, b"system key");
                    out
                }
                SIGN => {
                    let mut out = vec![SIGNED];
                    string(&mut out, b"signed by the system agent");
                    out
                }
                _ => vec![FAILURE],
            };
            stream
                .write_all(&agent_filter::frame(&answer))
                .await
                .unwrap();
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => buffer.extend_from_slice(&chunk[..n]),
        }
    }
}

#[tokio::test]
async fn a_system_agent_key_passes_without_a_card() {
    let dir = tempfile::tempdir().unwrap();
    let path = generate(dir.path(), "system", &["-t", "ed25519"], "");
    let blob = ssh_keys::load(&path, "")
        .unwrap()
        .public_key()
        .to_bytes()
        .unwrap();
    let (theirs, ours) = duplex(64 * 1024);
    tokio::spawn(system_agent(theirs, blob.clone()));
    let (context, seen) = context(vec![]);
    let mut client = serve(context, Some(Box::new(ours)));
    let list = ask(&mut client, &[LIST]).await;
    assert_eq!(
        agent_filter::identities(&list),
        [(blob.clone(), "system key".to_string())]
    );
    let answer = ask(&mut client, &sign_body(&blob, b"data")).await;
    let mut expected = vec![SIGNED];
    string(&mut expected, b"signed by the system agent");
    assert_eq!(answer, expected);
    assert!(seen.lock().unwrap().is_empty(), "no card");
}

fn enabled_store(dir: &std::path::Path) -> Arc<Store> {
    let store = Store::open(&dir.join("test.db")).unwrap();
    store.save_local_agent(true, vec![]).unwrap();
    Arc::new(store)
}
fn quiet() -> Sink {
    Arc::new(|_| Ok(()))
}

#[tokio::test]
async fn nothing_is_opened_while_the_setting_is_off() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("test.db")).unwrap());
    let target = Target::for_test("powershell", "shell");
    assert!(start(store, &target, quiet()).await.unwrap().is_none());
}

#[cfg(windows)]
mod windows {
    use super::*;
    use tokio::net::windows::named_pipe::ClientOptions;

    fn user(ssh: Option<&str>, git_ssh: bool, wslenv: Option<&str>) -> UserEnv {
        UserEnv {
            git_ssh,
            wslenv: wslenv.map(Into::into),
            system_ssh: ssh.map(Into::into),
        }
    }
    fn pairs(env: &[(String, String)]) -> Vec<(&str, &str)> {
        env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
    }
    const SSH: &str = r"C:\WINDOWS\System32\OpenSSH\ssh.exe";
    const PIPE: &str = r"\\.\pipe\dachsterm-agent-x";

    #[test]
    fn a_windows_shell_gets_the_pipe_and_the_system_ssh_for_git() {
        let shell = Target::for_test("powershell", "shell");
        assert_eq!(
            pairs(&shell_env(&shell, PIPE, &user(Some(SSH), false, None))),
            [("SSH_AUTH_SOCK", PIPE), ("GIT_SSH", SSH)]
        );
        assert_eq!(
            pairs(&shell_env(&shell, PIPE, &user(Some(SSH), true, None))),
            [("SSH_AUTH_SOCK", PIPE)],
            "the user's own GIT_SSH stays"
        );
        assert_eq!(
            pairs(&shell_env(&shell, PIPE, &user(None, false, None))),
            [("SSH_AUTH_SOCK", PIPE)],
            "no system ssh.exe"
        );
    }

    #[test]
    fn wsl_keeps_the_pipe_out_of_linux_and_translates_git_ssh() {
        let mut wsl = Target::for_test("wsl:Ubuntu", "wsl");
        wsl.env = vec![("WSLENV".into(), "USERPROFILE/p:PROMPT_COMMAND/u".into())];
        let env = shell_env(&wsl, PIPE, &user(Some(SSH), true, Some("ignored")));
        assert_eq!(
            pairs(&env),
            [
                ("SSH_AUTH_SOCK", PIPE),
                ("GIT_SSH", SSH),
                ("WSLENV", "USERPROFILE/p:PROMPT_COMMAND/u:GIT_SSH/up"),
            ]
        );
        let plain = Target::for_test("wsl:Ubuntu", "wsl");
        assert_eq!(
            pairs(&shell_env(&plain, PIPE, &user(Some(SSH), false, None)))[2],
            ("WSLENV", "GIT_SSH/up")
        );
        wsl.env = vec![("WSLENV".into(), "GIT_SSH/p".into())];
        assert_eq!(
            pairs(&shell_env(&wsl, PIPE, &user(Some(SSH), false, None))),
            [("SSH_AUTH_SOCK", PIPE)],
            "the user already passes their own GIT_SSH"
        );
    }

    async fn gone(name: &str) -> bool {
        for _ in 0..100 {
            if ClientOptions::new().open(name).is_err() {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        false
    }

    #[tokio::test]
    async fn the_pipe_lives_as_long_as_the_tab() {
        let dir = tempfile::tempdir().unwrap();
        let target = Target::for_test("powershell", "shell");
        let started = start(enabled_store(dir.path()), &target, quiet())
            .await
            .unwrap()
            .expect("on");
        let name = started
            .env
            .iter()
            .find(|(k, _)| k == "SSH_AUTH_SOCK")
            .map(|(_, v)| v.clone())
            .unwrap();
        assert!(name.starts_with(r"\\.\pipe\dachsterm-agent-"), "{name}");
        let mut client = ClientOptions::new().open(&name).unwrap();
        client
            .write_all(&agent_filter::frame(&[LIST]))
            .await
            .unwrap();
        let mut header = [0; 4];
        client.read_exact(&mut header).await.unwrap();
        // A second client while the first stays connected.
        drop(ClientOptions::new().open(&name).unwrap());
        drop(started);
        let mut rest = Vec::new();
        let _ = client.read_to_end(&mut rest).await;
        assert!(gone(&name).await, "closing the tab removes the pipe");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn the_socket_lives_in_a_private_folder_as_long_as_the_tab() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let target = Target::for_test("default-shell", "shell");
    let started = start(enabled_store(dir.path()), &target, quiet())
        .await
        .unwrap()
        .expect("on");
    let (key, socket) = &started.env[0];
    assert_eq!(key, "SSH_AUTH_SOCK");
    let socket = std::path::PathBuf::from(socket);
    assert!(socket.as_os_str().len() < MAX_SOCKET_PATH);
    let folder = socket.parent().unwrap().to_path_buf();
    assert_eq!(
        std::fs::metadata(&folder).unwrap().permissions().mode() & 0o777,
        0o700
    );
    let mut client = tokio::net::UnixStream::connect(&socket).await.unwrap();
    client
        .write_all(&agent_filter::frame(&[LIST]))
        .await
        .unwrap();
    let mut header = [0; 4];
    client.read_exact(&mut header).await.unwrap();
    drop(started);
    assert!(
        !socket.exists() && !folder.exists(),
        "closing the tab removes both"
    );
}
