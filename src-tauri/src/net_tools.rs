//! Network tools (TL). `link` is the connection a remote source runs over.
pub mod link;

use crate::{
    AppState,
    ssh::{Event, Sink},
    storage::Result,
};
use std::sync::{Arc, atomic::Ordering};
use tauri::{Manager, State, ipc::Channel};
use uuid::Uuid;

/// Connects a tool tab's remote source. State, login questions and trust come as events, and are
/// answered with `auth_reply` and `trust_host`. Calling it again for a live link counts as a use.
#[tauri::command]
pub async fn net_connect(
    app: tauri::AppHandle,
    id: String,
    profile_id: String,
    on_event: Channel<Event>,
) -> Result<()> {
    if Uuid::parse_str(&id).is_err() {
        return Err("잘못된 연결 ID".into());
    }
    let state = app.state::<AppState>();
    if state.closing.load(Ordering::SeqCst) {
        return Err("앱이 종료 중입니다.".into());
    }
    let connections = state.connections.clone();
    if connections.net.handle(&connections, &id).is_ok() {
        return Ok(());
    }
    let sink: Sink = Arc::new(move |event| {
        on_event
            .send(event)
            .map_err(|_| "도구 구독이 종료되었습니다.".into())
    });
    let reader = app.clone();
    let profile = blocking(move || reader.state::<AppState>().store.profile(&profile_id)).await?;
    if profile.protocol != "ssh" {
        return Err("SSH 세션만 출발지로 쓸 수 있습니다.".into());
    }
    if let Some(terminal) = link::reusable(&connections, &profile) {
        connections.net.reuse(&connections, id, terminal, sink);
        return Ok(());
    }
    let reader = app.clone();
    let target = profile.clone();
    let (secret, hops) = blocking(move || {
        let state = reader.state::<AppState>();
        let secret = crate::commands::saved_secret(&state, &target.id)?;
        let hops = crate::commands::hop_secrets(&state, &target)?;
        Ok((secret, hops))
    })
    .await?;
    link::start(link::Start {
        connections,
        id,
        profile,
        secret,
        hops,
        paths: state.known_hosts.clone(),
        sink,
        store: state.store.clone(),
    })
}

/// Lets go of a tool tab's source. A terminal connection it was reusing stays open.
#[tauri::command]
pub fn net_disconnect(state: State<AppState>, id: String) -> Result<()> {
    state.connections.net.close(&state.connections, &id);
    Ok(())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "연결 정보를 읽지 못했습니다.".to_string())?
}
