//! Serial console tab (CG.5): a router's or a board's console over a USB serial adapter. The port
//! is blocking, so one reader thread per tab reads with a short timeout and stops when the tab
//! does. Output goes through the SSH terminal's pump, so frames, ACKs, the session log, snippets
//! and multi-input work as in every other terminal.
use crate::{
    ssh::{Connections, Event, Input, Receivers, Sink},
    storage::{Flow, Parity, Profile, Result, SerialSettings, Store},
    terminal_output::{Other, Source, pump},
};
use russh::ChannelMsg;
use serde::Serialize;
use serialport::{ErrorKind, SerialPort};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{sync::mpsc, time::timeout};

/// How long a read waits, which is also how soon a closed tab's reader thread ends.
const READ_STEP: Duration = Duration::from_millis(200);
/// A Break holds the line low this long (common console practice; RFC 2217 leaves it open).
const BREAK: Duration = Duration::from_millis(250);
const BUSY: &str = "이미 다른 탭이나 프로그램이 이 포트를 쓰고 있습니다.";
const LOST: &str = "장치 연결이 끊겼습니다.";

type Port = Box<dyn SerialPort>;

/// Each open serial tab's port, kept to send a Break from the tab menu.
#[derive(Default)]
pub struct Breaks(Mutex<HashMap<String, Arc<Mutex<Port>>>>);

impl Breaks {
    fn insert(&self, id: &str, port: Arc<Mutex<Port>>) {
        self.0.lock().unwrap().insert(id.into(), port);
    }
    pub(crate) fn remove(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
    /// A handle of its own for the Break, so no lock is held while the line is held low.
    fn handle(&self, id: &str) -> Result<Port> {
        let port = self
            .0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("시리얼 연결이 아닙니다.")?;
        let clone = port.lock().unwrap().try_clone();
        clone.map_err(|_| LOST.into())
    }
}

fn data_bits(n: u8) -> serialport::DataBits {
    match n {
        5 => serialport::DataBits::Five,
        6 => serialport::DataBits::Six,
        7 => serialport::DataBits::Seven,
        _ => serialport::DataBits::Eight,
    }
}

/// The builder for a profile's settings. The speed is set after opening (see `open`).
fn builder(path: &str, s: &SerialSettings) -> serialport::SerialPortBuilder {
    serialport::new(path, 0)
        .data_bits(data_bits(s.data_bits))
        .parity(match s.parity {
            Parity::None => serialport::Parity::None,
            Parity::Odd => serialport::Parity::Odd,
            Parity::Even => serialport::Parity::Even,
        })
        .stop_bits(if s.stop_bits == 2 {
            serialport::StopBits::Two
        } else {
            serialport::StopBits::One
        })
        .flow_control(match s.flow {
            Flow::None => serialport::FlowControl::None,
            Flow::Software => serialport::FlowControl::Software,
            Flow::Hardware => serialport::FlowControl::Hardware,
        })
        .timeout(READ_STEP)
}

/// Why a port did not open, said for the user. The kinds, not the OS text, decide.
fn open_error(kind: ErrorKind, path: &str) -> String {
    match kind {
        ErrorKind::NoDevice => BUSY.into(),
        // Windows refuses a second opener with access denied.
        ErrorKind::Io(std::io::ErrorKind::PermissionDenied) if cfg!(windows) => BUSY.into(),
        ErrorKind::Io(std::io::ErrorKind::PermissionDenied) => {
            format!("{path}에 접근할 권한이 없습니다.")
        }
        ErrorKind::Io(std::io::ErrorKind::NotFound) => {
            format!("{path} 장치가 없습니다. 케이블을 확인하고 포트 목록에서 다시 고르세요.")
        }
        _ => format!("{path}를 열 수 없습니다."),
    }
}

/// Opens the profile's device. Opening without a speed and setting it after lets a device that
/// refuses the speed (a macOS pseudo-terminal does) be told apart from one that does not open.
fn open(p: &Profile) -> Result<Port> {
    let settings = p.serial.as_ref().ok_or("시리얼 통신 설정이 없습니다.")?;
    if !crate::storage::native_device(&p.host) {
        return Err(format!(
            "{}는 이 PC의 장치 이름이 아닙니다. 세션을 수정해 포트 목록에서 고르세요.",
            p.host
        ));
    }
    let mut port = builder(&p.host, settings)
        .open()
        .map_err(|e| open_error(e.kind, &p.host))?;
    port.set_baud_rate(settings.baud)
        .map_err(|_| "이 장치는 통신 속도 설정을 지원하지 않습니다.".to_string())?;
    Ok(port)
}

/// Output from the reader thread: bytes, or the device going away.
type Chunk = std::result::Result<Vec<u8>, ()>;

struct Reader {
    chunks: mpsc::Receiver<Chunk>,
    lost: bool,
}

impl Source for Reader {
    async fn next(&mut self) -> Option<ChannelMsg> {
        match self.chunks.recv().await? {
            Ok(bytes) => Some(ChannelMsg::Data { data: bytes.into() }),
            Err(()) => {
                self.lost = true;
                None
            }
        }
    }
}

/// Reads until the tab stops or the device goes away. Owned by `run_port`, which sets `stop`.
fn read_loop(mut port: Port, chunks: mpsc::Sender<Chunk>, stop: Arc<AtomicBool>) {
    let mut buffer = vec![0; 8192];
    while !stop.load(Ordering::Relaxed) {
        let chunk = match port.read(&mut buffer) {
            Ok(0) => Err(()),
            Ok(n) => Ok(buffer[..n].to_vec()),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::Interrupted
                ) =>
            {
                continue;
            }
            Err(_) => Err(()),
        };
        let ended = chunk.is_err();
        // The pump takes chunks only as fast as the window draws; waiting here is the backpressure.
        if chunks.blocking_send(chunk).is_err() || ended {
            break;
        }
    }
}

/// Ends the reader thread however `run_port` ends.
struct StopOnDrop(Arc<AtomicBool>);
impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
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
    let profile = p.clone();
    let port = tokio::task::spawn_blocking(move || open(&profile))
        .await
        .map_err(|_| "시리얼 포트를 열지 못했습니다.".to_string())??;
    run_port(manager, id, p, port, sink, channels, store).await
}

/// The tab on a port that is already open. Tests open a pseudo-terminal without a speed.
async fn run_port(
    manager: Arc<Connections>,
    id: String,
    p: Profile,
    port: Port,
    sink: Sink,
    channels: Receivers,
    store: Arc<Store>,
) -> Result<()> {
    let reader = port.try_clone().map_err(|_| LOST.to_string())?;
    let writer = Arc::new(Mutex::new(port.try_clone().map_err(|_| LOST.to_string())?));
    manager.serial.insert(&id, Arc::new(Mutex::new(port)));
    let stop = Arc::new(AtomicBool::new(false));
    let _stop = StopOnDrop(stop.clone());
    let (chunks, received) = mpsc::channel(16);
    std::thread::Builder::new()
        .name("serial-read".into())
        .spawn(move || read_loop(reader, chunks, stop))
        .map_err(|_| "시리얼 읽기를 시작하지 못했습니다.".to_string())?;
    let mut reader = Reader {
        chunks: received,
        lost: false,
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
        message: format!("연결됨 · 시리얼 {} · {}", p.host, settings_text(&p)),
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
        pump(&mut reader, &mut ack, send, |_| Other::Ignore, stalled).await?;
        Err(LOST.to_string())
    };
    let input_loop = async {
        while let Some(command) = input.recv().await {
            let Input::Data(bytes) = command else {
                continue;
            };
            let writer = writer.clone();
            let written = tokio::task::spawn_blocking(move || {
                let mut port = writer.lock().unwrap();
                port.write_all(&bytes).and_then(|()| port.flush())
            });
            match timeout(Duration::from_secs(10), written).await {
                Ok(Ok(Ok(()))) => {}
                _ => return Err(LOST.to_string()),
            }
        }
        Ok(())
    };
    tokio::select! {r = output => r, r = input_loop => r}
}

/// `115200 8N1`, and the flow control when there is one.
pub(crate) fn settings_text(p: &Profile) -> String {
    let Some(s) = &p.serial else {
        return String::new();
    };
    let parity = match s.parity {
        Parity::None => 'N',
        Parity::Odd => 'O',
        Parity::Even => 'E',
    };
    let flow = match s.flow {
        Flow::None => "",
        Flow::Software => " · XON/XOFF",
        Flow::Hardware => " · RTS/CTS",
    };
    format!("{} {}{}{}{flow}", s.baud, s.data_bits, parity, s.stop_bits)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortInfo {
    name: String,
    /// The USB adapter's maker and product, when the port is one.
    description: Option<String>,
}

/// macOS lists every device twice; `tty.*` waits for carrier detect when opened, `cu.*` does not.
fn listed(name: &str) -> bool {
    !cfg!(target_os = "macos") || name.starts_with("/dev/cu.")
}

#[tauri::command]
pub async fn serial_ports() -> Result<Vec<PortInfo>> {
    let ports = tokio::task::spawn_blocking(serialport::available_ports)
        .await
        .map_err(|_| "시리얼 포트 목록을 읽지 못했습니다.".to_string())?
        .map_err(|_| "시리얼 포트 목록을 읽지 못했습니다.".to_string())?;
    Ok(ports
        .into_iter()
        .filter(|p| listed(&p.port_name))
        .map(|p| PortInfo {
            description: match p.port_type {
                serialport::SerialPortType::UsbPort(usb) => {
                    let parts: Vec<String> = [usb.manufacturer, usb.product]
                        .into_iter()
                        .flatten()
                        .collect();
                    (!parts.is_empty()).then(|| parts.join(" "))
                }
                _ => None,
            },
            name: p.port_name,
        })
        .collect())
}

#[tauri::command]
pub async fn terminal_send_break(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    id: String,
) -> Result<()> {
    state
        .connections
        .control(&id)?
        .broker
        .check(window.label())?;
    let port = state.connections.serial.handle(&id)?;
    tokio::task::spawn_blocking(move || {
        port.set_break().map_err(|_| LOST.to_string())?;
        std::thread::sleep(BREAK);
        port.clear_break().map_err(|_| LOST.to_string())
    })
    .await
    .map_err(|_| "Break를 보내지 못했습니다.".to_string())?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::storage::SerialSettings;
    use serialport::TTYPort;

    fn settings() -> SerialSettings {
        SerialSettings {
            baud: 115_200,
            data_bits: 8,
            parity: Parity::None,
            stop_bits: 1,
            flow: Flow::None,
        }
    }

    #[test]
    fn says_the_settings_as_a_console_label_does() {
        let mut p = Profile::imported("console", "/dev/cu.usbserial", "", 0);
        p.serial = Some(SerialSettings {
            parity: Parity::Even,
            flow: Flow::Hardware,
            data_bits: 7,
            ..settings()
        });
        assert_eq!(settings_text(&p), "115200 7E1 · RTS/CTS");
        assert_eq!(open_error(ErrorKind::NoDevice, "COM3"), BUSY);
        assert!(
            open_error(ErrorKind::Io(std::io::ErrorKind::NotFound), "COM3").contains("없습니다")
        );
    }

    #[test]
    fn a_device_name_of_the_other_system_says_so() {
        let other = if cfg!(windows) {
            "/dev/cu.usbserial"
        } else {
            "COM3"
        };
        let mut p = Profile::imported("console", other, "", 0);
        p.serial = Some(settings());
        assert!(
            open(&p)
                .unwrap_err()
                .contains("이 PC의 장치 이름이 아닙니다")
        );
    }

    /// A pseudo-terminal pair stands in for the cable: the far end is the device.
    #[tokio::test]
    async fn carries_output_and_typing_and_ends_when_the_device_goes() {
        let (mut device, mut port) = TTYPort::pair().unwrap();
        port.set_timeout(READ_STEP).unwrap();
        device.set_timeout(Duration::from_secs(5)).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir.path().join("s.sqlite3")).unwrap());
        let mut p = Profile::imported("console", "/dev/cu.test", "", 0);
        p.protocol = "serial".into();
        p.auth = "interactive".into();
        p.serial = Some(settings());
        p.id.clear();
        let p = store.save(p, None).unwrap();
        let manager = Arc::new(Connections::default());
        let (tx, mut events) = mpsc::unbounded_channel();
        let sink: Sink = Arc::new(move |e| {
            let _ = tx.send(e);
            Ok(())
        });
        let id = uuid::Uuid::new_v4().to_string();
        let (sink, channels) = manager.register(&id, &p, &[], sink, &store).unwrap();
        let tab = tokio::spawn(run_port(
            manager.clone(),
            id.clone(),
            p,
            Box::new(port),
            sink,
            channels,
            store,
        ));
        let next = async |events: &mut mpsc::UnboundedReceiver<Event>| {
            tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .unwrap()
                .unwrap()
        };
        assert!(
            matches!(next(&mut events).await, Event::State { status, .. } if status == "connected")
        );
        manager.terminal_ready(&id).unwrap();
        device.write_all(b"device> ").unwrap();
        match next(&mut events).await {
            Event::Data { seq, bytes } => {
                assert_eq!(bytes, b"device> ");
                manager.control(&id).unwrap().ack.send(seq).unwrap();
            }
            _ => panic!("expected output"),
        }
        let input = manager.control(&id).unwrap().input.clone();
        input
            .send(Input::Data(b"show version\r".to_vec()))
            .await
            .unwrap();
        let mut typed = [0; 13];
        tokio::task::spawn_blocking(move || {
            device.read_exact(&mut typed).unwrap();
            assert_eq!(&typed, b"show version\r");
            // Unplugging the cable: the far end goes away.
            drop(device);
        })
        .await
        .unwrap();
        let ended = tokio::time::timeout(Duration::from_secs(5), tab)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ended.unwrap_err(), LOST);
    }

    /// The device console of `npm run connect:fixture -- up` (CG.0), through a socat
    /// pseudo-terminal as `connect:fixture -- serial` makes one. A pseudo-terminal refuses a speed
    /// on macOS, so it opens without one here; ending socat stands in for unplugging.
    #[tokio::test]
    #[ignore = "needs npm run connect:fixture -- up and socat"]
    async fn talks_to_the_fixture_console_and_sees_it_unplugged() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("tty.dachs-serial");
        let mut socat = std::process::Command::new(
            [
                "/opt/homebrew/bin/socat",
                "/usr/local/bin/socat",
                "/usr/bin/socat",
            ]
            .into_iter()
            .find(|p| std::path::Path::new(p).exists())
            .expect("socat"),
        )
        .arg(format!("pty,raw,echo=0,link={}", link.display()))
        .arg("tcp:127.0.0.1:47000")
        .spawn()
        .unwrap();
        while !link.exists() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let path = link.to_string_lossy().to_string();
        let port = builder(&path, &settings()).open().unwrap();
        let dir2 = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&dir2.path().join("s.sqlite3")).unwrap());
        let mut p = Profile::imported("console", "/dev/cu.fixture", "", 0);
        p.protocol = "serial".into();
        p.auth = "interactive".into();
        p.serial = Some(settings());
        p.id.clear();
        let p = store.save(p, None).unwrap();
        let manager = Arc::new(Connections::default());
        let (tx, mut events) = mpsc::unbounded_channel();
        let sink: Sink = Arc::new(move |e| {
            let _ = tx.send(e);
            Ok(())
        });
        let id = uuid::Uuid::new_v4().to_string();
        let (sink, channels) = manager.register(&id, &p, &[], sink, &store).unwrap();
        let tab = tokio::spawn(run_port(
            manager.clone(),
            id.clone(),
            p,
            port,
            sink,
            channels,
            store,
        ));
        let control = manager.control(&id).unwrap();
        control
            .input
            .send(Input::Data(b"echo serial-$((40+2))\r".to_vec()))
            .await
            .unwrap();
        let mut screen = String::new();
        while !screen.contains("serial-42\r\n") {
            let event = tokio::time::timeout(Duration::from_secs(10), events.recv())
                .await
                .unwrap_or_else(|_| panic!("no answer; screen: {screen:?}"))
                .unwrap();
            if let Event::Data { seq, bytes } = event {
                screen.push_str(&String::from_utf8_lossy(&bytes));
                let _ = control.ack.send(seq);
            }
        }
        // A Break goes out on the line; a pseudo-terminal cannot show it arrived.
        let breaker = manager.serial.handle(&id).unwrap();
        breaker.set_break().unwrap();
        breaker.clear_break().unwrap();
        socat.kill().unwrap();
        let _ = socat.wait();
        let ended = tokio::time::timeout(Duration::from_secs(5), tab)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(ended.unwrap_err(), LOST);
    }
}
