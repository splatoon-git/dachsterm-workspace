//! The first TCP connection of a route (CG.1): straight to the server, or through the HTTP CONNECT
//! or SOCKS5 proxy of the profile that owns it. Everything after it — jump hosts, SFTP, tunnels,
//! monitoring — rides on the SSH connection made over this stream.
use super::{AuthReply, Sink, proxy_command};
use crate::storage::{Endpoint, MAX_PROXY_FIELD, Profile, Result};
use base64::Engine;
use std::time::Duration;
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::TcpStream,
    sync::mpsc,
    time::timeout,
};
use zeroize::Zeroizing;

pub(crate) trait Transport: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Transport for T {}

/// The response header of a CONNECT is small; anything longer is not a proxy we can talk to.
const MAX_HEADER: usize = 16 * 1024;
const AUTH_FAILED: &str = "프록시 인증에 실패했습니다. 사용자 이름과 암호를 확인하세요.";
const AUTH_REQUIRED: &str = "프록시가 인증을 요구합니다.";
const NOT_ALLOWED: &str = "프록시가 이 목적지를 허용하지 않습니다.";
const CLOSED: &str = "프록시가 응답 도중 연결을 닫았습니다.";

/// The stream an SSH handshake runs on, and a proxy command's standard error to explain a failure.
pub(crate) struct Opened {
    pub stream: Box<dyn Transport>,
    pub stderr: Option<proxy_command::Stderr>,
}

/// Opens the stream the SSH handshake of `p` runs on. `secret` is the saved proxy password; a
/// proxy with a user name and no saved password asks for one, for this connection only.
pub(crate) async fn open(
    p: &Profile,
    secret: Option<Zeroizing<String>>,
    sink: &Sink,
    replies: &mut mpsc::Receiver<AuthReply>,
) -> Result<Opened> {
    let limit = Duration::from_secs(p.timeout);
    let Some(proxy) = &p.proxy else {
        let stream = timeout(limit, TcpStream::connect((p.host.as_str(), p.port)))
            .await
            .map_err(|_| "접속 시간이 초과되었습니다.")?
            .map_err(|_| "서버에 연결할 수 없습니다.")?;
        return Ok(Opened {
            stream: Box::new(stream),
            stderr: None,
        });
    };
    let Some(proxy) = proxy.endpoint() else {
        let command = proxy_command::expand(proxy.command().unwrap_or(""), p);
        let (stream, stderr) = proxy_command::spawn(&command)?;
        return Ok(Opened {
            stream: Box::new(stream),
            stderr: Some(stderr),
        });
    };
    let password = match secret {
        _ if proxy.username.is_empty() => None,
        Some(saved) => Some(saved),
        None => Some(ask(&proxy, sink, replies).await?),
    };
    if password.as_ref().is_some_and(|p| p.len() > MAX_PROXY_FIELD) {
        return Err("프록시 암호는 255바이트 이하여야 합니다.".into());
    }
    let auth = password.as_ref().map(|pw| (proxy.username, pw.as_str()));
    // The profile's one timeout covers the proxy's TCP connection and its negotiation.
    timeout(limit, async {
        let mut stream = TcpStream::connect((proxy.host, proxy.port))
            .await
            .map_err(|_| {
                format!(
                    "프록시({}:{})에 연결할 수 없습니다.",
                    proxy.host, proxy.port
                )
            })?;
        if proxy.socks {
            socks5(&mut stream, &p.host, p.port, auth).await?;
        } else {
            http_connect(&mut stream, &p.host, p.port, auth).await?;
        }
        Ok::<_, String>(Opened {
            stream: Box::new(stream),
            stderr: None,
        })
    })
    .await
    .map_err(|_| "프록시를 거친 접속 시간이 초과되었습니다.".to_string())?
}

async fn ask(
    proxy: &Endpoint<'_>,
    sink: &Sink,
    replies: &mut mpsc::Receiver<AuthReply>,
) -> Result<Zeroizing<String>> {
    crate::ssh_auth::ask_one(
        sink,
        replies,
        "프록시 암호",
        "이번 연결에만 사용합니다. 저장하려면 세션을 편집하세요.",
        &format!("{}@{}:{} 암호", proxy.username, proxy.host, proxy.port),
    )
    .await
}

/// `host:port` as a request target; an IPv6 address goes in brackets.
fn authority(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// A status line safe to show: printable, and short.
fn shown(line: &[u8]) -> String {
    String::from_utf8_lossy(line)
        .chars()
        .filter(|c| !c.is_control())
        .take(120)
        .collect::<String>()
        .trim()
        .to_string()
}

pub(crate) async fn http_connect<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    host: &str,
    port: u16,
    auth: Option<(&str, &str)>,
) -> Result<()> {
    let target = authority(host, port);
    let mut request = Zeroizing::new(format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n"));
    if let Some((user, password)) = auth {
        let pair = Zeroizing::new(format!("{user}:{password}"));
        let token = Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(&*pair));
        request.push_str("Proxy-Authorization: Basic ");
        request.push_str(&token);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|_| CLOSED)?;
    // Read the header a byte at a time up to its blank line: what follows is the SSH banner.
    let mut head = Vec::new();
    while !(head.ends_with(b"\r\n\r\n") || head.ends_with(b"\n\n")) {
        if head.len() >= MAX_HEADER {
            return Err("프록시 응답 헤더가 너무 깁니다.".into());
        }
        head.push(stream.read_u8().await.map_err(|_| CLOSED)?);
    }
    let line = head.split(|b| *b == b'\n').next().unwrap_or_default();
    let line = shown(line);
    let mut parts = line.split_whitespace();
    let code = match (parts.next(), parts.next()) {
        (Some(version), Some(code)) if version.starts_with("HTTP/") => code.parse::<u16>().ok(),
        _ => None,
    }
    .ok_or("HTTP 프록시가 아닌 서버가 응답했습니다.")?;
    match code {
        200..=299 => Ok(()),
        // tinyproxy answers a wrong password with 401 rather than 407 (CG.0).
        401 | 407 if auth.is_some() => Err(AUTH_FAILED.into()),
        401 | 407 => Err(AUTH_REQUIRED.into()),
        403 => Err(NOT_ALLOWED.into()),
        500..=599 => Err(format!("프록시가 목적지에 연결하지 못했습니다({line}).")),
        _ => Err(format!("프록시가 연결을 거부했습니다({line}).")),
    }
}

pub(crate) async fn socks5<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    host: &str,
    port: u16,
    auth: Option<(&str, &str)>,
) -> Result<()> {
    let methods: &[u8] = if auth.is_some() {
        &[5, 2, 0, 2]
    } else {
        &[5, 1, 0]
    };
    stream.write_all(methods).await.map_err(|_| CLOSED)?;
    let mut chosen = [0u8; 2];
    stream.read_exact(&mut chosen).await.map_err(|_| CLOSED)?;
    if chosen[0] != 5 {
        return Err("SOCKS5 프록시가 아닌 서버가 응답했습니다.".into());
    }
    match (chosen[1], auth) {
        (0, _) => {}
        (2, Some((user, password))) => {
            let mut message = Zeroizing::new(vec![1, user.len() as u8]);
            message.extend_from_slice(user.as_bytes());
            message.push(password.len() as u8);
            message.extend_from_slice(password.as_bytes());
            stream.write_all(&message).await.map_err(|_| CLOSED)?;
            let mut status = [0u8; 2];
            stream.read_exact(&mut status).await.map_err(|_| CLOSED)?;
            if status[1] != 0 {
                return Err(AUTH_FAILED.into());
            }
        }
        (0xff, None) => return Err(AUTH_REQUIRED.into()),
        _ => return Err("프록시가 지원하지 않는 인증 방식을 요구합니다.".into()),
    }
    // A name goes to the proxy unresolved, so names only it can resolve work (CG.0: `target`).
    let mut request = vec![5, 1, 0];
    match host.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(ip)) => {
            request.push(1);
            request.extend_from_slice(&ip.octets());
        }
        Ok(std::net::IpAddr::V6(ip)) => {
            request.push(4);
            request.extend_from_slice(&ip.octets());
        }
        // `valid_host` keeps a name at 253 bytes.
        Err(_) => {
            request.extend_from_slice(&[3, host.len() as u8]);
            request.extend_from_slice(host.as_bytes());
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    stream.write_all(&request).await.map_err(|_| CLOSED)?;
    let mut reply = [0u8; 4];
    stream.read_exact(&mut reply).await.map_err(|_| CLOSED)?;
    match reply[1] {
        0 => {}
        2 => return Err(NOT_ALLOWED.into()),
        code => {
            return Err(format!(
                "프록시가 목적지에 연결하지 못했습니다(SOCKS 코드 {code})."
            ));
        }
    }
    // The bound address the reply carries is of no use, but it must be read off the stream.
    let rest = match reply[3] {
        1 => 4 + 2,
        4 => 16 + 2,
        3 => stream.read_u8().await.map_err(|_| CLOSED)? as usize + 2,
        _ => return Err("SOCKS5 응답 형식이 올바르지 않습니다.".into()),
    };
    let mut bound = vec![0u8; rest];
    stream.read_exact(&mut bound).await.map_err(|_| CLOSED)?;
    Ok(())
}

#[cfg(test)]
#[path = "first_hop_tests.rs"]
mod tests;
