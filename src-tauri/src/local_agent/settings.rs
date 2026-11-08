//! The app-wide choice for local tabs (DX.13): whether they get the app's agent and which key
//! files it offers. Local tabs have no session, so this is one setting for the whole app, edited in
//! Settings › Agents. As with a session's keys (DX.11), a saved Passphrase is only a reference that
//! the backend sets from the card; this module never receives one.
use crate::{
    AppState,
    storage::{ForwardKey, Result, Store, check_forward_keys, db_error},
};
use rusqlite::params;
use serde::Serialize;
use tokio::task::spawn_blocking;

const ENABLED: &str = "localAgent";
pub(crate) const KEYS: &str = "localAgentKeys";
const CORRUPT: &str =
    "로컬 탭 키 제공 설정이 손상되었습니다. 설정 › 에이전트에서 키 목록을 다시 저장하세요.";
const UPSERT: &str = "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value";

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalAgent {
    pub enabled: bool,
    pub keys: Vec<ForwardKey>,
}
impl LocalAgent {
    pub fn refs(&self) -> impl Iterator<Item = &str> {
        self.keys.iter().filter_map(|k| k.secret_ref.as_deref())
    }
}

pub(crate) fn keys_value(keys: &[ForwardKey]) -> Result<String> {
    serde_json::to_string(keys).map_err(|_| "설정 직렬화 실패".into())
}

impl Store {
    /// Off with no keys until saved once. Damaged values are an error, not an empty list.
    pub fn local_agent(&self) -> Result<LocalAgent> {
        let enabled: Option<bool> =
            serde_json::from_str(&self.setting(ENABLED)?).map_err(|_| CORRUPT)?;
        let keys: Option<Vec<ForwardKey>> =
            serde_json::from_str(&self.setting(KEYS)?).map_err(|_| CORRUPT)?;
        let keys = keys.unwrap_or_default();
        check_forward_keys(&keys).map_err(|_| CORRUPT)?;
        Ok(LocalAgent {
            enabled: enabled.unwrap_or(false),
            keys,
        })
    }
    /// A kept key file keeps its saved Passphrase; a removed one's reference goes to the cleanup
    /// journal. Callers hold `AppState.mutation`.
    pub fn save_local_agent(&self, enabled: bool, paths: Vec<String>) -> Result<LocalAgent> {
        let old = self.local_agent()?;
        let keys: Vec<ForwardKey> = paths
            .into_iter()
            .map(|path| ForwardKey {
                secret_ref: old
                    .keys
                    .iter()
                    .find(|k| k.path == path)
                    .and_then(|k| k.secret_ref.clone()),
                path,
            })
            .collect();
        check_forward_keys(&keys)?;
        let saved = LocalAgent { enabled, keys };
        let dropped: Vec<&str> = old
            .refs()
            .filter(|r| !saved.refs().any(|kept| kept == *r))
            .collect();
        let value = keys_value(&saved.keys)?;
        let mut db = self.0.lock().unwrap();
        let tx = db.transaction().map_err(db_error)?;
        for reference in dropped {
            tx.execute("INSERT OR IGNORE INTO credential_gc VALUES(?)", [reference])
                .map_err(db_error)?;
        }
        tx.execute(UPSERT, params![ENABLED, enabled.to_string()])
            .map_err(db_error)?;
        tx.execute(UPSERT, params![KEYS, value]).map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(saved)
    }
    /// The local counterpart of `set_forward_secret`: points a key at a Passphrase that
    /// `Vault::save` just stored and staged. Callers hold `AppState.mutation`.
    pub fn set_local_agent_secret(&self, path: &str, reference: &str) -> Result<()> {
        let mut settings = self.local_agent()?;
        let key = settings
            .keys
            .iter_mut()
            .find(|k| k.path == path)
            .ok_or("로컬 탭의 키 목록이 바뀌어 Passphrase를 저장하지 않았습니다.")?;
        let previous = key.secret_ref.replace(reference.into());
        let value = keys_value(&settings.keys)?;
        let mut db = self.0.lock().unwrap();
        let tx = db.transaction().map_err(db_error)?;
        if tx
            .execute("DELETE FROM credential_gc WHERE id=?", [reference])
            .map_err(db_error)?
            == 0
        {
            drop(tx);
            db.execute("INSERT OR IGNORE INTO credential_gc VALUES(?)", [reference])
                .map_err(db_error)?;
            return Err("Passphrase를 저장하지 못했습니다. 다시 시도하세요.".into());
        }
        if let Some(previous) = previous {
            tx.execute("INSERT OR IGNORE INTO credential_gc VALUES(?)", [previous])
                .map_err(db_error)?;
        }
        tx.execute(UPSERT, params![KEYS, value]).map_err(db_error)?;
        tx.commit().map_err(db_error)
    }
}

#[tauri::command]
pub async fn local_agent_settings(state: tauri::State<'_, AppState>) -> Result<LocalAgent> {
    let store = state.store.clone();
    spawn_blocking(move || store.local_agent())
        .await
        .map_err(|_| "설정을 읽지 못했습니다.")?
}

/// Applies to local tabs opened afterwards. A tab already open keeps the agent it started with.
#[tauri::command]
pub async fn local_agent_save(
    app: tauri::AppHandle,
    enabled: bool,
    keys: Vec<String>,
) -> Result<LocalAgent> {
    spawn_blocking(move || {
        use tauri::Manager;
        let state = app.state::<AppState>();
        let _guard = state.mutation.lock().unwrap();
        state.store.save_local_agent(enabled, keys)
    })
    .await
    .map_err(|_| "설정을 저장하지 못했습니다.")?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Store, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        (Store::open(&dir.path().join("test.db")).unwrap(), dir)
    }
    fn journaled(store: &Store) -> Vec<String> {
        store
            .0
            .lock()
            .unwrap()
            .prepare("SELECT id FROM credential_gc ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }
    fn stage(store: &Store, reference: &str) {
        store.stage_secret(reference).unwrap();
    }

    #[test]
    fn off_until_saved_and_damage_is_an_error() {
        let (store, _dir) = store();
        assert_eq!(store.local_agent().unwrap(), LocalAgent::default());
        store.set_setting(KEYS, "{not json").unwrap();
        assert_eq!(store.local_agent(), Err(CORRUPT.to_string()));
        store
            .set_setting(
                KEYS,
                &keys_value(&[ForwardKey {
                    path: " ".into(),
                    secret_ref: None,
                }])
                .unwrap(),
            )
            .unwrap();
        assert_eq!(store.local_agent(), Err(CORRUPT.to_string()));
    }

    #[test]
    fn keys_are_bounded_and_keep_only_backend_references() {
        let (store, _dir) = store();
        let saved = store
            .save_local_agent(true, vec!["a".into(), "b".into()])
            .unwrap();
        assert!(saved.enabled && saved.refs().next().is_none());
        assert_eq!(store.local_agent().unwrap(), saved);
        let too_many = (0..9).map(|i| i.to_string()).collect();
        assert!(store.save_local_agent(true, too_many).is_err());
        assert!(
            store
                .save_local_agent(true, vec!["a".into(), "a".into()])
                .is_err()
        );

        stage(&store, "ref-a");
        store.set_local_agent_secret("a", "ref-a").unwrap();
        assert!(journaled(&store).is_empty(), "the reference is in use");
        assert!(
            store.set_local_agent_secret("gone", "ref-x").is_err(),
            "a key no longer listed"
        );
        assert!(
            store.set_local_agent_secret("b", "ref-cleaned").is_err(),
            "a cleanup removed the value in between"
        );
        assert_eq!(journaled(&store), ["ref-cleaned"]);

        let kept = store
            .save_local_agent(false, vec!["b".into(), "a".into()])
            .unwrap();
        assert_eq!(
            kept.refs().collect::<Vec<_>>(),
            ["ref-a"],
            "kept with its file"
        );
        stage(&store, "ref-a2");
        store.set_local_agent_secret("a", "ref-a2").unwrap();
        assert_eq!(
            journaled(&store),
            ["ref-a", "ref-cleaned"],
            "the replaced one"
        );
        store.save_local_agent(false, vec!["b".into()]).unwrap();
        assert_eq!(
            journaled(&store),
            ["ref-a", "ref-a2", "ref-cleaned"],
            "the removed key"
        );
    }
}
