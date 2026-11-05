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
}
impl Preview {
    fn new() -> Self {
        Self {
            bundle: Bundle {
                format: Some("daxterm.sessions".into()),
                version: 2,
                profiles: vec![],
                groups: vec![],
                tunnels: vec![],
            },
            warnings: vec![],
            skipped: 0,
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
        if !group.is_empty() {
            if group.len() > 100 {
                return Err("그룹 경로는 UTF-8 100바이트 이하여야 합니다.".into());
            }
            let id = if let Some(g) = self.bundle.groups.iter().find(|g| g.name == group) {
                g.id.clone()
            } else {
                if self.bundle.groups.len() >= 100 {
                    return Err("그룹은 100개까지 가져올 수 있습니다.".into());
                }
                let id = uuid::Uuid::new_v4().to_string();
                self.bundle.groups.push(Group {
                    id: id.clone(),
                    name: group.into(),
                });
                id
            };
            p.group_id = Some(id);
        }
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
        group_id: None,
        favorite: false,
        timeout: 15,
        keepalive: 15,
        last_connected: None,
        has_secret: false,
    }
}
fn decode(data: &[u8], encoding: &str) -> Result<String> {
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
            "daxterm"
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
        "daxterm" => {
            let bundle: Bundle =
                serde_json::from_str(&text).map_err(|_| "DaxTerm JSON 스키마 오류")?;
            crate::settings::validate_bundle(&bundle)?;
            Preview {
                bundle,
                warnings: vec![],
                skipped: 0,
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
    if format != "daxterm" {
        result.warn("외부 형식에서는 기본 SSH 접속 정보만 변환합니다. 터널·프록시·점프 호스트·자동 명령·터미널 외형·호스트키 신뢰·암호는 이전하지 않습니다. 적용 전 접속 대상을 확인하세요.");
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
    parse(&data, &format, &encoding).map(Some)
}
#[tauri::command]
pub fn config_apply(state: State<AppState>, data: String) -> Result<usize> {
    if data.len() > crate::maintenance::MAX_CONFIG_BYTES {
        return Err("설정 파일은 2MiB 이하여야 합니다.".into());
    }
    let bundle: Bundle = serde_json::from_str(&data).map_err(|_| "DaxTerm JSON 스키마 오류")?;
    crate::settings::validate_bundle(&bundle)?;
    let _guard = state.mutation.lock().unwrap();
    crate::maintenance::snapshot(&state.store, &state.directory)?;
    crate::settings::import(&state.store, data.as_bytes())
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
                out.add(p, "PuTTY")?;
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
            out.add(profile(&name, fields[1], fields[3], port), folder)?;
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
    result.warn("MobaXterm은 SSH 북마크의 이름·호스트·포트·사용자·폴더만 변환합니다. 키 인증은 세션 편집에서 다시 지정하고, 지원하지 않는 게이트웨이·프록시가 필요한 세션은 선택 해제하세요.");
    Ok(result)
}

fn words(line: &str) -> Result<Vec<String>> {
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
fn glob(pattern: &str, value: &str) -> bool {
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
            return Err("Match/Include가 있는 OpenSSH 파일은 자동 변환하지 않습니다. 해당 조건을 해석한 별도 Host 설정 파일을 선택하세요. 명령과 외부 파일은 실행·조회하지 않았습니다.".into());
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
    for alias in aliases {
        let mut applies = true;
        let mut values = HashMap::new();
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
            }
        }
        let get = |key: &str| values.get(key).copied().unwrap_or("");
        if ["proxyjump", "proxycommand"]
            .iter()
            .any(|k| !matches!(get(k), "" | "none"))
        {
            result.skipped += 1;
            result.warn("OpenSSH ProxyJump/ProxyCommand 세션은 지원하지 않아 제외했습니다.");
            continue;
        }
        let host = if get("hostname").is_empty() {
            alias.as_str()
        } else {
            get("hostname")
        };
        if host.contains('%') || get("user").contains('%') {
            result.skipped += 1;
            result.warn("OpenSSH 토큰 치환이 필요한 접속 대상을 제외했습니다.");
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
                result.warn("환경변수·홈 경로·토큰이 있는 키 경로는 가져오지 않았습니다. 세션에서 키 파일을 다시 지정하세요.");
            } else {
                p.auth = "key".into();
                p.key_path = key.into();
            }
        }
        result.add(p, "OpenSSH")?;
    }
    result.warn("OpenSSH는 명시적 Host 별칭과 Host 패턴의 첫 설정값을 적용합니다. User 미지정 시 직접 입력하며 추가 IdentityFile·인증 지시문·KeepAlive 등 나머지 옵션은 이전하지 않습니다.");
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(p.bundle.groups[0].name, "개발 / 서울");
        assert_eq!(p.bundle.profiles.len(), 2);
        assert_eq!(p.bundle.profiles[0].name, "테스트");
        assert!(p.bundle.profiles[1].username.is_empty());
        assert_eq!(p.skipped, 1);
        assert!(!serde_json::to_string(&p).unwrap().contains("never-import"));
    }
    #[test]
    fn openssh_first_value_patterns_quotes_and_proxy_skip() {
        let text = "Host lab other\n HostName=lab.example\n User \"test user\" # comment\n Port 2222\n IdentityFile \"C:/keys/test key\"\nHost other\n ProxyJump bastion\nHost * !other\n User fallback\n Port 22\nHost *\n ConnectTimeout 9\n";
        let p = parse(text.as_bytes(), "openssh", "utf-8").unwrap();
        assert_eq!(p.bundle.profiles.len(), 1);
        assert_eq!(p.skipped, 1);
        let s = &p.bundle.profiles[0];
        assert_eq!(s.name, "lab");
        assert_eq!(s.port, 2222);
        assert_eq!(s.username, "test user");
        assert_eq!(s.key_path, "C:/keys/test key");
        assert_eq!(s.auth, "key");
        assert_eq!(s.timeout, 15);
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
        assert_eq!(p.bundle.version, 2);
        assert_eq!(p.bundle.format.as_deref(), Some("daxterm.sessions"));
        assert_eq!(p.bundle.profiles[0].host, "lab.example");
    }
}
