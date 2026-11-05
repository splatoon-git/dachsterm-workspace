use crate::{
    AppState,
    storage::{Group, Profile, Result, Store, db_error},
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keepalive: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favorite: Option<bool>,
    /// Empty string moves to the root; absent means leave unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<i32>,
}
impl Options {
    pub fn apply(&self, p: &mut Profile) -> Result<()> {
        macro_rules! field { ($($f:ident),*) => { $(if let Some(v) = &self.$f { p.$f = v.clone(); })* }; }
        field!(
            port, auth, key_path, encoding, timeout, keepalive, jump_ids, tags, favorite,
            sort_order
        );
        if let Some(g) = &self.group_id {
            p.group_id = (!g.is_empty()).then(|| g.clone());
        }
        p.validate()
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub options: Options,
}
impl Template {
    pub fn validate(&self, profiles: &[Profile], groups: &[Group]) -> Result<()> {
        if self.id.is_empty()
            || self.id.len() > 200
            || self.name.trim().is_empty()
            || self.name.len() > 200
        {
            return Err("템플릿 ID·이름 오류".into());
        }
        // Reuse the profile validator without constructing or copying credentials.
        let mut p: Profile = serde_json::from_value(serde_json::json!({
            "id":format!("template:{}",self.id), "name":"template", "host":"template.invalid", "port":22,
            "username":"template", "auth":"password", "keyPath":"", "groupId":null,
            "favorite":false, "timeout":15,"keepalive":15
        })).map_err(|_| "템플릿 검증 오류")?;
        self.options.apply(&mut p)?;
        if p.group_id
            .as_ref()
            .is_some_and(|id| !groups.iter().any(|g| &g.id == id))
        {
            return Err("템플릿 그룹 참조 오류".into());
        }
        crate::routes::resolve(&p, profiles)?;
        Ok(())
    }
}
pub fn templates(store: &Store) -> Result<Vec<Template>> {
    let value = store.setting("session_templates")?;
    if value == "null" {
        return Ok(vec![]);
    }
    serde_json::from_str(&value).map_err(|_| "템플릿 저장 형식 오류".into())
}
pub fn validate_groups(groups: &[Group]) -> Result<()> {
    if groups.len() > 100 {
        return Err("그룹은 최대 100개입니다.".into());
    }
    let mut ids = std::collections::HashSet::new();
    for g in groups {
        if g.id.is_empty()
            || g.id.len() > 200
            || g.name.trim().is_empty()
            || g.name.len() > 100
            || !ids.insert(&g.id)
        {
            return Err("그룹 ID·이름 오류".into());
        }
        let mut seen = std::collections::HashSet::from([g.id.as_str()]);
        let mut parent = g.parent_id.as_deref();
        while let Some(id) = parent {
            if !seen.insert(id) || seen.len() > 16 {
                return Err("그룹 순환 또는 최대 16단계 초과".into());
            }
            parent = groups
                .iter()
                .find(|p| p.id == id)
                .ok_or("상위 그룹이 없습니다.")?
                .parent_id
                .as_deref();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn session_templates(state: State<AppState>) -> Result<Vec<Template>> {
    templates(&state.store)
}
#[tauri::command]
pub fn template_save(state: State<AppState>, template: Template, remove: bool) -> Result<()> {
    let _guard = state.mutation.lock().unwrap();
    let mut all = templates(&state.store)?;
    all.retain(|t| t.id != template.id);
    if !remove {
        let snapshot = state.store.list()?;
        template.validate(&snapshot.profiles, &snapshot.groups)?;
        all.push(template);
    }
    if all.len() > 100 {
        return Err("템플릿은 최대 100개입니다.".into());
    }
    crate::maintenance::snapshot(&state.store, &state.directory)?;
    state.store.set_setting(
        "session_templates",
        &serde_json::to_string(&all).map_err(|_| "템플릿 직렬화 오류")?,
    )
}

pub fn batch(store: &Store, expected: Vec<Profile>, options: Options) -> Result<usize> {
    if expected.is_empty() || expected.len() > 500 {
        return Err("대상은 1~500개입니다.".into());
    }
    let mut snapshot = store.list()?;
    let mut changes = Vec::new();
    let mut ids = std::collections::HashSet::new();
    for old in expected {
        if !ids.insert(old.id.clone()) {
            return Err("중복 대상".into());
        }
        let p = snapshot
            .profiles
            .iter_mut()
            .find(|p| p.id == old.id)
            .ok_or("대상 세션이 삭제되었습니다.")?;
        if serde_json::to_value(&*p).ok() != serde_json::to_value(&old).ok() {
            return Err("미리보기 이후 세션이 변경되었습니다. 다시 선택하세요.".into());
        }
        options.apply(p)?;
        if p.group_id
            .as_ref()
            .is_some_and(|id| !snapshot.groups.iter().any(|g| &g.id == id))
        {
            return Err("그룹 참조 오류".into());
        }
        // Never silently reuse a credential at a changed identity or endpoint.
        if old.has_secret
            && (p.port != old.port
                || p.auth != old.auth
                || p.key_path != old.key_path
                || p.jump_ids != old.jump_ids)
        {
            return Err("인증정보가 있는 세션의 포트·인증·키 변경은 개별 편집에서 인증정보를 먼저 해제하세요.".into());
        }
        changes.push(p.clone());
    }
    crate::routes::validate(&snapshot.profiles)?;
    let mut db = store.0.lock().unwrap();
    let tx = db.transaction().map_err(db_error)?;
    for mut p in changes {
        p.has_secret = false;
        p.last_connected = None;
        tx.execute(
            "UPDATE profiles SET data=?1,group_id=?2 WHERE id=?3",
            params![
                serde_json::to_string(&p).map_err(|_| "직렬화 오류")?,
                p.group_id,
                p.id
            ],
        )
        .map_err(db_error)?;
    }
    tx.commit().map_err(db_error)?;
    Ok(ids.len())
}
#[tauri::command]
pub fn session_batch(
    state: State<AppState>,
    expected: Vec<Profile>,
    options: Options,
) -> Result<usize> {
    let _guard = state.mutation.lock().unwrap();
    crate::maintenance::snapshot(&state.store, &state.directory)?;
    batch(&state.store, expected, options)
}

#[tauri::command]
pub fn group_update(state: State<AppState>, group: Group) -> Result<()> {
    let _guard = state.mutation.lock().unwrap();
    let mut groups = state.store.list()?.groups;
    groups.retain(|g| g.id != group.id);
    groups.push(group.clone());
    validate_groups(&groups)?;
    crate::maintenance::snapshot(&state.store, &state.directory)?;
    state.store.0.lock().unwrap().execute("INSERT INTO groups(id,name,parent_id,sort_order) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET name=?2,parent_id=?3,sort_order=?4",params![group.id,group.name,group.parent_id,group.sort_order]).map_err(db_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hierarchy_cycle_orphan_and_depth_rejected() {
        let mut groups: Vec<_> = (0..16)
            .map(|i| Group {
                id: i.to_string(),
                name: i.to_string(),
                parent_id: if i == 0 {
                    None
                } else {
                    Some((i - 1).to_string())
                },
                sort_order: 0,
            })
            .collect();
        assert!(validate_groups(&groups).is_ok());
        groups[0].parent_id = Some("15".into());
        assert!(validate_groups(&groups).is_err());
        groups[0].parent_id = Some("absent".into());
        assert!(validate_groups(&groups).is_err());
    }
    #[test]
    fn batch_is_atomic_and_rejects_stale_preview() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        let a = store.save(crate::storage::tests::profile(), None).unwrap();
        let b = store.save(crate::storage::tests::profile(), None).unwrap();
        store.0.lock().unwrap().execute_batch(&format!("CREATE TRIGGER fail BEFORE UPDATE ON profiles WHEN old.id='{}' BEGIN SELECT RAISE(ABORT,'injected'); END",b.id)).unwrap();
        assert!(
            batch(
                &store,
                vec![a.clone(), b],
                Options {
                    tags: Some(vec!["prod".into()]),
                    ..Default::default()
                }
            )
            .is_err()
        );
        assert!(store.profile(&a.id).unwrap().tags.is_empty());
        let mut stale = a;
        stale.name = "stale".into();
        assert!(batch(&store, vec![stale], Options::default()).is_err());
    }
}
