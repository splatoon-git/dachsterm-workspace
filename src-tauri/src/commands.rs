use crate::{
    AppState,
    ssh::{Event, Input},
    storage::{Profile, Result, Snapshot},
};
use std::sync::Arc;
use tauri::{Manager, State, ipc::Channel};
use uuid::Uuid;
use zeroize::Zeroizing;

#[tauri::command]
pub fn sessions(state: State<AppState>) -> Result<Snapshot> {
    let _guard = state.mutation.lock().unwrap();
    let mut snapshot = state.store.list()?;
    snapshot.credential_warning = state.store.cleanup_credentials().err();
    Ok(snapshot)
}
#[tauri::command]
pub fn save_session(
    state: State<AppState>,
    profile: Profile,
    secret_action: String,
    secret: Option<String>,
) -> Result<Profile> {
    let secret = secret.map(Zeroizing::new);
    profile.validate()?;
    if matches!(profile.auth.as_str(), "agent" | "interactive") && secret_action == "replace" {
        return Err("에이전트·추가 인증 응답은 저장할 수 없습니다.".into());
    }
    let _guard = state.mutation.lock().unwrap();
    if !profile.id.is_empty() {
        crate::maintenance::snapshot(&state.store, &state.directory)?;
    }
    let old = state.store.secret_ref(&profile.id)?;
    // A stored credential cannot silently follow a changed destination/account/key.
    if secret_action == "keep" && !profile.id.is_empty() {
        let previous = state.store.profile(&profile.id)?;
        if old.is_some()
            && (previous.protocol != profile.protocol
                || previous.tls_ca_path != profile.tls_ca_path
                || previous.host != profile.host
                || previous.port != profile.port
                || previous.username != profile.username
                || previous.auth != profile.auth
                || previous.key_path != profile.key_path
                || previous.jump_ids != profile.jump_ids)
        {
            return Err(
                "접속 대상이나 인증 방식 변경 시 기존 인증정보를 삭제하거나 새로 입력하세요."
                    .into(),
            );
        }
    }
    let new = match secret_action.as_str() {
        "keep" => old.clone(),
        "forget" => None,
        "replace" => {
            let value = secret.as_ref().ok_or("저장할 인증정보를 입력하세요.")?;
            if value.len() > 16384 {
                return Err("인증정보가 너무 깁니다.".into());
            }
            let id = state.vault.save(&state.store, value)?;
            Some(id)
        }
        _ => return Err("인증정보 저장 방식이 올바르지 않습니다.".into()),
    };
    let result = state.store.save(profile, new);
    // A failed OS cleanup stays journaled and is reported by the next snapshot.
    let _ = state.store.cleanup_credentials();
    result
}
#[tauri::command]
pub fn delete_session(state: State<AppState>, id: String) -> Result<()> {
    let _guard = state.mutation.lock().unwrap();
    crate::maintenance::snapshot(&state.store, &state.directory)?;
    state.store.delete(&id)?;
    // Only remove OS credentials after a committed deletion. Retry failures via the journal.
    let _ = state.store.cleanup_credentials();
    Ok(())
}
#[tauri::command]
pub fn duplicate_session(state: State<AppState>, id: String) -> Result<Profile> {
    let _guard = state.mutation.lock().unwrap();
    let mut p = state.store.profile(&id)?;
    p.id.clear();
    p.name = format!("{} 복사", p.name);
    state.store.save(p, None)
}
#[tauri::command]
pub fn save_group(state: State<AppState>, id: Option<String>, name: Option<String>) -> Result<()> {
    let _guard = state.mutation.lock().unwrap();
    if name.is_none() {
        crate::maintenance::snapshot(&state.store, &state.directory)?;
    }
    state.store.group(id, name)
}
#[tauri::command]
pub async fn connect(
    app: tauri::AppHandle,
    id: String,
    profile_id: String,
    expected: Profile,
    secret: Option<String>,
    remember: Option<bool>,
    on_event: Channel<Event>,
) -> Result<()> {
    let state = app.state::<AppState>();
    let save_app = app.clone();
    if state.closing.load(std::sync::atomic::Ordering::SeqCst) {
        return Err("앱이 종료 중입니다.".into());
    }
    if Uuid::parse_str(&id).is_err() {
        return Err("잘못된 연결 ID".into());
    }
    let profile = state.store.profile(&profile_id)?;
    if profile.protocol != expected.protocol
        || profile.tls_ca_path != expected.tls_ca_path
        || profile.host != expected.host
        || profile.port != expected.port
        || profile.username != expected.username
        || profile.encoding != expected.encoding
        || profile.auth != expected.auth
        || profile.key_path != expected.key_path
        || profile.jump_ids != expected.jump_ids
    {
        return Err("저장된 연결 대상이 변경되었습니다. 세션 목록에서 다시 연결하세요.".into());
    }
    let remember = remember.unwrap_or(false)
        && secret.is_some()
        && matches!(profile.auth.as_str(), "password" | "key");
    let original_ref = state.store.secret_ref(&profile_id)?;
    let secret = match secret {
        Some(s) if s.len() <= 16384 => Zeroizing::new(s),
        Some(_) => return Err("인증정보가 너무 깁니다.".into()),
        None => {
            let _guard = state.mutation.lock().unwrap();
            match state.store.secret_ref(&profile_id)? {
                Some(id) => state.vault.get(&state.store, &id)?,
                None => Zeroizing::new(String::new()),
            }
        }
    };
    let pending_secret = std::sync::Mutex::new(if remember && !secret.is_empty() {
        Some(Zeroizing::new(secret.to_string()))
    } else {
        None
    });
    let authenticated_profile = profile.clone();
    let tunnels = state.tunnels.clone();
    let connections = state.connections.clone();
    let configs = state
        .store
        .tunnel_configs()?
        .into_iter()
        .filter(|c| c.profile_id == profile_id && c.auto_start)
        .collect::<Vec<_>>();
    let tunnel_connection = id.clone();
    let hops = {
        let _guard = state.mutation.lock().unwrap();
        let mut route = crate::routes::resolve(&profile, &state.store.list()?.profiles)?;
        route.pop();
        route
            .into_iter()
            .map(|p| {
                let secret = match state.store.secret_ref(&p.id)? {
                    Some(reference) => Some(state.vault.get(&state.store, &reference)?),
                    None => None,
                };
                Ok((p, secret))
            })
            .collect::<Result<Vec<_>>>()?
    };
    state.connections.start_route(
        id,
        profile,
        secret,
        hops,
        state.known_hosts.clone(),
        Arc::new(move |mut event| {
            if let Event::State { status, message } = &mut event {
                if status == "connected" {
                    if let Some(value) = pending_secret.lock().unwrap().take() {
                        let state = save_app.state::<AppState>();
                        let saved = (|| -> Result<()> {
                            let _guard = state.mutation.lock().unwrap();
                            let current = state.store.profile(&authenticated_profile.id)?;
                            if !same_credential_target(&current, &authenticated_profile)
                                || state.store.secret_ref(&current.id)? != original_ref {
                                return Err("접속 중 세션 또는 저장 암호가 변경되어 암호를 저장하지 않았습니다.".into());
                            }
                            let reference = state.vault.save(&state.store, &value)?;
                            let result = state.store.save(current, Some(reference));
                            let _ = state.store.cleanup_credentials();
                            result.map(|_| ())
                        })();
                        message.push_str(match saved {
                            Ok(()) => " · 암호를 보안 저장소에 저장했습니다.",
                            Err(_) => " · 암호 저장에 실패했습니다. 보관함 잠금·세션 변경 여부를 확인하고 세션 편집에서 다시 저장하세요.",
                        });
                    }
                } else if matches!(status.as_str(), "closed" | "error") {
                    pending_secret.lock().unwrap().take();
                }
            }
            if matches!(&event,Event::State{status,..} if status=="connected") {
                let tunnels = tunnels.clone();
                let connections = connections.clone();
                let configs = configs.clone();
                let id = tunnel_connection.clone();
                tokio::spawn(async move {
                    for config in configs {
                        let _ = tunnels.start(connections.clone(), id.clone(), config).await;
                    }
                });
            }
            on_event
                .send(event)
                .map_err(|_| "터미널 구독이 종료되었습니다.".into())
        }),
        state.store.clone(),
    )
}
fn same_credential_target(a: &Profile, b: &Profile) -> bool {
    a.id == b.id
        && a.protocol == b.protocol
        && a.host == b.host
        && a.port == b.port
        && a.username == b.username
        && a.auth == b.auth
        && a.key_path == b.key_path
        && a.jump_ids == b.jump_ids
        && a.tls_ca_path == b.tls_ca_path
}
#[tauri::command]
pub fn disconnect(state: State<AppState>, id: String) -> Result<()> {
    if let Ok(c) = state.connections.control(&id) {
        let _ = c.stop.send(true);
    }
    Ok(())
}
#[tauri::command]
pub fn trust_host(
    state: State<AppState>,
    id: String,
    accept: bool,
    challenge: String,
) -> Result<()> {
    let c = state.connections.control(&id)?;
    decide_trust(&c.trust, &c.trust_request, &challenge, accept)
}
fn decide_trust(
    trust: &tokio::sync::watch::Sender<Option<bool>>,
    request: &std::sync::Mutex<Option<String>>,
    challenge: &str,
    accept: bool,
) -> Result<()> {
    let mut pending = request.lock().unwrap();
    if pending.as_deref() != Some(challenge) || trust.borrow().is_some() {
        return Err("이미 처리된 호스트키 확인입니다.".into());
    }
    pending.take();
    trust.send(Some(accept)).map_err(|_| "연결 종료".into())
}
#[cfg(test)]
mod trust_tests {
    use super::*;
    #[test]
    fn previous_hop_reply_cannot_approve_next_host() {
        let (trust, _receiver) = tokio::sync::watch::channel(None);
        let request = std::sync::Mutex::new(Some("hop-one".into()));
        decide_trust(&trust, &request, "hop-one", true).unwrap();
        assert!(decide_trust(&trust, &request, "hop-one", true).is_err());
        trust.send_replace(None);
        *request.lock().unwrap() = Some("hop-two".into());
        assert!(decide_trust(&trust, &request, "hop-one", true).is_err());
        assert_eq!(*trust.borrow(), None);
        decide_trust(&trust, &request, "hop-two", false).unwrap();
        assert_eq!(*trust.borrow(), Some(false));
    }
}
#[tauri::command]
pub fn auth_reply(
    window: tauri::WebviewWindow,
    state: State<AppState>,
    id: String,
    challenge: String,
    responses: Vec<String>,
) -> Result<()> {
    let responses = Zeroizing::new(responses);
    let control = state.connections.control(&id)?;
    control.broker.check(window.label())?;
    if Uuid::parse_str(&challenge).is_err()
        || responses.len() > 16
        || responses.iter().any(|s| s.len() > 16384)
    {
        return Err("추가 인증 응답 형식 오류".into());
    }
    control
        .auth_reply
        .try_send(crate::ssh::AuthReply {
            challenge,
            responses,
        })
        .map_err(|_| "이미 응답했거나 연결이 종료되었습니다.".into())
}
#[tauri::command]
pub fn terminal_input(
    window: tauri::WebviewWindow,
    state: State<AppState>,
    id: String,
    data: String,
) -> Result<()> {
    state.broadcast.send(
        &state.connections,
        &state.locals,
        &id,
        window.label(),
        &data,
    )
}
#[tauri::command]
pub fn terminal_resize(
    window: tauri::WebviewWindow,
    state: State<AppState>,
    id: String,
    cols: u32,
    rows: u32,
) -> Result<()> {
    state
        .connections
        .control(&id)?
        .broker
        .check(window.label())?;
    if !(2..=1000).contains(&cols) || !(1..=500).contains(&rows) {
        return Err("PTY 크기 범위 오류".into());
    }
    state
        .connections
        .control(&id)?
        .input
        .try_send(Input::Resize(cols, rows))
        .map_err(|_| "크기 변경 대기열이 가득 찼습니다.".into())
}
#[tauri::command]
pub fn terminal_ack(
    window: tauri::WebviewWindow,
    state: State<AppState>,
    id: String,
    seq: u64,
) -> Result<()> {
    state
        .connections
        .control(&id)?
        .broker
        .check(window.label())?;
    state
        .connections
        .control(&id)?
        .ack
        .send_if_modified(|current| {
            if seq > *current {
                *current = seq;
                true
            } else {
                false
            }
        });
    Ok(())
}
