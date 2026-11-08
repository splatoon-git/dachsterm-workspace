use crate::{
    AppState,
    ssh::{Event, Sink},
    storage::{Profile, Result},
};
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tauri::{Manager, State, ipc::Channel};
pub struct Broker {
    inner: Mutex<Stream>,
}
struct Stream {
    target: Sink,
    history: VecDeque<Event>,
    bytes: usize,
    state: Option<Event>,
    owner: String,
}
impl Broker {
    pub fn new(target: Sink) -> Self {
        Self {
            inner: Mutex::new(Stream {
                target,
                history: VecDeque::new(),
                bytes: 0,
                state: None,
                owner: "main".into(),
            }),
        }
    }
    pub fn send(&self, event: Event) -> Result<()> {
        let mut s = self.inner.lock().unwrap();
        if let Event::Data { bytes, .. } = &event {
            s.bytes += bytes.len();
            s.history.push_back(event.clone());
            while s.bytes > 2 * 1024 * 1024 {
                if let Some(Event::Data { bytes, .. }) = s.history.pop_front() {
                    s.bytes -= bytes.len();
                }
            }
        } else if !matches!(
            event,
            Event::AgentSign(_) | Event::AgentNotice { .. } | Event::GitCredential(_)
        ) {
            // A sign request is answered once or refused by timeout. Replaying it to another
            // window would also hide the connection state behind it.
            s.state = Some(event.clone());
        }
        (s.target)(event)
    }
    pub fn check(&self, label: &str) -> Result<()> {
        if self.inner.lock().unwrap().owner == label {
            Ok(())
        } else {
            Err("다른 창이 이 터미널을 소유하고 있습니다.".into())
        }
    }
    pub fn attach(&self, label: String, target: Sink) -> Result<()> {
        let mut s = self.inner.lock().unwrap();
        target(Event::Replay { active: true })?;
        if let Some(state) = s.state.clone() {
            target(state)?;
        }
        for event in &s.history {
            target(event.clone())?;
        }
        target(Event::Replay { active: false })?;
        s.owner = label;
        s.target = target;
        Ok(())
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detached {
    pub id: String,
    pub profile: Profile,
    pub cols: u32,
    pub rows: u32,
}
#[tauri::command]
pub async fn detach_terminal(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    id: String,
    profile: Profile,
    cols: u32,
    rows: u32,
) -> Result<()> {
    let c = state.connections.control(&id)?;
    c.broker.check(window.label())?;
    state.connections.handle(&id)?;
    if !(2..=1000).contains(&cols) || !(1..=500).contains(&rows) {
        return Err("터미널 크기 오류".into());
    }
    let label = format!("terminal-{id}");
    if app.get_webview_window(&label).is_some() {
        return Err("이미 분리된 창입니다.".into());
    }
    state.detached.lock().unwrap().insert(
        id.clone(),
        Detached {
            id: id.clone(),
            profile: profile.clone(),
            cols,
            rows,
        },
    );
    let url = format!("index.html?detached={id}");
    let builder =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(url.into()))
            .title(format!("{} — DachsTerm", profile.name))
            .inner_size(1000.0, 700.0)
            .min_inner_size(560.0, 480.0);
    // The page draws one title bar, as in the main window (tauri.windows/macos.conf.json).
    #[cfg(windows)]
    let builder = builder.decorations(false);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    // WebView2 requires the same environment options for windows sharing a user data folder.
    #[cfg(windows)]
    let builder = {
        let config = &app.config().app.windows[0];
        let builder = if let Some(path) = &config.data_directory {
            builder.data_directory(path.clone())
        } else {
            builder
        };
        if let Some(args) = &config.additional_browser_args {
            builder.additional_browser_args(args)
        } else {
            builder
        }
    };
    let result = builder.build();
    if let Err(error) = result {
        state.detached.lock().unwrap().remove(&id);
        return Err(format!("독립 창을 열 수 없습니다: {error}"));
    }
    Ok(())
}
#[tauri::command]
pub fn detached_info(
    window: tauri::WebviewWindow,
    state: State<AppState>,
    id: String,
) -> Result<Detached> {
    if window.label() != format!("terminal-{id}") {
        return Err("잘못된 창".into());
    }
    state
        .detached
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or("창 인계 정보 없음".into())
}
#[tauri::command]
pub fn attach_terminal(
    window: tauri::WebviewWindow,
    state: State<AppState>,
    id: String,
    on_event: Channel<Event>,
) -> Result<()> {
    if window.label() != format!("terminal-{id}") {
        return Err("잘못된 창".into());
    }
    state.connections.control(&id)?.broker.attach(
        window.label().into(),
        Arc::new(move |e| on_event.send(e).map_err(|_| "창 구독 종료".into())),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handoff_replays_once_and_revokes_previous_writer() {
        let old = Arc::new(Mutex::new(Vec::new()));
        let a = old.clone();
        let broker = Broker::new(Arc::new(move |event| {
            if let Event::Data { seq, .. } = event {
                a.lock().unwrap().push(seq);
            }
            Ok(())
        }));
        broker
            .send(Event::Data {
                seq: 1,
                bytes: vec![1],
            })
            .unwrap();
        let new = Arc::new(Mutex::new(Vec::new()));
        let b = new.clone();
        broker
            .attach(
                "terminal-1".into(),
                Arc::new(move |event| {
                    if let Event::Data { seq, .. } = event {
                        b.lock().unwrap().push(seq);
                    }
                    Ok(())
                }),
            )
            .unwrap();
        broker
            .send(Event::Data {
                seq: 2,
                bytes: vec![2],
            })
            .unwrap();
        assert_eq!(*old.lock().unwrap(), vec![1]);
        assert_eq!(*new.lock().unwrap(), vec![1, 2]);
        assert!(broker.check("main").is_err());
        assert!(broker.check("terminal-1").is_ok());
    }

    /// A platform file replaces the whole window list, so it must repeat the main window as is.
    #[test]
    fn platform_window_config_only_changes_the_title_bar() {
        let window = |text: &str| -> serde_json::Map<String, serde_json::Value> {
            let config: serde_json::Value = serde_json::from_str(text).unwrap();
            config["app"]["windows"][0].as_object().unwrap().clone()
        };
        let base = window(include_str!("../tauri.conf.json"));
        for (text, own) in [
            (
                include_str!("../tauri.windows.conf.json"),
                &["decorations"][..],
            ),
            (
                include_str!("../tauri.macos.conf.json"),
                &["titleBarStyle", "hiddenTitle"][..],
            ),
        ] {
            let mut platform = window(text);
            for key in own {
                assert!(platform.remove(*key).is_some(), "{key} must be set");
            }
            assert_eq!(platform, base);
        }
    }
}
