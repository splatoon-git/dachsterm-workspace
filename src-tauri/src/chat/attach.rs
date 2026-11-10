//! Attachments for a chat on this PC (AC.2). A chat over SSH sends files with `prompt_files`,
//! which uploads them; here the agent reads this PC, so a file goes as its own path and only a
//! clipboard image needs a file written for it.
use crate::{prompt_files, storage::Result};
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

/// Clipboard images older than this are removed the next time one is saved.
const KEEP: Duration = Duration::from_secs(7 * 24 * 60 * 60);

fn folder() -> PathBuf {
    std::env::temp_dir().join("dachsterm-chat")
}

/// The folder for clipboard images, readable by this user only.
fn prepare(folder: &Path) -> Result<()> {
    std::fs::create_dir_all(folder).map_err(|_| "첨부 폴더를 만들 수 없습니다.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "첨부 폴더의 권한을 정할 수 없습니다.".to_string())?;
    }
    Ok(())
}

/// Removes clipboard images this app saved more than a week ago. Failures leave them for later.
fn sweep(folder: &Path, now: SystemTime) {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|at| now.duration_since(at).is_ok_and(|age| age > KEEP));
        let ours = entry
            .file_name()
            .to_string_lossy()
            .starts_with("clipboard-");
        if old && ours {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn save(folder: &Path, png: &[u8]) -> Result<String> {
    prepare(folder)?;
    sweep(folder, SystemTime::now());
    let path = folder.join(format!("clipboard-{}.png", uuid::Uuid::new_v4().simple()));
    std::fs::write(&path, png).map_err(|_| "클립보드 이미지를 저장할 수 없습니다.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(path.to_string_lossy().into_owned())
}

/// Saves the clipboard image the user approved and gives its path on this PC.
#[tauri::command]
pub async fn chat_clipboard_local(expected: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let png = prompt_files::clipboard_png()?
            .filter(|png| prompt_files::digest(png) == expected)
            .ok_or("확인한 뒤 클립보드 내용이 바뀌어 붙이지 않았습니다. 다시 붙여넣으세요.")?;
        save(&folder(), &png)
    })
    .await
    .map_err(|_| "클립보드 이미지를 저장할 수 없습니다.".to_string())?
}

/// Files to attach, chosen in the OS dialog. Empty when the user cancels.
#[tauri::command]
pub async fn chat_pick_files() -> Result<Vec<String>> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("채팅에 첨부할 파일")
        .pick_files()
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|file| file.path().to_string_lossy().into_owned())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_privately_and_sweeps_only_old_clipboard_images() {
        let folder =
            std::env::temp_dir().join(format!("dachsterm-chat-test-{}", uuid::Uuid::new_v4()));
        let path = save(&folder, b"png").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"png");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        std::fs::write(folder.join("keep.txt"), b"x").unwrap();
        sweep(&folder, SystemTime::now() + KEEP + Duration::from_secs(60));
        assert!(!Path::new(&path).exists());
        assert!(folder.join("keep.txt").exists());
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
