//! Refuses local paths that pass through a user-created link or junction.
use crate::{sftp, storage::Result};
use std::path::Path;

// macOS ships these as root-owned links into /private. Refusing them would block every path below.
#[cfg(target_os = "macos")]
const SYSTEM_LINKS: &[(&str, &str)] = &[
    ("/etc", "private/etc"),
    ("/tmp", "private/tmp"),
    ("/var", "private/var"),
];
#[cfg(not(target_os = "macos"))]
const SYSTEM_LINKS: &[(&str, &str)] = &[];

pub fn linked(m: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        m.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        m.file_type().is_symlink()
    }
}

fn is_system_link(known: &[(&str, &str)], link: &Path, target: &Path) -> bool {
    known
        .iter()
        .any(|(path, expected)| link == Path::new(path) && target == Path::new(expected))
}

pub async fn refuse_links(path: &Path) -> Result<()> {
    for p in path.ancestors() {
        match tokio::fs::symlink_metadata(p).await {
            Ok(m) if linked(&m) => {
                let target = tokio::fs::read_link(p).await;
                if !target.is_ok_and(|t| is_system_link(SYSTEM_LINKS, p, &t)) {
                    return Err("링크 또는 junction 경로를 따라가지 않습니다.".into());
                }
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(sftp::failure(e)),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_link_needs_both_the_known_path_and_target() {
        let known = [("/tmp", "private/tmp")];
        assert!(is_system_link(
            &known,
            Path::new("/tmp"),
            Path::new("private/tmp")
        ));
        // A replaced link must not inherit the exception.
        assert!(!is_system_link(
            &known,
            Path::new("/tmp"),
            Path::new("/Users/me")
        ));
        assert!(!is_system_link(
            &known,
            Path::new("/Users/me/tmp"),
            Path::new("private/tmp")
        ));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn macos_system_links_do_not_block_paths_below_them() {
        refuse_links(Path::new("/tmp/file")).await.unwrap();
        refuse_links(Path::new("/var/folders/file")).await.unwrap();
    }
}
