//! Session settings other programs keep on this PC (I.2). Only fixed places are read, and only
//! when the app asks: PuTTY's sessions in the registry, the bookmarks file whose place the
//! bookmarks program records in its registry key (or its usual `%APPDATA%` folder), and
//! `~/.ssh/config`. Paths stay in here: the page names a source, never a file, so it cannot make
//! the backend read anything else. What is read goes through the same inert parsers as a file.
use super::{Preview, approval::Reviewed, decode, parse};
use crate::storage::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    Putty,
    Bookmarks,
    Openssh,
}
impl Source {
    const ALL: [Source; 3] = [Source::Putty, Source::Bookmarks, Source::Openssh];
    fn format(self) -> &'static str {
        match self {
            Source::Putty => "putty",
            Source::Bookmarks => "mobaxterm",
            Source::Openssh => "openssh",
        }
    }
}

/// The group an import from `format` is offered under. It is shown in the app, so the bookmarks
/// format goes by what it is rather than by a product name (engineering-rules §3).
pub(super) fn label(format: &str) -> Option<&'static str> {
    match format {
        "putty" => Some("PuTTY"),
        "mobaxterm" => Some("세션 북마크"),
        "openssh" => Some("OpenSSH"),
        _ => None,
    }
}

/// A source found on this PC.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    source: Source,
    /// Where it is, for the user to recognise it: a file path or the registry key.
    place: String,
    #[serde(flatten)]
    counted: Counted,
    /// Why it could not be read as sessions; it is still listed so the user knows why.
    problem: Option<String>,
}
/// What a source holds. A file with nothing to import is still listed: the user sees it was
/// found, and how many entries were left out (other session kinds, unsupported settings).
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Counted {
    /// Sessions its preview would list. With `include`, those of the main file only.
    count: usize,
    skipped: usize,
    /// The config has `Include` lines, read only after the user picks the files.
    include: bool,
}

const PUTTY_KEY: &str = r"Software\SimonTatham\PuTTY\Sessions";
const GONE: &str = "이 PC에서 그 설정을 더 이상 찾을 수 없습니다. 목록을 새로 고치세요.";

#[tauri::command]
pub async fn config_detect() -> Result<Vec<Found>> {
    tokio::task::spawn_blocking(|| Source::ALL.into_iter().filter_map(found).collect())
        .await
        .map_err(|_| "다른 프로그램의 세션 설정을 찾지 못했습니다.".into())
}

/// The preview of a source `config_detect` listed, read again now.
#[tauri::command]
pub async fn config_preview_found(source: Source) -> Result<Reviewed> {
    tokio::task::spawn_blocking(move || preview_found(source))
        .await
        .map_err(|_| "세션 설정을 읽지 못했습니다.".to_string())?
}

/// What the import does with a file: the user's own pick, or one found here.
pub(super) fn preview_file(path: &Path, format: &str, encoding: &str) -> Result<Reviewed> {
    let data = Zeroizing::new(crate::maintenance::read_config(path)?);
    preview_data(path, &data, format, encoding)
}

fn preview_data(path: &Path, data: &[u8], format: &str, encoding: &str) -> Result<Reviewed> {
    if matches!(format, "auto" | "openssh") && has_include(data, encoding)? {
        let mut preview = Preview::new();
        preview.include_plan = Some(crate::config_includes::plan(path, encoding)?);
        preview.source = label("openssh");
        preview.warn("Include 파일 내용을 읽기 전에 목록에서 허용할 파일을 선택하세요. 선택한 파일의 폴더를 루트로 사용하며 상대 경로만 지원합니다. 파일·명령은 실행하지 않습니다.");
        return Ok(super::approval::review(preview));
    }
    parse(data, format, encoding).map(super::approval::review)
}

fn has_include(data: &[u8], encoding: &str) -> Result<bool> {
    let text = Zeroizing::new(decode(data, encoding)?);
    Ok(text.lines().any(is_include))
}
fn is_include(line: &str) -> bool {
    super::words(line)
        .ok()
        .and_then(|w| w.first().cloned())
        .is_some_and(|w| w.eq_ignore_ascii_case("include"))
}

fn preview_found(source: Source) -> Result<Reviewed> {
    if source == Source::Putty {
        return putty_registry(PUTTY_KEY)?
            .ok_or_else(|| GONE.to_string())
            .map(super::approval::review);
    }
    let path = locate(source).ok_or(GONE)?;
    let data = Zeroizing::new(crate::maintenance::read_config(&path)?);
    preview_data(&path, &data, source.format(), encoding_of(&data))
}

fn found(source: Source) -> Option<Found> {
    let (place, read) = if source == Source::Putty {
        let counted = |p: Preview| Counted {
            count: p.bundle.profiles.len(),
            skipped: p.skipped,
            include: false,
        };
        (
            format!(r"레지스트리 HKEY_CURRENT_USER\{PUTTY_KEY}"),
            putty_registry(PUTTY_KEY).map(|p| p.map(counted)),
        )
    } else {
        let path = locate(source)?;
        (shown(&path), count_file(&path, source).map(Some))
    };
    let (counted, problem) = match read {
        Ok(counted) => (counted?, None),
        Err(problem) => (Counted::default(), Some(problem)),
    };
    Some(Found {
        source,
        place,
        counted,
        problem,
    })
}

fn count_file(path: &Path, source: Source) -> Result<Counted> {
    let data = Zeroizing::new(crate::maintenance::read_config(path)?);
    let encoding = encoding_of(&data);
    let text = Zeroizing::new(decode(&data, encoding)?);
    let include = source == Source::Openssh && text.lines().any(is_include);
    // The count leaves `Include` out; those files are listed for approval in the preview.
    let main = Zeroizing::new(
        text.lines()
            .filter(|l| !is_include(l))
            .collect::<Vec<_>>()
            .join("\n"),
    );
    match parse(main.as_bytes(), source.format(), "utf-8") {
        Ok(p) => Ok(Counted {
            count: p.bundle.profiles.len(),
            skipped: p.skipped,
            include,
        }),
        Err(_) if include => Ok(Counted {
            include,
            ..Counted::default()
        }),
        Err(e) => Err(e),
    }
}

/// Text files from Windows programs are often in the system's ANSI code page (CP949 on Korean
/// Windows), which the user cannot pick on the found list; UTF-8 and UTF-16 with BOM come first.
fn encoding_of(data: &[u8]) -> &'static str {
    if decode(data, "utf-8").map(Zeroizing::new).is_ok() {
        return "utf-8";
    }
    #[cfg(windows)]
    {
        // SAFETY: GetACP takes no arguments and only returns the code page number.
        match unsafe { windows_sys::Win32::Globalization::GetACP() } {
            949 => return "cp949",
            1252 => return "windows-1252",
            _ => {}
        }
    }
    "utf-8"
}

fn locate(source: Source) -> Option<PathBuf> {
    match source {
        Source::Putty => None,
        Source::Bookmarks => bookmarks_file(),
        Source::Openssh => dirs::home_dir()
            .map(|home| home.join(".ssh").join("config"))
            .filter(|p| p.is_file()),
    }
}

/// The file the bookmarks program last used, which also finds a portable copy that ran last,
/// then its installed edition's usual place.
#[cfg(windows)]
fn bookmarks_file() -> Option<PathBuf> {
    let last = super::registry::Key::open(r"Software\Mobatek\MobaXterm")
        .and_then(|key| key.value("LastIniPath"))
        .map(PathBuf::from);
    let usual = dirs::config_dir().map(|d| d.join("MobaXterm").join("MobaXterm.ini"));
    last.into_iter().chain(usual).find(|p| p.is_file())
}
/// The bookmarks program runs on Windows only.
#[cfg(not(windows))]
fn bookmarks_file() -> Option<PathBuf> {
    None
}

#[cfg(windows)]
fn putty_registry(path: &str) -> Result<Option<Preview>> {
    use super::{putty, registry::Key};
    let Some(sessions) = Key::open(path) else {
        return Ok(None);
    };
    let mut result = Preview::new();
    let mut values = std::collections::HashMap::new();
    for raw in sessions.children() {
        let (Some(name), Some(key)) = (super::unescape_session(&raw), sessions.child(&raw)) else {
            result.skipped += 1;
            continue;
        };
        for field in putty::FIELDS {
            if let Some(value) = key.value(field) {
                values.insert(field.to_string(), value);
            }
        }
        putty::session(&mut result, Some(name), &mut values)?;
    }
    if result.bundle.profiles.is_empty() && result.skipped == 0 {
        return Ok(None);
    }
    result.warn("PuTTY 레지스트리: 기본 접속·OpenSSH 키 경로·인증서 경로·루프백 L/R/D 터널·SOCKS5/HTTP 프록시를 변환합니다. PPK·그 밖의 프록시·명령·신뢰·암호는 이전하지 않습니다.");
    super::finish(result, "putty").map(Some)
}
/// PuTTY keeps its sessions in the registry on Windows only; elsewhere they are in files the user
/// can pick.
#[cfg(not(windows))]
fn putty_registry(_: &str) -> Result<Option<Preview>> {
    Ok(None)
}

/// A path as the user knows it: Windows may record the 8.3 short form (`ADMINI~1`).
fn shown(path: &Path) -> String {
    let full = std::fs::canonicalize(path).unwrap_or_else(|_| path.into());
    let text = full.to_string_lossy();
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preview(reviewed: Reviewed) -> serde_json::Value {
        serde_json::to_value(reviewed).unwrap()
    }

    #[test]
    fn found_bookmarks_keep_their_folders_and_offer_the_source_group() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("bookmarks.ini");
        let text = "[Bookmarks_1]\nSubRep=개발\\서울\nImgNum=41\nlab= #109#0%lab.example%22%tester%%-1%-1#MobaFont\n[Passwords]\nignored=never-import\n";
        let (bytes, _, _) = encoding_rs::EUC_KR.encode(text);
        std::fs::write(&path, &bytes).unwrap();
        let found = count_file(&path, Source::Bookmarks);
        // CP949 is only guessed where it is the system code page.
        if encoding_of(&bytes) == "cp949" {
            assert_eq!(found.unwrap().count, 1);
        }
        std::fs::write(&path, text).unwrap();
        assert_eq!(
            count_file(&path, Source::Bookmarks).unwrap(),
            Counted {
                count: 1,
                skipped: 0,
                include: false
            }
        );
        let v = preview(preview_file(&path, "mobaxterm", "utf-8").unwrap());
        assert_eq!(v["source"], "세션 북마크");
        let groups: Vec<_> = v["bundle"]["groups"].as_array().unwrap().iter().collect();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["name"], "개발");
        assert_eq!(groups[1]["parentId"], groups[0]["id"]);
        assert!(!v.to_string().contains("never-import"));
    }

    #[test]
    fn found_ssh_config_counts_the_main_file_and_leaves_include_to_approval() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config");
        std::fs::write(&path, "Include extra\nHost lab\n User tester\n").unwrap();
        std::fs::write(dir.path().join("extra"), "Host other\n User u\n").unwrap();
        let counted = count_file(&path, Source::Openssh).unwrap();
        assert_eq!((counted.count, counted.include), (1, true));
        let v = preview(preview_file(&path, "openssh", "utf-8").unwrap());
        assert_eq!(v["source"], "OpenSSH");
        assert_eq!(v["includePlan"]["files"].as_array().unwrap().len(), 2);
        assert!(v["bundle"]["profiles"].as_array().unwrap().is_empty());
        std::fs::write(&path, "# nothing yet\n").unwrap();
        // Found but empty: still listed, with nothing to import.
        assert_eq!(
            count_file(&path, Source::Openssh).unwrap(),
            Counted::default()
        );
        let other = "[Bookmarks]\nwsl= #105#14%Ubuntu%%%\nlab= #109#0%lab.example%22%u%%\n";
        std::fs::write(&path, other).unwrap();
        let counted = count_file(&path, Source::Bookmarks).unwrap();
        assert_eq!((counted.count, counted.skipped), (1, 1));
    }

    #[test]
    fn ssh_config_sessions_are_not_put_in_a_group_by_the_parser() {
        let p = parse(
            b"Host lab\n HostName lab.example\n User u\n",
            "openssh",
            "utf-8",
        )
        .unwrap();
        assert!(p.bundle.groups.is_empty());
        assert_eq!(p.source, Some("OpenSSH"));
        let own =
            r#"{"format":"dachsterm.sessions","version":2,"profiles":[],"groups":[],"tunnels":[]}"#;
        assert_eq!(parse(own.as_bytes(), "auto", "utf-8").unwrap().source, None);
    }

    #[cfg(windows)]
    #[test]
    fn putty_sessions_are_read_from_the_registry_without_their_secrets() {
        use super::super::registry::fixture::{Value::*, remove_tree, write};
        let root = format!(r"Software\DachsTerm-test-{}", uuid::Uuid::new_v4());
        let sessions = format!(r"{root}\Sessions");
        write(
            &format!(r"{sessions}\Lab%20SSH"),
            &[
                ("Protocol", Text("ssh")),
                ("HostName", Text("lab.example")),
                ("UserName", Text("tester")),
                ("PortNumber", Number(2222)),
                ("ProxyPassword", Text("never-import")),
                ("PortForwardings", Text("L8080=localhost:80")),
            ],
        );
        write(
            &format!(r"{sessions}\Default%20Settings"),
            &[("HostName", Text("x"))],
        );
        write(
            &format!(r"{sessions}\serial"),
            &[("Protocol", Text("serial"))],
        );
        let read = putty_registry(&sessions);
        let missing = putty_registry(&format!(r"{root}\Missing"));
        remove_tree(&root);
        let p = read.unwrap().unwrap();
        assert_eq!(p.bundle.profiles.len(), 1);
        let lab = &p.bundle.profiles[0];
        assert_eq!(
            (lab.name.as_str(), lab.host.as_str()),
            ("Lab SSH", "lab.example")
        );
        assert_eq!((lab.username.as_str(), lab.port), ("tester", 2222));
        assert!(lab.group_id.is_none());
        assert_eq!(p.bundle.tunnels.len(), 1);
        assert!(!p.bundle.tunnels[0].auto_start);
        assert_eq!(p.skipped, 1);
        assert_eq!(p.source, Some("PuTTY"));
        assert!(!serde_json::to_string(&p).unwrap().contains("never-import"));
        assert!(missing.unwrap().is_none());
        assert!(super::super::registry::Key::open(&root).is_none());
    }
}
