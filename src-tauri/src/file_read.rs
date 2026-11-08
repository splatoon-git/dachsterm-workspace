//! Reading one file for a file tab, from any source. The bytes go through the same steps whatever
//! the source: look at the start, decide what the file is, then read only as much as that allows.
use crate::{AppState, encoding, ftp, local_files, sftp, source::Source, storage::Result};
use base64::Engine;
use encoding_rs::Encoding;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io,
    path::PathBuf,
    time::{Duration, UNIX_EPOCH},
};
use tauri::State;
use tokio::io::{AsyncRead, AsyncReadExt};

mod format;
use format::{Kind, classify, decode};

/// Text past this asks first, since the editor highlights and keeps every line.
const TEXT_LIMIT: u64 = 2 * 1024 * 1024;
/// The most a tab holds in memory. Matches what external editing fetches (`editor.rs`).
const LIMIT: u64 = 32 * 1024 * 1024;
const HEAD: u64 = 8 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(120);
const NOT_A_FILE: &str = "파일이 아니어서 열 수 없습니다.";
const FTP_FAILED: &str = "FTP 서버에서 파일을 읽지 못했습니다.";

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReadOptions {
    /// The user agreed to open text above `TEXT_LIMIT`.
    #[serde(default)]
    large: bool,
    /// Reads the text in this encoding instead of working it out.
    #[serde(default)]
    encoding: Option<String>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Content {
    Text {
        text: String,
        encoding: String,
        lossy: bool,
        large: bool,
        hash: String,
    },
    Image {
        mime: String,
        data: String,
        hash: String,
    },
    Binary {
        format: String,
    },
    /// Text above `TEXT_LIMIT`, not read until the user asks.
    Large,
    TooLarge,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRead {
    size: Option<u64>,
    modified: Option<u32>,
    #[serde(flatten)]
    content: Content,
}

#[derive(Clone, Copy)]
struct Request<'a> {
    name: &'a str,
    size: Option<u64>,
    large: bool,
    chosen: Option<(&'static Encoding, &'a str)>,
    fallback: (&'static Encoding, &'a str),
}

const fn request<'a>(
    name: &'a str,
    large: bool,
    chosen: Option<(&'static Encoding, &'a str)>,
    fallback: (&'static Encoding, &'a str),
) -> Request<'a> {
    Request {
        name,
        size: None,
        large,
        chosen,
        fallback,
    }
}

struct Loaded {
    content: Content,
    /// False when reading stopped early. An FTP data stream must then be aborted, not finished.
    complete: bool,
}

const fn stopped(content: Content) -> Loaded {
    Loaded {
        content,
        complete: false,
    }
}

fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

async fn load(mut reader: impl AsyncRead + Unpin, request: Request<'_>) -> io::Result<Loaded> {
    let mut data = Vec::new();
    (&mut reader).take(HEAD).read_to_end(&mut data).await?;
    let kind = classify(request.name, &data);
    if let Kind::Binary(format) = kind {
        return Ok(Loaded {
            content: Content::Binary {
                format: format.into(),
            },
            complete: (data.len() as u64) < HEAD,
        });
    }
    if request.size.is_some_and(|size| size > LIMIT) {
        return Ok(stopped(Content::TooLarge));
    }
    let limit = if request.large || matches!(kind, Kind::Image(_)) {
        LIMIT
    } else {
        TEXT_LIMIT
    };
    if request.size.is_some_and(|size| size > limit) {
        return Ok(stopped(Content::Large));
    }
    // Sizes come from a listing that may be old, so the limit also holds for what actually arrives.
    (&mut reader)
        .take(limit + 1 - data.len() as u64)
        .read_to_end(&mut data)
        .await?;
    if data.len() as u64 > limit {
        return Ok(stopped(if limit == LIMIT {
            Content::TooLarge
        } else {
            Content::Large
        }));
    }
    let hash = digest(&data);
    let content = match kind {
        Kind::Image(mime) => Content::Image {
            mime: mime.into(),
            data: base64::engine::general_purpose::STANDARD.encode(&data),
            hash,
        },
        _ => {
            let decoded = decode(&data, request.chosen, request.fallback);
            Content::Text {
                text: decoded.text,
                encoding: decoded.encoding,
                lossy: decoded.lossy,
                large: request.large,
                hash,
            }
        }
    };
    Ok(Loaded {
        content,
        complete: true,
    })
}

fn modified_seconds(metadata: &std::fs::Metadata) -> Option<u32> {
    let elapsed = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    u32::try_from(elapsed.as_secs()).ok()
}

/// The last part of a path as a tab names it. Windows paths use either slash.
fn file_name(path: &str, windows: bool) -> &str {
    let separators: &[char] = if windows { &['/', '\\'] } else { &['/'] };
    path.trim_end_matches(separators)
        .rsplit(separators)
        .next()
        .unwrap_or(path)
}

async fn read_native(native: PathBuf, request: Request<'_>) -> Result<FileRead> {
    let metadata = tokio::fs::metadata(&native)
        .await
        .map_err(|_| "경로를 찾을 수 없습니다.")?;
    // A device or pipe never ends, and a folder has no bytes to show.
    if !metadata.is_file() {
        return Err(NOT_A_FILE.into());
    }
    let file = tokio::fs::File::open(&native)
        .await
        .map_err(|_| "파일을 열 수 없습니다. 권한을 확인하세요.")?;
    let size = Some(metadata.len());
    let loaded = load(file, Request { size, ..request })
        .await
        .map_err(|_| "파일을 읽지 못했습니다.")?;
    Ok(FileRead {
        size,
        modified: modified_seconds(&metadata),
        content: loaded.content,
    })
}

async fn read_sftp(
    connections: &crate::ssh::Connections,
    id: &str,
    path: &str,
    request: Request<'_>,
) -> Result<FileRead> {
    sftp::path(path)?;
    let session = sftp::open(connections, id).await?;
    let attributes = session.metadata(path).await.map_err(sftp::failure)?;
    // Servers may leave the permissions out, and then the file type is unknown, not "other".
    let special = attributes.permissions.is_some() && attributes.file_type().is_other();
    if attributes.is_dir() || special {
        return Err(NOT_A_FILE.into());
    }
    let file = session.open(path).await.map_err(sftp::failure)?;
    let loaded = load(
        file,
        Request {
            size: attributes.size,
            ..request
        },
    )
    .await
    .map_err(sftp::failure)?;
    Ok(FileRead {
        size: attributes.size,
        modified: attributes.mtime,
        content: loaded.content,
    })
}

fn parent_of(path: &str) -> Result<&str> {
    let (parent, _) = path
        .trim_end_matches('/')
        .rsplit_once('/')
        .ok_or("서버 경로를 확인하세요.")?;
    Ok(if parent.is_empty() { "/" } else { parent })
}

async fn read_ftp(session: &ftp::Session, path: &str, request: Request<'_>) -> Result<FileRead> {
    ftp::path(path)?;
    // FTP has no reliable stat, and a listing gives the size, date and type at once.
    let listing = ftp::list(session, parent_of(path)?).await?;
    let entry = listing
        .entries
        .iter()
        .find(|entry| entry.name == request.name)
        .ok_or("경로를 찾을 수 없습니다.")?;
    if entry.directory {
        return Err(NOT_A_FILE.into());
    }
    let (size, modified) = (entry.size, entry.modified);
    let mut stream = session.open().await?;
    let mut input = stream.retr_as_stream(path).await.map_err(|_| FTP_FAILED)?;
    let loaded = load(&mut input, Request { size, ..request })
        .await
        .map_err(|_| FTP_FAILED)?;
    if loaded.complete {
        input.finish().await.map_err(|_| FTP_FAILED)?;
    } else {
        let _ = stream.abort(input).await;
    }
    let _ = stream.quit().await;
    Ok(FileRead {
        size,
        modified,
        content: loaded.content,
    })
}

/// Reads a file for a tab. `file_write` will compare the returned hash before saving (GE.6).
#[tauri::command]
pub async fn file_read(
    state: State<'_, AppState>,
    source: Source,
    path: String,
    options: Option<ReadOptions>,
) -> Result<FileRead> {
    let options = options.unwrap_or_default();
    let chosen = match options.encoding.as_deref() {
        Some(label) => Some((encoding::get(label)?, label)),
        None => None,
    };
    let large = options.large;
    let utf8 = (encoding_rs::UTF_8, "utf-8");
    let reading = async {
        match &source {
            Source::Local { target_id } => {
                let target = state.locals.target(target_id)?;
                let native = local_files::native_path(&target, &path)?;
                let name = file_name(&path, cfg!(windows));
                read_native(native, request(name, large, chosen, utf8)).await
            }
            Source::Ssh { connection_id } => {
                let name = file_name(&path, false);
                let wanted = request(name, large, chosen, utf8);
                read_sftp(&state.connections, connection_id, &path, wanted).await
            }
            Source::Ftp { connection_id } => {
                let session = state.connections.ftp_session(connection_id)?;
                let label = session.profile.encoding.as_str();
                let fallback = (encoding::get(label)?, label);
                let name = file_name(&path, false);
                read_ftp(&session, &path, request(name, large, chosen, fallback)).await
            }
        }
    };
    tokio::time::timeout(READ_TIMEOUT, reading)
        .await
        .map_err(|_| "파일을 읽는 시간이 초과되었습니다.")?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_request(name: &str, large: bool) -> Request<'_> {
        request(name, large, None, (encoding_rs::UTF_8, "utf-8"))
    }
    fn run<T>(future: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(future)
    }
    fn loaded(bytes: Vec<u8>, request: Request<'_>) -> Loaded {
        run(load(bytes.as_slice(), request)).unwrap()
    }
    fn text_of(content: &Content) -> &str {
        match content {
            Content::Text { text, .. } => text,
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn text_is_decoded_and_hashed_over_its_raw_bytes() {
        let result = loaded("한글\n".as_bytes().to_vec(), local_request("a.txt", false));
        assert!(result.complete);
        let Content::Text {
            text,
            encoding,
            lossy,
            large,
            hash,
        } = result.content
        else {
            panic!("expected text");
        };
        assert_eq!(text, "한글\n");
        assert_eq!((encoding.as_str(), lossy, large), ("utf-8", false, false));
        assert_eq!(hash, digest("한글\n".as_bytes()));
        assert_eq!(hash.len(), 64);
    }

    #[test]
    fn text_over_two_mib_asks_first_and_opens_when_agreed() {
        let bytes = vec![b'a'; TEXT_LIMIT as usize + 1];
        let asked = loaded(bytes.clone(), local_request("a.log", false));
        assert_eq!(asked.content, Content::Large);
        assert!(!asked.complete);
        let opened = loaded(bytes, local_request("a.log", true));
        assert_eq!(text_of(&opened.content).len(), TEXT_LIMIT as usize + 1);
        assert!(matches!(opened.content, Content::Text { large: true, .. }));
    }

    #[test]
    fn exactly_two_mib_opens_without_asking() {
        let bytes = vec![b'a'; TEXT_LIMIT as usize];
        let result = loaded(bytes, local_request("a.log", false));
        assert_eq!(text_of(&result.content).len(), TEXT_LIMIT as usize);
    }

    #[test]
    fn nothing_opens_past_the_hard_limit_even_when_agreed() {
        let bytes = vec![b'a'; LIMIT as usize + 1];
        assert_eq!(
            loaded(bytes, local_request("a.log", true)).content,
            Content::TooLarge
        );
    }

    #[test]
    fn a_known_size_refuses_without_reading_the_rest() {
        let request = Request {
            size: Some(LIMIT + 1),
            ..local_request("a.log", true)
        };
        let result = loaded(b"short".to_vec(), request);
        assert_eq!(result.content, Content::TooLarge);
        let request = Request {
            size: Some(TEXT_LIMIT + 1),
            ..local_request("a.log", false)
        };
        assert_eq!(loaded(b"short".to_vec(), request).content, Content::Large);
    }

    #[test]
    fn a_listing_that_understates_the_size_does_not_lift_the_limit() {
        let request = Request {
            size: Some(10),
            ..local_request("a.log", false)
        };
        let bytes = vec![b'a'; TEXT_LIMIT as usize + 1];
        assert_eq!(loaded(bytes, request).content, Content::Large);
    }

    #[test]
    fn images_skip_the_text_limit() {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.resize(TEXT_LIMIT as usize + 100, 0);
        let result = loaded(bytes.clone(), local_request("a.png", false));
        let Content::Image { mime, data, hash } = result.content else {
            panic!("expected an image");
        };
        assert_eq!(mime, "image/png");
        assert_eq!(hash, digest(&bytes));
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(data)
            .unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn binary_files_are_named_and_not_read_further() {
        let mut bytes = vec![0u8; 20 * 1024];
        bytes[..4].copy_from_slice(b"PK\x03\x04");
        let result = loaded(bytes, local_request("a.zip", false));
        assert_eq!(
            result.content,
            Content::Binary {
                format: "ZIP 압축".into()
            }
        );
        assert!(!result.complete);
        let small = loaded(b"\0\x01".to_vec(), local_request("a.bin", false));
        assert!(small.complete);
    }

    #[test]
    fn an_empty_file_is_empty_text() {
        let result = loaded(Vec::new(), local_request("a.txt", false));
        assert_eq!(text_of(&result.content), "");
    }

    #[test]
    fn local_folders_are_refused_and_files_are_read() {
        let folder = std::env::temp_dir().join(format!("file-read-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder).unwrap();
        let file = folder.join("note.txt");
        std::fs::write(&file, "내용").unwrap();
        let result = run(read_native(file.clone(), local_request("note.txt", false))).unwrap();
        assert_eq!(result.size, Some(6));
        assert!(result.modified.is_some());
        assert_eq!(text_of(&result.content), "내용");
        let refused = run(read_native(folder.clone(), local_request("x", false)));
        assert_eq!(refused.err().as_deref(), Some(NOT_A_FILE));
        let missing = run(read_native(
            folder.join("없음"),
            local_request("없음", false),
        ));
        assert_eq!(missing.err().as_deref(), Some("경로를 찾을 수 없습니다."));
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn names_and_parents_come_from_the_path() {
        assert_eq!(file_name("/srv/app/a.txt", false), "a.txt");
        assert_eq!(file_name("C:\\work\\b.md", true), "b.md");
        assert_eq!(file_name("C:\\work/sub/c.md", true), "c.md");
        // A backslash is an ordinary character in a server's file name.
        assert_eq!(file_name("/srv/a\\b.txt", false), "a\\b.txt");
        assert_eq!(parent_of("/srv/app/a.txt").unwrap(), "/srv/app");
        assert_eq!(parent_of("/a.txt").unwrap(), "/");
        assert!(parent_of("a.txt").is_err());
    }

    #[test]
    fn the_response_is_flat_and_tagged_for_the_window() {
        let value = serde_json::to_value(FileRead {
            size: Some(3),
            modified: None,
            content: Content::Binary {
                format: "바이너리".into(),
            },
        })
        .unwrap();
        assert_eq!(value["kind"], "binary");
        assert_eq!(value["size"], 3);
        assert_eq!(value["format"], "바이너리");
        let large = serde_json::to_value(FileRead {
            size: None,
            modified: None,
            content: Content::TooLarge,
        })
        .unwrap();
        assert_eq!(large["kind"], "tooLarge");
    }
}
