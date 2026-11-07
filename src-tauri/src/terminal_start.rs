//! How an SSH terminal starts. A tmux session starts through `exec` and never by typing at a
//! prompt, so reattaching can never put text into a running program.
use crate::{
    AppState,
    remote_exec::{self, Limits, quote},
    storage::{Profile, Result},
};
use russh::{Channel, client};
use serde::Deserialize;
use std::{collections::HashMap, sync::Mutex, time::Duration};

const MAX_NAME_BYTES: usize = 64;
const MAX_LAUNCH_BYTES: usize = 4096;

/// A start command for a new tab. `connect` receives it once and it is never saved, so a
/// reconnect only attaches and never runs it again.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Launch {
    /// An absolute server folder, or empty for the login folder.
    pub folder: String,
    pub command: String,
}
impl Launch {
    pub fn check(&self, profile: &Profile) -> Result<()> {
        if profile.tmux_session.is_empty() {
            return Err("시작 명령은 tmux 세션을 쓰는 SSH 연결에서만 보낼 수 있습니다.".into());
        }
        if !(self.folder.is_empty() || self.folder.starts_with('/'))
            || self.folder.len() > MAX_LAUNCH_BYTES
        {
            return Err("시작 폴더는 /로 시작하는 서버 경로로 입력하세요.".into());
        }
        if self.command.trim().is_empty() || self.command.len() > MAX_LAUNCH_BYTES {
            return Err("시작 명령을 4096바이트 안에서 입력하세요.".into());
        }
        // A line break would run part of the command early, and tmux would read other controls.
        if (self.folder.chars().chain(self.command.chars())).any(char::is_control) {
            return Err("시작 명령과 폴더에는 줄바꿈이나 제어 문자를 넣을 수 없습니다.".into());
        }
        crate::encoding::encode(
            &format!("{}{}", self.folder, self.command),
            &profile.encoding,
        )
        .map(|_| ())
    }
}

/// Start commands waiting for their connection's terminal, owned by `Connections`.
#[derive(Default)]
pub struct Launches(Mutex<HashMap<String, Launch>>);
impl Launches {
    pub fn put(&self, id: &str, launch: Launch) {
        self.0.lock().unwrap().insert(id.to_string(), launch);
    }
    pub fn take(&self, id: &str) -> Option<Launch> {
        self.0.lock().unwrap().remove(id)
    }
}

pub fn check_name(name: &str) -> Result<()> {
    if name.len() > MAX_NAME_BYTES
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return Err("tmux 세션 이름은 영문, 숫자, _, - 로 64바이트까지 입력하세요.".into());
    }
    Ok(())
}

/// Without tmux this falls back to a login shell and tells the app, so the tab is still usable.
fn tmux_command(name: &str, encoding: &str, launch: Option<&Launch>) -> String {
    // A server's non-login exec environment often has no locale, and tmux would then replace every
    // non-ASCII character. Other session encodings keep tmux's own choice.
    let utf8 = if encoding == "utf-8" { " -u" } else { "" };
    let start = match launch {
        None => format!("exec tmux{utf8} new-session -A -s {}", quote(name)),
        Some(launch) => launch_script(name, utf8, launch),
    };
    let script = format!(
        "command -v tmux >/dev/null 2>&1 || {{\n\
         printf '\\033]777;DachsTerm;tmux;missing\\007'\n\
         exec \"${{SHELL:-/bin/sh}}\" -l\n\
         }}\n\
         {start}"
    );
    format!("sh -c {}", quote(&script))
}

/// Types the command only into a session this start creates. An existing session is attached as
/// it is, so a running agent never receives the text. `send-keys` runs it in the user's
/// interactive shell, whose rc files set the `PATH` where such tools are usually installed.
fn launch_script(name: &str, utf8: &str, launch: &Launch) -> String {
    let session = quote(&format!("={name}"));
    let pane = quote(&format!("={name}:"));
    let folder = if launch.folder.is_empty() {
        String::new()
    } else {
        format!(" -c {}", quote(&launch.folder))
    };
    format!(
        "tmux has-session -t {session} 2>/dev/null || {{\n\
         tmux{utf8} new-session -d -s {}{folder} &&\n\
         tmux send-keys -t {pane} -l -- {} &&\n\
         tmux send-keys -t {pane} Enter\n\
         }}\n\
         exec tmux{utf8} attach-session -t {session}",
        quote(name),
        quote(&launch.command)
    )
}

pub async fn begin(
    channel: &Channel<client::Msg>,
    profile: &Profile,
    launch: Option<Launch>,
) -> std::result::Result<(), russh::Error> {
    if profile.tmux_session.is_empty() {
        channel.request_shell(true).await
    } else {
        let command = tmux_command(&profile.tmux_session, &profile.encoding, launch.as_ref());
        // `Launch::check` already proved the text fits the session encoding; names are ASCII.
        let bytes = crate::encoding::encode(&command, &profile.encoding)
            .unwrap_or_else(|_| command.into_bytes());
        channel.exec(true, bytes).await
    }
}

pub fn lost_message(profile: &Profile) -> &'static str {
    if profile.tmux_session.is_empty() {
        "서버 연결이 끊어졌습니다. 재접속하면 새 셸이 열립니다."
    } else {
        "서버 연결이 끊어졌습니다. 재접속하면 같은 tmux 세션에 다시 연결합니다."
    }
}

fn current_path(output: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(output);
    let path = text.lines().last()?.trim();
    path.starts_with('/').then(|| path.to_string())
}

/// The name comes from the saved profile and never from the caller.
#[tauri::command]
pub async fn tmux_current_path(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Option<String>> {
    let name = state.connections.control(&id)?.profile.tmux_session.clone();
    if name.is_empty() {
        return Ok(None);
    }
    let handle = state.connections.handle(&id)?;
    let target = quote(&format!("={name}:"));
    let script = format!("tmux display-message -p -t {target} '#{{pane_current_path}}'");
    let limits = Limits {
        timeout: Duration::from_secs(5),
        max_output: 65536,
    };
    let output = remote_exec::run(&handle, &script, limits).await?;
    Ok(if output.exit == Some(0) {
        current_path(&output.stdout)
    } else {
        None
    })
}

#[cfg(test)]
mod tests {
    use super::{Launch, check_name, current_path, launch_script, tmux_command};
    use crate::storage::Profile;

    fn launch(folder: &str, command: &str) -> Launch {
        Launch {
            folder: folder.into(),
            command: command.into(),
        }
    }
    fn tmux_profile(encoding: &str) -> Profile {
        let mut profile = Profile::imported("p", "h", "u", 22);
        profile.tmux_session = "work".into();
        profile.encoding = encoding.into();
        profile
    }

    #[test]
    fn a_launch_types_only_into_a_session_it_creates() {
        let script = launch_script("work", " -u", &launch("/srv/a b's", "cli --worktree x"));
        assert_eq!(
            script,
            "tmux has-session -t '=work' 2>/dev/null || {\n\
             tmux -u new-session -d -s 'work' -c '/srv/a b'\\''s' &&\n\
             tmux send-keys -t '=work:' -l -- 'cli --worktree x' &&\n\
             tmux send-keys -t '=work:' Enter\n\
             }\n\
             exec tmux -u attach-session -t '=work'"
        );
        // The login folder needs no -c, and the tmux check still comes first.
        assert!(!launch_script("work", "", &launch("", "cli")).contains(" -c "));
        let command = tmux_command("work", "utf-8", Some(&launch("", "cli")));
        assert!(command.find("command -v tmux") < command.find("has-session"));
        assert!(!command.contains("new-session -A"));
    }

    #[test]
    fn a_launch_is_checked_before_connecting() {
        let p = tmux_profile("utf-8");
        assert!(launch("", "cli").check(&p).is_ok());
        assert!(
            launch("/srv/한글 폴더", "cli --worktree a.b-1")
                .check(&p)
                .is_ok()
        );
        for bad in [
            launch("srv", "cli"),
            launch("~/x", "cli"),
            launch("/srv", " "),
            launch("/srv", "cli\nrm -rf /"),
            launch("/srv\r", "cli"),
            launch("/srv", "cli\u{1b}[A"),
            launch("/srv", &"x".repeat(4097)),
        ] {
            assert!(bad.check(&p).is_err(), "{bad:?}");
        }
        assert!(
            launch("", "cli")
                .check(&Profile::imported("p", "h", "u", 22))
                .is_err()
        );
        assert!(
            launch("/srv/한글", "cli")
                .check(&tmux_profile("euc-kr"))
                .is_ok()
        );
        assert!(
            launch("/srv/😀", "cli")
                .check(&tmux_profile("euc-kr"))
                .is_err()
        );
    }

    #[test]
    fn allows_only_names_that_need_no_quoting() {
        for good in ["", "work", "a_b-1", &"a".repeat(64)] {
            assert!(check_name(good).is_ok(), "{good}");
        }
        for bad in [
            "a b",
            "a:b",
            "a.b",
            "a'b",
            "$(id)",
            "세션",
            "a\n",
            &"a".repeat(65),
        ] {
            assert!(check_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn starts_tmux_by_exec_with_a_login_shell_fallback() {
        let command = tmux_command("work", "utf-8", None);
        assert!(command.starts_with("sh -c '"));
        assert!(command.contains("exec tmux -u new-session -A -s '\\''work'\\''"));
        assert!(command.contains("]777;DachsTerm;tmux;missing"));
        assert!(!tmux_command("work", "euc-kr", None).contains(" -u "));
    }

    #[test]
    fn current_path_is_the_last_absolute_line() {
        assert_eq!(current_path(b"/srv/app\n").as_deref(), Some("/srv/app"));
        assert_eq!(
            current_path(b"noise\n/srv/a b\n").as_deref(),
            Some("/srv/a b")
        );
        assert_eq!(current_path(b"can't find session\n"), None);
        assert_eq!(current_path(b""), None);
    }
}
