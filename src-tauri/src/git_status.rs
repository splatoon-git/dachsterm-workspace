//! Read-only Git status of one folder (DX.5), with the query of a local or WSL tab in `local`
//! (DX.15) and the sidebar Git view's fuller listing in `view` (GE.7). All of them run Git through
//! `git_read`, so its program-free settings apply to every query.
pub mod local;
pub mod view;

use crate::{
    AppState,
    git_run::{GitHost, args, git_read},
    remote_exec::{Failure, Limits, Output},
    storage::Result,
};
use serde::Serialize;
use std::time::Duration;

pub const MAX_ENTRIES: usize = 5000;
const TIMEOUT: Duration = Duration::from_secs(5);
const MAX_OUTPUT: usize = 1024 * 1024;
const MAX_DETAIL: usize = 200;

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
pub enum Mark {
    #[serde(rename = "M")]
    Modified,
    #[serde(rename = "A")]
    Added,
    #[serde(rename = "D")]
    Deleted,
    #[serde(rename = "?")]
    Untracked,
    #[serde(rename = "U")]
    Conflict,
}

/// `path` is relative to the repository root, as Git reports it.
#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct Entry {
    pub path: String,
    pub mark: Mark,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Timeout,
    TooLarge,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitStatus {
    #[serde(rename_all = "camelCase")]
    Repo {
        root: String,
        /// `None` when HEAD is detached.
        branch: Option<String>,
        /// `None` before the first commit.
        oid: Option<String>,
        upstream: Option<String>,
        ahead: u32,
        behind: u32,
        entries: Vec<Entry>,
        /// More than `MAX_ENTRIES` changes; only the first ones are listed.
        truncated: bool,
    },
    /// Not a repository, no Git, or a folder that cannot be entered. The app shows nothing for
    /// this, except `detail` (the first error line) when the user asked for the query.
    NotRepo { detail: String },
    /// The query hit a limit, so the app stops querying this folder on its own.
    Stopped { reason: StopReason },
}

/// The folder comes from a terminal report or a file listing. It is quoted, so only what a
/// shell argument cannot carry is refused.
pub(crate) fn check_folder(folder: &str) -> Result<()> {
    if !folder.starts_with('/') || folder.len() > 4096 || folder.contains('\0') {
        return Err("Git 저장소 폴더가 올바르지 않습니다.".into());
    }
    Ok(())
}

/// `extra` goes on the `status` command, so a query can ask for more than the default listing.
pub(crate) fn status_commands(extra: &[&str]) -> Vec<Vec<String>> {
    let mut status = args(["status", "--porcelain=v2", "--branch", "-z"]);
    status.extend(extra.iter().map(|s| s.to_string()));
    vec![
        args(["rev-parse", "--show-toplevel", "--show-prefix"]),
        status,
    ]
}

pub(crate) fn first_line(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let line = text.lines().map(str::trim).find(|l| !l.is_empty());
    line.unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_DETAIL)
        .collect()
}

/// Git for Windows prints its root as `C:/path`.
pub(crate) fn windows_root(root: &str) -> bool {
    let bytes = root.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}

fn mark(kind: u8, xy: &[u8]) -> Mark {
    match kind {
        b'u' => Mark::Conflict,
        b'?' => Mark::Untracked,
        b'2' => Mark::Added,
        _ if xy.contains(&b'D') => Mark::Deleted,
        _ if xy.first() == Some(&b'A') => Mark::Added,
        _ => Mark::Modified,
    }
}

/// One file of `status --porcelain=v2 -z`, with paths as Git wrote them.
pub(crate) struct Record<'a> {
    pub kind: u8,
    pub xy: &'a [u8],
    pub path: &'a [u8],
    pub old_path: Option<&'a [u8]>,
}

/// A query's branch headers and file records.
pub(crate) struct Scanned<'a> {
    pub root: String,
    pub branch: Option<String>,
    pub oid: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub records: Vec<Record<'a>>,
}

/// `rev-parse` output, NUL, then `status --porcelain=v2 --branch -z` records. `spelled` is the
/// folder to take the root's spelling from.
pub(crate) fn scan<'a>(stdout: &'a [u8], spelled: Option<&str>) -> Option<Scanned<'a>> {
    let split = stdout.iter().position(|b| *b == 0)?;
    let head = String::from_utf8_lossy(&stdout[..split]);
    let root = head.lines().next()?.trim_end_matches('\r').to_string();
    if !root.starts_with('/') && !windows_root(&root) {
        return None;
    }
    let root = match spelled {
        Some(folder) => local::root_as_shell_spells(folder, &head),
        None => root,
    };
    let mut scanned = Scanned {
        root,
        branch: None,
        oid: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        records: Vec::new(),
    };
    let mut parts = stdout[split + 1..].split(|b| *b == 0);
    while let Some(record) = parts.next() {
        if let Some(header) = record.strip_prefix(b"# ") {
            let header = String::from_utf8_lossy(header);
            let (key, value) = header.split_once(' ').unwrap_or((&header, ""));
            match key {
                "branch.oid" => scanned.oid = (value != "(initial)").then(|| value.to_string()),
                "branch.head" => {
                    scanned.branch = (value != "(detached)").then(|| value.to_string())
                }
                "branch.upstream" => scanned.upstream = Some(value.to_string()),
                "branch.ab" => {
                    let mut counts = value
                        .split(' ')
                        .map(|n| n.get(1..).and_then(|v| v.parse().ok()).unwrap_or(0));
                    scanned.ahead = counts.next().unwrap_or(0);
                    scanned.behind = counts.next().unwrap_or(0);
                }
                _ => {}
            }
            continue;
        }
        let (Some(&kind), Some(b' ')) = (record.first(), record.get(1)) else {
            continue;
        };
        let field = |n: usize| record.splitn(n + 1, |b| *b == b' ').nth(n);
        let path = match kind {
            b'1' => field(8),
            b'2' => field(9),
            b'u' => field(10),
            b'?' => record.get(2..),
            _ => None,
        }
        .filter(|path| !path.is_empty());
        // A rename is followed by its original path as one more record.
        let old_path = if kind == b'2' { parts.next() } else { None };
        let Some(path) = path else { continue };
        let xy = if kind == b'?' {
            b"".as_slice()
        } else {
            record.get(2..4).unwrap_or_default()
        };
        scanned.records.push(Record {
            kind,
            xy,
            path,
            old_path,
        });
    }
    Some(scanned)
}

fn parse(stdout: &[u8], spelled: Option<&str>) -> Option<GitStatus> {
    let scanned = scan(stdout, spelled)?;
    let truncated = scanned.records.len() > MAX_ENTRIES;
    let entries = scanned
        .records
        .iter()
        .take(MAX_ENTRIES)
        .map(|record| Entry {
            path: String::from_utf8_lossy(record.path).into_owned(),
            mark: mark(record.kind, record.xy),
        })
        .collect();
    Some(GitStatus::Repo {
        root: scanned.root,
        branch: scanned.branch,
        oid: scanned.oid,
        upstream: scanned.upstream,
        ahead: scanned.ahead,
        behind: scanned.behind,
        entries,
        truncated,
    })
}

/// `untracked_files` lists new files one by one rather than as their folders (Settings → Git).
pub async fn query(host: &GitHost, folder: &str, untracked_files: bool) -> Result<GitStatus> {
    let limits = Limits {
        timeout: TIMEOUT,
        max_output: MAX_OUTPUT,
    };
    let extra: &[&str] = if untracked_files {
        &["--untracked-files=all"]
    } else {
        &[]
    };
    let output = match git_read(host, folder, &status_commands(extra), limits).await {
        Ok(output) => output,
        Err(Failure::TimedOut) => {
            return Ok(GitStatus::Stopped {
                reason: StopReason::Timeout,
            });
        }
        Err(Failure::TooLarge) => {
            return Ok(GitStatus::Stopped {
                reason: StopReason::TooLarge,
            });
        }
        Err(Failure::Other(message)) => return Err(message),
    };
    outcome(&output, host.spells_folder().then_some(folder))
}

/// Any failed step means "nothing to show": no folder, no Git (127) or not a repository (128).
fn outcome(output: &Output, spelled: Option<&str>) -> Result<GitStatus> {
    if output.exit != Some(0) {
        return Ok(GitStatus::NotRepo {
            detail: first_line(&output.stderr),
        });
    }
    parse(&output.stdout, spelled).ok_or_else(|| "Git 상태 출력을 읽을 수 없습니다.".into())
}

#[tauri::command]
pub async fn git_status(
    state: tauri::State<'_, AppState>,
    id: String,
    folder: String,
    untracked_files: bool,
) -> Result<GitStatus> {
    query(
        &GitHost::ssh(&state.connections, &id)?,
        &folder,
        untracked_files,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{Entry, GitStatus, MAX_ENTRIES, Mark, check_folder, first_line, outcome};
    use crate::remote_exec::Output;

    fn parse(output: &[u8]) -> Option<GitStatus> {
        super::parse(output, None)
    }

    fn repo(output: &[u8]) -> (Option<String>, Option<String>, u32, u32, Vec<Entry>, bool) {
        match parse(output) {
            Some(GitStatus::Repo {
                branch,
                upstream,
                ahead,
                behind,
                entries,
                truncated,
                ..
            }) => (branch, upstream, ahead, behind, entries, truncated),
            other => panic!("{other:?}"),
        }
    }

    fn entry(path: &str, mark: Mark) -> Entry {
        Entry {
            path: path.into(),
            mark,
        }
    }

    #[test]
    fn reads_branch_headers_and_every_entry_kind() {
        let output = b"/srv/app\n\0\
# branch.oid 0123456789abcdef0123456789abcdef01234567\0\
# branch.head main\0\
# branch.upstream origin/main\0\
# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaa bbb src/main.rs\0\
1 A. N... 000000 100644 100644 000 bbb new file.txt\0\
1 D. N... 100644 000000 000000 aaa 000 gone.txt\0\
1 .D N... 100644 100644 000000 aaa aaa missing.txt\0\
2 R. N... 100644 100644 100644 aaa aaa R100 renamed name.txt\0old name.txt\0\
u UU N... 100644 100644 100644 100644 a b c conflict.txt\0\
? untracked dir/\0\
! ignored.log\0";
        let (branch, upstream, ahead, behind, entries, truncated) = repo(output);
        assert_eq!(branch.as_deref(), Some("main"));
        assert_eq!(upstream.as_deref(), Some("origin/main"));
        assert_eq!((ahead, behind, truncated), (2, 1, false));
        assert_eq!(
            entries,
            vec![
                entry("src/main.rs", Mark::Modified),
                entry("new file.txt", Mark::Added),
                entry("gone.txt", Mark::Deleted),
                entry("missing.txt", Mark::Deleted),
                entry("renamed name.txt", Mark::Added),
                entry("conflict.txt", Mark::Conflict),
                entry("untracked dir/", Mark::Untracked),
            ]
        );
    }

    #[test]
    fn detached_head_and_first_commit_have_no_name() {
        let output = b"/r\n\0# branch.oid (initial)\0# branch.head (detached)\0";
        match parse(output) {
            Some(GitStatus::Repo {
                branch,
                oid,
                upstream,
                ..
            }) => assert_eq!((branch, oid, upstream), (None, None, None)),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn stops_listing_at_the_entry_limit() {
        let mut output = b"/r\n\0# branch.head main\0".to_vec();
        for n in 0..=MAX_ENTRIES {
            output.extend_from_slice(format!("? f{n}\0").as_bytes());
        }
        let (.., entries, truncated) = repo(&output);
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert!(truncated);
    }

    #[test]
    fn refuses_output_without_an_absolute_root() {
        assert!(parse(b"").is_none());
        assert!(parse(b"/r").is_none());
        assert!(parse(b"warning\n\0# branch.head main\0").is_none());
        assert!(parse(b"C:\\r\n\0# branch.head main\0").is_none());
        assert!(matches!(
            parse(b"C:/Users/a/repo\n\0# branch.head main\0"),
            Some(GitStatus::Repo { root, .. }) if root == "C:/Users/a/repo"
        ));
        // A malformed record is skipped, not misread.
        let (.., entries, _) = repo(b"/r\n\x001 .M\0? \0? ok\0");
        assert_eq!(entries, vec![entry("ok", Mark::Untracked)]);
    }

    #[test]
    fn checks_the_folder_and_quotes_it() {
        assert!(check_folder("/home/a b/'x'").is_ok());
        for bad in ["", "relative", "~/x", "/a\0b"] {
            assert!(check_folder(bad).is_err(), "{bad:?}");
        }
        assert!(check_folder(&format!("/{}", "a".repeat(4096))).is_err());
    }

    #[test]
    fn the_status_query_is_two_commands_and_takes_extra_switches() {
        let commands = super::status_commands(&["--untracked-files=all"]);
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0][0], "rev-parse");
        assert_eq!(
            commands[1].last().map(String::as_str),
            Some("--untracked-files=all")
        );
        // A subfolder's prefix between the root and the records is not read as a record.
        let (.., entries, _) = repo(b"/r\n? x/\n\0? ok\0");
        assert_eq!(entries, vec![entry("ok", Mark::Untracked)]);
    }

    #[test]
    fn a_failed_step_is_nothing_to_show() {
        for (exit, stderr) in [
            (Some(127), "sh: 1: git: not found"),
            (
                Some(128),
                "fatal: not a git repository (or any parent up to mount point /)",
            ),
            (Some(2), "sh: 1: cd: can't cd to /gone"),
            (None, ""),
        ] {
            let output = Output {
                stdout: b"/r
"
                .to_vec(),
                stderr: stderr.into(),
                exit,
            };
            assert_eq!(
                outcome(&output, None),
                Ok(GitStatus::NotRepo {
                    detail: stderr.into()
                })
            );
        }
    }

    #[test]
    fn keeps_the_first_error_line_as_plain_text() {
        assert_eq!(
            first_line(b"\n  fatal: not a git repository\x1b[31m\nmore"),
            "fatal: not a git repository[31m"
        );
        assert_eq!(first_line(b""), "");
        assert_eq!(first_line("가".repeat(300).as_bytes()).chars().count(), 200);
    }
}
