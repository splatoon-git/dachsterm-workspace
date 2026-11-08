//! Making an Ed25519 key pair from the tools menu (TL.3). The private key file is owner-only
//! before any secret reaches it, and no step replaces a file that was already there.
use crate::storage::Result;
use russh::keys::{Algorithm, HashAlg, PrivateKey, key::safe_rng, ssh_key::LineEnding};
use serde::Serialize;
use std::{
    fs::{File, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};
use zeroize::Zeroizing;

const MAX_NAME: usize = 128;
const MAX_COMMENT: usize = 256;
const MAX_PASSPHRASE: usize = 16384;
const MAX_FOLDER: usize = 4096;
const WRITE_FAILED: &str = "키 파일을 쓰지 못했습니다.";
const EXISTS: &str = "같은 이름의 키 파일이 있습니다. 기존 파일은 덮어쓰지 않으니 이름을 바꾸세요.";

/// What the finished dialog shows. The private key never leaves its file.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedKey {
    pub path: String,
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyDefaults {
    pub folder: String,
    pub comment: String,
}

fn check_name(name: &str) -> Result<()> {
    let allowed = |c: char| c.is_ascii_alphanumeric() || "._-".contains(c);
    if name.is_empty() || name.len() > MAX_NAME || !name.chars().all(allowed) {
        return Err("파일 이름은 영문, 숫자, . _ - 만 쓸 수 있습니다.".into());
    }
    // `key.pub` would leave `key.pub.pub`, and a key named like another key's public half.
    if name.starts_with('.') || name.ends_with('.') || name.ends_with(".pub") {
        return Err("파일 이름은 점으로 시작하거나 끝날 수 없고 .pub로 끝날 수 없습니다.".into());
    }
    crate::transfer_queue::component(name)
}

fn check_comment(comment: &str) -> Result<()> {
    if comment.chars().count() > MAX_COMMENT || comment.chars().any(char::is_control) {
        return Err("주석을 확인하세요.".into());
    }
    Ok(())
}

fn default_folder() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".ssh"))
}

/// The folder to write in. Only the default `~/.ssh` is created here: a folder the user named
/// and that is missing is more likely a typing mistake.
fn ready_folder(folder: &str) -> Result<PathBuf> {
    let path = Path::new(folder);
    if folder.trim().is_empty()
        || folder.len() > MAX_FOLDER
        || folder.chars().any(char::is_control)
        || !path.is_absolute()
    {
        return Err("저장 폴더를 확인하세요.".into());
    }
    if path.is_dir() {
        return Ok(path.to_path_buf());
    }
    if default_folder().as_deref() != Some(path) {
        return Err("저장 폴더가 없습니다.".into());
    }
    create_owner_folder(path).map_err(|_| "저장 폴더를 만들지 못했습니다.".to_string())?;
    Ok(path.to_path_buf())
}

#[cfg(unix)]
fn create_owner_folder(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(path)
}

/// `~/.ssh` under the user profile inherits the profile's user-only access.
#[cfg(not(unix))]
fn create_owner_folder(path: &Path) -> io::Result<()> {
    std::fs::create_dir_all(path)
}

/// Creates the file or fails if the name is taken. On Windows nobody else can open it meanwhile.
fn open_private(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const GENERIC_WRITE: u32 = 0x4000_0000;
        const WRITE_DAC: u32 = 0x0004_0000;
        options.access_mode(GENERIC_WRITE | WRITE_DAC).share_mode(0);
    }
    options.open(path)
}

/// Replaces the inherited access with the current user's alone. Windows OpenSSH refuses a key
/// that anyone else can read, which a folder outside the user profile would otherwise allow.
#[cfg(windows)]
fn owner_only(file: &File) -> io::Result<()> {
    use std::{
        os::windows::io::AsRawHandle,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::{
            ACL,
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
                SE_FILE_OBJECT, SetSecurityInfo,
            },
            DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl,
            PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        },
    };
    let security = crate::local_agent::pipe::security()?;
    // SAFETY: `security` is NUL-terminated; the descriptor owns `dacl` and is freed after the
    // last use of it. `file` keeps the handle open for the call.
    unsafe {
        let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            security.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let (mut present, mut defaulted, mut dacl) = (0, 0, null_mut::<ACL>());
        let result =
            if GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted) == 0
                || present == 0
            {
                Err(io::Error::last_os_error())
            } else {
                match SetSecurityInfo(
                    file.as_raw_handle(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    dacl,
                    null(),
                ) {
                    0 => Ok(()),
                    code => Err(io::Error::from_raw_os_error(code as i32)),
                }
            };
        LocalFree(descriptor);
        result
    }
}

fn write_private(file: &mut File, secret: &str) -> io::Result<()> {
    #[cfg(windows)]
    owner_only(file)?;
    file.write_all(secret.as_bytes())?;
    file.sync_all()
}

fn creation_error(error: io::Error) -> String {
    if error.kind() == io::ErrorKind::AlreadyExists {
        EXISTS.into()
    } else {
        WRITE_FAILED.into()
    }
}

fn write_public(path: &Path, line: &str) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(creation_error)?;
    let written = file
        .write_all(format!("{line}\n").as_bytes())
        .and_then(|()| file.sync_all());
    drop(file);
    written.map_err(|_| {
        // It is this call's own partial file, and the private key goes with it.
        let _ = std::fs::remove_file(path);
        WRITE_FAILED.to_string()
    })
}

/// Writes both halves or neither: a private key without its `.pub` is removed again.
fn write_pair(private: &Path, public: &Path, secret: &str, line: &str) -> Result<()> {
    let mut file = open_private(private).map_err(creation_error)?;
    let written = write_private(&mut file, secret).map_err(|_| WRITE_FAILED.to_string());
    drop(file);
    let finished = written.and_then(|()| write_public(public, line));
    if finished.is_err() && std::fs::remove_file(private).is_err() {
        return Err(format!(
            "{WRITE_FAILED} 만들다 만 개인키를 지우지 못했습니다: {}",
            private.display()
        ));
    }
    finished
}

/// The file text (encrypted when there is a Passphrase), the public line and its fingerprint.
fn make_key(comment: &str, passphrase: &str) -> Result<(Zeroizing<String>, String, String)> {
    const FAILED: &str = "SSH 키를 만들지 못했습니다.";
    let mut key = PrivateKey::random(&mut safe_rng(), Algorithm::Ed25519).map_err(|_| FAILED)?;
    key.set_comment(comment);
    let public = key.public_key().to_openssh().map_err(|_| FAILED)?;
    let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
    if !passphrase.is_empty() {
        key = key
            .encrypt(&mut safe_rng(), passphrase.as_bytes())
            .map_err(|_| FAILED)?;
    }
    let encoded = key.to_openssh(LineEnding::LF).map_err(|_| FAILED)?;
    Ok((encoded, public.trim_end().to_string(), fingerprint))
}

pub fn generate(name: &str, comment: &str, passphrase: &str, folder: &str) -> Result<GeneratedKey> {
    check_name(name)?;
    check_comment(comment)?;
    if passphrase.len() > MAX_PASSPHRASE {
        return Err("Passphrase가 너무 깁니다.".into());
    }
    let folder = ready_folder(folder)?;
    let private = folder.join(name);
    let public = folder.join(format!("{name}.pub"));
    // Answers before the slow key derivation. `create_new` is what actually guards the files.
    if [&private, &public]
        .iter()
        .any(|path| std::fs::symlink_metadata(path).is_ok())
    {
        return Err(EXISTS.into());
    }
    let (secret, line, fingerprint) = make_key(comment, passphrase)?;
    write_pair(&private, &public, &secret, &line)?;
    Ok(GeneratedKey {
        path: private.to_string_lossy().into_owned(),
        public_key: line,
        fingerprint,
    })
}

fn clean(value: String) -> Option<String> {
    let value: String = value.trim().chars().filter(|c| !c.is_control()).collect();
    (!value.is_empty()).then_some(value)
}

#[cfg(windows)]
fn host_name() -> Option<String> {
    std::env::var("COMPUTERNAME").ok().and_then(clean)
}

/// A Finder-launched app has no `HOSTNAME`, so this asks the system tool at its fixed path.
#[cfg(not(windows))]
fn host_name() -> Option<String> {
    let output = std::process::Command::new("/bin/hostname").output().ok()?;
    clean(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn default_comment() -> String {
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .ok()
        .and_then(clean);
    let comment = match (user, host_name()) {
        (Some(user), Some(host)) => format!("{user}@{host}"),
        (Some(name), None) | (None, Some(name)) => name,
        (None, None) => String::new(),
    };
    comment.chars().take(MAX_COMMENT).collect()
}

#[tauri::command]
pub async fn ssh_key_defaults() -> Result<KeyDefaults> {
    tauri::async_runtime::spawn_blocking(|| {
        Ok(KeyDefaults {
            folder: default_folder()
                .ok_or("사용자 폴더를 찾을 수 없습니다.")?
                .to_string_lossy()
                .into_owned(),
            comment: default_comment(),
        })
    })
    .await
    .map_err(|_| "SSH 키 기본값을 읽지 못했습니다.".to_string())?
}

#[tauri::command]
pub async fn ssh_key_pick_folder() -> Result<Option<String>> {
    Ok(rfd::AsyncFileDialog::new()
        .set_title("SSH 키를 저장할 폴더")
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().into_owned()))
}

#[tauri::command]
pub async fn ssh_key_generate(
    name: String,
    comment: String,
    passphrase: String,
    folder: String,
) -> Result<GeneratedKey> {
    let passphrase = Zeroizing::new(passphrase);
    tauri::async_runtime::spawn_blocking(move || generate(&name, &comment, &passphrase, &folder))
        .await
        .map_err(|_| "SSH 키를 만들지 못했습니다.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh_keys::{self, LoadError, tests::keygen};
    use std::process::{Command, Output};

    fn run(args: &[&str]) -> Output {
        Command::new(keygen()).args(args).output().unwrap()
    }
    fn folder(dir: &tempfile::TempDir) -> String {
        dir.path().to_string_lossy().into_owned()
    }
    /// What the real `ssh-keygen` derives from the private key file, comment dropped.
    fn derived(path: &str, passphrase: &str) -> String {
        let output = run(&["-y", "-P", passphrase, "-f", path]);
        assert!(output.status.success(), "ssh-keygen read the key");
        let text = String::from_utf8(output.stdout).unwrap();
        text.split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ")
    }
    fn key_body(line: &str) -> String {
        line.split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ")
    }
    fn system_fingerprint(path: &str) -> String {
        let output = run(&["-l", "-E", "sha256", "-f", path]);
        assert!(output.status.success());
        let text = String::from_utf8(output.stdout).unwrap();
        text.split_whitespace().nth(1).unwrap().to_string()
    }

    #[test]
    fn a_plain_key_is_read_by_ssh_keygen_and_the_app_alike() {
        let dir = tempfile::tempdir().unwrap();
        let made = generate("id_plain", "me@pc", "", &folder(&dir)).unwrap();
        assert!(made.public_key.starts_with("ssh-ed25519 "));
        assert!(made.public_key.ends_with(" me@pc"));
        assert_eq!(derived(&made.path, ""), key_body(&made.public_key));
        assert_eq!(system_fingerprint(&made.path), made.fingerprint);
        let info = ssh_keys::info(&made.path).unwrap();
        assert_eq!(info.fingerprint.as_deref(), Some(made.fingerprint.as_str()));
        assert_eq!(info.algorithm, "ssh-ed25519");
        assert_eq!(info.comment, "me@pc");
        assert!(!info.encrypted);
        let public = std::fs::read_to_string(format!("{}.pub", made.path)).unwrap();
        assert_eq!(public, format!("{}\n", made.public_key));
    }

    #[test]
    fn a_passphrase_key_opens_only_with_its_passphrase() {
        let dir = tempfile::tempdir().unwrap();
        let phrase = uuid::Uuid::new_v4().to_string();
        let made = generate("id_locked", "me@pc", &phrase, &folder(&dir)).unwrap();
        assert_eq!(derived(&made.path, &phrase), key_body(&made.public_key));
        assert!(
            !run(&["-y", "-P", "wrong", "-f", &made.path])
                .status
                .success()
        );
        let info = ssh_keys::info(&made.path).unwrap();
        assert!(info.encrypted);
        assert_eq!(info.fingerprint.as_deref(), Some(made.fingerprint.as_str()));
        assert_eq!(
            ssh_keys::load(&made.path, "").unwrap_err(),
            LoadError::Decode
        );
        assert_eq!(
            ssh_keys::load(&made.path, &phrase)
                .unwrap()
                .public_key()
                .fingerprint(HashAlg::Sha256)
                .to_string(),
            made.fingerprint
        );
    }

    #[test]
    fn existing_files_are_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        for existing in ["taken", "taken.pub"] {
            let path = dir.path().join(existing);
            std::fs::write(&path, "kept").unwrap();
            assert_eq!(
                generate("taken", "", "", &folder(&dir)).unwrap_err(),
                EXISTS
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), "kept");
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
            std::fs::remove_file(&path).unwrap();
        }
    }

    /// The `.pub` name is taken after the early check passed: the private key must not stay.
    #[test]
    fn a_failed_public_file_removes_the_new_private_key() {
        let dir = tempfile::tempdir().unwrap();
        let private = dir.path().join("late");
        let public = dir.path().join("late.pub");
        std::fs::write(&public, "kept").unwrap();
        let error = write_pair(&private, &public, "secret", "line").unwrap_err();
        assert_eq!(error, EXISTS);
        assert!(!private.exists());
        assert_eq!(std::fs::read_to_string(&public).unwrap(), "kept");
    }

    #[test]
    fn names_comments_and_folders_are_checked() {
        let dir = tempfile::tempdir().unwrap();
        let place = folder(&dir);
        for name in [
            "", ".", "..", ".key", "key.", "a/b", "a\\b", "키", "a b", "k.pub",
        ] {
            assert!(generate(name, "", "", &place).is_err(), "{name}");
        }
        assert!(generate(&"a".repeat(MAX_NAME + 1), "", "", &place).is_err());
        assert!(generate("k", "a\nb", "", &place).is_err());
        assert!(generate("k", "", "", "relative/folder").is_err());
        let missing = dir.path().join("missing");
        assert_eq!(
            generate("k", "", "", &missing.to_string_lossy()).unwrap_err(),
            "저장 폴더가 없습니다."
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn the_private_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let made = generate("id_mode", "", "", &folder(&dir)).unwrap();
        let mode = std::fs::metadata(&made.path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[cfg(windows)]
    #[test]
    fn the_private_file_inherits_no_access() {
        let dir = tempfile::tempdir().unwrap();
        let made = generate("id_acl", "", "", &folder(&dir)).unwrap();
        let output = Command::new(r"C:\Windows\System32\icacls.exe")
            .arg(&made.path)
            .output()
            .unwrap();
        assert!(output.status.success());
        let text = String::from_utf8_lossy(&output.stdout);
        let entries = text.lines().filter(|line| line.contains(":(")).count();
        assert_eq!(entries, 1, "only the current user: {text}");
        assert!(!text.contains("(I)"), "nothing inherited: {text}");
    }
}
