//! Pod shell and log tabs. Never members of the shell broadcast or snippet targets.
mod launch;
use crate::{
    AppState,
    ssh::{Event, Input},
    storage::Result,
};
pub use launch::Launch;
use launch::{Labels, LocalPod};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{State, ipc::Channel};
use tokio::sync::{mpsc, watch};
struct Control {
    input: mpsc::Sender<Input>,
    stop: watch::Sender<bool>,
    ack: watch::Sender<u64>,
}
#[derive(Default)]
pub struct Terminals {
    entries: Mutex<HashMap<String, Arc<Control>>>,
    closing: AtomicBool,
}
impl Terminals {
    pub fn is_empty(&self) -> bool {
        self.entries.lock().unwrap().is_empty()
    }
    pub fn shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        for c in self.entries.lock().unwrap().values() {
            let _ = c.stop.send(true);
        }
    }
    fn control(&self, id: &str) -> Result<Arc<Control>> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("쿠버네티스 터미널 탭이 종료되었습니다.".into())
    }
}
// Closing on drop also covers cancellation/timeouts before the PTY task is installed.
struct RemoteChannel(Option<russh::Channel<russh::client::Msg>>);
impl std::ops::Deref for RemoteChannel {
    type Target = russh::Channel<russh::client::Msg>;
    fn deref(&self) -> &Self::Target {
        self.0.as_ref().unwrap()
    }
}
impl std::ops::DerefMut for RemoteChannel {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.0.as_mut().unwrap()
    }
}
impl Drop for RemoteChannel {
    fn drop(&mut self) {
        if let Some(channel) = self.0.take() {
            tokio::spawn(async move {
                let _ = channel.signal(russh::Sig::TERM).await;
                let _ = channel.close().await;
            });
        }
    }
}
fn emit(sink: &Channel<Event>, status: &str, message: &str) {
    let _ = sink.send(Event::State {
        status: status.into(),
        message: message.into(),
    });
}
#[tauri::command]
pub async fn kube_terminal_open(
    state: State<'_, AppState>,
    id: String,
    launch: Launch,
    cols: u16,
    rows: u16,
    on_event: Channel<Event>,
) -> Result<()> {
    uuid::Uuid::parse_str(&id).map_err(|_| "터미널 ID 오류")?;
    if !(2..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err("PTY 크기 오류".into());
    }
    let (tx, rx) = mpsc::channel(32);
    let (stop, stopped) = watch::channel(false);
    let (ack, acked) = watch::channel(0);
    let manager = state.kube_terminals.clone();
    {
        let mut entries = manager.entries.lock().unwrap();
        if manager.closing.load(Ordering::SeqCst)
            || entries.len() >= 16
            || entries.contains_key(&id)
        {
            return Err("쿠버네티스 터미널 탭 상한(16개) 또는 앱 종료 중입니다.".into());
        }
        entries.insert(
            id.clone(),
            Arc::new(Control {
                input: tx,
                stop,
                ack,
            }),
        );
    }
    let launch::Prepared {
        connection,
        command,
        labels,
        local,
    } = match launch::prepare(&state, &launch).await {
        Ok(v) => v,
        Err(e) => {
            manager.entries.lock().unwrap().remove(&id);
            return Err(e);
        }
    };
    let result = match local {
        Some(pod) => {
            start_local(
                &state,
                id.clone(),
                pod,
                cols,
                rows,
                on_event,
                rx,
                stopped,
                acked,
                labels,
            )
            .await
        }
        None => {
            start_ssh(
                &state,
                id.clone(),
                &connection,
                command,
                cols,
                rows,
                on_event,
                rx,
                stopped,
                acked,
                labels,
            )
            .await
        }
    };
    if result.is_err() {
        manager.entries.lock().unwrap().remove(&id);
    }
    result
}
#[allow(clippy::too_many_arguments)]
async fn start_ssh(
    state: &AppState,
    id: String,
    connection: &str,
    command: String,
    cols: u16,
    rows: u16,
    sink: Channel<Event>,
    mut rx: mpsc::Receiver<Input>,
    mut stop: watch::Receiver<bool>,
    mut ack: watch::Receiver<u64>,
    labels: Labels,
) -> Result<()> {
    let handle = state.connections.handle(connection)?;
    let mut parent = state.connections.control(connection)?.stop.subscribe();
    let channel = tokio::time::timeout(Duration::from_secs(15), async {
        let mut c = RemoteChannel(Some(handle.channel_open_session().await?));
        c.request_pty(true, "xterm-256color", cols.into(), rows.into(), 0, 0, &[])
            .await?;
        c.exec(true, command).await?;
        Ok::<_, russh::Error>(c.0.take().unwrap())
    })
    .await
    .map_err(|_| "터미널을 여는 시간이 초과되었습니다.")?
    .map_err(|error| match error {
        russh::Error::ChannelOpenFailure(_) => "서버의 동시 세션 한도(MaxSessions)에 걸려 터미널을 열 수 없습니다. 다른 탭이나 파일 전송을 줄이고 다시 시도하세요.",
        _ => "터미널을 열지 못했습니다.",
    })?;
    let manager = state.kube_terminals.clone();
    tokio::spawn(async move {
        let (mut reader, writer) = channel.split();
        emit(&sink, "connected", &labels.title);
        let output = async {
            let mut seq = 0;
            while let Some(m) = reader.wait().await {
                match m {
                    russh::ChannelMsg::Data { data }
                    | russh::ChannelMsg::ExtendedData { data, .. } => {
                        for bytes in data.chunks(32768) {
                            seq += 1;
                            sink.send(Event::Data {
                                seq,
                                bytes: bytes.to_vec(),
                            })
                            .map_err(|_| "출력 구독 종료")?;
                            tokio::time::timeout(Duration::from_secs(30), async {
                                while *ack.borrow_and_update() < seq {
                                    ack.changed().await.map_err(|_| "출력 ACK 종료")?;
                                }
                                Ok::<_, String>(())
                            })
                            .await
                            .map_err(|_| "출력 ACK 시간 초과")??;
                        }
                    }
                    russh::ChannelMsg::ExitStatus { exit_status } if exit_status != 0 => {
                        return Err(labels.failed.to_string());
                    }
                    _ => {}
                }
            }
            Ok::<_, String>(())
        };
        let input = async {
            while let Some(v) = rx.recv().await {
                match v {
                    Input::Data(b) => writer.data(&b[..]).await,
                    Input::Resize(c, r) => writer.window_change(c, r, 0, 0).await,
                }
                .map_err(|_| "터미널 입력 실패")?;
            }
            Ok::<_, String>(())
        };
        let result = tokio::select! {biased;_ = stop.changed()=>Ok(()),_ = parent.changed()=>Ok(()),r=output=>r,r=input=>r};
        let _ = writer.signal(russh::Sig::TERM).await;
        // Give the remote kubectl time to act on the signal before the channel goes.
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            while reader.wait().await.is_some() {}
        })
        .await;
        let _ = writer.close().await;
        manager.entries.lock().unwrap().remove(&id);
        match result {
            Ok(()) => emit(&sink, "closed", labels.closed),
            Err(e) => emit(&sink, "error", &e),
        };
    });
    Ok(())
}
#[allow(clippy::too_many_arguments)]
async fn start_local(
    state: &AppState,
    id: String,
    pod: LocalPod,
    cols: u16,
    rows: u16,
    sink: Channel<Event>,
    mut rx: mpsc::Receiver<Input>,
    stop: watch::Receiver<bool>,
    ack: watch::Receiver<u64>,
    labels: Labels,
) -> Result<()> {
    let (program, args, env, mut filter) = launch::pty_process(pod);
    let manager = state.kube_terminals.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| "터미널 PTY 생성 실패")?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|_| "터미널 읽기 생성 실패")?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|_| "터미널 입력 생성 실패")?;
        let mut cmd = portable_pty::CommandBuilder::new(program);
        cmd.args(args);
        cmd.env("TERM", "xterm-256color");
        env.into_iter().for_each(|(key, value)| cmd.env(key, value));
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|_| "kubectl 실행 실패")?;
        drop(pair.slave);
        let mut killer = child.clone_killer();
        let finished = Arc::new(AtomicBool::new(false));
        let child_failed = Arc::new(AtomicBool::new(false));
        let child_result = child_failed.clone();
        let end = finished.clone();
        let input_stop = stop.clone();
        std::thread::spawn(move || {
            child_result.store(!child.wait().is_ok_and(|s| s.success()), Ordering::SeqCst);
            end.store(true, Ordering::SeqCst);
        });
        let end = finished.clone();
        std::thread::spawn(move || {
            while !*input_stop.borrow() && !end.load(Ordering::SeqCst) {
                match rx.try_recv() {
                    Ok(Input::Data(b)) => {
                        if writer.write_all(&b).and_then(|_| writer.flush()).is_err() {
                            break;
                        }
                    }
                    Ok(Input::Resize(c, r)) => {
                        let _ = pair.master.resize(portable_pty::PtySize {
                            cols: c as u16,
                            rows: r as u16,
                            pixel_width: 0,
                            pixel_height: 0,
                        });
                    }
                    Err(mpsc::error::TryRecvError::Empty) => {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => break,
                }
            }
            if !end.load(Ordering::SeqCst) {
                let _ = writer.write_all(b"\x03");
                let _ = writer.flush();
                for _ in 0..100 {
                    if end.load(Ordering::SeqCst) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
                if !end.load(Ordering::SeqCst) {
                    let _ = killer.kill();
                }
            }
        });
        emit(&sink, "connected", &labels.title);
        std::thread::spawn(move || {
            let mut bytes = [0u8; 32768];
            let mut seq = 0;
            let mut failed = false;
            while let Ok(n) = reader.read(&mut bytes) {
                if n == 0 {
                    break;
                }
                let data = filter
                    .as_mut()
                    .map_or_else(|| bytes[..n].to_vec(), |f| f.push(&bytes[..n]));
                if *stop.borrow() || data.is_empty() {
                    continue;
                }
                seq += 1;
                if sink.send(Event::Data { seq, bytes: data }).is_err() {
                    failed = true;
                    break;
                }
                let until = std::time::Instant::now() + Duration::from_secs(30);
                while *ack.borrow() < seq && !*stop.borrow() {
                    if std::time::Instant::now() > until {
                        failed = true;
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                if failed {
                    break;
                }
            }
            if finished.load(Ordering::SeqCst)
                && child_failed.load(Ordering::SeqCst)
                && !*stop.borrow()
            {
                failed = true;
            }
            if let Ok(c) = manager.control(&id) {
                let _ = c.stop.send(true);
            }
            manager.entries.lock().unwrap().remove(&id);
            let (status, text) = if failed {
                ("error", labels.failed)
            } else {
                ("closed", labels.closed)
            };
            emit(&sink, status, text);
        });
        Ok(())
    })
    .await
    .map_err(|_| "터미널 PTY 작업 실패")?
}
#[tauri::command]
pub fn kube_terminal_input(state: State<AppState>, id: String, data: String) -> Result<()> {
    if data.len() > 16384 {
        return Err("터미널 입력 상한 초과".into());
    }
    state
        .kube_terminals
        .control(&id)?
        .input
        .try_send(Input::Data(data.into_bytes()))
        .map_err(|_| "터미널 입력 대기열 초과".into())
}
#[tauri::command]
pub fn kube_terminal_resize(
    state: State<AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    if !(2..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err("PTY 크기 오류".into());
    }
    state
        .kube_terminals
        .control(&id)?
        .input
        .try_send(Input::Resize(cols.into(), rows.into()))
        .map_err(|_| "터미널 resize 대기열 초과".into())
}
#[tauri::command]
pub fn kube_terminal_ack(state: State<AppState>, id: String, seq: u64) -> Result<()> {
    let c = state.kube_terminals.control(&id)?;
    if seq == *c.ack.borrow() + 1 {
        let _ = c.ack.send(seq);
    }
    Ok(())
}
#[tauri::command]
pub fn kube_terminal_close(state: State<AppState>, id: String) {
    if let Ok(c) = state.kube_terminals.control(&id) {
        let _ = c.stop.send(true);
    }
}
