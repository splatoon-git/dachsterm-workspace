//! Local PTYs do not use SSH credentials or files; explicitly selected input groups may include them.
use crate::{
    AppState,
    ssh::{Event, Input},
    storage::Result,
};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{State, ipc::Channel};
use tokio::sync::mpsc;

#[derive(Clone, Serialize)]
pub struct Target {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(skip)]
    program: PathBuf,
    #[serde(skip)]
    args: Vec<String>,
}
#[derive(Serialize)]
pub struct Catalog {
    targets: Vec<Target>,
    warning: Option<String>,
}
pub struct Control {
    pub(crate) input: mpsc::Sender<Input>,
    pub(crate) name: String,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    stopped: AtomicBool,
    exited: AtomicBool,
    ack: (Mutex<u64>, Condvar),
}
impl Control {
    pub(crate) fn ready(&self) -> bool {
        !self.stopped.load(Ordering::SeqCst) && !self.exited.load(Ordering::SeqCst)
    }
    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        // Wake a blocking input worker so cancellation also drops the PTY master.
        let _ = self.input.try_send(Input::Data(Vec::new()));
        self.ack.1.notify_all();
        if !self.exited.load(Ordering::SeqCst) {
            let _ = self.killer.lock().unwrap().kill();
        }
    }
}
#[derive(Default)]
pub struct Locals {
    closing: AtomicBool,
    targets: Mutex<HashMap<String, Target>>,
    entries: Mutex<HashMap<String, Arc<Control>>>,
}
impl Locals {
    pub fn shutdown(&self) {
        self.closing.store(true, Ordering::SeqCst);
        for c in self.entries.lock().unwrap().values() {
            c.stop();
        }
    }
    pub(crate) fn control(&self, id: &str) -> Result<Arc<Control>> {
        self.entries
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("로컬 터미널이 종료되었습니다.".into())
    }
    pub(crate) fn active(&self) -> Vec<(String, Arc<Control>)> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, c)| c.ready())
            .map(|(id, c)| (id.clone(), c.clone()))
            .collect()
    }
}
fn target(id: &str, name: &str, kind: &str, program: PathBuf, args: &[&str]) -> Target {
    Target {
        id: id.into(),
        name: name.into(),
        kind: kind.into(),
        program,
        args: args.iter().map(|s| (*s).into()).collect(),
    }
}
#[cfg(windows)]
fn decode_wsl(bytes: &[u8]) -> String {
    if bytes.contains(&0) || bytes.starts_with(&[0xff, 0xfe]) {
        String::from_utf16_lossy(
            &bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u16::from_le_bytes([b[0], b[1]]))
                .collect::<Vec<_>>(),
        )
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}
#[tauri::command]
pub async fn local_targets(state: State<'_, AppState>) -> Result<Catalog> {
    let mut targets = Vec::new();
    #[allow(unused_mut)]
    let mut warning = None;
    #[cfg(windows)]
    {
        let root =
            PathBuf::from(std::env::var_os("SystemRoot").ok_or("Windows 경로를 찾지 못했습니다.")?);
        let system = root.join("System32");
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            let pwsh = PathBuf::from(pf).join("PowerShell/7/pwsh.exe");
            if pwsh.is_file() {
                targets.push(target("pwsh", "PowerShell 7", "shell", pwsh, &["-NoLogo"]));
            }
        }
        targets.push(target(
            "powershell",
            "Windows PowerShell",
            "shell",
            system.join("WindowsPowerShell/v1.0/powershell.exe"),
            &["-NoLogo"],
        ));
        targets.push(target(
            "cmd",
            "명령 프롬프트",
            "shell",
            system.join("cmd.exe"),
            &[],
        ));
        let wsl = system.join("wsl.exe");
        if wsl.is_file() {
            let mut command = tokio::process::Command::new(&wsl);
            command
                .args(["--list", "--quiet"])
                .creation_flags(0x08000000)
                .kill_on_drop(true);
            match tokio::time::timeout(Duration::from_secs(5), command.output()).await {
                Ok(Ok(output)) if output.status.success() => {
                    for name in decode_wsl(&output.stdout).trim_start_matches('\u{feff}').lines().map(str::trim).filter(|s| !s.is_empty()) {
                        if name.len() <= 256 && !name.chars().any(char::is_control) {
                            targets.push(target(&format!("wsl:{name}"), name, "wsl", wsl.clone(), &["--distribution", name, "--cd", "~"]));
                        }
                    }
                }
                _ => warning = Some("WSL 목록을 가져오지 못했습니다. 설치 상태를 확인한 뒤 새로고침하세요. 로컬 셸은 사용할 수 있습니다.".into()),
            }
        }
    }
    #[cfg(not(windows))]
    {
        // GUI launches may lack SHELL; portable-pty falls back to the user's passwd entry.
        let shell = PathBuf::from(CommandBuilder::new_default_prog().get_shell());
        let name = format!(
            "{} · 기본 셸",
            shell.file_name().unwrap_or_default().to_string_lossy()
        );
        targets.push(target("default-shell", &name, "shell", shell, &["-l"]));
    }
    targets.retain(|t| t.program.is_file());
    *state.locals.targets.lock().unwrap() =
        targets.iter().map(|t| (t.id.clone(), t.clone())).collect();
    Ok(Catalog { targets, warning })
}
fn size(cols: u16, rows: u16) -> Result<PtySize> {
    if !(2..=1000).contains(&cols) || !(1..=1000).contains(&rows) {
        return Err("터미널 크기가 올바르지 않습니다.".into());
    }
    Ok(PtySize {
        cols,
        rows,
        pixel_width: 0,
        pixel_height: 0,
    })
}
#[tauri::command]
pub async fn local_open(
    state: State<'_, AppState>,
    id: String,
    target_id: String,
    cols: u16,
    rows: u16,
    on_event: Channel<Event>,
) -> Result<()> {
    let locals = state.locals.clone();
    if state.closing.load(Ordering::SeqCst) {
        return Err("앱이 종료 중입니다.".into());
    }
    uuid::Uuid::parse_str(&id).map_err(|_| "잘못된 터미널 ID")?;
    let dimensions = size(cols, rows)?;
    let target = locals
        .targets
        .lock()
        .unwrap()
        .get(&target_id)
        .cloned()
        .ok_or("로컬 목록을 새로고침한 뒤 다시 선택하세요.")?;
    tauri::async_runtime::spawn_blocking(move || {
        // Serialize startup with insertion so duplicate IDs cannot orphan a process.
        let mut entries = locals.entries.lock().unwrap();
        if locals.closing.load(Ordering::SeqCst) {
            return Err("앱이 종료 중입니다.".into());
        }
        if entries.contains_key(&id) || entries.len() >= 32 {
            return Err("로컬 터미널 ID가 중복되었거나 최대 32개에 도달했습니다.".into());
        }
        let pair = native_pty_system()
            .openpty(dimensions)
            .map_err(|_| "로컬 PTY를 만들지 못했습니다.")?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|_| "로컬 출력 채널을 만들지 못했습니다.")?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|_| "로컬 입력 채널을 만들지 못했습니다.")?;
        let mut command = CommandBuilder::new(&target.program);
        command.args(&target.args);
        if let Some(home) = dirs::home_dir() {
            command.cwd(home);
        }
        command.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|_| "로컬 셸을 실행하지 못했습니다. 설치 상태를 확인하세요.")?;
        drop(pair.slave);
        let (tx, mut rx) = mpsc::channel(16);
        let control = Arc::new(Control {
            input: tx,
            name: target.name.clone(),
            killer: Mutex::new(child.clone_killer()),
            stopped: AtomicBool::new(false),
            exited: AtomicBool::new(false),
            ack: (Mutex::new(0), Condvar::new()),
        });
        entries.insert(id.clone(), control.clone());
        drop(entries);
        let exit_control = control.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            exit_control.exited.store(true, Ordering::SeqCst);
            let _ = exit_control.input.try_send(Input::Data(Vec::new()));
        });
        let input_control = control.clone();
        std::thread::spawn(move || {
            while !input_control.stopped.load(Ordering::SeqCst)
                && !input_control.exited.load(Ordering::SeqCst)
            {
                match rx.blocking_recv() {
                    Some(Input::Data(bytes)) => {
                        if writer
                            .write_all(&bytes)
                            .and_then(|_| writer.flush())
                            .is_err()
                        {
                            break;
                        }
                    }
                    Some(Input::Resize(cols, rows)) => {
                        if pair
                            .master
                            .resize(PtySize {
                                cols: cols as u16,
                                rows: rows as u16,
                                pixel_width: 0,
                                pixel_height: 0,
                            })
                            .is_err()
                        {
                            break;
                        }
                    }
                    None => break,
                }
            }
            if !input_control.exited.load(Ordering::SeqCst) {
                input_control.stop();
            }
        });
        if on_event
            .send(Event::State {
                status: "connected".into(),
                message: format!("로컬 · {}", target.name),
            })
            .is_err()
        {
            control.stop();
        }
        std::thread::spawn(move || {
            let mut bytes = [0u8; 32768];
            let mut seq = 0;
            loop {
                let n = match reader.read(&mut bytes) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                // ConPTY close can wait for its output pipe: drain after cancellation
                // while the input worker drops the master, without queueing more IPC.
                if control.stopped.load(Ordering::SeqCst) {
                    continue;
                }
                seq += 1;
                if on_event
                    .send(Event::Data {
                        seq,
                        bytes: bytes[..n].to_vec(),
                    })
                    .is_err()
                {
                    control.stop();
                    continue;
                }
                // Only one bounded frame is in flight; cancellation wakes an ACK wait.
                let mut ack = control.ack.0.lock().unwrap();
                while *ack < seq && !control.stopped.load(Ordering::SeqCst) {
                    ack = control
                        .ack
                        .1
                        .wait_timeout(ack, Duration::from_millis(200))
                        .unwrap()
                        .0;
                }
            }
            control.stop();
            locals.entries.lock().unwrap().remove(&id);
            let _ = on_event.send(Event::State {
                status: "closed".into(),
                message: "로컬 셸이 종료되었습니다. 다시 열면 새 셸이 시작됩니다.".into(),
            });
        });
        Ok(())
    })
    .await
    .map_err(|_| "로컬 터미널 작업에 실패했습니다.")?
}
#[tauri::command]
pub fn local_input(
    window: tauri::WebviewWindow,
    state: State<AppState>,
    id: String,
    data: String,
) -> Result<()> {
    if data.len() > 16384 {
        return Err("입력 크기 제한을 초과했습니다.".into());
    }
    state.locals.control(&id)?;
    state.broadcast.send(
        &state.connections,
        &state.locals,
        &id,
        window.label(),
        &data,
    )
}
#[tauri::command]
pub fn local_resize(state: State<AppState>, id: String, cols: u16, rows: u16) -> Result<()> {
    size(cols, rows)?;
    state
        .locals
        .control(&id)?
        .input
        .try_send(Input::Resize(cols.into(), rows.into()))
        .map_err(|_| "터미널 크기를 변경하지 못했습니다.".into())
}
#[tauri::command]
pub fn local_ack(state: State<AppState>, id: String, seq: u64) -> Result<()> {
    let c = state.locals.control(&id)?;
    let mut ack = c.ack.0.lock().unwrap();
    if seq == *ack + 1 {
        *ack = seq;
        c.ack.1.notify_all();
    }
    Ok(())
}
#[tauri::command]
pub fn local_close(state: State<AppState>, id: String) {
    if let Ok(c) = state.locals.control(&id) {
        c.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_dimensions() {
        assert!(size(0, 24).is_err());
        assert!(size(80, 0).is_err());
        assert!(size(80, 24).is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn wsl_unicode_names() {
        let bytes: Vec<_> = "Ubuntu\r\n한글 개발\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        assert_eq!(decode_wsl(&bytes), "Ubuntu\r\n한글 개발\r\n");
        assert_eq!(decode_wsl(b"Ubuntu\n"), "Ubuntu\n");
    }
}
