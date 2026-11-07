//! File adapters are inert parsers: no registry writes, includes, commands, or connections.
use crate::{
    AppState,
    settings::Bundle,
    storage::{Group, Profile, Result},
};
use serde::Serialize;
use std::collections::HashMap;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    bundle: Bundle,
    warnings: Vec<String>,
    skipped: usize,
    include_plan: Option<crate::config_includes::Plan>,
}
impl Preview {
    fn new() -> Self {
        Self {
            bundle: Bundle {
                format: Some("dachsterm.sessions".into()),
                version: 3,
                profiles: vec![],
                groups: vec![],
                tunnels: vec![],
                templates: vec![],
            },
            warnings: vec![],
            skipped: 0,
            include_plan: None,
        }
    }
    fn warn(&mut self, message: &str) {
        if !self.warnings.iter().any(|w| w == message) {
            self.warnings.push(message.into());
        }
    }
    fn add(&mut self, mut p: Profile, group: &str) -> Result<()> {
        if self.bundle.profiles.len() >= 500 {
            return Err("한 번에 500개까지 가져올 수 있습니다.".into());
        }
        // Missing usernames remain editable in preview, never invent a privileged account.
        let mut check = p.clone();
        if check.username.is_empty() {
            check.username = "preview".into();
        }
        if check.validate().is_err() {
            self.skipped += 1;
            self.warn("유효하지 않은 호스트·포트·세션 설정을 제외했습니다.");
            return Ok(());
        }
        let mut parent = None;
        for part in group.split(" / ").filter(|v| !v.is_empty()) {
            if part.len() > 100 {
                return Err("그룹 이름 길이 초과".into());
            }
            let id = if let Some(g) = self
                .bundle
                .groups
                .iter()
                .find(|g| g.name == part && g.parent_id == parent)
            {
                g.id.clone()
            } else {
                if self.bundle.groups.len() >= 100 {
                    return Err("그룹은 100개까지 가져올 수 있습니다.".into());
                }
                let id = uuid::Uuid::new_v4().to_string();
                self.bundle.groups.push(Group {
                    id: id.clone(),
                    name: part.into(),
                    parent_id: parent.clone(),
                    sort_order: 0,
                });
                id
            };
            parent = Some(id);
        }
        p.group_id = parent;
        if p.username.is_empty() {
            self.warn("사용자명이 없는 세션은 미리보기에서 계정을 입력해야 합니다.");
        }
        self.bundle.profiles.push(p);
        Ok(())
    }
}
fn profile(name: &str, host: &str, username: &str, port: u16) -> Profile {
    Profile {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.into(),
        host: host.into(),
        port,
        username: username.into(),
        auth: "password".into(),
        protocol: "ssh".into(),
        tls_ca_path: String::new(),
        encoding: "utf-8".into(),
        key_path: String::new(),
        jump_ids: vec![],
        tags: vec![],
        sort_order: 0,
        group_id: None,
        favorite: false,
        timeout: 15,
        keepalive: 15,
        last_connected: None,
        has_secret: false,
    }
}
pub(crate) fn decode(data: &[u8], encoding: &str) -> Result<String> {
    let (codec, skip) = if data.starts_with(&[0xff, 0xfe]) {
        (encoding_rs::UTF_16LE, 2)
    } else if data.starts_with(&[0xfe, 0xff]) {
        (encoding_rs::UTF_16BE, 2)
    } else {
        (
            match encoding {
                "utf-8" => encoding_rs::UTF_8,
                "windows-1252" => encoding_rs::WINDOWS_1252,
                "cp949" => encoding_rs::EUC_KR,
                _ => return Err("지원하지 않는 파일 인코딩입니다.".into()),
            },
            if data.starts_with(&[0xef, 0xbb, 0xbf]) {
                3
            } else {
                0
            },
        )
    };
    let (text, errors) = codec.decode_without_bom_handling(&data[skip..]);
    if errors || text.contains('\0') {
        return Err(
            "파일 인코딩이 맞지 않습니다. UTF-8·한국어 CP949·서유럽 인코딩을 확인하세요.".into(),
        );
    }
    Ok(text.into_owned())
}

pub(crate) fn parse(data: &[u8], format: &str, encoding: &str) -> Result<Preview> {
    if data.len() > crate::maintenance::MAX_CONFIG_BYTES {
        return Err("설정 파일은 2MiB 이하여야 합니다.".into());
    }
    let text = zeroize::Zeroizing::new(decode(data, encoding)?);
    if text.lines().count() > 20000 {
        return Err("설정 파일은 20,000줄 이하여야 합니다.".into());
    }
    let format = if format == "auto" {
        if text.trim_start().starts_with('{') {
            "dachsterm"
        } else if text.starts_with("Windows Registry Editor Version 5.00")
            || text.starts_with("REGEDIT4")
        {
            "putty"
        } else if text.lines().any(|l| l.trim().starts_with("[Bookmarks")) {
            "mobaxterm"
        } else if text.lines().any(|l| {
            l.trim()
                .get(..4)
                .is_some_and(|s| s.eq_ignore_ascii_case("host"))
                && l.trim()
                    .chars()
                    .nth(4)
                    .is_some_and(|c| c.is_whitespace() || c == '=')
        }) {
            "openssh"
        } else {
            return Err("형식을 찾지 못했습니다. 가져올 프로그램을 직접 선택하세요.".into());
        }
    } else {
        format
    };
    let mut result = match format {
        "dachsterm" => {
            let bundle: Bundle =
                serde_json::from_str(&text).map_err(|_| "DachsTerm JSON 스키마 오류")?;
            crate::settings::validate_bundle(&bundle)?;
            Preview {
                bundle,
                warnings: vec![],
                skipped: 0,
                include_plan: None,
            }
        }
        "putty" => putty(&text)?,
        "mobaxterm" => moba(&text)?,
        "openssh" => openssh(&text)?,
        _ => return Err("지원하지 않는 가져오기 형식입니다.".into()),
    };
    for p in &mut result.bundle.profiles {
        p.last_connected = None;
        p.has_secret = false;
    }
    for c in &mut result.bundle.tunnels {
        c.auto_start = false;
    }
    if format != "dachsterm" {
        result.warn("외부 형식의 지원 범위는 아래 보고서를 확인하세요. 자동 명령·호스트키 신뢰·암호·개인키 내용은 이전하지 않습니다. 터널 자동 시작은 꺼집니다. 적용 전 접속 대상을 확인하세요.");
    }
    Ok(result)
}

#[tauri::command]
pub async fn config_preview(format: String, encoding: String) -> Result<Option<Preview>> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("가져올 세션 설정 선택")
        .add_filter("세션 설정", &["json", "reg", "mxtsessions", "ini", "conf"])
        .add_filter("모든 파일 (OpenSSH config)", &["*"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let data = zeroize::Zeroizing::new(crate::maintenance::read_config(file.path())?);
    if matches!(format.as_str(), "auto" | "openssh") {
        let text = zeroize::Zeroizing::new(decode(&data, &encoding)?);
        if text.lines().any(|l| {
            words(l)
                .ok()
                .and_then(|w| w.first().cloned())
                .is_some_and(|w| w.eq_ignore_ascii_case("include"))
        }) {
            let mut preview = Preview::new();
            preview.include_plan = Some(crate::config_includes::plan(file.path(), &encoding)?);
            preview.warn("Include 파일 내용을 읽기 전에 목록에서 허용할 파일을 선택하세요. 선택한 파일의 폴더를 루트로 사용하며 상대 경로만 지원합니다. 파일·명령은 실행하지 않습니다.");
            return Ok(Some(preview));
        }
    }
    parse(&data, &format, &encoding).map(Some)
}
#[tauri::command]
pub fn config_apply(
    state: State<AppState>,
    data: String,
    merges: Option<Vec<crate::settings::Merge>>,
) -> Result<usize> {
    if data.len() > crate::maintenance::MAX_CONFIG_BYTES {
        return Err("설정 파일은 2MiB 이하여야 합니다.".into());
    }
    let bundle: Bundle = serde_json::from_str(&data).map_err(|_| "DachsTerm JSON 스키마 오류")?;
    crate::settings::validate_bundle(&bundle)?;
    let _guard = state.mutation.lock().unwrap();
    crate::maintenance::snapshot(&state.store, &state.directory)?;
    let mut bundle = bundle;
    crate::settings::apply_bundle(&state.store, &mut bundle, &merges.unwrap_or_default())
}

// Registry strings only recognize the escapes emitted by regedit; never execute a .reg file.
fn reg_string(value: &str) -> Option<String> {
    let inner = value.strip_prefix('"')?.strip_suffix('"')?;
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            let c = chars.next()?;
            if c != '\\' && c != '"' {
                return None;
            }
            out.push(c);
        } else {
            out.push(c);
        }
    }
    Some(out)
}
fn unescape_session(value: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let source = value.as_bytes();
    let mut i = 0;
    while i < source.len() {
        if source[i] == b'%' {
            let hex = source.get(i + 1..i + 3)?;
            bytes.push(u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?);
            i += 3;
        } else {
            bytes.push(source[i]);
            i += 1;
        }
    }
    String::from_utf8(bytes).ok()
}
fn putty(text: &str) -> Result<Preview> {
    let mut result = Preview::new();
    let mut name: Option<String> = None;
    let mut values = HashMap::<String, String>::new();
    fn flush(
        out: &mut Preview,
        name: Option<String>,
        values: &mut HashMap<String, String>,
    ) -> Result<()> {
        if let Some(name) = name {
            let get = |k: &str| values.get(k).map(String::as_str).unwrap_or("");
            if name == "Default Settings" {
                values.clear();
                return Ok(());
            }
            if get("Protocol") != "ssh" || !matches!(get("ProxyMethod"), "" | "0") {
                out.skipped += 1;
                out.warn("PuTTY의 SSH 외 프로토콜 또는 프록시 세션을 제외했습니다.");
            } else {
                let port = if get("PortNumber").is_empty() {
                    22
                } else {
                    get("PortNumber").parse().unwrap_or(0)
                };
                let mut p = profile(&name, get("HostName"), get("UserName"), port);
                let key = get("PublicKeyFile");
                if !key.is_empty() && !key.to_ascii_lowercase().ends_with(".ppk") {
                    p.auth = "key".into();
                    p.key_path = key.into();
                } else if !key.is_empty() {
                    out.warn("PuTTY PPK 키는 자동 변환하지 않습니다. PuTTYgen에서 OpenSSH 키로 내보낸 후 세션의 키 경로를 지정하세요.");
                }
                let id = p.id.clone();
                out.add(p, "PuTTY")?;
                if out.bundle.profiles.iter().any(|p| p.id == id) {
                    if ["LocalPortAcceptAll", "RemotePortAcceptAll"]
                        .iter()
                        .any(|k| !matches!(get(k), "" | "0"))
                    {
                        out.warn("PuTTY 비루프백 수신 터널은 제외했습니다.");
                    } else {
                        for entry in get("PortForwardings").split(',').filter(|v| !v.is_empty()) {
                            let (listen, target) = entry.split_once('=').unwrap_or((entry, ""));
                            let parsed = match listen.as_bytes().first() {
                                Some(b'L') => tunnel(&id, "local", &listen[1..], Some(target)),
                                Some(b'R') => tunnel(&id, "remote", &listen[1..], Some(target)),
                                Some(b'D') => tunnel(&id, "dynamic", &listen[1..], None),
                                _ => Err("지원하지 않는 PuTTY 터널".into()),
                            };
                            match parsed {Ok(c)=>out.bundle.tunnels.push(c),Err(_)=>out.warn("PuTTY 터널의 주소·이스케이프·IPv6 수신 형식을 변환하지 못해 제외했습니다.")}
                        }
                    }
                }
            }
        }
        values.clear();
        Ok(())
    }
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            flush(&mut result, name.take(), &mut values)?;
            name = line
                .strip_prefix("[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\")
                .and_then(|s| s.strip_suffix(']'))
                .and_then(unescape_session);
        } else if name.is_some()
            && let Some((key, value)) = line.split_once('=')
        {
            let Some(key) = reg_string(key.trim()) else {
                continue;
            };
            if ![
                "Protocol",
                "HostName",
                "UserName",
                "PublicKeyFile",
                "PortNumber",
                "ProxyMethod",
                "PortForwardings",
                "LocalPortAcceptAll",
                "RemotePortAcceptAll",
            ]
            .contains(&key.as_str())
            {
                continue;
            }
            let value = value.trim();
            let parsed = if let Some(v) = value.strip_prefix("dword:") {
                u32::from_str_radix(v, 16).ok().map(|n| n.to_string())
            } else {
                reg_string(value)
            };
            values.insert(key, parsed.ok_or("PuTTY 필드 형식 오류")?);
        }
    }
    flush(&mut result, name, &mut values)?;
    result.warn("PuTTY reg: 기본 접속·OpenSSH 키 경로·루프백 L/R/D 터널을 변환합니다. PPK·프록시·명령·신뢰·암호는 이전하지 않습니다. reg에는 제품 버전이 없어 버전별 실제 내보내기 검증이 별도로 필요합니다.");
    Ok(result)
}

fn moba(text: &str) -> Result<Preview> {
    let mut result = Preview::new();
    let mut active = false;
    let mut folder = String::new();
    let mut entries = vec![];
    fn flush(out: &mut Preview, folder: &str, entries: &mut Vec<(String, String)>) -> Result<()> {
        for (name, value) in entries.drain(..) {
            // #icon#type%host%port%user... : only the documented-by-export common prefix.
            let Some(settings) = value.split('#').nth(2) else {
                out.skipped += 1;
                continue;
            };
            let fields: Vec<_> = settings.split('%').collect();
            if fields.len() < 4 || fields[0] != "0" {
                out.skipped += 1;
                continue;
            }
            let port = fields[2].parse().unwrap_or(0);
            let get = |i: usize| fields.get(i).copied().unwrap_or("");
            if !matches!(get(19), "" | "0")
                || !get(35).is_empty()
                || !get(36).is_empty()
                || get(27) == "2"
            {
                out.skipped += 1;
                out.warn("프록시·인증서·SSHv1 조건 세션은 제외했습니다.");
                continue;
            }
            let user = if matches!(fields[3], "<default>" | "<username>") {
                ""
            } else {
                fields[3]
            };
            let mut p = profile(&name, fields[1], user, port);
            fn key(p: &mut Profile, value: &str, out: &mut Preview) {
                if value.is_empty() {
                    return;
                }
                if value.contains("_CurrentDrive_")
                    || value.to_ascii_lowercase().ends_with(".ppk")
                    || value.contains("__")
                {
                    out.warn("PPK·드라이브 치환 키 경로는 적용 전에 다시 지정하세요.");
                } else {
                    p.auth = "key".into();
                    p.key_path = value.into();
                }
            }
            key(&mut p, get(14), out);
            if !get(8).is_empty() {
                let hosts: Vec<_> = get(8).split("__PIPE__").collect();
                let ports: Vec<_> = get(9).split("__PIPE__").collect();
                let users: Vec<_> = get(10).split("__PIPE__").collect();
                let keys: Vec<_> = get(15).split("__PIPE__").collect();
                if hosts.len() > 4
                    || hosts.len() != ports.len()
                    || hosts.len() != users.len()
                    || (!get(15).is_empty() && keys.len() != hosts.len())
                {
                    out.skipped += 1;
                    out.warn("게이트웨이 목록 형식이 달라 세션을 제외했습니다.");
                    continue;
                }
                let mut hops = Vec::new();
                let mut valid = true;
                for (i, host) in hosts.iter().enumerate() {
                    let mut hop = profile(
                        &format!("{name} 경유 {}", i + 1),
                        host,
                        users[i],
                        ports[i].parse().unwrap_or(0),
                    );
                    key(&mut hop, keys.get(i).copied().unwrap_or(""), out);
                    let mut check = hop.clone();
                    if check.username.is_empty() {
                        check.username = "preview".into();
                    }
                    if check.validate().is_err() {
                        valid = false;
                        break;
                    }
                    p.jump_ids.push(hop.id.clone());
                    hops.push(hop);
                }
                if !valid {
                    out.skipped += 1;
                    out.warn("유효하지 않은 게이트웨이 때문에 세션을 제외했습니다.");
                    continue;
                }
                for hop in hops {
                    out.add(hop, &format!("{folder} / 경유"))?;
                }
            }
            out.add(p, folder)?;
        }
        Ok(())
    }
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            flush(&mut result, &folder, &mut entries)?;
            folder.clear();
            active = line == "[Bookmarks]"
                || line
                    .strip_prefix("[Bookmarks_")
                    .and_then(|s| s.strip_suffix(']'))
                    .is_some_and(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()));
        } else if active && let Some((name, value)) = line.split_once('=') {
            if name == "SubRep" {
                folder = value.replace('\\', " / ");
            } else if name != "ImgNum" {
                entries.push((name.trim().into(), value.trim().into()));
            }
        }
    }
    flush(&mut result, &folder, &mut entries)?;
    result.warn("SSH 북마크의 폴더 계층·키 경로·게이트웨이를 변환합니다. 공개 형식 관찰 자료를 참고한 제한적 어댑터이며 내보낸 프로그램의 버전은 파일에서 확인할 수 없습니다. 별도 터널 섹션·PPK·명령·매크로·신뢰 설정은 제외합니다.");
    Ok(result)
}

pub(crate) fn words(line: &str) -> Result<Vec<String>> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return Ok(vec![]);
    }
    let end = line
        .find(|c: char| c.is_whitespace() || c == '=')
        .unwrap_or(line.len());
    let keyword = &line[..end];
    let rest = line[end..].trim_start();
    let rest = rest.strip_prefix('=').unwrap_or(rest).trim_start();
    let mut out = vec![keyword.into()];
    let mut word = String::new();
    let mut quoted = false;
    for c in rest.chars() {
        match c {
            '"' => quoted = !quoted,
            '#' if !quoted => break,
            c if c.is_whitespace() && !quoted => {
                if !word.is_empty() {
                    out.push(std::mem::take(&mut word));
                }
            }
            c => word.push(c),
        }
    }
    if quoted {
        return Err("OpenSSH 설정의 따옴표가 닫히지 않았습니다.".into());
    }
    if !word.is_empty() {
        out.push(word);
    }
    Ok(out)
}
pub(crate) fn glob(pattern: &str, value: &str) -> bool {
    let p = pattern.as_bytes();
    let v = value.as_bytes();
    let (mut i, mut j, mut star, mut retry) = (0, 0, None, 0);
    while j < v.len() {
        if i < p.len() && (p[i] == b'?' || p[i].eq_ignore_ascii_case(&v[j])) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == b'*' {
            star = Some(i);
            i += 1;
            retry = j;
        } else if let Some(s) = star {
            retry += 1;
            j = retry;
            i = s + 1;
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == b'*' {
        i += 1;
    }
    i == p.len()
}
fn endpoint(value: &str) -> Option<(String, u16)> {
    let (host, port) = value.rsplit_once(':')?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let port = port.parse::<u16>().ok()?;
    (!host.is_empty() && port > 0).then(|| (host.into(), port))
}
fn tunnel(
    profile_id: &str,
    kind: &str,
    listen: &str,
    target: Option<&str>,
) -> Result<crate::tunnels::Config> {
    let port = if let Ok(port) = listen.parse::<u16>() {
        port
    } else {
        let (host, port) = endpoint(listen).ok_or("터널 수신 주소 형식 오류")?;
        if !matches!(host.as_str(), "127.0.0.1" | "localhost") {
            return Err("루프백 IPv4 터널만 변환합니다.".into());
        }
        port
    };
    let (host, target_port) = if kind == "dynamic" {
        ("127.0.0.1".into(), 1)
    } else {
        endpoint(target.ok_or("터널 목적지 누락")?).ok_or("터널 목적지 형식 오류")?
    };
    let c = crate::tunnels::Config {
        id: uuid::Uuid::new_v4().to_string(),
        profile_id: profile_id.into(),
        name: format!("{kind} {port}"),
        kind: kind.into(),
        port,
        host,
        target_port,
        auto_start: false,
    };
    c.validate()?;
    Ok(c)
}
fn openssh(text: &str) -> Result<Preview> {
    let mut result = Preview::new();
    let mut lines = vec![];
    let mut aliases = vec![];
    for line in text.lines() {
        let mut w = words(line)?;
        if w.is_empty() {
            continue;
        }
        w[0] = w[0].to_ascii_lowercase();
        if matches!(w[0].as_str(), "match" | "include") {
            return Err(
                "Match는 지원하지 않습니다. Include는 파일 목록 승인 후에만 읽습니다.".into(),
            );
        }
        if w.len() < 2 {
            return Err("OpenSSH 지시문에 값이 없습니다.".into());
        }
        if w[0] == "host" {
            for a in &w[1..] {
                if !a.contains(['*', '?', '!']) && !aliases.contains(a) {
                    aliases.push(a.clone());
                }
            }
        }
        lines.push(w);
    }
    if aliases.len() > 500 {
        return Err("한 번에 500개까지 가져올 수 있습니다.".into());
    }
    let declared = aliases.clone();
    let mut jumps = Vec::new();
    for alias in aliases {
        let mut applies = true;
        let mut values = HashMap::new();
        let mut forwards = vec![];
        for w in &lines {
            if w[0] == "host" {
                applies = w[1..]
                    .iter()
                    .any(|p| !p.starts_with('!') && glob(p, &alias))
                    && !w[1..]
                        .iter()
                        .any(|p| p.strip_prefix('!').is_some_and(|p| glob(p, &alias)));
            } else if applies {
                values.entry(w[0].as_str()).or_insert(w[1].as_str());
                if matches!(
                    w[0].as_str(),
                    "localforward" | "remoteforward" | "dynamicforward"
                ) {
                    forwards.push(w);
                }
            }
        }
        let get = |key: &str| values.get(key).copied().unwrap_or("");
        if [
            "proxycommand",
            "hostkeyalias",
            "knownhostscommand",
            "certificatefile",
        ]
        .iter()
        .any(|k| !matches!(get(k), "" | "none"))
            || !matches!(get("canonicalizehostname"), "" | "no" | "false")
        {
            result.skipped += 1;
            result.warn("ProxyCommand·HostKeyAlias·KnownHostsCommand·CertificateFile·호스트 정규화 조건 세션을 제외했습니다.");
            continue;
        }
        let host = if get("hostname").is_empty() {
            alias.as_str()
        } else {
            get("hostname")
        };
        if host.contains(['%', '$', '~']) || get("user").contains(['%', '$']) {
            result.skipped += 1;
            result.warn("토큰 치환이 필요한 접속 대상을 제외했습니다.");
            continue;
        }
        let mut p = profile(
            &alias,
            host,
            get("user"),
            if get("port").is_empty() {
                22
            } else {
                get("port").parse().unwrap_or(0)
            },
        );
        let key = get("identityfile");
        if !matches!(key, "" | "none") {
            if key.contains(['%', '$', '~']) {
                result.warn("환경변수·홈·토큰 키 경로는 적용 전 다시 지정하세요.");
            } else {
                p.auth = "key".into();
                p.key_path = key.into();
            }
        }
        for (name, slot) in [
            ("connecttimeout", &mut p.timeout),
            ("serveraliveinterval", &mut p.keepalive),
        ] {
            if let Ok(n) = get(name).parse::<u64>() {
                if (5..=if name == "connecttimeout" { 120 } else { 300 }).contains(&n) {
                    *slot = n;
                } else {
                    result.warn("타임아웃·KeepAlive 범위를 벗어난 값은 기본값을 사용합니다.");
                }
            }
        }
        let id = p.id.clone();
        if !matches!(get("proxyjump"), "" | "none") {
            jumps.push((id.clone(), get("proxyjump").to_string()));
        }
        result.add(p, "OpenSSH")?;
        if result.bundle.profiles.iter().any(|p| p.id == id) {
            for w in forwards {
                let kind = match w[0].as_str() {
                    "localforward" => "local",
                    "remoteforward" => "remote",
                    _ => "dynamic",
                };
                match tunnel(&id, kind, &w[1], w.get(2).map(String::as_str)) {
                    Ok(c) => result.bundle.tunnels.push(c),
                    Err(_) => {
                        result.warn("Unix 소켓·비루프백·지원하지 않는 터널 형식은 제외했습니다.")
                    }
                }
            }
        }
    }
    for (id, value) in jumps {
        let mut ids = Vec::new();
        let mut valid = true;
        for part in value.split(',') {
            if ids.len() >= crate::routes::MAX_HOPS || part.contains(['%', '$', '~', '/']) {
                valid = false;
                break;
            }
            let (user, address) = part
                .rsplit_once('@')
                .map_or((None, part), |(u, a)| (Some(u), a));
            let (host, port) = if address.starts_with('[') || address.matches(':').count() == 1 {
                match endpoint(address) {
                    Some((h, p)) => (h, Some(p)),
                    None => {
                        valid = false;
                        break;
                    }
                }
            } else {
                (address.to_string(), None)
            };
            let known = result
                .bundle
                .profiles
                .iter()
                .find(|p| p.name == host)
                .cloned();
            if known.is_none() && declared.contains(&host) {
                valid = false;
                break;
            }
            if let Some(p) = &known
                && user.is_none()
                && port.is_none()
            {
                ids.push(p.id.clone());
                continue;
            }
            let mut hop = known.unwrap_or_else(|| profile(&format!("경유 {host}"), &host, "", 22));
            hop.id = uuid::Uuid::new_v4().to_string();
            hop.name = format!("경유 {part}");
            if let Some(u) = user {
                hop.username = u.into();
            }
            if let Some(p) = port {
                hop.port = p;
            }
            let hop_id = hop.id.clone();
            result.add(hop, "OpenSSH / 경유")?;
            if !result.bundle.profiles.iter().any(|p| p.id == hop_id) {
                valid = false;
                break;
            }
            ids.push(hop_id);
        }
        if valid {
            if let Some(p) = result.bundle.profiles.iter_mut().find(|p| p.id == id) {
                p.jump_ids = ids;
            }
        } else {
            result.bundle.profiles.retain(|p| p.id != id);
            result.skipped += 1;
            result.warn(
                "변환할 수 없는 ProxyJump 세션을 제외했습니다. 직접 연결로 바꾸지 않았습니다.",
            );
        }
    }
    // Remove dependent sessions too; never fall back to direct connection after a missing hop.
    loop {
        let invalid: Vec<_> = result
            .bundle
            .profiles
            .iter()
            .filter(|p| crate::routes::resolve(p, &result.bundle.profiles).is_err())
            .map(|p| p.id.clone())
            .collect();
        if invalid.is_empty() {
            break;
        }
        result.skipped += invalid.len();
        result.bundle.profiles.retain(|p| !invalid.contains(&p.id));
        result.warn("순환·중복·누락·4홉 초과 경유 세션을 제외했습니다.");
    }
    result
        .bundle
        .tunnels
        .retain(|t| result.bundle.profiles.iter().any(|p| p.id == t.profile_id));
    result.warn("OpenSSH 명시적 Host와 첫 설정값, ProxyJump, 루프백 Local/Remote/DynamicForward를 변환합니다. 추가 IdentityFile·Match·임의 명령·agent forwarding·신뢰 설정은 이전하지 않습니다. 파일에 제품 버전이 없어 원본 버전은 확인할 수 없습니다.");
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_gateway_keys_and_putty_tunnels_are_inert() {
        let mut fields = vec![""; 37];
        fields[0] = "0";
        fields[1] = "inside.example";
        fields[2] = "22";
        fields[3] = "app";
        fields[8] = "gateway.example";
        fields[9] = "2222";
        fields[10] = "gate";
        fields[14] = "C:/keys/app";
        fields[15] = "C:/keys/gate";
        fields[19] = "0";
        let source = format!(
            "[Bookmarks]\nSubRep=Prod\\Seoul\nInside=#109#{}#MobaFont",
            fields.join("%")
        );
        let p = parse(source.as_bytes(), "mobaxterm", "utf-8").unwrap();
        assert_eq!(p.bundle.profiles.len(), 2);
        assert_eq!(
            p.bundle.profiles[1].jump_ids,
            vec![p.bundle.profiles[0].id.clone()]
        );
        assert_eq!(p.bundle.profiles[1].key_path, "C:/keys/app");
        fields[19] = "5";
        let bad = format!("[Bookmarks]\nUnsafe=#109#{}#MobaFont", fields.join("%"));
        assert!(
            parse(bad.as_bytes(), "mobaxterm", "utf-8")
                .unwrap()
                .bundle
                .profiles
                .is_empty()
        );
        let putty = "[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Lab]\n\"Protocol\"=\"ssh\"\n\"HostName\"=\"lab.example\"\n\"UserName\"=\"user\"\n\"PortForwardings\"=\"L8080=localhost:80,R8081=localhost:81,D1080=\"";
        let p = parse(putty.as_bytes(), "putty", "utf-8").unwrap();
        assert_eq!(p.bundle.tunnels.len(), 3);
        assert!(p.bundle.tunnels.iter().all(|t| !t.auto_start));
    }

    #[test]
    fn proxyjump_tunnels_and_hierarchy_remap_as_one_transaction() {
        let source=b"Host gateway\n HostName jump.example\n User gate\nHost inside\n HostName internal.example\n User app\n ProxyJump gateway\n LocalForward 18080 localhost:80\n RemoteForward 18081 localhost:81\n DynamicForward 1080\n";
        let p = parse(source, "openssh", "utf-8").unwrap();
        assert_eq!(p.bundle.profiles.len(), 2);
        assert_eq!(p.bundle.tunnels.len(), 3);
        assert_eq!(
            p.bundle.profiles[1].jump_ids,
            vec![p.bundle.profiles[0].id.clone()]
        );
        let dir = tempfile::tempdir().unwrap();
        let store = crate::storage::Store::open(&dir.path().join("db")).unwrap();
        crate::settings::import(&store, &serde_json::to_vec(&p.bundle).unwrap()).unwrap();
        let all = store.list().unwrap().profiles;
        let end = all.iter().find(|p| p.name == "inside").unwrap();
        let route = crate::routes::resolve(end, &all).unwrap();
        assert_eq!(route.len(), 2);
        assert_ne!(route[0].id, p.bundle.profiles[0].id);
        assert!(
            store
                .tunnel_configs()
                .unwrap()
                .iter()
                .all(|t| !t.auto_start && t.profile_id == end.id)
        );
        assert!(store.delete(&route[0].id).is_err());
    }
    #[test]
    fn unsupported_and_cyclic_hops_never_become_direct() {
        for text in [
            "Host a\nUser u\nProxyJump b\nHost b\nUser u\nProxyJump a",
            "Host a\nUser u\nProxyJump b\nHost b\nUser u\nProxyCommand unsafe",
        ] {
            let p = parse(text.as_bytes(), "openssh", "utf-8").unwrap();
            assert!(p.bundle.profiles.is_empty());
        }
    }

    #[test]
    fn putty_utf16_registry_is_inert_and_ppk_is_not_misrepresented() {
        let source = "Windows Registry Editor Version 5.00\r\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\Lab%20SSH]\r\n\"HostName\"=\"lab.example\"\r\n\"Protocol\"=\"ssh\"\r\n\"UserName\"=\"tester\"\r\n\"PortNumber\"=dword:000008ae\r\n\"PublicKeyFile\"=\"C:\\\\keys\\\\test.ppk\"\r\n[HKEY_CURRENT_USER\\Unrelated]\r\n\"HostName\"=\"ignored.example\"";
        let mut bytes = vec![0xff, 0xfe];
        bytes.extend(source.encode_utf16().flat_map(u16::to_le_bytes));
        let p = parse(&bytes, "auto", "utf-8").unwrap();
        assert_eq!(p.bundle.profiles.len(), 1);
        let s = &p.bundle.profiles[0];
        assert_eq!(
            (&*s.name, &*s.host, s.port),
            ("Lab SSH", "lab.example", 2222)
        );
        assert_eq!(s.auth, "password");
        assert!(s.key_path.is_empty());
        assert!(p.warnings.iter().any(|s| s.contains("PPK")));
    }
    #[test]
    fn putty_proxy_and_non_ssh_are_skipped() {
        let text = "[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\proxy]\n\"Protocol\"=\"ssh\"\n\"ProxyMethod\"=dword:00000005\n[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\serial]\n\"Protocol\"=\"serial\"";
        let p = parse(text.as_bytes(), "putty", "utf-8").unwrap();
        assert!(p.bundle.profiles.is_empty());
        assert_eq!(p.skipped, 2);
    }
    #[test]
    fn moba_folders_encoding_and_missing_username_are_preserved() {
        let text = "[Bookmarks_1]\nSubRep=개발\\서울\nImgNum=41\n테스트= #109#0%lab.example%22%tester%%-1%-1#MobaFont\n빈계정= #109#0%empty.example%2222%%%\nrdp= #91#4%desktop.example%3389%%%\n[Passwords]\nignored=never-import\n";
        let (bytes, _, errors) = encoding_rs::EUC_KR.encode(text);
        assert!(!errors);
        assert!(parse(&bytes, "auto", "utf-8").is_err());
        let p = parse(&bytes, "auto", "cp949").unwrap();
        assert_eq!(p.bundle.groups[0].name, "개발");
        assert_eq!(p.bundle.groups[1].name, "서울");
        assert_eq!(
            p.bundle.groups[1].parent_id.as_ref(),
            Some(&p.bundle.groups[0].id)
        );
        assert_eq!(p.bundle.profiles.len(), 2);
        assert_eq!(p.bundle.profiles[0].name, "테스트");
        assert!(p.bundle.profiles[1].username.is_empty());
        assert_eq!(p.skipped, 1);
        assert!(!serde_json::to_string(&p).unwrap().contains("never-import"));
    }
    #[test]
    fn openssh_first_value_patterns_quotes_and_proxy_skip() {
        let text = "Host lab other\n HostName=lab.example\n User \"test user\" # comment\n Port 2222\n IdentityFile \"C:/keys/test key\"\nHost other\n ProxyCommand command\nHost * !other\n User fallback\n Port 22\nHost *\n ConnectTimeout 9\n";
        let p = parse(text.as_bytes(), "openssh", "utf-8").unwrap();
        assert_eq!(p.bundle.profiles.len(), 1);
        assert_eq!(p.skipped, 1);
        let s = &p.bundle.profiles[0];
        assert_eq!(s.name, "lab");
        assert_eq!(s.port, 2222);
        assert_eq!(s.username, "test user");
        assert_eq!(s.key_path, "C:/keys/test key");
        assert_eq!(s.auth, "key");
        assert_eq!(s.timeout, 9);
    }
    #[test]
    fn openssh_does_not_evaluate_external_or_conditional_configuration() {
        for source in [
            "Host lab\n Include extra.conf",
            "Match exec \"anything\"\nHost lab",
        ] {
            assert!(parse(source.as_bytes(), "openssh", "utf-8").is_err());
        }
        let p = parse(
            b"Host *\n User defaults\nHost a\n User later\n",
            "openssh",
            "utf-8",
        )
        .unwrap();
        assert_eq!(p.bundle.profiles[0].username, "defaults");
    }
    #[test]
    fn limits_and_unknown_formats_fail_closed() {
        assert!(
            parse(
                &vec![b'x'; crate::maintenance::MAX_CONFIG_BYTES + 1],
                "putty",
                "utf-8"
            )
            .is_err()
        );
        assert!(parse(b"unrecognized", "auto", "utf-8").is_err());
        assert!(parse(b"Host a\nUser \"unfinished", "openssh", "utf-8").is_err());
        assert!(parse(b"Host a\nUser x", "openssh", "bogus").is_err());
    }
    #[test]
    fn converted_data_roundtrips_v2_with_new_ids_and_no_credentials() {
        let p = parse(
            b"Host lab\nHostName lab.example\nUser tester",
            "openssh",
            "utf-8",
        )
        .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let store = crate::storage::Store::open(&dir.path().join("db")).unwrap();
        let data = serde_json::to_vec(&p.bundle).unwrap();
        assert_eq!(crate::settings::import(&store, &data).unwrap(), 1);
        let stored = store.list().unwrap();
        assert_ne!(stored.profiles[0].id, p.bundle.profiles[0].id);
        assert!(!stored.profiles[0].has_secret);
        let exported = crate::settings::export(&store).unwrap();
        let p = parse(&exported, "auto", "utf-8").unwrap();
        assert_eq!(p.bundle.version, 3);
        assert_eq!(p.bundle.format.as_deref(), Some("dachsterm.sessions"));
        assert_eq!(p.bundle.profiles[0].host, "lab.example");
    }
}
