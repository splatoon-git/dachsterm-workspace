//! Agent chat (AC, docs/design/agent-chat.md): a saved SSH session opened as a conversation instead
//! of a terminal. The connection stops after login (`login_only`), the agent CLI runs detached on
//! the server (`runner`), and its output reaches the tab as `ChatEvent`s.
mod claude;
mod event;
mod runner;

use crate::{
    AppState, login_only,
    ssh::{Event, Host, Sink},
    storage::Result,
};
pub use event::{ChatEvent, EndReason};
use russh::client;
use std::{
    collections::HashMap,
    ops::ControlFlow,
    sync::{Arc, Mutex, atomic::Ordering},
};
use tauri::{Manager, State, async_runtime::JoinHandle, ipc::Channel};
use uuid::Uuid;

/// Open chats by their tab's connection ID. One chat tab owns one connection.
#[derive(Default)]
pub struct Chats {
    entries: Mutex<HashMap<String, Arc<Chat>>>,
}

struct Chat {
    /// The runner's folder name on the server.
    runner: String,
    /// One message at a time, so the agent reads them in the order they were sent.
    sending: tokio::sync::Mutex<()>,
    reading: Mutex<Option<JoinHandle<()>>>,
}

impl Chats {
    fn get(&self, id: &str) -> Result<Arc<Chat>> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "채팅이 시작되지 않았습니다.".into())
    }
    /// Forgets a chat and stops reading its output. The runner on the server is left as it is.
    fn take(&self, id: &str) -> Option<Arc<Chat>> {
        let chat = self.entries.lock().unwrap().remove(id)?;
        if let Some(reading) = chat.reading.lock().unwrap().take() {
            reading.abort();
        }
        Some(chat)
    }
}

/// Logs in to the session for a chat tab. State, login questions and host keys come as the same
/// events a terminal gets, and are answered with `auth_reply` and `trust_host`.
#[tauri::command]
pub async fn chat_open(
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
    let profile = login_only::saved_profile(&app, profile_id).await?;
    if profile.protocol != "ssh" {
        return Err("SSH 세션만 채팅으로 열 수 있습니다.".into());
    }
    let sink: Sink = Arc::new(move |event| {
        on_event
            .send(event)
            .map_err(|_| "채팅 구독이 종료되었습니다.".into())
    });
    let request = login_only::request(&app, id.clone(), profile, sink).await?;
    let chats = state.chats.clone();
    login_only::start(request, None, || {}, move || drop(chats.take(&id)))
}

/// Starts the agent in `folder` (empty: the login folder) on a connected chat tab.
#[tauri::command]
pub async fn chat_start(
    state: State<'_, AppState>,
    id: String,
    folder: String,
    on_event: Channel<ChatEvent>,
) -> Result<()> {
    if let Some(problem) = runner::folder_problem(&folder) {
        return Err(problem.into());
    }
    let handle = state.connections.handle(&id)?;
    if state.chats.entries.lock().unwrap().contains_key(&id) {
        return Err("이미 시작한 채팅입니다.".into());
    }
    let program = runner::locate(&handle, claude::PROGRAM).await?;
    let name = Uuid::new_v4().simple().to_string();
    let argv: Vec<String> = std::iter::once(program)
        .chain(claude::arguments())
        .collect();
    runner::start(&handle, &name, &folder, &argv).await?;
    let chat = Arc::new(Chat {
        runner: name.clone(),
        sending: Default::default(),
        reading: Mutex::new(None),
    });
    let raced = {
        let mut entries = state.chats.entries.lock().unwrap();
        let raced = entries.contains_key(&id);
        if !raced {
            entries.insert(id.clone(), chat.clone());
        }
        raced
    };
    if raced {
        let _ = runner::stop(&handle, &name).await;
        return Err("이미 시작한 채팅입니다.".into());
    }
    let task = tauri::async_runtime::spawn(read(handle, name, on_event));
    *chat.reading.lock().unwrap() = Some(task);
    Ok(())
}

/// Hands the agent one user message. Messages queue on the server while a turn is running.
#[tauri::command]
pub async fn chat_send(state: State<'_, AppState>, id: String, text: String) -> Result<()> {
    if text.trim().is_empty() {
        return Err("보낼 내용을 입력하세요.".into());
    }
    let line = claude::user_message(&text);
    if line.len() > runner::MAX_MESSAGE {
        return Err("메시지가 너무 깁니다.".into());
    }
    let chat = state.chats.get(&id)?;
    let handle = state.connections.handle(&id)?;
    let _order = chat.sending.lock().await;
    runner::send(&handle, &chat.runner, &line).await
}

/// Ends the agent, removes its folder on the server and closes the tab's connection.
#[tauri::command]
pub async fn chat_close(state: State<'_, AppState>, id: String) -> Result<()> {
    if let Some(chat) = state.chats.take(&id)
        && let Ok(handle) = state.connections.handle(&id)
    {
        // A runner that cannot be stopped now keeps waiting on the server; it ends with the
        // server's own cleanup or a later chat's (AC.9).
        let _ = runner::stop(&handle, &chat.runner).await;
    }
    if let Ok(control) = state.connections.control(&id) {
        let _ = control.stop.send(true);
    }
    Ok(())
}

async fn read(handle: Arc<client::Handle<Host>>, runner: String, events: Channel<ChatEvent>) {
    let mut reader = claude::Reader::default();
    let mut offset = 0;
    let result = runner::attach(&handle, &runner, &mut offset, |line| {
        for event in reader.read(line) {
            if events.send(event).is_err() {
                return ControlFlow::Break(());
            }
        }
        ControlFlow::Continue(())
    })
    .await;
    let (reason, detail) = match result {
        Ok(runner::Attached::Stopped) => return,
        Ok(runner::Attached::Exited) => (
            EndReason::Exited,
            runner::last_error(&handle, &runner).await,
        ),
        Err(_) if handle.is_closed() => (EndReason::Disconnected, None),
        Err(message) => (EndReason::Unreadable, Some(message)),
    };
    let _ = events.send(ChatEvent::Ended { reason, detail });
}
