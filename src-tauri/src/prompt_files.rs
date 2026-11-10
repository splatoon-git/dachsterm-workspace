//! Sends a PC's image or file to a server so a program running there can read it. The app uploads
//! over SFTP and types the path, because a remote program cannot see this PC's clipboard.
//!
//! This does not use the transfer queue. The queue's lasting resume and conflict handling do not
//! fit "attach this to the prompt now", and after a restart there is no prompt left to type into.
use crate::{
    AppState,
    sftp::{Entry, failure},
    ssh::Connections,
    storage::Result,
};
use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, OpenFlags},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_FILES: usize = 10;
/// Checked before encoding. A clipboard image is held in memory at four bytes per pixel.
const MAX_IMAGE_PIXELS: usize = 40_000_000;
const MAX_NAME_CHARS: usize = 100;
const KEEP_SECONDS: u64 = 7 * 24 * 60 * 60;
const FILE_TIMEOUT: Duration = Duration::from_secs(60);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(10);
const CLIPBOARD_NAME: &str = "clipboard.png";
const TOO_LARGE: &str =
    "파일당 20MiB, 한 번에 10개까지 보낼 수 있습니다. 더 큰 파일은 파일 패널을 사용하세요.";

fn name_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')
}

/// Removes everything a shell or a normalizing file system could treat differently, including the
/// NFD names macOS produces. The end of a long name is kept because it holds the extension.
fn safe_name(original: &str) -> String {
    let mapped: Vec<char> = original
        .chars()
        .map(|c| {
            if u8::try_from(c).is_ok_and(name_char) {
                c
            } else {
                '_'
            }
        })
        .collect();
    let start = mapped.len().saturating_sub(MAX_NAME_CHARS);
    let name: String = mapped[start..].iter().collect();
    if name.is_empty() { "file".into() } else { name }
}

/// Days since 1970 to a calendar date, for names sorted by time without a date library.
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

fn stored_name(original: &str, unix_seconds: u64, random: &str) -> String {
    let (year, month, day) = civil((unix_seconds / 86_400) as i64);
    let second = unix_seconds % 86_400;
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}-{random}-{}",
        second / 3600,
        second / 60 % 60,
        second % 60,
        safe_name(original)
    )
}

/// Only names this module made are ever deleted, so a user's file in this folder stays.
fn is_stored_name(name: &str) -> bool {
    let b = name.as_bytes();
    let digits = |r: std::ops::Range<usize>| b[r].iter().all(u8::is_ascii_digit);
    b.len() > 25
        && digits(0..8)
        && b[8] == b'-'
        && digits(9..15)
        && b[15] == b'-'
        && b[16..24]
            .iter()
            .all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
        && b[24] == b'-'
        && b[25..].iter().all(|c| name_char(*c))
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |t| t.as_secs())
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map_or("file".into(), |n| n.to_string_lossy().into_owned())
}

/// A symbolic link is refused rather than followed, since it can point anywhere on this PC.
async fn check_local(path: &Path, upload: bool) -> Result<u64> {
    let name = file_name(path);
    let meta = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| format!("{name}: 파일을 읽을 수 없습니다."))?;
    if !meta.is_file() {
        return Err(format!("{name}: 폴더와 심볼릭 링크는 보낼 수 없습니다."));
    }
    if upload && meta.len() > MAX_FILE_BYTES {
        return Err(format!("{name}: {TOO_LARGE}"));
    }
    Ok(meta.len())
}

async fn read_local(path: &Path) -> Result<Vec<u8>> {
    let name = file_name(path);
    check_local(path, true).await?;
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| format!("{name}: 파일을 읽을 수 없습니다."))?;
    let mut data = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut data)
        .await
        .map_err(|_| format!("{name}: 파일을 읽을 수 없습니다."))?;
    if data.len() as u64 > MAX_FILE_BYTES {
        return Err(format!("{name}: {TOO_LARGE}"));
    }
    Ok(data)
}

async fn private_directory(session: &SftpSession, path: &str) -> Result<()> {
    if session.symlink_metadata(path).await.is_err() {
        // Losing a race to another upload is fine. The check below decides.
        let _ = session.create_dir(path).await;
    }
    let meta = session.symlink_metadata(path).await.map_err(failure)?;
    if !meta.is_dir() {
        return Err("서버의 첨부 폴더가 일반 폴더가 아니어서 업로드하지 않았습니다.".into());
    }
    let attributes = FileAttributes {
        permissions: Some(0o700),
        ..Default::default()
    };
    session
        .set_metadata(path, attributes)
        .await
        .map_err(failure)
}

async fn prepare(session: &SftpSession) -> Result<String> {
    let home = session.canonicalize(".").await.map_err(failure)?;
    let cache = format!("{}/.cache", home.trim_end_matches('/'));
    if session.metadata(&cache).await.is_err() {
        let _ = session.create_dir(&cache).await;
    }
    let parent = format!("{cache}/dachsterm");
    private_directory(session, &parent).await?;
    let folder = format!("{parent}/prompt");
    private_directory(session, &folder).await?;
    Ok(folder)
}

/// Failing to clean up must never fail the upload the user asked for. `sftp::list` is the listing
/// with a limit: `read_dir` collects until the server says it is done, which it need not say.
async fn remove_old(connections: &Connections, id: &str, session: &SftpSession, folder: &str) {
    let Ok(listing) = crate::sftp::list(connections, id, folder).await else {
        return;
    };
    let now = now();
    let remove = async {
        for entry in listing.entries {
            if expired(&entry, now) {
                let _ = session
                    .remove_file(format!("{folder}/{}", entry.name))
                    .await;
            }
        }
    };
    let _ = tokio::time::timeout(CLEANUP_TIMEOUT, remove).await;
}

fn expired(entry: &Entry, now: u64) -> bool {
    !entry.directory
        && !entry.symlink
        && is_stored_name(&entry.name)
        && entry
            .modified
            .is_some_and(|time| now.saturating_sub(u64::from(time)) > KEEP_SECONDS)
}

async fn write_new(session: &SftpSession, target: &str, data: &[u8]) -> Result<()> {
    let attributes = FileAttributes {
        permissions: Some(0o600),
        ..Default::default()
    };
    let write = async {
        let mut file = session
            .open_with_flags_and_attributes(
                target,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                attributes,
            )
            .await
            .map_err(failure)?;
        file.write_all(data).await.map_err(failure)?;
        file.shutdown().await.map_err(failure)
    };
    let result = tokio::time::timeout(FILE_TIMEOUT, write)
        .await
        .unwrap_or_else(|_| Err("업로드 시간이 초과되었습니다.".into()));
    if result.is_err() {
        let _ = session.remove_file(target).await;
    }
    result
}

async fn upload(
    connections: &Connections,
    id: &str,
    files: Vec<(String, Vec<u8>)>,
) -> Result<Vec<String>> {
    let session = crate::sftp::open(connections, id).await?;
    let folder = prepare(&session).await?;
    remove_old(connections, id, &session, &folder).await;
    let mut written = Vec::new();
    for (name, data) in files {
        let random = uuid::Uuid::new_v4().simple().to_string();
        let target = format!("{folder}/{}", stored_name(&name, now(), &random[..8]));
        if let Err(error) = write_new(&session, &target, &data).await {
            // Nothing gets typed, so files from this attempt would never be used.
            for path in written {
                let _ = session.remove_file::<String>(path).await;
            }
            return Err(error);
        }
        written.push(target);
    }
    Ok(written)
}

/// Runs `read` off the async runtime. The clipboard and the encoder both block.
async fn blocking<T: Send + 'static>(
    read: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(read)
        .await
        .map_err(|_| "클립보드를 읽지 못했습니다.".to_string())?
}

fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>> {
    let failed = |_| "클립보드 이미지를 변환하지 못했습니다.".to_string();
    let mut output = Vec::new();
    let mut encoder = png::Encoder::new(&mut output, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(failed)?;
    writer.write_image_data(rgba).map_err(failed)?;
    writer.finish().map_err(failed)?;
    Ok(output)
}

fn clipboard_png() -> Result<Option<Vec<u8>>> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|_| "클립보드를 읽지 못했습니다.".to_string())?;
    let image = match clipboard.get_image() {
        Ok(image) => image,
        // Anything else on the clipboard simply means there is no image to attach.
        Err(_) => return Ok(None),
    };
    if image.width.saturating_mul(image.height) > MAX_IMAGE_PIXELS {
        return Err("클립보드 이미지가 너무 큽니다. 파일로 저장해 보내세요.".into());
    }
    let (width, height) = (image.width as u32, image.height as u32);
    let png = encode_png(width, height, &image.bytes)?;
    if png.len() as u64 > MAX_FILE_BYTES {
        return Err(TOO_LARGE.into());
    }
    Ok(Some(png))
}

fn digest(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    name: String,
    size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImage {
    item: Item,
    /// What the user approved. The upload refuses a clipboard that has changed since.
    digest: String,
}

#[tauri::command]
pub async fn prompt_clipboard_inspect() -> Result<Option<ClipboardImage>> {
    let png = blocking(clipboard_png).await?;
    Ok(png.map(|png| ClipboardImage {
        item: Item {
            name: CLIPBOARD_NAME.into(),
            size: png.len() as u64,
        },
        digest: digest(&png),
    }))
}

#[tauri::command]
pub async fn prompt_clipboard_image(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
    expected: String,
) -> Result<String> {
    state
        .connections
        .control(&id)?
        .broker
        .check(window.label())?;
    let png = blocking(clipboard_png)
        .await?
        .filter(|png| digest(png) == expected)
        .ok_or("확인한 뒤 클립보드 내용이 바뀌어 보내지 않았습니다. 다시 붙여넣으세요.")?;
    let mut paths = upload(&state.connections, &id, vec![(CLIPBOARD_NAME.into(), png)]).await?;
    paths.pop().ok_or("업로드 결과가 없습니다.".into())
}

/// Local tabs only type the path, so the upload limits apply only when `upload` is set.
#[tauri::command]
pub async fn prompt_files_inspect(paths: Vec<String>, upload: bool) -> Result<Vec<Item>> {
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err(TOO_LARGE.into());
    }
    let mut items = Vec::with_capacity(paths.len());
    for path in &paths {
        let path = Path::new(path);
        items.push(Item {
            name: file_name(path),
            size: check_local(path, upload).await?,
        });
    }
    Ok(items)
}

#[tauri::command]
pub async fn prompt_files_upload(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
    paths: Vec<String>,
) -> Result<Vec<String>> {
    state
        .connections
        .control(&id)?
        .broker
        .check(window.label())?;
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err(TOO_LARGE.into());
    }
    let mut files = Vec::with_capacity(paths.len());
    for path in &paths {
        let path = Path::new(path);
        files.push((file_name(path), read_local(path).await?));
    }
    upload(&state.connections, &id, files).await
}

#[cfg(test)]
mod tests {
    use super::{
        Entry, KEEP_SECONDS, check_local, civil, encode_png, expired, is_stored_name, safe_name,
        stored_name,
    };

    #[test]
    fn stored_names_are_shell_safe_and_keep_the_extension() {
        assert_eq!(safe_name("shot 1.png"), "shot_1.png");
        assert_eq!(safe_name("$(reboot);`id`'.png"), "__reboot___id__.png");
        assert_eq!(safe_name("../../etc/passwd"), ".._.._etc_passwd");
        assert_eq!(safe_name("화면.png"), "__.png");
        // NFC and NFD Korean give different lengths but neither reaches the server name.
        assert!(safe_name("하\u{1161}.png").is_ascii());
        assert_eq!(safe_name(""), "file");
        let long = format!("{}.png", "a".repeat(300));
        let shortened = safe_name(&long);
        assert_eq!(shortened.len(), 100);
        assert!(shortened.ends_with(".png"));
    }

    #[test]
    fn stored_name_contains_the_utc_time() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(19_782), (2024, 2, 29));
        assert_eq!(civil(20_764), (2026, 11, 7));
        assert_eq!(
            stored_name("a b.png", 1_794_052_861, "0a1b2c3d"),
            "20261107-120101-0a1b2c3d-a_b.png"
        );
    }

    #[test]
    fn only_old_regular_files_of_this_module_expire() {
        let name = stored_name("a.png", 1_000, "abcd1234");
        let entry = |name: &str, directory, symlink, modified| Entry {
            name: name.into(),
            directory,
            symlink,
            size: None,
            modified,
            permissions: None,
        };
        let now = 1_000 + KEEP_SECONDS + 1;
        assert!(expired(&entry(&name, false, false, Some(1_000)), now));
        assert!(!expired(&entry(&name, false, false, Some(1_001)), now));
        assert!(!expired(&entry(&name, false, false, None), now));
        assert!(!expired(&entry(&name, true, false, Some(1_000)), now));
        assert!(!expired(&entry(&name, false, true, Some(1_000)), now));
        assert!(!expired(
            &entry("notes.txt", false, false, Some(1_000)),
            now
        ));
    }

    #[test]
    fn cleanup_only_matches_names_this_module_makes() {
        let made = stored_name("x.png", 1_794_052_861, "0a1b2c3d");
        assert!(is_stored_name(&made));
        for other in [
            "notes.txt",
            "",
            "20261107-180101-0a1b2c3d-",
            "20261107-180101-0A1B2C3D-x.png",
            "2026110x-180101-0a1b2c3d-x.png",
            "20261107-180101-0a1b2c3d-a b.png",
            ".dachsterm-20261107-180101-0a1b2c3d-x.png",
        ] {
            assert!(!is_stored_name(other), "{other}");
        }
    }

    #[test]
    fn encodes_an_image_that_decodes_back() {
        let pixels = [255, 0, 0, 255, 0, 255, 0, 128];
        let png = encode_png(2, 1, &pixels).unwrap();
        let mut reader = png::Decoder::new(std::io::Cursor::new(&png))
            .read_info()
            .unwrap();
        let mut output = vec![0; reader.output_buffer_size().unwrap()];
        reader.next_frame(&mut output).unwrap();
        assert_eq!(output, pixels);
    }

    #[tokio::test]
    async fn refuses_folders_links_and_large_uploads() {
        let directory = tempfile::tempdir().unwrap();
        assert!(check_local(directory.path(), true).await.is_err());
        let missing = directory.path().join("missing");
        assert!(check_local(&missing, true).await.is_err());
        let file = directory.path().join("big.bin");
        let handle = std::fs::File::create(&file).unwrap();
        handle.set_len(super::MAX_FILE_BYTES + 1).unwrap();
        assert!(check_local(&file, true).await.is_err());
        // A local tab only types the path, so size does not matter there.
        assert_eq!(
            check_local(&file, false).await.unwrap(),
            super::MAX_FILE_BYTES + 1
        );
        #[cfg(unix)]
        {
            let link = directory.path().join("link");
            std::os::unix::fs::symlink(&file, &link).unwrap();
            assert!(check_local(&link, false).await.is_err());
        }
    }
}
