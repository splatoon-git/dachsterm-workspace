//! Both sides of one changed file, for the diff tab (GE.8). What Git holds is read as a blob, which
//! runs no filter or textconv. The working tree is read the way a file tab reads it, so the hash
//! it returns is the one `file_write` compares when the tab saves.
use super::{DiffBase, MAX_FILE, base_object, check_path, checked, limits};
use crate::{
    AppState,
    file_read::{self, Content, ReadOptions},
    git_graph::check_hash,
    git_run::{GitHost, args, git_run},
    remote_exec::Failure,
    source::Source,
    storage::Result,
};
use serde::{Deserialize, Serialize};

const SUBMODULE: &str = "160000";
const MAX_LOOKUP_OUTPUT: usize = 64 * 1024;

/// What the two sides of the tab are.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Compare {
    HeadIndex,
    /// `deleted` is the listing saying the file is gone, so there is nothing to read on the right.
    IndexWorktree {
        deleted: bool,
    },
    Untracked,
    /// A commit against its first parent, or against nothing for a root commit.
    Commit {
        hash: String,
        parent: Option<String>,
    },
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Side {
    /// The file does not exist on this side: new on the right, deleted on the left, and so on.
    Absent,
    Text {
        text: String,
        encoding: String,
        lossy: bool,
        hash: String,
    },
    Binary {
        format: String,
    },
    TooLarge,
}

impl From<Content> for Side {
    fn from(content: Content) -> Self {
        match content {
            Content::Text {
                text,
                encoding,
                lossy,
                hash,
                ..
            } => Self::Text {
                text,
                encoding,
                lossy,
                hash,
            },
            Content::Image { mime, .. } => Self::Binary { format: mime },
            Content::Binary { format } => Self::Binary { format },
            Content::Large | Content::TooLarge => Self::TooLarge,
        }
    }
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileDiff {
    pub original: Side,
    pub modified: Side,
}

#[derive(Debug, PartialEq, Eq)]
struct Entry {
    mode: String,
    object: String,
}

/// `<mode> <type> <object>\t<path>` from `ls-tree`, `<mode> <object> <stage>\t<path>` from
/// `ls-files --stage`. Only stage 0 is the index's own copy, and a folder is not a file.
fn parse_entry(stdout: &[u8]) -> Option<Entry> {
    stdout.split(|byte| *byte == 0).find_map(|record| {
        let head = record.split(|byte| *byte == b'\t').next()?;
        let head = std::str::from_utf8(head).ok()?;
        match head.split(' ').collect::<Vec<_>>()[..] {
            [mode, "blob" | "commit", object] | [mode, object, "0"] => Some(Entry {
                mode: mode.to_string(),
                object: object.to_string(),
            }),
            _ => None,
        }
    })
}

fn tree_lookup(tree: &str, path: &str) -> Vec<String> {
    args(["ls-tree", "-z", tree, "--", path])
}

fn index_lookup(path: &str) -> Vec<String> {
    args(["ls-files", "--stage", "-z", "--", path])
}

fn blob_command(object: &str) -> Vec<String> {
    args(["cat-file", "blob", object])
}

fn failure_text(failure: Failure) -> String {
    match failure {
        Failure::TimedOut => "diff를 읽는 시간이 초과되었습니다.".into(),
        Failure::TooLarge => "diff 출력이 너무 커서 읽지 못했습니다.".into(),
        Failure::Other(message) => message,
    }
}

async fn lookup(host: &GitHost, root: &str, command: Vec<String>) -> Result<Option<Entry>> {
    let output = git_run(host, root, &[command], limits(MAX_LOOKUP_OUTPUT))
        .await
        .map_err(failure_text)?;
    Ok(parse_entry(&checked(output, "Git 항목을")?))
}

async fn blob_side(host: &GitHost, root: &str, name: &str, entry: Option<Entry>) -> Result<Side> {
    let Some(entry) = entry else {
        return Ok(Side::Absent);
    };
    if entry.mode == SUBMODULE {
        return Ok(Side::Binary {
            format: "서브모듈".into(),
        });
    }
    let command = blob_command(&entry.object);
    let output = match git_run(host, root, &[command], limits(MAX_FILE as usize)).await {
        Err(Failure::TooLarge) => return Ok(Side::TooLarge),
        other => other.map_err(failure_text)?,
    };
    let bytes = checked(output, "diff를")?;
    let content = file_read::content_of(name, &bytes)
        .await
        .map_err(|e| e.to_string())?;
    Ok(content.into())
}

/// The left side, and the right one when Git holds that as well.
async fn git_sides(
    host: &GitHost,
    root: &str,
    path: &str,
    old_path: Option<&str>,
    compare: &Compare,
) -> Result<(Side, Option<Side>)> {
    let left = old_path.unwrap_or(path);
    let name = file_read::file_name(path, false);
    match compare {
        Compare::Untracked => Ok((Side::Absent, None)),
        Compare::IndexWorktree { .. } => {
            let entry = lookup(host, root, index_lookup(left)).await?;
            Ok((blob_side(host, root, name, entry).await?, None))
        }
        Compare::HeadIndex => {
            // Before the first commit this is the empty tree, so every file reads as new.
            let tree = base_object(host, root, &DiffBase::WorkingTree)
                .await
                .map_err(failure_text)?;
            let old = lookup(host, root, tree_lookup(&tree, left)).await?;
            let new = lookup(host, root, index_lookup(path)).await?;
            let original = blob_side(host, root, name, old).await?;
            Ok((original, Some(blob_side(host, root, name, new).await?)))
        }
        Compare::Commit { hash, parent } => {
            check_hash(hash)?;
            let old = match parent {
                Some(parent) => {
                    check_hash(parent)?;
                    lookup(host, root, tree_lookup(parent, left)).await?
                }
                None => None,
            };
            let new = lookup(host, root, tree_lookup(hash, path)).await?;
            let original = blob_side(host, root, name, old).await?;
            Ok((original, Some(blob_side(host, root, name, new).await?)))
        }
    }
}

#[tauri::command]
pub async fn git_file_diff(
    state: tauri::State<'_, AppState>,
    source: Source,
    folder: String,
    path: String,
    old_path: Option<String>,
    compare: Compare,
) -> Result<GitFileDiff> {
    check_path(&path)?;
    if let Some(old) = &old_path {
        check_path(old)?;
    }
    let host = GitHost::resolve(&state.connections, &state.locals, &source).await?;
    let (original, held) = git_sides(&host, &folder, &path, old_path.as_deref(), &compare).await?;
    let modified = match (held, compare) {
        (Some(side), _) => side,
        (None, Compare::IndexWorktree { deleted: true }) => Side::Absent,
        (None, _) => {
            let file = format!("{}/{path}", folder.trim_end_matches('/'));
            let read = file_read::read(state.inner(), &source, &file, ReadOptions::default());
            read.await?.content.into()
        }
    };
    Ok(GitFileDiff { original, modified })
}

#[cfg(test)]
mod tests {
    use super::super::tests::git;
    use super::*;

    const OID: &str = "0123456789012345678901234567890123456789";

    #[test]
    fn reads_both_listing_formats_and_skips_what_is_not_the_files_own_copy() {
        let tree = format!("100644 blob {OID}\ta b.txt\0");
        assert_eq!(
            parse_entry(tree.as_bytes()),
            Some(Entry {
                mode: "100644".into(),
                object: OID.into(),
            })
        );
        let index = format!("100755 {OID} 0\tx\ty.sh\0");
        assert_eq!(parse_entry(index.as_bytes()).unwrap().mode, "100755");
        let submodule = format!("160000 commit {OID}\tsub\0");
        assert_eq!(parse_entry(submodule.as_bytes()).unwrap().mode, SUBMODULE);
        assert_eq!(parse_entry(b""), None);
        assert_eq!(
            parse_entry(format!("040000 tree {OID}\tdir\0").as_bytes()),
            None
        );
        let conflict = format!("100644 {OID} 1\tf\0100644 {OID} 2\tf\0100644 {OID} 3\tf\0");
        assert_eq!(parse_entry(conflict.as_bytes()), None);
    }

    #[test]
    fn a_path_stays_after_the_separator_and_blobs_have_no_filters() {
        let lookup = index_lookup("--cached");
        assert_eq!(lookup[lookup.len() - 2..], ["--", "--cached"]);
        let lookup = tree_lookup(OID, "-rf");
        assert_eq!(lookup[lookup.len() - 2..], ["--", "-rf"]);
        assert_eq!(blob_command(OID), ["cat-file", "blob", OID]);
    }

    #[test]
    fn compare_is_a_tagged_union() {
        let parsed: Compare =
            serde_json::from_str(r#"{"kind":"indexWorktree","deleted":true}"#).unwrap();
        assert_eq!(parsed, Compare::IndexWorktree { deleted: true });
        let parsed: Compare = serde_json::from_str(r#"{"kind":"headIndex"}"#).unwrap();
        assert_eq!(parsed, Compare::HeadIndex);
        assert!(serde_json::from_str::<Compare>(r#"{"kind":"branch"}"#).is_err());
        let parsed: Compare =
            serde_json::from_str(r#"{"kind":"commit","hash":"h","parent":null}"#).unwrap();
        assert_eq!(
            parsed,
            Compare::Commit {
                hash: "h".into(),
                parent: None
            }
        );
    }

    #[test]
    fn a_working_tree_file_keeps_the_hash_a_save_compares() {
        let side: Side = Content::Text {
            text: "x".into(),
            encoding: "utf-8".into(),
            lossy: false,
            large: false,
            hash: "abc".into(),
        }
        .into();
        assert!(matches!(side, Side::Text { hash, .. } if hash == "abc"));
        assert_eq!(Side::from(Content::Large), Side::TooLarge);
        assert_eq!(Side::from(Content::TooLarge), Side::TooLarge);
    }

    fn text(side: &Side) -> &str {
        match side {
            Side::Text { text, .. } => text,
            other => panic!("not text: {other:?}"),
        }
    }

    /// This PC's real git. The right side of the working tree comparisons is `file_read`'s.
    #[tokio::test]
    async fn the_sides_of_a_real_repository() {
        let Some(program) = crate::git_credential::git_program() else {
            return;
        };
        let repo =
            std::env::temp_dir().join(format!("dachsterm-sides-{} 한글", std::process::id()));
        std::fs::create_dir_all(&repo).unwrap();
        let root = repo.to_str().unwrap().replace('\\', "/");
        let host = GitHost::Native(Some(program));
        git(&repo, &["init", "-q", "-b", "main"]);

        // Before the first commit, a staged file is new.
        std::fs::write(repo.join("첫 파일.txt"), "first\n").unwrap();
        git(&repo, &["add", "."]);
        let (left, right) = git_sides(&host, &root, "첫 파일.txt", None, &Compare::HeadIndex)
            .await
            .unwrap();
        assert_eq!(left, Side::Absent);
        assert_eq!(text(&right.unwrap()), "first\n");
        git(&repo, &["commit", "-q", "-m", "one"]);

        // HEAD, index and working tree all differ.
        std::fs::write(repo.join("첫 파일.txt"), "staged\n").unwrap();
        git(&repo, &["add", "."]);
        std::fs::write(repo.join("첫 파일.txt"), "working\n").unwrap();
        let (left, right) = git_sides(&host, &root, "첫 파일.txt", None, &Compare::HeadIndex)
            .await
            .unwrap();
        assert_eq!(text(&left), "first\n");
        assert_eq!(text(&right.unwrap()), "staged\n");
        let compare = Compare::IndexWorktree { deleted: false };
        let (left, right) = git_sides(&host, &root, "첫 파일.txt", None, &compare)
            .await
            .unwrap();
        assert_eq!(text(&left), "staged\n");
        assert_eq!(right, None);

        // An untracked file has nothing on the left, and Git is not asked.
        let (left, right) = git_sides(&host, &root, "없는 파일", None, &Compare::Untracked)
            .await
            .unwrap();
        assert_eq!((left, right), (Side::Absent, None));

        // A staged rename reads the old name on the left.
        git(&repo, &["checkout", "-q", "--", "."]);
        git(&repo, &["reset", "-q", "--hard"]);
        git(&repo, &["mv", "첫 파일.txt", "새 이름.txt"]);
        let (left, right) = git_sides(
            &host,
            &root,
            "새 이름.txt",
            Some("첫 파일.txt"),
            &Compare::HeadIndex,
        )
        .await
        .unwrap();
        assert_eq!(text(&left), "first\n");
        assert_eq!(text(&right.unwrap()), "first\n");

        // A blob is decided by its bytes, and one past the limit is not read.
        std::fs::write(repo.join("bin"), b"\0\x01\x02binary").unwrap();
        std::fs::write(repo.join("big"), vec![b'a'; MAX_FILE as usize + 1]).unwrap();
        git(&repo, &["add", "bin", "big"]);
        let compare = Compare::IndexWorktree { deleted: false };
        let (left, _) = git_sides(&host, &root, "bin", None, &compare)
            .await
            .unwrap();
        assert!(matches!(left, Side::Binary { .. }), "{left:?}");
        let (left, _) = git_sides(&host, &root, "big", None, &compare)
            .await
            .unwrap();
        assert_eq!(left, Side::TooLarge);

        std::fs::remove_dir_all(&repo).unwrap();
    }

    /// Both sides of a commit come from Git, whatever the working tree holds now.
    #[tokio::test]
    async fn a_commit_is_read_from_its_own_trees() {
        let Some(program) = crate::git_credential::git_program() else {
            return;
        };
        let repo = std::env::temp_dir().join(format!(
            "dachsterm-commit-sides-{} 한글",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(&repo).unwrap();
        let root = repo.to_str().unwrap().replace('\\', "/");
        let host = GitHost::Native(Some(program.clone()));
        let head = || {
            let out = std::process::Command::new(&program)
                .current_dir(&repo)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap();
            String::from_utf8(out.stdout).unwrap().trim().to_string()
        };
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("old.txt"), "first\n").unwrap();
        std::fs::write(repo.join("gone.txt"), "gone\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "one"]);
        let one = head();
        git(&repo, &["mv", "old.txt", "new.txt"]);
        git(&repo, &["rm", "-q", "gone.txt"]);
        git(&repo, &["commit", "-q", "-m", "two"]);
        let two = head();
        std::fs::write(repo.join("new.txt"), "working tree\n").unwrap();

        let compare = Compare::Commit {
            hash: two,
            parent: Some(one.clone()),
        };
        let (left, right) = git_sides(&host, &root, "new.txt", Some("old.txt"), &compare)
            .await
            .unwrap();
        assert_eq!(text(&left), "first\n");
        assert_eq!(text(&right.unwrap()), "first\n");
        let (left, right) = git_sides(&host, &root, "gone.txt", None, &compare)
            .await
            .unwrap();
        assert_eq!(text(&left), "gone\n");
        assert_eq!(right, Some(Side::Absent));

        let first = Compare::Commit {
            hash: one,
            parent: None,
        };
        let (left, right) = git_sides(&host, &root, "old.txt", None, &first)
            .await
            .unwrap();
        assert_eq!(left, Side::Absent);
        assert_eq!(text(&right.unwrap()), "first\n");

        let bad = Compare::Commit {
            hash: "--all".into(),
            parent: None,
        };
        assert!(
            git_sides(&host, &root, "old.txt", None, &bad)
                .await
                .is_err()
        );
        std::fs::remove_dir_all(&repo).unwrap();
    }
}
