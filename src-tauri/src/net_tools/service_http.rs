//! The plain-bytes parts of a service check: the one request it may send, and reading what comes
//! back. Everything a server sends stops at 4 KiB, loses its control characters and is never
//! interpreted beyond the status line and two headers.
use crate::agent_filter::plain_up_to;
use serde::Serialize;
use std::time::Duration;
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    time::{Instant, timeout, timeout_at},
};

pub const MAX_RESPONSE: usize = 4096;
/// A multi-line greeting arrives within moments of its first line.
const BANNER_SETTLE: Duration = Duration::from_millis(300);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpReply {
    pub version: String,
    pub status: u16,
    pub reason: String,
    pub server: Option<String>,
    pub location: Option<String>,
}

/// `HEAD` only, so no body is ever read, and nothing that identifies the user.
pub fn head_request(path: &str, host: &str) -> String {
    format!(
        "HEAD {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: DachsTerm\r\nAccept: */*\r\nConnection: close\r\n\r\n"
    )
}

fn field(bytes: &[u8]) -> String {
    plain_up_to(bytes, MAX_RESPONSE).trim().to_string()
}

fn header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|part| part == b"\r\n\r\n")
}

pub fn parse_reply(bytes: &[u8]) -> Option<HttpReply> {
    let head = &bytes[..header_end(bytes).unwrap_or(bytes.len())];
    let mut lines = head
        .split(|byte| *byte == b'\n')
        .map(|line| line.strip_suffix(b"\r").unwrap_or(line));
    let status = field(lines.next()?);
    let mut parts = status.splitn(3, ' ');
    let version = parts.next()?.strip_prefix("HTTP/")?.to_string();
    let code = parts.next()?;
    if code.len() != 3 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let mut reply = HttpReply {
        version,
        status: code.parse().ok()?,
        reason: parts.next().unwrap_or_default().to_string(),
        server: None,
        location: None,
    };
    for line in lines {
        let Some(colon) = line.iter().position(|byte| *byte == b':') else {
            continue;
        };
        let (name, value) = (&line[..colon], &line[colon + 1..]);
        if name.eq_ignore_ascii_case(b"server") {
            reply.server = Some(field(value));
        } else if name.eq_ignore_ascii_case(b"location") {
            reply.location = Some(field(value));
        }
    }
    Some(reply)
}

/// What a server sent, a line at a time and safe to show. Empty when it was only line breaks.
pub fn text_lines(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|byte| *byte == b'\n')
        .map(field)
        .filter(|line| !line.is_empty())
        .collect()
}

/// Up to the end of the headers, 4 KiB, the server closing, or the time limit, whichever is first.
pub async fn read_head<S: AsyncRead + Unpin>(stream: &mut S, wait: Duration) -> Vec<u8> {
    let deadline = Instant::now() + wait;
    let mut received = Vec::new();
    let mut buffer = [0; MAX_RESPONSE];
    while received.len() < MAX_RESPONSE && header_end(&received).is_none() {
        let room = MAX_RESPONSE - received.len();
        match timeout_at(deadline, stream.read(&mut buffer[..room])).await {
            Ok(Ok(count)) if count > 0 => received.extend_from_slice(&buffer[..count]),
            _ => break,
        }
    }
    received
}

/// Whatever the server says without being asked. Empty when it says nothing within `wait`.
pub async fn read_banner<S: AsyncRead + Unpin>(stream: &mut S, wait: Duration) -> Vec<u8> {
    let mut buffer = [0; MAX_RESPONSE];
    let mut received = match timeout(wait, stream.read(&mut buffer)).await {
        Ok(Ok(count)) if count > 0 => buffer[..count].to_vec(),
        _ => return Vec::new(),
    };
    while received.len() < MAX_RESPONSE {
        let room = MAX_RESPONSE - received.len();
        match timeout(BANNER_SETTLE, stream.read(&mut buffer[..room])).await {
            Ok(Ok(count)) if count > 0 => received.extend_from_slice(&buffer[..count]),
            _ => break,
        }
    }
    received
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[test]
    fn the_request_is_head_and_says_nothing_about_the_user() {
        assert_eq!(
            head_request("/x", "web.example:8080"),
            "HEAD /x HTTP/1.1\r\nHost: web.example:8080\r\nUser-Agent: DachsTerm\r\nAccept: */*\r\nConnection: close\r\n\r\n"
        );
    }

    #[test]
    fn reads_the_status_and_the_two_headers_it_shows() {
        let reply = parse_reply(
            b"HTTP/1.1 301 Moved Permanently\r\nSERVER: nginx\r\nlocation:  https://x/ \r\nSet-Cookie: a=b\r\n\r\nbody",
        )
        .unwrap();
        assert_eq!(reply.version, "1.1");
        assert_eq!(reply.status, 301);
        assert_eq!(reply.reason, "Moved Permanently");
        assert_eq!(reply.server.as_deref(), Some("nginx"));
        assert_eq!(reply.location.as_deref(), Some("https://x/"));
    }

    #[test]
    fn a_status_line_without_a_reason_is_still_a_reply() {
        let reply = parse_reply(b"HTTP/2 204\r\n\r\n").unwrap();
        assert_eq!((reply.status, reply.reason.as_str()), (204, ""));
    }

    #[test]
    fn what_is_not_http_is_not_read_as_http() {
        for bytes in [
            &b"220 mail ready\r\n"[..],
            b"HTTP/1.1 abc\r\n\r\n",
            b"HTTP/1.1 20\r\n\r\n",
            b"",
        ] {
            assert_eq!(parse_reply(bytes), None, "{bytes:?}");
        }
    }

    #[test]
    fn headers_after_the_blank_line_do_not_count() {
        let reply = parse_reply(b"HTTP/1.1 200 OK\r\n\r\nServer: body\r\n").unwrap();
        assert_eq!(reply.server, None);
    }

    #[test]
    fn control_characters_never_reach_the_screen() {
        let reply = parse_reply(
            b"HTTP/1.1 200 \x1b[31mOK\r\nServer: a\x1b]0;title\x07b\xe2\x80\xae\r\n\r\n",
        )
        .unwrap();
        assert_eq!(reply.reason, "[31mOK");
        assert_eq!(reply.server.as_deref(), Some("a]0;titleb"));
        assert_eq!(
            text_lines(b"220 ok\x00\r\n\r\n\x1b[2J\r\n  next\t\r\n"),
            ["220 ok", "[2J", "next"]
        );
    }

    #[tokio::test]
    async fn reading_headers_stops_at_the_limit_and_at_the_blank_line() {
        let (mut near, mut far) = tokio::io::duplex(64 * 1024);
        far.write_all(&vec![b'a'; MAX_RESPONSE * 2]).await.unwrap();
        assert_eq!(
            read_head(&mut near, Duration::from_secs(2)).await.len(),
            MAX_RESPONSE
        );
        let (mut near, mut far) = tokio::io::duplex(1024);
        far.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await.unwrap();
        // The other end stays open, so only the blank line can end this before the limit.
        let started = Instant::now();
        let head = read_head(&mut near, Duration::from_secs(30)).await;
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(parse_reply(&head).is_some());
    }

    #[tokio::test]
    async fn a_silent_server_gives_no_banner() {
        let (mut near, _far) = tokio::io::duplex(64);
        assert!(
            read_banner(&mut near, Duration::from_millis(50))
                .await
                .is_empty()
        );
    }

    #[tokio::test]
    async fn a_greeting_is_gathered_when_it_comes_in_pieces() {
        let (mut near, mut far) = tokio::io::duplex(1024);
        far.write_all(b"220-first\r\n").await.unwrap();
        let writer = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            far.write_all(b"220 last\r\n").await.unwrap();
            far
        });
        let banner = read_banner(&mut near, Duration::from_secs(2)).await;
        drop(writer.await);
        assert_eq!(text_lines(&banner), ["220-first", "220 last"]);
    }
}
