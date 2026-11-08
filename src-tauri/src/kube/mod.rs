//! Backend of the Kubernetes workspace (docs/design/kubernetes-workspace.md). Commands validate and
//! delegate; the work is in the modules below.
mod detect;
mod runner;
mod settings;
mod state;
use crate::{
    AppState,
    storage::{Result, Store},
};
use detect::{Detection, Source, detect};
use runner::Runner;
use serde::Deserialize;
pub use settings::{KubeSettings, Workspace};
use settings::{check_context, check_kubeconfig, check_kubectl};
use tauri::{AppHandle, Manager, State};

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum DetectRequest {
    /// The session's stored choice, or a full scan when it has none.
    Saved,
    Scan,
    Manual {
        kubectl: String,
        kubeconfig: String,
    },
}

fn saved_settings(store: &Store, profile_id: &str) -> Option<KubeSettings> {
    store
        .profile(profile_id)
        .ok()
        .and_then(|profile| profile.kube)
}

fn to_source(request: DetectRequest, saved: Option<KubeSettings>) -> Result<Source> {
    Ok(match request {
        DetectRequest::Saved => saved.map_or(Source::Scan, Source::Saved),
        DetectRequest::Scan => Source::Scan,
        DetectRequest::Manual {
            kubectl,
            kubeconfig,
        } => {
            check_kubectl(&kubectl)?;
            check_kubeconfig(&kubeconfig)?;
            Source::Manual {
                kubectl,
                kubeconfig,
            }
        }
    })
}

#[tauri::command]
pub async fn kube_detect(
    state: State<'_, AppState>,
    id: String,
    request: DetectRequest,
    context: Option<String>,
) -> Result<Detection> {
    if let Some(context) = &context {
        check_context(context)?;
    }
    let handle = state.connections.handle(&id)?;
    let profile_id = state.connections.control(&id)?.profile.id.clone();
    let store = state.store.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || saved_settings(&store, &profile_id))
        .await
        .map_err(|_| "저장된 세션을 읽지 못했습니다.".to_string())?;
    let source = to_source(request, saved)?;
    Ok(detect(&Runner::Ssh(&handle), source, context.as_deref()).await)
}

fn save_settings(store: &Store, profile_id: &str, mut kube: KubeSettings) -> Result<()> {
    let mut profile = store.profile(profile_id)?;
    if profile.workspace != Workspace::Kubernetes {
        return Err("쿠버네티스 세션에서만 설정을 저장할 수 있습니다.".into());
    }
    kube.operate = profile.kube.as_ref().is_some_and(|old| old.operate);
    profile.kube = Some(kube);
    let secret = store.secret_ref(profile_id)?;
    store.save(profile, secret).map(|_| ())
}

/// Only a session opened as a Kubernetes session is changed. A terminal session that merely shows
/// the workspace from its tab menu stays as it was (design §3.1).
#[tauri::command]
pub async fn kube_save(app: AppHandle, id: String, kube: KubeSettings) -> Result<()> {
    kube.validate()?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let profile_id = state.connections.control(&id)?.profile.id.clone();
        let _guard = state.mutation.lock().unwrap();
        save_settings(&state.store, &profile_id, kube)
    })
    .await
    .map_err(|_| "세션을 저장하지 못했습니다.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::tests::profile;

    fn settings(context: &str) -> KubeSettings {
        KubeSettings {
            context: context.into(),
            namespace: String::new(),
            kubectl: "/k".into(),
            kubeconfig: "/c".into(),
            operate: false,
        }
    }

    fn store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        (dir, store)
    }

    #[test]
    fn saved_mode_scans_when_nothing_is_stored() {
        assert!(matches!(
            to_source(DetectRequest::Saved, None),
            Ok(Source::Scan)
        ));
        let source = to_source(DetectRequest::Saved, Some(settings("a"))).unwrap();
        assert!(matches!(source, Source::Saved(s) if s.context == "a"));
    }

    #[test]
    fn typed_commands_are_checked_before_anything_runs() {
        let manual = |kubectl: &str, kubeconfig: &str| DetectRequest::Manual {
            kubectl: kubectl.into(),
            kubeconfig: kubeconfig.into(),
        };
        assert!(to_source(manual("kubectl; reboot", ""), None).is_err());
        assert!(to_source(manual("sudo kubectl", ""), None).is_err());
        assert!(to_source(manual("microk8s kubectl", "relative"), None).is_err());
        assert!(to_source(manual("microk8s kubectl", ""), None).is_ok());
    }

    #[test]
    fn a_terminal_session_is_not_changed() {
        let (_dir, store) = store();
        let saved = store.save(profile(), None).unwrap();
        assert!(save_settings(&store, &saved.id, settings("a")).is_err());
        assert!(store.profile(&saved.id).unwrap().kube.is_none());
    }

    #[test]
    fn saving_keeps_the_login_secret_and_cannot_switch_operate_on() {
        let (_dir, store) = store();
        let mut p = profile();
        p.workspace = Workspace::Kubernetes;
        let saved = store.save(p, Some("secret-ref".into())).unwrap();
        let mut asked = settings("a");
        asked.operate = true;
        save_settings(&store, &saved.id, asked).unwrap();
        let stored = store.profile(&saved.id).unwrap();
        assert_eq!(stored.kube.as_ref().unwrap().context, "a");
        assert!(!stored.kube.unwrap().operate);
        assert_eq!(
            store.secret_ref(&saved.id).unwrap().as_deref(),
            Some("secret-ref")
        );
    }

    #[test]
    fn saving_keeps_an_operate_mode_already_on() {
        let (_dir, store) = store();
        let mut p = profile();
        p.workspace = Workspace::Kubernetes;
        let mut on = settings("a");
        on.operate = true;
        p.kube = Some(on);
        let saved = store.save(p, None).unwrap();
        save_settings(&store, &saved.id, settings("b")).unwrap();
        assert!(store.profile(&saved.id).unwrap().kube.unwrap().operate);
    }
}
