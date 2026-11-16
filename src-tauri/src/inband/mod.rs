//! File transfers inside a terminal (CG.8): ZMODEM (`sz`/`rz`) and trzsz (`tsz`/`trz`), for
//! servers behind jump hosts, Telnet devices and serial consoles, where SFTP does not reach.
//!
//! The output of SSH, Telnet and serial terminals passes through `Inband` before it is sent to
//! the window. When a program starts a transfer, its bytes stop going to the screen and a task
//! of their own takes them: the tab asks the user, who picks a folder or files (nothing is
//! accepted on its own), and the task then talks the protocol, writing back through the tab's
//! input. Typing into the tab waits until it ends. Transfers are not part of the persistent
//! transfer queue: they live only as long as the program on the server that runs them.
mod detect;
mod files;
#[cfg(test)]
mod fixture_tests;
mod trzsz;
mod zmodem;

use crate::ssh::{Event, Input, Sink};
use crate::storage::Result;
use crate::terminal_output::Source;
use detect::{Detector, Found, Start};
use files::{Download, Upload};
use russh::ChannelMsg;
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot, watch};

/// Held bytes that could begin a mark are shown when no more output comes within this time.
const HOLD: Duration = Duration::from_millis(50);
/// The user has this long to answer; the program on the server gives up about as soon.
const ASK_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Download,
    Upload,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Protocol {
    Zmodem,
    Trzsz,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    /// The program waits for the user to pick a folder or files, or to refuse.
    Ask,
    Progress,
    Done,
    Failed,
}

/// What the tab shows about a transfer. Only the window that owns the tab gets it; a detached
/// window does not replay it.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub request: String,
    pub stage: Stage,
    pub direction: Direction,
    pub protocol: Protocol,
    /// The file under way, as saved here or as sent.
    pub name: Option<String>,
    pub done: u64,
    /// The file's size, or 0 when the sender did not say.
    pub total: u64,
    pub files: usize,
    pub message: Option<String>,
}

/// The user's answer to `Stage::Ask`.
#[derive(Debug)]
enum Answer {
    Folder(PathBuf),
    Files(Vec<PathBuf>),
    Decline,
}

struct Active {
    request: String,
    direction: Direction,
    answer: Option<oneshot::Sender<Answer>>,
    stop: watch::Sender<bool>,
}

/// The transfer each connection has under way, by connection ID.
#[derive(Default)]
pub struct Transfers(Mutex<HashMap<String, Active>>);

impl Transfers {
    /// Typing would go into the protocol's byte stream, so it waits for the end.
    pub(crate) fn check_input(&self, id: &str) -> Result<()> {
        if self.0.lock().unwrap().contains_key(id) {
            return Err("터미널 안 파일 전송 중에는 입력할 수 없습니다. 탭의 전송 표시에서 취소할 수 있습니다.".into());
        }
        Ok(())
    }

    pub(crate) fn remove(&self, id: &str) {
        if let Some(active) = self.0.lock().unwrap().remove(id) {
            let _ = active.stop.send(true);
        }
    }

    /// The request's direction, while its question is still open.
    fn pending(&self, id: &str, request: &str) -> Result<Direction> {
        let map = self.0.lock().unwrap();
        match map.get(id) {
            Some(a) if a.request == request && a.answer.is_some() => Ok(a.direction),
            _ => Err("이미 답했거나 전송이 끝났습니다.".into()),
        }
    }

    fn answer(&self, id: &str, request: &str, answer: Answer) -> Result<()> {
        let sender = {
            let mut map = self.0.lock().unwrap();
            let active = map
                .get_mut(id)
                .filter(|a| a.request == request)
                .ok_or("이미 답했거나 전송이 끝났습니다.")?;
            active.answer.take().ok_or("이미 답했습니다.")?
        };
        sender
            .send(answer)
            .map_err(|_| "전송이 이미 끝났습니다.".into())
    }

    fn stop(&self, id: &str, request: &str) -> Result<()> {
        let map = self.0.lock().unwrap();
        let active = map
            .get(id)
            .filter(|a| a.request == request)
            .ok_or("전송이 이미 끝났습니다.")?;
        let _ = active.stop.send(true);
        Ok(())
    }
}

/// Sends progress at most a few times a second.
pub(super) struct Progress {
    notice: Notice,
    sink: Sink,
    last: Instant,
}

impl Progress {
    fn send(&mut self) {
        // A closed window misses progress only; the transfer itself goes on.
        let _ = (self.sink)(Event::Inband(self.notice.clone()));
        self.last = Instant::now();
    }
    fn file(&mut self, name: &str, total: u64) {
        self.notice.stage = Stage::Progress;
        self.notice.name = Some(name.into());
        self.notice.total = total;
        self.notice.done = 0;
        self.notice.files += 1;
        self.send();
    }
    fn step(&mut self, done: u64) {
        self.notice.done = done;
        if self.last.elapsed() >= Duration::from_millis(200) {
            self.send();
        }
    }
    fn end(&mut self, stage: Stage, message: String) {
        self.notice.stage = stage;
        self.notice.message = Some(message);
        self.send();
    }
}

/// The transfer's side of the terminal: server bytes in, bytes to the server out.
pub(super) trait Wire: Send {
    /// Server bytes, or `None` when `limit` passed without any.
    fn read_for(
        &mut self,
        limit: Duration,
    ) -> impl std::future::Future<Output = Result<Option<Vec<u8>>>> + Send;
    fn write(&mut self, bytes: Vec<u8>) -> impl std::future::Future<Output = Result<()>> + Send;
    /// Server bytes, waiting as long as the protocol allows.
    fn read(&mut self) -> impl std::future::Future<Output = Result<Vec<u8>>> + Send {
        async move {
            self.read_for(Duration::from_secs(60))
                .await?
                .ok_or_else(|| "서버가 응답하지 않아 전송을 멈췄습니다.".to_string())
        }
    }
}

impl<W: Wire> Wire for &mut W {
    async fn read_for(&mut self, limit: Duration) -> Result<Option<Vec<u8>>> {
        (**self).read_for(limit).await
    }
    async fn write(&mut self, bytes: Vec<u8>) -> Result<()> {
        (**self).write(bytes).await
    }
}

/// What the transfer task hands back to the output path.
enum Back<S> {
    /// Messages that are not output (a channel's exit or close), passed on as they come.
    Message(ChannelMsg),
    /// The transfer ended: the source, and the server's bytes after it for the screen.
    Done(S, Vec<u8>, Option<ChannelMsg>),
}

struct TaskWire<'a, S: Source> {
    source: &'a mut S,
    input: mpsc::Sender<Input>,
    stop: watch::Receiver<bool>,
    back: &'a mpsc::Sender<Back<S>>,
    /// The message that ended the source, given back after the transfer.
    ended: Option<ChannelMsg>,
}

impl<S: Source + Send> Wire for TaskWire<'_, S> {
    async fn read_for(&mut self, limit: Duration) -> Result<Option<Vec<u8>>> {
        if self.ended.is_some() {
            return Err("연결이 끊겨 전송을 멈췄습니다.".into());
        }
        let deadline = tokio::time::Instant::now() + limit;
        let mut stop = self.stop.clone();
        let stopped = async move {
            while !*stop.borrow_and_update() {
                if stop.changed().await.is_err() {
                    std::future::pending::<()>().await;
                }
            }
        };
        tokio::pin!(stopped);
        loop {
            tokio::select! {
                () = &mut stopped => return Err(STOPPED.into()),
                _ = tokio::time::sleep_until(deadline) => return Ok(None),
                message = self.source.next() => match message {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        return Ok(Some(data.to_vec()));
                    }
                    Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) | None => {
                        self.ended = Some(ChannelMsg::Close);
                        return Err("연결이 끊겨 전송을 멈췄습니다.".into());
                    }
                    Some(other) => {
                        let _ = self.back.send(Back::Message(other)).await;
                    }
                },
            }
        }
    }

    async fn write(&mut self, bytes: Vec<u8>) -> Result<()> {
        if *self.stop.borrow() {
            return Err(STOPPED.into());
        }
        self.input
            .send(Input::Data(bytes))
            .await
            .map_err(|_| "연결이 끊겨 전송을 멈췄습니다.".to_string())
    }
}

const STOPPED: &str = "전송을 취소했습니다.";

/// Where a connection's transfers report and write.
#[derive(Clone)]
pub(crate) struct Context {
    pub id: String,
    pub sink: Sink,
    pub input: mpsc::Sender<Input>,
    pub transfers: Arc<Transfers>,
}

/// The output path of one terminal: shows output, and hands a transfer to a task of its own.
/// Every await in `next` is on a channel or the inner source, so the pump may drop it at any
/// time (it does when an ACK comes first) without losing a byte.
pub(crate) struct Inband<S: Source> {
    inner: Option<S>,
    detector: Detector,
    context: Context,
    task: Option<mpsc::Receiver<Back<S>>>,
    /// Output held for the screen after a transfer, and a message that ended the source.
    queued: Vec<u8>,
    ended: Option<ChannelMsg>,
}

impl<S: Source + Send + 'static> Inband<S> {
    pub(crate) fn new(inner: S, context: Context) -> Self {
        Self {
            inner: Some(inner),
            detector: Detector::default(),
            context,
            task: None,
            queued: Vec::new(),
            ended: None,
        }
    }

    fn data(bytes: Vec<u8>) -> Option<ChannelMsg> {
        Some(ChannelMsg::Data { data: bytes.into() })
    }

    fn start(&mut self, start: Start, after: Vec<u8>) {
        let Some(source) = self.inner.take() else {
            return;
        };
        let (back, receiver) = mpsc::channel(8);
        self.task = Some(receiver);
        tokio::spawn(run(source, start, after, self.context.clone(), back));
    }
}

impl<S: Source + Send + 'static> Source for Inband<S> {
    async fn next(&mut self) -> Option<ChannelMsg> {
        loop {
            if let Some(task) = &mut self.task {
                match task.recv().await {
                    Some(Back::Message(m)) => return Some(m),
                    Some(Back::Done(source, rest, ended)) => {
                        self.task = None;
                        self.inner = Some(source);
                        self.ended = ended;
                        // What follows may start another transfer (`sz a; sz b`).
                        match self.detector.push(&rest) {
                            Found::Output(b) => self.queued.extend(b),
                            Found::Start {
                                before,
                                start,
                                after,
                            } => {
                                self.queued.extend(before);
                                self.start(start, after);
                            }
                        }
                    }
                    None => return None,
                }
                continue;
            }
            if !self.queued.is_empty() {
                return Self::data(std::mem::take(&mut self.queued));
            }
            if let Some(m) = self.ended.take() {
                return Some(m);
            }
            let inner = self.inner.as_mut()?;
            let message = if self.detector.holding() {
                tokio::select! {
                    m = inner.next() => m,
                    () = tokio::time::sleep(HOLD) => return Self::data(self.detector.flush()),
                }
            } else {
                inner.next().await
            };
            match message {
                Some(ChannelMsg::Data { data }) => match self.detector.push(&data) {
                    Found::Output(b) if b.is_empty() => continue,
                    Found::Output(b) => return Self::data(b),
                    Found::Start {
                        before,
                        start,
                        after,
                    } => {
                        self.start(start, after);
                        if !before.is_empty() {
                            return Self::data(before);
                        }
                    }
                },
                // The end of output first shows what was held.
                None if self.detector.holding() => return Self::data(self.detector.flush()),
                other => return other,
            }
        }
    }
}

fn kind(start: &Start) -> (Direction, Protocol) {
    match start {
        Start::ZmodemDownload => (Direction::Download, Protocol::Zmodem),
        Start::ZmodemUpload => (Direction::Upload, Protocol::Zmodem),
        Start::TrzszDownload => (Direction::Download, Protocol::Trzsz),
        Start::TrzszUpload | Start::TrzszDirectory => (Direction::Upload, Protocol::Trzsz),
    }
}

/// One transfer, from the question to the end. Always hands the source back.
async fn run<S: Source + Send + 'static>(
    mut source: S,
    start: Start,
    after: Vec<u8>,
    context: Context,
    back: mpsc::Sender<Back<S>>,
) {
    let (direction, protocol) = kind(&start);
    let request = uuid::Uuid::new_v4().to_string();
    let (answer, answered) = oneshot::channel();
    let (stop, stopped) = watch::channel(false);
    context.transfers.0.lock().unwrap().insert(
        context.id.clone(),
        Active {
            request: request.clone(),
            direction,
            answer: Some(answer),
            stop,
        },
    );
    let mut progress = Progress {
        notice: Notice {
            request,
            stage: Stage::Ask,
            direction,
            protocol,
            name: None,
            done: 0,
            total: 0,
            files: 0,
            message: None,
        },
        sink: context.sink.clone(),
        last: Instant::now(),
    };
    let mut wire = TaskWire {
        source: &mut source,
        input: context.input.clone(),
        stop: stopped,
        back: &back,
        ended: None,
    };
    let result = if start == Start::TrzszDirectory {
        refuse(&mut wire, &start, after).await.and(Err(
            "폴더 받기(trz -d)는 지원하지 않습니다. 파일을 골라 trz로 보내세요.".to_string(),
        ))
    } else {
        progress.send();
        let choice = tokio::time::timeout(ASK_TIMEOUT, answered).await;
        match choice {
            Ok(Ok(Answer::Folder(folder))) => {
                let mut target = Download::new(folder);
                let r = transfer_in(&mut wire, &start, after, &mut target, &mut progress).await;
                if r.is_err() {
                    target.discard_partial().await;
                }
                r.map(|(names, rest)| (summary_in(&names, target.folder()), rest))
            }
            Ok(Ok(Answer::Files(paths))) => {
                let mut files = Upload::new(paths);
                transfer_out(&mut wire, &start, after, &mut files, &mut progress)
                    .await
                    .map(|(names, rest)| {
                        (
                            format!("파일 {}개를 보냈습니다: {}", names.len(), names.join(", ")),
                            rest,
                        )
                    })
            }
            _ => refuse(&mut wire, &start, after)
                .await
                .and(Err("전송을 거절했습니다.".into())),
        }
    };
    if result.is_err() && *wire.stop.borrow() {
        // The user stopped it: tell the server to stop too.
        let stop = match protocol {
            Protocol::Zmodem => zmodem::cancel_sequence(),
            Protocol::Trzsz => trzsz::stop_line(),
        };
        let _ = context.input.send(Input::Data(stop)).await;
    }
    let ended = wire.ended.take();
    context.transfers.0.lock().unwrap().remove(&context.id);
    let rest = match result {
        Ok((message, rest)) => {
            progress.end(Stage::Done, message);
            rest
        }
        Err(message) => {
            progress.end(Stage::Failed, message);
            Vec::new()
        }
    };
    let _ = back.send(Back::Done(source, rest, ended)).await;
}

fn summary_in(names: &[String], folder: &std::path::Path) -> String {
    format!(
        "파일 {}개를 {}에 저장했습니다: {}",
        names.len(),
        folder.display(),
        names.join(", ")
    )
}

type Moved = Result<(Vec<String>, Vec<u8>)>;

async fn transfer_in<W: Wire>(
    wire: &mut W,
    start: &Start,
    after: Vec<u8>,
    target: &mut Download,
    progress: &mut Progress,
) -> Moved {
    match start {
        Start::ZmodemDownload => zmodem::download(wire, after, target, progress).await,
        Start::TrzszDownload => {
            let mut lines = trzsz::Lines::new(wire, after);
            let names = trzsz::download(&mut lines, target, progress).await?;
            Ok((names, lines.rest()))
        }
        _ => Err("받기 요청이 아닙니다.".into()),
    }
}

async fn transfer_out<W: Wire>(
    wire: &mut W,
    start: &Start,
    after: Vec<u8>,
    files: &mut Upload,
    progress: &mut Progress,
) -> Moved {
    match start {
        Start::ZmodemUpload => zmodem::upload(wire, after, files, progress).await,
        Start::TrzszUpload => {
            let mut lines = trzsz::Lines::new(wire, after);
            let names = trzsz::upload(&mut lines, files, progress).await?;
            Ok((names, lines.rest()))
        }
        _ => Err("보내기 요청이 아닙니다.".into()),
    }
}

/// Tells the program on the server that nothing will be sent or taken.
async fn refuse<W: Wire>(wire: &mut W, start: &Start, after: Vec<u8>) -> Result<()> {
    match start {
        Start::ZmodemDownload | Start::ZmodemUpload => wire.write(zmodem::cancel_sequence()).await,
        _ => trzsz::decline(&mut trzsz::Lines::new(wire, after)).await,
    }
}

/// The tab's answer to a transfer's question, or a stop while it runs. The folder and the
/// files are picked here with the system's dialog: the web view never names a path.
#[tauri::command]
pub async fn inband_transfer_answer(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    id: String,
    request: String,
    action: String,
) -> Result<()> {
    state
        .connections
        .control(&id)?
        .broker
        .check(window.label())?;
    let transfers = state.connections.inband.clone();
    match action.as_str() {
        "stop" => transfers.stop(&id, &request),
        "decline" => transfers.answer(&id, &request, Answer::Decline),
        "accept" => {
            let answer = match transfers.pending(&id, &request)? {
                Direction::Download => rfd::AsyncFileDialog::new()
                    .set_title("받은 파일을 저장할 폴더")
                    .pick_folder()
                    .await
                    .map(|f| Answer::Folder(f.path().to_path_buf())),
                Direction::Upload => rfd::AsyncFileDialog::new()
                    .set_title("서버로 보낼 파일")
                    .pick_files()
                    .await
                    .map(|f| Answer::Files(f.iter().map(|f| f.path().to_path_buf()).collect())),
            };
            transfers.answer(&id, &request, answer.unwrap_or(Answer::Decline))
        }
        _ => Err("전송 응답 형식 오류".into()),
    }
}

impl Transfers {
    /// Answers as the tab's buttons and the system dialog would, for tests that drive a real
    /// server.
    #[cfg(test)]
    pub(crate) fn answer_with(
        &self,
        id: &str,
        request: &str,
        folder: Option<PathBuf>,
        files: Vec<PathBuf>,
    ) -> Result<()> {
        let answer = match folder {
            Some(f) => Answer::Folder(f),
            None if files.is_empty() => Answer::Decline,
            None => Answer::Files(files),
        };
        self.answer(id, request, answer)
    }
}

/// Two ends of a terminal in memory, and a progress that goes nowhere.
#[cfg(test)]
pub(super) mod testing {
    use super::*;

    pub(in crate::inband) struct Pipe {
        rx: mpsc::UnboundedReceiver<Vec<u8>>,
        tx: mpsc::UnboundedSender<Vec<u8>>,
    }

    pub(in crate::inband) fn pipe() -> (Pipe, Pipe) {
        let (a_tx, a_rx) = mpsc::unbounded_channel();
        let (b_tx, b_rx) = mpsc::unbounded_channel();
        (Pipe { rx: a_rx, tx: b_tx }, Pipe { rx: b_rx, tx: a_tx })
    }

    impl Wire for Pipe {
        async fn read_for(&mut self, limit: Duration) -> Result<Option<Vec<u8>>> {
            match tokio::time::timeout(limit, self.rx.recv()).await {
                Ok(Some(bytes)) => Ok(Some(bytes)),
                Ok(None) => Err("closed".into()),
                Err(_) => Ok(None),
            }
        }
        async fn write(&mut self, bytes: Vec<u8>) -> Result<()> {
            self.tx.send(bytes).map_err(|_| "closed".to_string())
        }
    }

    pub(in crate::inband) fn progress() -> (Progress, Arc<Mutex<Vec<Notice>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let sink: Sink = Arc::new(move |e| {
            if let Event::Inband(n) = e {
                log.lock().unwrap().push(n);
            }
            Ok(())
        });
        let notice = Notice {
            request: "r".into(),
            stage: Stage::Ask,
            direction: Direction::Download,
            protocol: Protocol::Trzsz,
            name: None,
            done: 0,
            total: 0,
            files: 0,
            message: None,
        };
        (
            Progress {
                notice,
                sink,
                last: Instant::now(),
            },
            seen,
        )
    }

    /// Bytes that compress badly and hit every escape: all 256 values, then noise.
    pub(in crate::inband) fn sample(len: usize) -> Vec<u8> {
        let mut x = 0x2545_f491_u32;
        (0..len)
            .map(|i| {
                if i < 256 {
                    return i as u8;
                }
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x as u8
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::testing::sample;
    use super::*;

    /// The server's end: reads what the tab types, writes what the tab shows.
    struct Server {
        typed: mpsc::Receiver<Input>,
        shows: mpsc::UnboundedSender<ChannelMsg>,
    }

    impl Wire for Server {
        async fn read_for(&mut self, limit: Duration) -> Result<Option<Vec<u8>>> {
            match tokio::time::timeout(limit, self.typed.recv()).await {
                Ok(Some(Input::Data(bytes))) => Ok(Some(bytes)),
                Ok(Some(_)) => Ok(Some(Vec::new())),
                Ok(None) => Err("closed".into()),
                Err(_) => Ok(None),
            }
        }
        async fn write(&mut self, bytes: Vec<u8>) -> Result<()> {
            self.shows
                .send(ChannelMsg::Data { data: bytes.into() })
                .map_err(|_| "closed".to_string())
        }
    }

    struct Tab {
        inband: Inband<mpsc::UnboundedReceiver<ChannelMsg>>,
        transfers: Arc<Transfers>,
        notices: Arc<Mutex<Vec<Notice>>>,
    }

    fn tab() -> (Tab, Server) {
        let (shows, output) = mpsc::unbounded_channel();
        let (input, typed) = mpsc::channel(64);
        let transfers = Arc::new(Transfers::default());
        let notices = Arc::new(Mutex::new(Vec::new()));
        let log = notices.clone();
        let sink: Sink = Arc::new(move |e| {
            if let Event::Inband(n) = e {
                log.lock().unwrap().push(n);
            }
            Ok(())
        });
        let context = Context {
            id: "c".into(),
            sink,
            input,
            transfers: transfers.clone(),
        };
        let tab = Tab {
            inband: Inband::new(output, context),
            transfers,
            notices,
        };
        (tab, Server { typed, shows })
    }

    /// Draws the tab's output until the server is gone, answering the question once.
    async fn draw(tab: &mut Tab, answer: impl Fn() -> Answer) -> String {
        let mut screen = Vec::new();
        let mut answered = false;
        loop {
            let next = tokio::time::timeout(Duration::from_millis(20), tab.inband.next()).await;
            match next {
                Ok(Some(ChannelMsg::Data { data })) => screen.extend_from_slice(&data),
                Ok(Some(_)) => {}
                Ok(None) => return String::from_utf8_lossy(&screen).into_owned(),
                // Dropping `next` here is what the pump does when an ACK comes first.
                Err(_) => {}
            }
            let asked = tab
                .notices
                .lock()
                .unwrap()
                .iter()
                .find(|n| n.stage == Stage::Ask)
                .cloned();
            if let (false, Some(ask)) = (answered, asked) {
                assert!(tab.transfers.check_input("c").is_err(), "typing waits");
                tab.transfers.answer("c", &ask.request, answer()).unwrap();
                answered = true;
            }
        }
    }

    #[tokio::test]
    async fn a_tsz_in_the_output_saves_where_the_user_picked_and_the_screen_goes_on() {
        let dir = tempfile::tempdir().unwrap();
        let (mut tab, mut server) = tab();
        let data = sample(40_000);
        let sent = data.clone();
        let server = tokio::spawn(async move {
            server
                .write(b"hello\r\n\x1b7::TRZSZ:TRANSFER:S:1.1.7:1763276400000:0\r\n".to_vec())
                .await?;
            let said = super::trzsz::tests::tsz(&mut server, "a.bin", sent).await?;
            server.write(b"\x1b8\x1b[0JSaved\r\n$ ".to_vec()).await?;
            Ok::<_, String>(said)
        });
        let folder = dir.path().to_path_buf();
        let screen = draw(&mut tab, || Answer::Folder(folder.clone())).await;
        assert_eq!(server.await.unwrap().unwrap(), "a.bin|Saved 1 file(s)");
        assert_eq!(screen, "hello\r\n\x1b8\x1b[0JSaved\r\n$ ");
        assert_eq!(std::fs::read(dir.path().join("a.bin")).unwrap(), data);
        let last = tab.notices.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last.stage, Stage::Done);
        assert!(last.message.unwrap().contains("a.bin"));
        tab.transfers.check_input("c").unwrap();
    }

    #[tokio::test]
    async fn a_refused_sz_is_cancelled_on_the_server_and_nothing_is_written() {
        let (mut tab, mut server) = tab();
        let server = tokio::spawn(async move {
            server
                .write(b"**\x18B00000000000000\r\x8a\x11".to_vec())
                .await?;
            let got = server.read().await?;
            server.write(b"\r\nskipped\r\n".to_vec()).await?;
            Ok::<_, String>(got)
        });
        let screen = draw(&mut tab, || Answer::Decline).await;
        assert_eq!(server.await.unwrap().unwrap(), zmodem::cancel_sequence());
        assert_eq!(screen, "\r\nskipped\r\n");
        let last = tab.notices.lock().unwrap().last().cloned().unwrap();
        assert_eq!(
            (last.stage, last.protocol),
            (Stage::Failed, Protocol::Zmodem)
        );
    }

    #[tokio::test]
    async fn a_stop_tells_the_server_and_removes_the_half_written_file() {
        let dir = tempfile::tempdir().unwrap();
        let (mut tab, mut server) = tab();
        let server = tokio::spawn(async move {
            server
                .write(b"\x1b7::TRZSZ:TRANSFER:S:1.1.7:1763276400000:0\r\n".to_vec())
                .await?;
            let mut lines = super::trzsz::Lines::new(&mut server, Vec::new());
            let mut seen = String::new();
            // ACT, then the answers, until the stop arrives.
            while !seen.contains("#fail:") {
                seen.push_str(&String::from_utf8_lossy(&lines.raw().await?));
                if seen.contains("#ACT:") && !seen.contains("SENT") {
                    seen.push_str("SENT");
                    lines.send_raw(b"#CFG:eJyrrgUAAXUA+Q==\n#NUM:1\n").await?;
                    lines
                        .send_raw(b"#NAME:eJxL1EvKzAMABQgByQ==\n#SIZE:100\n")
                        .await?;
                }
            }
            server.write(b"\r\nStopped\r\n".to_vec()).await?;
            Ok::<_, String>(())
        });
        let folder = dir.path().to_path_buf();
        let mut screen = Vec::new();
        let mut stopped = false;
        loop {
            match tokio::time::timeout(Duration::from_millis(20), tab.inband.next()).await {
                Ok(Some(ChannelMsg::Data { data })) => screen.extend_from_slice(&data),
                Ok(None) => break,
                _ => {}
            }
            let notices = tab.notices.lock().unwrap().clone();
            if let Some(ask) = notices.iter().find(|n| n.stage == Stage::Ask)
                && tab.transfers.pending("c", &ask.request).is_ok()
            {
                tab.transfers
                    .answer("c", &ask.request, Answer::Folder(folder.clone()))
                    .unwrap();
            }
            if !stopped && let Some(p) = notices.iter().find(|n| n.stage == Stage::Progress) {
                tab.transfers.stop("c", &p.request).unwrap();
                stopped = true;
            }
        }
        server.await.unwrap().unwrap();
        assert!(String::from_utf8_lossy(&screen).contains("Stopped"));
        let last = tab.notices.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last.stage, Stage::Failed);
        assert_eq!(last.message.as_deref(), Some(STOPPED));
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            0,
            "no half file stays"
        );
    }
}
