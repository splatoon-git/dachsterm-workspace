//! Saving to this computer's disk or into WSL through its network share.
use super::{NOT_A_FILE, NOT_WRITABLE, Outcome, TIMED_OUT, WRITE_TIMEOUT, conflict, saved};
use crate::{git_run, local::Target, local_files, remote_exec::quote, storage::Result};
use std::{
    ffi::OsString,
    fs::Metadata,
    io::ErrorKind,
    path::{Path, PathBuf},
    time::Duration,
};
use tempfile::TempPath;
use tokio::{fs, io::AsyncWriteExt};

const WSL_TIMEOUT: Duration = Duration::from_secs(15);
const NO_PLACE: &str = "저장할 위치에 임시 파일을 만들 수 없습니다. 폴더 권한을 확인하세요.";
const KEEP_FAILED: &str = "저장 실패 · 기존 파일은 유지됩니다.";

/// The file a save lands on: a link is followed, so the link itself is not replaced by a plain file.
struct Destination {
    native: PathBuf,
    /// A WSL file's own path and mode, which the network share cannot read or set.
    wsl: Option<WslFile>,
}

struct WslFile {
    path: String,
    mode: Option<String>,
}

async fn run_wsl(target: &Target, script: String) -> Result<String> {
    let mut command = tokio::process::Command::new(&target.program);
    command
        .args(git_run::wsl_args(target, script))
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(WSL_TIMEOUT, command.output())
        .await
        .map_err(|_| "WSL 응답 시간이 초과되었습니다.")?
        .map_err(|_| "WSL을 실행하지 못했습니다.")?;
    if !output.status.success() {
        return Err("WSL에서 파일 정보를 확인하지 못했습니다.".into());
    }
    String::from_utf8(output.stdout).map_err(|_| "WSL 경로를 읽지 못했습니다.".into())
}

/// Prints the mode and the real path of a file that exists, and nothing for one that does not.
fn wsl_file_script(path: &str) -> String {
    format!(
        "r=$(readlink -f -- {}) || exit 0\n[ -e \"$r\" ] || exit 0\nstat -c %a -- \"$r\" && printf '%s' \"$r\"",
        quote(path)
    )
}

async fn wsl_destination(target: &Target, path: &str) -> Result<Destination> {
    let report = run_wsl(target, wsl_file_script(path)).await?;
    let found = report
        .split_once('\n')
        .filter(|(mode, real)| !real.is_empty() && mode.bytes().all(|b| b.is_ascii_digit()));
    let (shown, mode) = match found {
        Some((mode, real)) => (real.to_string(), Some(mode.to_string())),
        None => (path.to_string(), None),
    };
    Ok(Destination {
        native: local_files::native_path(target, &shown)?,
        wsl: Some(WslFile { path: shown, mode }),
    })
}

async fn native_destination(native: PathBuf) -> Result<Destination> {
    let link = fs::symlink_metadata(&native)
        .await
        .is_ok_and(|metadata| metadata.is_symlink());
    let native = if link {
        fs::canonicalize(&native)
            .await
            .map_err(|_| "링크가 가리키는 파일을 찾지 못해 저장하지 않았습니다.")?
    } else {
        native
    };
    Ok(Destination { native, wsl: None })
}

async fn existing(path: &Path) -> Result<Option<Metadata>> {
    match fs::metadata(path).await {
        Ok(metadata) if metadata.is_file() => Ok(Some(metadata)),
        Ok(_) => Err(NOT_A_FILE.into()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => Err("저장 경로를 확인하지 못했습니다.".into()),
    }
}

async fn read_current(path: &Path) -> Result<Option<Vec<u8>>> {
    let file = match fs::File::open(path).await {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("저장 직전 파일을 읽지 못했습니다.".into()),
    };
    super::current_bytes(file)
        .await
        .map(Some)
        .map_err(|_| "저장 직전 파일을 읽지 못했습니다.".into())
}

fn stage_path(path: &Path) -> PathBuf {
    let mut name = OsString::from(path);
    name.push(format!(".dachsterm-{}.part", uuid::Uuid::new_v4()));
    PathBuf::from(name)
}

/// The staged file is deleted when this is dropped, so a timeout or a conflict leaves nothing behind.
async fn stage(path: &Path, wire: &[u8], private: bool) -> Result<TempPath> {
    let staged = stage_path(path);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if private {
        options.mode(0o600);
    }
    #[cfg(not(unix))]
    let _ = private;
    let mut file = options.open(&staged).await.map_err(|_| NO_PLACE)?;
    let temp = TempPath::try_from_path(&staged).map_err(|_| NO_PLACE)?;
    file.write_all(wire).await.map_err(|_| KEEP_FAILED)?;
    file.sync_all().await.map_err(|_| KEEP_FAILED)?;
    // Windows cannot move a file that is still open here.
    drop(file);
    Ok(temp)
}

async fn replace(temp: TempPath, target: PathBuf, overwrite: bool) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        if overwrite {
            temp.persist(&target).map_err(|_| KEEP_FAILED.to_string())
        } else {
            // Something made in the last moment must not be replaced by a file meant to be new.
            temp.persist_noclobber(&target)
                .map_err(|_| "같은 이름의 파일이 생겨 저장하지 않았습니다.".to_string())
        }
    })
    .await
    .map_err(|_| "파일 작업이 중단되었습니다.")?
}

async fn write_at(
    target: &Target,
    destination: Destination,
    wire: &[u8],
    base: Option<&str>,
) -> Result<Outcome> {
    let Destination { native, wsl } = destination;
    let before = existing(&native).await?;
    if before.is_some() {
        // Replacing needs only the folder's permission, which would ignore a read-only file.
        fs::OpenOptions::new()
            .write(true)
            .open(&native)
            .await
            .map_err(|_| NOT_WRITABLE)?;
    }
    let temp = stage(&native, wire, before.is_some()).await?;
    let current = read_current(&native).await?;
    if let Some(found) = conflict(current.as_deref(), base) {
        return Ok(found);
    }
    if let Some(metadata) = &before {
        fs::set_permissions(&temp, metadata.permissions())
            .await
            .map_err(|_| KEEP_FAILED)?;
    }
    if let Some(WslFile {
        path,
        mode: Some(mode),
    }) = &wsl
    {
        let name = temp.file_name().ok_or(KEEP_FAILED)?.to_string_lossy();
        let (parent, _) = path.rsplit_once('/').ok_or(KEEP_FAILED)?;
        let staged = format!("{parent}/{name}");
        run_wsl(target, format!("chmod {mode} -- {}", quote(&staged)))
            .await
            .map_err(|_| "WSL 파일 권한을 유지하지 못해 저장하지 않았습니다.")?;
    }
    replace(temp, native, current.is_some()).await?;
    Ok(saved(wire, None))
}

pub(super) async fn write(
    target: &Target,
    path: &str,
    wire: &[u8],
    base: Option<&str>,
) -> Result<Outcome> {
    let saving = async {
        let destination = if target.id.starts_with("wsl:") {
            local_files::native_path(target, path)?;
            wsl_destination(target, path).await?
        } else {
            native_destination(local_files::native_path(target, path)?).await?
        };
        write_at(target, destination, wire, base).await
    };
    tokio::time::timeout(WRITE_TIMEOUT, saving)
        .await
        .map_err(|_| TIMED_OUT)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_read::digest;

    fn run<T>(future: impl Future<Output = T>) -> T {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }
    fn folder() -> PathBuf {
        let folder = std::env::temp_dir().join(format!("file-write-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&folder).unwrap();
        folder
    }
    fn plain_target() -> Target {
        Target::for_test("this-pc", "shell")
    }
    fn save(file: &Path, wire: &[u8], base: Option<&str>) -> Result<Outcome> {
        run(write(&plain_target(), file.to_str().unwrap(), wire, base))
    }
    fn names(folder: &Path) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn a_save_replaces_the_file_and_leaves_nothing_beside_it() {
        let folder = folder();
        let file = folder.join("한글 메모.txt");
        std::fs::write(&file, "before").unwrap();
        let outcome = save(&file, "after 한글".as_bytes(), Some(&digest(b"before"))).unwrap();
        assert_eq!(outcome, saved("after 한글".as_bytes(), None));
        assert_eq!(std::fs::read(&file).unwrap(), "after 한글".as_bytes());
        assert_eq!(names(&folder), ["한글 메모.txt"]);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn a_changed_file_is_left_alone_and_reported() {
        let folder = folder();
        let file = folder.join("a.txt");
        std::fs::write(&file, "theirs").unwrap();
        let outcome = save(&file, b"mine", Some(&digest(b"before"))).unwrap();
        assert_eq!(
            outcome,
            Outcome::Conflict {
                hash: Some(digest(b"theirs"))
            }
        );
        assert_eq!(std::fs::read(&file).unwrap(), b"theirs");
        assert_eq!(names(&folder), ["a.txt"]);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn overwriting_uses_the_hash_the_conflict_reported() {
        let folder = folder();
        let file = folder.join("a.txt");
        std::fs::write(&file, "theirs").unwrap();
        let outcome = save(&file, b"mine", Some(&digest(b"theirs"))).unwrap();
        assert!(matches!(outcome, Outcome::Saved { .. }));
        assert_eq!(std::fs::read(&file).unwrap(), b"mine");
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn a_new_name_is_created_but_an_existing_one_is_not_replaced() {
        let folder = folder();
        let file = folder.join("new.txt");
        assert!(matches!(
            save(&file, b"one", None).unwrap(),
            Outcome::Saved { .. }
        ));
        assert_eq!(std::fs::read(&file).unwrap(), b"one");
        assert_eq!(
            save(&file, b"two", None).unwrap(),
            Outcome::Conflict {
                hash: Some(digest(b"one"))
            }
        );
        assert_eq!(std::fs::read(&file).unwrap(), b"one");
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn a_vanished_file_is_a_conflict_with_no_hash() {
        let folder = folder();
        let file = folder.join("gone.txt");
        assert_eq!(
            save(&file, b"x", Some("abc")).unwrap(),
            Outcome::Conflict { hash: None }
        );
        assert_eq!(names(&folder), Vec::<String>::new());
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn folders_and_read_only_files_are_refused() {
        let folder = folder();
        assert_eq!(
            save(&folder, b"x", Some("abc")).err().as_deref(),
            Some(NOT_A_FILE)
        );
        let file = folder.join("locked.txt");
        std::fs::write(&file, "before").unwrap();
        let mut permissions = std::fs::metadata(&file).unwrap().permissions();
        permissions.set_readonly(true);
        std::fs::set_permissions(&file, permissions.clone()).unwrap();
        assert_eq!(
            save(&file, b"x", Some(&digest(b"before"))).err().as_deref(),
            Some(NOT_WRITABLE)
        );
        assert_eq!(std::fs::read(&file).unwrap(), b"before");
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        std::fs::set_permissions(&file, permissions).unwrap();
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn the_mode_survives_and_a_link_stays_a_link() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let folder = folder();
        let file = folder.join("run.sh");
        std::fs::write(&file, "old").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o750)).unwrap();
        let link = folder.join("link.sh");
        symlink(&file, &link).unwrap();
        assert!(matches!(
            save(&link, b"new", Some(&digest(b"old"))).unwrap(),
            Outcome::Saved { .. }
        ));
        assert!(std::fs::symlink_metadata(&link).unwrap().is_symlink());
        assert_eq!(std::fs::read(&file).unwrap(), b"new");
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o750);
        std::fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn the_wsl_report_script_prints_mode_then_path() {
        let script = wsl_file_script("/home/me/it's.txt");
        assert!(script.contains(r"'/home/me/it'\''s.txt'"));
    }

    /// Real WSL: `cargo test -p dachsterm --lib --locked wsl_save -- --ignored`.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs a WSL distribution"]
    fn wsl_save_keeps_the_mode_and_follows_a_link() {
        let distribution = std::env::var("DACHSTERM_WSL").unwrap_or("Ubuntu-24.04".into());
        let program = PathBuf::from(std::env::var("WINDIR").unwrap())
            .join("System32")
            .join("wsl.exe");
        let target = Target {
            program,
            ..Target::for_test(&format!("wsl:{distribution}"), "wsl")
        };
        let folder = format!("/tmp/dachsterm-save-{}", uuid::Uuid::new_v4());
        let shell = |script: String| run(run_wsl(&target, script)).unwrap();
        shell(format!(
            "mkdir {folder} && printf old > {folder}/run.sh && chmod 751 {folder}/run.sh && ln -s run.sh {folder}/link.sh"
        ));
        let outcome = run(write(
            &target,
            &format!("{folder}/link.sh"),
            "한글 new".as_bytes(),
            Some(&digest(b"old")),
        ))
        .unwrap();
        assert_eq!(outcome, saved("한글 new".as_bytes(), None));
        let report = shell(format!(
            "stat -c '%a %F' {folder}/run.sh; test -L {folder}/link.sh && echo linked; cat {folder}/run.sh; ls -A {folder} | wc -l"
        ));
        assert_eq!(report, "751 regular file\nlinked\n한글 new2\n");
        let fresh = format!("{folder}/새 파일.txt");
        assert!(matches!(
            run(write(&target, &fresh, b"x", None)).unwrap(),
            Outcome::Saved { .. }
        ));
        assert_eq!(
            run(write(&target, &fresh, b"y", None)).unwrap(),
            Outcome::Conflict {
                hash: Some(digest(b"x"))
            }
        );
        shell(format!("rm -rf {folder}"));
    }
}
