use crate::{sftp, ssh::Connections, storage::Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
const LIMIT: u64 = 32 * 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Edit {
    pub id: String,
    pub connection_id: String,
    pub profile_id: String,
    #[serde(default)]
    pub destination: String,
    #[serde(default = "original_encoding")]
    pub encoding: String,
    #[serde(default = "ask_mode")]
    pub upload_mode: String,
    pub remote: String,
    pub local: PathBuf,
    pub baseline: String,
    pub uploaded: String,
    pub status: String,
    pub message: String,
}
#[derive(Default)]
pub struct Editors {
    pub entries: Mutex<HashMap<String, Edit>>,
    pub busy: tokio::sync::Mutex<()>,
    cancel: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
}
fn ask_mode() -> String {
    "ask".into()
}
fn original_encoding() -> String {
    "original".into()
}
pub fn destination(p: &crate::storage::Profile) -> String {
    hash(
        format!(
            "{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}",
            p.host,
            p.port,
            p.username,
            p.auth,
            p.key_path,
            p.protocol,
            p.tls_ca_path,
            if p.protocol == "ssh" {
                "utf-8"
            } else {
                &p.encoding
            }
        )
        .as_bytes(),
    )
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn editor_program(program: &str) -> PathBuf {
    #[cfg(windows)]
    {
        let relative = match program {
            "code" => Some("Microsoft VS Code/Code.exe"),
            "cursor" => Some("cursor/Cursor.exe"),
            "subl" => Some("Sublime Text/sublime_text.exe"),
            _ => None,
        };
        if let Some(relative) = relative {
            let mut roots = Vec::new();
            if let Some(local) = std::env::var_os("LOCALAPPDATA") {
                roots.push(PathBuf::from(local).join("Programs"));
            }
            if let Some(programs) = std::env::var_os("ProgramFiles") {
                roots.push(PathBuf::from(programs));
            }
            for root in roots {
                let path = root.join(relative);
                if path.is_file() {
                    return path;
                }
            }
        }
    }
    PathBuf::from(program)
}
async fn read_remote(s: &russh_sftp::client::SftpSession, path: &str) -> Result<Vec<u8>> {
    let file = s.open(path).await.map_err(sftp::failure)?;
    let mut data = Vec::new();
    file.take(LIMIT + 1)
        .read_to_end(&mut data)
        .await
        .map_err(sftp::failure)?;
    if data.len() as u64 > LIMIT {
        return Err("외부 편집은 32MiB 이하 파일만 지원합니다.".into());
    }
    Ok(data)
}
fn persist(edit: &Edit) -> Result<()> {
    let manifest = edit
        .local
        .parent()
        .ok_or("편집 경로 오류")?
        .join("recovery.json");
    let data = serde_json::to_vec(edit).map_err(sftp::failure)?;
    crate::maintenance::atomic_write(&manifest, &data)
}
pub fn private_directory(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path).map_err(sftp::failure)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(sftp::failure)?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let who = std::process::Command::new("whoami.exe")
            .args(["/user", "/fo", "csv", "/nh"])
            .creation_flags(0x08000000)
            .output()
            .map_err(sftp::failure)?;
        let text = String::from_utf8_lossy(&who.stdout);
        let sid = text
            .split(',')
            .nth(1)
            .unwrap_or("")
            .trim()
            .trim_matches('"');
        if !sid.starts_with("S-1-")
            || !sid
                .chars()
                .all(|c| c.is_ascii_digit() || c == 'S' || c == '-')
        {
            return Err("사용자 전용 편집 폴더를 준비할 수 없습니다.".into());
        }
        let status = std::process::Command::new("icacls.exe")
            .arg(path)
            .args(["/inheritance:r", "/grant:r", &format!("*{sid}:(OI)(CI)F")])
            .creation_flags(0x08000000)
            .output()
            .map_err(sftp::failure)?;
        if !status.status.success() {
            return Err("편집 폴더 접근 권한 설정 실패".into());
        }
    }
    Ok(())
}
impl Editors {
    pub fn list(&self) -> Vec<Edit> {
        self.entries.lock().unwrap().values().cloned().collect()
    }
    pub fn recover(&self, root: &Path) {
        if let Ok(dirs) = std::fs::read_dir(root) {
            for entry in dirs.flatten() {
                let file = entry.path().join("recovery.json");
                if let Ok(data) = crate::maintenance::read_config(&file)
                    && data.len() < 65536
                    && let Ok(mut edit) = serde_json::from_slice::<Edit>(&data)
                {
                    if edit.local.parent() != Some(entry.path().as_path()) || !edit.local.is_file()
                    {
                        continue;
                    }
                    edit.status = "recovery".into();
                    edit.message =
                        "보존된 수정본입니다. 같은 세션에 연결한 뒤 재시도하세요.".into();
                    self.entries.lock().unwrap().insert(edit.id.clone(), edit);
                }
            }
        }
    }
    #[allow(clippy::too_many_arguments)]
    pub async fn start(
        &self,
        connections: &Connections,
        connection: String,
        profile: String,
        remote: String,
        root: &Path,
        program: &str,
        args: &[String],
        encoding: &str,
    ) -> Result<Edit> {
        sftp::path(&remote)?;
        let actual = connections.control(&connection)?.profile.clone();
        if actual.id != profile {
            return Err("편집 세션 대상 불일치".into());
        }
        if self.list().len() >= 32 {
            return Err("편집 작업은 최대 32개입니다.".into());
        }
        if program.is_empty()
            || program.len() > 4096
            || args.len() > 32
            || args.iter().any(|a| a.len() > 4096)
        {
            return Err("편집기 실행 설정 오류".into());
        }
        let s = sftp::open(connections, &connection).await?;
        let remote = s.canonicalize(&remote).await.map_err(sftp::failure)?;
        let bytes = read_remote(&s, &remote).await?;
        let id = uuid::Uuid::new_v4().to_string();
        let dir = root.join(&id);
        private_directory(&dir)?;
        let name = remote
            .rsplit('/')
            .next()
            .filter(|n| !n.is_empty() && !n.contains(['\\', ':']))
            .ok_or("파일 이름 오류")?;
        let extension = Path::new(name)
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("txt");
        let local = dir.join(format!("working.{extension}"));
        let local_bytes = crate::encoding::to_local(&bytes, encoding)?;
        tokio::fs::write(&local, &local_bytes)
            .await
            .map_err(sftp::failure)?;
        let mut edit = Edit {
            id: id.clone(),
            connection_id: connection,
            profile_id: profile,
            destination: destination(&actual),
            encoding: encoding.into(),
            upload_mode: ask_mode(),
            remote,
            local,
            baseline: hash(&bytes),
            uploaded: hash(&local_bytes),
            status: "watching".into(),
            message: "저장을 감지하면 업로드 여부를 확인합니다.".into(),
        };
        persist(&edit)?;
        // Never interpolate a shell command. The file argument is always a separate argument.
        let mut command = std::process::Command::new(editor_program(program));
        command.args(args).arg(&edit.local);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        match command.spawn() {
            Ok(mut child) => {
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
            }
            Err(_) => {
                edit.status = "error".into();
                edit.message = "편집기를 실행할 수 없습니다. 로컬 파일은 보존되었습니다.".into();
            }
        }
        self.entries.lock().unwrap().insert(id, edit.clone());
        Ok(edit)
    }
    pub async fn sync(
        &self,
        connections: &Connections,
        id: &str,
        choice: &str,
        new_path: Option<&str>,
    ) -> Result<()> {
        let _guard = self.busy.lock().await;
        let (mut edit, mut cancelled) = {
            let entries = self.entries.lock().unwrap();
            let edit = entries.get(id).cloned().ok_or("편집 작업 없음")?;
            let mut tokens = self.cancel.lock().unwrap();
            let token = tokens
                .entry(id.into())
                .or_insert_with(|| tokio::sync::watch::channel(false).0);
            if choice != "auto" {
                token.send_replace(false);
            }
            (edit, token.subscribe())
        };
        if choice == "auto" {
            if edit.status != "watching" {
                return Ok(());
            }
            let read: Result<Vec<u8>> = async {
                let file = tokio::fs::File::open(&edit.local)
                    .await
                    .map_err(sftp::failure)?;
                let mut bytes = Vec::new();
                file.take(LIMIT + 1)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(sftp::failure)?;
                if bytes.len() as u64 > LIMIT {
                    return Err("편집 파일이 32MiB를 초과했습니다.".into());
                }
                Ok(bytes)
            }
            .await;
            let bytes = match read {
                Ok(bytes) => bytes,
                Err(error) => {
                    edit.status = "error".into();
                    edit.message = error.clone();
                    persist(&edit)?;
                    self.entries.lock().unwrap().insert(id.into(), edit);
                    return Err(error);
                }
            };
            if hash(&bytes) == edit.uploaded {
                return Ok(());
            }
            if edit.upload_mode != "auto" {
                edit.status = "pending".into();
                edit.message = if edit.upload_mode == "ask" {
                    "로컬 수정본을 서버에 업로드할까요?"
                } else {
                    "로컬 수정본 저장됨 · 수동 업로드 대기"
                }
                .into();
                let mut entries = self.entries.lock().unwrap();
                if *cancelled.borrow() {
                    return Ok(());
                }
                persist(&edit)?;
                entries.insert(id.into(), edit);
                return Ok(());
            }
        }
        let result: Result<()> = async {
            let s = sftp::open(connections, &edit.connection_id).await?;
            if *cancelled.borrow() { return Err("cancelled".into()); }
            if choice == "reload" {
                let remote = read_remote(&s, &edit.remote).await?;
                // Preserve the overwritten local revision as an explicit recovery copy.
                tokio::fs::copy(
                    &edit.local,
                    edit.local
                        .with_extension(format!("{}.bak", uuid::Uuid::new_v4())),
                )
                .await
                .map_err(sftp::failure)?;
                let local_bytes = crate::encoding::to_local(&remote, &edit.encoding)?;
                tokio::fs::write(&edit.local, &local_bytes)
                    .await
                    .map_err(sftp::failure)?;
                edit.baseline = hash(&remote);
                edit.uploaded = hash(&local_bytes);
                return Ok(());
            }
            let local = tokio::fs::File::open(&edit.local)
                .await
                .map_err(sftp::failure)?;
            let mut bytes = Vec::new();
            local
                .take(LIMIT + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(sftp::failure)?;
            if bytes.len() as u64 > LIMIT {
                return Err("편집 파일이 32MiB를 초과했습니다.".into());
            }
            let digest = hash(&bytes);
            if choice == "auto" && digest == edit.uploaded {
                return Ok(());
            }
            let wire = crate::encoding::to_remote(&bytes, &edit.encoding)?;
            let target = if choice == "saveAs" {
                let p = new_path.ok_or("새 경로 필요")?;
                sftp::path(p)?;
                p.to_string()
            } else {
                edit.remote.clone()
            };
            if choice == "saveAs" {
                if s.try_exists(&target).await.map_err(sftp::failure)? {
                    return Err("다른 이름의 대상 파일이 이미 있습니다.".into());
                }
            } else {
                let remote = read_remote(&s, &target).await?;
                if hash(&remote) != edit.baseline && choice != "overwrite" {
                    return Err("conflict".into());
                }
            }
            if *cancelled.borrow() { return Err("cancelled".into()); }
            let metadata = s.metadata(&target).await.ok();
            {let mut entries=self.entries.lock().unwrap();if let Some(active)=entries.get_mut(id){active.status="uploading".into();active.message="수정본 업로드 중".into();}}
            let temp = format!("{target}.daxterm-{}.part", uuid::Uuid::new_v4());
            let upload = async {
                let mut file = s
                    .open_with_flags_and_attributes(
                        &temp,
                        russh_sftp::protocol::OpenFlags::CREATE
                            | russh_sftp::protocol::OpenFlags::EXCLUDE
                            | russh_sftp::protocol::OpenFlags::WRITE,
                        russh_sftp::protocol::FileAttributes {
                            permissions: Some(0o600),
                            ..Default::default()
                        },
                    )
                    .await
                    .map_err(sftp::failure)?;
                tokio::select! { biased; _=cancelled.changed()=>return Err("cancelled".into()), result=file.write_all(&wire)=>result.map_err(sftp::failure)? };
                file.shutdown().await.map_err(sftp::failure)?;
                if let Some(m) = metadata {
                    s.set_metadata(
                        &temp,
                        russh_sftp::protocol::FileAttributes {
                            permissions: m.permissions,
                            ..Default::default()
                        },
                    )
                    .await
                    .map_err(sftp::failure)?;
                }
                {let mut entries=self.entries.lock().unwrap();if *cancelled.borrow(){return Err("cancelled".into());}
                if let Some(active)=entries.get_mut(id){active.status="committing".into();active.message="원격 파일 교체 완료 확인 중".into();}}
                if choice == "saveAs" {
                    s.rename(&temp, &target).await.map_err(sftp::failure)?;
                } else {
                    atomic_replace(connections, &edit.connection_id, &temp, &target).await?;
                }
                Ok::<(), String>(())
            }
            .await;
            if upload.is_err() {
                let _ = s.remove_file(&temp).await;
            }
            upload?;
            edit.remote = target;
            edit.baseline = hash(&wire);
            edit.uploaded = digest;
            Ok(())
        }
        .await;
        match result {
            Ok(()) => {
                edit.status = "watching".into();
                edit.message = "저장 감지 중 · 원격 파일 동기화됨".into();
            }
            Err(ref e) => {
                edit.status = if e == "cancelled" {
                    "recovery"
                } else if e == "conflict" {
                    "conflict"
                } else {
                    "error"
                }
                .into();
                edit.message = if e == "cancelled" {
                    "업로드를 취소했습니다. 로컬 수정본은 보존되었습니다.".into()
                } else if e == "conflict" {
                    "서버 파일도 변경되었습니다. 수정본을 보존했습니다.".into()
                } else {
                    e.clone()
                };
            }
        }
        persist(&edit)?;
        self.entries.lock().unwrap().insert(id.into(), edit);
        result
    }
    pub fn watch(self: &Arc<Self>, connections: Arc<Connections>) {
        let editors = self.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(2)).await;
                for edit in editors
                    .list()
                    .into_iter()
                    .filter(|e| e.status == "watching")
                {
                    // Two samples debounce partial writes; sync uses a single serialized upload queue.
                    let before = tokio::fs::metadata(&edit.local)
                        .await
                        .ok()
                        .and_then(|m| m.modified().ok());
                    tokio::time::sleep(Duration::from_millis(350)).await;
                    let after = tokio::fs::metadata(&edit.local)
                        .await
                        .ok()
                        .and_then(|m| m.modified().ok());
                    if before == after {
                        let _ = editors.sync(&connections, &edit.id, "auto", None).await;
                    }
                }
            }
        });
    }
    pub fn pause(&self, id: &str) -> Result<()> {
        let mut entries = self.entries.lock().unwrap();
        let edit = entries.get_mut(id).ok_or("편집 작업 없음")?;
        if edit.status == "committing" {
            return Err("원격 교체 완료를 확인하고 있습니다. 완료 후 중지하세요.".into());
        }
        if let Some(cancel) = self.cancel.lock().unwrap().get(id) {
            cancel.send_replace(true);
        }
        if edit.status != "uploading" {
            edit.status = "recovery".into();
            edit.message = "감지 중지 · 수정본 보존됨".into();
            persist(edit)?;
        }
        Ok(())
    }
    pub async fn set_mode(&self, id: &str, mode: &str) -> Result<()> {
        if !["ask", "auto", "manual"].contains(&mode) {
            return Err("업로드 방식 오류".into());
        }
        let _guard = self.busy.lock().await;
        let mut entries = self.entries.lock().unwrap();
        let edit = entries.get_mut(id).ok_or("편집 작업 없음")?;
        edit.upload_mode = mode.into();
        if edit.status == "pending" {
            edit.status = "watching".into();
        }
        persist(edit)
    }
    pub async fn close(&self, id: &str, root: &Path) -> Result<()> {
        let _guard = self.busy.lock().await;
        let edit = self
            .entries
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("편집 작업 없음")?;
        let file = tokio::fs::File::open(&edit.local)
            .await
            .map_err(sftp::failure)?;
        let mut bytes = Vec::new();
        file.take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(sftp::failure)?;
        if hash(&bytes) != edit.uploaded {
            return Err("아직 업로드되지 않은 수정본이 있습니다. 먼저 저장하거나 감지를 중지해 복구본을 보존하세요.".into());
        }
        if uuid::Uuid::parse_str(id).is_err()
            || edit.local.parent() != Some(root.join(id).as_path())
        {
            return Err("편집 폴더 범위 오류".into());
        }
        let dir = edit.local.parent().ok_or("편집 경로 오류")?;
        if std::fs::read_dir(dir)
            .map_err(sftp::failure)?
            .flatten()
            .any(|e| e.path() != edit.local && e.file_name() != "recovery.json")
        {
            return Err("이 폴더에 복구용 파일이 있어 자동 정리하지 않습니다. 감지를 중지하고 복구본을 확인하세요.".into());
        }
        tokio::fs::remove_file(&edit.local)
            .await
            .map_err(sftp::failure)?;
        tokio::fs::remove_file(dir.join("recovery.json"))
            .await
            .map_err(sftp::failure)?;
        tokio::fs::remove_dir(dir).await.map_err(sftp::failure)?;
        self.entries.lock().unwrap().remove(id);
        self.cancel.lock().unwrap().remove(id);
        Ok(())
    }
}
async fn atomic_replace(connections: &Connections, id: &str, old: &str, new: &str) -> Result<()> {
    let h = connections.handle(id)?;
    let channel = h.channel_open_session().await.map_err(sftp::failure)?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(sftp::failure)?;
    let raw = russh_sftp::client::RawSftpSession::new(channel.into_stream());
    let version = raw.init().await.map_err(sftp::failure)?;
    if !version.extensions.contains_key("posix-rename@openssh.com") {
        return Err("서버가 원자적 교체를 지원하지 않습니다. 다른 이름으로 저장하세요.".into());
    }
    let mut data = Vec::new();
    for p in [old, new] {
        data.extend_from_slice(&(p.len() as u32).to_be_bytes());
        data.extend_from_slice(p.as_bytes());
    }
    let packet = raw
        .extended("posix-rename@openssh.com", data)
        .await
        .map_err(sftp::failure)?;
    if let russh_sftp::protocol::Packet::Status(s) = packet
        && s.status_code == russh_sftp::protocol::StatusCode::Ok
    {
        Ok(())
    } else {
        Err("원자적 파일 교체 실패".into())
    }
}
