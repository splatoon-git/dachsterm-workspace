use crate::{
    AppState,
    storage::{Group, Profile, Result, Store, db_error},
    tunnels::{Config, Status},
};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tauri::State;
impl Store {
    pub fn setting(&self, key: &str) -> Result<String> {
        self.0
            .lock()
            .unwrap()
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(db_error)
            .map(|v| v.unwrap_or("null".into()))
    }
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.0.lock().unwrap().execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value]).map_err(db_error)?;
        Ok(())
    }
    pub fn tunnel_configs(&self) -> Result<Vec<Config>> {
        Ok(serde_json::from_str(&self.setting("tunnels")?).unwrap_or_default())
    }
}
#[tauri::command]
pub fn tunnel_configs(state: State<AppState>) -> Result<Vec<Config>> {
    state.store.tunnel_configs()
}
#[tauri::command]
pub fn tunnel_save(state: State<AppState>, configs: Vec<Config>) -> Result<()> {
    let _guard = state.mutation.lock().unwrap();
    if configs.len() > 128 {
        return Err("터널 설정은 128개까지 저장할 수 있습니다.".into());
    }
    let mut ids = std::collections::HashSet::new();
    for c in &configs {
        c.validate()?;
        state.store.profile(&c.profile_id)?;
        if !ids.insert(&c.id) {
            return Err("중복 터널 ID".into());
        }
    }
    crate::maintenance::snapshot(&state.store, &state.directory)?;
    state.store.set_setting(
        "tunnels",
        &serde_json::to_string(&configs).map_err(|_| "설정 직렬화 실패")?,
    )
}
#[tauri::command]
pub async fn tunnel_start(
    state: State<'_, AppState>,
    id: String,
    config: Config,
) -> Result<String> {
    if state.connections.control(&id)?.profile.id != config.profile_id {
        return Err("터널 세션 대상 불일치".into());
    }
    state
        .tunnels
        .start(state.connections.clone(), id, config)
        .await
}
#[tauri::command]
pub fn tunnel_stop(state: State<AppState>, id: String) {
    state.tunnels.stop(&id)
}
#[tauri::command]
pub fn tunnel_list(state: State<AppState>) -> Vec<Status> {
    state.tunnels.list()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Bundle {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    pub version: u32,
    pub profiles: Vec<Profile>,
    pub groups: Vec<Group>,
    pub tunnels: Vec<Config>,
}
#[tauri::command]
pub async fn config_export(state: State<'_, AppState>) -> Result<bool> {
    let data = {
        let _guard = state.mutation.lock().unwrap();
        export(&state.store)?
    };
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_file_name("daxterm-sessions.json")
        .add_filter("JSON", &["json"])
        .save_file()
        .await
    else {
        return Ok(false);
    };
    crate::maintenance::atomic_write(file.path(), &data)?;
    Ok(true)
}
pub fn export(store: &Store) -> Result<Vec<u8>> {
    let mut snapshot = store.list()?;
    for p in &mut snapshot.profiles {
        p.has_secret = false;
        p.last_connected = None;
    }
    let tunnels = store
        .tunnel_configs()?
        .into_iter()
        .filter(|c| snapshot.profiles.iter().any(|p| p.id == c.profile_id))
        .collect();
    let data = serde_json::to_vec_pretty(&Bundle {
        format: Some("daxterm.sessions".into()),
        version: 2,
        profiles: snapshot.profiles,
        groups: snapshot.groups,
        tunnels,
    })
    .map_err(|_| "내보내기 실패")?;
    if data.len() > crate::maintenance::MAX_CONFIG_BYTES {
        return Err("설정 백업은 2MiB 이하여야 합니다.".into());
    }
    Ok(data)
}
#[tauri::command]
pub async fn config_import(state: State<'_, AppState>) -> Result<usize> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .add_filter("JSON", &["json"])
        .pick_file()
        .await
    else {
        return Ok(0);
    };
    let data = crate::maintenance::read_config(file.path())?;
    let _guard = state.mutation.lock().unwrap();
    crate::maintenance::snapshot(&state.store, &state.directory)?;
    import(&state.store, &data)
}
pub fn import(store: &Store, data: &[u8]) -> Result<usize> {
    if data.len() > crate::maintenance::MAX_CONFIG_BYTES {
        return Err("설정 파일은 2MiB 이하여야 합니다.".into());
    }
    let mut bundle: Bundle = serde_json::from_slice(data)
        .map_err(|_| "설정 스키마 오류 · 비밀정보와 알 수 없는 필드는 허용하지 않습니다.")?;
    validate_bundle(&bundle)?;
    apply_bundle(store, &mut bundle)
}
pub(crate) fn validate_bundle(bundle: &Bundle) -> Result<()> {
    if !matches!(
        (bundle.version, bundle.format.as_deref()),
        (1, None) | (2, Some("daxterm.sessions"))
    ) || bundle.profiles.len() > 500
        || bundle.groups.len() > 100
        || bundle.tunnels.len() > 128
    {
        return Err("설정 버전 또는 항목 수 오류".into());
    }
    let mut profiles = std::collections::HashSet::new();
    let mut groups = std::collections::HashSet::new();
    let mut tunnels = std::collections::HashSet::new();
    for g in &bundle.groups {
        if g.id.is_empty()
            || g.id.len() > 200
            || g.name.trim().is_empty()
            || g.name.len() > 100
            || !groups.insert(&g.id)
        {
            return Err("그룹 데이터 오류".into());
        }
    }
    for p in &bundle.profiles {
        p.validate()?;
        if p.id.is_empty()
            || p.id.len() > 200
            || p.has_secret
            || !profiles.insert(&p.id)
            || p.group_id.as_ref().is_some_and(|id| !groups.contains(id))
        {
            return Err("세션 ID·비밀정보·그룹 참조 오류".into());
        }
    }
    for c in &bundle.tunnels {
        c.validate()?;
        if c.id.is_empty()
            || c.id.len() > 200
            || !tunnels.insert(&c.id)
            || !profiles.contains(&c.profile_id)
            || !bundle
                .profiles
                .iter()
                .any(|p| p.id == c.profile_id && p.protocol == "ssh")
        {
            return Err("터널 ID 또는 SSH 세션 참조 오류".into());
        }
    }
    Ok(())
}
fn apply_bundle(store: &Store, bundle: &mut Bundle) -> Result<usize> {
    let mut profile_ids = std::collections::HashMap::new();
    let mut group_ids = std::collections::HashMap::new();
    for g in &bundle.groups {
        if g.name.trim().is_empty()
            || g.name.len() > 100
            || group_ids
                .insert(g.id.clone(), uuid::Uuid::new_v4().to_string())
                .is_some()
        {
            return Err("그룹 데이터 오류".into());
        }
    }
    for p in &bundle.profiles {
        p.validate()?;
        if p.has_secret
            || profile_ids
                .insert(p.id.clone(), uuid::Uuid::new_v4().to_string())
                .is_some()
        {
            return Err("세션 데이터 오류".into());
        }
        if p.group_id
            .as_ref()
            .is_some_and(|id| !group_ids.contains_key(id))
        {
            return Err("그룹 참조 오류".into());
        }
    }
    let mut configs = store.tunnel_configs()?;
    for c in &mut bundle.tunnels {
        c.validate()?;
        c.profile_id = profile_ids
            .get(&c.profile_id)
            .ok_or("터널 세션 참조 오류")?
            .clone();
        c.id = uuid::Uuid::new_v4().to_string();
        c.auto_start = false;
    }
    configs.append(&mut bundle.tunnels);
    if configs.len() > 128 {
        return Err("전체 터널 설정 수 제한".into());
    }
    let mut db = store.0.lock().unwrap();
    let tx = db.transaction().map_err(db_error)?;
    for g in bundle.groups.drain(..) {
        tx.execute(
            "INSERT INTO groups(id,name) VALUES(?1,?2)",
            params![group_ids[&g.id], g.name],
        )
        .map_err(db_error)?;
    }
    let count = bundle.profiles.len();
    for mut p in bundle.profiles.drain(..) {
        p.id = profile_ids[&p.id].clone();
        p.group_id = p.group_id.map(|id| group_ids[&id].clone());
        p.has_secret = false;
        p.last_connected = None;
        tx.execute(
            "INSERT INTO profiles(id,data,group_id) VALUES(?1,?2,?3)",
            params![
                p.id,
                serde_json::to_string(&p).map_err(|_| "세션 직렬화 오류")?,
                p.group_id
            ],
        )
        .map_err(db_error)?;
    }
    tx.execute("INSERT INTO settings(key,value) VALUES('tunnels',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[serde_json::to_string(&configs).map_err(|_|"설정 직렬화 실패")?]).map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    Ok(count)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn import_failure_rolls_back_profiles_groups_and_tunnels() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        let mut profile = crate::storage::tests::profile();
        profile.id = "old-id".into();
        profile.group_id = Some("old-group".into());
        let data = serde_json::to_vec(&Bundle {
            format: None,
            version: 1,
            profiles: vec![profile],
            groups: vec![Group {
                id: "old-group".into(),
                name: "group".into(),
            }],
            tunnels: vec![],
        })
        .unwrap();
        store.0.lock().unwrap().execute_batch("CREATE TRIGGER fail_settings BEFORE INSERT ON settings BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
        assert!(import(&store, &data).is_err());
        let state = store.list().unwrap();
        assert!(state.profiles.is_empty());
        assert!(state.groups.is_empty());
        assert!(store.tunnel_configs().unwrap().is_empty());
    }
    #[test]
    fn rejects_secret_and_unknown_schema() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        assert!(
            import(
                &store,
                br#"{"version":1,"profiles":[],"groups":[],"tunnels":[],"password":"x"}"#
            )
            .is_err()
        );
        assert!(
            import(
                &store,
                br#"{"version":99,"profiles":[],"groups":[],"tunnels":[]}"#
            )
            .is_err()
        );
        assert!(store.list().unwrap().profiles.is_empty());
    }
    #[test]
    fn v2_rejects_invalid_references_duplicate_ids_and_future_versions_before_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        let mut p = crate::storage::tests::profile();
        p.id = "session".into();
        let base = Bundle {
            format: Some("daxterm.sessions".into()),
            version: 2,
            profiles: vec![p],
            groups: vec![],
            tunnels: vec![],
        };
        let mut invalid = vec![];
        let mut b = base.clone();
        b.profiles.push(b.profiles[0].clone());
        invalid.push(b);
        let mut b = base.clone();
        b.profiles[0].has_secret = true;
        invalid.push(b);
        let mut b = base.clone();
        b.profiles[0].group_id = Some("missing".into());
        invalid.push(b);
        let mut b = base.clone();
        b.version = 3;
        invalid.push(b);
        let mut b = base.clone();
        b.format = None;
        invalid.push(b);
        let mut b = base.clone();
        b.tunnels.push(Config {
            id: "t".into(),
            profile_id: "missing".into(),
            name: "test".into(),
            kind: "local".into(),
            port: 0,
            host: "localhost".into(),
            target_port: 22,
            auto_start: true,
        });
        invalid.push(b.clone());
        b.tunnels[0].profile_id = "session".into();
        b.tunnels.push(b.tunnels[0].clone());
        invalid.push(b);
        for b in invalid {
            assert!(import(&store, &serde_json::to_vec(&b).unwrap()).is_err());
        }
        assert!(store.list().unwrap().profiles.is_empty());
        let mut valid = base;
        valid.tunnels.push(Config {
            id: "t".into(),
            profile_id: "session".into(),
            name: "test".into(),
            kind: "local".into(),
            port: 0,
            host: "localhost".into(),
            target_port: 22,
            auto_start: true,
        });
        import(&store, &serde_json::to_vec(&valid).unwrap()).unwrap();
        assert!(!store.tunnel_configs().unwrap()[0].auto_start);
        assert_ne!(store.tunnel_configs().unwrap()[0].profile_id, "session");
    }
}
