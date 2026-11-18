//! Parts of the PuTTY import kept out of `session_transfer.rs`, which may not grow.
use super::{Preview, tunnel};
use crate::storage::{Profile, Proxy, Result};
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

/// The session values the import reads; the rest of a session (colors, fonts, …) is ignored.
pub(super) const FIELDS: [&str; 13] = [
    "Protocol",
    "HostName",
    "UserName",
    "PublicKeyFile",
    "DetachedCertificate",
    "PortNumber",
    "ProxyMethod",
    "ProxyHost",
    "ProxyPort",
    "ProxyUsername",
    "PortForwardings",
    "LocalPortAcceptAll",
    "RemotePortAcceptAll",
];

/// One saved session, whether it came from an exported `.reg` file or the registry itself (I.2).
/// `values` holds `FIELDS` as text, DWORDs in decimal, and is emptied for the next session.
pub(super) fn session(
    out: &mut Preview,
    name: Option<String>,
    values: &mut HashMap<String, String>,
) -> Result<()> {
    if let Some(name) = name.filter(|n| n != "Default Settings") {
        let get = |k: &str| values.get(k).map(String::as_str).unwrap_or("");
        if let Some((protocol, default_port, proxy)) = kind(out, get) {
            let port = if get("PortNumber").is_empty() {
                default_port
            } else {
                get("PortNumber").parse().unwrap_or(0)
            };
            let mut p = Profile::imported(&name, get("HostName"), get("UserName"), port);
            p.proxy = proxy;
            let key = get("PublicKeyFile");
            if protocol == "telnet" {
                telnet(&mut p);
            } else if !key.is_empty() && !key.to_ascii_lowercase().ends_with(".ppk") {
                p.auth = "key".into();
                p.key_path = key.into();
            } else if !key.is_empty() {
                out.warn("PuTTY PPK 키는 자동 변환하지 않습니다. PuTTYgen에서 OpenSSH 키로 내보낸 후 세션의 키 경로를 지정하세요.");
            }
            super::login::certificate(out, &mut p, get("DetachedCertificate"));
            let id = p.id.clone();
            // No group here: the preview offers to put a whole import under the program's name.
            out.add(p, "")?;
            if protocol == "ssh" && out.bundle.profiles.iter().any(|p| p.id == id) {
                forwards(out, &id, values);
            }
        }
    }
    values.clear();
    Ok(())
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
