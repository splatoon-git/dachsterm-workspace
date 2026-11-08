//! Saving a file tab, to any source. Each source follows the same order: encode first so a character
//! that cannot be written stops the save before anything is touched, stage the bytes beside the file
//! under the `.dachsterm-*` name, compare the file with what the user read at the last moment, and
//! only then replace it.
use crate::{
    AppState, encoding,
    file_read::{LIMIT, digest},
    source::Source,
    storage::Result,
};
use serde::Serialize;
use std::time::Duration;
use tauri::State;
use tokio::io::{AsyncRead, AsyncReadExt};

mod local;
mod remote;

const WRITE_TIMEOUT: Duration = Duration::from_secs(120);
const TIMED_OUT: &str = "파일을 저장하는 시간이 초과되었습니다.";
const NOT_A_FILE: &str = "파일이 아니어서 저장할 수 없습니다.";
const NOT_WRITABLE: &str = "이 파일을 쓸 권한이 없습니다.";

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Outcome {
    /// The file now holds these bytes. `notice` is something left over that the user should know.
    Saved {
        hash: String,
        notice: Option<String>,
    },
    /// Nothing was written. `hash` is what the file holds now, `None` when there is no such file.
    /// Saving again with this as the base overwrites exactly the version the user was warned about.
    Conflict { hash: Option<String> },
}

fn saved(wire: &[u8], notice: Option<String>) -> Outcome {
    Outcome::Saved {
        hash: digest(wire),
        notice,
    }
}

/// `base` is the hash the user last read, or `None` for a new file that must not exist yet.
fn conflict(current: Option<&[u8]>, base: Option<&str>) -> Option<Outcome> {
    let hash = current.map(digest);
    (hash.as_deref() != base).then_some(Outcome::Conflict { hash })
}

/// Reads no further than a tab can hold: a longer file cannot match a base hash anyway, and its
/// hash over this part stays the same when the user chooses to overwrite it.
async fn current_bytes(mut reader: impl AsyncRead + Unpin) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    (&mut reader)
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .await?;
    Ok(bytes)
}

/// Saves a file tab. Returns the new hash, or the conflict that stopped it (GE.6).
#[tauri::command]
pub async fn file_write(
    state: State<'_, AppState>,
    source: Source,
    path: String,
    content: String,
    encoding: String,
    base_hash: Option<String>,
) -> Result<Outcome> {
    let wire = encoding::encode_text(&content, &encoding)?;
    drop(content);
    if wire.len() as u64 > LIMIT {
        return Err("탭에서는 32MiB까지 저장할 수 있습니다.".into());
    }
    let base = base_hash.as_deref();
    match &source {
        Source::Local { target_id } => {
            let target = state.locals.target(target_id)?;
            local::write(&target, &path, &wire, base).await
        }
        Source::Ssh { connection_id } => {
            remote::write_sftp(&state.connections, connection_id, &path, &wire, base).await
        }
        Source::Ftp { connection_id } => {
            let session = state.connections.ftp_session(connection_id)?;
            remote::write_ftp(&session, &path, &wire, base).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_save_goes_ahead_only_on_the_version_the_user_read() {
        let bytes = b"same";
        let hash = digest(bytes);
        assert_eq!(conflict(Some(bytes), Some(&hash)), None);
        assert_eq!(conflict(None, None), None);
        assert_eq!(
            conflict(Some(b"other"), Some(&hash)),
            Some(Outcome::Conflict {
                hash: Some(digest(b"other"))
            })
        );
    }

    #[test]
    fn a_vanished_file_and_a_taken_name_are_both_conflicts() {
        assert_eq!(
            conflict(None, Some("abc")),
            Some(Outcome::Conflict { hash: None })
        );
        assert_eq!(
            conflict(Some(b"there"), None),
            Some(Outcome::Conflict {
                hash: Some(digest(b"there"))
            })
        );
    }

    #[test]
    fn the_hash_a_conflict_reports_lets_the_next_save_overwrite_it() {
        let Some(Outcome::Conflict { hash }) = conflict(Some(b"theirs"), Some("old")) else {
            panic!("expected a conflict");
        };
        assert_eq!(conflict(Some(b"theirs"), hash.as_deref()), None);
    }

    #[test]
    fn the_response_is_tagged_for_the_window() {
        let value = serde_json::to_value(saved(b"a", None)).unwrap();
        assert_eq!(value["status"], "saved");
        assert_eq!(value["hash"], digest(b"a"));
        assert!(value["notice"].is_null());
        let value = serde_json::to_value(Outcome::Conflict { hash: None }).unwrap();
        assert_eq!(value["status"], "conflict");
        assert!(value["hash"].is_null());
    }

    #[test]
    fn current_bytes_stop_past_the_limit() {
        let bytes = vec![b'a'; LIMIT as usize + 100];
        let read = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(current_bytes(bytes.as_slice()))
            .unwrap();
        assert_eq!(read.len() as u64, LIMIT + 1);
    }
}
