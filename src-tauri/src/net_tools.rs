//! Network tools (TL). `link` is the connection a remote source runs over and `dial` the one TCP
//! connection a tool makes through it or from this PC.
mod dial;
mod fallback;
mod jobs;
mod limited;
pub mod link;
mod listener_parse;
mod listeners;
#[cfg(windows)]
mod listeners_windows;
mod port_check;
mod service_check;
mod service_http;
mod service_target;
mod service_tls;
mod targets;
mod trace;
mod trace_parse;
#[cfg(windows)]
mod trace_windows;

pub use jobs::Jobs;

use crate::{
    AppState,
    ssh::{Event, Sink},
    storage::Result,
};
use serde::Deserialize;
use std::sync::{Arc, atomic::Ordering};
use tauri::{Manager, State, ipc::Channel};
use uuid::Uuid;

/// Where a tool runs from. `connection_id` is the tool tab's link, not a terminal's connection.
#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SourceArg {
    Local,
    Remote { connection_id: String },
}

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

/// Starts a port check, or says what confirming it would mean. Results come as events.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn net_port_check(
    state: State<'_, AppState>,
    source: SourceArg,
    targets: String,
    ports: String,
    timeout_seconds: u64,
    job_id: String,
    confirmed: bool,
    on_event: Channel<port_check::Event>,
) -> Result<port_check::Start> {
    if Uuid::parse_str(&job_id).is_err() {
        return Err("잘못된 작업 ID".into());
    }
    port_check::start(
        state.connections.clone(),
        port_check::Request {
            source,
            targets,
            ports,
            timeout_seconds,
            job_id,
            confirmed,
            events: Arc::new(move |event| {
                on_event
                    .send(event)
                    .map_err(|_| "도구 구독이 종료되었습니다.".into())
            }),
        },
    )
}

#[tauri::command]
pub async fn net_listeners(
    state: State<'_, AppState>,
    source: SourceArg,
) -> Result<listeners::Report> {
    match source {
        SourceArg::Local => listeners::local().await,
        SourceArg::Remote { connection_id } => {
            let handle = state
                .connections
                .net
                .handle(&state.connections, &connection_id)?;
            listeners::remote(&handle).await
        }
    }
}

/// None when it was cancelled.
#[tauri::command]
pub async fn net_service_check(
    state: State<'_, AppState>,
    source: SourceArg,
    target: String,
    format: service_target::Format,
    job_id: String,
) -> Result<Option<service_check::Report>> {
    if Uuid::parse_str(&job_id).is_err() {
        return Err("잘못된 작업 ID".into());
    }
    service_check::run(state.connections.clone(), source, &target, format, job_id).await
}

/// Starts tracing the route. Hops and the conclusion come as events.
#[tauri::command]
pub async fn net_trace(
    state: State<'_, AppState>,
    source: SourceArg,
    host: String,
    port: u16,
    job_id: String,
    on_event: Channel<trace::Event>,
) -> Result<()> {
    if Uuid::parse_str(&job_id).is_err() {
        return Err("잘못된 작업 ID".into());
    }
    trace::start(
        state.connections.clone(),
        trace::Request {
            source,
            host,
            port,
            job_id,
            events: Arc::new(move |event| {
                on_event
                    .send(event)
                    .map_err(|_| "도구 구독이 종료되었습니다.".into())
            }),
        },
    )
}

#[tauri::command]
pub fn net_cancel(state: State<AppState>, job_id: String) -> Result<()> {
    state.connections.net.jobs.cancel(&job_id);
    Ok(())
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "연결 정보를 읽지 못했습니다.".to_string())?
}
