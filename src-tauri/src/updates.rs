//! App updates (CG.6): finding a newer release, fetching its signed package, and restarting into
//! it. The web view gets none of the updater plugin's own commands. These commands keep the
//! setting that turns the automatic check off, and they close every session before the app is
//! replaced, the way quitting does.
//!
//! A build without the release public key (`plugins.updater.pubkey`) never checks: a package can
//! only be trusted through that key, and the key is set only for release builds.
use crate::{AppState, storage::Result};
use serde::Serialize;
use std::{
    path::Path,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Error, Update, UpdaterExt};

const AUTO_KEY: &str = "update.auto";
/// The release manifest is a small file. A check that has not answered by then has failed.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// The whole package download, which the plugin bounds with the same timeout as the check.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Default, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Phase {
    #[default]
    Idle,
    Checking,
    /// The last check found nothing newer. `checked` is in seconds since the epoch.
    Latest {
        checked: u64,
    },
    Available {
        version: String,
        notes: Option<String>,
        date: Option<String>,
    },
    Downloading {
        version: String,
        received: u64,
        total: Option<u64>,
    },
    /// The package is verified and being put in place. The app restarts once it is.
    Installing {
        version: String,
    },
    Failed {
        message: String,
    },
}

impl Phase {
    fn busy(&self) -> bool {
        matches!(
            self,
            Phase::Checking | Phase::Downloading { .. } | Phase::Installing { .. }
        )
    }
}

#[derive(Default)]
pub struct Updates {
    phase: Mutex<Phase>,
    found: Mutex<Option<Update>>,
}

impl Updates {
    fn set(&self, phase: Phase) {
        *self.phase.lock().unwrap() = phase;
    }
    /// Moves to `next` unless a check or an install is already running.
    fn start(&self, next: Phase) -> bool {
        let mut phase = self.phase.lock().unwrap();
        if phase.busy() {
            return false;
        }
        *phase = next;
        true
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current: String,
    /// Checks on start and once a day while the app stays open.
    auto: bool,
    /// Why this build cannot update itself, when it cannot.
    unavailable: Option<&'static str>,
    phase: Phase,
}

/// Why updating cannot work for this build or from where it runs. Pure, for tests.
fn unavailable(release: bool, pubkey: &str, exe: &Path) -> Option<&'static str> {
    if !release {
        return Some("개발 빌드는 업데이트하지 않습니다.");
    }
    if pubkey.trim().is_empty() {
        return Some("이 빌드에는 업데이트 서명 공개 키가 없어 새 버전을 받지 않습니다.");
    }
    if cfg!(target_os = "macos") {
        let path = exe.to_string_lossy();
        if !path.contains(".app/Contents/MacOS/") {
            return Some("앱 번들 밖에서 실행 중이라 업데이트할 수 없습니다.");
        }
        // An unsigned app opened from the download folder runs from a read-only copy.
        if path.contains("/AppTranslocation/") {
            return Some(
                "macOS가 앱을 임시 위치에서 실행 중입니다. DachsTerm을 응용 프로그램 폴더로 옮긴 뒤 다시 실행하세요.",
            );
        }
    }
    None
}

fn pubkey(app: &AppHandle) -> String {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|c| c.get("pubkey"))
        .and_then(|k| k.as_str())
        .unwrap_or_default()
        .to_string()
}

fn reason(app: &AppHandle) -> Option<&'static str> {
    let exe = std::env::current_exe().unwrap_or_default();
    unavailable(!cfg!(debug_assertions), &pubkey(app), &exe)
}

/// What to tell the user. The plugin's own messages are English and name its internals.
fn describe(error: &Error) -> String {
    match error {
        Error::Reqwest(_) | Error::Network(_) | Error::ReleaseNotFound => {
            "업데이트 서버에 연결하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도하세요.".into()
        }
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => {
            "새 버전에 이 운영체제용 파일이 없습니다.".into()
        }
        Error::Minisign(_)
        | Error::Base64(_)
        | Error::SignatureUtf8(_)
        | Error::SignedVersionMismatch { .. }
        | Error::MissingSignedVersion => {
            "내려받은 파일의 서명이 맞지 않아 설치하지 않았습니다. 현재 버전은 그대로입니다."
                .into()
        }
        Error::PreviousAppNotRestored(path) => format!(
            "새 버전을 설치하지 못했고 이전 앱을 제자리로 되돌리지 못했습니다. 이전 앱은 {}에 있습니다.",
            path.display()
        ),
        Error::TempDirNotOnSameMountPoint => {
            "앱이 있는 디스크에 임시 폴더를 만들 수 없어 설치하지 않았습니다. 응용 프로그램 폴더에서 실행하세요."
                .into()
        }
        Error::AuthenticationFailed => {
            "관리자 인증이 취소되어 설치하지 않았습니다. 현재 버전은 그대로입니다.".into()
        }
        Error::Io(e) if e.kind() == std::io::ErrorKind::ReadOnlyFilesystem => {
            "읽기 전용 위치(디스크 이미지 등)에서 실행 중이라 설치하지 않았습니다. DachsTerm을 응용 프로그램 폴더로 옮긴 뒤 다시 실행하세요."
                .into()
        }
        Error::Io(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
            "앱 위치에 쓸 권한이 없어 설치하지 않았습니다. 현재 버전은 그대로입니다.".into()
        }
        _ => "업데이트를 처리하지 못했습니다. 현재 버전은 그대로입니다.".into(),
    }
}

fn read_auto(state: &AppState) -> Result<bool> {
    match state.store.setting(AUTO_KEY)?.as_str() {
        "null" => Ok(true),
        "true" => Ok(true),
        "false" => Ok(false),
        _ => Err("업데이트 설정 값이 손상되었습니다. 설정에서 다시 지정하세요.".into()),
    }
}

async fn status(app: &AppHandle) -> Result<UpdateStatus> {
    let handle = app.clone();
    let auto = tauri::async_runtime::spawn_blocking(move || read_auto(&handle.state()))
        .await
        .map_err(|_| "업데이트 설정을 읽지 못했습니다.".to_string())??;
    Ok(UpdateStatus {
        current: app.package_info().version.to_string(),
        auto,
        unavailable: reason(app),
        phase: app.state::<Updates>().phase.lock().unwrap().clone(),
    })
}

fn updater(app: &AppHandle) -> std::result::Result<tauri_plugin_updater::Updater, Error> {
    let builder = app.updater_builder().timeout(DOWNLOAD_TIMEOUT);
    // The installer replaces the running app, so the plugin exits right after starting it. Sessions
    // close first, as on quit. This thread is the blocking one `update_install` runs `install` on.
    #[cfg(windows)]
    let builder = {
        let app = app.clone();
        builder.on_before_exit(move || {
            tauri::async_runtime::block_on(crate::finish_sessions(app.clone()));
            crate::desktop_files::clear_fetched(&app.state::<AppState>().directory);
        })
    };
    builder.build()
}

#[tauri::command]
pub async fn update_status(app: AppHandle) -> Result<UpdateStatus> {
    status(&app).await
}

#[tauri::command]
pub async fn update_auto_set(app: AppHandle, on: bool) -> Result<UpdateStatus> {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let _guard = state.mutation.lock().unwrap();
        state
            .store
            .set_setting(AUTO_KEY, if on { "true" } else { "false" })
    })
    .await
    .map_err(|_| "업데이트 설정을 저장하지 못했습니다.".to_string())??;
    status(&app).await
}

/// `automatic` is the check the app makes on its own, which the setting can turn off. A check the
/// user asks for always runs.
#[tauri::command]
pub async fn update_check(app: AppHandle, automatic: bool) -> Result<UpdateStatus> {
    let current = status(&app).await?;
    if (automatic && !current.auto) || current.unavailable.is_some() {
        return Ok(current);
    }
    let updates = app.state::<Updates>();
    if !updates.start(Phase::Checking) {
        return Ok(current);
    }
    let found = match updater(&app) {
        Ok(updater) => tokio::time::timeout(CHECK_TIMEOUT, updater.check())
            .await
            .unwrap_or(Err(Error::Network("timeout".into()))),
        Err(e) => Err(e),
    };
    match found {
        Ok(Some(update)) => {
            updates.set(Phase::Available {
                version: update.version.clone(),
                notes: update.body.clone().filter(|b| !b.trim().is_empty()),
                date: update.date.map(|d| d.to_string()),
            });
            *updates.found.lock().unwrap() = Some(update);
        }
        Ok(None) => {
            let checked = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_secs());
            updates.set(Phase::Latest { checked });
            *updates.found.lock().unwrap() = None;
        }
        Err(e) => updates.set(Phase::Failed {
            message: describe(&e),
        }),
    }
    status(&app).await
}

/// Downloads, verifies and installs the update the last check found, then restarts. On Windows the
/// installer takes over and this never returns; on macOS the new bundle is in place before any
/// session closes, so a failed install leaves the app running as it was.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<()> {
    if let Some(reason) = reason(&app) {
        return Err(reason.into());
    }
    let updates = app.state::<Updates>();
    let Some(update) = updates.found.lock().unwrap().clone() else {
        return Err("설치할 새 버전이 없습니다. 먼저 업데이트를 확인하세요.".into());
    };
    let version = update.version.clone();
    if !updates.start(Phase::Downloading {
        version: version.clone(),
        received: 0,
        total: None,
    }) {
        return Err("업데이트 확인이나 설치가 이미 진행 중입니다.".into());
    }
    let fail = |e: &Error| {
        let message = describe(e);
        updates.set(Phase::Failed {
            message: message.clone(),
        });
        message
    };
    let mut received = 0u64;
    let bytes = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                updates.set(Phase::Downloading {
                    version: version.clone(),
                    received,
                    total,
                });
            },
            || {},
        )
        .await
        .map_err(|e| fail(&e))?;
    updates.set(Phase::Installing {
        version: version.clone(),
    });
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes)).await;
    match installed {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(fail(&e)),
        Err(_) => {
            let message = "업데이트 설치 작업이 중단되었습니다. 현재 버전은 그대로입니다.";
            updates.set(Phase::Failed {
                message: message.into(),
            });
            return Err(message.into());
        }
    }
    let state = app.state::<AppState>();
    if state
        .closing
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        // Quitting already closes everything; the new version starts on the next launch.
        return Ok(());
    }
    crate::finish_sessions(app.clone()).await;
    // The new process takes the lock while this one is still exiting.
    let _ = state.instance_lock.unlock();
    app.request_restart();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHRlc3Q=";

    #[test]
    fn debug_builds_and_missing_keys_never_update() {
        let exe = Path::new("/Applications/DachsTerm.app/Contents/MacOS/dachsterm");
        assert!(unavailable(false, KEY, exe).is_some());
        assert!(unavailable(true, "", exe).is_some());
        assert!(unavailable(true, "  ", exe).is_some());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn mac_updates_only_an_app_it_can_replace() {
        let ok = |p: &str| unavailable(true, KEY, Path::new(p)).is_none();
        assert!(ok("/Applications/DachsTerm.app/Contents/MacOS/dachsterm"));
        assert!(ok(
            "/Users/me/Applications/DachsTerm.app/Contents/MacOS/dachsterm"
        ));
        assert!(!ok("/Users/me/dev/target/release/dachsterm"));
        assert!(!ok(
            "/private/var/folders/x/T/AppTranslocation/1234/d/DachsTerm.app/Contents/MacOS/dachsterm"
        ));
    }

    #[cfg(windows)]
    #[test]
    fn windows_release_with_a_key_updates() {
        let exe = Path::new(r"C:\Users\me\AppData\Local\DachsTerm\dachsterm.exe");
        assert!(unavailable(true, KEY, exe).is_none());
    }

    #[test]
    fn only_a_running_check_or_install_blocks_another() {
        let updates = Updates::default();
        assert!(updates.start(Phase::Checking));
        assert!(!updates.start(Phase::Checking));
        updates.set(Phase::Failed {
            message: String::new(),
        });
        assert!(updates.start(Phase::Installing {
            version: "1.0.0".into()
        }));
        assert!(!updates.start(Phase::Checking));
    }

    #[test]
    fn signature_failures_say_the_current_version_stays() {
        let message = describe(&Error::SignedVersionMismatch {
            signed: "0.5.1".into(),
            announced: "0.5.2".into(),
        });
        assert!(message.contains("서명"));
    }
}
