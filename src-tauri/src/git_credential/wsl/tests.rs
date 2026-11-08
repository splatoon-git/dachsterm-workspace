use super::*;
use crate::{
    approval::Direct,
    git_credential::{Credential, CredentialRequest, Decision, approval::Answer},
    ssh::Event,
};
use std::sync::Mutex;
use tokio::io::{DuplexStream, duplex};

const EXE: &str = r"C:\Program Files\Dachs'Term\dachsterm.exe";
const PIPE: &str = r"\\.\pipe\dachsterm-credential-0123456789abcdef0123456789abcdef";

/// git's reading of one `GIT_CONFIG_PARAMETERS` item (`sq_dequote`): single quotes, and `'\''`
/// for a quote inside.
fn dequote(item: &str) -> String {
    let inner = item.strip_prefix('\'').unwrap().strip_suffix('\'').unwrap();
    assert!(!inner.replace(r"'\''", "").contains('\''), "{item}");
    inner.replace(r"'\''", "'")
}

#[test]
fn the_helper_runs_the_app_by_its_wsl_path_for_get_only() {
    let item = parameter(EXE);
    let helper = dequote(&item)
        .strip_prefix("credential.helper=")
        .unwrap()
        .to_string();
    assert_eq!(helper, super::helper(EXE));
    assert!(helper.starts_with("!f() { [ \"$1\" = get ] || return 0;"));
    assert!(
        helper.contains(r"wslpath -u 'C:\Program Files\Dachs'\''Term\dachsterm.exe' 2>/dev/null"),
        "the path is one shell word: {helper}"
    );
    assert!(helper.contains("[ -x \"$p\" ] || return 0; exec \"$p\" git-credential get;"));
}

fn user(wslenv: Option<&str>, parameters: Option<&str>) -> UserEnv {
    UserEnv {
        wslenv: wslenv.map(Into::into),
        parameters: parameters.map(Into::into),
    }
}
fn value<'a>(env: &'a [(String, String)], name: &str) -> Option<&'a str> {
    env.iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

#[test]
fn the_pipe_stays_on_windows_and_the_helper_goes_to_linux() {
    let item = parameter(EXE);
    let env = shell_env(PIPE, EXE, &[], &user(None, None));
    assert_eq!(value(&env, PIPE_VARIABLE), Some(PIPE));
    assert_eq!(value(&env, PARAMETERS), Some(item.as_str()));
    assert_eq!(value(&env, "WSLENV"), Some("GIT_CONFIG_PARAMETERS/u"));

    // The tab's own variables (the directory hook, the agent's GIT_SSH) keep going to Linux.
    let tab = [
        ("WSLENV".to_string(), "PROMPT_COMMAND/u".to_string()),
        (
            "WSLENV".to_string(),
            "PROMPT_COMMAND/u:GIT_SSH/up".to_string(),
        ),
    ];
    let env = shell_env(PIPE, EXE, &tab, &user(Some("USERPROFILE/p"), None));
    assert_eq!(
        value(&env, "WSLENV"),
        Some("PROMPT_COMMAND/u:GIT_SSH/up:GIT_CONFIG_PARAMETERS/u")
    );
    let env = shell_env(PIPE, EXE, &[], &user(Some("USERPROFILE/p"), None));
    assert_eq!(
        value(&env, "WSLENV"),
        Some("USERPROFILE/p:GIT_CONFIG_PARAMETERS/u")
    );

    // A value Linux did not get before stays on the Windows side only.
    let env = shell_env(PIPE, EXE, &[], &user(None, Some("'core.pager=less'")));
    assert_eq!(value(&env, PARAMETERS), Some(item.as_str()));

    // One the user already sends to WSL keeps its items, and ours comes after them.
    let env = shell_env(
        PIPE,
        EXE,
        &[],
        &user(Some("GIT_CONFIG_PARAMETERS/u"), Some("'core.pager=less'")),
    );
    assert_eq!(
        value(&env, PARAMETERS),
        Some(format!("'core.pager=less' {item}").as_str())
    );
    assert_eq!(value(&env, "WSLENV"), None, "already forwarded");
}

#[test]
fn the_helper_opens_only_the_apps_credential_pipes() {
    assert!(usable_pipe(PIPE));
    for name in [
        r"\\.\pipe\dachsterm-agent-0123456789abcdef0123456789abcdef",
        r"\\.\pipe\dachsterm-credential-0123",
        r"\\.\pipe\dachsterm-credential-0123456789abcdef0123456789abcdeg",
        r"\\server\pipe\dachsterm-credential-0123456789abcdef0123456789abcdef",
        "",
    ] {
        assert!(!usable_pipe(name), "{name}");
    }
}

type Seen = Arc<Mutex<Vec<Event>>>;
/// The tab's side: its pipe state, where its cards go, and its open/closed signal, which the test
/// holds as the tab would.
struct Open {
    forward: Arc<Forward>,
    cards: Arc<dyn Notify>,
    seen: Seen,
    stop: watch::Sender<bool>,
}
fn tab() -> Open {
    let seen: Seen = Arc::default();
    let sink = seen.clone();
    let cards: Arc<dyn Notify> = Arc::new(Direct(Arc::new(move |event| {
        sink.lock().unwrap().push(event);
        Ok(())
    })));
    Open {
        forward: Arc::new(Forward::new(PIPE.into(), Vec::new(), true)),
        cards,
        seen,
        stop: watch::channel(false).0,
    }
}
fn client(tab: &Open) -> DuplexStream {
    let (client, server) = duplex(64 * 1024);
    spawn_client(
        &tab.forward,
        &tab.cards,
        "Ubuntu-24.04",
        server,
        tab.stop.subscribe(),
    );
    client
}
async fn card(seen: &Seen) -> CredentialRequest {
    let shown = async {
        loop {
            let last = seen.lock().unwrap().pop();
            if let Some(Event::GitCredential(request)) = last {
                return request;
            }
            tokio::task::yield_now().await;
        }
    };
    timeout(Duration::from_secs(10), shown)
        .await
        .expect("a card")
}
const GET: &[u8] = b"action=get\nprotocol=https\nhost=git.test:3000\nusername=probe\n";

#[tokio::test]
async fn a_request_waits_for_the_tabs_card() {
    let tab = tab();
    let (forward, seen) = (&tab.forward, &tab.seen);
    let mut stream = client(&tab);
    stream.write_all(&frame(GET)).await.unwrap();
    let request = card(seen).await;
    assert!(request.local, "the card says the value goes to WSL");
    assert_eq!(request.session, "Ubuntu-24.04");
    assert_eq!(request.host, "git.test:3000");
    assert_eq!(request.username.as_deref(), Some("probe"));
    assert!(request.server_helpers.is_empty());
    forward
        .send(
            &request.request,
            Answer::Allow(
                Decision::Once,
                Credential {
                    username: Zeroizing::new("probe".into()),
                    password: Zeroizing::new("made-in-test".into()),
                },
            ),
        )
        .unwrap();
    let answer = read_frame(&mut stream, 4096).await.unwrap();
    assert_eq!(&answer[..], b"username=probe\npassword=made-in-test\n");
    drop(stream);

    // "Allow once" also answers the rest of the same push, without a card.
    let mut again = client(&tab);
    again.write_all(&frame(GET)).await.unwrap();
    let answer = read_frame(&mut again, 4096).await.unwrap();
    assert!(answer.starts_with(b"username=probe\n"));
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_refusal_is_an_empty_answer() {
    let tab = tab();
    let (forward, seen) = (&tab.forward, &tab.seen);
    let mut stream = client(&tab);
    stream.write_all(&frame(GET)).await.unwrap();
    let request = card(seen).await;
    forward.send(&request.request, Answer::Deny).unwrap();
    assert!(read_frame(&mut stream, 4096).await.unwrap().is_empty());

    // http is refused without a card, with one notice.
    let mut plain = client(&tab);
    plain
        .write_all(&frame(b"action=get\nprotocol=http\nhost=git.test\n"))
        .await
        .unwrap();
    assert!(read_frame(&mut plain, 4096).await.unwrap().is_empty());
    assert!(matches!(
        seen.lock().unwrap().as_slice(),
        [Event::AgentNotice { .. }]
    ));
}

#[tokio::test]
async fn an_oversized_request_ends_the_client_without_an_answer() {
    let tab = tab();
    let mut stream = client(&tab);
    let length = (protocol::MAX_REQUEST as u32 + 1).to_be_bytes();
    stream.write_all(&length).await.unwrap();
    let mut rest = Vec::new();
    stream.read_to_end(&mut rest).await.unwrap();
    assert!(rest.is_empty());
    assert!(tab.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn closing_the_tab_ends_a_waiting_request() {
    let open = tab();
    let mut stream = client(&open);
    stream.write_all(&frame(GET)).await.unwrap();
    card(&open.seen).await;
    let Open { forward, stop, .. } = open;
    drop(Tab { forward, stop });
    let mut rest = Vec::new();
    stream.read_to_end(&mut rest).await.unwrap();
    // The forgotten request may still say "no value" before the client ends.
    assert!(
        rest.is_empty() || rest == [0; 4],
        "no credential once the tab is gone"
    );
}

fn store(dir: &std::path::Path, on: bool) -> Arc<Store> {
    let store = Store::open(&dir.join("test.db")).unwrap();
    store.save_local_agent(false, vec![], on).unwrap();
    Arc::new(store)
}
fn quiet() -> Sink {
    Arc::new(|_| Ok(()))
}

#[tokio::test]
async fn only_wsl_tabs_with_the_setting_on_get_a_pipe() {
    let dir = tempfile::tempdir().unwrap();
    let wsl = Target::for_test("wsl:Ubuntu", "wsl");
    let off = store(dir.path(), false);
    assert!(start(off, &wsl, &[], quiet()).await.unwrap().is_none());
    let on = store(dir.path(), true);
    let shell = Target::for_test("powershell", "shell");
    assert!(start(on, &shell, &[], quiet()).await.unwrap().is_none());
}

#[cfg(windows)]
#[tokio::test]
async fn a_wsl_tabs_pipe_lives_as_long_as_the_tab() {
    use tokio::net::windows::named_pipe::ClientOptions;
    let dir = tempfile::tempdir().unwrap();
    let wsl = Target::for_test("wsl:Ubuntu", "wsl");
    let started = start(store(dir.path(), true), &wsl, &[], quiet())
        .await
        .unwrap()
        .unwrap();
    let pipe = value(&started.env, PIPE_VARIABLE).unwrap().to_string();
    assert!(usable_pipe(&pipe), "{pipe}");
    let exe = std::env::current_exe().unwrap();
    assert_eq!(
        value(&started.env, PARAMETERS),
        Some(parameter(&exe.to_string_lossy()).as_str())
    );
    drop(
        ClientOptions::new()
            .open(&pipe)
            .expect("open while the tab is"),
    );
    drop(started);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        ClientOptions::new().open(&pipe).is_err(),
        "gone with the tab"
    );
}
