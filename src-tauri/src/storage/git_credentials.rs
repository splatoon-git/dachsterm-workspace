//! HTTPS Git credentials the user saved from the card (DX.12). The database keeps protocol, host,
//! user and a reference; the value lives in the OS store or the vault like every other secret,
//! and references that leave go through the `credential_gc` journal.
use super::{Result, Store, db_error};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

const SETTING: &str = "git-credentials";
const MAX_SAVED: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCredential {
    pub protocol: String,
    pub host: String,
    pub username: String,
    pub secret_ref: String,
}
impl GitCredential {
    fn same_target(&self, other: &Self) -> bool {
        self.protocol == other.protocol
            && self.host.eq_ignore_ascii_case(&other.host)
            && self.username == other.username
    }
}

fn read(db: &rusqlite::Connection) -> Result<Vec<GitCredential>> {
    db.query_row("SELECT value FROM settings WHERE key=?", [SETTING], |r| {
        r.get::<_, String>(0)
    })
    .optional()
    .map_err(db_error)?
    // A damaged list is an error, not an empty one: its references would never be cleaned up.
    .map(|value| {
        serde_json::from_str(&value)
            .map_err(|_| "저장한 Git 자격 증명 목록이 손상되었습니다.".into())
    })
    .transpose()
    .map(Option::unwrap_or_default)
}

fn write(tx: &rusqlite::Transaction, list: &[GitCredential]) -> Result<()> {
    let value = serde_json::to_string(list).map_err(|_| "Git 자격 증명 직렬화 오류")?;
    tx.execute(
        "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2",
        params![SETTING, value],
    )
    .map_err(db_error)?;
    Ok(())
}

impl Store {
    pub fn git_credentials(&self) -> Result<Vec<GitCredential>> {
        read(&self.0.lock().unwrap())
    }

    /// Points at a value `Vault::save` just stored and staged; a value already saved for the same
    /// host and user is replaced and journaled. If a cleanup removed the new value in between, it
    /// is staged again and nothing refers to it. Callers hold `AppState.mutation`.
    pub fn set_git_credential(&self, entry: GitCredential) -> Result<()> {
        let mut db = self.0.lock().unwrap();
        let mut list = read(&db)?;
        let tx = db.transaction().map_err(db_error)?;
        if tx
            .execute("DELETE FROM credential_gc WHERE id=?", [&entry.secret_ref])
            .map_err(db_error)?
            == 0
        {
            drop(tx);
            db.execute(
                "INSERT OR IGNORE INTO credential_gc VALUES(?)",
                [&entry.secret_ref],
            )
            .map_err(db_error)?;
            return Err("자격 증명을 저장하지 못했습니다. 다시 시도하세요.".into());
        }
        for old in list.iter().filter(|old| old.same_target(&entry)) {
            tx.execute(
                "INSERT OR IGNORE INTO credential_gc VALUES(?)",
                [&old.secret_ref],
            )
            .map_err(db_error)?;
        }
        list.retain(|old| !old.same_target(&entry));
        if list.len() >= MAX_SAVED {
            return Err(
                "저장한 Git 자격 증명은 최대 200개입니다. 쓰지 않는 항목을 지우세요.".into(),
            );
        }
        list.push(entry);
        write(&tx, &list)?;
        tx.commit().map_err(db_error)
    }

    /// Takes one entry out and journals its value. Callers hold `AppState.mutation` and run
    /// `cleanup_credentials` after it, outside the database lock.
    pub fn forget_git_credential(&self, protocol: &str, host: &str, username: &str) -> Result<()> {
        let mut db = self.0.lock().unwrap();
        let mut list = read(&db)?;
        let target = |e: &GitCredential| {
            e.protocol == protocol && e.host.eq_ignore_ascii_case(host) && e.username == username
        };
        let tx = db.transaction().map_err(db_error)?;
        for old in list.iter().filter(|e| target(e)) {
            tx.execute(
                "INSERT OR IGNORE INTO credential_gc VALUES(?)",
                [&old.secret_ref],
            )
            .map_err(db_error)?;
        }
        list.retain(|e| !target(e));
        write(&tx, &list)?;
        tx.commit().map_err(db_error)
    }

    /// For `Vault::configure`: the list with new references, written in its transaction.
    pub(crate) fn write_git_credentials(
        tx: &rusqlite::Transaction,
        list: &[GitCredential],
    ) -> Result<()> {
        write(tx, list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(host: &str, user: &str, reference: &str) -> GitCredential {
        GitCredential {
            protocol: "https".into(),
            host: host.into(),
            username: user.into(),
            secret_ref: reference.into(),
        }
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
            .collect::<std::result::Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn references_move_through_the_journal() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        assert!(store.git_credentials().unwrap().is_empty());
        assert!(
            store.set_git_credential(entry("h", "me", "a")).is_err(),
            "an unstaged value was cleaned up in between"
        );
        assert_eq!(journaled(&store), ["a"]);
        store.stage_secret("b").unwrap();
        store.set_git_credential(entry("h", "me", "b")).unwrap();
        assert_eq!(journaled(&store), ["a"]);
        store.stage_secret("c").unwrap();
        store.set_git_credential(entry("H", "me", "c")).unwrap();
        assert_eq!(journaled(&store), ["a", "b"], "the replaced value");
        store.stage_secret("d").unwrap();
        store.set_git_credential(entry("h", "other", "d")).unwrap();
        assert_eq!(store.git_credentials().unwrap().len(), 2);
        store.forget_git_credential("https", "h", "me").unwrap();
        assert_eq!(journaled(&store), ["a", "b", "c"]);
        assert_eq!(store.git_credentials().unwrap(), [entry("h", "other", "d")]);
    }

    #[test]
    fn a_damaged_list_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        store.set_setting(SETTING, "{").unwrap();
        assert!(store.git_credentials().is_err());
    }
}
