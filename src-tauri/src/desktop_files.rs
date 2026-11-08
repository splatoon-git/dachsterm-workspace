//! Handing files to this computer's desktop: a native drag out of a file panel, and showing an
//! item in the file manager. Server files are fetched to a private folder first, because the
//! desktop only takes paths of this computer.
use crate::{
    AppState, editor, ftp, local_files, sftp, source::Source, ssh::Connections, storage::Result,
    transfer_queue,
};
use std::{
    path::{Path, PathBuf},
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::State;
use tokio::io::{AsyncRead, AsyncReadExt};

const FOLDER: &str = "drag-out";
const REMOTE_LIMIT: u64 = 10 * 1024 * 1024;
const PATH_LIMIT: usize = 1000;
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);
const USE_DOWNLOAD: &str =
    "서버 파일은 합쳐서 10MiB까지 끌어낼 수 있습니다. 폴더나 큰 파일은 다운로드를 쓰세요.";

type Fetched = Vec<(String, Vec<u8>)>;

/// The paths of the drag about to start. The window names them by id, so it can only start a drag
/// of what `files_drag_prepare` checked. A newer drag replaces an unused one.
#[derive(Default)]
pub struct DragOuts {
    ready: Mutex<Option<Prepared>>,
    folder_private: AtomicBool,
}
struct Prepared {
    id: String,
    paths: Vec<PathBuf>,
}
impl DragOuts {
    fn keep(&self, paths: Vec<PathBuf>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        *self.ready.lock().unwrap() = Some(Prepared {
            id: id.clone(),
            paths,
        });
        id
    }
    fn take(&self, id: &str) -> Option<Vec<PathBuf>> {
        let mut ready = self.ready.lock().unwrap();
        if ready.as_ref().is_some_and(|p| p.id == id) {
            return ready.take().map(|p| p.paths);
        }
        None
    }
}

/// Server files stay until the app exits, since the drop target may still be copying them. A crash
/// leaves them behind, so the next start clears them too; only one instance runs at a time.
pub fn clear_fetched(app_data: &Path) {
    let _ = std::fs::remove_dir_all(app_data.join(FOLDER));
}

/// The shell cannot build one drag from items of different folders (the drag crate panics).
fn same_parent(paths: &[PathBuf]) -> Result<()> {
    let parent = paths.first().and_then(|p| p.parent());
    if parent.is_none() || paths.iter().any(|p| p.parent() != parent) {
        return Err("같은 폴더의 항목만 함께 끌어낼 수 있습니다.".into());
    }
    Ok(())
}
fn existing(paths: &[PathBuf]) -> Result<()> {
    if paths.iter().any(|p| std::fs::symlink_metadata(p).is_err()) {
        return Err("경로를 찾을 수 없습니다.".into());
    }
    Ok(())
}
/// Splits remote paths into their one folder and the item names.
fn remote_folder(paths: &[String]) -> Result<(&str, Vec<&str>)> {
    let mut folder = None;
    let mut names = Vec::with_capacity(paths.len());
    for path in paths {
        sftp::path(path)?;
        let (parent, name) = path
            .trim_end_matches('/')
            .rsplit_once('/')
            .ok_or("서버 경로를 확인하세요.")?;
        let parent = if parent.is_empty() { "/" } else { parent };
        if *folder.get_or_insert(parent) != parent {
            return Err("같은 폴더의 항목만 함께 끌어낼 수 있습니다.".into());
        }
        names.push(name);
    }
    Ok((folder.ok_or("서버 경로를 확인하세요.")?, names))
}
/// Checks the listing before anything is fetched. A link may lead to a folder of any size.
fn within_limit(entries: &[sftp::Entry], names: &[&str]) -> Result<()> {
    let mut total = 0u64;
    for name in names {
        transfer_queue::component(name)?;
        let entry = entries
            .iter()
            .find(|e| e.name == *name)
            .ok_or("경로를 찾을 수 없습니다.")?;
        if entry.directory || entry.symlink {
            return Err(USE_DOWNLOAD.into());
        }
        total = total.saturating_add(entry.size.unwrap_or(0));
    }
    if total > REMOTE_LIMIT {
        return Err(USE_DOWNLOAD.into());
    }
    Ok(())
}
/// Reads at most `left` bytes in all, because a file can grow after it was listed.
async fn read_capped(
    reader: impl AsyncRead + Unpin,
    left: &mut u64,
) -> std::io::Result<Option<Vec<u8>>> {
    let mut data = Vec::new();
    reader.take(*left + 1).read_to_end(&mut data).await?;
    if data.len() as u64 > *left {
        return Ok(None);
    }
    *left -= data.len() as u64;
    Ok(Some(data))
}
async fn read_sftp(connections: &Connections, id: &str, paths: &[String]) -> Result<Fetched> {
    let (folder, names) = remote_folder(paths)?;
    within_limit(&sftp::list(connections, id, folder).await?.entries, &names)?;
    let session = sftp::open(connections, id).await?;
    let mut left = REMOTE_LIMIT;
    let mut files = Vec::with_capacity(paths.len());
    for (path, name) in paths.iter().zip(names) {
        let file = session.open(path).await.map_err(sftp::failure)?;
        let data = read_capped(file, &mut left)
            .await
            .map_err(sftp::failure)?
            .ok_or(USE_DOWNLOAD)?;
        files.push((name.to_string(), data));
    }
    Ok(files)
}
async fn read_ftp(session: &ftp::Session, paths: &[String]) -> Result<Fetched> {
    const FAILED: &str = "FTP 서버에서 파일을 받지 못했습니다.";
    let (folder, names) = remote_folder(paths)?;
    for path in paths {
        ftp::path(path)?;
    }
    within_limit(&ftp::list(session, folder).await?.entries, &names)?;
    let mut stream = session.open().await?;
    let mut left = REMOTE_LIMIT;
    let mut files = Vec::with_capacity(paths.len());
    for (path, name) in paths.iter().zip(names) {
        let mut input = stream.retr_as_stream(path).await.map_err(|_| FAILED)?;
        let Some(data) = read_capped(&mut input, &mut left)
            .await
            .map_err(|_| FAILED)?
        else {
            let _ = stream.abort(input).await;
            return Err(USE_DOWNLOAD.into());
        };
        input.finish().await.map_err(|_| FAILED)?;
        files.push((name.to_string(), data));
    }
    let _ = stream.quit().await;
    Ok(files)
}
/// Writes one drag's files into a folder of its own, under their real names, which is what the
/// drop target will call them. Names differing only by case collide on Windows and are refused
/// instead of replaced.
fn store(root: &Path, private: bool, files: Fetched) -> Result<Vec<PathBuf>> {
    if private {
        editor::private_directory(root)?;
    }
    let folder = root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir(&folder).map_err(sftp::failure)?;
    let mut paths = Vec::with_capacity(files.len());
    for (name, data) in files {
        let path = folder.join(name);
        let written = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .and_then(|mut file| std::io::Write::write_all(&mut file, &data));
        if let Err(e) = written {
            let _ = std::fs::remove_dir_all(&folder);
            return Err(sftp::failure(e));
        }
        paths.push(path);
    }
    Ok(paths)
}
async fn stored(
    state: &AppState,
    fetch: impl Future<Output = Result<Fetched>>,
) -> Result<Vec<PathBuf>> {
    let files = tokio::time::timeout(FETCH_TIMEOUT, fetch)
        .await
        .map_err(|_| "서버에서 파일을 받는 시간이 초과되었습니다. 다운로드를 쓰세요.")??;
    let root = state.directory.join(FOLDER);
    let private = !state.drag_outs.folder_private.load(Ordering::Relaxed);
    let paths = local_files::blocking(move || store(&root, private, files)).await?;
    state
        .drag_outs
        .folder_private
        .store(true, Ordering::Relaxed);
    Ok(paths)
}

/// Checks a drag and fetches server files, then gives the id `files_drag_out` starts it with. It
/// is a separate step so the window can see whether the button is still held after the fetch: a
/// native drag begun with the button up would drop at once on Windows.
#[tauri::command]
pub async fn files_drag_prepare(
    state: State<'_, AppState>,
    source: Source,
    paths: Vec<String>,
) -> Result<String> {
    if paths.is_empty() || paths.len() > PATH_LIMIT {
        return Err("끌어낼 항목을 확인하세요.".into());
    }
    let prepared = match source {
        Source::Local { target_id } => {
            let target = state.locals.target(&target_id)?;
            let natives = paths
                .iter()
                .map(|path| local_files::native_path(&target, path))
                .collect::<Result<Vec<_>>>()?;
            same_parent(&natives)?;
            local_files::blocking(move || existing(&natives).map(|()| natives)).await?
        }
        Source::Ssh { connection_id } => {
            stored(
                &state,
                read_sftp(&state.connections, &connection_id, &paths),
            )
            .await?
        }
        Source::Ftp { connection_id } => {
            let session = state.connections.ftp_session(&connection_id)?;
            stored(&state, read_ftp(&session, &paths)).await?
        }
    };
    Ok(state.drag_outs.keep(prepared))
}

/// Starts the native drag and returns when it has ended.
#[tauri::command]
pub async fn files_drag_out(
    window: tauri::Window,
    state: State<'_, AppState>,
    id: String,
) -> Result<()> {
    let paths = state
        .drag_outs
        .take(&id)
        .ok_or("끌어낼 항목을 다시 선택하세요.")?;
    start_drag(window, paths).await
}

#[cfg(any(windows, target_os = "macos"))]
async fn start_drag(window: tauri::Window, paths: Vec<PathBuf>) -> Result<()> {
    use std::sync::Arc;
    // A session that never reports its end must not keep the window ignoring drops for good.
    const ENDS_WITHIN: Duration = Duration::from_secs(120);
    const ICON: &[u8] = include_bytes!("../icons/32x32.png");
    let (done, ended) = tokio::sync::oneshot::channel::<Result<()>>();
    let done = Arc::new(Mutex::new(Some(done)));
    let finish = move |result: Result<()>| {
        if let Some(done) = done.lock().unwrap().take() {
            let _ = done.send(result);
        }
    };
    let target = window.clone();
    // Windows blocks in its own drag loop here; macOS returns and reports the end later.
    window
        .run_on_main_thread(move || {
            let at_end = finish.clone();
            let started = drag::start_drag(
                &target,
                drag::DragItem::Files(paths),
                drag::Image::Raw(ICON.to_vec()),
                move |_, _| at_end(Ok(())),
                drag::Options::default(),
            );
            if started.is_err() {
                finish(Err("끌어내기를 시작하지 못했습니다.".into()));
            }
        })
        .map_err(|_| "끌어내기를 시작하지 못했습니다.")?;
    match tokio::time::timeout(ENDS_WITHIN, ended).await {
        Ok(result) => result.map_err(|_| "끌어내기가 중단되었습니다.")?,
        Err(_) => Ok(()),
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
async fn start_drag(_window: tauri::Window, _paths: Vec<PathBuf>) -> Result<()> {
    Err("이 OS에서는 끌어내기를 지원하지 않습니다.".into())
}

/// Opens the file manager with the item selected. Only files of this computer can be shown.
#[tauri::command]
pub async fn files_reveal(state: State<'_, AppState>, source: Source, path: String) -> Result<()> {
    let Source::Local { target_id } = source else {
        return Err("서버 파일은 이 컴퓨터의 파일 관리자에서 볼 수 없습니다.".into());
    };
    let native = local_files::native_path(&state.locals.target(&target_id)?, &path)?;
    local_files::blocking(move || {
        existing(std::slice::from_ref(&native))?;
        show_in_file_manager(&native)
    })
    .await
}

/// `/select,` takes the path in its own quotes, which Rust's argument quoting would wrap again.
#[cfg(windows)]
fn select_argument(path: &Path) -> Result<std::ffi::OsString> {
    let text = path.as_os_str();
    if text.to_string_lossy().contains('"') {
        return Err("이 파일 이름은 탐색기에서 선택할 수 없습니다.".into());
    }
    let mut argument = std::ffi::OsString::from("/select,\"");
    argument.push(text);
    argument.push("\"");
    Ok(argument)
}
#[cfg(windows)]
fn show_in_file_manager(path: &Path) -> Result<()> {
    use std::os::windows::process::CommandExt;
    let system = std::env::var_os("SystemRoot").ok_or("Windows 경로를 찾지 못했습니다.")?;
    // explorer.exe reports failure even when the window opens, so only starting it is checked.
    std::process::Command::new(PathBuf::from(system).join("explorer.exe"))
        .raw_arg(select_argument(path)?)
        .spawn()
        .map(drop)
        .map_err(|_| "탐색기를 실행할 수 없습니다.".to_string())
}
#[cfg(target_os = "macos")]
fn show_in_file_manager(path: &Path) -> Result<()> {
    let shown = std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(path)
        .status()
        .map_err(|_| "Finder를 실행할 수 없습니다.")?;
    if !shown.success() {
        return Err("Finder에서 항목을 보여 주지 못했습니다.".into());
    }
    Ok(())
}
#[cfg(not(any(windows, target_os = "macos")))]
fn show_in_file_manager(_path: &Path) -> Result<()> {
    Err("이 OS에서는 파일 관리자 열기를 지원하지 않습니다.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, directory: bool, symlink: bool, size: u64) -> sftp::Entry {
        sftp::Entry {
            name: name.into(),
            directory,
            symlink,
            size: Some(size),
            modified: None,
            permissions: None,
        }
    }
    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "dachsterm-desktop-files-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn a_drag_holds_items_of_one_folder() {
        let (a, b) = (PathBuf::from("/x/a"), PathBuf::from("/x/b"));
        assert!(same_parent(&[a.clone(), b]).is_ok());
        assert!(same_parent(&[a, PathBuf::from("/y/c")]).is_err());
        assert!(same_parent(&[PathBuf::from("/")]).is_err());
        assert!(same_parent(&[]).is_err());
    }

    #[test]
    fn remote_paths_split_into_one_folder_and_names() {
        let paths = ["/srv/a.txt".to_string(), "/srv/b.txt".to_string()];
        assert_eq!(
            remote_folder(&paths).unwrap(),
            ("/srv", vec!["a.txt", "b.txt"])
        );
        assert_eq!(
            remote_folder(&["/a.txt".to_string()]).unwrap(),
            ("/", vec!["a.txt"])
        );
        assert!(remote_folder(&["/srv/a".to_string(), "/srv/sub/b".to_string()]).is_err());
        assert!(remote_folder(&["relative".to_string()]).is_err());
    }

    #[test]
    fn only_small_plain_files_are_fetched() {
        let entries = [
            entry("small", false, false, 10),
            entry("exact", false, false, REMOTE_LIMIT),
            entry("big", false, false, REMOTE_LIMIT + 1),
            entry("folder", true, false, 0),
            entry("link", false, true, 1),
        ];
        assert!(within_limit(&entries, &["small"]).is_ok());
        assert!(within_limit(&entries, &["exact"]).is_ok());
        for names in [
            &["big"][..],
            &["folder"],
            &["link"],
            &["missing"],
            &["small", "exact"],
        ] {
            assert!(within_limit(&entries, names).is_err(), "{names:?}");
        }
    }

    #[test]
    fn a_name_from_the_server_cannot_leave_the_drag_folder() {
        let entries = [
            entry("..\\evil", false, false, 1),
            entry("..", false, false, 1),
        ];
        assert!(within_limit(&entries, &["..\\evil"]).is_err());
        assert!(within_limit(&entries, &[".."]).is_err());
    }

    #[tokio::test]
    async fn reading_stops_at_the_budget_shared_by_all_files() {
        let mut left = 5;
        assert_eq!(
            read_capped(&b"abc"[..], &mut left).await.unwrap(),
            Some(b"abc".to_vec())
        );
        assert_eq!(left, 2);
        assert_eq!(read_capped(&b"abc"[..], &mut left).await.unwrap(), None);
    }

    #[test]
    fn each_drag_keeps_its_files_under_their_own_names() {
        let root = scratch("store");
        let first = store(&root, false, vec![("한글 이름.txt".into(), b"a".to_vec())]).unwrap();
        let second = store(&root, false, vec![("한글 이름.txt".into(), b"b".to_vec())]).unwrap();
        assert_ne!(first[0].parent(), second[0].parent());
        assert_eq!(first[0].file_name().unwrap(), "한글 이름.txt");
        assert_eq!(std::fs::read(&first[0]).unwrap(), b"a");
        assert_eq!(std::fs::read(&second[0]).unwrap(), b"b");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_name_collision_is_refused_and_leaves_nothing() {
        let root = scratch("collision");
        let files = vec![("same".to_string(), vec![1]), ("same".to_string(), vec![2])];
        assert!(store(&root, false, files).is_err());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clearing_removes_what_earlier_drags_left() {
        let app_data = scratch("clear");
        let root = app_data.join(FOLDER);
        std::fs::create_dir(&root).unwrap();
        store(&root, false, vec![("a".into(), vec![1])]).unwrap();
        clear_fetched(&app_data);
        assert!(!root.exists());
        std::fs::remove_dir_all(app_data).unwrap();
    }

    #[test]
    fn a_prepared_drag_starts_once_and_only_by_its_id() {
        let drags = DragOuts::default();
        let old = drags.keep(vec![PathBuf::from("/old")]);
        let id = drags.keep(vec![PathBuf::from("/new")]);
        assert_eq!(drags.take(&old), None);
        assert_eq!(drags.take("other"), None);
        assert_eq!(drags.take(&id), Some(vec![PathBuf::from("/new")]));
        assert_eq!(drags.take(&id), None);
    }

    #[cfg(windows)]
    #[test]
    fn explorer_gets_one_quoted_path() {
        assert_eq!(
            select_argument(Path::new(r"C:\a b\한글.txt")).unwrap(),
            r#"/select,"C:\a b\한글.txt""#
        );
        assert!(select_argument(Path::new(r#"\\wsl.localhost\U\a"b"#)).is_err());
    }
}
