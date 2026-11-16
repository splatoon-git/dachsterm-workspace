//! Telnet terminal tab (CG.4), for network devices and old hosts. Everything typed, passwords
//! included, crosses the network in the clear: the app saves no password for it and types no
//! login, and the tab says so. Output goes through the SSH terminal's pump, so frames, ACKs, the
//! session log, snippets, multi-input and detached windows behave as they do for SSH.
mod protocol;

use crate::{
    ssh::{Connections, Event, Input, Receivers, Sink},
    storage::{Profile, Result, Store},
    terminal_output::{Other, Source, pump},
};
use protocol::Telnet;
use russh::ChannelMsg;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, tcp::OwnedReadHalf},
    sync::mpsc,
    time::timeout,
};

/// Negotiation answers waiting to be written. A server that asks faster than it reads is cut off.
const MAX_REPLIES: usize = 256;

/// Reads the socket and hands the screen only data; negotiation answers go to the writer.
struct Reader {
    socket: OwnedReadHalf,
    telnet: Arc<Mutex<Telnet>>,
    replies: mpsc::Sender<Vec<u8>>,
    buffer: Vec<u8>,
    flooded: bool,
}

impl Source for Reader {
    async fn next(&mut self) -> Option<ChannelMsg> {
        loop {
            let read = self.socket.read(&mut self.buffer).await.ok()?;
            if read == 0 {
                return None;
            }
            let parsed = self.telnet.lock().unwrap().feed(&self.buffer[..read]);
            if !parsed.reply.is_empty() && self.replies.try_send(parsed.reply).is_err() {
                self.flooded = true;
                return Some(ChannelMsg::Close);
            }
            if !parsed.data.is_empty() {
                return Some(ChannelMsg::Data {
                    data: parsed.data.into(),
                });
            }
        }
    }
}

async fn write(socket: &mut tokio::net::tcp::OwnedWriteHalf, bytes: &[u8]) -> Result<()> {
    match timeout(Duration::from_secs(10), socket.write_all(bytes)).await {
        Ok(Ok(())) => Ok(()),
        _ => Err("Telnet 서버로 입력을 보내지 못했습니다.".into()),
    }
}

pub(crate) async fn run(
    manager: Arc<Connections>,
    id: String,
    p: Profile,
    sink: Sink,
    channels: Receivers,
    store: Arc<Store>,
) -> Result<()> {
    let place = format!("{}:{}", p.host, p.port);
    let stream = timeout(
        Duration::from_secs(p.timeout),
        TcpStream::connect((p.host.as_str(), p.port)),
    )
    .await
    .map_err(|_| format!("Telnet 서버({place}) 연결 시간이 초과되었습니다."))?
    .map_err(|_| format!("Telnet 서버({place})에 연결할 수 없습니다."))?;
    // Typing goes out a key at a time; Nagle would hold each key back for an ACK.
    let _ = stream.set_nodelay(true);
    let (socket, mut writer) = stream.into_split();
    let telnet = Arc::new(Mutex::new(Telnet::new(80, 24)));
    let (replies, mut answers) = mpsc::channel(MAX_REPLIES);
    let mut reader = Reader {
        socket,
        telnet: telnet.clone(),
        replies,
        buffer: vec![0; 16384],
        flooded: false,
    };
    manager.mark_streaming(&id);
    manager.logs.register(&id, &p.encoding)?;
    crate::session_log::auto_start(
        &manager.logs,
        &store,
        &id,
        &format!("ssh:{}", p.id),
        &p.name,
    );
    store.touch(&p.id)?;
    sink(Event::State {
        status: "connected".into(),
        message: format!("연결됨 · Telnet · 암호화 없음 · {place}"),
    })?;
    let Receivers {
        mut input, mut ack, ..
    } = channels;
    let output = async {
        let send = |seq, bytes: Vec<u8>| {
            manager.logs.data(&id, &bytes);
            sink(Event::Data { seq, bytes })
        };
        let stalled = "터미널 렌더링 응답이 없어 연결을 종료했습니다.";
        pump(&mut reader, &mut ack, send, |_| Other::End, stalled).await?;
        if reader.flooded {
            return Err("Telnet 서버가 옵션 협상을 너무 많이 보내 연결을 종료했습니다.".into());
        }
        Ok(())
    };
    let input_loop = async {
        loop {
            tokio::select! {
                Some(answer) = answers.recv() => write(&mut writer, &answer).await?,
                command = input.recv() => {
                    let bytes = match command {
                        None => return Ok(()),
                        Some(Input::Data(bytes)) => telnet.lock().unwrap().encode_input(&bytes),
                        Some(Input::Resize(cols, rows)) => {
                            let cols = cols.min(u16::MAX as u32) as u16;
                            let rows = rows.min(u16::MAX as u32) as u16;
                            telnet.lock().unwrap().resize(cols, rows)
                        }
                    };
                    if !bytes.is_empty() {
                        write(&mut writer, &bytes).await?;
                    }
                }
            }
        }
    };
    let result: Result<()> = tokio::select! {r = output => r, r = input_loop => r};
    let _ = timeout(Duration::from_secs(2), writer.shutdown()).await;
    result
}

#[cfg(test)]
mod tests {
    use super::protocol::IAC;
    use crate::ssh::{Connections, Event, Input};
    use crate::storage::{Profile, Store};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::mpsc;
    use zeroize::Zeroizing;

    const DO: u8 = 253;
    const WILL: u8 = 251;
    const SB: u8 = 250;
    const SE: u8 = 240;

    /// Reads from the client until `want` has arrived, and returns all that came.
    async fn read_until(socket: &mut tokio::net::TcpStream, want: &[u8]) -> Vec<u8> {
        let mut got = Vec::new();
        let mut buf = [0; 256];
        while !got.windows(want.len()).any(|w| w == want) {
            let n = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut buf))
                .await
                .expect("client went quiet")
                .unwrap();
            assert!(n > 0, "client closed early");
            got.extend_from_slice(&buf[..n]);
        }
        got
    }

    #[tokio::test]
    async fn negotiates_logs_in_by_typing_and_reports_the_close() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut hello = vec![IAC, DO, 31, IAC, DO, 24, IAC, WILL, 1];
            hello.extend_from_slice(b"login: ");
            socket.write_all(&hello).await.unwrap();
            // Answers, typing and the new size, however the reads split them.
            let all = read_until(&mut socket, &[IAC, SB, 31, 0, 120, 0, 40, IAC, SE]).await;
            socket.write_all(b"\r\0Welcome\r\n").await.unwrap();
            all
        });

        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("s.sqlite3")).unwrap());
        let mut profile = Profile::imported("switch", "127.0.0.1", "", port);
        profile.protocol = "telnet".into();
        profile.auth = "interactive".into();
        profile.id.clear();
        let profile = store.save(profile, None).unwrap();
        let manager = Arc::new(Connections::default());
        let (tx, mut events) = mpsc::unbounded_channel();
        let id = uuid::Uuid::new_v4().to_string();
        manager
            .start(
                id.clone(),
                profile,
                Zeroizing::new(String::new()),
                vec![],
                Arc::new(move |e| {
                    let _ = tx.send(e);
                    Ok(())
                }),
                store,
            )
            .unwrap();

        let mut screen = Vec::new();
        let mut status = Vec::new();
        let mut typed = false;
        while let Some(event) = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .unwrap()
        {
            match event {
                Event::Data { seq, bytes } => {
                    screen.extend_from_slice(&bytes);
                    // The server may close before the last frame is drawn.
                    let Ok(control) = manager.control(&id) else {
                        continue;
                    };
                    let _ = control.ack.send(seq);
                    if !typed && screen.ends_with(b"login: ") {
                        typed = true;
                        manager.terminal_ready(&id).unwrap();
                        let input = control.input.clone();
                        input.send(Input::Data(b"root\r".to_vec())).await.unwrap();
                        input.send(Input::Resize(120, 40)).await.unwrap();
                    }
                }
                Event::State { status: s, message } => {
                    status.push((s.clone(), message));
                    if s == "closed" || s == "error" {
                        break;
                    }
                }
                _ => {}
            }
        }
        let sent = server.await.unwrap();
        // Window size first (asked first), then the terminal type and the server's echo.
        assert!(sent.starts_with(&[IAC, WILL, 31, IAC, SB, 31, 0, 80, 0, 24, IAC, SE]));
        assert!(sent.windows(3).any(|w| w == [IAC, DO, 1]));
        assert!(sent.windows(6).any(|w| w == b"root\r\0"));
        assert_eq!(screen, b"login: \rWelcome\r\n");
        assert_eq!(status[0].0, "connected");
        assert!(status[0].1.contains("암호화 없음"));
        assert_eq!(status.last().unwrap().0, "closed");
        assert!(manager.terminal_ready(&id).is_err());
    }

    /// Drives a Telnet tab the way the window does: draws (ACKs) every frame and types.
    struct Tab {
        manager: Arc<Connections>,
        id: String,
        events: mpsc::UnboundedReceiver<Event>,
        screen: String,
        closed: Option<String>,
    }
    impl Tab {
        async fn open(host: &str, port: u16, dir: &std::path::Path) -> Self {
            let store = Arc::new(Store::open(&dir.join("s.sqlite3")).unwrap());
            let mut profile = Profile::imported("fixture", host, "", port);
            profile.protocol = "telnet".into();
            profile.auth = "interactive".into();
            profile.id.clear();
            let profile = store.save(profile, None).unwrap();
            let manager = Arc::new(Connections::default());
            let (tx, events) = mpsc::unbounded_channel();
            let id = uuid::Uuid::new_v4().to_string();
            let sink: crate::ssh::Sink = Arc::new(move |e| {
                let _ = tx.send(e);
                Ok(())
            });
            let empty = Zeroizing::new(String::new());
            manager
                .start(id.clone(), profile, empty, vec![], sink, store)
                .unwrap();
            Tab {
                manager,
                id,
                events,
                screen: String::new(),
                closed: None,
            }
        }
        /// Waits until the screen, from `from` on, holds `text`. Returns where it ends.
        async fn wait(&mut self, from: usize, text: &str) -> usize {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
            loop {
                if let Some(at) = self.screen[from..].find(text) {
                    return from + at + text.len();
                }
                assert!(self.closed.is_none(), "closed while waiting for {text:?}");
                let event = tokio::time::timeout_at(deadline, self.events.recv())
                    .await
                    .unwrap_or_else(|_| {
                        let tail: String = self.screen.chars().rev().take(200).collect();
                        let tail: String = tail.chars().rev().collect();
                        panic!("no {text:?} on screen, which ends with {tail:?}")
                    })
                    .unwrap();
                match event {
                    Event::Data { seq, bytes } => {
                        self.screen.push_str(&String::from_utf8_lossy(&bytes));
                        if let Ok(c) = self.manager.control(&self.id) {
                            let _ = c.ack.send(seq);
                        }
                    }
                    Event::State { status, message } if status != "connected" => {
                        self.closed = Some(format!("{status}: {message}"))
                    }
                    _ => {}
                }
            }
        }
        /// Draws until the connection ends, and says how.
        async fn end(&mut self) -> String {
            while self.closed.is_none() {
                let event = tokio::time::timeout(Duration::from_secs(20), self.events.recv())
                    .await
                    .expect("the connection did not end")
                    .unwrap();
                match event {
                    Event::Data { seq, .. } => {
                        if let Ok(c) = self.manager.control(&self.id) {
                            let _ = c.ack.send(seq);
                        }
                    }
                    Event::State { status, message } if status != "connected" => {
                        self.closed = Some(format!("{status}: {message}"))
                    }
                    _ => {}
                }
            }
            self.closed.clone().unwrap()
        }
        async fn send(&self, input: Input) {
            let control = self.manager.control(&self.id).unwrap();
            control.input.send(input).await.unwrap();
        }
    }

    /// The real telnetd of `npm run connect:fixture` (CG.0): login typed in the terminal, the
    /// window size and TERM it sees, a session log, and the end when the shell exits.
    #[tokio::test]
    #[ignore = "needs npm run connect:fixture -- up"]
    async fn logs_into_the_fixture_telnetd() {
        let secrets = std::env::temp_dir().join("dachsterm-connect-fixture");
        let password = Zeroizing::new(
            std::fs::read_to_string(secrets.join("user.password"))
                .unwrap()
                .trim()
                .to_string(),
        );
        let dir = tempfile::tempdir().unwrap();
        let mut tab = Tab::open("127.0.0.1", 42323, dir.path()).await;
        let at = tab.wait(0, "login: ").await;
        tab.send(Input::Data(b"probe\r".to_vec())).await;
        let at = tab.wait(at, "assword: ").await;
        let mut typed = password.as_bytes().to_vec();
        typed.push(b'\r');
        tab.send(Input::Data(typed)).await;
        let at = tab.wait(at, "$ ").await;
        assert!(
            !tab.screen.contains(password.as_str()),
            "the password must not echo"
        );
        tab.manager.terminal_ready(&tab.id).unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir(&logs).unwrap();
        let options = crate::session_log::Options {
            directory: logs.to_string_lossy().into(),
            timestamps: false,
            max_bytes: 1_048_576,
            keep_files: 2,
            daily: false,
        };
        tab.manager
            .logs
            .start(&tab.id, "fixture", options, vec![])
            .unwrap();
        tab.send(Input::Resize(132, 43)).await;
        let line = crate::snippets::payload("stty size; echo TERM=$TERM", true, false).unwrap();
        tab.send(Input::Data(line.into_bytes())).await;
        let at = tab.wait(at, "43 132").await;
        let at = tab.wait(at, "TERM=xterm-256color").await;
        tab.send(Input::Data("echo 한글\r".as_bytes().to_vec()))
            .await;
        let at = tab.wait(at, "\r한글\r\n").await;
        assert!(at > 0);
        tab.send(Input::Data(b"exit\r".to_vec())).await;
        assert_eq!(tab.end().await, "closed: 연결이 종료되었습니다.");
        // The log sits in a folder of its own under the chosen one.
        let mut log = logs.clone();
        while log.is_dir() {
            log = std::fs::read_dir(&log)
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
        }
        let text = std::fs::read_to_string(log).unwrap();
        assert!(text.contains("TERM=xterm-256color") && text.contains("한글"));
        assert!(!text.contains(password.as_str()));
    }
}
