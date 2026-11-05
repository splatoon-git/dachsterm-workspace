//! Output-only recording. One producer per PTY; no input/auth events enter this module.
use crate::{AppState, storage::Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs::{File, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;
const QUEUE: usize = 64;
const LINE_LIMIT: usize = 64 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    pub directory: String,
    pub timestamps: bool,
    pub max_bytes: u64,
    pub keep_files: usize,
    pub daily: bool,
}
impl Options {
    fn validate(&self) -> Result<()> {
        if !PathBuf::from(&self.directory).is_absolute()
            || !(1_048_576..=1_073_741_824).contains(&self.max_bytes)
            || !(1..=100).contains(&self.keep_files)
        {
            return Err("로그 경로·회전 크기(1~1024MiB)·보관 수(1~100)를 확인하세요.".into());
        }
        Ok(())
    }
}
#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: String,
    pub path: String,
    pub message: String,
    pub bytes: u64,
}
enum Item {
    Text(String),
    Pause,
    Resume,
}
struct Recording {
    tx: SyncSender<Item>,
    status: Arc<Mutex<Status>>,
    ending: Arc<AtomicBool>,
    done: Arc<AtomicBool>,
}
struct Stream {
    decoder: encoding_rs::Decoder,
    recording: Option<Recording>,
    cleaner: Cleaner,
}
#[derive(Default)]
pub struct Logs {
    streams: Mutex<HashMap<String, Stream>>,
    history: Mutex<VecDeque<(String, Arc<Mutex<Status>>)>>,
    workers: Mutex<Vec<Arc<AtomicBool>>>,
}
impl Logs {
    pub fn register(&self, id: &str, encoding: &str) -> Result<()> {
        self.streams.lock().unwrap().insert(
            id.into(),
            Stream {
                decoder: crate::encoding::get(encoding)?.new_decoder_without_bom_handling(),
                recording: None,
                cleaner: Cleaner::default(),
            },
        );
        Ok(())
    }
    pub fn data(&self, id: &str, bytes: &[u8]) {
        let mut streams = self.streams.lock().unwrap();
        let Some(stream) = streams.get_mut(id) else {
            return;
        };
        // Decode continuously, including while off/paused, to preserve character boundaries.
        let mut text = String::with_capacity(bytes.len() * 3 + 16);
        let _ = stream.decoder.decode_to_string(bytes, &mut text, false);
        let text: String = text
            .chars()
            .filter_map(|c| stream.cleaner.push(c))
            .collect();
        if let Some(r) = &stream.recording {
            let mut status = r.status.lock().unwrap();
            if status.state == "recording"
                && !text.is_empty()
                && r.tx.try_send(Item::Text(text)).is_err()
            {
                status.state = "error".into();
                status.message =
                    "로그 큐 상한 초과: 기록을 중단했습니다. 일부 출력은 저장되지 않았습니다."
                        .into();
                r.ending.store(true, Ordering::SeqCst);
            }
        }
    }
    pub fn start(&self, id: &str, name: &str, options: Options, masks: Vec<String>) -> Result<()> {
        options.validate()?;
        if masks.len() > 32
            || masks
                .iter()
                .any(|s| s.is_empty() || s.len() > 1024 || s.contains(['\n', '\r']))
        {
            return Err("마스킹은 줄바꿈 없는 문자열 1~1024바이트, 최대 32개입니다.".into());
        }
        let mut streams = self.streams.lock().unwrap();
        let stream = streams
            .get_mut(id)
            .ok_or("연결된 터미널만 기록할 수 있습니다.")?;
        if stream
            .recording
            .as_ref()
            .is_some_and(|r| !r.done.load(Ordering::SeqCst))
        {
            return Err("기존 기록이 아직 종료되지 않았습니다.".into());
        }
        let (tx, rx) = mpsc::sync_channel(QUEUE);
        let status = Arc::new(Mutex::new(Status {
            state: "recording".into(),
            message: "출력만 기록 중".into(),
            ..Default::default()
        }));
        let ending = Arc::new(AtomicBool::new(false));
        let done = Arc::new(AtomicBool::new(false));
        let mut writer = LogWriter::new(name, options, masks, status.clone())?;
        {
            let mut workers = self.workers.lock().unwrap();
            workers.retain(|d| !d.load(Ordering::SeqCst));
            workers.push(done.clone());
        }
        stream.recording = Some(Recording {
            tx,
            status: status.clone(),
            ending: ending.clone(),
            done: done.clone(),
        });
        std::thread::spawn(move || {
            let result = (|| -> Result<()> {
                loop {
                    let item = if ending.load(Ordering::SeqCst) {
                        rx.try_recv().ok()
                    } else {
                        match rx.recv_timeout(Duration::from_millis(100)) {
                            Ok(v) => Some(v),
                            Err(mpsc::RecvTimeoutError::Timeout) => continue,
                            Err(_) => None,
                        }
                    };
                    match item {
                        Some(Item::Text(s)) => writer.push(&s)?,
                        Some(Item::Pause) | Some(Item::Resume) => writer.boundary()?,
                        None => break,
                    }
                }
                writer.finish()
            })();
            let mut s = status.lock().unwrap();
            if let Err(message) = result {
                s.state = "error".into();
                s.message = message;
            } else if s.state != "error" {
                s.state = "stopped".into();
                s.message = "기록 종료 · flush 완료".into();
            }
            done.store(true, Ordering::SeqCst);
        });
        Ok(())
    }
    pub fn action(&self, id: &str, action: &str) -> Result<()> {
        let streams = self.streams.lock().unwrap();
        let r = streams
            .get(id)
            .and_then(|s| s.recording.as_ref())
            .ok_or("진행 중인 로그가 없습니다.")?;
        let mut s = r.status.lock().unwrap();
        match action {
            "stop" => {
                r.ending.store(true, Ordering::SeqCst);
                if s.state != "error" && !r.done.load(Ordering::SeqCst) {
                    s.state = "stopping".into();
                }
            }
            "pause" | "resume" => {
                if !matches!(
                    (s.state.as_str(), action),
                    ("recording", "pause") | ("paused", "resume")
                ) {
                    return Err("로그 상태가 변경되었습니다.".into());
                }
                r.tx.try_send(if action == "pause" {
                    Item::Pause
                } else {
                    Item::Resume
                })
                .map_err(|_| "로그 대기열이 가득 찼습니다. 다시 시도하거나 종료하세요.")?;
                s.state = if action == "pause" {
                    "paused"
                } else {
                    "recording"
                }
                .into();
                s.message = "일시정지 경계의 미완성 줄은 저장하지 않습니다.".into();
            }
            _ => return Err("잘못된 로그 동작".into()),
        }
        Ok(())
    }
    pub fn status(&self, id: &str) -> Status {
        if let Some(r) = self
            .streams
            .lock()
            .unwrap()
            .get(id)
            .and_then(|s| s.recording.as_ref())
        {
            return r.status.lock().unwrap().clone();
        }
        self.history
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|(key, _)| key == id)
            .map(|(_, s)| s.lock().unwrap().clone())
            .unwrap_or(Status {
                state: "off".into(),
                ..Default::default()
            })
    }
    pub fn close(&self, id: &str) {
        if let Some(mut stream) = self.streams.lock().unwrap().remove(id)
            && let Some(r) = stream.recording.take()
        {
            let mut s = r.status.lock().unwrap();
            if s.state != "error" && !r.done.load(Ordering::SeqCst) {
                s.state = "stopping".into();
            }
            drop(s);
            r.ending.store(true, Ordering::SeqCst);
            let mut h = self.history.lock().unwrap();
            h.push_back((id.into(), r.status));
            while h.len() > 64 {
                h.pop_front();
            }
        }
    }
    pub fn shutdown(&self) -> bool {
        let _active: Vec<_> = self
            .streams
            .lock()
            .unwrap()
            .values()
            .filter_map(|s| s.recording.as_ref())
            .map(|r| {
                r.ending.store(true, Ordering::SeqCst);
                r.done.clone()
            })
            .collect();
        let pending = self.workers.lock().unwrap().clone();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while pending.iter().any(|d| !d.load(Ordering::SeqCst))
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        pending.iter().all(|d| d.load(Ordering::SeqCst))
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn safe_name(name: &str) -> String {
    let s: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_'))
        .take(48)
        .collect();
    if s.is_empty() { "session".into() } else { s }
}
// Stateful ECMA-48 stripping: fragmented CSI/OSC/DCS/APC/PM/SOS cannot escape to disk.
#[derive(Default)]
struct Cleaner {
    state: u8,
}
impl Cleaner {
    fn push(&mut self, c: char) -> Option<char> {
        match self.state {
            0 => match c {
                '\x1b' => {
                    self.state = 1;
                    None
                }
                '\u{009b}' => {
                    self.state = 2;
                    None
                }
                '\u{009d}' => {
                    self.state = 3;
                    None
                }
                '\u{0090}' | '\u{0098}' | '\u{009e}' | '\u{009f}' => {
                    self.state = 3;
                    None
                }
                '\n' | '\t' => Some(c),
                c if !c.is_control() => Some(c),
                _ => None,
            },
            1 => {
                self.state = match c {
                    '[' => 2,
                    ']' | 'P' | '_' | '^' | 'X' => 3,
                    ' '..='/' => 5,
                    _ => 0,
                };
                None
            }
            2 => {
                if ('@'..='~').contains(&c) {
                    self.state = 0;
                }
                None
            }
            3 => {
                if c == '\x07' || c == '\u{009c}' {
                    self.state = 0;
                } else if c == '\x1b' {
                    self.state = 4;
                }
                None
            }
            4 => {
                self.state = if c == '\\' { 0 } else { 3 };
                None
            }
            _ => {
                if ('0'..='~').contains(&c) {
                    self.state = 0;
                }
                None
            }
        }
    }
}
struct LogWriter {
    options: Options,
    masks: Zeroizing<Vec<String>>,
    cleaner: Cleaner,
    line: Zeroizing<String>,
    directory: PathBuf,
    files: VecDeque<PathBuf>,
    file: Option<File>,
    size: u64,
    day: u64,
    index: u32,
    status: Arc<Mutex<Status>>,
}
impl LogWriter {
    fn new(
        name: &str,
        options: Options,
        masks: Vec<String>,
        status: Arc<Mutex<Status>>,
    ) -> Result<Self> {
        let directory = PathBuf::from(&options.directory).join(format!(
            "{}-{}-{}",
            safe_name(name),
            now(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory)
            .map_err(|_| "로그 전용 폴더를 만들지 못했습니다. 저장 위치와 권한을 확인하세요.")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "로그 폴더 권한 설정 실패")?;
        }
        let mut w = Self {
            options,
            masks: Zeroizing::new(masks),
            cleaner: Cleaner::default(),
            line: Zeroizing::new(String::new()),
            directory,
            files: VecDeque::new(),
            file: None,
            size: 0,
            day: now() / 86400,
            index: 0,
            status,
        };
        w.rotate()?;
        Ok(w)
    }
    fn rotate(&mut self) -> Result<()> {
        if let Some(f) = self.file.take() {
            f.sync_all().map_err(|_| "로그 flush 실패")?;
        }
        self.index += 1;
        let path = self.directory.join(format!("output-{:06}.log", self.index));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        self.file = Some(
            options
                .open(&path)
                .map_err(|_| "로그 파일 생성 실패 · 기록 중단")?,
        );
        self.size = 0;
        self.day = now() / 86400;
        self.status.lock().unwrap().path = path.to_string_lossy().into();
        self.files.push_back(path);
        while self.files.len() > self.options.keep_files {
            if let Some(p) = self.files.pop_front() {
                std::fs::remove_file(p).map_err(|_| "로그 보관 한도 정리 실패 · 기록 중단")?;
            }
        }
        Ok(())
    }
    fn push(&mut self, text: &str) -> Result<()> {
        for c in text.chars() {
            if let Some(c) = self.cleaner.push(c) {
                self.line.push(c);
                if self.line.len() > LINE_LIMIT {
                    return Err("미완성 로그 줄이 64KiB를 넘어 기록을 중단했습니다. 해당 줄은 저장하지 않았습니다.".into());
                }
                if c == '\n' {
                    self.write_line()?;
                }
            }
        }
        Ok(())
    }
    fn write_line(&mut self) -> Result<()> {
        if self.line.is_empty() {
            return Ok(());
        }
        let mut text = Zeroizing::new(self.line.to_string());
        // Match all masks against the original text, then merge intervals (overlaps included).
        let mut spans = Vec::new();
        for mask in self.masks.iter() {
            let mut offset = 0;
            while let Some(i) = text[offset..].find(mask) {
                let start = offset + i;
                spans.push((start, start + mask.len()));
                offset = start + text[start..].chars().next().unwrap().len_utf8();
            }
        }
        spans.sort_unstable();
        let mut merged: Vec<(usize, usize)> = Vec::new();
        for (a, b) in spans {
            if let Some(last) = merged.last_mut().filter(|last| a <= last.1) {
                last.1 = last.1.max(b)
            } else {
                merged.push((a, b));
            }
        }
        for (a, b) in merged.into_iter().rev() {
            text.replace_range(a..b, "[MASKED]");
        }
        if self.options.timestamps {
            text.insert_str(0, &format!("[{} UTC epoch] ", now()));
        }
        if self.size + text.len() as u64 > self.options.max_bytes
            || self.options.daily && self.day != now() / 86400
        {
            self.rotate()?;
        }
        self.file
            .as_mut()
            .unwrap()
            .write_all(text.as_bytes())
            .map_err(|_| "로그 쓰기 실패 · 기록 중단, 일부 출력은 저장되지 않았습니다.")?;
        self.size += text.len() as u64;
        self.status.lock().unwrap().bytes += text.len() as u64;
        self.line.clear();
        Ok(())
    }
    fn boundary(&mut self) -> Result<()> {
        self.line.clear();
        self.cleaner = Cleaner::default();
        self.file
            .as_ref()
            .unwrap()
            .sync_all()
            .map_err(|_| "로그 flush 실패".into())
    }
    fn finish(&mut self) -> Result<()> {
        self.write_line()?;
        self.file
            .as_ref()
            .unwrap()
            .sync_all()
            .map_err(|_| "로그 flush 실패".into())
    }
}
#[tauri::command]
pub fn log_status(state: tauri::State<AppState>, id: String) -> Status {
    state.connections.logs.status(&id)
}
#[tauri::command]
pub async fn log_pick() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("세션 로그 저장 폴더")
        .pick_folder()
        .await
        .map(|f| f.path().to_string_lossy().into())
}
#[tauri::command]
pub fn log_start(
    state: tauri::State<AppState>,
    id: String,
    options: Options,
    masks: Vec<String>,
) -> Result<()> {
    let name = if let Ok(c) = state.locals.control(&id) {
        if !c.ready() {
            return Err("터미널 종료".into());
        }
        c.name.clone()
    } else {
        state.connections.handle(&id)?;
        state.connections.control(&id)?.profile.name.clone()
    };
    state.connections.logs.start(&id, &name, options, masks)
}
#[tauri::command]
pub fn log_action(state: tauri::State<AppState>, id: String, action: String) -> Result<()> {
    state.connections.logs.action(&id, &action)
}
#[tauri::command]
pub fn log_auto_get(state: tauri::State<AppState>, key: String) -> Result<Option<Options>> {
    let value = state.store.setting(&format!("log-auto:{key}"))?;
    if value.is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&value).map_err(|_| "자동 로그 설정을 읽지 못했습니다.".into())
}
#[tauri::command]
pub fn log_auto(
    state: tauri::State<AppState>,
    key: String,
    options: Option<Options>,
) -> Result<()> {
    if key.len() > 300 || !(key.starts_with("ssh:") || key.starts_with("local:")) {
        return Err("로그 설정 대상 오류".into());
    }
    if let Some(o) = &options {
        o.validate()?;
    }
    state.store.set_setting(
        &format!("log-auto:{key}"),
        &serde_json::to_string(&options).map_err(|_| "로그 설정 오류")?,
    )
}
pub fn auto_start(logs: &Logs, store: &crate::storage::Store, id: &str, key: &str, name: &str) {
    if let Ok(raw) = store.setting(&format!("log-auto:{key}"))
        && let Ok(Some(options)) = serde_json::from_str::<Option<Options>>(&raw)
        && let Err(message) = logs.start(id, name, options, Vec::new())
    {
        let mut h = logs.history.lock().unwrap();
        h.push_back((
            id.into(),
            Arc::new(Mutex::new(Status {
                state: "error".into(),
                message,
                ..Default::default()
            })),
        ));
        while h.len() > 64 {
            h.pop_front();
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn opts(dir: &std::path::Path) -> Options {
        Options {
            directory: dir.to_string_lossy().into(),
            timestamps: false,
            max_bytes: 1048576,
            keep_files: 2,
            daily: true,
        }
    }
    #[test]
    fn bounded_queue_reports_loss_without_blocking_output() {
        let logs = Logs::default();
        logs.register("id", "utf-8").unwrap();
        let (tx, _rx) = mpsc::sync_channel(1);
        tx.try_send(Item::Text("queued".into())).unwrap();
        let status = Arc::new(Mutex::new(Status {
            state: "recording".into(),
            ..Default::default()
        }));
        logs.streams
            .lock()
            .unwrap()
            .get_mut("id")
            .unwrap()
            .recording = Some(Recording {
            tx,
            status: status.clone(),
            ending: Arc::default(),
            done: Arc::default(),
        });
        logs.data("id", b"overflow\n");
        assert_eq!(status.lock().unwrap().state, "error");
        logs.data("id", b"terminal continues\n");
    }
    #[test]
    fn size_date_rotation_and_disk_error() {
        let d = tempfile::tempdir().unwrap();
        let status = Arc::new(Mutex::new(Status::default()));
        let mut w = LogWriter::new("test", opts(d.path()), vec![], status.clone()).unwrap();
        let first = status.lock().unwrap().path.clone();
        w.size = w.options.max_bytes;
        w.push("new file\n").unwrap();
        assert_ne!(first, status.lock().unwrap().path);
        let second = status.lock().unwrap().path.clone();
        w.day -= 1;
        w.push("next day\n").unwrap();
        assert_ne!(second, status.lock().unwrap().path);
        w.file = Some(File::open(&status.lock().unwrap().path).unwrap());
        assert!(w.push("write denied\n").is_err());
    }
    #[test]
    fn starting_mid_packet_and_paused_osc_do_not_leak_payload() {
        let d = tempfile::tempdir().unwrap();
        let logs = Logs::default();
        logs.register("id", "utf-8").unwrap();
        let bytes = "한".as_bytes();
        logs.data("id", &bytes[..1]);
        logs.start("id", "test", opts(d.path()), vec![]).unwrap();
        logs.data("id", &bytes[1..]);
        logs.data("id", b"\n");
        logs.action("id", "pause").unwrap();
        logs.data("id", b"\x1b]52;hidden");
        logs.action("id", "resume").unwrap();
        logs.data("id", b"payload\x07visible\n");
        logs.action("id", "stop").unwrap();
        logs.shutdown();
        assert_eq!(
            std::fs::read_to_string(logs.status("id").path).unwrap(),
            "한\nvisible\n"
        );
        let first = logs.status("id").path;
        logs.start("id", "test", opts(d.path()), vec![]).unwrap();
        logs.action("id", "stop").unwrap();
        logs.shutdown();
        assert_ne!(first, logs.status("id").path);
    }
    #[test]
    fn boundaries_ansi_overlap_and_unicode() {
        let d = tempfile::tempdir().unwrap();
        let s = Arc::new(Mutex::new(Status::default()));
        let mut w = LogWriter::new(
            "../CON:한글",
            opts(d.path()),
            vec!["abcdef".into(), "defghi".into()],
            s.clone(),
        )
        .unwrap();
        for part in [
            "한",
            "글\x1b[3",
            "1mabc",
            "defghi\x1b]52;secret",
            "\x1b\\\n",
        ] {
            w.push(part).unwrap();
        }
        w.finish().unwrap();
        assert_eq!(
            std::fs::read_to_string(&s.lock().unwrap().path).unwrap(),
            "한글[MASKED]\n"
        );
    }
    #[test]
    fn pause_discards_fragment_and_retention() {
        let d = tempfile::tempdir().unwrap();
        let s = Arc::new(Mutex::new(Status::default()));
        let mut w = LogWriter::new("test", opts(d.path()), vec![], s.clone()).unwrap();
        w.push("unfinished").unwrap();
        w.boundary().unwrap();
        w.push("kept\n").unwrap();
        for _ in 0..3 {
            w.rotate().unwrap();
        }
        assert_eq!(std::fs::read_dir(&w.directory).unwrap().count(), 2);
        assert!(w.push(&"x".repeat(LINE_LIMIT + 1)).is_err());
    }
    #[test]
    fn output_decoding_and_close_flush() {
        for encoding in ["utf-8", "euc-kr"] {
            let d = tempfile::tempdir().unwrap();
            let logs = Logs::default();
            logs.register("id", encoding).unwrap();
            logs.start("id", "test", opts(d.path()), vec![]).unwrap();
            for b in crate::encoding::encode("한글\n마지막", encoding).unwrap() {
                logs.data("id", &[b]);
            }
            logs.action("id", "stop").unwrap();
            logs.shutdown();
            let s = logs.status("id");
            assert_eq!(s.state, "stopped");
            assert_eq!(std::fs::read_to_string(s.path).unwrap(), "한글\n마지막");
        }
    }
}
