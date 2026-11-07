//! How an SSH terminal starts. A tmux session starts through `exec` and never by typing at a
//! prompt, so reattaching can never put text into a running program.
use crate::{
    AppState,
    remote_exec::{self, Limits, quote},
    storage::{Profile, Result},
};
use russh::{Channel, client};
use std::time::Duration;

const MAX_NAME_BYTES: usize = 64;

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
fn tmux_command(name: &str, encoding: &str) -> String {
    // A server's non-login exec environment often has no locale, and tmux would then replace every
    // non-ASCII character. Other session encodings keep tmux's own choice.
    let utf8 = if encoding == "utf-8" { " -u" } else { "" };
    let script = format!(
        "command -v tmux >/dev/null 2>&1 || {{\n\
         printf '\\033]777;DachsTerm;tmux;missing\\007'\n\
         exec \"${{SHELL:-/bin/sh}}\" -l\n\
         }}\n\
         exec tmux{utf8} new-session -A -s {}",
        quote(name)
    );
    format!("sh -c {}", quote(&script))
}

pub async fn begin(
    channel: &Channel<client::Msg>,
    profile: &Profile,
) -> std::result::Result<(), russh::Error> {
    if profile.tmux_session.is_empty() {
        channel.request_shell(true).await
    } else {
        let command = tmux_command(&profile.tmux_session, &profile.encoding);
        channel.exec(true, command).await
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
    use super::{check_name, current_path, tmux_command};

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
        let command = tmux_command("work", "utf-8");
        assert!(command.starts_with("sh -c '"));
        assert!(command.contains("exec tmux -u new-session -A -s '\\''work'\\''"));
        assert!(command.contains("]777;DachsTerm;tmux;missing"));
        assert!(!tmux_command("work", "euc-kr").contains(" -u "));
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
