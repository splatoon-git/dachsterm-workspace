use crate::{ssh::Connections, storage::Result};
use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, OpenFlags},
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

pub fn path(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > 4096 || value.contains('\0') || value.contains('\u{fffd}')
    {
        return Err("경로가 올바르지 않습니다.".into());
    }
    Ok(())
}
pub fn failure(e: impl std::fmt::Display) -> String {
    format!("SFTP 작업 실패: {e}")
}
pub async fn open(connections: &Connections, id: &str) -> Result<SftpSession> {
    let handle = connections.handle(id)?;
    tokio::time::timeout(Duration::from_secs(15), async {
        let channel = handle.channel_open_session().await.map_err(failure)?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(failure)?;
        SftpSession::new(channel.into_stream())
            .await
            .map_err(failure)
    })
    .await
    .map_err(|_| "SFTP 연결 시간 초과")?
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub directory: bool,
    pub symlink: bool,
    pub size: Option<u64>,
    pub modified: Option<u32>,
    pub permissions: Option<u32>,
}
#[derive(Serialize)]
pub struct Listing {
    pub path: String,
    pub entries: Vec<Entry>,
}
pub async fn list(connections: &Connections, id: &str, directory: &str) -> Result<Listing> {
    path(directory)?;
    let h = connections.handle(id)?;
    tokio::time::timeout(Duration::from_secs(20),async {
        let channel=h.channel_open_session().await.map_err(failure)?;
        channel.request_subsystem(true,"sftp").await.map_err(failure)?;
        let raw=russh_sftp::client::RawSftpSession::new(channel.into_stream());raw.init().await.map_err(failure)?;
        let canonical=raw.realpath(directory).await.map_err(failure)?;
        let directory=canonical.files.first().ok_or("원격 경로 없음")?.filename.clone();path(&directory)?;
        let handle=raw.opendir(directory.clone()).await.map_err(failure)?.handle;
        let mut entries=Vec::new();
        loop {
            match raw.readdir(&handle).await {
                Ok(packet)=>{
                    for file in packet.files {
                        if matches!(file.filename.as_str(),"."|".."){continue;}
                        if file.filename.contains('\u{fffd}') || file.filename.contains('/') {return Err("UTF-8이 아닌 파일 이름이 감지되었습니다. 이 서버의 파일명 인코딩을 UTF-8로 변환한 뒤 사용하세요. 잘못된 이름으로 파일을 변경하지 않습니다.".into());}
                        let m=file.attrs;
                        entries.push(Entry{name:file.filename,directory:m.file_type().is_dir(),symlink:m.file_type().is_symlink(),size:m.size,modified:m.mtime,permissions:m.permissions});
                        if entries.len()>20000{return Err("폴더 항목이 20,000개를 초과했습니다. 하위 폴더 경로로 이동하세요.".into());}
                    }
                },
                Err(russh_sftp::client::error::Error::Status(status)) if status.status_code==russh_sftp::protocol::StatusCode::Eof=>break,
                Err(e)=>return Err(failure(e))
            }
        }
        raw.close(handle).await.map_err(failure)?;
        entries.sort_by(|a,b|b.directory.cmp(&a.directory).then(a.name.cmp(&b.name)));
        Ok(Listing{path:directory,entries})
    }).await.map_err(|_|"디렉터리 목록 시간 초과")?
}

pub async fn change(
    connections: &Connections,
    id: &str,
    operation: &str,
    target: &str,
    value: &str,
) -> Result<()> {
    path(target)?;
    let s = open(connections, id).await?;
    match operation {
        "newfile" => {
            let mut file = s
                .open_with_flags_and_attributes(
                    target,
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                    FileAttributes {
                        permissions: Some(0o600),
                        ..Default::default()
                    },
                )
                .await
                .map_err(failure)?;
            file.shutdown().await.map_err(failure)?;
            return Ok(());
        }
        "mkdir" => s.create_dir(target).await,
        "rename" => {
            path(value)?;
            s.rename(target, value).await
        }
        "delete" => s.remove_file(target).await,
        "rmdir" => s.remove_dir(target).await,
        "chmod" => {
            let mode = u32::from_str_radix(value, 8).map_err(|_| "8진수 권한을 입력하세요.")?;
            if mode > 0o777 {
                return Err("권한은 000~777 범위입니다.".into());
            }
            s.set_metadata(
                target,
                FileAttributes {
                    permissions: Some(mode),
                    ..Default::default()
                },
            )
            .await
        }
        _ => return Err("지원하지 않는 파일 작업".into()),
    }
    .map_err(failure)
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub connection_id: String,
    pub profile_id: String,
    pub name: String,
    pub direction: String,
    pub done: u64,
    pub total: u64,
    pub status: String,
    pub message: String,
    #[serde(default)]
    pub files: usize,
    #[serde(default)]
    pub finished: usize,
    #[serde(default)]
    pub skipped: usize,
    #[serde(default)]
    pub current: String,
    #[serde(default)]
    pub current_done: u64,
    #[serde(default)]
    pub current_total: u64,
    #[serde(default)]
    pub conflict: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub(crate) struct Source {
    pub(crate) size: u64,
    pub(crate) modified: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Plan {
    pub(crate) view: Transfer,
    pub(crate) local: PathBuf,
    pub(crate) remote: String,
    pub(crate) upload: bool,
    pub(crate) destination: String,
    pub(crate) source: Option<Source>,
}
pub use crate::transfer_queue::Transfers;
pub(crate) async fn source(s: &SftpSession, plan: &Plan) -> Result<Source> {
    if plan.upload {
        let m = tokio::fs::metadata(&plan.local).await.map_err(failure)?;
        if !m.is_file() {
            return Err("일반 파일만 전송할 수 있습니다.".into());
        }
        let modified = m
            .modified()
            .map_err(failure)?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(failure)?
            .as_nanos()
            .to_string();
        Ok(Source {
            size: m.len(),
            modified,
        })
    } else {
        let m = s.symlink_metadata(&plan.remote).await.map_err(failure)?;
        if !m.file_type().is_file() {
            return Err("일반 파일만 내려받을 수 있습니다.".into());
        }
        Ok(Source {
            size: m.size.ok_or("원격 파일 크기 없음")?,
            modified: m.mtime.ok_or("원격 수정 시각 없음")?.to_string(),
        })
    }
}
pub(crate) async fn prefix<A: tokio::io::AsyncRead + Unpin, B: tokio::io::AsyncRead + Unpin>(
    a: &mut A,
    b: &mut B,
    length: u64,
) -> Result<()> {
    let mut left = length;
    let mut x = vec![0; 65536];
    let mut y = vec![0; 65536];
    while left > 0 {
        let n = left.min(65536) as usize;
        a.read_exact(&mut x[..n]).await.map_err(failure)?;
        b.read_exact(&mut y[..n]).await.map_err(failure)?;
        if x[..n] != y[..n] {
            return Err("부분 파일의 내용이 원본과 다릅니다. 이어쓰기를 거부했습니다.".into());
        }
        left -= n as u64;
    }
    Ok(())
}
pub(crate) async fn resumed(
    s: &SftpSession,
    plan: &Plan,
    progress: impl Fn(u64, u64),
    committing: &std::sync::atomic::AtomicBool,
) -> Result<()> {
    let original = plan.source.as_ref().ok_or("원본 정보 없음")?;
    let total = original.size;
    let mut buffer = vec![0; 65536];
    if plan.upload {
        if s.symlink_metadata(&plan.remote).await.is_ok() {
            return Err("대상 파일이 이미 있습니다. 기존 파일에는 이어쓰지 않습니다.".into());
        }
        let temp = format!("{}.dachsterm-{}.part", plan.remote, plan.view.id);
        let existing = s.symlink_metadata(&temp).await;
        let offset = match existing {
            Ok(m) => {
                if !m.file_type().is_file() {
                    return Err("부분 파일이 일반 파일이 아닙니다.".into());
                }
                m.size.ok_or("부분 파일 크기 없음")?
            }
            Err(russh_sftp::client::error::Error::Status(status))
                if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile =>
            {
                0
            }
            Err(e) => return Err(failure(e)),
        };
        if offset > total {
            return Err("부분 파일이 원본보다 큽니다.".into());
        }
        let mut input = tokio::fs::File::open(&plan.local).await.map_err(failure)?;
        let exists = s.symlink_metadata(&temp).await.is_ok();
        if exists {
            let mut check = s.open(&temp).await.map_err(failure)?;
            prefix(&mut input, &mut check, offset).await?;
        }
        let mut output = s
            .open_with_flags_and_attributes(
                &temp,
                if exists {
                    OpenFlags::WRITE
                } else {
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE
                },
                FileAttributes {
                    permissions: Some(0o600),
                    ..Default::default()
                },
            )
            .await
            .map_err(failure)?;
        output
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(failure)?;
        let mut done = offset;
        progress(done, total);
        while done < total {
            let amount = (total - done).min(buffer.len() as u64) as usize;
            let n = input.read(&mut buffer[..amount]).await.map_err(failure)?;
            if n == 0 {
                return Err("전송 중 원본이 짧아졌습니다.".into());
            }
            output.write_all(&buffer[..n]).await.map_err(failure)?;
            done += n as u64;
            progress(done, total);
        }
        output.shutdown().await.map_err(failure)?;
        if &source(s, plan).await? != original {
            return Err("전송 중 원본 변경 · 부분 파일 보존됨".into());
        }
        committing.store(true, std::sync::atomic::Ordering::SeqCst);
        s.rename(&temp, &plan.remote).await.map_err(failure)?;
    } else {
        if tokio::fs::symlink_metadata(&plan.local).await.is_ok() {
            return Err("로컬 대상이 이미 있습니다. 다른 이름을 선택하세요.".into());
        }
        let temp = plan
            .local
            .with_file_name(format!(".dachsterm-{}.part", plan.view.id));
        let exists = tokio::fs::symlink_metadata(&temp).await;
        let offset = match &exists {
            Ok(m) => {
                if !m.is_file() {
                    return Err("부분 파일이 일반 파일이 아닙니다.".into());
                }
                m.len()
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
            Err(e) => return Err(failure(e)),
        };
        if offset > total {
            return Err("부분 파일이 원본보다 큽니다.".into());
        }
        let mut input = s.open(&plan.remote).await.map_err(failure)?;
        if exists.is_ok() {
            let mut check = tokio::fs::File::open(&temp).await.map_err(failure)?;
            prefix(&mut input, &mut check, offset).await?;
        }
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true);
        if exists.is_err() {
            options.create_new(true);
        }
        #[cfg(unix)]
        {
            options.mode(0o600);
        }
        let mut output = options.open(&temp).await.map_err(failure)?;
        output
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(failure)?;
        let mut done = offset;
        progress(done, total);
        while done < total {
            let amount = (total - done).min(buffer.len() as u64) as usize;
            let n = input.read(&mut buffer[..amount]).await.map_err(failure)?;
            if n == 0 {
                return Err("원격 원본이 짧아졌습니다.".into());
            }
            output.write_all(&buffer[..n]).await.map_err(failure)?;
            done += n as u64;
            progress(done, total);
        }
        output.sync_all().await.map_err(failure)?;
        drop(output);
        if &source(s, plan).await? != original {
            return Err("전송 중 원격 원본 변경 · 부분 파일 보존됨".into());
        }
        committing.store(true, std::sync::atomic::Ordering::SeqCst);
        tokio::fs::hard_link(&temp, &plan.local)
            .await
            .map_err(|_| "로컬 파일을 덮어쓰지 않고 완료할 수 없습니다.")?;
        tokio::fs::remove_file(temp).await.map_err(failure)?;
    }
    Ok(())
}

pub async fn transfer(
    s: &SftpSession,
    remote: &str,
    local: &Path,
    remote_temp: &str,
    local_temp: &Path,
    upload: bool,
    progress: impl Fn(u64, u64),
) -> Result<()> {
    let mut buffer = vec![0; 65536];
    let mut done = 0;
    if upload {
        if s.try_exists(remote).await.map_err(failure)? {
            return Err("대상 파일이 이미 있습니다. 이름을 변경한 후 전송하세요.".into());
        }
        let mut source = tokio::fs::File::open(local).await.map_err(failure)?;
        let total = source.metadata().await.map_err(failure)?.len();
        let mut dest = s
            .open_with_flags_and_attributes(
                remote_temp,
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
                FileAttributes {
                    permissions: Some(0o600),
                    ..Default::default()
                },
            )
            .await
            .map_err(failure)?;
        loop {
            let n = source.read(&mut buffer).await.map_err(failure)?;
            if n == 0 {
                break;
            }
            dest.write_all(&buffer[..n]).await.map_err(failure)?;
            done += n as u64;
            progress(done, total);
        }
        dest.flush().await.map_err(failure)?;
        dest.shutdown().await.map_err(failure)?;
        s.rename(remote_temp, remote).await.map_err(failure)?;
    } else {
        let mut source = s.open(remote).await.map_err(failure)?;
        let total = s.metadata(remote).await.map_err(failure)?.size.unwrap_or(0);
        let mut dest = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(local_temp)
            .await
            .map_err(failure)?;
        loop {
            let n = source.read(&mut buffer).await.map_err(failure)?;
            if n == 0 {
                break;
            }
            dest.write_all(&buffer[..n]).await.map_err(failure)?;
            done += n as u64;
            progress(done, total);
        }
        dest.sync_all().await.map_err(failure)?;
        drop(dest);
        // Hard link is an atomic no-replace commit on the same local filesystem.
        tokio::fs::hard_link(local_temp, local)
            .await
            .map_err(|_| "로컬 대상이 이미 있거나 저장할 수 없습니다.".to_string())?;
        tokio::fs::remove_file(local_temp).await.map_err(failure)?;
    }
    Ok(())
}
