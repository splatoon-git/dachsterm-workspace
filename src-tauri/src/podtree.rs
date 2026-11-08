//! Dedicated Kubernetes PTYs. Never members of the shell broadcast or snippet targets.
mod launch;
use crate::{
    AppState,
    ssh::{Event, Input},
    storage::Result,
};
use serde::{Deserialize, Serialize};
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
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{mpsc, watch},
};
const SCRIPT: &str = include_str!("../assets/podtree/podtree.sh");
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Location {
    pub kind: String,
    pub id: String,
}
pub use launch::Launch;
use launch::{Labels, ScriptLaunch};
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    contexts: Vec<String>,
    current: String,
    namespaces: Vec<String>,
    warning: String,
}
struct Control {
    input: mpsc::Sender<Input>,
    stop: watch::Sender<bool>,
    ack: watch::Sender<u64>,
}
#[derive(Default)]
pub struct PodTrees {
    entries: Mutex<HashMap<String, Arc<Control>>>,
    closing: AtomicBool,
}
impl PodTrees {
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
use crate::remote_exec::quote;
fn name(s: &str, empty: bool) -> Result<()> {
    if (!empty && s.is_empty())
        || s.len() > 253
        || s.starts_with('-')
        || s.chars().any(char::is_control)
    {
        Err("context/namespace 이름이 올바르지 않습니다.".into())
    } else {
        Ok(())
    }
}
fn bash_target(
    state: &AppState,
    location: &Location,
    script: &str,
) -> Result<(std::path::PathBuf, Vec<String>)> {
    if location.kind != "local" {
        return Err("실행 위치 오류".into());
    }
    let target = state.locals.target(&location.id)?;
    if target.kind == "wsl" {
        let mut args = target.args;
        args.extend([
            "--exec".into(),
            "bash".into(),
            "--noprofile".into(),
            "--norc".into(),
            "-c".into(),
            script.into(),
        ]);
        Ok((target.program, args))
    } else {
        #[cfg(windows)]
        {
            Err("Windows에서는 WSL 배포판을 선택하세요.".into())
        }
        #[cfg(not(windows))]
        {
            Ok((
                ["/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/bin/bash"]
                    .into_iter()
                    .map(std::path::PathBuf::from)
                    .find(|p| p.is_file())
                    .ok_or("Bash를 찾지 못했습니다.")?,
                vec![
                    "--noprofile".into(),
                    "--norc".into(),
                    "-c".into(),
                    script.into(),
                ],
            ))
        }
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
async fn execute(
    state: &AppState,
    location: &Location,
    script: &str,
    input: &[u8],
) -> Result<String> {
    let work = async {
        if location.kind == "ssh" {
            let handle = state.connections.handle(&location.id)?;
            let mut c = RemoteChannel(Some(
                handle
                    .channel_open_session()
                    .await
                    .map_err(|_| "PodTree 검사 채널 생성 실패")?,
            ));
            c.exec(
                true,
                format!("bash --noprofile --norc -c {}", quote(script)),
            )
            .await
            .map_err(|_| "Bash 실행 실패")?;
            c.data(input).await.map_err(|_| "PodTree 자산 전송 실패")?;
            c.eof().await.map_err(|_| "PodTree 채널 EOF 실패")?;
            let mut out = Vec::new();
            let mut code = None;
            while let Some(m) = c.wait().await {
                match m {
                    russh::ChannelMsg::Data { data } => {
                        out.extend_from_slice(&data);
                        if out.len() > 131072 {
                            let _ = c.close().await;
                            return Err("PodTree 검사 출력 상한 초과".into());
                        }
                    }
                    russh::ChannelMsg::ExitStatus { exit_status } => code = Some(exit_status),
                    _ => {}
                }
            }
            if code != Some(0) {
                return Err("Bash 4+·kubectl·awk·sort·mktemp·ps·base64와 실행 권한을 확인하세요. 검사 명령이 실패했습니다.".into());
            }
            String::from_utf8(out).map_err(|_| "검사 출력 인코딩 오류".into())
        } else {
            let (program, args) = bash_target(state, location, script)?;
            let mut command = tokio::process::Command::new(program);
            command
                .args(args)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            #[cfg(windows)]
            command.creation_flags(0x08000000);
            let mut child = command.spawn().map_err(|_| "WSL/Bash 실행 실패")?;
            let mut stdin = child.stdin.take().unwrap();
            stdin
                .write_all(input)
                .await
                .map_err(|_| "PodTree 자산 전송 실패")?;
            drop(stdin);
            let mut out = Vec::new();
            child
                .stdout
                .take()
                .unwrap()
                .take(131073)
                .read_to_end(&mut out)
                .await
                .map_err(|_| "PodTree 검사 읽기 실패")?;
            if out.len() > 131072 {
                return Err("PodTree 검사 출력 상한 초과".into());
            }
            if !child
                .wait()
                .await
                .map_err(|_| "PodTree 검사 종료 실패")?
                .success()
            {
                return Err("Bash 4+·kubectl·awk·sort·mktemp·ps·base64와 실행 권한을 확인하세요. 검사 명령이 실패했습니다.".into());
            }
            String::from_utf8(out).map_err(|_| "검사 출력 인코딩 오류".into())
        }
    };
    tokio::time::timeout(Duration::from_secs(20), work)
        .await
        .map_err(|_| "PodTree 준비 시간 초과")?
}
const DEPS: &str = "((BASH_VERSINFO[0]>=4)) || exit 10; for d in kubectl awk sort mktemp ps base64; do command -v \"$d\" >/dev/null || exit 11; done; ";
#[tauri::command]
pub async fn kube_terminal_inspect(
    state: State<'_, AppState>,
    location: Location,
    context: Option<String>,
) -> Result<Inspection> {
    let context = context.unwrap_or_default();
    name(&context, true)?;
    let script = format!(
        "{DEPS} printf 'DACHSTERM_CONTEXTS\\n'; kubectl config get-contexts -o name 2>/dev/null || exit 12; printf 'DACHSTERM_CURRENT\\n'; kubectl config current-context 2>/dev/null || :; printf 'DACHSTERM_NAMESPACES\\n'; {}",
        if context.is_empty() {
            String::new()
        } else {
            format!(
                "kubectl --context {} --request-timeout=8s get namespaces -o 'jsonpath={{range .items[*]}}{{.metadata.name}}{{\"\\n\"}}{{end}}' 2>/dev/null || printf 'DACHSTERM_NAMESPACE_DENIED\\n'",
                quote(&context)
            )
        }
    );
    let out = execute(&state, &location, &script, &[]).await?;
    let mut mode = "";
    let mut result = Inspection {
        contexts: vec![],
        current: String::new(),
        namespaces: vec![],
        warning: String::new(),
    };
    for line in out.lines() {
        match line {"DACHSTERM_CONTEXTS"|"DACHSTERM_CURRENT"|"DACHSTERM_NAMESPACES"=>mode=line,"DACHSTERM_NAMESPACE_DENIED"=>result.warning="namespace 목록 권한이 없거나 클러스터에 연결할 수 없습니다. 허용된 namespace를 직접 입력할 수 있습니다.".into(),s if name(s,false).is_ok()=>match mode {"DACHSTERM_CONTEXTS"=>result.contexts.push(s.into()),"DACHSTERM_CURRENT"=>result.current=s.into(),"DACHSTERM_NAMESPACES"=>result.namespaces.push(s.into()),_=>{}},_=>{}}
    }
    Ok(result)
}
async fn stage(state: &AppState, launch: &ScriptLaunch) -> Result<(String, String)> {
    name(&launch.context, false)?;
    name(&launch.namespace, true)?;
    // stdin contains only a bundled public script, never kubeconfig or authentication material.
    let script = format!(
        "{DEPS} kubectl config get-contexts -o name 2>/dev/null | grep -Fx -- {} >/dev/null || exit 12; umask 077; d=$(mktemp -d \"${{TMPDIR:-/tmp}}/dachsterm-podtree.XXXXXXXX\") || exit; trap 'rm -f -- \"$d/podtree.sh\"; rmdir -- \"$d\"' EXIT; cat >\"$d/podtree.sh\" || exit; chmod 600 \"$d/podtree.sh\" || exit; printf '%s\\n' \"$d\"; trap - EXIT",
        quote(&launch.context)
    );
    let path = execute(state, &launch.location, &script, SCRIPT.as_bytes())
        .await?
        .trim()
        .to_string();
    if !path.starts_with('/')
        || !path
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .starts_with("dachsterm-podtree.")
        || path.chars().any(char::is_control)
    {
        return Err("PodTree 임시 경로 확인 실패".into());
    }
    let command = launch::start_command(launch, &path);
    Ok((path, command))
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
    let manager = state.podtrees.clone();
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
        location,
        command,
        labels,
        staged,
    } = match launch::prepare(&state, &launch).await {
        Ok(v) => v,
        Err(e) => {
            manager.entries.lock().unwrap().remove(&id);
            return Err(e);
        }
    };
    let result = if location.kind == "ssh" {
        start_ssh(
            &state,
            id.clone(),
            &location,
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
    } else {
        start_local(
            &state,
            id.clone(),
            &location,
            command,
            cols,
            rows,
            on_event,
            rx,
            stopped,
            acked,
            labels.title,
        )
        .await
    };
    if result.is_err() {
        manager.entries.lock().unwrap().remove(&id);
        if let Some(path) = staged {
            let cleanup = format!("rm -f -- {0}/podtree.sh; rmdir -- {0}", quote(&path));
            let _ = execute(&state, &location, &cleanup, &[]).await;
        }
    }
    result
}
#[allow(clippy::too_many_arguments)]
async fn start_ssh(
    state: &AppState,
    id: String,
    location: &Location,
    command: String,
    cols: u16,
    rows: u16,
    sink: Channel<Event>,
    mut rx: mpsc::Receiver<Input>,
    mut stop: watch::Receiver<bool>,
    mut ack: watch::Receiver<u64>,
    labels: Labels,
) -> Result<()> {
    let handle = state.connections.handle(&location.id)?;
    let mut parent = state.connections.control(&location.id)?.stop.subscribe();
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
    let manager = state.podtrees.clone();
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
        // Give EXIT/HUP handlers time to stop log collectors and remove owned temporary files.
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
    location: &Location,
    command: String,
    cols: u16,
    rows: u16,
    sink: Channel<Event>,
    mut rx: mpsc::Receiver<Input>,
    stop: watch::Receiver<bool>,
    ack: watch::Receiver<u64>,
    title: String,
) -> Result<()> {
    let (program, args) = bash_target(state, location, &command)?;
    let manager = state.podtrees.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let pair = portable_pty::native_pty_system()
            .openpty(portable_pty::PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| "PodTree 로컬 PTY 생성 실패")?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|_| "PodTree 읽기 생성 실패")?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|_| "PodTree 입력 생성 실패")?;
        let mut cmd = portable_pty::CommandBuilder::new(program);
        cmd.args(args);
        cmd.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|_| "PodTree WSL/Bash 실행 실패")?;
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
        emit(&sink, "connected", &title);
        std::thread::spawn(move || {
            let mut bytes = [0u8; 32768];
            let mut seq = 0;
            let mut failed = false;
            while let Ok(n) = reader.read(&mut bytes) {
                if n == 0 {
                    break;
                }
                if *stop.borrow() {
                    continue;
                }
                seq += 1;
                if sink
                    .send(Event::Data {
                        seq,
                        bytes: bytes[..n].to_vec(),
                    })
                    .is_err()
                {
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
            emit(
                &sink,
                if failed { "error" } else { "closed" },
                if failed {
                    "PodTree 프로세스 실패 또는 출력 시간 초과 · 터미널 안내를 확인하세요."
                } else {
                    "PodTree 종료"
                },
            );
        });
        Ok(())
    })
    .await
    .map_err(|_| "PodTree PTY 작업 실패")?
}
#[tauri::command]
pub fn kube_terminal_input(state: State<AppState>, id: String, data: String) -> Result<()> {
    if data.len() > 16384 {
        return Err("터미널 입력 상한 초과".into());
    }
    state
        .podtrees
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
        .podtrees
        .control(&id)?
        .input
        .try_send(Input::Resize(cols.into(), rows.into()))
        .map_err(|_| "터미널 resize 대기열 초과".into())
}
#[tauri::command]
pub fn kube_terminal_ack(state: State<AppState>, id: String, seq: u64) -> Result<()> {
    let c = state.podtrees.control(&id)?;
    if seq == *c.ack.borrow() + 1 {
        let _ = c.ack.send(seq);
    }
    Ok(())
}
#[tauri::command]
pub fn kube_terminal_close(state: State<AppState>, id: String) {
    if let Ok(c) = state.podtrees.control(&id) {
        let _ = c.stop.send(true);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quoting_and_scope() {
        assert_eq!(quote("a'b"), "'a'\\''b'");
        assert!(name("x\n", false).is_err());
        assert!(name("--context=evil", false).is_err());
        assert!(name("prod/context", false).is_ok());
        assert!(name("", false).is_err());
    }
    #[test]
    fn pinned_asset() {
        use sha2::{Digest, Sha256};
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../assets/podtree/provenance.json")).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(SCRIPT)),
            manifest["embeddedSha256"].as_str().unwrap()
        );
    }
}
