use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Mutex};
use uuid::Uuid;

pub type Result<T> = std::result::Result<T, String>;
pub fn db_error(_: rusqlite::Error) -> String {
    "세션 데이터베이스 작업에 실패했습니다.".into()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: String,
    #[serde(default = "default_protocol")]
    pub protocol: String,
    #[serde(default)]
    pub tls_ca_path: String,
    #[serde(default = "crate::encoding::default_encoding")]
    pub encoding: String,
    pub key_path: String,
    #[serde(default)]
    pub jump_ids: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub sort_order: i32,
    pub group_id: Option<String>,
    pub favorite: bool,
    pub timeout: u64,
    pub keepalive: u64,
    /// Empty means off. Not part of session JSON and not part of "same connection target".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tmux_session: String,
    /// Off unless the user turns it on in the form. Never taken from a session file either.
    #[serde(default, skip_serializing_if = "is_false")]
    pub forward_agent: bool,
    /// Built-in agent sources (DX.11). Like `forward_agent`, a session file never sets them.
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    pub forward_login_key: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub forward_keys: Vec<ForwardKey>,
    #[serde(default = "yes", skip_serializing_if = "is_true")]
    pub forward_system_agent: bool,
    #[serde(default)]
    pub last_connected: Option<i64>,
    #[serde(default)]
    pub has_secret: bool,
}
fn is_false(value: &bool) -> bool {
    !value
}
fn is_true(value: &bool) -> bool {
    *value
}
fn yes() -> bool {
    true
}
/// A key file the built-in agent offers. `secret_ref` points at its stored Passphrase; only the
/// backend sets it (`Store::save` keeps the saved one), the form's value is ignored.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForwardKey {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_ref: Option<String>,
}
pub const MAX_FORWARD_KEYS: usize = 8;
fn default_protocol() -> String {
    "ssh".into()
}
impl Profile {
    /// A new SSH session with default options, for sessions read from other tools' settings.
    pub(crate) fn imported(name: &str, host: &str, username: &str, port: u16) -> Self {
        Profile {
            id: Uuid::new_v4().to_string(),
            name: name.into(),
            host: host.into(),
            port,
            username: username.into(),
            auth: "password".into(),
            protocol: "ssh".into(),
            tls_ca_path: String::new(),
            encoding: "utf-8".into(),
            key_path: String::new(),
            jump_ids: vec![],
            tags: vec![],
            sort_order: 0,
            group_id: None,
            favorite: false,
            timeout: 15,
            keepalive: 15,
            tmux_session: String::new(),
            forward_agent: false,
            forward_login_key: true,
            forward_keys: vec![],
            forward_system_agent: true,
            last_connected: None,
            has_secret: false,
        }
    }
    /// Stored Passphrase references of the forwarded key files.
    pub fn forward_refs(&self) -> impl Iterator<Item = &str> {
        self.forward_keys
            .iter()
            .filter_map(|k| k.secret_ref.as_deref())
    }
    pub fn validate(&self) -> Result<()> {
        crate::encoding::get(&self.encoding)?;
        crate::terminal_start::check_name(&self.tmux_session)?;
        if self.protocol != "ssh" && !self.tmux_session.is_empty() {
            return Err("tmux 세션은 SSH 연결에서만 사용할 수 있습니다.".into());
        }
        if self.protocol != "ssh" && (self.forward_agent || !self.forward_keys.is_empty()) {
            return Err("키 전달은 SSH 연결에서만 사용할 수 있습니다.".into());
        }
        let keys = &self.forward_keys;
        if keys.len() > MAX_FORWARD_KEYS
            || keys.iter().enumerate().any(|(i, k)| {
                k.path.trim().is_empty()
                    || k.path.len() > 4096
                    || k.path.chars().any(char::is_control)
                    || keys[..i].iter().any(|o| o.path == k.path)
            })
        {
            return Err("전달할 키는 서로 다른 파일로 최대 8개입니다.".into());
        }
        if self.jump_ids.len() > crate::routes::MAX_HOPS
            || (self.protocol != "ssh" && !self.jump_ids.is_empty())
            || self.tags.len() > 32
            || self
                .tags
                .iter()
                .any(|t| t.trim().is_empty() || t.len() > 64 || t.chars().any(char::is_control))
        {
            return Err(
                "경유지는 최대 4개, 태그는 64바이트 이하 32개입니다. SSH 경유 설정을 확인하세요."
                    .into(),
            );
        }
        if !["ssh", "ftp", "ftps"].contains(&self.protocol.as_str())
            || (self.protocol != "ssh" && self.auth != "password")
            || self.tls_ca_path.len() > 4096
        {
            return Err("프로토콜 또는 TLS 설정을 확인하세요.".into());
        }
        if self.name.trim().is_empty()
            || self.name.len() > 200
            || self.host.is_empty()
            || self.host.len() > 253
            || self.host.chars().any(|c| {
                c.is_whitespace() || c.is_control() || matches!(c, '/' | '\\' | ',' | '[' | ']')
            })
            || self.port == 0
            || self.username.is_empty()
            || self.username.len() > 256
            || self.username.chars().any(char::is_control)
            || !matches!(
                self.auth.as_str(),
                "password" | "key" | "agent" | "interactive"
            )
            || self.key_path.len() > 4096
            || (self.auth == "key" && self.key_path.is_empty())
            || !(5..=120).contains(&self.timeout)
            || !(5..=300).contains(&self.keepalive)
        {
            return Err(
                "연결 설정을 확인하세요. 타임아웃 5~120초, KeepAlive 5~300초가 필요합니다.".into(),
            );
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Group {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
}
#[derive(Serialize)]
pub struct Snapshot {
    pub profiles: Vec<Profile>,
    pub groups: Vec<Group>,
    #[serde(rename = "credentialWarning")]
    pub credential_warning: Option<String>,
}
pub struct Store(pub Mutex<Connection>);
/// The JSON kept in `profiles.data`. Group, secret presence and last use live in columns.
pub(crate) fn profile_data(p: &Profile) -> Result<String> {
    let mut p = p.clone();
    p.has_secret = false;
    p.last_connected = None;
    serde_json::to_string(&p).map_err(|_| "세션 직렬화 오류".into())
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let mut connection = Connection::open(path).map_err(db_error)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(db_error)?;
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(db_error)?;
        if version > 4 {
            return Err("더 새로운 버전에서 만든 데이터베이스입니다. 앱을 업데이트하세요.".into());
        }
        let integrity: String = connection
            .query_row("PRAGMA quick_check", [], |r| r.get(0))
            .map_err(db_error)?;
        if integrity != "ok" {
            return Err(
                "세션 데이터베이스가 손상되었습니다. 원본을 보존하고 설정 복구본을 사용하세요."
                    .into(),
            );
        }
        connection
            .execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")
            .map_err(db_error)?;
        let tx = connection.transaction().map_err(db_error)?;
        tx.execute_batch("
            CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY, data TEXT NOT NULL, group_id TEXT REFERENCES groups(id) ON DELETE SET NULL, secret_ref TEXT, last_connected INTEGER);
            CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS credential_gc(id TEXT PRIMARY KEY);
            PRAGMA user_version=3;").map_err(db_error)?;
        if version < 4 {
            let has_parent: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('groups') WHERE name='parent_id')",[],|r|r.get(0)).map_err(db_error)?;
            if !has_parent {
                tx.execute_batch("ALTER TABLE groups ADD COLUMN parent_id TEXT REFERENCES groups(id) ON DELETE SET NULL; ALTER TABLE groups ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;").map_err(db_error)?;
            }
        }
        tx.execute_batch("PRAGMA user_version=4;")
            .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(Self(Mutex::new(connection)))
    }
    pub fn list(&self) -> Result<Snapshot> {
        let db = self.0.lock().unwrap();
        let mut statement = db
            .prepare("SELECT data,group_id,secret_ref,last_connected FROM profiles ORDER BY rowid")
            .map_err(db_error)?;
        let profiles = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<i64>>(3)?,
                ))
            })
            .map_err(db_error)?
            .map(|row| {
                let (data, group, secret, last) = row.map_err(db_error)?;
                let mut p: Profile =
                    serde_json::from_str(&data).map_err(|_| "세션 데이터 형식 오류".to_string())?;
                p.group_id = group;
                p.has_secret = secret.is_some();
                p.last_connected = last;
                Ok(p)
            })
            .collect::<Result<Vec<_>>>()?;
        let groups = db
            .prepare("SELECT id,name,parent_id,sort_order FROM groups ORDER BY sort_order,name")
            .map_err(db_error)?
            .query_map([], |r| {
                Ok(Group {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    parent_id: r.get(2)?,
                    sort_order: r.get(3)?,
                })
            })
            .map_err(db_error)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(Snapshot {
            profiles,
            groups,
            credential_warning: None,
        })
    }
    pub fn profile(&self, id: &str) -> Result<Profile> {
        self.list()?
            .profiles
            .into_iter()
            .find(|p| p.id == id)
            .ok_or("세션을 찾을 수 없습니다.".into())
    }
    pub fn secret_ref(&self, id: &str) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        self.0
            .lock()
            .unwrap()
            .query_row("SELECT secret_ref FROM profiles WHERE id=?", [id], |r| {
                r.get(0)
            })
            .optional()
            .map(|r| r.flatten())
            .map_err(db_error)
    }
    pub fn save(&self, mut p: Profile, secret: Option<String>) -> Result<Profile> {
        p.validate()?;
        let old = if p.id.is_empty() {
            p.id = Uuid::new_v4().to_string();
            None
        } else {
            Some(self.profile(&p.id)?)
        };
        // The form cannot choose a stored Passphrase: a key keeps the one saved for its file.
        for key in &mut p.forward_keys {
            key.secret_ref = old
                .iter()
                .flat_map(|o| &o.forward_keys)
                .find(|k| k.path == key.path)
                .and_then(|k| k.secret_ref.clone());
        }
        let dropped: Vec<String> = old
            .iter()
            .flat_map(|o| o.forward_refs())
            .filter(|r| !p.forward_refs().any(|kept| kept == *r))
            .map(String::from)
            .collect();
        let mut profiles = self.list()?.profiles;
        profiles.retain(|old| old.id != p.id);
        profiles.push(p.clone());
        if profiles.len() > 500 {
            return Err("세션은 최대 500개입니다.".into());
        }
        crate::routes::validate(&profiles)?;
        for t in crate::session_management::templates(self)? {
            t.validate(&profiles, &self.list()?.groups)?;
        }
        let data = profile_data(&p)?;
        {
            let mut db = self.0.lock().unwrap();
            let tx = db.transaction().map_err(db_error)?;
            for reference in &dropped {
                tx.execute("INSERT OR IGNORE INTO credential_gc VALUES(?)", [reference])
                    .map_err(db_error)?;
            }
            tx.execute("INSERT OR IGNORE INTO credential_gc SELECT secret_ref FROM profiles WHERE id=?1 AND secret_ref IS NOT NULL AND secret_ref IS NOT ?2",params![p.id,secret]).map_err(db_error)?;
            tx.execute("INSERT INTO profiles(id,data,group_id,secret_ref) VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET data=?2,group_id=?3,secret_ref=?4",params![p.id,data,p.group_id,secret]).map_err(db_error)?;
            tx.execute("DELETE FROM credential_gc WHERE id=?", [&secret])
                .map_err(db_error)?;
            tx.commit().map_err(db_error)?;
        }
        self.profile(&p.id)
    }
    pub fn stage_secret(&self, id: &str) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .execute("INSERT OR IGNORE INTO credential_gc VALUES(?)", [id])
            .map_err(db_error)?;
        Ok(())
    }
    /// Callers hold `AppState.mutation`, so nothing is referenced between the query and the
    /// removal. The OS store is called without the database lock.
    pub fn cleanup_credentials(&self) -> Result<()> {
        let forwarded: std::collections::HashSet<String> = self
            .list()?
            .profiles
            .iter()
            .flat_map(|p| p.forward_refs().map(String::from))
            .collect();
        let ids = {
            let db = self.0.lock().unwrap();
            db.prepare("SELECT id FROM credential_gc WHERE id NOT IN (SELECT secret_ref FROM profiles WHERE secret_ref IS NOT NULL)").map_err(db_error)?.query_map([],|r|r.get::<_,String>(0)).map_err(db_error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(db_error)?
        };
        for id in ids.into_iter().filter(|id| !forwarded.contains(id)) {
            crate::credentials::delete(&id)?;
            self.0
                .lock()
                .unwrap()
                .execute("DELETE FROM credential_gc WHERE id=?", [id])
                .map_err(db_error)?;
        }
        Ok(())
    }
    /// Points a forwarded key at a Passphrase `Vault::save` just stored and staged. If a cleanup
    /// removed it in between, it is staged again and nothing refers to it.
    pub fn set_forward_secret(&self, profile: &str, path: &str, reference: &str) -> Result<()> {
        let mut p = self.profile(profile)?;
        let changed = "세션의 전달할 키가 바뀌어 Passphrase를 저장하지 않았습니다.";
        let key = p
            .forward_keys
            .iter_mut()
            .find(|k| k.path == path)
            .ok_or(changed)?;
        let previous = key.secret_ref.replace(reference.into());
        let data = profile_data(&p)?;
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
        tx.execute(
            "UPDATE profiles SET data=?1 WHERE id=?2",
            params![data, profile],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }
    pub fn touch(&self, id: &str) -> Result<()> {
        self.0
            .lock()
            .unwrap()
            .execute(
                "UPDATE profiles SET last_connected=unixepoch() WHERE id=?",
                [id],
            )
            .map_err(db_error)?;
        Ok(())
    }
    pub fn delete(&self, id: &str) -> Result<()> {
        if self
            .list()?
            .profiles
            .iter()
            .any(|p| p.jump_ids.iter().any(|h| h == id))
            || crate::session_management::templates(self)?.iter().any(|t| {
                t.options
                    .jump_ids
                    .as_ref()
                    .is_some_and(|ids| ids.iter().any(|h| h == id))
            })
        {
            return Err("다른 세션 또는 템플릿의 경유지입니다. 참조를 먼저 수정하세요. 열린 연결은 기존 경로를 유지합니다.".into());
        }
        use rusqlite::OptionalExtension;
        let forwarded: Vec<String> = self
            .profile(id)
            .map(|p| p.forward_refs().map(String::from).collect())
            .unwrap_or_default();
        let mut db = self.0.lock().unwrap();
        let tx = db.transaction().map_err(db_error)?;
        tx.execute("INSERT OR IGNORE INTO credential_gc SELECT secret_ref FROM profiles WHERE id=? AND secret_ref IS NOT NULL", [id]).map_err(db_error)?;
        for reference in &forwarded {
            tx.execute("INSERT OR IGNORE INTO credential_gc VALUES(?)", [reference])
                .map_err(db_error)?;
        }
        tx.execute("DELETE FROM profiles WHERE id=?", [id])
            .map_err(db_error)?;
        if let Some(value) = tx
            .query_row("SELECT value FROM settings WHERE key='tunnels'", [], |r| {
                r.get::<_, String>(0)
            })
            .optional()
            .map_err(db_error)?
        {
            let mut configs: Vec<crate::tunnels::Config> =
                serde_json::from_str(&value).map_err(|_| "터널 설정 형식 오류")?;
            configs.retain(|c| c.profile_id != id);
            let value = serde_json::to_string(&configs).map_err(|_| "터널 설정 직렬화 오류")?;
            tx.execute("UPDATE settings SET value=? WHERE key='tunnels'", [value])
                .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(())
    }
    pub fn group(&self, id: Option<String>, name: Option<String>) -> Result<()> {
        let id = id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let groups = self.list()?.groups;
        if name.is_some() && groups.len() >= 100 && !groups.iter().any(|g| g.id == id) {
            return Err("그룹은 최대 100개입니다.".into());
        }
        if name.is_none()
            && crate::session_management::templates(self)?
                .iter()
                .any(|t| t.options.group_id.as_deref() == Some(&id))
        {
            return Err(
                "템플릿에서 참조 중인 그룹입니다. 템플릿의 그룹 설정을 먼저 변경하세요.".into(),
            );
        }
        let db = self.0.lock().unwrap();
        if let Some(name) = name {
            if name.trim().is_empty() || name.len() > 100 {
                return Err("그룹 이름은 1~100자로 입력하세요.".into());
            }
            db.execute(
                "INSERT INTO groups(id,name) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET name=?2",
                params![id, name.trim()],
            )
            .map_err(db_error)?;
        } else {
            db.execute("DELETE FROM groups WHERE id=?", [id])
                .map_err(db_error)?;
        }
        Ok(())
    }
}
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub fn profile() -> Profile {
        Profile {
            id: String::new(),
            name: "서버".into(),
            host: "localhost".into(),
            port: 22,
            username: "user".into(),
            auth: "password".into(),
            protocol: "ssh".into(),
            tls_ca_path: String::new(),
            encoding: "utf-8".into(),
            key_path: String::new(),
            jump_ids: vec![],
            tags: vec![],
            sort_order: 0,
            group_id: None,
            favorite: false,
            timeout: 15,
            keepalive: 15,
            tmux_session: String::new(),
            forward_agent: false,
            forward_login_key: true,
            forward_keys: vec![],
            forward_system_agent: true,
            last_connected: None,
            has_secret: false,
        }
    }
    #[test]
    fn forward_agent_needs_ssh() {
        let mut p = profile();
        p.forward_agent = true;
        assert!(p.validate().is_ok());
        p.protocol = "ftps".into();
        assert!(p.validate().is_err());
    }
    #[test]
    fn tmux_session_needs_ssh_and_a_safe_name() {
        let mut p = profile();
        p.tmux_session = "work_1-a".into();
        assert!(p.validate().is_ok());
        p.tmux_session = "a b".into();
        assert!(p.validate().is_err());
        p.tmux_session = "work".into();
        p.protocol = "ftp".into();
        assert!(p.validate().is_err());
        p.tmux_session.clear();
        assert!(p.validate().is_ok());
    }
    #[test]
    fn persistence_and_groups() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sessions.db");
        let s = Store::open(&path).unwrap();
        s.group(Some("group".into()), Some("개발".into())).unwrap();
        let mut p = profile();
        p.group_id = Some("group".into());
        let p = s.save(p, Some("reference-only".into())).unwrap();
        s.touch(&p.id).unwrap();
        drop(s);
        let s = Store::open(&path).unwrap();
        assert!(s.profile(&p.id).unwrap().has_secret);
        assert!(s.profile(&p.id).unwrap().last_connected.is_some());
        s.group(Some("group".into()), None).unwrap();
        assert!(s.profile(&p.id).unwrap().group_id.is_none());
        s.delete(&p.id).unwrap();
        assert!(s.list().unwrap().profiles.is_empty());
    }
    #[test]
    fn invalid_targets_rejected() {
        for host in ["bad\nhost", "host,other", "[host]", ""] {
            let mut p = profile();
            p.host = host.into();
            assert!(p.validate().is_err());
        }
    }
    #[test]
    fn failed_save_preserves_old_secret_reference_and_journals_new_one() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).unwrap();
        let mut p = store.save(profile(), Some("old-reference".into())).unwrap();
        store.stage_secret("new-reference").unwrap();
        p.group_id = Some("missing-group".into());
        assert!(store.save(p.clone(), Some("new-reference".into())).is_err());
        assert_eq!(
            store.secret_ref(&p.id).unwrap().as_deref(),
            Some("old-reference")
        );
        let count: i64 = store
            .0
            .lock()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM credential_gc WHERE id='new-reference'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
    fn journaled(store: &Store) -> Vec<String> {
        let db = store.0.lock().unwrap();
        let mut statement = db
            .prepare("SELECT id FROM credential_gc ORDER BY id")
            .unwrap();
        statement
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<std::result::Result<_, _>>()
            .unwrap()
    }
    fn key(path: &str, secret_ref: Option<&str>) -> ForwardKey {
        ForwardKey {
            path: path.into(),
            secret_ref: secret_ref.map(Into::into),
        }
    }
    #[test]
    fn forwarded_key_passphrases_are_referenced_only_by_the_backend() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("test.db")).unwrap();
        let mut p = profile();
        p.forward_keys = vec![key("a", Some("forged")), key("b", None)];
        let p = store.save(p, None).unwrap();
        assert_eq!(
            p.forward_refs().count(),
            0,
            "a form cannot pick a reference"
        );
        assert!(store.set_forward_secret(&p.id, "a", "ref-a").is_err());
        assert_eq!(
            journaled(&store),
            ["ref-a"],
            "an unstaged one stays journaled"
        );
        store.stage_secret("ref-b").unwrap();
        store.set_forward_secret(&p.id, "b", "ref-b").unwrap();
        assert_eq!(journaled(&store), ["ref-a"]);
        let mut edited = store.profile(&p.id).unwrap();
        edited.forward_keys = vec![key("b", None), key("c", Some("ref-a"))];
        let edited = store.save(edited, None).unwrap();
        assert_eq!(
            edited.forward_keys,
            [key("b", Some("ref-b")), key("c", None)],
            "the saved reference follows its file"
        );
        store.stage_secret("ref-b2").unwrap();
        store.set_forward_secret(&p.id, "b", "ref-b2").unwrap();
        assert_eq!(journaled(&store), ["ref-a", "ref-b"], "the replaced one");
        let mut copy = store.profile(&p.id).unwrap();
        copy.id.clear();
        assert_eq!(store.save(copy, None).unwrap().forward_refs().count(), 0);
        store.delete(&p.id).unwrap();
        assert_eq!(journaled(&store), ["ref-a", "ref-b", "ref-b2"]);
        let mut removed = store.save(profile(), None).unwrap();
        removed.forward_keys = vec![key("d", None)];
        let removed = store.save(removed, None).unwrap();
        store.stage_secret("ref-d").unwrap();
        store.set_forward_secret(&removed.id, "d", "ref-d").unwrap();
        let mut none = store.profile(&removed.id).unwrap();
        none.forward_keys.clear();
        store.save(none, None).unwrap();
        assert!(
            journaled(&store).contains(&"ref-d".to_string()),
            "a removed key"
        );
    }
    #[test]
    fn forwarded_keys_are_bounded_unique_and_ssh_only() {
        let mut p = profile();
        p.forward_keys = (0..MAX_FORWARD_KEYS)
            .map(|i| key(&i.to_string(), None))
            .collect();
        assert!(p.validate().is_ok());
        p.forward_keys.push(key("x", None));
        assert!(p.validate().is_err());
        p.forward_keys = vec![key("a", None), key("a", None)];
        assert!(p.validate().is_err());
        p.forward_keys = vec![key(" ", None)];
        assert!(p.validate().is_err());
        p.forward_keys = vec![key("a", None)];
        p.protocol = "ftp".into();
        assert!(p.validate().is_err());
    }
    #[test]
    fn legacy_schema_keeps_profiles_and_defaults_encoding() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("legacy.db");
        let store = Store::open(&path).unwrap();
        let p = store.save(profile(), None).unwrap();
        let mut data = serde_json::to_value(&p).unwrap();
        data.as_object_mut().unwrap().remove("encoding");
        store
            .0
            .lock()
            .unwrap()
            .execute(
                "UPDATE profiles SET data=? WHERE id=?",
                params![data.to_string(), p.id],
            )
            .unwrap();
        store
            .0
            .lock()
            .unwrap()
            .execute_batch("PRAGMA user_version=1")
            .unwrap();
        drop(store);
        let migrated = Store::open(&path).unwrap();
        assert_eq!(migrated.profile(&p.id).unwrap().encoding, "utf-8");
        assert_eq!(
            migrated
                .0
                .lock()
                .unwrap()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            4
        );
    }
    #[test]
    fn future_schema_is_not_downgraded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("future.db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA user_version=9").unwrap();
        drop(db);
        assert!(Store::open(&path).is_err());
        let db = Connection::open(path).unwrap();
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            9
        );
    }
    #[test]
    fn failed_delete_keeps_profile_and_does_not_schedule_credential_removal() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        let p = store
            .save(profile(), Some("existing-reference".into()))
            .unwrap();
        store.0.lock().unwrap().execute_batch("CREATE TRIGGER reject_delete BEFORE DELETE ON profiles BEGIN SELECT RAISE(ABORT, 'injected'); END;").unwrap();
        assert!(store.delete(&p.id).is_err());
        assert_eq!(
            store.secret_ref(&p.id).unwrap().as_deref(),
            Some("existing-reference")
        );
        let db = store.0.lock().unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM credential_gc", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        db.execute_batch("DROP TRIGGER reject_delete").unwrap();
        drop(db);
        store.delete(&p.id).unwrap();
        assert!(store.profile(&p.id).is_err());
        assert_eq!(
            store
                .0
                .lock()
                .unwrap()
                .query_row("SELECT id FROM credential_gc", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "existing-reference"
        );
    }
    #[test]
    fn corrupt_database_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let bytes = b"invalid database, preserve for recovery";
        std::fs::write(&path, bytes).unwrap();
        assert!(Store::open(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
    #[test]
    fn failed_schema_setup_rolls_back_created_tables_and_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE sentinel(value TEXT); CREATE INDEX settings ON sentinel(value); PRAGMA user_version=1;").unwrap();
        drop(db);
        assert!(Store::open(&path).is_err());
        let db = Connection::open(&path).unwrap();
        assert_eq!(
            db.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='profiles'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }
}
