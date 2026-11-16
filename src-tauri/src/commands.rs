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
    mut profile: Profile,
    secret_action: String,
    secret: Option<String>,
    proxy_secret_action: Option<String>,
    proxy_secret: Option<String>,
) -> Result<Profile> {
    let secret = secret.map(Zeroizing::new);
    let proxy_secret = proxy_secret.map(Zeroizing::new);
    profile.validate()?;
    let proxy_secret = match proxy_secret_action.as_deref() {
        None | Some("keep") => None,
        Some("forget") => Some(None),
        Some("replace") => Some(Some(check_proxy_secret(&profile, proxy_secret)?)),
        Some(_) => return Err("프록시 암호 저장 방식이 올바르지 않습니다.".into()),
    };
    if matches!(profile.auth.as_str(), "agent" | "interactive") && secret_action == "replace" {
        return Err("에이전트·추가 인증 응답은 저장할 수 없습니다.".into());
    }
    let _guard = state.mutation.lock().unwrap();
    if !profile.id.is_empty() {
        crate::maintenance::snapshot(&state.store, &state.directory)?;
    }
    // Detection fills this, and a form opened before that must not wipe it.
    profile.kube = if profile.id.is_empty() {
        None
    } else {
        state.store.profile(&profile.id)?.kube
    };
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
    let result = state
        .store
        .save(profile, new)
        .and_then(|saved| match proxy_secret {
            None => Ok(saved),
            Some(None) => state.store.set_proxy_secret(&saved.id, None),
            Some(Some(value)) => {
                let reference = state.vault.save(&state.store, &value)?;
                state.store.set_proxy_secret(&saved.id, Some(&reference))
            }
        });
    // A failed OS cleanup stays journaled and is reported by the next snapshot.
    let _ = state.store.cleanup_credentials();
    result
}
/// A proxy password to store: SOCKS5 carries at most 255 bytes, and only a named account has one.
fn check_proxy_secret(
    profile: &Profile,
    value: Option<Zeroizing<String>>,
) -> Result<Zeroizing<String>> {
    let proxy = (profile.proxy.as_ref()).ok_or("프록시를 지정해야 암호를 저장할 수 있습니다.")?;
    if proxy.endpoint().is_none_or(|e| e.username.is_empty()) {
        return Err("프록시 사용자 이름을 입력해야 암호를 저장할 수 있습니다.".into());
    }
    let value = value.ok_or("저장할 프록시 암호를 입력하세요.")?;
    if value.len() > crate::storage::MAX_PROXY_FIELD {
        return Err("프록시 암호는 255바이트 이하여야 합니다.".into());
    }
    Ok(value)
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
// Tauri passes each IPC argument separately; `launch` is the one-time start command (DX.7).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn connect(
    app: tauri::AppHandle,
    id: String,
    profile_id: String,
    expected: Profile,
    secret: Option<String>,
    remember: Option<bool>,
    launch: Option<crate::terminal_start::Launch>,
    on_event: Channel<Event>,
) -> Result<()> {
    let secret = secret.map(Zeroizing::new);
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
        || profile.cert_path != expected.cert_path
        || profile.agent_source != expected.agent_source
        || !same_proxy(&profile, &expected)
    {
        return Err("저장된 연결 대상이 변경되었습니다. 세션 목록에서 다시 연결하세요.".into());
    }
    if let Some(launch) = &launch {
        launch.check(&profile)?;
    }
    let remember = remember.unwrap_or(false)
        && secret.is_some()
        && matches!(profile.auth.as_str(), "password" | "key");
    let original_ref = state.store.secret_ref(&profile_id)?;
    let secret = match secret {
        Some(s) if s.len() <= 16384 => s,
        Some(_) => return Err("인증정보가 너무 깁니다.".into()),
        None => saved_secret(&state, &profile_id)?.unwrap_or_default(),
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
    let route = route_secrets(&state, &profile)?;
    if let Some(launch) = launch {
        state.connections.launches.put(&id, launch);
    }
    let launch_id = id.clone();
    let started = state.connections.start_route(
        id,
        profile,
        secret,
        route,
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
    );
    if started.is_err() {
        state.connections.launches.take(&launch_id);
    }
    started
}
/// The session's own secret, when one is saved.
pub(crate) fn saved_secret(state: &AppState, id: &str) -> Result<Option<Zeroizing<String>>> {
    let _guard = state.mutation.lock().unwrap();
    match state.store.secret_ref(id)? {
        Some(reference) => state.vault.get(&state.store, &reference).map(Some),
        None => Ok(None),
    }
}
/// The jump hosts on the way to a session with the secrets saved for them, and the saved password
/// of the proxy the first of them (or the session itself) connects through.
pub(crate) fn route_secrets(state: &AppState, profile: &Profile) -> Result<crate::ssh::Secrets> {
    let _guard = state.mutation.lock().unwrap();
    let mut route = crate::routes::resolve(profile, &state.store.list()?.profiles)?;
    let proxy = match route.first().and_then(|p| p.proxy.as_ref()?.secret_ref()) {
        Some(reference) => Some(state.vault.get(&state.store, reference)?),
        None => None,
    };
    route.pop();
    let hops = route
        .into_iter()
        .map(|p| {
            let secret = match state.store.secret_ref(&p.id)? {
                Some(reference) => Some(state.vault.get(&state.store, &reference)?),
                None => None,
            };
            Ok((p, secret))
        })
        .collect::<Result<_>>()?;
    Ok(crate::ssh::Secrets { hops, proxy })
}
/// The proxy the tab was opened for, ignoring the password reference the backend keeps.
fn same_proxy(a: &Profile, b: &Profile) -> bool {
    match (&a.proxy, &b.proxy) {
        (None, None) => true,
        (Some(a), Some(b)) => a.same_target(b),
        _ => false,
    }
}
pub(crate) fn same_credential_target(a: &Profile, b: &Profile) -> bool {
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
/// engineering-rules §5: a command wraps every secret argument in `Zeroizing` before anything else,
/// so no early return leaves the plain text in memory. S.11 found `connect` returning first.
#[cfg(test)]
mod secret_argument_tests {
    const SECRETS: &[&str] = &[
        "secret",
        "password",
        "new_password",
        "passphrase",
        "proxy_secret",
    ];

    fn sources(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).unwrap().map(Result::unwrap) {
            let path = entry.path();
            if path.is_dir() {
                sources(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                let text = std::fs::read_to_string(&path).unwrap();
                out.push((path.display().to_string(), text));
            }
        }
    }

    /// Secret parameters of each command that are not wrapped by its first statements.
    fn unwrapped(source: &str) -> Vec<String> {
        let mut found = Vec::new();
        for command in source.split("#[tauri::command]").skip(1) {
            let Some(body) = command.find('{') else {
                continue;
            };
            let (signature, body) = command.split_at(body);
            let name = signature
                .split("fn ")
                .nth(1)
                .and_then(|s| s.split('(').next());
            let secrets: Vec<_> = (signature.split(['(', ',']))
                .filter_map(|param| param.trim().split_once(':'))
                .filter(|(name, ty)| SECRETS.contains(&name.trim()) && ty.contains("String"))
                .map(|(name, _)| name.trim())
                .collect();
            let first: Vec<_> = (body[1..].lines().map(str::trim))
                .filter(|l| !l.is_empty())
                .take(secrets.len())
                .collect();
            for secret in secrets {
                let wrapped = first.iter().any(|line| {
                    line.starts_with(&format!("let {secret} = ")) && line.contains("Zeroizing")
                });
                if !wrapped {
                    found.push(format!("{}({secret})", name.unwrap_or("?")));
                }
            }
        }
        found
    }

    #[test]
    fn every_command_wraps_its_secrets_before_anything_else() {
        let mut files = Vec::new();
        sources(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
            &mut files,
        );
        let found: Vec<_> = (files.iter())
            .flat_map(|(path, text)| {
                unwrapped(text)
                    .into_iter()
                    .map(move |f| format!("{path}: {f}"))
            })
            .collect();
        assert!(found.is_empty(), "{found:#?}");
    }

    #[test]
    fn an_early_return_before_the_wrap_is_found() {
        let before = "#[tauri::command]\npub async fn connect(\n    id: String,\n    secret: Option<String>,\n) -> Result<()> {\n    if id.is_empty() {\n        return Err(\"id\".into());\n    }\n    let secret = secret.map(Zeroizing::new);\n}\n";
        assert_eq!(unwrapped(before), ["connect(secret)"]);
        let after = before.replacen(
            "    if id",
            "    let secret = secret.map(Zeroizing::new);\n    if id",
            1,
        );
        assert!(unwrapped(&after).is_empty());
    }
}
