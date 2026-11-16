//! Proxies in other tools' session settings. OpenSSH's `nc -X` forms and PuTTY's SOCKS5 and HTTP
//! methods become proxies without running anything (CG.1); any other `ProxyCommand` becomes a
//! command proxy that the preview asks the user to approve (CG.2, `approval.rs`). A proxy
//! password is never read.
use super::{Preview, endpoint};
use crate::storage::Proxy;
use std::collections::HashMap;

const NOT_NC: &str =
    "ProxyCommand·HostKeyAlias·KnownHostsCommand·호스트 정규화 조건 세션을 제외했습니다.";
const SOCKS4: &str = "SOCKS4 프록시는 지원하지 않아 해당 세션을 제외했습니다.";

fn proxy(socks: bool, host: String, port: u16, username: String) -> Proxy {
    let secret_ref = None;
    if socks {
        Proxy::Socks5 {
            host,
            port,
            username,
            secret_ref,
        }
    } else {
        Proxy::Http {
            host,
            port,
            username,
            secret_ref,
        }
    }
}

/// The proxy an OpenSSH host's settings (each key's first value, as words) stand for:
/// `Some(None)` when there is none, `None` when the session is left out because it needs a
/// command or a lookup the import does not do (the reason is already in `out`). OpenSSH uses
/// `ProxyJump` over `ProxyCommand`, so a session with both keeps its jump hosts.
pub(super) fn openssh(
    out: &mut Preview,
    values: &HashMap<&str, &[String]>,
) -> Option<Option<Proxy>> {
    let get = |key: &str| values.get(key).map_or("", |v| v[0].as_str());
    if ["hostkeyalias", "knownhostscommand"]
        .iter()
        .any(|k| !matches!(get(k), "" | "none"))
        || !matches!(get("canonicalizehostname"), "" | "no" | "false")
    {
        out.skipped += 1;
        out.warn(NOT_NC);
        return None;
    }
    let command = get("proxycommand");
    if matches!(command, "" | "none") {
        return Some(None);
    }
    if !matches!(get("proxyjump"), "" | "none") {
        out.warn("ProxyJump와 ProxyCommand가 함께 있는 세션은 OpenSSH처럼 ProxyJump만 씁니다.");
        return Some(None);
    }
    let reason = match netcat(&super::words(command).unwrap_or_default()) {
        Ok(proxy) => return Some(Some(proxy)),
        Err(SOCKS4) => SOCKS4,
        // Anything else runs as written once the user approves it on the preview.
        Err(_) if crate::storage::check_command(command).is_ok() => {
            return Some(Some(Proxy::Command {
                command: command.into(),
            }));
        }
        Err(_) => "%h·%p·%r·%n·%% 외의 토큰을 쓰거나 너무 긴 ProxyCommand 세션을 제외했습니다.",
    };
    out.skipped += 1;
    out.warn(reason);
    None
}

/// Lowercases a directive's keyword. `ProxyCommand` keeps the rest of its line as one value,
/// as written: OpenSSH hands it to the shell unsplit, and the preview shows exactly that.
pub(super) fn keyword(w: &mut Vec<String>, line: &str) {
    w[0] = w[0].to_ascii_lowercase();
    if w[0] != "proxycommand" || w.len() < 2 {
        return;
    }
    let line = line.trim();
    let after = &line[line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len())..];
    let after = after.trim_start();
    let value = after.strip_prefix('=').unwrap_or(after).trim();
    w.truncate(1);
    w.push(value.into());
}
/// `nc [-X 5|connect] -x host[:port] [-P user] %h %p`: the netcat that ships with macOS and
/// OpenBSD. Without `-X` it speaks SOCKS5.
fn netcat(words: &[String]) -> Result<Proxy, &'static str> {
    let (program, args) = words.split_first().ok_or(NOT_NC)?;
    if program.rsplit(['/', '\\']).next() != Some("nc") {
        return Err(NOT_NC);
    }
    let (mut kind, mut address, mut user, mut rest) = (None, None, String::new(), vec![]);
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        let (flag, inline) = match arg.strip_prefix('-') {
            Some(f) if !f.is_empty() && !arg.starts_with("--") => f.split_at(1),
            _ => {
                rest.push(arg.as_str());
                continue;
            }
        };
        let value = if inline.is_empty() {
            args.next().map(String::as_str).ok_or(NOT_NC)?
        } else {
            inline
        };
        match flag {
            "X" => kind = Some(value),
            "x" => address = Some(value),
            "P" => user = value.to_string(),
            _ => return Err(NOT_NC),
        }
    }
    if rest != ["%h", "%p"] {
        return Err(NOT_NC);
    }
    let socks = match kind.unwrap_or("5") {
        "5" => true,
        k if k.eq_ignore_ascii_case("connect") => false,
        "4" => return Err(SOCKS4),
        _ => return Err(NOT_NC),
    };
    let address = address.ok_or(NOT_NC)?;
    let (host, port) = endpoint(address)
        .or_else(|| (!address.contains(':')).then(|| (address.into(), default_port(socks))))
        .ok_or(NOT_NC)?;
    Ok(proxy(socks, host, port, user))
}

/// nc's ports when `-x` names none.
fn default_port(socks: bool) -> u16 {
    if socks { 1080 } else { 3128 }
}

/// PuTTY's `ProxyMethod`: 0 none, 1 SOCKS4, 2 SOCKS5, 3 HTTP, 4 Telnet, 5 a local command, 6 SSH.
/// Same return as `openssh`. `ProxyPassword` is not among the values the reader keeps.
pub(super) fn putty<'a>(out: &mut Preview, get: impl Fn(&str) -> &'a str) -> Option<Option<Proxy>> {
    let socks = match get("ProxyMethod") {
        "" | "0" => return Some(None),
        "2" => true,
        "3" => false,
        _ => {
            out.skipped += 1;
            out.warn("PuTTY의 SOCKS4·Telnet·로컬 명령·SSH 프록시 세션은 제외했습니다.");
            return None;
        }
    };
    let port = get("ProxyPort").parse().unwrap_or(0);
    Some(Some(proxy(
        socks,
        get("ProxyHost").into(),
        port,
        get("ProxyUsername").into(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn words(text: &str) -> Vec<String> {
        text.split_whitespace().map(String::from).collect()
    }
    fn nc(text: &str) -> Result<Proxy, &'static str> {
        netcat(&words(text))
    }
    #[test]
    fn proxycommand_keeps_its_line_as_written() {
        let mut w =
            crate::session_transfer::words("ProxyCommand ssh -W '%h:%p' \"jump host\"").unwrap();
        keyword(&mut w, "  ProxyCommand ssh -W '%h:%p' \"jump host\"  ");
        assert_eq!(w, ["proxycommand", "ssh -W '%h:%p' \"jump host\""]);
        let mut w = crate::session_transfer::words("proxycommand=nc %h %p").unwrap();
        keyword(&mut w, "proxycommand=nc %h %p");
        assert_eq!(w, ["proxycommand", "nc %h %p"]);
        let mut w = crate::session_transfer::words("ProxyCommand = nc %h %p").unwrap();
        keyword(&mut w, "ProxyCommand = nc %h %p");
        assert_eq!(w[1], "nc %h %p");
        let mut w = crate::session_transfer::words("User Alice").unwrap();
        keyword(&mut w, "User Alice");
        assert_eq!(w, ["user", "Alice"]);
    }
    #[test]
    fn netcat_forms_become_proxies() {
        assert_eq!(
            nc("nc -X 5 -x proxy:1080 %h %p").unwrap(),
            proxy(true, "proxy".into(), 1080, String::new())
        );
        assert_eq!(
            nc("/usr/bin/nc -X connect -x 10.0.0.1:3128 -P alice %h %p").unwrap(),
            proxy(false, "10.0.0.1".into(), 3128, "alice".into())
        );
        assert_eq!(
            nc("nc -Xconnect -xproxy %h %p").unwrap(),
            proxy(false, "proxy".into(), 3128, String::new())
        );
        assert_eq!(
            nc("nc -x [::1]:1081 %h %p").unwrap(),
            proxy(true, "::1".into(), 1081, String::new())
        );
        assert_eq!(nc("nc -X 4 -x proxy:1080 %h %p").unwrap_err(), SOCKS4);
        for other in [
            "ncat --proxy proxy:1080 %h %p",
            "nc -X 5 -x proxy:1080 -w 3 %h %p",
            "nc -X 5 -x proxy:1080 %h 22",
            "nc proxy 1080",
            "nc -X 5 %h %p",
            "nc -X 5 -x proxy:1080 %h %p; reboot",
            "ssh -W %h:%p jump",
            "nc -X 5 -x",
        ] {
            assert_eq!(nc(other).unwrap_err(), NOT_NC, "{other}");
        }
    }
    #[test]
    fn openssh_and_putty_report_what_they_leave_out() {
        let mut out = Preview::new();
        let host = |pairs: &[(&'static str, &'static str)]| {
            let pairs: Vec<_> = pairs
                .iter()
                .map(|(k, v)| (*k, vec![v.to_string()]))
                .collect();
            let mut out = Preview::new();
            let map: HashMap<&str, &[String]> =
                pairs.iter().map(|(k, v)| (*k, v.as_slice())).collect();
            (openssh(&mut out, &map), out)
        };
        assert_eq!(host(&[("proxycommand", "none")]).0, Some(None));
        assert_eq!(host(&[]).0, Some(None));
        let (found, report) = host(&[("proxycommand", "nc -X 5 -x p:1 %h %p")]);
        assert!(found.unwrap().is_some());
        assert!(report.warnings.is_empty() && report.skipped == 0);
        let (found, report) = host(&[
            ("proxycommand", "nc -X 5 -x p:1 %h %p"),
            ("proxyjump", "jump"),
        ]);
        assert_eq!(found, Some(None));
        assert!(report.warnings[0].contains("ProxyJump만"));
        let (found, report) = host(&[("proxycommand", "socat - %h:%p")]);
        assert_eq!(
            found,
            Some(Some(Proxy::Command {
                command: "socat - %h:%p".into()
            }))
        );
        assert!(report.warnings.is_empty());
        for left_out in [
            [("proxycommand", "nc -X 4 -x p:1 %h %p")],
            [("proxycommand", "corkscrew proxy 8080 %h %p %d")],
            [("hostkeyalias", "other")],
            [("canonicalizehostname", "yes")],
        ] {
            let (found, report) = host(&left_out);
            assert_eq!((found, report.skipped), (None, 1));
        }
        let values = |method: &'static str| {
            move |k: &str| match k {
                "ProxyMethod" => method,
                "ProxyHost" => "proxy.lan",
                "ProxyPort" => "8080",
                "ProxyUsername" => "bob",
                _ => "",
            }
        };
        assert_eq!(putty(&mut out, values("0")), Some(None));
        assert_eq!(
            putty(&mut out, values("3")),
            Some(Some(proxy(false, "proxy.lan".into(), 8080, "bob".into())))
        );
        assert_eq!(
            putty(&mut out, values("2")),
            Some(Some(proxy(true, "proxy.lan".into(), 8080, "bob".into())))
        );
        for unsupported in ["1", "4", "5", "6"] {
            assert_eq!(putty(&mut out, values(unsupported)), None);
        }
        assert_eq!(out.skipped, 4);
    }
}
