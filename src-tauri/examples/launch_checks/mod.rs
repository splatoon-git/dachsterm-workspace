//! Starting an agent in tmux (DX.7) against the real OpenSSH fixture. The start command runs once,
//! in its folder, only in a session the start creates. An existing session is attached as it is,
//! and a reconnect never runs the command again.
use super::*;
use dachsterm::terminal_start::Launch;
use russh::ChannelMsg;

const SESSION: &str = "dx7-probe";
const FOLDER: &str = "/tmp/dx7 launch's 한글";
const COUNT: &str = "/tmp/dx7-probe.count";

/// Fixture setup and checks the app itself never runs, on a channel of their own.
async fn shell(manager: &Connections, id: &str, script: &str) -> Result<String> {
    let mut channel = manager.handle(id)?.channel_open_session().await?;
    channel.exec(true, script).await?;
    let mut out = Vec::new();
    while let Some(message) = channel.wait().await {
        if let ChannelMsg::Data { data } = message {
            out.extend_from_slice(&data);
        }
    }
    Ok(String::from_utf8(out)?)
}

/// Each run appends its folder. The printed marker differs from the typed text, so only a real
/// run shows it on screen.
fn launch() -> Launch {
    Launch {
        folder: FOLDER.into(),
        command: format!("printf '%s\\n' \"$PWD\" >> {COUNT}; printf 'DX7_%s\\n' RAN"),
    }
}

async fn attached(c: &mut Client, marker: &str) -> Result<()> {
    c.connected(false).await?;
    c.send(&format!("printf 'DX7_%s\\n' {marker}\r")).await?;
    c.marker(&format!("DX7_{marker}")).await?;
    Ok(())
}

pub async fn run(
    manager: &Arc<Connections>,
    store: &Arc<Store>,
    paths: &[PathBuf],
    setup_id: &str,
) -> Result<()> {
    let reset = format!(
        "tmux kill-session -t ={SESSION} 2>/dev/null; rm -f {COUNT}; mkdir -p \"{FOLDER}\""
    );
    shell(manager, setup_id, &reset).await?;
    let mut profile = base();
    profile.name = "launch".into();
    profile.tmux_session = SESSION.into();
    let profile = store.save(profile, None)?;
    let cat = format!("cat {COUNT} 2>/dev/null");
    let count = || shell(manager, setup_id, &cat);
    let open = |launch| {
        begin_with(
            manager,
            store,
            paths,
            profile.clone(),
            env("PASSWORD"),
            launch,
        )
    };
    let once = format!(
        "{FOLDER}
"
    );
    let result = async {
        let mut c = open(Some(launch()))?;
        c.connected(false).await?;
        c.marker("DX7_RAN").await?;
        assert_eq!(count().await?, once, "ran once, in its folder");
        c.stop().await?;
        println!("PASS DX.7 a tmux start runs its command once in a new session and folder");

        // Another start for the same session must not type into the running program.
        let mut again = open(Some(launch()))?;
        attached(&mut again, "ATTACHED").await?;
        assert_eq!(count().await?, once, "an existing session only attaches");
        again.stop().await?;
        let mut reconnect = open(None)?;
        attached(&mut reconnect, "RECONNECTED").await?;
        assert_eq!(count().await?, once, "a reconnect runs nothing again");
        let sessions = shell(manager, setup_id, "tmux list-sessions -F '#{session_name}'").await?;
        assert_eq!(sessions.lines().filter(|s| *s == SESSION).count(), 1);
        assert!(
            manager.launches.take(&reconnect.id).is_none(),
            "nothing left to run"
        );
        reconnect.stop().await?;
        println!("PASS DX.7 an existing session and a reconnect only attach, nothing runs again");
        Ok::<_, Box<dyn std::error::Error>>(())
    }
    .await;
    shell(manager, setup_id, &reset).await?;
    store.delete(&profile.id)?;
    result
}
