use crate::{
    AppState,
    editor::Edit,
    sftp::{self, Listing, Transfer},
    storage::Result,
};
use tauri::State;
#[tauri::command]
pub async fn sftp_list(state: State<'_, AppState>, id: String, path: String) -> Result<Listing> {
    if state.connections.control(&id)?.profile.protocol != "ssh" {
        return crate::ftp::list(&*state.connections.ftp_session(&id)?, &path).await;
    }
    sftp::list(&state.connections, &id, &path).await
}
#[tauri::command]
pub async fn sftp_change(
    state: State<'_, AppState>,
    id: String,
    operation: String,
    path: String,
    value: String,
) -> Result<()> {
    if state.connections.control(&id)?.profile.protocol != "ssh" {
        return crate::ftp::change(
            &*state.connections.ftp_session(&id)?,
            &operation,
            &path,
            &value,
        )
        .await;
    }
    sftp::change(&state.connections, &id, &operation, &path, &value).await
}
#[tauri::command]
pub async fn transfer_pick(
    state: State<'_, AppState>,
    id: String,
    path: String,
    upload: bool,
) -> Result<Option<String>> {
    state.connections.ready(&id)?;
    let selected = if upload {
        rfd::AsyncFileDialog::new()
            .set_title("업로드할 파일")
            .pick_file()
            .await
    } else {
        rfd::AsyncFileDialog::new()
            .set_title("새 이름으로 다운로드 · 기존 파일 덮어쓰기 없음")
            .set_file_name(path.rsplit('/').next().unwrap_or("download"))
            .save_file()
            .await
    };
    let Some(file) = selected else {
        return Ok(None);
    };
    let remote = if upload {
        format!("{}/{}", path.trim_end_matches('/'), file.file_name())
    } else {
        path
    };
    state
        .transfers
        .start(
            state.connections.clone(),
            id,
            remote,
            file.path().to_path_buf(),
            upload,
        )
        .map(Some)
}
#[tauri::command]
pub async fn transfer_drop(
    state: State<'_, AppState>,
    id: String,
    path: String,
    local: String,
) -> Result<String> {
    let local = std::path::PathBuf::from(local);
    if !local.is_file() && !local.is_dir() {
        return Err("파일 또는 폴더를 드롭하세요.".into());
    }
    let name = local
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("파일 이름 오류")?;
    let remote = format!("{}/{name}", path.trim_end_matches('/'));
    state
        .transfers
        .start(state.connections.clone(), id, remote, local, true)
}
#[tauri::command]
pub fn transfer_list(state: State<'_, AppState>) -> Vec<Transfer> {
    state.transfers.list()
}
#[tauri::command]
pub fn transfer_cancel(state: State<'_, AppState>, id: String) -> Result<()> {
    state.transfers.control(&[id], "pause")
}
#[tauri::command]
pub async fn transfer_batch(
    state: State<'_, AppState>,
    id: String,
    path: String,
    mode: String,
    paths: Vec<String>,
    conflict: String,
) -> Result<Vec<String>> {
    state.connections.ready(&id)?;
    if paths.len() > 100 {
        return Err("선택은 최대 100개입니다.".into());
    }
    let upload = mode != "download";
    let roots = match mode.as_str() {
        "files" | "folders" => {
            let dialog = rfd::AsyncFileDialog::new()
                .set_title("전송 큐에 추가 · 선택 전체에 충돌 정책 적용");
            let selected = if mode == "files" {
                dialog.pick_files().await
            } else {
                dialog.pick_folders().await
            };
            selected
                .unwrap_or_default()
                .into_iter()
                .map(|f| {
                    crate::transfer_queue::component(&f.file_name())?;
                    Ok((
                        format!("{}/{}", path.trim_end_matches('/'), f.file_name()),
                        f.path().to_path_buf(),
                    ))
                })
                .collect::<Result<Vec<_>>>()?
        }
        "drop" => paths
            .into_iter()
            .map(|p| {
                let p = std::path::PathBuf::from(p);
                let name = p
                    .file_name()
                    .and_then(|s| s.to_str())
                    .ok_or("파일 이름 오류")?;
                crate::transfer_queue::component(name)?;
                Ok((format!("{}/{name}", path.trim_end_matches('/')), p))
            })
            .collect::<Result<Vec<_>>>()?,
        "download" => {
            if paths.is_empty() {
                return Err("다운로드할 항목을 선택하세요.".into());
            }
            let Some(folder) = rfd::AsyncFileDialog::new()
                .set_title("파일·폴더를 받을 로컬 폴더")
                .pick_folder()
                .await
            else {
                return Ok(vec![]);
            };
            paths
                .into_iter()
                .map(|remote| {
                    let name = remote.rsplit('/').next().ok_or("파일 이름 오류")?;
                    crate::transfer_queue::component(name)?;
                    let local = folder.path().join(name);
                    Ok((remote, local))
                })
                .collect::<Result<Vec<_>>>()?
        }
        _ => return Err("전송 선택 방식 오류".into()),
    };
    if roots.is_empty() {
        return Ok(vec![]);
    }
    state.transfers.enqueue(
        state.connections.clone(),
        id,
        roots,
        upload,
        &conflict,
        false,
    )
}
#[tauri::command]
pub async fn transfer_control(
    state: State<'_, AppState>,
    ids: Vec<String>,
    action: String,
    connection_id: String,
    profile_id: String,
) -> Result<()> {
    if action == "resume" {
        if ids.len() > 100 {
            return Err("최대 100개 작업".into());
        }
        for id in ids {
            state.transfers.resume(
                state.connections.clone(),
                id,
                profile_id.clone(),
                Some(connection_id.clone()),
            )?;
        }
        Ok(())
    } else {
        state.transfers.control(&ids, &action)
    }
}
#[tauri::command]
pub fn transfer_items(
    state: State<'_, AppState>,
    id: String,
    offset: usize,
) -> Result<Vec<crate::transfer_queue::Item>> {
    state.transfers.items(&id, offset)
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn edit_start(
    state: State<'_, AppState>,
    id: String,
    profile_id: String,
    path: String,
    program: String,
    args: Vec<String>,
    encoding: Option<String>,
    upload_mode: Option<String>,
) -> Result<Edit> {
    let mode = upload_mode.as_deref().unwrap_or("ask");
    if !["ask", "auto", "manual"].contains(&mode) {
        return Err("업로드 방식 오류".into());
    }
    let edit = state
        .editors
        .start(
            &state.connections,
            id,
            profile_id,
            path,
            &state.directory.join("edits"),
            &program,
            &args,
            encoding.as_deref().unwrap_or("original"),
        )
        .await?;
    state.editors.set_mode(&edit.id, mode).await?;
    state
        .editors
        .list()
        .into_iter()
        .find(|e| e.id == edit.id)
        .ok_or("편집 작업 없음".into())
}
#[tauri::command]
pub fn edit_list(state: State<'_, AppState>) -> Vec<Edit> {
    state.editors.list()
}
#[tauri::command]
pub async fn edit_resolve(
    state: State<'_, AppState>,
    id: String,
    connection_id: String,
    profile_id: String,
    choice: String,
    path: Option<String>,
) -> Result<()> {
    if !["retry", "overwrite", "reload", "saveAs", "pause"].contains(&choice.as_str()) {
        return Err("잘못된 충돌 해결 방법".into());
    }
    if choice == "pause" {
        return state.editors.pause(&id);
    }
    {
        let _guard = state.editors.busy.lock().await;
        let actual = state.connections.control(&connection_id)?.profile.clone();
        let mut entries = state.editors.entries.lock().unwrap();
        let edit = entries.get_mut(&id).ok_or("편집 작업 없음")?;
        if edit.profile_id != profile_id
            || actual.id != profile_id
            || edit.destination != crate::editor::destination(&actual)
        {
            return Err("편집을 시작한 서버 세션으로 연결하세요.".into());
        }
        edit.connection_id = connection_id;
    }
    state
        .editors
        .sync(&state.connections, &id, &choice, path.as_deref())
        .await
}

#[tauri::command]
pub async fn edit_close(state: State<'_, AppState>, id: String) -> Result<()> {
    state
        .editors
        .close(&id, &state.directory.join("edits"))
        .await
}

#[tauri::command]
pub async fn edit_mode(state: State<'_, AppState>, id: String, mode: String) -> Result<()> {
    state.editors.set_mode(&id, &mode).await
}
#[tauri::command]
pub async fn editor_pick() -> Result<Option<String>> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("외부 편집기 실행 파일 선택")
        .pick_file()
        .await
        .map(|f| f.path().to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn transfer_resume(
    state: State<'_, AppState>,
    id: String,
    connection_id: String,
    profile_id: String,
) -> Result<()> {
    state.transfers.resume(
        state.connections.clone(),
        id,
        profile_id,
        Some(connection_id),
    )
}
#[tauri::command]
pub async fn transfer_discard(
    state: State<'_, AppState>,
    id: String,
    connection_id: String,
) -> Result<()> {
    state
        .transfers
        .discard(&state.connections, &id, &connection_id)
        .await
}
