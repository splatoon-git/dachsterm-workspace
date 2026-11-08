//! What a service check is pointed at: `host:port` or a URL, read into a validated host, a port and
//! the path a `HEAD` request asks for. Nothing a user typed reaches a request unencoded.
use super::targets;
use crate::storage::Result;
use serde::{Deserialize, Serialize};
use std::fmt::Write;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Format {
    Auto,
    Http,
    Https,
    Tls,
    Banner,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ServiceTarget {
    pub host: String,
    pub port: u16,
    pub path: String,
    pub format: Format,
}

impl ServiceTarget {
    /// The port is left out when it is the scheme's own, as a browser would send it.
    pub fn host_header(&self, secure: bool) -> String {
        let name = if self.host.contains(':') {
            format!("[{}]", self.host)
        } else {
            self.host.clone()
        };
        if self.port == if secure { 443 } else { 80 } {
            name
        } else {
            format!("{name}:{}", self.port)
        }
    }
}

fn scheme_format(scheme: &str) -> Result<Format> {
    match scheme.to_ascii_lowercase().as_str() {
        "http" => Ok(Format::Http),
        "https" => Ok(Format::Https),
        _ => Err(format!("주소는 http 또는 https만 쓸 수 있습니다: {scheme}")),
    }
}

fn split_authority(authority: &str) -> Result<(&str, Option<&str>)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let wrong = || format!("대상 형식이 잘못되었습니다: {authority}");
        let (host, after) = rest.split_once(']').ok_or_else(wrong)?;
        return match after {
            "" => Ok((host, None)),
            _ => after
                .strip_prefix(':')
                .map(|port| (host, Some(port)))
                .ok_or_else(wrong),
        };
    }
    Ok(match authority.matches(':').count() {
        1 => {
            let (host, port) = authority.split_once(':').unwrap();
            (host, Some(port))
        }
        // No colon is a bare name, and more than one is a bare IPv6 address.
        _ => (authority, None),
    })
}

fn default_port(format: Format) -> Option<u16> {
    match format {
        Format::Http => Some(80),
        Format::Https | Format::Tls => Some(443),
        Format::Auto | Format::Banner => None,
    }
}

/// Percent-encodes everything but visible ASCII, so a line break cannot start a new header.
fn request_path(tail: &str) -> String {
    let tail = tail.split('#').next().unwrap_or_default();
    let mut path = String::with_capacity(tail.len() + 1);
    if !tail.starts_with('/') {
        path.push('/');
    }
    for byte in tail.bytes() {
        if byte.is_ascii_graphic() {
            path.push(byte as char);
        } else {
            // Writing to a String cannot fail.
            let _ = write!(path, "%{byte:02X}");
        }
    }
    path
}

/// A URL's scheme picks the format only when the format is left on automatic.
pub fn parse(text: &str, format: Format) -> Result<ServiceTarget> {
    let text = text.trim();
    if text.is_empty() {
        return Err("대상을 입력하세요.".into());
    }
    let (scheme, rest) = match text.split_once("://") {
        Some((scheme, rest)) => (Some(scheme_format(scheme)?), rest),
        None => (None, text),
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    if authority.contains('@') {
        return Err("주소에 사용자 이름이나 암호를 넣을 수 없습니다.".into());
    }
    let (host, port) = split_authority(authority)?;
    let host = targets::single_host(host)?;
    let format = match (format, scheme) {
        (Format::Auto, Some(from_url)) => from_url,
        (chosen, _) => chosen,
    };
    let port = match port {
        Some(port) => targets::port(port)?,
        None => default_port(scheme.unwrap_or(format))
            .ok_or_else(|| format!("포트를 함께 입력하세요. 예: {host}:443"))?,
    };
    Ok(ServiceTarget {
        host,
        port,
        path: request_path(tail),
        format,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(text: &str, format: Format) -> ServiceTarget {
        parse(text, format).unwrap()
    }

    #[test]
    fn host_and_port_with_each_format() {
        let target = read("Db.Example:5432", Format::Auto);
        assert_eq!(target.host, "db.example");
        assert_eq!(target.port, 5432);
        assert_eq!(target.path, "/");
        assert_eq!(target.format, Format::Auto);
        assert_eq!(read("web.example", Format::Http).port, 80);
        assert_eq!(read("web.example", Format::Https).port, 443);
        assert_eq!(read("web.example", Format::Tls).port, 443);
    }

    #[test]
    fn a_port_is_needed_when_the_format_cannot_supply_one() {
        for format in [Format::Auto, Format::Banner] {
            assert!(parse("web.example", format).unwrap_err().contains("포트"));
        }
    }

    #[test]
    fn a_url_gives_the_format_only_on_automatic() {
        let target = read("https://web.example/a?b=1#frag", Format::Auto);
        assert_eq!(target.format, Format::Https);
        assert_eq!(target.port, 443);
        assert_eq!(target.path, "/a?b=1");
        assert_eq!(read("http://web.example:8080", Format::Auto).port, 8080);
        assert_eq!(read("http://web.example", Format::Tls).format, Format::Tls);
        assert_eq!(read("http://web.example", Format::Tls).port, 80);
        assert_eq!(read("HTTP://web.example?q", Format::Auto).path, "/?q");
    }

    #[test]
    fn ipv6_with_and_without_brackets() {
        assert_eq!(read("[::1]:8080", Format::Auto).host, "::1");
        assert_eq!(read("[::1]:8080", Format::Auto).port, 8080);
        assert_eq!(read("::1", Format::Https).host, "::1");
        assert_eq!(read("https://[2001:db8::1]/x", Format::Auto).path, "/x");
        assert!(parse("[::1", Format::Https).is_err());
        assert!(parse("[::1]x", Format::Https).is_err());
    }

    #[test]
    fn nothing_typed_can_reach_a_header_or_a_command_unencoded() {
        assert_eq!(
            read("http://web.example/a b\r\nX: 1", Format::Auto).path,
            "/a%20b%0D%0AX:%201"
        );
        assert_eq!(
            read("http://web.example/한", Format::Auto).path,
            "/%ED%95%9C"
        );
        for bad in [
            "-oProxyCommand=x:22",
            "a b:22",
            "a;id:22",
            "$(id):22",
            "a'b:22",
        ] {
            assert!(parse(bad, Format::Auto).is_err(), "{bad}");
        }
    }

    #[test]
    fn credentials_and_other_schemes_are_refused() {
        assert!(
            parse("https://user:secret@web.example/", Format::Auto)
                .unwrap_err()
                .contains("사용자 이름")
        );
        assert!(parse("ftp://web.example/", Format::Auto).is_err());
        assert!(parse("   ", Format::Auto).is_err());
        assert!(parse("web.example:0", Format::Auto).is_err());
        assert!(parse("web.example:70000", Format::Auto).is_err());
    }

    #[test]
    fn the_host_header_leaves_out_the_default_port() {
        let header = |text: &str, secure| read(text, Format::Auto).host_header(secure);
        assert_eq!(header("https://web.example", true), "web.example");
        assert_eq!(header("http://web.example", false), "web.example");
        assert_eq!(header("web.example:443", false), "web.example:443");
        assert_eq!(header("web.example:8443", true), "web.example:8443");
        assert_eq!(header("[::1]:8080", false), "[::1]:8080");
        assert_eq!(header("https://[::1]", true), "[::1]");
    }
}
