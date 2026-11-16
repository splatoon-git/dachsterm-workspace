//! X11 forwarding to an X server the user runs (XQuartz, VcXsrv, …), as OpenSSH does it (CG.9).
//! The server gets a random cookie; each X11 channel it opens must present that cookie, which is
//! swapped for this PC's real one (or none) before the bytes reach the local display. Only a
//! connection that asked for forwarding has a `Forward`, so any other X11 channel is refused.
use crate::{
    ssh::{Event, Sink},
    storage::{Profile, Result},
};
use russh::{Channel, ChannelMsg, client};
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const PROTOCOL: &str = "MIT-MAGIC-COOKIE-1";
const NO_SERVER: &str = "X 서버(XQuartz, VcXsrv 등)를 먼저 실행하세요.";
/// An X11 setup packet's name and cookie are short; anything longer is not one.
const MAX_AUTH: usize = 1024;

/// Where the local X server listens.
#[derive(Debug, PartialEq)]
pub enum Target {
    Tcp(String, u16),
    #[cfg(unix)]
    Unix(PathBuf),
}

#[derive(Debug, PartialEq)]
pub struct Display {
    pub target: Target,
    /// The display number as Xauthority records name it.
    pub number: String,
    pub screen: u32,
}

/// `:0`, `unix:0`, `host:0.1`, `[::1]:0` or XQuartz's socket path `/private/tmp/…/org.xquartz:0`.
pub fn parse_display(value: &str) -> Option<Display> {
    let (head, tail) = value.rsplit_once(':')?;
    let (number, screen) = tail.split_once('.').unwrap_or((tail, "0"));
    // The TCP port is 6000 + the number.
    let n: u16 = number.parse().ok().filter(|n| *n <= u16::MAX - 6000)?;
    let screen = screen.parse().ok()?;
    let target = if head.starts_with('/') {
        // The socket file's name ends with `:<number>` (launchd's XQuartz socket).
        socket(PathBuf::from(format!("{head}:{number}")))?
    } else if head.is_empty() || head == "unix" {
        socket(PathBuf::from(format!("/tmp/.X11-unix/X{n}")))
            .unwrap_or(Target::Tcp("localhost".into(), 6000 + n))
    } else {
        let host = head.trim_start_matches('[').trim_end_matches(']');
        if host.is_empty() || host.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return None;
        }
        Target::Tcp(host.into(), 6000 + n)
    };
    Some(Display {
        target,
        number: n.to_string(),
        screen,
    })
}

#[cfg(unix)]
fn socket(path: PathBuf) -> Option<Target> {
    Some(Target::Unix(path))
}
/// Windows X servers listen on TCP only.
#[cfg(not(unix))]
fn socket(_: PathBuf) -> Option<Target> {
    None
}

/// The display a session forwards to: its own setting, else `DISPLAY` (macOS), else the usual
/// Windows X servers' `localhost:0.0`.
fn display_of(p: &Profile) -> Option<String> {
    if !p.x11_display.is_empty() {
        return Some(p.x11_display.clone());
    }
    if cfg!(windows) {
        return Some("localhost:0.0".into());
    }
    std::env::var("DISPLAY").ok().filter(|d| !d.is_empty())
}

/// The Xauthority file: `XAUTHORITY`, else `~/.Xauthority`. It is read directly, so no `xauth`
/// program has to be found on `PATH`.
fn xauthority() -> Option<PathBuf> {
    std::env::var_os("XAUTHORITY")
        .map(PathBuf::from)
        .or_else(|| dirs_home().map(|h| h.join(".Xauthority")))
}
/// This PC's cookie for a display number. `None` sends no authentication, which servers started
/// without access control (VcXsrv `-ac`) accept.
fn real_cookie(file: Option<&PathBuf>, number: &str) -> Option<Vec<u8>> {
    find_cookie(&std::fs::read(file?).ok()?, number)
}
fn dirs_home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}
/// Records are a family and four length-prefixed fields: address, number, name, data.
pub fn find_cookie(mut data: &[u8], number: &str) -> Option<Vec<u8>> {
    fn field<'a>(data: &mut &'a [u8]) -> Option<&'a [u8]> {
        let len = u16::from_be_bytes([*data.first()?, *data.get(1)?]) as usize;
        let value = data.get(2..2 + len)?;
        *data = &data[2 + len..];
        Some(value)
    }
    while data.len() >= 2 {
        data = &data[2..];
        let _address = field(&mut data)?;
        let found = field(&mut data)?;
        let name = field(&mut data)?;
        let cookie = field(&mut data)?;
        if found == number.as_bytes() && name == PROTOCOL.as_bytes() {
            return Some(cookie.to_vec());
        }
    }
    None
}

/// Rewrites a client's setup packet: its cookie must be `fake`, and is replaced by `real`.
/// Returns the packet to send on, or `None` for a client without the cookie.
pub async fn swap_cookie<R: AsyncRead + Unpin>(
    from: &mut R,
    fake: &[u8],
    real: Option<&[u8]>,
) -> Option<Vec<u8>> {
    let mut head = [0u8; 12];
    from.read_exact(&mut head).await.ok()?;
    let read16 = |b: [u8; 2]| match head[0] {
        b'l' => Some(u16::from_le_bytes(b)),
        b'B' => Some(u16::from_be_bytes(b)),
        _ => None,
    };
    let name_len = read16([head[6], head[7]])? as usize;
    let data_len = read16([head[8], head[9]])? as usize;
    if name_len > MAX_AUTH || data_len > MAX_AUTH {
        return None;
    }
    let pad = |n: usize| (4 - n % 4) % 4;
    let mut auth = vec![0u8; name_len + pad(name_len) + data_len + pad(data_len)];
    from.read_exact(&mut auth).await.ok()?;
    let name = &auth[..name_len];
    let cookie = &auth[name_len + pad(name_len)..][..data_len];
    if name != PROTOCOL.as_bytes() || cookie != fake {
        return None;
    }
    let write16 = |n: usize| {
        let n = n as u16;
        if head[0] == b'l' {
            n.to_le_bytes()
        } else {
            n.to_be_bytes()
        }
    };
    let (name, cookie): (&[u8], &[u8]) = match real {
        Some(real) => (PROTOCOL.as_bytes(), real),
        None => (&[], &[]),
    };
    let mut out = head.to_vec();
    out[6..8].copy_from_slice(&write16(name.len()));
    out[8..10].copy_from_slice(&write16(cookie.len()));
    for part in [name, cookie] {
        out.extend_from_slice(part);
        out.extend(std::iter::repeat_n(0, pad(part.len())));
    }
    Some(out)
}

/// The X11 forwarding of one connection that asked for it.
pub struct Forward {
    display: Display,
    xauthority: Option<PathBuf>,
    fake: [u8; 16],
    sink: Sink,
    told: AtomicBool,
}
impl Forward {
    /// `None` when the session does not forward X11. A display that cannot be used is told to
    /// the user once and the connection goes on without forwarding.
    pub fn new(p: &Profile, sink: Sink) -> Result<Option<Arc<Self>>> {
        if !p.forward_x11 {
            return Ok(None);
        }
        let Some(display) = display_of(p).as_deref().and_then(parse_display) else {
            let _ = sink(Event::AgentNotice {
                message: format!(
                    "X11 포워딩을 하지 않습니다. 표시할 곳(DISPLAY)이 없습니다. {NO_SERVER}"
                ),
            });
            return Ok(None);
        };
        Ok(Some(Arc::new(Self {
            display,
            xauthority: xauthority(),
            fake: crate::vault::random::<16>()?,
            sink,
            told: AtomicBool::new(false),
        })))
    }
    fn tell(&self, message: String) {
        if !self.told.swap(true, Ordering::SeqCst) {
            let _ = (self.sink)(Event::AgentNotice { message });
        }
    }
    /// Asks for forwarding on the shell's channel before anything else is requested on it, so
    /// the next reply on the channel is this request's.
    pub async fn request(&self, channel: &mut Channel<client::Msg>) {
        let cookie: String = self.fake.iter().map(|b| format!("{b:02x}")).collect();
        let sent = channel
            .request_x11(true, false, PROTOCOL, cookie, self.display.screen)
            .await;
        let reply = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match channel.wait().await {
                    Some(ChannelMsg::Success) => return true,
                    Some(ChannelMsg::Failure) | None => return false,
                    Some(_) => {}
                }
            }
        });
        if sent.is_err() || !matches!(reply.await, Ok(true)) {
            self.tell("서버가 X11 포워딩을 거부했습니다. 서버의 X11Forwarding 설정과 xauth 설치를 확인하세요.".into());
        }
    }
    /// A channel the server opened for an X client: checked, then relayed to the local display.
    pub fn relay(self: &Arc<Self>, channel: Channel<client::Msg>) {
        let forward = self.clone();
        // Owned by the channel: it ends when either the X client or the local server closes.
        tokio::spawn(async move {
            let mut remote = channel.into_stream();
            let real = real_cookie(forward.xauthority.as_ref(), &forward.display.number);
            let Some(setup) = swap_cookie(&mut remote, &forward.fake, real.as_deref()).await else {
                return;
            };
            match &forward.display.target {
                Target::Tcp(host, port) => {
                    match tokio::net::TcpStream::connect((host.as_str(), *port)).await {
                        Ok(local) => pipe(remote, local, &setup).await,
                        Err(_) => forward.tell(NO_SERVER.into()),
                    }
                }
                #[cfg(unix)]
                Target::Unix(path) => match tokio::net::UnixStream::connect(path).await {
                    Ok(local) => pipe(remote, local, &setup).await,
                    Err(_) => forward.tell(NO_SERVER.into()),
                },
            }
        });
    }
}

#[cfg(test)]
impl Forward {
    pub fn for_test(display: &str, xauthority: Option<PathBuf>, sink: Sink) -> Arc<Self> {
        Arc::new(Self {
            display: parse_display(display).unwrap(),
            xauthority,
            fake: [7; 16],
            sink,
            told: AtomicBool::new(false),
        })
    }
}

async fn pipe<A, B>(mut remote: A, mut local: B, setup: &[u8])
where
    A: AsyncRead + AsyncWrite + Unpin,
    B: AsyncRead + AsyncWrite + Unpin,
{
    if local.write_all(setup).await.is_ok() {
        let _ = tokio::io::copy_bidirectional(&mut remote, &mut local).await;
    }
}

#[cfg(test)]
#[path = "x11_tests.rs"]
mod tests;
