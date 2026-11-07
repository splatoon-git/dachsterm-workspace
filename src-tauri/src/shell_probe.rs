//! Before typing the session-only directory hook into a remote shell, confirm on a separate exec
//! channel that the login shell can run it. Network devices and forced-command menus must never
//! receive shell text they would interpret differently.
use crate::{
    AppState,
    remote_exec::{self, Limits},
    storage::Result,
};
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
    let limits = Limits {
        timeout: Duration::from_secs(5),
        max_output: 65536,
    };
    // A server that refuses or stalls exec simply keeps the manual connect button.
    let output = remote_exec::run(&handle, "printf %s \"$SHELL\"", limits).await;
    Ok(output.is_ok_and(|o| is_supported_shell(&String::from_utf8_lossy(&o.stdout))))
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
