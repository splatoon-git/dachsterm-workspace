use crate::{
    sftp::{Entry, Listing},
    storage::{Profile, Result},
};
use std::{sync::Arc, time::Duration};
use suppaftp::{
    Status,
    tokio::{AsyncRustlsConnector, AsyncRustlsFtpStream},
    types::FileType,
};
use tokio::{io::AsyncReadExt, sync::watch};
use zeroize::Zeroizing;
pub type Stream = AsyncRustlsFtpStream;
pub struct Session {
    pub profile: Profile,
    secret: Zeroizing<String>,
}
#[derive(Debug)]
struct Encoding(String);
impl suppaftp::Encoding for Encoding {
    fn encode(&self, text: &str) -> std::io::Result<Vec<u8>> {
        crate::encoding::encode(text, &self.0).map_err(std::io::Error::other)
    }
    fn decode(&self, bytes: &[u8]) -> String {
        crate::encoding::get(&self.0)
            .expect("validated encoding")
            .decode_without_bom_handling(bytes)
            .0
            .into_owned()
    }
}
fn protocol_failure(error: suppaftp::FtpError) -> String {
    protocol_details(&error)
}
fn protocol_details(error: &suppaftp::FtpError) -> String {
    let category = match error {
        suppaftp::FtpError::ConnectionError(e) => format!("연결 {:?}", e.kind()),
        suppaftp::FtpError::UnexpectedResponse(r) => format!("서버 응답 {}", r.status as u32),
        suppaftp::FtpError::SecureError(_) => "TLS".into(),
        _ => "프로토콜".into(),
    };
    format!("FTP 작업 실패 ({category}). 서버 지원 명령·접근 권한·연결 상태를 확인하세요.")
}
fn failure(error: impl std::error::Error + 'static) -> String {
    let error = &error as &dyn std::error::Error;
    if let Some(error) = error.downcast_ref::<suppaftp::FtpError>() {
        return protocol_details(error);
    }
    if let Some(error) = error.downcast_ref::<std::io::Error>() {
        return format!("FTP 입출력 실패 ({:?})", error.kind());
    }
    "FTP 작업 실패. 연결 상태를 확인하세요.".into()
}
pub fn path(value: &str) -> Result<()> {
    crate::sftp::path(value)?;
    if value.contains(['\r', '\n']) {
        return Err("FTP 경로에는 줄바꿈을 사용할 수 없습니다.".into());
    }
    Ok(())
}
impl Session {
    pub async fn open(&self) -> Result<Stream> {
        tokio::time::timeout(Duration::from_secs(self.profile.timeout),async {
            let mut ftp=Stream::connect((self.profile.host.as_str(),self.profile.port)).await.map_err(failure)?;
            ftp.set_passive_nat_workaround(true); // Data peer must be the control peer, never the supplied PASV host.
            if self.profile.protocol=="ftps" {
                let mut roots=suppaftp::tokio_rustls::rustls::RootCertStore::empty();
                let native=tokio::task::spawn_blocking(rustls_native_certs::load_native_certs).await.map_err(failure)?;
                roots.add_parsable_certificates(native.certs);
                if !self.profile.tls_ca_path.is_empty(){
                    let file=tokio::fs::File::open(&self.profile.tls_ca_path).await.map_err(|_|"TLS CA 파일을 읽을 수 없습니다.")?;
                    let mut cert=Vec::new();file.take(1024*1024+1).read_to_end(&mut cert).await.map_err(failure)?;
                    if cert.len()>1024*1024{return Err("TLS CA 파일이 너무 큽니다.".into());}
                    use suppaftp::tokio_rustls::rustls::pki_types::{CertificateDer, pem::PemObject};
                    let certificates=CertificateDer::pem_slice_iter(&cert).collect::<std::result::Result<Vec<_>,_>>().map_err(|_|"TLS CA 인증서 형식 오류")?;
                    if certificates.is_empty(){return Err("TLS CA 인증서가 없습니다.".into());}
                    for certificate in certificates {roots.add(certificate).map_err(|_|"TLS CA 인증서 형식 오류")?;}
                }
                if roots.is_empty(){return Err("신뢰할 TLS CA 인증서를 불러오지 못했습니다.".into());}
                let config=suppaftp::tokio_rustls::rustls::ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
                let connector=suppaftp::tokio_rustls::TlsConnector::from(Arc::new(config));
                ftp=ftp.into_secure(AsyncRustlsConnector::from(connector),&self.profile.host).await.map_err(|_|"FTPS 인증서 또는 TLS 연결 검증 실패. 암호화되지 않은 연결로 전환하지 않습니다.")?;
            }
            ftp.set_encoding(Encoding(self.profile.encoding.clone())).await;
            ftp.login(self.profile.username.as_str(),self.secret.as_str()).await.map_err(|_|"FTP 인증이 거부되었습니다.")?;
            ftp.transfer_type(FileType::Binary).await.map_err(failure)?;
            let _=ftp.opts("UTF8",Some(if self.profile.encoding=="utf-8"{"ON"}else{"OFF"})).await;
            Ok(ftp)
        }).await.map_err(|_|"FTP 연결 시간이 초과되었습니다.")?
    }
}
pub async fn run(
    manager: Arc<crate::ssh::Connections>,
    id: String,
    profile: Profile,
    secret: Zeroizing<String>,
    sink: crate::ssh::Sink,
    mut stop: watch::Receiver<bool>,
    store: Arc<crate::storage::Store>,
) -> Result<()> {
    let session = Arc::new(Session {
        profile: profile.clone(),
        secret,
    });
    let mut ftp = session.open().await?;
    manager.ftp.lock().unwrap().insert(id.clone(), session);
    store.touch(&profile.id)?;
    sink(crate::ssh::Event::State {
        status: "connected".into(),
        message: if profile.protocol == "ftps" {
            "FTPS 연결됨 · TLS 보호"
        } else {
            "FTP 연결됨 · 암호화되지 않은 연결"
        }
        .into(),
    })?;
    loop {
        tokio::select! {_=stop.changed()=>break,_=tokio::time::sleep(Duration::from_secs(profile.keepalive))=>{
            tokio::time::timeout(Duration::from_secs(profile.timeout),ftp.noop()).await.map_err(|_|"FTP 연결 응답 없음")?.map_err(failure)?;
        }}
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), ftp.quit()).await;
    Ok(())
}
async fn lines(ftp: &mut Stream, command: &str, encoding: &str) -> Result<Vec<String>> {
    let (_, mut stream) = ftp
        .custom_data_command(command, &[Status::AboutToSend, Status::AlreadyOpen])
        .await
        .map_err(failure)?;
    let mut bytes = Vec::new();
    (&mut stream)
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(failure)?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("FTP 목록이 4MiB를 초과했습니다.".into());
    }
    stream.finish().await.map_err(failure)?;
    let text = Encoding(encoding.into());
    let text = suppaftp::Encoding::decode(&text, &bytes);
    if text.contains('\u{fffd}') {
        return Err("파일명 인코딩이 맞지 않습니다. 세션 인코딩을 변경하세요.".into());
    }
    let lines: Vec<_> = text.lines().map(str::to_owned).collect();
    if lines.len() > 20000 {
        return Err("폴더 항목은 20,000개까지 표시합니다.".into());
    }
    Ok(lines)
}
pub async fn list(session: &Session, directory: &str) -> Result<Listing> {
    path(directory)?;
    tokio::time::timeout(Duration::from_secs(30), async {
        let mut ftp = session.open().await?;
        ftp.cwd(directory).await.map_err(failure)?;
        let base = ftp.pwd().await.map_err(failure)?;
        path(&base)?;
        let (lines, mlsd) = match lines(&mut ftp, "MLSD", &session.profile.encoding).await {
            Ok(lines) => (lines, true),
            Err(_) => (
                lines(&mut ftp, "LIST", &session.profile.encoding).await?,
                false,
            ),
        };
        let mut entries = Vec::new();
        for line in lines {
            if line.to_ascii_lowercase().contains("type=cdir;")
                || line.to_ascii_lowercase().contains("type=pdir;")
            {
                continue;
            }
            let file = if mlsd {
                suppaftp::list::ListParser::parse_mlsd(&line)
            } else {
                line.parse()
            }
            .map_err(|_| "FTP 목록 형식을 해석할 수 없습니다.")?;
            if matches!(file.name(), "." | "..") {
                continue;
            }
            path(file.name())?;
            if file.name().contains('/') {
                return Err("FTP 항목 이름에 경로가 포함되어 있습니다.".into());
            }
            let permissions = if mlsd {
                line.split(';')
                    .find_map(|p| p.strip_prefix("unix.mode="))
                    .and_then(|p| u32::from_str_radix(p, 8).ok())
            } else {
                None
            };
            entries.push(Entry {
                name: file.name().into(),
                directory: file.is_directory(),
                symlink: file.is_symlink(),
                size: Some(file.size() as u64),
                modified: file
                    .modified()
                    .duration_since(std::time::UNIX_EPOCH)
                    .ok()
                    .and_then(|d| u32::try_from(d.as_secs()).ok()),
                permissions,
            });
        }
        let _ = ftp.quit().await;
        entries.sort_by(|a, b| b.directory.cmp(&a.directory).then(a.name.cmp(&b.name)));
        Ok(Listing {
            path: base,
            entries,
        })
    })
    .await
    .map_err(|_| "FTP 목록 조회 시간이 초과되었습니다.")?
}
pub async fn exists(ftp: &mut Stream, target: &str, encoding: &str) -> Result<bool> {
    path(target)?;
    let (directory, name) = target
        .rsplit_once('/')
        .ok_or("FTP 절대 경로가 필요합니다.")?;
    let directory = if directory.is_empty() { "/" } else { directory };
    let names = tokio::time::timeout(
        Duration::from_secs(30),
        lines(ftp, &format!("NLST {directory}"), encoding),
    )
    .await
    .map_err(|_| "FTP 대상 확인 시간이 초과되었습니다.")??;
    Ok(names.iter().any(|p| p.rsplit('/').next() == Some(name)))
}

pub async fn change(session: &Session, operation: &str, target: &str, value: &str) -> Result<()> {
    path(target)?;
    let mut ftp = session.open().await?;
    match operation {
        "mkdir" => ftp.mkdir(target).await.map_err(failure)?,
        "rename" => {
            path(value)?;
            if exists(&mut ftp, value, &session.profile.encoding).await? {
                return Err("대상 항목이 이미 있습니다.".into());
            }
            ftp.rename(target, value).await.map_err(failure)?;
        }
        "delete" => ftp.rm(target).await.map_err(failure)?,
        "rmdir" => ftp.rmdir(target).await.map_err(failure)?,
        "chmod" => {
            let mode = u32::from_str_radix(value, 8).map_err(|_| "8진수 권한을 입력하세요.")?;
            if mode > 0o777 {
                return Err("권한은 000~777 범위입니다.".into());
            }
            ftp.site(format!("CHMOD {mode:o} {target}"))
                .await
                .map_err(failure)?;
        }
        "newfile" => {
            if exists(&mut ftp, target, &session.profile.encoding).await? {
                return Err("대상 파일이 이미 있습니다.".into());
            }
            ftp.put_with_stream(target)
                .await
                .map_err(failure)?
                .finish()
                .await
                .map_err(failure)?;
        }
        _ => return Err("FTP에서 지원하지 않는 파일 작업".into()),
    };
    let _ = ftp.quit().await;
    Ok(())
}

pub(crate) async fn transfer_source(
    session: &Session,
    plan: &crate::sftp::Plan,
) -> Result<crate::sftp::Source> {
    if plan.upload {
        let metadata = tokio::fs::metadata(&plan.local).await.map_err(failure)?;
        if !metadata.is_file() {
            return Err("일반 파일만 전송할 수 있습니다.".into());
        }
        Ok(crate::sftp::Source {
            size: metadata.len(),
            modified: metadata
                .modified()
                .map_err(failure)?
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(failure)?
                .as_nanos()
                .to_string(),
        })
    } else {
        let mut ftp = session.open().await?;
        path(&plan.remote)?;
        let size = ftp.size(&plan.remote).await.map_err(failure)? as u64;
        let modified = ftp
            .mdtm(&plan.remote)
            .await
            .map_err(|_| "FTP 이어받기는 SIZE와 MDTM 지원이 필요합니다.")?
            .to_string();
        let _ = ftp.quit().await;
        Ok(crate::sftp::Source { size, modified })
    }
}
pub(crate) async fn transfer(
    session: &Session,
    plan: &crate::sftp::Plan,
    progress: impl Fn(u64, u64),
    committing: &std::sync::atomic::AtomicBool,
    cancelled: watch::Receiver<bool>,
) -> Result<()> {
    use tokio::io::{AsyncSeekExt, AsyncWriteExt};
    let original = plan.source.as_ref().ok_or("전송 원본 정보 없음")?;
    let total = original.size;
    let mut ftp = session.open().await?;
    path(&plan.remote)?;
    let mut buffer = vec![0; 65536];
    if plan.upload {
        if exists(&mut ftp, &plan.remote, &session.profile.encoding).await? {
            return Err("FTP 대상 파일이 이미 있습니다. 기존 파일에는 이어쓰지 않습니다.".into());
        }
        let temp = format!("{}.daxterm-{}.part", plan.remote, plan.view.id);
        let offset = if exists(&mut ftp, &temp, &session.profile.encoding).await? {
            ftp.size(&temp).await.map_err(failure)? as u64
        } else {
            0
        };
        if offset > total {
            return Err("부분 파일이 원본보다 큽니다.".into());
        }
        let mut input = tokio::fs::File::open(&plan.local).await.map_err(failure)?;
        if offset > 0 {
            let mut check = ftp.retr_as_stream(&temp).await.map_err(failure)?;
            crate::sftp::prefix(&mut input, &mut check, offset).await?;
            if check
                .read(&mut buffer[..1])
                .await
                .map_err(|e| format!("FTP 부분 파일 EOF 확인 실패: {:?}", e.kind()))?
                != 0
            {
                return Err("부분 파일 크기가 검증 중 변경되었습니다.".into());
            }
            tokio::time::timeout(Duration::from_secs(15), check.finish())
                .await
                .map_err(|_| "FTP 부분 파일 검증 완료 응답 시간 초과")?
                .map_err(protocol_failure)?;
            ftp.resume_transfer(usize::try_from(offset).map_err(|_| "FTP 오프셋 범위 오류")?)
                .await
                .map_err(|_| "FTP 서버가 REST 이어보내기를 지원하지 않습니다.")?;
        }
        let mut output = ftp.put_with_stream(&temp).await.map_err(failure)?;
        let mut done = offset;
        progress(done, total);
        while done < total {
            if *cancelled.borrow() {
                break;
            }
            let amount = (total - done).min(buffer.len() as u64) as usize;
            let n = input.read(&mut buffer[..amount]).await.map_err(failure)?;
            if n == 0 {
                return Err("원본이 짧아져 전송을 중단했습니다.".into());
            }
            output.write_all(&buffer[..n]).await.map_err(failure)?;
            done += n as u64;
            progress(done, total);
        }
        tokio::time::timeout(Duration::from_secs(15), output.finish())
            .await
            .map_err(|_| "FTP 업로드 완료 응답 시간 초과 · 부분 파일 보존됨")?
            .map_err(protocol_failure)?;
        if *cancelled.borrow() {
            return Err("일시 중지 · FTP 부분 파일 보존됨".into());
        }
        if &transfer_source(session, plan).await? != original {
            return Err("전송 중 원본 변경 · 부분 파일 보존됨".into());
        }
        if ftp.size(&temp).await.map_err(failure)? as u64 != total {
            return Err("서버가 이어보내기 오프셋을 처리하지 못했습니다. 부분 파일을 삭제하고 다시 보내세요.".into());
        }
        if exists(&mut ftp, &plan.remote, &session.profile.encoding).await? {
            return Err("전송 중 대상 파일이 생겼습니다. 부분 파일을 보존했습니다.".into());
        }
        committing.store(true, std::sync::atomic::Ordering::SeqCst);
        ftp.rename(&temp, &plan.remote).await.map_err(failure)?;
    } else {
        if tokio::fs::symlink_metadata(&plan.local).await.is_ok() {
            return Err("로컬 대상이 이미 있습니다.".into());
        }
        let temp = plan
            .local
            .with_file_name(format!(".daxterm-{}.part", plan.view.id));
        let metadata = tokio::fs::symlink_metadata(&temp).await;
        let offset = match &metadata {
            Ok(m) => {
                if !m.is_file() {
                    return Err("부분 파일이 일반 파일이 아닙니다.".into());
                }
                m.len()
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
            Err(e) => return Err(format!("FTP 로컬 파일 확인 실패 ({:?})", e.kind())),
        };
        if offset > total {
            return Err("부분 파일이 원본보다 큽니다.".into());
        }
        if offset > 0 {
            let mut partial = tokio::fs::File::open(&temp).await.map_err(failure)?;
            let mut check = ftp.retr_as_stream(&plan.remote).await.map_err(failure)?;
            crate::sftp::prefix(&mut partial, &mut check, offset).await?;
            if offset == total {
                if check
                    .read(&mut buffer[..1])
                    .await
                    .map_err(|e| format!("FTP 부분 파일 EOF 확인 실패: {:?}", e.kind()))?
                    != 0
                {
                    return Err("원격 파일 크기가 변경되었습니다.".into());
                }
                check.finish().await.map_err(failure)?;
            } else {
                ftp.abort(check).await.map_err(failure)?;
            }
            ftp.resume_transfer(usize::try_from(offset).map_err(|_| "FTP 오프셋 범위 오류")?)
                .await
                .map_err(|_| "FTP 서버가 REST 이어받기를 지원하지 않습니다.")?;
        }
        let mut input = ftp.retr_as_stream(&plan.remote).await.map_err(failure)?;
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true);
        if metadata.is_err() {
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
            if *cancelled.borrow() {
                break;
            }
            let amount = (total - done).min(buffer.len() as u64) as usize;
            let n = input.read(&mut buffer[..amount]).await.map_err(failure)?;
            if n == 0 {
                return Err("FTP 원본이 짧아졌습니다.".into());
            }
            output.write_all(&buffer[..n]).await.map_err(failure)?;
            done += n as u64;
            progress(done, total);
        }
        if *cancelled.borrow() {
            let _ = tokio::time::timeout(Duration::from_secs(10), ftp.abort(input)).await;
            output.sync_all().await.map_err(failure)?;
            return Err("일시 중지 · FTP 부분 파일 보존됨".into());
        }
        if input.read(&mut buffer[..1]).await.map_err(failure)? != 0 {
            return Err("FTP 원본 크기 또는 재개 오프셋이 맞지 않습니다.".into());
        }
        input.finish().await.map_err(failure)?;
        output.sync_all().await.map_err(failure)?;
        drop(output);
        if &transfer_source(session, plan).await? != original {
            return Err("FTP 원본이 변경되었습니다. 부분 파일을 보존했습니다.".into());
        }
        committing.store(true, std::sync::atomic::Ordering::SeqCst);
        tokio::fs::hard_link(&temp, &plan.local)
            .await
            .map_err(|_| "로컬 대상을 덮어쓰지 않고 완료할 수 없습니다.")?;
        tokio::fs::remove_file(temp).await.map_err(failure)?;
    }
    let _ = ftp.quit().await;
    Ok(())
}

pub async fn batch(
    session: &Session,
    operation: &str,
    paths: &[String],
    directory: &str,
) -> Result<crate::file_ops::Outcome> {
    use tokio::io::AsyncWriteExt;
    let mut outcome = crate::file_ops::Outcome {
        completed: Vec::new(),
        errors: Vec::new(),
    };
    if paths.is_empty() || paths.len() > 1000 || !["copy", "move", "delete"].contains(&operation) {
        return Err("FTP 파일 작업 설정 오류".into());
    }
    let mut ftp = session.open().await?;
    ftp.cwd(directory).await.map_err(failure)?;
    let base = ftp.pwd().await.map_err(failure)?;
    path(&base)?;
    for source in paths {
        let result: Result<()> = async {
            path(source)?;
            let (parent, name) = source
                .trim_end_matches('/')
                .rsplit_once('/')
                .ok_or("절대 경로가 필요합니다.")?;
            if name.is_empty() || matches!(name, "." | "..") {
                return Err("루트 항목을 변경할 수 없습니다.".into());
            }
            let listing = list(session, if parent.is_empty() { "/" } else { parent }).await?;
            let first = listing
                .entries
                .into_iter()
                .find(|e| e.name == name)
                .ok_or("원본 항목이 없습니다.")?;
            let source = format!("{}/{}", listing.path.trim_end_matches('/'), name);
            let mut target = format!("{}/{}", base.trim_end_matches('/'), name);
            if operation == "copy" && target == source {
                for n in 1..1000 {
                    let candidate = format!("{target} 복사 {n}");
                    if !exists(&mut ftp, &candidate, &session.profile.encoding).await? {
                        target = candidate;
                        break;
                    }
                }
            }
            if operation != "delete"
                && (target == source || target.starts_with(&format!("{source}/")))
            {
                return Err("원본 또는 하위 폴더에 붙여넣을 수 없습니다.".into());
            }
            if operation == "move" {
                if exists(&mut ftp, &target, &session.profile.encoding).await? {
                    return Err("대상 항목이 이미 있습니다.".into());
                }
                ftp.rename(&source, &target).await.map_err(failure)?;
                return Ok(());
            }
            let mut queue = vec![(source, String::new(), first)];
            let mut nodes = Vec::new();
            while let Some((source, relative, entry)) = queue.pop() {
                if nodes.len() + queue.len() > 20000 || relative.matches('/').count() > 64 {
                    return Err("파일 작업은 20,000개/64단계까지 가능합니다.".into());
                }
                if entry.directory && !entry.symlink {
                    let children = list(session, &source).await?;
                    if children.path.trim_end_matches('/') != source.trim_end_matches('/') {
                        return Err("FTP 폴더가 다른 경로로 변경되었습니다.".into());
                    }
                    for child in children.entries {
                        let child_path = format!("{source}/{}", child.name);
                        let rel = if relative.is_empty() {
                            child.name.clone()
                        } else {
                            format!("{relative}/{}", child.name)
                        };
                        queue.push((child_path, rel, child));
                    }
                }
                nodes.push((source, relative, entry));
            }
            if operation == "delete" {
                for (source, _, entry) in nodes.iter().rev() {
                    if entry.directory && !entry.symlink {
                        ftp.rmdir(source).await
                    } else {
                        ftp.rm(source).await
                    }
                    .map_err(failure)?;
                }
                return Ok(());
            }
            if nodes.iter().any(|(_, _, e)| e.symlink) {
                return Err("FTP 심볼릭 링크 복사는 지원하지 않습니다.".into());
            }
            if exists(&mut ftp, &target, &session.profile.encoding).await? {
                return Err("대상 항목이 이미 있습니다.".into());
            }
            let staging = format!("{target}.daxterm-{}.part", uuid::Uuid::new_v4());
            let mut created = Vec::new();
            let copied: Result<()> = async {
                for (source, relative, entry) in &nodes {
                    let dest = if relative.is_empty() {
                        staging.clone()
                    } else {
                        format!("{staging}/{relative}")
                    };
                    if entry.directory {
                        ftp.mkdir(&dest).await.map_err(failure)?;
                        created.push((dest, true));
                    } else {
                        let mut reader = session.open().await?;
                        let mut input = reader.retr_as_stream(source).await.map_err(failure)?;
                        let mut output = ftp.put_with_stream(&dest).await.map_err(failure)?;
                        created.push((dest, false));
                        let count = tokio::io::copy(&mut input, &mut output)
                            .await
                            .map_err(failure)?;
                        input.finish().await.map_err(failure)?;
                        output.flush().await.map_err(failure)?;
                        output.finish().await.map_err(failure)?;
                        if Some(count) != entry.size {
                            return Err("복사 중 FTP 원본 크기가 변경되었습니다.".into());
                        }
                        let _ = reader.quit().await;
                    }
                }
                if exists(&mut ftp, &target, &session.profile.encoding).await? {
                    return Err("복사 중 대상 항목이 생겼습니다.".into());
                }
                ftp.rename(&staging, &target).await.map_err(failure)?;
                Ok(())
            }
            .await;
            if copied.is_err() {
                for (path, directory) in created.into_iter().rev() {
                    if directory {
                        let _ = ftp.rmdir(path).await;
                    } else {
                        let _ = ftp.rm(path).await;
                    }
                }
            }
            copied
        }
        .await;
        match result {
            Ok(()) => outcome.completed.push(source.clone()),
            Err(error) => outcome.errors.push(format!("{source}: {error}")),
        }
    }
    let _ = ftp.quit().await;
    Ok(outcome)
}
