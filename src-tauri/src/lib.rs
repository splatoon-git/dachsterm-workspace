mod agent_filter;
pub mod agent_forward;
pub mod agent_keys;
mod agent_relay;
mod approval;
pub mod archive;
pub mod broadcast;
mod commands;
mod config_includes;
pub mod credential_helper;
pub mod credentials;
mod desktop_bridge;
mod desktop_files;
pub mod editor;
mod editor_location;
pub mod encoding;
pub mod file_ops;
pub mod ftp;
pub mod git_config;
pub mod git_credential;
pub mod git_diff;
pub mod git_run;
pub mod git_status;
pub mod hostkeys;
pub mod local;
mod local_agent;
mod local_files;
mod local_links;
#[cfg(target_os = "macos")]
mod login_path;
mod maintenance;
pub mod monitoring;
pub mod podtree;
mod prompt_files;
mod remote_exec;
mod remote_ports;
pub mod routes;
mod rsa_auth;
pub mod session_log;
mod session_management;
mod session_transfer;
mod settings;
pub mod sftp;
mod shell_probe;
pub mod snippets;
pub mod source;
pub mod ssh;
mod ssh_auth;
pub mod ssh_keys;
pub mod storage;
pub mod terminal_start;
pub mod transfer_queue;
pub mod tunnels;
pub mod vault;
pub mod windows;
mod workspace;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::Manager;
pub struct AppState {
    pub instance_lock: std::fs::File,
    pub locals: Arc<local::Locals>,
    pub podtrees: Arc<podtree::PodTrees>,
    pub file_clipboard: std::sync::Mutex<Option<file_ops::Clipboard>>,
    pub broadcast: broadcast::Broadcast,
    pub vault: Arc<vault::Vault>,
    pub detached: std::sync::Mutex<std::collections::HashMap<String, windows::Detached>>,
    pub monitors: Arc<monitoring::Monitors>,
    pub tunnels: Arc<tunnels::Tunnels>,
    pub transfers: Arc<sftp::Transfers>,
    pub editors: Arc<editor::Editors>,
    pub drag_outs: desktop_files::DragOuts,
    pub directory: PathBuf,
    pub store: Arc<storage::Store>,
    pub connections: Arc<ssh::Connections>,
    pub known_hosts: Vec<PathBuf>,
    pub mutation: std::sync::Mutex<()>,
    pub closing: AtomicBool,
}
pub fn run() {
    #[cfg(target_os = "macos")]
    login_path::apply();
    let context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    let context = {
        let mut context = context;
        if let Some(directory) = std::env::var_os("DACHSTERM_TEST_DATA_DIR") {
            context.config_mut().app.windows[0].data_directory =
                Some(PathBuf::from(directory).join("webview"));
            if let Ok(port) = std::env::var("DACHSTERM_TEST_CDP_PORT")
                .unwrap_or_default()
                .parse::<u16>()
            {
                context.config_mut().app.windows[0].additional_browser_args = Some(format!(
                    "--remote-debugging-port={port} --remote-debugging-address=127.0.0.1"
                ));
            }
        }
        context
    };
    let app = tauri::Builder::default()
        // Only desktop_bridge uses this. The webview gets no notification permission.
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            // Integration tests isolate all local state; release builds ignore this variable.
            #[cfg(debug_assertions)]
            let directory = std::env::var_os("DACHSTERM_TEST_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or(directory);
            std::fs::create_dir_all(&directory)?;
            let instance_lock =
                maintenance::instance_lock(&directory).map_err(std::io::Error::other)?;
            let mut known_hosts = vec![directory.join("known_hosts")];
            if let Some(home) = dirs::home_dir() {
                known_hosts.push(home.join(".ssh/known_hosts"));
            }
            let store = Arc::new(
                storage::Store::open(&directory.join("sessions.sqlite3"))
                    .map_err(std::io::Error::other)?,
            );
            git_config::program::load(&store);
            let transfers = Arc::new(sftp::Transfers::default());
            transfers
                .recover(store.clone())
                .map_err(std::io::Error::other)?;
            if let Ok(value) = store.setting("window")
                && let Ok(size) = serde_json::from_str::<(f64, f64)>(&value)
                && (560.0..=3840.0).contains(&size.0)
                && (480.0..=2160.0).contains(&size.1)
                && let Some(window) = app.get_webview_window("main")
            {
                let _ = window.set_size(tauri::LogicalSize::new(size.0, size.1));
            }
            let connections = Arc::new(ssh::Connections::default());
            let editors = Arc::new(editor::Editors::default());
            editors.recover(&directory.join("edits"));
            desktop_files::clear_fetched(&directory);
            {
                let editors = editors.clone();
                let connections = connections.clone();
                tauri::async_runtime::spawn(async move {
                    editors.watch(connections);
                });
            }
            let vault = Arc::new(vault::Vault::default());
            {
                let vault = vault.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                        vault.expire();
                    }
                });
            }
            app.manage(AppState {
                instance_lock,
                locals: Arc::default(),
                podtrees: Arc::default(),
                file_clipboard: Default::default(),
                broadcast: Default::default(),
                vault,
                detached: Default::default(),
                monitors: Arc::default(),
                tunnels: Arc::default(),
                transfers,
                editors,
                drag_outs: Default::default(),
                directory,
                store,
                connections,
                known_hosts,
                mutation: std::sync::Mutex::new(()),
                closing: AtomicBool::new(false),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            session_log::log_status,
            session_log::log_pick,
            session_log::log_start,
            session_log::log_action,
            session_log::log_auto,
            session_log::log_auto_get,
            maintenance::recovery_list,
            maintenance::recovery_create,
            maintenance::recovery_restore,
            maintenance::diagnostics_export,
            podtree::podtree_inspect,
            podtree::podtree_open,
            podtree::podtree_input,
            podtree::podtree_resize,
            podtree::podtree_ack,
            podtree::podtree_close,
            local::local_targets,
            local::local_open,
            local::local_input,
            local::local_resize,
            local::local_ack,
            local::local_close,
            local_files::local_files_home,
            local_files::local_files_list,
            local_files::local_files_change,
            local_files::local_files_batch,
            local_files::local_files_download,
            local_files::local_files_edit,
            desktop_files::files_drag_prepare,
            desktop_files::files_drag_out,
            desktop_files::files_reveal,
            shell_probe::terminal_supports_directory_hook,
            desktop_bridge::clipboard_write_text,
            desktop_bridge::url_open,
            desktop_bridge::notification_show,
            prompt_files::prompt_clipboard_inspect,
            prompt_files::prompt_clipboard_image,
            prompt_files::prompt_files_inspect,
            prompt_files::prompt_files_upload,
            remote_ports::remote_ports,
            terminal_start::tmux_current_path,
            git_status::git_status,
            git_status::local::local_git_status,
            git_status::view::git_view,
            git_config::git_config_read,
            git_config::git_config_preview,
            git_config::git_config_write,
            git_config::program::git_program_info,
            git_config::program::git_program_pick,
            git_config::program::git_program_set,
            git_diff::git_refs,
            git_diff::git_diff_files,
            git_diff::git_diff_file,
            agent_keys::agent_sign_reply,
            local_agent::settings::local_agent_settings,
            local_agent::settings::local_agent_save,
            ssh_keys::ssh_key_info,
            git_credential::commands::git_credential_reply,
            git_credential::commands::git_credential_shell,
            git_credential::commands::git_credentials_saved,
            git_credential::commands::git_credential_forget,
            broadcast::broadcast_status,
            broadcast::broadcast_set,
            vault::vault_status,
            vault::vault_action,
            vault::vault_lock,
            settings::tunnel_configs,
            settings::tunnel_save,
            settings::tunnel_start,
            settings::tunnel_stop,
            settings::tunnel_list,
            settings::config_export,
            session_transfer::config_preview,
            config_includes::config_include_preview,
            session_transfer::config_apply,
            monitoring::monitor_get,
            monitoring::monitor_configure,
            session_management::session_templates,
            session_management::template_save,
            session_management::session_batch,
            session_management::group_update,
            commands::sessions,
            commands::save_session,
            commands::delete_session,
            commands::duplicate_session,
            commands::save_group,
            commands::connect,
            commands::disconnect,
            commands::trust_host,
            commands::auth_reply,
            commands::terminal_input,
            commands::terminal_resize,
            windows::detach_terminal,
            windows::detached_info,
            windows::attach_terminal,
            archive::archive_run,
            file_ops::file_batch,
            file_ops::file_clipboard,
            workspace::sftp_list,
            workspace::sftp_change,
            workspace::transfer_batch,
            workspace::transfer_control,
            workspace::transfer_items,
            workspace::transfer_pick,
            workspace::transfer_list,
            workspace::transfer_discard,
            workspace::edit_close,
            workspace::edit_start,
            workspace::edit_mode,
            workspace::editor_list,
            workspace::editor_pick,
            workspace::edit_list,
            workspace::edit_resolve,
            workspace::edit_session_auto,
            snippets::snippet_list,
            snippets::snippet_save,
            snippets::snippet_send,
            commands::terminal_ack
        ])
        .build(context);
    let app = match app {
        Ok(app) => app,
        Err(_) => {
            rfd::MessageDialog::new().set_title("DachsTerm 시작 실패")
                .set_description("앱을 시작할 수 없습니다. 이미 실행 중인 DachsTerm을 먼저 확인하세요. 계속 실패하면 앱 데이터 폴더의 sessions.sqlite3와 recovery 폴더를 보존하고 복구 절차를 확인하세요. 원본 데이터는 자동 초기화하지 않습니다.")
                .set_level(rfd::MessageLevel::Error).show();
            std::process::exit(1);
        }
    };
    app.run(|app, event| {
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } = &event
            && label == "main"
            && let Some(window) = app.get_webview_window(label)
            && let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor())
        {
            let logical = size.to_logical::<f64>(scale);
            if let Ok(value) = serde_json::to_string(&(logical.width, logical.height)) {
                let _ = app.state::<AppState>().store.set_setting("window", &value);
            }
        }

        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::Destroyed,
            ..
        } = &event
            && let Some(id) = label.strip_prefix("terminal-")
        {
            let state = app.state::<AppState>();
            if let Ok(c) = state.connections.control(id) {
                let _ = c.stop.send(true);
            }
            state.detached.lock().unwrap().remove(id);
        }
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let state = app.state::<AppState>();
            if !state.closing.swap(true, Ordering::SeqCst) {
                api.prevent_exit();
                state.podtrees.shutdown();
                state.locals.shutdown();
                state.connections.shutdown();
                let connections = state.connections.clone();
                let podtrees = state.podtrees.clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                        while !connections.entries.lock().unwrap().is_empty() || !podtrees.is_empty() {
                            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                        }
                    })
                    .await;
                    let logs = app.state::<AppState>().connections.logs.clone();
                    let _ = tauri::async_runtime::spawn_blocking(move || {
                        if !logs.shutdown() {
                            rfd::MessageDialog::new().set_title("세션 로그 저장 시간 초과")
                                .set_description("로그 저장이 3초 안에 끝나지 않았습니다. 종료 후 로그의 마지막 출력이 누락될 수 있습니다. 저장 장치 상태와 로그 파일을 확인하세요.")
                                .set_level(rfd::MessageLevel::Warning).show();
                        }
                    }).await;
                    app.exit(0);
                });
            }
        } else if let tauri::RunEvent::Exit = event {
            app.state::<AppState>().locals.shutdown();
            app.state::<AppState>().connections.shutdown();
            desktop_files::clear_fetched(&app.state::<AppState>().directory);
        }
    });
}
