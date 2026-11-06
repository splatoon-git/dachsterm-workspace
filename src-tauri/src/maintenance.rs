//! Recovery files contain portable settings only; diagnostics use an explicit allowlist.
use crate::{
    AppState, settings,
    storage::{Result, Store},
};
use serde::Serialize;
use std::{
    fs::{File, OpenOptions},
    io::{Read, Write},
    path::Path,
    time::UNIX_EPOCH,
};
use tauri::State;

pub const MAX_CONFIG_BYTES: usize = 2 * 1024 * 1024;
const MAX_SNAPSHOTS: usize = 10;

pub fn instance_lock(directory: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("instance.lock"))
        .map_err(|_| "앱 데이터 잠금 파일을 열 수 없습니다.")?;
    file.try_lock().map_err(|_| "같은 데이터 폴더를 사용하는 DachsTerm이 이미 실행 중입니다. 기존 창을 사용하거나 앱을 종료한 뒤 다시 실행하세요.")?;
    Ok(file)
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("저장 경로 오류")?;
    let mut pending =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| "임시 저장 파일 생성 실패")?;
    pending
        .write_all(bytes)
        .map_err(|_| "파일 저장 실패 · 기존 파일은 유지됩니다.")?;
    pending
        .as_file()
        .sync_all()
        .map_err(|_| "파일 동기화 실패 · 기존 파일은 유지됩니다.")?;
    pending
        .persist(path)
        .map_err(|_| "파일 교체 실패 · 기존 파일은 유지됩니다.")?;
    Ok(())
}

pub fn read_config(path: &Path) -> Result<Vec<u8>> {
    let file = File::open(path).map_err(|_| "설정 파일 읽기 실패")?;
    let mut data = Vec::new();
    file.take((MAX_CONFIG_BYTES + 1) as u64)
        .read_to_end(&mut data)
        .map_err(|_| "설정 파일 읽기 실패")?;
    if data.len() > MAX_CONFIG_BYTES {
        return Err("설정 파일은 2MiB 이하여야 합니다.".into());
    }
    Ok(data)
}

#[derive(Serialize)]
pub struct RecoveryFile {
    pub id: String,
    pub modified: u64,
}

fn files(root: &Path) -> Result<Vec<RecoveryFile>> {
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut result = Vec::new();
    for entry in std::fs::read_dir(root).map_err(|_| "설정 복구본 목록 읽기 실패")? {
        let entry = entry.map_err(|_| "설정 복구본 목록 읽기 실패")?;
        if !entry
            .file_type()
            .map_err(|_| "설정 복구본 확인 실패")?
            .is_file()
        {
            continue;
        }
        let path = entry.path();
        if path.extension().is_none_or(|v| v != "json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|v| v.to_str()) else {
            continue;
        };
        if uuid::Uuid::parse_str(id).is_err() {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |v| v.as_secs());
        result.push(RecoveryFile {
            id: id.into(),
            modified,
        });
    }
    result.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.id.cmp(&b.id)));
    Ok(result)
}

pub fn snapshot(store: &Store, directory: &Path) -> Result<String> {
    let data = settings::export(store)?;
    let root = directory.join("recovery");
    crate::editor::private_directory(&root)?;
    let id = uuid::Uuid::new_v4().to_string();
    atomic_write(&root.join(format!("{id}.json")), &data)?;
    // Always retain the newly written snapshot, even when timestamps have equal precision.
    for old in files(&root)?
        .into_iter()
        .filter(|v| v.id != id)
        .skip(MAX_SNAPSHOTS - 1)
    {
        std::fs::remove_file(root.join(format!("{}.json", old.id)))
            .map_err(|_| "오래된 설정 복구본 정리 실패")?;
    }
    Ok(id)
}

fn restore(store: &Store, directory: &Path, id: &str) -> Result<usize> {
    let parsed = uuid::Uuid::parse_str(id).map_err(|_| "설정 복구본 ID 오류")?;
    if parsed.to_string() != id {
        return Err("설정 복구본 ID 오류".into());
    }
    let path = directory.join("recovery").join(format!("{id}.json"));
    if !std::fs::symlink_metadata(&path)
        .map_err(|_| "설정 복구본을 찾을 수 없습니다.")?
        .file_type()
        .is_file()
    {
        return Err("설정 복구본은 일반 파일이어야 합니다.".into());
    }
    let data = read_config(&path)?;
    snapshot(store, directory)?;
    settings::import(store, &data)
}

#[tauri::command]
pub fn recovery_list(state: State<AppState>) -> Result<Vec<RecoveryFile>> {
    files(&state.directory.join("recovery"))
}
#[tauri::command]
pub fn recovery_create(state: State<AppState>) -> Result<String> {
    let _guard = state.mutation.lock().unwrap();
    snapshot(&state.store, &state.directory)
}
#[tauri::command]
pub fn recovery_restore(state: State<AppState>, id: String) -> Result<usize> {
    let _guard = state.mutation.lock().unwrap();
    restore(&state.store, &state.directory, &id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostics {
    format_version: u8,
    app_version: &'static str,
    os: &'static str,
    architecture: &'static str,
    debug_build: bool,
    database_ok: bool,
    schema_version: Option<i64>,
    profiles: i64,
    groups: i64,
    connections: usize,
    transfers: usize,
    editors: usize,
    tunnels: usize,
}
fn database_diagnostics(store: &Store) -> Diagnostics {
    let db = store.0.lock().unwrap();
    let ok = db
        .query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
        .is_ok_and(|s| s == "ok");
    let version = db.query_row("PRAGMA user_version", [], |r| r.get(0)).ok();
    let profiles = db
        .query_row("SELECT count(*) FROM profiles", [], |r| r.get(0))
        .unwrap_or(0);
    let groups = db
        .query_row("SELECT count(*) FROM groups", [], |r| r.get(0))
        .unwrap_or(0);
    Diagnostics {
        format_version: 1,
        app_version: env!("CARGO_PKG_VERSION"),
        os: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        debug_build: cfg!(debug_assertions),
        database_ok: ok,
        schema_version: version,
        profiles,
        groups,
        connections: 0,
        transfers: 0,
        editors: 0,
        tunnels: 0,
    }
}
#[tauri::command]
pub async fn diagnostics_export(state: State<'_, AppState>) -> Result<bool> {
    let mut report = database_diagnostics(&state.store);
    report.connections = state.connections.entries.lock().unwrap().len();
    report.transfers = state.transfers.list().len();
    report.editors = state.editors.list().len();
    report.tunnels = state.tunnels.list().len();
    let data = serde_json::to_vec_pretty(&report).map_err(|_| "진단 생성 실패")?;
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_file_name("dachsterm-diagnostics.json")
        .add_filter("JSON", &["json"])
        .save_file()
        .await
    else {
        return Ok(false);
    };
    atomic_write(file.path(), &data)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn process_lock_is_exclusive_and_releases_on_drop() {
        let dir = tempfile::tempdir().unwrap();
        let lock = instance_lock(dir.path()).unwrap();
        assert!(instance_lock(dir.path()).is_err());
        drop(lock);
        assert!(instance_lock(dir.path()).is_ok());
    }
    #[test]
    fn atomic_replace_and_bounded_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        atomic_write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(read_config(&path).unwrap(), b"new");
        let large = File::create(&path).unwrap();
        large.set_len((MAX_CONFIG_BYTES + 1) as u64).unwrap();
        assert!(read_config(&path).is_err());
        assert!(atomic_write(&dir.path().join("missing/file"), b"x").is_err());
    }
    #[test]
    fn recovery_is_bounded_importable_and_does_not_export_vault_or_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        let original = store
            .save(
                crate::storage::tests::profile(),
                Some("do-not-export-credential-reference".into()),
            )
            .unwrap();
        store
            .set_setting("master-vault-v1", "do-not-export")
            .unwrap();
        store.stage_secret("do-not-export").unwrap();
        let mut last = String::new();
        for _ in 0..12 {
            last = snapshot(&store, dir.path()).unwrap();
        }
        let list = files(&dir.path().join("recovery")).unwrap();
        assert_eq!(list.len(), MAX_SNAPSHOTS);
        assert!(list.iter().any(|v| v.id == last));
        let bytes = read_config(&dir.path().join("recovery").join(format!("{last}.json"))).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("do-not-export"));
        assert_eq!(restore(&store, dir.path(), &last).unwrap(), 1);
        let profiles = store.list().unwrap().profiles;
        assert_eq!(profiles.len(), 2);
        let restored = profiles.iter().find(|p| p.id != original.id).unwrap();
        assert!(!restored.has_secret);
        assert!(restore(&store, dir.path(), "../db").is_err());
        let diagnostic = serde_json::to_string(&database_diagnostics(&store)).unwrap();
        assert!(!diagnostic.contains(&original.host));
        assert!(!diagnostic.contains(&original.name));
        assert!(!diagnostic.contains("do-not-export"));
        assert!(!diagnostic.contains(&dir.path().to_string_lossy().to_string()));
    }
}
