//! Master-protected credentials remain in the native OS credential store.
use crate::{
    AppState, credentials,
    storage::{Result, Store, db_error},
};
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit, OsRng, Payload, rand_core::RngCore},
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::Manager;
use zeroize::Zeroizing;
const SETTING: &str = "master-vault-v1";
const WRAP_AAD: &[u8] = b"DachsTerm master key v1 Argon2id m32768 t3 p1";
const TTL: Duration = Duration::from_secs(300);
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    version: u8,
    salt: [u8; 16],
    wrapped: String,
}
#[derive(Default)]
pub struct Vault {
    cache: Mutex<Option<(Zeroizing<[u8; 32]>, Instant)>>,
    attempts: Mutex<Option<Instant>>,
}
#[derive(Serialize)]
pub struct Status {
    pub enabled: bool,
    pub unlocked: bool,
    pub seconds: u64,
}
fn random<const N: usize>() -> Result<[u8; N]> {
    let mut value = [0; N];
    OsRng
        .try_fill_bytes(&mut value)
        .map_err(|_| "보안 난수 생성 실패")?;
    Ok(value)
}
fn derive(password: &str, salt: &[u8; 16]) -> Result<Zeroizing<[u8; 32]>> {
    if password.len() > 1024 {
        return Err("마스터 패스워드는 1024바이트 이하여야 합니다.".into());
    }
    let mut key = Zeroizing::new([0; 32]);
    Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(32768, 3, 1, Some(32)).map_err(|_| "암호 설정 오류")?,
    )
    .hash_password_into(password.as_bytes(), salt, key.as_mut())
    .map_err(|_| "암호 키 생성 실패")?;
    Ok(key)
}
fn seal(key: &[u8; 32], bytes: &[u8], aad: &[u8]) -> Result<String> {
    let nonce = random::<12>()?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "암호 키 오류")?;
    let encrypted = cipher
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: bytes, aad })
        .map_err(|_| "암호화 실패")?;
    let mut output = nonce.to_vec();
    output.extend(encrypted);
    Ok(STANDARD.encode(output))
}
fn open(key: &[u8; 32], value: &str, aad: &[u8]) -> Result<Zeroizing<Vec<u8>>> {
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| "암호화 데이터 형식 오류")?;
    if bytes.len() < 28 || bytes.len() > 32768 {
        return Err("암호화 데이터 길이 오류".into());
    }
    Aes256Gcm::new_from_slice(key)
        .map_err(|_| "암호 키 오류")?
        .decrypt(
            Nonce::from_slice(&bytes[..12]),
            Payload {
                msg: &bytes[12..],
                aad,
            },
        )
        .map(Zeroizing::new)
        .map_err(|_| "마스터 패스워드가 일치하지 않거나 암호화 데이터가 손상되었습니다.".into())
}
fn config(store: &Store) -> Result<Option<Config>> {
    use rusqlite::OptionalExtension;
    let value: Option<String> = store
        .0
        .lock()
        .unwrap()
        .query_row("SELECT value FROM settings WHERE key=?", [SETTING], |r| {
            r.get(0)
        })
        .optional()
        .map_err(db_error)?;
    value
        .map(|v| {
            let c: Config =
                serde_json::from_str(&v).map_err(|_| "마스터 암호 설정을 읽을 수 없습니다.")?;
            if c.version != 1 {
                return Err("지원하지 않는 암호 저장 형식입니다.".into());
            }
            Ok(c)
        })
        .transpose()
}
fn wrap(password: &str, key: &[u8; 32]) -> Result<String> {
    if password.chars().count() < 12 || password.len() > 1024 {
        return Err("새 마스터 패스워드는 12자 이상, 1024바이트 이하로 입력하세요.".into());
    }
    let salt = random()?;
    let derived = derive(password, &salt)?;
    serde_json::to_string(&Config {
        version: 1,
        salt,
        wrapped: seal(&derived, key, WRAP_AAD)?,
    })
    .map_err(|_| "암호 설정 저장 실패".into())
}
impl Vault {
    pub fn lock(&self) {
        *self.cache.lock().unwrap() = None;
    }
    pub fn expire(&self) {
        let mut cache = self.cache.lock().unwrap();
        if cache.as_ref().is_some_and(|(_, at)| at.elapsed() >= TTL) {
            *cache = None;
        }
    }
    pub fn status(&self, store: &Store) -> Result<Status> {
        self.expire();
        let enabled = config(store)?.is_some();
        let cache = self.cache.lock().unwrap();
        Ok(Status {
            enabled,
            unlocked: cache.is_some(),
            seconds: cache
                .as_ref()
                .map_or(0, |(_, at)| TTL.saturating_sub(at.elapsed()).as_secs()),
        })
    }
    fn key(&self) -> Result<Zeroizing<[u8; 32]>> {
        self.expire();
        self.cache
            .lock()
            .unwrap()
            .as_ref()
            .map(|(key, _)| key.clone())
            .ok_or("마스터 패스워드로 암호 보관함의 잠금을 해제하세요.".into())
    }
    fn verify(&self, store: &Store, password: &str) -> Result<Zeroizing<[u8; 32]>> {
        {
            let mut last = self.attempts.lock().unwrap();
            if last.is_some_and(|at| at.elapsed() < Duration::from_secs(1)) {
                return Err("잠시 후 마스터 패스워드를 다시 확인하세요.".into());
            }
            *last = Some(Instant::now());
        }
        let c = config(store)?.ok_or("먼저 마스터 패스워드를 설정하세요.")?;
        let derived = derive(password, &c.salt)?;
        let bytes = open(&derived, &c.wrapped, WRAP_AAD)?;
        let mut key = Zeroizing::new([0; 32]);
        if bytes.len() != 32 {
            return Err("암호 키 길이 오류".into());
        }
        key.copy_from_slice(&bytes);
        Ok(key)
    }
    pub fn unlock(&self, store: &Store, password: &str) -> Result<()> {
        let key = self.verify(store, password)?;
        *self.cache.lock().unwrap() = Some((key, Instant::now()));
        Ok(())
    }
    pub fn get(&self, store: &Store, id: &str) -> Result<Zeroizing<String>> {
        if config(store)?.is_none() {
            if id.starts_with("vault-") {
                return Err("마스터 암호 설정이 누락되었습니다.".into());
            }
            return credentials::get(id);
        }
        let key = self.key()?;
        self.decrypt(id, &key)
    }
    fn decrypt(&self, id: &str, key: &[u8; 32]) -> Result<Zeroizing<String>> {
        if !id.starts_with("vault-") {
            return Err("암호화되지 않은 인증정보 참조를 거부했습니다.".into());
        }
        let encrypted = credentials::get(id)?;
        let bytes = open(key, &encrypted, id.as_bytes())?;
        let value = std::str::from_utf8(&bytes).map_err(|_| "인증정보 인코딩 오류")?;
        Ok(Zeroizing::new(value.to_owned()))
    }
    pub fn save(&self, store: &Store, value: &str) -> Result<String> {
        let enabled = config(store)?.is_some();
        let id = format!(
            "{}{}",
            if enabled { "vault-" } else { "" },
            uuid::Uuid::new_v4()
        );
        let encrypted = if enabled {
            Some(seal(&*self.key()?, value.as_bytes(), id.as_bytes())?)
        } else {
            None
        };
        store.stage_secret(&id)?;
        credentials::set(&id, encrypted.as_deref().unwrap_or(value))?;
        Ok(id)
    }
    pub fn reveal(
        &self,
        store: &Store,
        profile: &str,
        password: &str,
    ) -> Result<Zeroizing<String>> {
        let key = self.verify(store, password)?;
        let id = store
            .secret_ref(profile)?
            .ok_or("저장된 인증정보가 없습니다.")?;
        self.decrypt(&id, &key)
    }
    pub fn configure(&self, store: &Store, old: Option<&str>, password: &str) -> Result<()> {
        let previous_key = if config(store)?.is_some() {
            Some(self.verify(store, old.ok_or("현재 마스터 패스워드를 입력하세요.")?)?)
        } else {
            None
        };
        let key = Zeroizing::new(random::<32>()?);
        let wrapped = wrap(password, &key)?;
        let profiles = store.list()?.profiles;
        let mut changed = Vec::new();
        let mut forwarded = Vec::new();
        // Copy-on-write OS entries. Old entries stay usable until the SQLite commit.
        let copy = |previous: &str| -> Result<String> {
            let value = if let Some(old_key) = previous_key.as_ref() {
                self.decrypt(previous, old_key)?
            } else {
                if previous.starts_with("vault-") {
                    return Err("기존 암호 보관함 설정 복구가 필요합니다.".into());
                }
                credentials::get(previous)?
            };
            let next = format!("vault-{}", uuid::Uuid::new_v4());
            store.stage_secret(&next)?;
            credentials::set(&next, &seal(&key, value.as_bytes(), next.as_bytes())?)?;
            Ok(next)
        };
        for mut profile in profiles {
            if let Some(previous) = store.secret_ref(&profile.id)? {
                let next = copy(&previous)?;
                changed.push((Some(profile.id.clone()), previous, next));
            }
            // Passphrases of forwarded key files (DX.11) live in the profile data.
            if profile.forward_refs().next().is_none() {
                continue;
            }
            for forward in &mut profile.forward_keys {
                if let Some(previous) = forward.secret_ref.take() {
                    let next = copy(&previous)?;
                    forward.secret_ref = Some(next.clone());
                    changed.push((None, previous, next));
                }
            }
            forwarded.push((crate::storage::profile_data(&profile)?, profile.id));
        }
        // The local tabs' key files (DX.13) keep theirs in the app settings.
        let mut local = store.local_agent()?;
        let local_value = if local.refs().next().is_some() {
            for key in &mut local.keys {
                if let Some(previous) = key.secret_ref.take() {
                    let next = copy(&previous)?;
                    key.secret_ref = Some(next.clone());
                    changed.push((None, previous, next));
                }
            }
            Some(crate::local_agent::keys_value(&local.keys)?)
        } else {
            None
        };
        let mut db = store.0.lock().unwrap();
        let tx = db.transaction().map_err(db_error)?;
        for (data, profile) in forwarded {
            tx.execute(
                "UPDATE profiles SET data=? WHERE id=?",
                rusqlite::params![data, profile],
            )
            .map_err(db_error)?;
        }
        if let Some(value) = local_value {
            tx.execute(
                "UPDATE settings SET value=? WHERE key=?",
                rusqlite::params![value, crate::local_agent::KEYS],
            )
            .map_err(db_error)?;
        }
        for (profile, previous, next) in changed {
            if let Some(profile) = profile {
                tx.execute(
                    "UPDATE profiles SET secret_ref=? WHERE id=?",
                    rusqlite::params![next, profile],
                )
                .map_err(db_error)?;
            }
            tx.execute("INSERT OR IGNORE INTO credential_gc VALUES(?)", [previous])
                .map_err(db_error)?;
            tx.execute("DELETE FROM credential_gc WHERE id=?", [next])
                .map_err(db_error)?;
        }
        tx.execute(
            "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=?2",
            rusqlite::params![SETTING, wrapped],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        drop(db);
        if previous_key.is_some() {
            self.lock();
        } else {
            *self.cache.lock().unwrap() = Some((key, Instant::now()));
        }
        Ok(())
    }
}
#[tauri::command]
pub fn vault_status(state: tauri::State<AppState>) -> Result<Status> {
    state.vault.status(&state.store)
}
#[tauri::command]
pub fn vault_lock(state: tauri::State<AppState>) {
    let _guard = state.mutation.lock().unwrap();
    state.vault.lock();
}
// KDF/native keyring work stays off the window thread. Shared mutation prevents
// migrations racing session save/delete and prevents a stale key after change.
#[tauri::command]
pub async fn vault_action(
    app: tauri::AppHandle,
    action: String,
    password: String,
    new_password: Option<String>,
    profile_id: Option<String>,
) -> Result<Option<String>> {
    let password = Zeroizing::new(password);
    let new_password = new_password.map(Zeroizing::new);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let _guard = state.mutation.lock().unwrap();
        match action.as_str() {
            "unlock" => {
                state.vault.unlock(&state.store, &password)?;
                Ok(None)
            }
            "configure" => {
                let result = state.vault.configure(
                    &state.store,
                    Some(&password),
                    new_password
                        .as_deref()
                        .map(|v| v.as_str())
                        .ok_or("새 패스워드 누락")?,
                );
                let _ = state.store.cleanup_credentials();
                result?;
                Ok(None)
            }
            "reveal" => {
                let secret = state.vault.reveal(
                    &state.store,
                    profile_id.as_deref().ok_or("세션 누락")?,
                    &password,
                )?;
                Ok(Some(secret.to_string()))
            }
            _ => Err("알 수 없는 암호 보관함 작업".into()),
        }
    })
    .await
    .map_err(|_| "암호 보관함 작업을 완료하지 못했습니다.".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encryption_is_random_authenticated_and_bound_to_entry() {
        let key = random::<32>().unwrap();
        let a = seal(&key, b"test-only secret", b"entry-a").unwrap();
        let b = seal(&key, b"test-only secret", b"entry-a").unwrap();
        assert_ne!(a, b);
        assert_eq!(&**open(&key, &a, b"entry-a").unwrap(), b"test-only secret");
        assert!(open(&key, &a, b"entry-b").is_err());
        let mut damaged = STANDARD.decode(&a).unwrap();
        damaged[15] ^= 1;
        assert!(open(&key, &STANDARD.encode(damaged), b"entry-a").is_err());
    }
    #[test]
    fn master_wrap_wrong_password_change_and_expiry() {
        let key = Zeroizing::new(random::<32>().unwrap());
        let encoded = wrap("test-only master password", &key).unwrap();
        let cfg: Config = serde_json::from_str(&encoded).unwrap();
        assert!(open(&derive("wrong", &cfg.salt).unwrap(), &cfg.wrapped, WRAP_AAD).is_err());
        assert_eq!(
            &**open(
                &derive("test-only master password", &cfg.salt).unwrap(),
                &cfg.wrapped,
                WRAP_AAD
            )
            .unwrap(),
            &*key
        );
        let changed: Config =
            serde_json::from_str(&wrap("replacement test master", &key).unwrap()).unwrap();
        assert!(
            open(
                &derive("test-only master password", &changed.salt).unwrap(),
                &changed.wrapped,
                WRAP_AAD
            )
            .is_err()
        );
        let vault = Vault::default();
        *vault.cache.lock().unwrap() = Some((key, Instant::now() - TTL));
        assert!(vault.key().is_err());
        assert!(vault.cache.lock().unwrap().is_none());
    }
}
