//! The built-in agent (DX.11): the keys this app offers on a forwarding connection, the list a
//! server sees, and signatures. Private keys never leave the app; the server only gets
//! signatures, each approved on the card (`agent_forward`). The system agent's keys are merged in
//! and still signed by the system agent.
use crate::{
    AppState,
    agent_forward::{Decision, Unlock},
    ssh::Connections,
    ssh_keys,
    storage::{ForwardKey, Result, Store},
    vault::Vault,
};
use russh::keys::{
    HashAlg, PrivateKey, PublicKey, signature::Signer, ssh_encoding::Encode, ssh_key::Signature,
};
use serde::Serialize;
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::task::spawn_blocking;
use zeroize::Zeroizing;

const IDENTITIES_ANSWER: u8 = 12;
const SIGN_REQUEST: u8 = 13;
const SIGN_RESPONSE: u8 = 14;
/// `SSH_AGENT_RSA_SHA2_256` and `_512`. A request with neither asks for SHA-1.
const RSA_SHA2_256: u32 = 2;
const RSA_SHA2_512: u32 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Source {
    /// A key file this app reads: the login key or a chosen one.
    App,
    /// A key held by this PC's SSH agent, which signs it.
    System,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtraKey {
    pub path: String,
    pub encrypted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Origin {
    Login,
    Extra(ExtraKey),
    System,
}

#[derive(Clone, Debug)]
pub struct Identity {
    pub blob: Vec<u8>,
    pub comment: String,
    pub origin: Origin,
}
impl Identity {
    pub fn source(&self) -> Source {
        match self.origin {
            Origin::System => Source::System,
            _ => Source::App,
        }
    }
}

/// Keys kept in memory for one connection. Every secret key type of ssh-key zeroizes itself on
/// drop, so removing an entry clears it.
#[derive(Default)]
pub struct AppKeys {
    /// Already decoded for login. Kept only when forwarding offers it, for the connection's life.
    login: Mutex<Option<Arc<PrivateKey>>>,
    /// Chosen keys unlocked for "allow for 10 minutes", until the allowance ends.
    unlocked: Mutex<Vec<Unlocked>>,
}
struct Unlocked {
    blob: Vec<u8>,
    key: Arc<PrivateKey>,
    until: Instant,
}
impl AppKeys {
    pub fn keep_login(&self, key: &PrivateKey) {
        *self.login.lock().unwrap() = Some(Arc::new(key.clone()));
    }
    pub fn login(&self) -> Option<Arc<PrivateKey>> {
        self.login.lock().unwrap().clone()
    }
    pub fn forget(&self) {
        self.login.lock().unwrap().take();
        self.unlocked.lock().unwrap().clear();
    }
    pub fn hold(&self, blob: Vec<u8>, key: Arc<PrivateKey>, until: Instant) {
        let mut unlocked = self.unlocked.lock().unwrap();
        unlocked.retain(|held| held.blob != blob);
        unlocked.push(Unlocked { blob, key, until });
    }
    pub fn unlocked(&self, blob: &[u8]) -> Option<Arc<PrivateKey>> {
        let now = Instant::now();
        self.unlocked
            .lock()
            .unwrap()
            .iter()
            .find(|held| held.blob == blob && now < held.until)
            .map(|held| held.key.clone())
    }
    pub fn expire(&self) {
        let now = Instant::now();
        self.unlocked
            .lock()
            .unwrap()
            .retain(|held| now < held.until);
    }
}

/// Called right after the login key is decoded, for the final server with forwarding on.
pub fn keep_login(manager: &Connections, id: &str, key: &PrivateKey) {
    if let Ok(control) = manager.control(id)
        && control.profile.forward_login_key
    {
        control.agent.keys.keep_login(key);
    }
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map_or_else(|| path.into(), |n| n.to_string_lossy().into_owned())
}
fn named(comment: String, path: &str) -> String {
    let comment = crate::agent_filter::plain(comment.as_bytes());
    if comment.is_empty() {
        file_name(path)
    } else {
        comment
    }
}

/// The app's keys in the order a server sees them: the login key, then the chosen files. A file
/// that cannot be read, or whose public part is unknown, is left out. Reads files: call it off
/// the async threads.
pub fn app_identities(
    login: Option<&PrivateKey>,
    login_path: &str,
    extras: &[ForwardKey],
) -> Vec<Identity> {
    let mut out = Vec::new();
    if let Some(key) = login
        && let Ok(blob) = key.public_key().to_bytes()
    {
        out.push(Identity {
            blob,
            comment: named(key.comment().to_string(), login_path),
            origin: Origin::Login,
        });
    }
    for extra in extras {
        let Ok(Some(public)) = ssh_keys::public(&extra.path) else {
            continue;
        };
        let Ok(blob) = public.key.to_bytes() else {
            continue;
        };
        out.push(Identity {
            blob,
            comment: named(public.comment, &extra.path),
            origin: Origin::Extra(ExtraKey {
                path: extra.path.clone(),
                encrypted: public.encrypted,
            }),
        });
    }
    out
}

/// One entry per public key, the app's first. A key in both places is signed by the app.
pub fn merge(app: Vec<Identity>, system: Vec<(Vec<u8>, String)>) -> Vec<Identity> {
    let system = system.into_iter().map(|(blob, comment)| Identity {
        blob,
        comment,
        origin: Origin::System,
    });
    let mut out: Vec<Identity> = Vec::new();
    for identity in app.into_iter().chain(system) {
        if !out.iter().any(|seen| seen.blob == identity.blob) {
            out.push(identity);
        }
    }
    out
}

fn string(out: &mut Vec<u8>, value: &[u8]) {
    out.extend_from_slice(&(value.len() as u32).to_be_bytes());
    out.extend_from_slice(value);
}

pub fn identities_answer(list: &[Identity]) -> Vec<u8> {
    let mut out = vec![IDENTITIES_ANSWER];
    out.extend_from_slice(&(list.len() as u32).to_be_bytes());
    for identity in list {
        string(&mut out, &identity.blob);
        string(&mut out, identity.comment.as_bytes());
    }
    out
}

/// The data and flags of a `SIGN_REQUEST`. `agent_filter::classify` decides whether it passes;
/// this only reads what the app needs to sign it.
pub fn sign_request(body: &[u8]) -> Option<(&[u8], u32)> {
    let (&SIGN_REQUEST, mut rest) = body.split_first()? else {
        return None;
    };
    let mut take = |length: usize| {
        let (value, tail) = rest.split_at_checked(length)?;
        rest = tail;
        Some(value)
    };
    let length = u32::from_be_bytes(take(4)?.try_into().ok()?) as usize;
    take(length)?;
    let length = u32::from_be_bytes(take(4)?.try_into().ok()?) as usize;
    let data = take(length)?;
    let flags = u32::from_be_bytes(take(4)?.try_into().ok()?);
    Some((data, flags))
}

/// An RSA key asked to sign without a SHA-2 flag: OpenSSH's old SHA-1 `ssh-rsa`.
pub fn refuses_sha1(blob: &[u8], flags: u32) -> bool {
    flags & (RSA_SHA2_256 | RSA_SHA2_512) == 0
        && PublicKey::from_bytes(blob).is_ok_and(|key| key.algorithm().is_rsa())
}

#[derive(Debug, PartialEq, Eq)]
pub struct SignFailed;

/// A `SIGN_RESPONSE` body. Ed25519 and ECDSA sign with ssh-key; RSA goes through ring
/// (`rsa_auth`) with the SHA-2 hash the request names, never SHA-1.
pub fn sign(key: &PrivateKey, data: &[u8], flags: u32) -> std::result::Result<Vec<u8>, SignFailed> {
    let blob = if key.algorithm().is_rsa() {
        let hash = if flags & RSA_SHA2_512 != 0 {
            HashAlg::Sha512
        } else if flags & RSA_SHA2_256 != 0 {
            HashAlg::Sha256
        } else {
            return Err(SignFailed);
        };
        crate::rsa_auth::RsaSigner::new(key)
            .map_err(|_| SignFailed)?
            .sign(Some(hash), data)
            .map_err(|_| SignFailed)?
    } else {
        let signature: Signature = key.try_sign(data).map_err(|_| SignFailed)?;
        signature.encode_vec().map_err(|_| SignFailed)?
    };
    let mut out = vec![SIGN_RESPONSE];
    string(&mut out, &blob);
    Ok(out)
}

/// Why the card asks for the Passphrase.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Ask {
    Needed,
    Wrong,
    /// A saved one could not be read, for example while the vault is locked.
    Stored,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Reply {
    Done { notice: Option<String> },
    Passphrase { reason: Ask },
}

// Tauri passes each IPC argument separately.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn agent_sign_reply(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AppState>,
    id: String,
    request: String,
    decision: Decision,
    passphrase: Option<String>,
    remember: Option<bool>,
) -> Result<Reply> {
    let passphrase = passphrase.map(Zeroizing::new);
    // `id` is the connection or the local tab the request came on (DX.13).
    let agent = crate::approval::Owner::find(&state, window.label(), &id)?.agent()?;
    let unlock = agent.unlock_of(&request)?;
    let typed = passphrase.is_some();
    let passphrase = match (passphrase, &unlock) {
        (Some(typed), _) => Some(typed),
        (None, Some(unlock)) if decision != Decision::Deny => {
            let (store, vault, unlock) = (state.store.clone(), state.vault.clone(), unlock.clone());
            match spawn_blocking(move || stored_passphrase(&store, &vault, &unlock)).await {
                Ok(Ok(stored)) => stored,
                _ => {
                    return Ok(Reply::Passphrase {
                        reason: Ask::Stored,
                    });
                }
            }
        }
        _ => None,
    };
    let kept = passphrase
        .clone()
        .filter(|_| typed && remember == Some(true));
    let reply = agent.answer(&request, decision, passphrase).await?;
    let (Reply::Done { .. }, Some(unlock), Some(passphrase)) = (&reply, unlock, kept) else {
        return Ok(reply);
    };
    let saving = spawn_blocking(move || {
        use tauri::Manager;
        remember_passphrase(&app.state::<AppState>(), &unlock, &passphrase)
    });
    Ok(Reply::Done {
        notice: saving
            .await
            .map_err(|_| "Passphrase를 저장하지 못했습니다.".to_string())
            .and_then(|saved| saved)
            .err(),
    })
}

/// The Passphrase saved for this key file, read now: it may have been saved on this connection.
fn stored_passphrase(
    store: &Store,
    vault: &Vault,
    unlock: &Unlock,
) -> Result<Option<Zeroizing<String>>> {
    let reference = store
        .profile(&unlock.profile)?
        .forward_keys
        .into_iter()
        .find(|key| key.path == unlock.path)
        .and_then(|key| key.secret_ref);
    reference.map(|r| vault.get(store, &r)).transpose()
}

/// "Save on this PC" on the card. The OS store is written first and without any lock; the
/// reference then goes into the session under `mutation` (see `Store::set_forward_secret`).
fn remember_passphrase(state: &AppState, unlock: &Unlock, passphrase: &str) -> Result<()> {
    let reference = state.vault.save(&state.store, passphrase)?;
    let _guard = state.mutation.lock().unwrap();
    state
        .store
        .set_forward_secret(&unlock.profile, &unlock.path, &reference)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh_keys::tests::generate;
    use russh::keys::signature::Verifier;
    use std::time::Duration;

    fn request(blob: &[u8], data: &[u8], flags: u32) -> Vec<u8> {
        let mut out = vec![SIGN_REQUEST];
        string(&mut out, blob);
        string(&mut out, data);
        out.extend_from_slice(&flags.to_be_bytes());
        out
    }
    /// Checks a response against the public key, the way the remote client and server do.
    fn verified(key: &PrivateKey, response: &[u8], data: &[u8]) -> String {
        assert_eq!(response[0], SIGN_RESPONSE);
        let length = u32::from_be_bytes(response[1..5].try_into().unwrap()) as usize;
        assert_eq!(response.len(), 5 + length);
        let signature = Signature::try_from(&response[5..]).unwrap();
        Verifier::verify(key.public_key(), data, &signature).unwrap();
        signature.algorithm().as_str().to_string()
    }

    #[test]
    fn every_signature_verifies_with_its_public_key() {
        let dir = tempfile::tempdir().unwrap();
        let data = b"session-id and userauth request";
        for (name, kind, algorithm) in [
            ("ed", &["-t", "ed25519"][..], "ssh-ed25519"),
            ("p256", &["-t", "ecdsa", "-b", "256"], "ecdsa-sha2-nistp256"),
            ("p384", &["-t", "ecdsa", "-b", "384"], "ecdsa-sha2-nistp384"),
            ("p521", &["-t", "ecdsa", "-b", "521"], "ecdsa-sha2-nistp521"),
        ] {
            let key = ssh_keys::load(&generate(dir.path(), name, kind, ""), "").unwrap();
            let blob = key.public_key().to_bytes().unwrap();
            let body = request(&blob, data, 0);
            let (signed, flags) = sign_request(&body).unwrap();
            assert_eq!(signed, data);
            let response = sign(&key, signed, flags).unwrap();
            assert_eq!(verified(&key, &response, data), algorithm, "{name}");
            assert!(!refuses_sha1(&blob, 0), "only RSA has a SHA-1 form");
        }
    }

    #[test]
    fn rsa_signs_sha2_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = generate(dir.path(), "rsa", &["-t", "rsa", "-b", "2048"], "");
        let key = ssh_keys::load(&path, "").unwrap();
        let blob = key.public_key().to_bytes().unwrap();
        let data = b"payload";
        for (flags, algorithm) in [
            (RSA_SHA2_256, "rsa-sha2-256"),
            (RSA_SHA2_512, "rsa-sha2-512"),
            (RSA_SHA2_256 | RSA_SHA2_512, "rsa-sha2-512"),
        ] {
            let response = sign(&key, data, flags).unwrap();
            assert_eq!(verified(&key, &response, data), algorithm);
            assert!(!refuses_sha1(&blob, flags));
        }
        assert!(refuses_sha1(&blob, 0));
        assert!(refuses_sha1(&blob, 1), "an unrelated flag is still SHA-1");
        assert_eq!(sign(&key, data, 0), Err(SignFailed));
    }

    #[test]
    fn a_malformed_sign_request_gives_nothing_to_sign() {
        let good = request(b"key", b"data", 4);
        assert_eq!(sign_request(&good), Some((&b"data"[..], 4)));
        for cut in 0..good.len() {
            assert_eq!(sign_request(&good[..cut]), None, "{cut}");
        }
        assert_eq!(sign_request(&[11]), None);
        let mut large = good.clone();
        large[1..5].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(sign_request(&large), None);
    }

    #[test]
    fn app_keys_come_first_and_each_public_key_once() {
        let dir = tempfile::tempdir().unwrap();
        let phrase = uuid::Uuid::new_v4().to_string();
        let login = generate(dir.path(), "login", &["-t", "ed25519"], "");
        let git = generate(dir.path(), "git", &["-t", "ed25519"], &phrase);
        let key = ssh_keys::load(&login, "").unwrap();
        let login_blob = key.public_key().to_bytes().unwrap();
        let extras = [
            ForwardKey {
                path: git.clone(),
                secret_ref: Some("ref".into()),
            },
            ForwardKey {
                path: dir.path().join("gone").to_string_lossy().into_owned(),
                secret_ref: None,
            },
            ForwardKey {
                path: login.clone(),
                secret_ref: None,
            },
        ];
        let app = app_identities(Some(&key), &login, &extras);
        assert_eq!(app.len(), 3, "the missing file is left out");
        assert_eq!(app[0].origin, Origin::Login);
        assert_eq!(app[0].comment, "login");
        let Origin::Extra(extra) = &app[1].origin else {
            panic!("the chosen key")
        };
        assert!(extra.encrypted);
        let git_blob = app[1].blob.clone();
        let merged = merge(
            app,
            vec![
                (login_blob.clone(), "system copy".into()),
                (b"other".to_vec(), "system only".into()),
            ],
        );
        let shown: Vec<_> = merged
            .iter()
            .map(|i| (i.blob.clone(), i.source()))
            .collect();
        assert_eq!(
            shown,
            [
                (login_blob, Source::App),
                (git_blob, Source::App),
                (b"other".to_vec(), Source::System)
            ]
        );
        let answer = identities_answer(&merged);
        let names: Vec<_> = crate::agent_filter::identities(&answer)
            .into_iter()
            .map(|(_, comment)| comment)
            .collect();
        assert_eq!(names, ["login", "git", "system only"]);
        assert!(app_identities(None, "", &[]).is_empty());
    }

    #[test]
    fn unlocked_keys_last_only_until_the_allowance_ends() {
        let dir = tempfile::tempdir().unwrap();
        let key = ssh_keys::load(&generate(dir.path(), "k", &["-t", "ed25519"], ""), "").unwrap();
        let keys = AppKeys::default();
        let key = Arc::new(key);
        keys.hold(
            b"a".to_vec(),
            key.clone(),
            Instant::now() + Duration::from_secs(60),
        );
        keys.hold(b"b".to_vec(), key.clone(), Instant::now());
        assert!(keys.unlocked(b"a").is_some());
        assert!(keys.unlocked(b"b").is_none(), "expired");
        keys.expire();
        assert_eq!(keys.unlocked.lock().unwrap().len(), 1);
        keys.keep_login(&key);
        assert!(keys.login().is_some());
        keys.forget();
        assert!(keys.login().is_none() && keys.unlocked(b"a").is_none());
        drop(keys);
        assert_eq!(Arc::strong_count(&key), 1, "nothing else holds the key");
    }
}
