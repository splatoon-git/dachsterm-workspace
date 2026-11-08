//! The card's answers and the saved list in Settings › Agents.
use super::{
    Credential, Decision,
    approval::{Answer, ENDED, Forward, INPUT_TIME},
    local, protocol,
};
use crate::{
    AppState,
    approval::Owner,
    ssh::Connections,
    storage::{Result, Store},
    vault::Vault,
};
use serde::Serialize;
use std::sync::Arc;
use tokio::task::spawn_blocking;
use zeroize::Zeroizing;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InputReason {
    Chosen,
    /// Neither the app nor this PC's Git helpers had a value.
    NotFound,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Reply {
    Done { notice: Option<String> },
    Input { reason: InputReason, seconds: u64 },
}

fn input(reason: InputReason) -> Reply {
    Reply::Input {
        reason,
        seconds: INPUT_TIME.as_secs(),
    }
}

/// The card's answer. An allow looks for the value only now, so a credential manager's sign-in
/// window never opens before the user agreed. A typed value is checked here and answered like
/// "allow once" unless the card chose ten minutes.
async fn reply(
    forward: &Forward,
    store: Arc<Store>,
    vault: Arc<Vault>,
    request: &str,
    decision: Decision,
    typed: Option<Credential>,
) -> Result<Reply> {
    if decision == Decision::Deny {
        forward.send(request, Answer::Deny)?;
        return Ok(Reply::Done { notice: None });
    }
    if let Some(typed) = typed {
        if !protocol::usable_value(&typed.username, local::MAX_USERNAME)
            || !protocol::usable_value(&typed.password, local::MAX_PASSWORD)
        {
            return Err("사용자 이름과 토큰을 한 줄로 입력하세요.".into());
        }
        let decision = if decision == Decision::Input {
            Decision::Once
        } else {
            decision
        };
        forward.send(request, Answer::Allow(decision, typed))?;
        return Ok(Reply::Done { notice: None });
    }
    if decision == Decision::Input {
        forward.extend(request, INPUT_TIME)?;
        return Ok(input(InputReason::Chosen));
    }
    let ask = forward.begin_fetch(request)?;
    let found = spawn_blocking(move || local::find(&store, &vault, &ask))
        .await
        .ok()
        .flatten();
    forward.end_fetch(request);
    match found {
        Some(found) => {
            forward.send(request, Answer::Allow(decision, found))?;
            Ok(Reply::Done { notice: None })
        }
        None => {
            forward.extend(request, INPUT_TIME)?;
            Ok(input(InputReason::NotFound))
        }
    }
}

/// A connection's card answered by its ID, without a window: the Docker probe answers this way.
pub async fn answer(
    connections: &Connections,
    store: Arc<Store>,
    vault: Arc<Vault>,
    id: &str,
    request: &str,
    decision: Decision,
    typed: Option<Credential>,
) -> Result<Reply> {
    let forward = connections.git.get(id).ok_or(ENDED)?;
    reply(&forward, store, vault, request, decision, typed).await
}

/// The requests of the tab `id`: a connection's forward, or a WSL tab's pipe (DX.14). The window
/// must show that tab, as for a signature card.
fn forward_of(state: &AppState, window: &str, id: &str) -> Result<Arc<Forward>> {
    let forward = match Owner::find(state, window, id)? {
        Owner::Remote(_) => state.connections.git.get(id),
        Owner::Local(control) => control.credentials().map(|tab| tab.forward()),
    };
    forward.ok_or_else(|| ENDED.into())
}

// Tauri passes each IPC argument separately.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn git_credential_reply(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
    request: String,
    decision: Decision,
    username: Option<String>,
    password: Option<String>,
    remember: Option<bool>,
) -> Result<Reply> {
    let password = password.map(Zeroizing::new);
    let forward = forward_of(&state, window.label(), &id)?;
    let typed = password.map(|password| Credential {
        username: Zeroizing::new(username.unwrap_or_default()),
        password,
    });
    // Only a value typed on the card can be saved. The server never supplies one.
    let keep = match (&typed, remember) {
        (Some(typed), Some(true)) => Some((
            forward.with(&request, |p| Ok(p.ask.clone()))?,
            typed.clone(),
        )),
        _ => None,
    };
    let (store, vault) = (state.store.clone(), state.vault.clone());
    let reply = reply(&forward, store, vault, &request, decision, typed).await?;
    let Some((ask, typed)) = keep else {
        return Ok(reply);
    };
    let saving = spawn_blocking(move || {
        use tauri::Manager;
        local::save(&app.state::<AppState>(), &ask, &typed)
    });
    Ok(Reply::Done {
        notice: saving
            .await
            .map_err(|_| "자격 증명을 저장하지 못했습니다.".to_string())
            .and_then(|saved| saved)
            .err(),
    })
}

/// The line the shell hook adds for this connection, while its socket is open.
pub fn shell_line(connections: &Connections, id: &str) -> Option<String> {
    let forward = connections.git.get(id)?;
    let path = forward.path.lock().unwrap().clone()?;
    Some(protocol::shell_export(&path))
}

#[tauri::command]
pub async fn git_credential_shell(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Option<String>> {
    state
        .connections
        .control(&id)?
        .broker
        .check(window.label())?;
    Ok(shell_line(&state.connections, &id))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub host: String,
    pub username: String,
}

/// Saved credentials without their values, for Settings › Agents.
#[tauri::command]
pub async fn git_credentials_saved(app: tauri::AppHandle) -> Result<Vec<Saved>> {
    spawn_blocking(move || {
        use tauri::Manager;
        let list = app.state::<AppState>().store.git_credentials()?;
        Ok(list
            .into_iter()
            .map(|e| Saved {
                host: e.host,
                username: e.username,
            })
            .collect())
    })
    .await
    .map_err(|_| "저장한 자격 증명을 읽지 못했습니다.".to_string())?
}

/// Removes one; the OS store entry follows through the journal, as for a deleted session.
#[tauri::command]
pub async fn git_credential_forget(
    app: tauri::AppHandle,
    host: String,
    username: String,
) -> Result<()> {
    spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let _guard = state.mutation.lock().unwrap();
        state
            .store
            .forget_git_credential("https", &host, &username)?;
        let _ = state.store.cleanup_credentials();
        Ok(())
    })
    .await
    .map_err(|_| "자격 증명을 지우지 못했습니다.".to_string())?
}
