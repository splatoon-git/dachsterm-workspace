//! Backend of the Kubernetes workspace (docs/design/kubernetes-workspace.md). Commands validate and
//! delegate; the work is in the modules below.
mod action;
#[cfg(all(test, unix))]
mod action_cluster_test;
mod detail;
mod detect;
mod ingress;
mod ingress_metrics;
mod log_keywords;
mod log_scheduler;
mod log_search;
mod log_stream;
mod logs;
mod metrics;
mod probe;
mod runner;
mod settings;
mod shell;
mod slots;
mod snapshot;
mod state;
mod templates;
use crate::{
    AppState,
    storage::{Result, Store},
};
use action::{Action, OperateMode};
use detail::{Detail, DetailKind, PodTarget};
use detect::{Detection, Source, detect};
pub use log_keywords::Keywords;
pub use log_search::LogSearches;
use log_search::SearchRequest;
use log_stream::StreamSource;
use logs::{LogRequest, Logs};
use metrics::{MetricsRead, MetricsTarget};
use probe::ProbeRead;
use runner::Runner;
use serde::Deserialize;
pub use settings::{KubeSettings, Workspace};
use settings::{
    check_context, check_kubeconfig, check_kubectl, check_namespace, check_pod, is_log_time,
};
pub use shell::{check_target, logs_command, shell_command};
pub use slots::{Slots, WatchSlots};
use snapshot::{Kind, Snapshot, collect};
use state::ShellCheck;
use tauri::{AppHandle, Manager, State, ipc::Channel};
use uuid::Uuid;

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

/// Settings come with the call because a terminal session showing the workspace from its tab menu
/// keeps its choice only while the tab is open (design §3.1).
#[tauri::command]
pub async fn kube_snapshot(
    state: State<'_, AppState>,
    slots: State<'_, Slots>,
    id: String,
    kube: KubeSettings,
    kind: Kind,
) -> Result<Snapshot> {
    kube.validate()?;
    let handle = state.connections.handle(&id)?;
    let slot = slots.for_connection(&id);
    let _turn = slot
        .acquire_owned()
        .await
        .map_err(|_| "조회를 시작하지 못했습니다.".to_string())?;
    Ok(collect(&Runner::Ssh(&handle), &kube, kind).await)
}

/// Runs its reads one after another in a single slot, so it costs a connection what any poll does.
#[tauri::command]
pub async fn kube_ingress(
    state: State<'_, AppState>,
    slots: State<'_, Slots>,
    id: String,
    kube: KubeSettings,
) -> Result<ingress::Report> {
    kube.validate()?;
    let handle = state.connections.handle(&id)?;
    let slot = slots.for_connection(&id);
    let _turn = slot
        .acquire_owned()
        .await
        .map_err(|_| "조회를 시작하지 못했습니다.".to_string())?;
    Ok(ingress::collect(&Runner::Ssh(&handle), &kube).await)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PodRef {
    namespace: String,
    pod: String,
}

fn check_pod_ref(target: &PodRef) -> Result<()> {
    if target.namespace.is_empty() {
        return Err("파드의 namespace가 필요합니다.".into());
    }
    check_namespace(&target.namespace)?;
    check_pod(&target.pod)
}

#[tauri::command]
pub async fn kube_detail(
    state: State<'_, AppState>,
    slots: State<'_, Slots>,
    id: String,
    kube: KubeSettings,
    target: PodRef,
    kind: DetailKind,
) -> Result<Detail> {
    kube.validate()?;
    check_pod_ref(&target)?;
    let handle = state.connections.handle(&id)?;
    let slot = slots.for_connection(&id);
    let _turn = slot
        .acquire_owned()
        .await
        .map_err(|_| "조회를 시작하지 못했습니다.".to_string())?;
    let target = PodTarget {
        namespace: &target.namespace,
        pod: &target.pod,
    };
    Ok(detail::read(&Runner::Ssh(&handle), &kube, target, kind).await)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn kube_logs(
    state: State<'_, AppState>,
    slots: State<'_, Slots>,
    id: String,
    kube: KubeSettings,
    target: PodRef,
    container: String,
    tail: u32,
    previous: bool,
    since_time: Option<String>,
) -> Result<Logs> {
    check_target(&kube, &target.namespace, &target.pod, &container)?;
    if since_time.as_deref().is_some_and(|time| !is_log_time(time)) {
        return Err("로그 시각이 올바르지 않습니다.".into());
    }
    let handle = state.connections.handle(&id)?;
    let slot = slots.for_connection(&id);
    let _turn = slot
        .acquire_owned()
        .await
        .map_err(|_| "조회를 시작하지 못했습니다.".to_string())?;
    let request = LogRequest {
        namespace: &target.namespace,
        pod: &target.pod,
        container: &container,
        tail,
        previous,
        since_time: since_time.as_deref(),
    };
    Ok(logs::fetch(&Runner::Ssh(&handle), &kube, request).await)
}

/// Results come as events and the call ends with the search. Log search has its own limit rather
/// than the polling slots (design KV.2).
#[tauri::command]
pub async fn kube_log_search(
    state: State<'_, AppState>,
    searches: State<'_, LogSearches>,
    id: String,
    kube: KubeSettings,
    search_id: String,
    request: SearchRequest,
    on_event: Channel<log_search::Event>,
) -> Result<()> {
    kube.validate()?;
    if Uuid::parse_str(&search_id).is_err() {
        return Err("잘못된 검색 ID".into());
    }
    let plan = log_search::plan(request)?;
    let handle = state.connections.handle(&id)?;
    let registered = searches.begin(search_id);
    let cancel = registered.cancel.clone();
    log_search::run(handle, kube, plan, on_event, cancel).await;
    Ok(())
}

/// One SSH channel however many pods are followed, and no polling slot: it runs until cancelled.
/// `kube_log_cancel` ends it, since a stream registers the same way a search does.
#[tauri::command]
pub async fn kube_log_stream(
    state: State<'_, AppState>,
    searches: State<'_, LogSearches>,
    id: String,
    kube: KubeSettings,
    stream_id: String,
    sources: Vec<StreamSource>,
    on_event: Channel<log_stream::Event>,
) -> Result<()> {
    kube.validate()?;
    if Uuid::parse_str(&stream_id).is_err() {
        return Err("잘못된 스트림 ID".into());
    }
    log_stream::check(&sources)?;
    let handle = state.connections.handle(&id)?;
    let registered = searches.begin(stream_id);
    let cancel = registered.cancel.clone();
    log_stream::run(handle, kube, sources, on_event, cancel).await;
    Ok(())
}

#[tauri::command]
pub fn kube_log_cancel(searches: State<'_, LogSearches>, search_id: String) -> Result<()> {
    searches.cancel(&search_id);
    Ok(())
}

/// Runs a no-op in the container first, so a tab is only opened when a shell can start.
#[tauri::command]
pub async fn kube_terminal_probe(
    state: State<'_, AppState>,
    slots: State<'_, Slots>,
    id: String,
    kube: KubeSettings,
    target: PodRef,
    container: String,
) -> Result<ShellCheck> {
    check_target(&kube, &target.namespace, &target.pod, &container)?;
    let handle = state.connections.handle(&id)?;
    let slot = slots.for_connection(&id);
    let _turn = slot
        .acquire_owned()
        .await
        .map_err(|_| "조회를 시작하지 못했습니다.".to_string())?;
    Ok(shell::probe(
        &Runner::Ssh(&handle),
        &kube,
        &target.namespace,
        &target.pod,
        &container,
    )
    .await)
}

/// A pod's `/metrics`, its candidates, or its node's thread counts. Reads only (design KV.9).
#[tauri::command]
pub async fn kube_metrics(
    state: State<'_, AppState>,
    slots: State<'_, WatchSlots>,
    id: String,
    kube: KubeSettings,
    target: MetricsTarget,
) -> Result<MetricsRead> {
    kube.validate()?;
    target.check()?;
    let handle = state.connections.handle(&id)?;
    let slot = slots.0.for_connection(&id);
    let _turn = slot
        .acquire_owned()
        .await
        .map_err(|_| "조회를 시작하지 못했습니다.".to_string())?;
    Ok(metrics::read(&Runner::Ssh(&handle), &kube, &target).await)
}

/// Runs the app's fixed read-only script in a container. There is no path for any other command.
#[tauri::command]
pub async fn kube_probe(
    state: State<'_, AppState>,
    slots: State<'_, WatchSlots>,
    id: String,
    kube: KubeSettings,
    target: PodRef,
    container: String,
) -> Result<ProbeRead> {
    check_target(&kube, &target.namespace, &target.pod, &container)?;
    let handle = state.connections.handle(&id)?;
    let slot = slots.0.for_connection(&id);
    let _turn = slot
        .acquire_owned()
        .await
        .map_err(|_| "조회를 시작하지 못했습니다.".to_string())?;
    Ok(probe::run(
        &Runner::Ssh(&handle),
        &kube,
        &target.namespace,
        &target.pod,
        &container,
    )
    .await)
}

/// Reads the stored mode. The screen uses it only to draw; `kube_action` reads it again.
#[tauri::command]
pub async fn kube_operate_mode(app: AppHandle, id: String) -> Result<OperateMode> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let profile_id = state.connections.control(&id)?.profile.id.clone();
        action::operate_mode(&state.store, &profile_id)
    })
    .await
    .map_err(|_| "운영 모드를 읽지 못했습니다.".to_string())?
}

#[tauri::command]
pub async fn kube_set_operate_mode(app: AppHandle, id: String, on: bool) -> Result<OperateMode> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let profile_id = state.connections.control(&id)?.profile.id.clone();
        let _guard = state.mutation.lock().unwrap();
        action::set_operate_mode(&state.store, &profile_id, on)
    })
    .await
    .map_err(|_| "운영 모드를 바꾸지 못했습니다.".to_string())?
}

/// Takes no settings: `permit` uses what the profile stores. `context` is only what the user saw
/// when confirming, and a mismatch refuses.
#[tauri::command]
pub async fn kube_action(
    state: State<'_, AppState>,
    slots: State<'_, Slots>,
    id: String,
    context: String,
    action: Action,
) -> Result<()> {
    check_context(&context)?;
    action.check()?;
    let handle = state.connections.handle(&id)?;
    let profile_id = state.connections.control(&id)?.profile.id.clone();
    let store = state.store.clone();
    let (kube, action) = tauri::async_runtime::spawn_blocking(move || {
        action::permit(&store, &profile_id, &context, &action).map(|kube| (kube, action))
    })
    .await
    .map_err(|_| "운영 모드를 확인하지 못했습니다.".to_string())??;
    let slot = slots.for_connection(&id);
    let _turn = slot
        .acquire_owned()
        .await
        .map_err(|_| "실행을 시작하지 못했습니다.".to_string())?;
    action::run(&Runner::Ssh(&handle), &kube, &action).await
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
