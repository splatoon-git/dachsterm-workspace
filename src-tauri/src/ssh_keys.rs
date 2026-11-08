//! Private key files: reading, decoding and the public part. Login (`ssh_auth::key`) and the
//! built-in agent (`agent_keys`) share this, so both accept the same formats and limits.
use crate::storage::Result;
use russh::keys::{Algorithm, HashAlg, PrivateKey, PublicKey, decode_secret_key};
use serde::Serialize;
use std::io::Read;
use zeroize::Zeroizing;

const MAX_FILE: u64 = 1024 * 1024;
const MAX_PUBLIC_FILE: u64 = 64 * 1024;
const UNREADABLE: &str = "개인키 파일을 읽을 수 없습니다.";

/// Why a key could not be decoded. Callers ask again for a Passphrase only on `Decode`.
#[derive(Debug, PartialEq, Eq)]
pub enum LoadError {
    File(String),
    Decode,
}
impl From<LoadError> for String {
    fn from(error: LoadError) -> Self {
        match error {
            LoadError::File(message) => message,
            LoadError::Decode => "개인키 또는 Passphrase를 확인하세요.".into(),
        }
    }
}

fn read_limited(path: &str, limit: u64) -> Result<Zeroizing<String>> {
    let metadata = std::fs::metadata(path).map_err(|_| UNREADABLE)?;
    if metadata.len() > limit {
        return Err("키 파일이 너무 큽니다.".into());
    }
    let mut text = Zeroizing::new(String::new());
    std::fs::File::open(path)
        .map_err(|_| UNREADABLE)?
        .take(limit + 1)
        .read_to_string(&mut text)
        .map_err(|_| UNREADABLE)?;
    if text.len() as u64 > limit {
        return Err("키 파일이 너무 큽니다.".into());
    }
    Ok(text)
}

pub fn decode(encoded: &str, passphrase: &str) -> std::result::Result<PrivateKey, LoadError> {
    decode_secret_key(encoded, (!passphrase.is_empty()).then_some(passphrase))
        .map_err(|_| ())
        .or_else(|_| crate::rsa_auth::decode_pem(encoded, passphrase))
        .map_err(|_| LoadError::Decode)
}

/// Reads and decodes a private key. The text and the result are cleared when dropped.
pub fn load(path: &str, passphrase: &str) -> std::result::Result<PrivateKey, LoadError> {
    let encoded = read_limited(path, MAX_FILE).map_err(LoadError::File)?;
    decode(&encoded, passphrase)
}

/// Key types the built-in agent signs with. FIDO keys need their device and go through the
/// system agent instead.
fn supported(algorithm: &Algorithm) -> Result<()> {
    match algorithm {
        Algorithm::Ed25519 | Algorithm::Ecdsa { .. } | Algorithm::Rsa { .. } => Ok(()),
        Algorithm::SkEd25519 | Algorithm::SkEcdsaSha2NistP256 => {
            Err("FIDO 보안 키는 이 PC의 SSH agent를 통해서만 전달할 수 있습니다.".into())
        }
        _ => Err("Ed25519, ECDSA, RSA 키만 전달할 수 있습니다.".into()),
    }
}

pub struct Public {
    pub key: PublicKey,
    pub comment: String,
    pub encrypted: bool,
}

/// The public part without the Passphrase. OpenSSH files carry it in the clear; an encrypted
/// PEM or PKCS#8 file does not, so the `.pub` file beside it is read. `None` if neither has it.
pub fn public(path: &str) -> Result<Option<Public>> {
    let encoded = read_limited(path, MAX_FILE)?;
    if !encoded.contains("PRIVATE KEY") && !encoded.contains("PuTTY-User-Key-File-") {
        return Err("개인키 파일이 아닙니다.".into());
    }
    let found = PrivateKey::from_openssh(encoded.as_bytes())
        .ok()
        .map(|key| {
            (
                key.public_key().clone(),
                key.comment().to_string(),
                key.is_encrypted(),
            )
        })
        .or_else(|| {
            let key = decode(&encoded, "").ok()?;
            Some((key.public_key().clone(), key.comment().to_string(), false))
        })
        .or_else(|| {
            let text = read_limited(&format!("{path}.pub"), MAX_PUBLIC_FILE).ok()?;
            let key = PublicKey::from_openssh(text.trim()).ok()?;
            let comment = key.comment().to_string();
            Some((key, comment, true))
        });
    let Some((key, comment, encrypted)) = found else {
        return Ok(None);
    };
    supported(&key.algorithm())?;
    Ok(Some(Public {
        key,
        comment,
        encrypted,
    }))
}

/// What the session form shows for a key file. Never reads or returns the secret part.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub path: String,
    pub name: String,
    pub algorithm: String,
    pub fingerprint: Option<String>,
    pub comment: String,
    pub encrypted: bool,
}

pub fn info(path: &str) -> Result<KeyInfo> {
    let name = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let public = public(path)?;
    Ok(KeyInfo {
        path: path.into(),
        name,
        algorithm: public
            .as_ref()
            .map_or_else(String::new, |p| p.key.algorithm().as_str().into()),
        fingerprint: public
            .as_ref()
            .map(|p| p.key.fingerprint(HashAlg::Sha256).to_string()),
        comment: public.as_ref().map_or_else(String::new, |p| {
            crate::agent_filter::plain(p.comment.as_bytes())
        }),
        encrypted: public.is_none_or(|p| p.encrypted),
    })
}

#[tauri::command]
pub async fn ssh_key_info(path: String) -> Result<KeyInfo> {
    if path.trim().is_empty() || path.len() > 4096 || path.chars().any(char::is_control) {
        return Err("키 파일 경로를 확인하세요.".into());
    }
    tauri::async_runtime::spawn_blocking(move || info(&path))
        .await
        .map_err(|_| "키 파일을 확인하지 못했습니다.".to_string())?
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::{path::Path, process::Command};

    /// The OpenSSH key generator at its fixed system path. Test keys are made per run in a
    /// temporary folder and never leave it.
    pub(crate) fn keygen() -> &'static str {
        if cfg!(windows) {
            r"C:\Windows\System32\OpenSSH\ssh-keygen.exe"
        } else {
            "/usr/bin/ssh-keygen"
        }
    }
    pub(crate) fn generate(dir: &Path, name: &str, kind: &[&str], passphrase: &str) -> String {
        let path = dir.join(name);
        let status = Command::new(keygen())
            .args(kind)
            .args(["-q", "-C", name, "-N", passphrase, "-f"])
            .arg(&path)
            .status()
            .expect("ssh-keygen at its system path");
        assert!(status.success());
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn public_parts_come_without_the_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let phrase = uuid::Uuid::new_v4().to_string();
        let plain = generate(dir.path(), "plain", &["-t", "ed25519"], "");
        let locked = generate(dir.path(), "locked", &["-t", "ecdsa", "-b", "384"], &phrase);
        let info = info(&plain).unwrap();
        assert_eq!(info.algorithm, "ssh-ed25519");
        assert_eq!(info.name, "plain");
        assert_eq!(info.comment, "plain");
        assert!(!info.encrypted);
        let key = load(&plain, "").unwrap();
        assert_eq!(
            info.fingerprint.as_deref(),
            Some(
                key.public_key()
                    .fingerprint(HashAlg::Sha256)
                    .to_string()
                    .as_str()
            )
        );
        let info = super::info(&locked).unwrap();
        assert!(info.encrypted && info.fingerprint.is_some());
        assert_eq!(info.algorithm, "ecdsa-sha2-nistp384");
        assert_eq!(load(&locked, "wrong").unwrap_err(), LoadError::Decode);
        assert_eq!(
            load(&locked, &phrase)
                .unwrap()
                .public_key()
                .fingerprint(HashAlg::Sha256)
                .to_string(),
            info.fingerprint.unwrap()
        );
        assert!(matches!(
            load(&dir.path().join("missing").to_string_lossy(), ""),
            Err(LoadError::File(_))
        ));
    }

    #[test]
    fn an_encrypted_pem_key_needs_its_pub_file() {
        let dir = tempfile::tempdir().unwrap();
        let phrase = uuid::Uuid::new_v4().to_string();
        let pem = generate(
            dir.path(),
            "pem",
            &["-t", "rsa", "-b", "2048", "-m", "PEM"],
            &phrase,
        );
        let with_pub = super::info(&pem).unwrap();
        assert!(with_pub.encrypted);
        assert_eq!(with_pub.algorithm, "ssh-rsa");
        std::fs::remove_file(format!("{pem}.pub")).unwrap();
        let without = super::info(&pem).unwrap();
        assert_eq!(
            without.fingerprint, None,
            "shown as unknown, never decrypted"
        );
        assert!(without.encrypted);
        let other = dir.path().join("note.txt");
        std::fs::write(&other, "hello").unwrap();
        assert!(super::info(&other.to_string_lossy()).is_err());
    }
}
