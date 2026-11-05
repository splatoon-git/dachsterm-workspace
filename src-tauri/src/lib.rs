pub mod archive;
pub mod broadcast;
mod commands;
pub mod credentials;
pub mod editor;
pub mod encoding;
pub mod file_ops;
pub mod ftp;
pub mod hostkeys;
pub mod local;
mod maintenance;
pub mod monitoring;
mod rsa_auth;
mod session_transfer;
mod settings;
pub mod sftp;
pub mod ssh;
mod ssh_auth;
pub mod storage;
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
    pub file_clipboard: std::sync::Mutex<Option<file_ops::Clipboard>>,
    pub broadcast: broadcast::Broadcast,
    pub vault: Arc<vault::Vault>,
    pub detached: std::sync::Mutex<std::collections::HashMap<String, windows::Detached>>,
    pub monitors: Arc<monitoring::Monitors>,
    pub tunnels: Arc<tunnels::Tunnels>,
    pub transfers: Arc<sftp::Transfers>,
    pub editors: Arc<editor::Editors>,
    pub directory: PathBuf,
    pub store: Arc<storage::Store>,
    pub connections: Arc<ssh::Connections>,
    pub known_hosts: Vec<PathBuf>,
    pub mutation: std::sync::Mutex<()>,
    pub closing: AtomicBool,
}
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    let context = {
        let mut context = context;
        if let Some(directory) = std::env::var_os("DAXTERM_TEST_DATA_DIR") {
            context.config_mut().app.windows[0].data_directory =
                Some(PathBuf::from(directory).join("webview"));
            if let Ok(port) = std::env::var("DAXTERM_TEST_CDP_PORT")
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
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            // Integration tests isolate all local state; release builds ignore this variable.
            #[cfg(debug_assertions)]
            let directory = std::env::var_os("DAXTERM_TEST_DATA_DIR")
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
                file_clipboard: Default::default(),
                broadcast: Default::default(),
                vault,
                detached: Default::default(),
                monitors: Arc::default(),
                tunnels: Arc::default(),
                transfers,
                editors,
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
            maintenance::recovery_list,
            maintenance::recovery_create,
            maintenance::recovery_restore,
            maintenance::diagnostics_export,
            local::local_targets,
            local::local_open,
            local::local_input,
            local::local_resize,
            local::local_ack,
            local::local_close,
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
            settings::config_import,
            session_transfer::config_preview,
            session_transfer::config_apply,
            monitoring::monitor_get,
            monitoring::monitor_configure,
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
            workspace::transfer_pick,
            workspace::transfer_drop,
            workspace::transfer_list,
            workspace::transfer_cancel,
            workspace::transfer_resume,
            workspace::transfer_discard,
            workspace::edit_close,
            workspace::edit_start,
            workspace::edit_mode,
            workspace::editor_pick,
            workspace::edit_list,
            workspace::edit_resolve,
            commands::terminal_ack
        ])
        .build(context);
    let app = match app {
        Ok(app) => app,
        Err(_) => {
            rfd::MessageDialog::new().set_title("DaxTerm 시작 실패")
                .set_description("앱을 시작할 수 없습니다. 이미 실행 중인 DaxTerm을 먼저 확인하세요. 계속 실패하면 앱 데이터 폴더의 sessions.sqlite3와 recovery 폴더를 보존하고 복구 절차를 확인하세요. 원본 데이터는 자동 초기화하지 않습니다.")
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
                state.locals.shutdown();
                state.connections.shutdown();
                let connections = state.connections.clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), async {
                        while !connections.entries.lock().unwrap().is_empty() {
                            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                        }
                    })
                    .await;
                    app.exit(0);
                });
            }
        } else if let tauri::RunEvent::Exit = event {
            app.state::<AppState>().locals.shutdown();
            app.state::<AppState>().connections.shutdown();
        }
    });
}
