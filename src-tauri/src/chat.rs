//! Agent chat (AC, docs/design/agent-chat.md): a conversation with an agent CLI in a chat tab
//! instead of a terminal. Over SSH the connection stops after login (`login_only`) and the agent
//! runs detached on the server (`runner`); on this PC it is a child process (`local`). Either way
//! its output reaches the tab as `ChatEvent`s.
mod claude;
mod event;
mod local;
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

/// Open chats by their tab's ID, which for a chat over SSH is also its connection's ID.
#[derive(Default)]
pub struct Chats {
    entries: Mutex<HashMap<String, Arc<Chat>>>,
}

/// Where the agent runs.
enum Agent {
    /// On the server, in the runner folder of this name.
    Remote(String),
    Local(Box<local::LocalAgent>),
}

struct Chat {
    agent: Agent,
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
    /// Records a started chat, or gives back `None` if another start for this ID won the race.
    fn insert(&self, id: &str, agent: Agent) -> Option<Arc<Chat>> {
        let mut entries = self.entries.lock().unwrap();
        if entries.contains_key(id) {
            return None;
        }
        let chat = Arc::new(Chat {
            agent,
            sending: Default::default(),
            reading: Mutex::new(None),
        });
        entries.insert(id.to_string(), chat.clone());
        Some(chat)
    }
    /// Forgets a chat and stops reading its output. The agent itself is left as it is.
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
    let Some(chat) = state.chats.insert(&id, Agent::Remote(name.clone())) else {
        let _ = runner::stop(&handle, &name).await;
        return Err("이미 시작한 채팅입니다.".into());
    };
    let task = tauri::async_runtime::spawn(read(handle, name, on_event));
    *chat.reading.lock().unwrap() = Some(task);
    deliver(&state, &id, &claude::initialize_message()).await?;
    deliver(&state, &id, &claude::settings_message()).await
}

/// Starts the agent on this PC in `folder` (empty: the home folder).
#[tauri::command]
pub async fn chat_start_local(
    state: State<'_, AppState>,
    id: String,
    folder: String,
    on_event: Channel<ChatEvent>,
) -> Result<()> {
    if Uuid::parse_str(&id).is_err() {
        return Err("잘못된 채팅 ID".into());
    }
    if state.chats.entries.lock().unwrap().contains_key(&id) {
        return Err("이미 시작한 채팅입니다.".into());
    }
    let (agent, stdout, stderr) = tauri::async_runtime::spawn_blocking(move || {
        let folder = local::folder(&folder)?;
        let program = local::locate(claude::PROGRAM)?;
        local::start(&program, &claude::arguments(), &folder)
    })
    .await
    .map_err(|_| "에이전트를 실행할 수 없습니다.".to_string())??;
    let Some(chat) = state.chats.insert(&id, Agent::Local(Box::new(agent))) else {
        return Err("이미 시작한 채팅입니다.".into());
    };
    let task = tauri::async_runtime::spawn(read_local(stdout, stderr, on_event));
    *chat.reading.lock().unwrap() = Some(task);
    deliver(&state, &id, &claude::initialize_message()).await?;
    deliver(&state, &id, &claude::settings_message()).await
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
    deliver(&state, &id, &line).await
}

/// Stops the turn that is running. The agent stays and takes the next message.
#[tauri::command]
pub async fn chat_interrupt(state: State<'_, AppState>, id: String) -> Result<()> {
    deliver(&state, &id, &claude::interrupt_message()).await
}

/// Asks how full the context window is. The answer comes as a `Context` event.
#[tauri::command]
pub async fn chat_context(state: State<'_, AppState>, id: String) -> Result<()> {
    deliver(&state, &id, &claude::context_message()).await
}

/// Switches the model for the next turns. A refusal comes as a `Problem` event.
#[tauri::command]
pub async fn chat_set_model(state: State<'_, AppState>, id: String, model: String) -> Result<()> {
    if let Some(problem) = claude::model_problem(&model) {
        return Err(problem.into());
    }
    deliver(&state, &id, &claude::model_message(&model)).await
}

/// Changes the effort level for the next turns.
#[tauri::command]
pub async fn chat_set_effort(state: State<'_, AppState>, id: String, level: String) -> Result<()> {
    let line = claude::effort_message(&level).ok_or("알 수 없는 노력 수준입니다.")?;
    deliver(&state, &id, &line).await
}

/// Changes the permission mode. The new mode comes back as a `Mode` event.
#[tauri::command]
pub async fn chat_set_mode(state: State<'_, AppState>, id: String, mode: String) -> Result<()> {
    let line = claude::mode_message(&mode).ok_or("알 수 없는 권한 모드입니다.")?;
    deliver(&state, &id, &line).await
}

/// Turns Ultracode on or off for this session. It runs as a short turn of its own.
#[tauri::command]
pub async fn chat_set_ultracode(state: State<'_, AppState>, id: String, on: bool) -> Result<()> {
    deliver(&state, &id, &claude::ultracode_message(on)).await
}

/// Asks for the session's cost and the account's usage limits; they come as a `Usage` event.
#[tauri::command]
pub async fn chat_usage(state: State<'_, AppState>, id: String) -> Result<()> {
    deliver(&state, &id, &claude::usage_message()).await
}

/// One line to the agent's input, in the order lines were given.
async fn deliver(state: &AppState, id: &str, line: &str) -> Result<()> {
    let chat = state.chats.get(id)?;
    let _order = chat.sending.lock().await;
    match &chat.agent {
        Agent::Remote(name) => {
            let handle = state.connections.handle(id)?;
            runner::send(&handle, name, line).await
        }
        Agent::Local(agent) => agent.send(line).await,
    }
}

/// Ends the agent and, over SSH, removes its folder on the server and closes the connection.
#[tauri::command]
pub async fn chat_close(state: State<'_, AppState>, id: String) -> Result<()> {
    match state.chats.take(&id).as_deref().map(|chat| &chat.agent) {
        Some(Agent::Local(agent)) => agent.stop(),
        Some(Agent::Remote(name)) => {
            if let Ok(handle) = state.connections.handle(&id) {
                // A runner that cannot be stopped now keeps waiting on the server; it ends with
                // the server's own cleanup or a later chat's (AC.9).
                let _ = runner::stop(&handle, name).await;
            }
        }
        None => {}
    }
    if let Ok(control) = state.connections.control(&id) {
        let _ = control.stop.send(true);
    }
    Ok(())
}

/// Hands each output line's events to the tab, and stops once the tab has gone.
fn forward(events: &Channel<ChatEvent>) -> impl FnMut(&str) -> ControlFlow<()> + Send + '_ {
    let mut reader = claude::Reader::default();
    move |line| {
        for event in reader.read(line) {
            if events.send(event).is_err() {
                return ControlFlow::Break(());
            }
        }
        ControlFlow::Continue(())
    }
}

async fn read(handle: Arc<client::Handle<Host>>, runner: String, events: Channel<ChatEvent>) {
    let mut offset = 0;
    let result = runner::attach(&handle, &runner, &mut offset, forward(&events)).await;
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

async fn read_local(
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    events: Channel<ChatEvent>,
) {
    let errors = tauri::async_runtime::spawn(local::error_tail(stderr));
    let (reason, detail) = match local::read_lines(stdout, forward(&events)).await {
        Ok(false) => return,
        Ok(true) => (EndReason::Exited, errors.await.ok().flatten()),
        Err(message) => (EndReason::Unreadable, Some(message)),
    };
    let _ = events.send(ChatEvent::Ended { reason, detail });
}
