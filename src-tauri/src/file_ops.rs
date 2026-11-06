use crate::{AppState, sftp, ssh::Connections, storage::Result};
use russh_sftp::{
    client::SftpSession,
    protocol::{FileAttributes, OpenFlags},
};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
#[derive(Serialize)]
pub struct Outcome {
    pub completed: Vec<String>,
    pub errors: Vec<String>,
}
struct Node {
    path: String,
    relative: String,
    attrs: FileAttributes,
}
async fn normalized(s: &SftpSession, path: &str) -> Result<String> {
    sftp::path(path)?;
    let (parent, name) = path
        .trim_end_matches('/')
        .rsplit_once('/')
        .ok_or("절대 경로를 사용하세요.")?;
    if name.is_empty() || matches!(name, "." | "..") {
        return Err("루트 또는 상대 경로 항목은 변경할 수 없습니다.".into());
    }
    let base = s
        .canonicalize(if parent.is_empty() { "/" } else { parent })
        .await
        .map_err(sftp::failure)?;
    sftp::path(&base)?;
    Ok(format!("{}/{}", base.trim_end_matches('/'), name))
}
async fn tree(
    connections: &Connections,
    id: &str,
    s: &SftpSession,
    root: &str,
) -> Result<Vec<Node>> {
    let mut queue = vec![(root.to_string(), String::new())];
    let mut nodes = Vec::new();
    while let Some((path, relative)) = queue.pop() {
        if nodes.len() + queue.len() > 20000 || relative.matches('/').count() > 64 {
            return Err("파일 작업은 20,000개/64단계까지 가능합니다.".into());
        }
        let attrs = s.symlink_metadata(&path).await.map_err(sftp::failure)?;
        if attrs.file_type().is_dir() {
            let listing = sftp::list(connections, id, &path).await?;
            if listing.path.trim_end_matches('/') != path.trim_end_matches('/') {
                return Err("폴더가 다른 경로로 변경되었습니다.".into());
            }
            for entry in listing.entries {
                let name = entry.name;
                sftp::path(&name)?;
                queue.push((
                    format!("{path}/{name}"),
                    if relative.is_empty() {
                        name
                    } else {
                        format!("{relative}/{name}")
                    },
                ));
            }
        }
        nodes.push(Node {
            path,
            relative,
            attrs,
        });
    }
    Ok(nodes)
}
async fn remove(s: &SftpSession, nodes: &[Node]) -> Result<()> {
    for node in nodes.iter().rev() {
        let now = s
            .symlink_metadata(&node.path)
            .await
            .map_err(sftp::failure)?;
        if now.file_type().is_dir() != node.attrs.file_type().is_dir() {
            return Err("파일 종류가 바뀌어 삭제를 중지했습니다.".into());
        }
        if node.attrs.file_type().is_dir() {
            s.remove_dir(&node.path).await
        } else {
            s.remove_file(&node.path).await
        }
        .map_err(sftp::failure)?;
    }
    Ok(())
}
async fn copy(
    source: &SftpSession,
    dest: &SftpSession,
    nodes: &[Node],
    target: &str,
) -> Result<()> {
    if nodes
        .iter()
        .any(|n| !n.attrs.file_type().is_dir() && !n.attrs.file_type().is_file())
    {
        return Err(
            "심볼릭 링크·장치 파일 복사는 지원하지 않습니다. 일반 파일과 폴더를 선택하세요.".into(),
        );
    }
    if dest.symlink_metadata(target).await.is_ok() {
        return Err("대상 항목이 이미 있습니다.".into());
    }
    let staging = format!("{target}.dachsterm-{}.part", uuid::Uuid::new_v4());
    let mut created: Vec<(String, bool)> = Vec::new();
    let result: Result<()> = async {
        for node in nodes {
            let path = if node.relative.is_empty() {
                staging.clone()
            } else {
                format!("{staging}/{}", node.relative)
            };
            let current = source
                .symlink_metadata(&node.path)
                .await
                .map_err(sftp::failure)?;
            if current.file_type() != node.attrs.file_type()
                || current.size != node.attrs.size
                || current.mtime != node.attrs.mtime
            {
                return Err("복사 중 원본이 변경되었습니다.".into());
            }
            if node.attrs.file_type().is_dir() {
                dest.create_dir(&path).await.map_err(sftp::failure)?;
                created.push((path, true));
            } else {
                let mut input = source.open(&node.path).await.map_err(sftp::failure)?;
                let mut output = dest
                    .open_with_flags_and_attributes(
                        &path,
                        OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                        FileAttributes {
                            permissions: Some(0o600),
                            ..Default::default()
                        },
                    )
                    .await
                    .map_err(sftp::failure)?;
                created.push((path, false));
                let mut buffer = vec![0; 65536];
                let mut copied = 0;
                loop {
                    let n = input.read(&mut buffer).await.map_err(sftp::failure)?;
                    if n == 0 {
                        break;
                    }
                    output
                        .write_all(&buffer[..n])
                        .await
                        .map_err(sftp::failure)?;
                    copied += n as u64;
                }
                output.shutdown().await.map_err(sftp::failure)?;
                let after = source
                    .symlink_metadata(&node.path)
                    .await
                    .map_err(sftp::failure)?;
                if Some(copied) != node.attrs.size
                    || after.size != node.attrs.size
                    || after.mtime != node.attrs.mtime
                {
                    return Err("복사 중 원본 내용이 변경되었습니다.".into());
                }
            }
        }
        for (node, (path, _)) in nodes.iter().zip(&created).rev() {
            dest.set_metadata(
                path,
                FileAttributes {
                    permissions: node.attrs.permissions.map(|p| p & 0o777),
                    atime: node.attrs.atime,
                    mtime: node.attrs.mtime,
                    ..Default::default()
                },
            )
            .await
            .map_err(sftp::failure)?;
        }
        dest.rename(&staging, target).await.map_err(sftp::failure)?;
        Ok(())
    }
    .await;
    if result.is_err() {
        for (path, is_dir) in created.into_iter().rev() {
            if is_dir {
                let _ = dest.remove_dir(path).await;
            } else {
                let _ = dest.remove_file(path).await;
            }
        }
    }
    result
}
pub async fn batch(
    connections: &Connections,
    id: &str,
    source_id: &str,
    operation: &str,
    paths: &[String],
    directory: &str,
) -> Result<Outcome> {
    if connections.control(id)?.profile.protocol != "ssh" {
        if source_id != id {
            return Err("FTP 복사·이동은 같은 연결에서 지원합니다.".into());
        }
        return crate::ftp::batch(&*connections.ftp_session(id)?, operation, paths, directory)
            .await;
    }
    if paths.is_empty() || paths.len() > 1000 {
        return Err("1~1,000개 항목을 선택하세요.".into());
    }
    if !["copy", "move", "delete"].contains(&operation) {
        return Err("지원하지 않는 파일 작업".into());
    }
    if operation == "move" && source_id != id {
        return Err("다른 연결로는 복사 후 원본을 확인하고 삭제하세요.".into());
    }
    let source = sftp::open(connections, source_id).await?;
    let dest = sftp::open(connections, id).await?;
    let base = dest.canonicalize(directory).await.map_err(sftp::failure)?;
    sftp::path(&base)?;
    let same_server = crate::editor::destination(&connections.control(id)?.profile)
        == crate::editor::destination(&connections.control(source_id)?.profile);
    let mut outcome = Outcome {
        completed: Vec::new(),
        errors: Vec::new(),
    };
    for path in paths {
        let result: Result<()> = async {
            let path = normalized(&source, path).await?;
            let name = path.rsplit('/').next().ok_or("항목 이름 오류")?;
            let mut target = format!("{}/{name}", base.trim_end_matches('/'));
            if operation == "copy" && same_server && target == path {
                for n in 1..1000 {
                    let candidate = format!("{target} 복사 {n}");
                    if dest.symlink_metadata(&candidate).await.is_err() {
                        target = candidate;
                        break;
                    }
                }
            }
            if operation != "delete"
                && same_server
                && (target == path || target.starts_with(&format!("{path}/")))
            {
                return Err("원본 자신이나 하위 폴더에는 붙여넣을 수 없습니다.".into());
            }
            if operation == "move" {
                if dest.symlink_metadata(&target).await.is_ok() {
                    return Err("대상 이름이 이미 있습니다.".into());
                }
                source.rename(&path, &target).await.map_err(sftp::failure)
            } else {
                let nodes = tree(connections, source_id, &source, &path).await?;
                if operation == "delete" {
                    remove(&source, &nodes).await
                } else {
                    copy(&source, &dest, &nodes, &target).await
                }
            }
        }
        .await;
        match result {
            Ok(()) => outcome.completed.push(path.clone()),
            Err(e) => outcome.errors.push(format!("{path}: {e}")),
        }
    }
    Ok(outcome)
}
#[tauri::command]
pub async fn file_batch(
    state: tauri::State<'_, AppState>,
    id: String,
    source_id: String,
    operation: String,
    paths: Vec<String>,
    directory: String,
) -> Result<Outcome> {
    let control = state.connections.control(&id)?;
    let mut stop = control.stop.subscribe();
    tokio::select! {biased;_=stop.changed()=>Err("연결이 종료되어 파일 작업을 중지했습니다. 완료된 항목과 부분 파일을 확인하세요.".into()),result=batch(&state.connections,&id,&source_id,&operation,&paths,&directory)=>result}
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Clipboard {
    pub source_id: String,
    pub operation: String,
    pub paths: Vec<String>,
}
#[tauri::command]
pub fn file_clipboard(
    state: tauri::State<AppState>,
    action: String,
    value: Option<Clipboard>,
) -> Result<Option<Clipboard>> {
    let mut clipboard = state.file_clipboard.lock().unwrap();
    match action.as_str() {
        "get" => {}
        "clear" => *clipboard = None,
        "set" => {
            let value = value.ok_or("클립보드 항목 없음")?;
            if !["copy", "move"].contains(&value.operation.as_str())
                || value.paths.is_empty()
                || value.paths.len() > 1000
            {
                return Err("복사할 항목을 확인하세요.".into());
            }
            state.connections.control(&value.source_id)?;
            for path in &value.paths {
                sftp::path(path)?;
            }
            *clipboard = Some(value);
        }
        _ => return Err("클립보드 작업 오류".into()),
    }
    Ok(clipboard.clone())
}
