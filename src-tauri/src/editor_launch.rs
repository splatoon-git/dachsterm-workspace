//! Which external editor launches the app allows (S.11, architecture-review B11). The program and
//! its arguments come from the web view, so a script running there must not be able to start any
//! program it likes, or a known editor with arguments that load code (VS Code's
//! `--extensionDevelopmentPath`). A launch runs without asking when it is a known editor found on
//! this PC with no extra arguments, or one the user allowed outside the web view: a program picked
//! in the file dialog, or a launch confirmed in the native dialog this module shows.
use crate::{
    AppState,
    editor_location::{Installed, installed},
    storage::{Result, Store},
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const KEY: &str = "editor-launches";
/// The oldest allowed launch is forgotten first; it is asked again when it is used.
const MAX_ALLOWED: usize = 32;
const DAMAGED: &str = "외부 편집기 허용 기록을 읽지 못했습니다. 편집기 선택에서 실행 파일을 다시 고르면 새로 기록합니다.";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Launch {
    program: String,
    args: Vec<String>,
}

fn malformed(launch: &Launch) -> bool {
    let bad = |s: &String| s.len() > 4096 || s.chars().any(char::is_control);
    launch.program.trim().is_empty()
        || bad(&launch.program)
        || launch.args.len() > 32
        || launch.args.iter().any(bad)
}

/// True when the launch may run without asking.
fn known(launch: &Launch, installed: &[Installed]) -> bool {
    launch.args.is_empty()
        && installed
            .iter()
            .any(|e| e.id == launch.program || e.path == launch.program)
}

fn allowed(store: &Store) -> Result<Vec<Launch>> {
    serde_json::from_str::<Option<Vec<Launch>>>(&store.setting(KEY)?)
        .map(Option::unwrap_or_default)
        .map_err(|_| DAMAGED.into())
}

/// A damaged record is replaced only from here, after the user acted outside the web view.
fn remember(store: &Store, launch: Launch) -> Result<()> {
    let mut list = allowed(store).unwrap_or_default();
    list.retain(|l| *l != launch);
    list.push(launch);
    let skip = list.len().saturating_sub(MAX_ALLOWED);
    let value = serde_json::to_string(&list[skip..]).map_err(|_| DAMAGED)?;
    store.set_setting(KEY, &value)
}

async fn save(app: &AppHandle, launch: Launch) -> Result<()> {
    let handle = app.clone();
    blocking(move || {
        let state = handle.state::<AppState>();
        let _guard = state.mutation.lock().unwrap();
        remember(&state.store, launch)
    })
    .await
}

/// Native test runs (`test-native.mjs`) launch a helper in place of an editor. Debug builds only.
fn test_editor(launch: &Launch) -> bool {
    #[cfg(debug_assertions)]
    if let Some(program) = std::env::var_os("DACHSTERM_TEST_EDITOR") {
        return program == launch.program.as_str();
    }
    let _ = launch;
    false
}

fn describe(launch: &Launch) -> String {
    let mut text = format!(
        "아래 프로그램으로 파일을 엽니다. 처음 쓰는 편집기 설정이라 확인합니다.\n\n프로그램: {}",
        launch.program
    );
    for (i, arg) in launch.args.iter().enumerate() {
        text.push_str(&format!("\n인자 {}: {arg}", i + 1));
    }
    text.push_str(
        "\n\n직접 설정한 편집기가 맞을 때만 허용하세요. 허용하면 다음부터 묻지 않습니다.",
    );
    text
}

async fn confirm(launch: &Launch) -> bool {
    rfd::AsyncMessageDialog::new()
        .set_title("외부 편집기 실행 확인")
        .set_description(describe(launch))
        .set_level(rfd::MessageLevel::Warning)
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        .await
        == rfd::MessageDialogResult::Yes
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "외부 편집기 설정을 확인하지 못했습니다.".to_string())?
}

/// Called before an editor starts. Asks the user, outside the web view, about a launch it has not
/// seen, and refuses when the user does not allow it.
pub async fn check(app: &AppHandle, program: &str, args: &[String]) -> Result<()> {
    let launch = Launch {
        program: program.into(),
        args: args.to_vec(),
    };
    if malformed(&launch) {
        return Err("편집기 실행 설정 오류".into());
    }
    if test_editor(&launch) {
        return Ok(());
    }
    let (handle, probe) = (app.clone(), launch.clone());
    let trusted = blocking(move || {
        Ok(known(&probe, &installed())
            || allowed(&handle.state::<AppState>().store)?.contains(&probe))
    })
    .await?;
    if trusted {
        return Ok(());
    }
    if !confirm(&launch).await {
        return Err("외부 편집기 실행을 허용하지 않았습니다.".into());
    }
    save(app, launch).await
}

/// A program the user picked in the native file dialog runs without arguments from then on.
pub async fn picked(app: &AppHandle, program: String) -> Result<()> {
    let launch = Launch {
        program,
        args: vec![],
    };
    if malformed(&launch) {
        return Err("이 파일은 편집기로 쓸 수 없습니다.".into());
    }
    save(app, launch).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(program: &str, args: &[&str]) -> Launch {
        Launch {
            program: program.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
        }
    }

    fn code() -> Vec<Installed> {
        vec![Installed {
            id: "code",
            name: "Visual Studio Code",
            path: "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code".into(),
        }]
    }

    /// S.11: the web view used to start whatever program and arguments it sent.
    #[test]
    fn only_a_known_editor_without_arguments_runs_unasked() {
        let installed = code();
        assert!(known(&launch("code", &[]), &installed));
        assert!(known(&launch(&installed[0].path, &[]), &installed));
        for other in [
            launch("cmd.exe", &["/c", "calc"]),
            launch("/bin/sh", &["-c", "id"]),
            launch("code", &["--extensionDevelopmentPath=/tmp/x"]),
            launch("vim", &[]),
            launch("zed", &[]),
        ] {
            assert!(!known(&other, &installed), "{other:?}");
        }
    }

    #[test]
    fn refuses_control_characters_and_oversized_launches() {
        assert!(malformed(&launch("", &[])));
        assert!(malformed(&launch("code", &["a\nb"])));
        assert!(malformed(&launch("code\r", &[])));
        assert!(malformed(&launch("code", &["x"; 33])));
        assert!(!malformed(&launch("C:/Tools/edit.exe", &["-n", "a b"])));
    }

    #[test]
    fn remembers_allowed_launches_and_forgets_the_oldest() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        assert!(allowed(&store).unwrap().is_empty());
        let first = launch("/opt/edit", &["-n"]);
        remember(&store, first.clone()).unwrap();
        remember(&store, first.clone()).unwrap();
        assert_eq!(allowed(&store).unwrap(), vec![first.clone()]);
        for i in 0..MAX_ALLOWED {
            remember(&store, launch(&format!("/opt/{i}"), &[])).unwrap();
        }
        let list = allowed(&store).unwrap();
        assert_eq!(list.len(), MAX_ALLOWED);
        assert!(!list.contains(&first));
    }

    #[test]
    fn a_damaged_record_is_an_error_until_the_user_picks_again() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        store.set_setting(KEY, "{").unwrap();
        assert_eq!(allowed(&store).unwrap_err(), DAMAGED);
        remember(&store, launch("/opt/edit", &[])).unwrap();
        assert_eq!(allowed(&store).unwrap(), vec![launch("/opt/edit", &[])]);
    }
}
