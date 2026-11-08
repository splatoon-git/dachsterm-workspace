//! Saving to a server. SFTP replaces the file in one step (`atomic_replace`). FTP has no such step,
//! so it moves the old file aside first, as uploads that overwrite do (`transfer_queue.rs`).
use super::{NOT_A_FILE, NOT_WRITABLE, Outcome, TIMED_OUT, WRITE_TIMEOUT, conflict, saved};
use crate::{
    editor::atomic_replace,
    file_read::{file_name, parent_of},
    ftp,
    sftp::{self, Entry},
    ssh::Connections,
    storage::Result,
};
use russh_sftp::{
    client::{SftpSession, error::Error as SftpError},
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use std::time::Duration;
use tokio::{io::AsyncWriteExt, time::timeout};

const CLEANUP_TIMEOUT: Duration = Duration::from_secs(5);
const STEP_TIMEOUT: Duration = Duration::from_secs(30);
const FTP_FAILED: &str = "FTP 서버에 파일을 저장하지 못했습니다. 권한과 연결 상태를 확인하세요.";
const FTP_LINK: &str = "FTP의 링크는 저장할 수 없습니다. 링크가 가리키는 파일을 여세요.";

fn stage_name(target: &str) -> String {
    format!("{target}.dachsterm-{}.part", uuid::Uuid::new_v4())
}

fn missing(error: &SftpError) -> bool {
    matches!(error, SftpError::Status(status) if status.status_code == StatusCode::NoSuchFile)
}

/// A link is followed, because replacing it would leave a plain file where the link was.
async fn sftp_target(
    session: &SftpSession,
    path: &str,
) -> Result<(String, Option<FileAttributes>)> {
    let own = match session.symlink_metadata(path).await {
        Ok(attributes) => attributes,
        Err(error) if missing(&error) => return Ok((path.to_string(), None)),
        Err(error) => return Err(sftp::failure(error)),
    };
    let real = if own.file_type().is_symlink() {
        let real = session
            .canonicalize(path)
            .await
            .map_err(|_| "링크가 가리키는 파일을 찾지 못해 저장하지 않았습니다.")?;
        sftp::path(&real)?;
        real
    } else {
        path.to_string()
    };
    let attributes = session.metadata(&real).await.map_err(sftp::failure)?;
    // Servers may leave the permissions out, and then the file type is unknown, not "other".
    let special = attributes.permissions.is_some() && attributes.file_type().is_other();
    if attributes.is_dir() || special {
        return Err(NOT_A_FILE.into());
    }
    Ok((real, Some(attributes)))
}

async fn sftp_current(session: &SftpSession, target: &str) -> Result<Option<Vec<u8>>> {
    let file = match session.open(target).await {
        Ok(file) => file,
        Err(error) if missing(&error) => return Ok(None),
        Err(error) => return Err(sftp::failure(error)),
    };
    super::current_bytes(file)
        .await
        .map(Some)
        .map_err(sftp::failure)
}

struct SftpSave<'a> {
    connections: &'a Connections,
    id: &'a str,
    session: &'a SftpSession,
    target: &'a str,
    temp: &'a str,
    wire: &'a [u8],
    base: Option<&'a str>,
}

impl SftpSave<'_> {
    async fn stage(&self, before: Option<&FileAttributes>) -> Result<()> {
        // A file that already exists stays private until it has the original's permissions. A new
        // one takes the server's default for new files.
        let attributes = FileAttributes {
            permissions: before.map(|_| 0o600),
            ..Default::default()
        };
        let mut file = self
            .session
            .open_with_flags_and_attributes(
                self.temp,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                attributes,
            )
            .await
            .map_err(sftp::failure)?;
        file.write_all(self.wire).await.map_err(sftp::failure)?;
        file.shutdown().await.map_err(sftp::failure)
    }

    /// The owner can only be kept by a privileged login, so failing to is not a reason to stop.
    async fn copy_attributes(&self, before: &FileAttributes) -> Result<()> {
        self.session
            .set_metadata(
                self.temp,
                FileAttributes {
                    permissions: before.permissions.map(|mode| mode & 0o777),
                    ..Default::default()
                },
            )
            .await
            .map_err(sftp::failure)?;
        if before.uid.is_some() && before.gid.is_some() {
            let owner = FileAttributes {
                uid: before.uid,
                gid: before.gid,
                ..Default::default()
            };
            let _ = self.session.set_metadata(self.temp, owner).await;
        }
        Ok(())
    }

    async fn run(&self, before: Option<&FileAttributes>) -> Result<Outcome> {
        if before.is_some() {
            // Replacing needs only the folder's permission, which would ignore a read-only file.
            let probe = self
                .session
                .open_with_flags(self.target, OpenFlags::WRITE)
                .await
                .map_err(|_| NOT_WRITABLE)?;
            drop(probe);
        }
        self.stage(before).await?;
        let current = sftp_current(self.session, self.target).await?;
        if let Some(found) = conflict(current.as_deref(), self.base) {
            return Ok(found);
        }
        if let Some(attributes) = before {
            self.copy_attributes(attributes).await?;
        }
        if current.is_some() {
            atomic_replace(self.connections, self.id, self.temp, self.target).await?;
        } else {
            // SFTP's plain rename refuses an existing name, which is what a new file wants.
            self.session
                .rename(self.temp, self.target)
                .await
                .map_err(sftp::failure)?;
        }
        Ok(saved(self.wire, None))
    }
}

pub(super) async fn write_sftp(
    connections: &Connections,
    id: &str,
    path: &str,
    wire: &[u8],
    base: Option<&str>,
) -> Result<Outcome> {
    sftp::path(path)?;
    let session = sftp::open(connections, id).await?;
    let (target, before) = timeout(WRITE_TIMEOUT, sftp_target(&session, path))
        .await
        .map_err(|_| TIMED_OUT)??;
    let temp = stage_name(&target);
    let save = SftpSave {
        connections,
        id,
        session: &session,
        target: &target,
        temp: &temp,
        wire,
        base,
    };
    let result = timeout(WRITE_TIMEOUT, save.run(before.as_ref()))
        .await
        .unwrap_or_else(|_| Err(TIMED_OUT.into()));
    if !matches!(result, Ok(Outcome::Saved { .. })) {
        let _ = timeout(CLEANUP_TIMEOUT, session.remove_file(&temp)).await;
    }
    result
}

async fn ftp_entry(session: &ftp::Session, path: &str) -> Result<Option<Entry>> {
    let listing = ftp::list(session, parent_of(path)?).await?;
    let name = file_name(path, false);
    let entry = listing.entries.into_iter().find(|entry| entry.name == name);
    if entry.as_ref().is_some_and(|entry| entry.symlink) {
        return Err(FTP_LINK.into());
    }
    if entry.as_ref().is_some_and(|entry| entry.directory) {
        return Err(NOT_A_FILE.into());
    }
    Ok(entry)
}

async fn ftp_stage(stream: &mut ftp::Stream, temp: &str, wire: &[u8]) -> Result<()> {
    let mut output = stream.put_with_stream(temp).await.map_err(|_| FTP_FAILED)?;
    output.write_all(wire).await.map_err(|_| FTP_FAILED)?;
    output.flush().await.map_err(|_| FTP_FAILED)?;
    output.finish().await.map_err(|_| FTP_FAILED)?;
    // A cut connection can look like a finished upload. Servers without SIZE simply skip the check.
    if let Ok(size) = stream.size(temp).await
        && size as u64 != wire.len() as u64
    {
        return Err("FTP 업로드 크기가 맞지 않아 저장하지 않았습니다.".into());
    }
    Ok(())
}

async fn ftp_current(stream: &mut ftp::Stream, path: &str) -> Result<Vec<u8>> {
    let mut input = stream.retr_as_stream(path).await.map_err(|_| FTP_FAILED)?;
    let bytes = super::current_bytes(&mut input)
        .await
        .map_err(|_| FTP_FAILED)?;
    if (bytes.len() as u64) > crate::file_read::LIMIT {
        let _ = stream.abort(input).await;
    } else {
        input.finish().await.map_err(|_| FTP_FAILED)?;
    }
    Ok(bytes)
}

/// Moves the staged file into place. Each step has its own limit, so a stalled server can never
/// leave this waiting with the original moved aside and nothing said about it.
async fn ftp_commit(
    stream: &mut ftp::Stream,
    temp: &str,
    target: &str,
    existed: bool,
) -> Result<Option<String>> {
    if !existed {
        return match timeout(STEP_TIMEOUT, stream.rename(temp, target)).await {
            Ok(Ok(())) => Ok(None),
            _ => Err(FTP_FAILED.into()),
        };
    }
    let backup = format!("{target}.dachsterm-{}.backup", uuid::Uuid::new_v4());
    match timeout(STEP_TIMEOUT, stream.rename(target, &backup)).await {
        Ok(Ok(())) => {}
        _ => return Err("FTP 기존 파일을 옮기지 못했습니다 · 기존 파일은 유지됩니다.".into()),
    }
    if !matches!(
        timeout(STEP_TIMEOUT, stream.rename(temp, target)).await,
        Ok(Ok(()))
    ) {
        return match timeout(STEP_TIMEOUT, stream.rename(backup.as_str(), target)).await {
            Ok(Ok(())) => Err("FTP 교체 실패 · 기존 파일은 복원했습니다.".into()),
            _ => Err(format!(
                "FTP 교체 실패 · 기존 파일이 {backup}에 남아 있습니다."
            )),
        };
    }
    Ok(match timeout(STEP_TIMEOUT, stream.rm(&backup)).await {
        Ok(Ok(())) => None,
        _ => Some(format!(
            "저장했지만 기존 파일 백업 {backup}을 지우지 못했습니다."
        )),
    })
}

async fn ftp_run(
    session: &ftp::Session,
    stream: &mut ftp::Stream,
    target: &str,
    temp: &str,
    wire: &[u8],
    base: Option<&str>,
) -> Result<Outcome> {
    let before = ftp_entry(session, target).await?;
    ftp_stage(stream, temp, wire).await?;
    // Listed again here: this is the last look before the file is replaced.
    let now = ftp_entry(session, target).await?;
    let current = match &now {
        Some(_) => Some(ftp_current(stream, target).await?),
        None => None,
    };
    if let Some(found) = conflict(current.as_deref(), base) {
        return Ok(found);
    }
    if let Some(mode) = before.and_then(|entry| entry.permissions) {
        // Servers without SITE CHMOD give a new file their default permissions.
        let _ = stream
            .site(format!("CHMOD {:o} {temp}", mode & 0o777))
            .await;
    }
    let notice = ftp_commit(stream, temp, target, current.is_some()).await?;
    Ok(saved(wire, notice))
}

pub(super) async fn write_ftp(
    session: &ftp::Session,
    path: &str,
    wire: &[u8],
    base: Option<&str>,
) -> Result<Outcome> {
    ftp::path(path)?;
    let temp = stage_name(path);
    let mut stream = session.open().await?;
    let result = timeout(
        WRITE_TIMEOUT,
        ftp_run(session, &mut stream, path, &temp, wire, base),
    )
    .await
    .unwrap_or_else(|_| Err(TIMED_OUT.into()));
    if !matches!(result, Ok(Outcome::Saved { .. })) {
        // The stream may be the thing that stalled. A failed commit already moved the file back.
        let cleanup = async {
            let mut fresh = session.open().await?;
            let _ = fresh.rm(&temp).await;
            let _ = fresh.quit().await;
            Ok::<(), String>(())
        };
        let _ = timeout(CLEANUP_TIMEOUT, cleanup).await;
    }
    let _ = timeout(CLEANUP_TIMEOUT, stream.quit()).await;
    result
}
