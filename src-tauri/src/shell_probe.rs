//! Before typing the session-only directory hook into a remote shell, confirm on a separate exec
//! channel that the login shell can run it. Network devices and forced-command menus must never
//! receive shell text they would interpret differently.
use crate::{AppState, storage::Result};
use std::time::Duration;

fn is_supported_shell(output: &str) -> bool {
    // sshd may run the user's rc files first, so only the last line is the requested value.
    let shell = output.trim().lines().last().unwrap_or("");
    matches!(shell.rsplit('/').next(), Some("bash" | "zsh"))
}

#[tauri::command]
pub async fn terminal_supports_directory_hook(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<bool> {
    let handle = state.connections.handle(&id)?;
    let probe = async {
        let mut channel = handle.channel_open_session().await.ok()?;
        channel.exec(true, "printf %s \"$SHELL\"").await.ok()?;
        let mut output = Vec::new();
        while let Some(event) = channel.wait().await {
            if let russh::ChannelMsg::Data { data } = event {
                output.extend_from_slice(&data);
                if output.len() > 65536 {
                    return None;
                }
            }
        }
        Some(String::from_utf8_lossy(&output).into_owned())
    };
    // A server that refuses or stalls exec simply keeps the manual connect button.
    let output = tokio::time::timeout(Duration::from_secs(5), probe).await;
    Ok(output
        .ok()
        .flatten()
        .is_some_and(|o| is_supported_shell(&o)))
}

#[cfg(test)]
mod tests {
    use super::is_supported_shell;

    #[test]
    fn accepts_only_bash_and_zsh_from_the_last_output_line() {
        assert!(is_supported_shell("/bin/bash"));
        assert!(is_supported_shell("/usr/local/bin/zsh\n"));
        assert!(is_supported_shell("welcome banner\n/bin/bash"));
        for other in [
            "",
            "/usr/bin/fish",
            "/bin/sh",
            "% Invalid input",
            "/bin/bash\nmenu",
        ] {
            assert!(!is_supported_shell(other), "{other}");
        }
    }
}
