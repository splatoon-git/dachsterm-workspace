//! File browsing for local terminal tabs. Paths keep the form the shell reports: WSL tabs use
//! Linux paths, mapped here to the distribution's network share. The SFTP transfer queue and
//! edit sync do not apply, because these files are already on this computer.
use crate::{AppState, file_ops::Outcome, local::Target, storage::Result};
use serde::Serialize;
use std::{
    fs, io,
    path::{Component, Path, PathBuf},
    time::{Duration, UNIX_EPOCH},
};
use tauri::State;

const ENTRY_LIMIT: usize = 20_000;
const DEPTH_LIMIT: usize = 64;

#[derive(Serialize)]
pub struct Entry {
    name: String,
    directory: bool,
    symlink: bool,
    hidden: bool,
    size: Option<u64>,
    modified: Option<u32>,
    permissions: Option<u32>,
}
#[derive(Serialize)]
pub struct Listing {
    path: String,
    entries: Vec<Entry>,
}
struct Location {
    native: PathBuf,
    shown: String,
}
fn failure(e: io::Error) -> String {
    match e.kind() {
        io::ErrorKind::NotFound => "경로를 찾을 수 없습니다.".into(),
        io::ErrorKind::PermissionDenied => "권한이 없습니다.".into(),
        io::ErrorKind::AlreadyExists => "같은 이름의 항목이 이미 있습니다.".into(),
        _ => format!("파일 작업 실패: {e}"),
    }
}
fn lexical(path: &Path) -> PathBuf {
    let mut clean = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::ParentDir => {
                clean.pop();
            }
            other => clean.push(other.as_os_str()),
        }
    }
    clean
}
fn posix_parts(value: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    parts
}
fn locate(target: &Target, value: &str) -> Result<Location> {
    crate::sftp::path(value)?;
    if let Some(distribution) = target.id.strip_prefix("wsl:") {
        if !value.starts_with('/') {
            return Err("WSL 경로는 /로 시작해야 합니다.".into());
        }
        let parts = posix_parts(value);
        let mut native = PathBuf::from(format!(r"\\wsl.localhost\{distribution}\"));
        native.extend(&parts);
        return Ok(Location {
            native,
            shown: format!("/{}", parts.join("/")),
        });
    }
    let path = Path::new(value);
    if !path.is_absolute() {
        return Err("절대 경로를 입력하세요.".into());
    }
    let native = lexical(path);
    let shown = native.to_string_lossy().into_owned();
    Ok(Location { native, shown })
}
fn hidden(name: &str, metadata: Option<&fs::Metadata>) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.is_some_and(|m| m.file_attributes() & 0x2 != 0) {
            return true;
        }
    }
    #[cfg(not(windows))]
    let _ = metadata;
    name.starts_with('.')
}
fn modified(metadata: &fs::Metadata) -> Option<u32> {
    let seconds = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs();
    u32::try_from(seconds).ok()
}
fn permissions(metadata: &fs::Metadata) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        Some(metadata.permissions().mode())
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}
fn list(location: Location) -> Result<Listing> {
    let mut entries = Vec::new();
    for item in fs::read_dir(&location.native).map_err(failure)? {
        let item = item.map_err(failure)?;
        if entries.len() >= ENTRY_LIMIT {
            return Err("폴더 항목이 20,000개를 초과했습니다. 하위 폴더 경로로 이동하세요.".into());
        }
        let name = item.file_name().to_string_lossy().into_owned();
        let own = item.metadata().ok();
        let symlink = item.file_type().is_ok_and(|t| t.is_symlink());
        // Show what a link points to, while a broken or forbidden link still appears in the list.
        let resolved = if symlink {
            fs::metadata(item.path()).ok()
        } else {
            None
        };
        let shown = resolved.as_ref().or(own.as_ref());
        entries.push(Entry {
            hidden: hidden(&name, own.as_ref()),
            directory: shown.is_some_and(|m| m.is_dir()),
            size: shown.filter(|m| m.is_file()).map(|m| m.len()),
            modified: shown.and_then(modified),
            permissions: shown.and_then(permissions),
            symlink,
            name,
        });
    }
    Ok(Listing {
        path: location.shown,
        entries,
    })
}
// Windows treats a differently cased name as the same file, so only that rename may replace.
fn same_file_name(a: &Path, b: &Path) -> bool {
    cfg!(windows) && a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
}
fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}
fn change(operation: &str, path: &Path, value: Option<&Path>) -> Result<()> {
    match operation {
        "mkdir" => fs::create_dir(path).map_err(failure),
        "newfile" => fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map(drop)
            .map_err(failure),
        "rename" => {
            let destination = value.ok_or("새 이름을 입력하세요.")?;
            // fs::rename replaces an existing file, which a rename must never do silently.
            if exists(destination) && !same_file_name(path, destination) {
                return Err(failure(io::ErrorKind::AlreadyExists.into()));
            }
            fs::rename(path, destination).map_err(failure)
        }
        _ => Err("지원하지 않는 파일 작업".into()),
    }
}
fn remove(path: &Path) -> io::Result<()> {
    let kind = fs::symlink_metadata(path)?.file_type();
    if kind.is_dir() {
        // remove_dir_all removes a link inside the tree without entering its target.
        return fs::remove_dir_all(path);
    }
    fs::remove_file(path).or_else(|e| {
        // A Windows directory link or junction is deleted as a directory, not its target's files.
        if cfg!(windows) && kind.is_symlink() {
            fs::remove_dir(path)
        } else {
            Err(e)
        }
    })
}
fn copy_tree(from: &Path, to: &Path, depth: usize, count: &mut usize) -> Result<()> {
    *count += 1;
    if *count > ENTRY_LIMIT || depth > DEPTH_LIMIT {
        return Err("파일 작업은 20,000개/64단계까지 가능합니다.".into());
    }
    let kind = fs::symlink_metadata(from).map_err(failure)?.file_type();
    if kind.is_symlink() {
        return Err(format!("링크는 복사하지 않습니다: {}", from.display()));
    }
    if exists(to) {
        return Err(failure(io::ErrorKind::AlreadyExists.into()));
    }
    if kind.is_dir() {
        fs::create_dir(to).map_err(failure)?;
        for item in fs::read_dir(from).map_err(failure)? {
            let item = item.map_err(failure)?;
            copy_tree(&item.path(), &to.join(item.file_name()), depth + 1, count)?;
        }
        return Ok(());
    }
    if !kind.is_file() {
        return Err(format!("특수 파일은 복사하지 않습니다: {}", from.display()));
    }
    fs::copy(from, to).map(drop).map_err(failure)
}
fn transfer(operation: &str, from: &Path, directory: &Path) -> Result<()> {
    let name = from.file_name().ok_or("루트 경로는 변경할 수 없습니다.")?;
    let mut to = directory.join(name);
    // Same rule as SFTP and FTP: copying into the item's own folder makes a numbered copy.
    if operation == "copy" && to == from {
        let original = name.to_string_lossy();
        if let Some(free) = (1..1000)
            .map(|n| directory.join(format!("{original} 복사 {n}")))
            .find(|candidate| !exists(candidate))
        {
            to = free;
        }
    }
    if to.starts_with(from) {
        return Err("폴더를 자기 자신 안으로 옮기거나 복사할 수 없습니다.".into());
    }
    if exists(&to) {
        return Err(failure(io::ErrorKind::AlreadyExists.into()));
    }
    if operation == "move" {
        match fs::rename(from, &to) {
            Ok(()) => return Ok(()),
            // A drive or WSL boundary cannot rename; everything else is a real failure.
            Err(e) if e.kind() != io::ErrorKind::CrossesDevices => return Err(failure(e)),
            Err(_) => {}
        }
    }
    copy_tree(from, &to, 0, &mut 0)?;
    if operation == "move" {
        remove(from).map_err(|e| format!("복사했지만 원본을 지우지 못했습니다: {}", failure(e)))?;
    }
    Ok(())
}
fn batch(
    operation: &str,
    source: &Target,
    paths: &[String],
    directory: Option<PathBuf>,
) -> Outcome {
    let mut outcome = Outcome {
        completed: Vec::new(),
        errors: Vec::new(),
    };
    for path in paths {
        let result = locate(source, path).and_then(|location| {
            let native = location.native;
            if native.file_name().is_none() {
                return Err("루트 경로는 변경할 수 없습니다.".into());
            }
            match (operation, &directory) {
                ("delete", _) => remove(&native).map_err(failure),
                (_, Some(directory)) => transfer(operation, &native, directory),
                _ => Err("대상 폴더가 없습니다.".to_string()),
            }
        });
        match result {
            Ok(()) => outcome.completed.push(path.clone()),
            Err(e) => outcome.errors.push(format!("{path}: {e}")),
        }
    }
    outcome
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "파일 작업이 중단되었습니다.")?
}
#[tauri::command]
pub async fn local_files_home(state: State<'_, AppState>, target_id: String) -> Result<String> {
    let target = state.locals.target(&target_id)?;
    if target.id.starts_with("wsl:") {
        let mut command = tokio::process::Command::new(&target.program);
        command
            .args(&target.args)
            .args(["--exec", "pwd"])
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let output = tokio::time::timeout(Duration::from_secs(10), command.output())
            .await
            .map_err(|_| "WSL 응답 시간 초과")?
            .map_err(failure)?;
        let home = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(if home.starts_with('/') {
            home
        } else {
            "/".into()
        });
    }
    dirs::home_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or("홈 폴더를 찾지 못했습니다.".into())
}
#[tauri::command]
pub async fn local_files_list(
    state: State<'_, AppState>,
    target_id: String,
    path: String,
) -> Result<Listing> {
    let location = locate(&state.locals.target(&target_id)?, &path)?;
    blocking(move || list(location)).await
}
#[tauri::command]
pub async fn local_files_change(
    state: State<'_, AppState>,
    target_id: String,
    operation: String,
    path: String,
    value: Option<String>,
) -> Result<()> {
    let target = state.locals.target(&target_id)?;
    let path = locate(&target, &path)?.native;
    let value = value
        .map(|v| locate(&target, &v).map(|l| l.native))
        .transpose()?;
    blocking(move || change(&operation, &path, value.as_deref())).await
}
#[tauri::command]
pub async fn local_files_batch(
    state: State<'_, AppState>,
    source_target_id: String,
    target_id: String,
    operation: String,
    paths: Vec<String>,
    directory: Option<String>,
) -> Result<Outcome> {
    if !["copy", "move", "delete"].contains(&operation.as_str()) || paths.len() > 1000 {
        return Err("파일 작업 설정을 확인하세요.".into());
    }
    let source = state.locals.target(&source_target_id)?;
    let target = state.locals.target(&target_id)?;
    let directory = directory
        .map(|d| locate(&target, &d).map(|l| l.native))
        .transpose()?;
    blocking(move || Ok(batch(&operation, &source, &paths, directory))).await
}
#[tauri::command]
pub async fn local_files_edit(
    state: State<'_, AppState>,
    target_id: String,
    path: String,
    program: String,
    args: Vec<String>,
) -> Result<()> {
    let location = locate(&state.locals.target(&target_id)?, &path)?;
    blocking(move || {
        // Never interpolate a shell command. The file argument is always a separate argument.
        let mut command = std::process::Command::new(crate::editor_location::resolve(&program));
        command.args(args).arg(&location.native);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .spawn()
            .map_err(|_| "편집기를 실행할 수 없습니다. 프로그램 경로를 확인하세요.")?;
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell() -> Target {
        Target::for_test("powershell", "shell")
    }
    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "dachsterm-local-files-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }
    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn wsl_paths_stay_linux_and_cannot_leave_the_distribution_root() {
        let wsl = Target::for_test("wsl:Ubuntu", "wsl");
        let location = locate(&wsl, "/app/mesim/../../..//etc/./ssh").unwrap();
        assert_eq!(location.shown, "/etc/ssh");
        assert!(
            location
                .native
                .to_string_lossy()
                .starts_with(r"\\wsl.localhost\Ubuntu\")
        );
        assert_eq!(locate(&wsl, "/..").unwrap().shown, "/");
        assert!(locate(&wsl, "relative").is_err());
    }
    #[test]
    fn shell_paths_must_be_absolute_and_are_cleaned() {
        assert!(locate(&shell(), "relative/path").is_err());
        let root = scratch("clean");
        let shown = locate(&shell(), &text(&root.join("a").join("..").join("b")))
            .unwrap()
            .shown;
        assert_eq!(shown, text(&root.join("b")));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn listing_reports_folders_hidden_files_and_sizes() {
        let root = scratch("list");
        fs::create_dir(root.join("folder")).unwrap();
        fs::write(root.join("file.txt"), b"12345").unwrap();
        fs::write(root.join(".secret"), b"").unwrap();
        let listing = list(locate(&shell(), &text(&root)).unwrap()).unwrap();
        let find = |name: &str| listing.entries.iter().find(|e| e.name == name).unwrap();
        assert!(find("folder").directory);
        assert_eq!(find("file.txt").size, Some(5));
        assert!(!find("file.txt").hidden);
        assert!(find(".secret").hidden);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rename_and_new_file_never_replace_existing_files() {
        let root = scratch("replace");
        let (a, b) = (root.join("a.txt"), root.join("b.txt"));
        change("newfile", &a, None).unwrap();
        fs::write(&a, b"keep").unwrap();
        assert!(change("newfile", &a, None).is_err());
        fs::write(&b, b"other").unwrap();
        assert!(change("rename", &a, Some(&b)).is_err());
        assert_eq!(fs::read(&b).unwrap(), b"other");
        change("rename", &a, Some(&root.join("c.txt"))).unwrap();
        assert_eq!(fs::read(root.join("c.txt")).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn copy_move_and_delete_report_each_item() {
        let root = scratch("batch");
        let (from, to) = (root.join("from"), root.join("to"));
        fs::create_dir_all(from.join("inner")).unwrap();
        fs::create_dir(&to).unwrap();
        fs::write(from.join("inner").join("f.txt"), b"data").unwrap();
        let paths = [text(&from)];

        let copied = batch("copy", &shell(), &paths, Some(to.clone()));
        assert!(copied.errors.is_empty(), "{:?}", copied.errors);
        assert_eq!(
            fs::read(to.join("from").join("inner").join("f.txt")).unwrap(),
            b"data"
        );

        let again = batch("copy", &shell(), &paths, Some(to.clone()));
        assert_eq!((again.completed.len(), again.errors.len()), (0, 1));

        for numbered in ["from 복사 1", "from 복사 2"] {
            let beside = batch("copy", &shell(), &paths, Some(root.clone()));
            assert!(beside.errors.is_empty(), "{:?}", beside.errors);
            assert!(root.join(numbered).join("inner").join("f.txt").exists());
        }

        let inside = batch("move", &shell(), &paths, Some(from.join("inner")));
        assert_eq!(inside.errors.len(), 1);
        assert!(from.exists());

        let deleted = batch("delete", &shell(), &paths, None);
        assert!(deleted.errors.is_empty(), "{:?}", deleted.errors);
        assert!(!from.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn roots_cannot_be_deleted() {
        let root = if cfg!(windows) { r"C:\" } else { "/" };
        let outcome = batch("delete", &shell(), &[root.to_string()], None);
        assert_eq!((outcome.completed.len(), outcome.errors.len()), (0, 1));
    }
}
