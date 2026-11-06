use crate::{AppState, ssh::Connections, storage::Result};
use serde::{Deserialize, Serialize};
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub operation: String,
    pub paths: Vec<String>,
    pub target: String,
    pub format: String,
    pub encoding: String,
    pub limit_mb: u64,
}
#[derive(Deserialize)]
struct Response {
    ok: bool,
    error: Option<String>,
}
pub async fn run(connections: &Connections, id: &str, request: Request) -> Result<()> {
    if request.paths.is_empty()
        || request.paths.len() > 1000
        || !["compress", "extract"].contains(&request.operation.as_str())
    {
        return Err("압축 작업 설정을 확인하세요.".into());
    }
    for path in request.paths.iter().chain(std::iter::once(&request.target)) {
        crate::sftp::path(path)?;
    }
    let command = format!(
        "python3 -c '{}'",
        include_str!("archive_helper.py").replace('\'', "'\"'\"'")
    );
    let handle = connections.handle(id)?;
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(crate::sftp::failure)?;
    let work = async {
        channel
            .exec(true, command)
            .await
            .map_err(crate::sftp::failure)?;
        let bytes = serde_json::to_vec(&request).map_err(crate::sftp::failure)?;
        channel
            .data(&bytes[..])
            .await
            .map_err(crate::sftp::failure)?;
        channel.eof().await.map_err(crate::sftp::failure)?;
        let mut output = Vec::new();
        let mut exit = None;
        while let Some(event) = channel.wait().await {
            match event {
                russh::ChannelMsg::Data { data } => {
                    output.extend_from_slice(&data);
                    if output.len() > 65536 {
                        return Err("압축 작업 응답이 너무 큽니다.".into());
                    }
                }
                russh::ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
                _ => {}
            }
        }
        let response:Response=serde_json::from_slice(&output).map_err(|_| "서버에 Python 3와 Linux renameat2 지원이 필요합니다. ZIP 파일명 인코딩 지정은 Python 3.11 이상이 필요합니다.")?;
        if exit != Some(0) || !response.ok {
            return Err(format!(
                "압축 작업 실패: {}",
                response.error.unwrap_or_default()
            ));
        }
        Ok(())
    };
    tokio::time::timeout(std::time::Duration::from_secs(600), work)
        .await
        .map_err(
            |_| "압축 작업 시간 초과. 서버의 작업 상태와 .dachsterm-archive 임시 폴더를 확인하세요.",
        )?
}
#[tauri::command]
pub async fn archive_run(
    state: tauri::State<'_, AppState>,
    id: String,
    request: Request,
) -> Result<()> {
    run(&state.connections, &id, request).await
}
