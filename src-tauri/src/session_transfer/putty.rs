//! Parts of the PuTTY import kept out of `session_transfer.rs`, which may not grow.
use super::{Preview, tunnel};
use crate::storage::{Profile, Proxy};
use std::collections::HashMap;

/// What a PuTTY session's `Protocol` becomes, and its port when none is saved. `None`: skipped.
pub(super) fn protocol(name: &str) -> Option<(&'static str, u16)> {
    match name {
        "ssh" => Some(("ssh", 22)),
        "telnet" => Some(("telnet", 23)),
        _ => None,
    }
}

/// The session's protocol, port when none is saved, and proxy. `None`: skipped, with a warning.
pub(super) fn kind<'a>(
    out: &mut Preview,
    get: impl Fn(&str) -> &'a str + Copy,
) -> Option<(&'static str, u16, Option<Proxy>)> {
    let Some((name, port)) = protocol(get("Protocol")) else {
        out.skipped += 1;
        out.warn("PuTTY의 SSH·Telnet 외 프로토콜 세션을 제외했습니다.");
        return None;
    };
    if name == "ssh" {
        return super::proxy::putty(out, get).map(|proxy| (name, port, proxy));
    }
    // A proxy carries SSH only (CG.1), and without it the session would go another way.
    if !matches!(get("ProxyMethod"), "" | "0") {
        out.skipped += 1;
        out.warn("프록시를 쓰는 PuTTY Telnet 세션은 제외했습니다.");
        return None;
    }
    Some((name, port, None))
}

/// A Telnet session keeps no key and no password: the login is typed in its terminal (CG.4).
pub(super) fn telnet(p: &mut Profile) {
    p.protocol = "telnet".into();
    p.auth = "interactive".into();
    p.key_path.clear();
}

/// An SSH session's `PortForwardings`, once the session itself was added.
pub(super) fn forwards(out: &mut Preview, id: &str, values: &HashMap<String, String>) {
    let get = |k: &str| values.get(k).map(String::as_str).unwrap_or("");
    if ["LocalPortAcceptAll", "RemotePortAcceptAll"]
        .iter()
        .any(|k| !matches!(get(k), "" | "0"))
    {
        out.warn("PuTTY 비루프백 수신 터널은 제외했습니다.");
        return;
    }
    for entry in get("PortForwardings").split(',').filter(|v| !v.is_empty()) {
        let (listen, target) = entry.split_once('=').unwrap_or((entry, ""));
        let parsed = match listen.as_bytes().first() {
            Some(b'L') => tunnel(id, "local", &listen[1..], Some(target)),
            Some(b'R') => tunnel(id, "remote", &listen[1..], Some(target)),
            Some(b'D') => tunnel(id, "dynamic", &listen[1..], None),
            _ => Err("지원하지 않는 PuTTY 터널".into()),
        };
        match parsed {
            Ok(c) => out.bundle.tunnels.push(c),
            Err(_) => out
                .warn("PuTTY 터널의 주소·이스케이프·IPv6 수신 형식을 변환하지 못해 제외했습니다."),
        }
    }
}
