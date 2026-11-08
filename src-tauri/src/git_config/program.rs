//! Which git this PC's tabs run (GE.10): the one the app finds, or a file the user picked. A
//! picked file that is gone or does not run is reported as it is and never replaced by the found
//! one, since the user chose it for a reason. WSL and servers use the git on their own `PATH`.
use super::failure_text;
use crate::{
    AppState,
    git_credential::find_git_program,
    git_run::{GitHost, args, git_run},
    remote_exec::Limits,
    storage::{Result, Store},
};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::RwLock,
    time::Duration,
};
use tauri::Manager;

const KEY: &str = "git-program";
const CORRUPT: &str = "저장한 Git 위치를 읽지 못했습니다. 자동 찾기로 되돌리거나 다시 지정하세요.";
const LIMITS: Limits = Limits {
    timeout: Duration::from_secs(5),
    max_output: 64 * 1024,
};

#[derive(Clone, Debug, PartialEq, Eq)]
enum Choice {
    Automatic,
    Picked(PathBuf),
    /// The saved value could not be read. No git runs until the user sets it again.
    Damaged,
}

/// Read by code that has no access to the store, such as `GitHost::local`.
static CHOICE: RwLock<Choice> = RwLock::new(Choice::Automatic);

fn choice() -> Choice {
    CHOICE.read().unwrap().clone()
}

fn saved(store: &Store) -> Choice {
    match store
        .setting(KEY)
        .map(|v| serde_json::from_str::<Option<String>>(&v))
    {
        Ok(Ok(None)) => Choice::Automatic,
        Ok(Ok(Some(path))) => Choice::Picked(PathBuf::from(path)),
        _ => Choice::Damaged,
    }
}

/// The app starts either way; a damaged value is reported in the settings.
pub fn load(store: &Store) {
    *CHOICE.write().unwrap() = saved(store);
}

/// `/usr/bin/git` is a stub that opens an installer while the Command Line Tools are missing.
#[cfg(target_os = "macos")]
fn mac_stub(path: &Path) -> bool {
    path == Path::new("/usr/bin/git") && !crate::git_credential::command_line_tools()
}

#[cfg(not(target_os = "macos"))]
fn mac_stub(_path: &Path) -> bool {
    false
}

fn resolved(choice: Choice, find: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
    match choice {
        Choice::Automatic => find(),
        Choice::Picked(path) => (!mac_stub(&path)).then_some(path),
        Choice::Damaged => None,
    }
}

/// The git this PC's tabs run, or `None` when there is none to run.
pub fn current() -> Option<PathBuf> {
    resolved(choice(), find_git_program)
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitProgramInfo {
    /// The file the user picked, if any.
    pub chosen: Option<String>,
    /// What the automatic search finds.
    pub found: Option<String>,
    /// `git --version` of the git in use.
    pub version: Option<String>,
    /// Why the git in use cannot run.
    pub problem: Option<String>,
}

/// Runs the file once. A picked file need not be called `git`, so its answer decides.
async fn probe(path: &Path) -> Result<String> {
    if mac_stub(path) {
        return Err(
            "명령줄 도구가 설치되어 있지 않아 /usr/bin/git을 실행할 수 없습니다. 터미널에서 \
             xcode-select --install을 실행한 뒤 다시 시도하세요."
                .into(),
        );
    }
    if !tokio::fs::metadata(path).await.is_ok_and(|m| m.is_file()) {
        return Err(format!("지정한 Git 파일이 없습니다: {}", path.display()));
    }
    let host = GitHost::Native(Some(path.to_path_buf()));
    let folder = std::env::temp_dir().to_string_lossy().into_owned();
    let output = git_run(&host, &folder, &[args(["--version"])], LIMITS)
        .await
        .map_err(failure_text)?;
    let text = String::from_utf8_lossy(&output.stdout);
    let version = text.trim();
    if output.exit == Some(0) && version.starts_with("git version") {
        Ok(version.to_string())
    } else {
        Err(format!("Git이 아닙니다: {}", path.display()))
    }
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

async fn info() -> GitProgramInfo {
    let found = tokio::task::spawn_blocking(find_git_program)
        .await
        .ok()
        .flatten();
    let choice = choice();
    let chosen = match &choice {
        Choice::Picked(path) => Some(path.clone()),
        _ => None,
    };
    let in_use = match &choice {
        Choice::Automatic => found.clone(),
        Choice::Picked(path) => Some(path.clone()),
        Choice::Damaged => None,
    };
    let (version, problem) = match (in_use, choice) {
        (_, Choice::Damaged) => (None, Some(CORRUPT.to_string())),
        (None, _) => (None, None),
        (Some(path), _) => match probe(&path).await {
            Ok(version) => (Some(version), None),
            Err(problem) => (None, Some(problem)),
        },
    };
    GitProgramInfo {
        chosen: chosen.as_deref().map(text),
        found: found.as_deref().map(text),
        version,
        problem,
    }
}

#[tauri::command]
pub async fn git_program_info() -> Result<GitProgramInfo> {
    Ok(info().await)
}

/// Only asks which file: `git_program_set` checks and saves it.
#[tauri::command]
pub async fn git_program_pick() -> Result<Option<String>> {
    let mut dialog = rfd::AsyncFileDialog::new().set_title("Git 실행 파일 선택");
    if cfg!(windows) {
        dialog = dialog.add_filter("Git 실행 파일", &["exe"]);
    }
    Ok(dialog.pick_file().await.map(|file| text(file.path())))
}

/// `None` goes back to the automatic search. A file that does not run is refused and the previous
/// setting stays.
#[tauri::command]
pub async fn git_program_set(
    app: tauri::AppHandle,
    path: Option<String>,
) -> Result<GitProgramInfo> {
    let next = match path {
        None => Choice::Automatic,
        Some(path) => {
            let path = PathBuf::from(path);
            if !path.is_absolute() {
                return Err("Git 실행 파일은 전체 경로로 지정하세요.".into());
            }
            probe(&path).await?;
            Choice::Picked(path)
        }
    };
    let value = match &next {
        Choice::Picked(path) => serde_json::to_string(&text(path)),
        _ => serde_json::to_string(&None::<String>),
    }
    .map_err(|_| "Git 위치를 저장하지 못했습니다.")?;
    tokio::task::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state.mutation.lock().unwrap();
        state.store.set_setting(KEY, &value)
    })
    .await
    .map_err(|_| "Git 위치를 저장하지 못했습니다.")??;
    *CHOICE.write().unwrap() = next;
    Ok(info().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Store, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (Store::open(&dir.path().join("test.db")).unwrap(), dir)
    }

    #[test]
    fn the_saved_value_reads_back_and_damage_is_not_automatic() {
        let (store, _dir) = store();
        assert_eq!(saved(&store), Choice::Automatic);
        store.set_setting(KEY, "null").unwrap();
        assert_eq!(saved(&store), Choice::Automatic);
        store.set_setting(KEY, "\"/opt/git\"").unwrap();
        assert_eq!(saved(&store), Choice::Picked("/opt/git".into()));
        store.set_setting(KEY, "{broken").unwrap();
        assert_eq!(saved(&store), Choice::Damaged);
        store.set_setting(KEY, "5").unwrap();
        assert_eq!(saved(&store), Choice::Damaged);
    }

    #[test]
    fn a_picked_file_is_used_without_the_search() {
        let searched = || -> Option<PathBuf> { panic!("no search") };
        assert_eq!(
            resolved(Choice::Picked("/opt/git".into()), searched),
            Some("/opt/git".into())
        );
        assert_eq!(resolved(Choice::Damaged, searched), None);
        assert_eq!(
            resolved(Choice::Automatic, || Some("/usr/local/bin/git".into())),
            Some("/usr/local/bin/git".into())
        );
    }

    #[tokio::test]
    async fn a_missing_file_is_reported_as_missing() {
        let gone = std::env::temp_dir().join("dachsterm-no-such-git");
        let problem = probe(&gone).await.unwrap_err();
        assert!(
            problem.starts_with("지정한 Git 파일이 없습니다"),
            "{problem}"
        );
    }

    #[tokio::test]
    async fn the_real_git_answers_with_its_version() {
        let Some(program) = find_git_program() else {
            return;
        };
        assert!(probe(&program).await.unwrap().starts_with("git version"));
    }

    /// A program that exits normally but is not git.
    #[cfg(windows)]
    #[tokio::test]
    async fn another_program_is_not_git() {
        let hostname = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("hostname.exe");
        let problem = probe(&hostname).await.unwrap_err();
        assert!(problem.starts_with("Git이 아닙니다"), "{problem}");
    }
}
