//! Read-only Git status of one remote folder (DX.5), and of a local or WSL folder in `local`
//! (DX.15). Git queries live here and not in the command layer, so the diff review (DX.6) runs Git
//! with the same program-free settings.
pub mod local;

use crate::{
    AppState,
    remote_exec::{self, Failure, Limits, Output, quote},
    ssh::Connections,
    storage::Result,
};
use serde::Serialize;
use std::time::Duration;

/// A repository's own settings must not start a program. `core.fsmonitor` names a hook the
/// repository chooses, and optional locks would collide with the user's own Git commands. Clean
/// filters cannot be turned off by name and remain, which the user guide states.
pub const SAFE_GIT: &str = "LC_ALL=C GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false";
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

pub fn status_script(folder: &str) -> String {
    format!(
        "cd -- {} && {SAFE_GIT} rev-parse --show-toplevel && {SAFE_GIT} status --porcelain=v2 --branch -z",
        quote(folder)
    )
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
fn windows_root(root: &str) -> bool {
    let bytes = root.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/'
}

fn mark(kind: &str, xy: &str) -> Mark {
    match kind {
        "u" => Mark::Conflict,
        "?" => Mark::Untracked,
        "2" => Mark::Added,
        _ if xy.contains('D') => Mark::Deleted,
        _ if xy.starts_with('A') => Mark::Added,
        _ => Mark::Modified,
    }
}

/// `rev-parse --show-toplevel` output, then `status --porcelain=v2 --branch -z` records.
fn parse(stdout: &[u8]) -> Option<GitStatus> {
    let newline = stdout.iter().position(|b| *b == b'\n')?;
    let root = String::from_utf8_lossy(&stdout[..newline])
        .trim_end_matches('\r')
        .to_string();
    if !root.starts_with('/') && !windows_root(&root) {
        return None;
    }
    let (mut branch, mut oid, mut upstream, mut ahead, mut behind) = (None, None, None, 0, 0);
    let mut entries = Vec::new();
    let mut truncated = false;
    let mut records = stdout[newline + 1..].split(|b| *b == 0);
    while let Some(record) = records.next() {
        let record = String::from_utf8_lossy(record);
        if let Some(header) = record.strip_prefix("# ") {
            let (key, value) = header.split_once(' ').unwrap_or((header, ""));
            match key {
                "branch.oid" => oid = (value != "(initial)").then(|| value.to_string()),
                "branch.head" => branch = (value != "(detached)").then(|| value.to_string()),
                "branch.upstream" => upstream = Some(value.to_string()),
                "branch.ab" => {
                    let mut counts = value
                        .split(' ')
                        .map(|n| n.get(1..).and_then(|v| v.parse().ok()).unwrap_or(0));
                    ahead = counts.next().unwrap_or(0);
                    behind = counts.next().unwrap_or(0);
                }
                _ => {}
            }
            continue;
        }
        let kind = record.split(' ').next().unwrap_or("");
        let xy = record.get(2..4).unwrap_or("");
        let (xy, path) = match kind {
            "1" => record.splitn(9, ' ').nth(8).map(|p| (xy, p)),
            "2" => record.splitn(10, ' ').nth(9).map(|p| (xy, p)),
            "u" => record.splitn(11, ' ').nth(10).map(|p| (xy, p)),
            "?" => record.get(2..).map(|p| ("", p)),
            _ => None,
        }
        .filter(|(_, p)| !p.is_empty())
        .unzip();
        // A rename is followed by its original path as one more record.
        if kind == "2" {
            records.next();
        }
        let (Some(xy), Some(path)) = (xy, path) else {
            continue;
        };
        if entries.len() == MAX_ENTRIES {
            truncated = true;
            break;
        }
        entries.push(Entry {
            path: path.to_string(),
            mark: mark(kind, xy),
        });
    }
    Some(GitStatus::Repo {
        root,
        branch,
        oid,
        upstream,
        ahead,
        behind,
        entries,
        truncated,
    })
}

pub async fn query(connections: &Connections, id: &str, folder: &str) -> Result<GitStatus> {
    check_folder(folder)?;
    let handle = connections.handle(id)?;
    let limits = Limits {
        timeout: TIMEOUT,
        max_output: MAX_OUTPUT,
    };
    let output = match remote_exec::run(&handle, &status_script(folder), limits).await {
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
    outcome(&output)
}

/// Any failed step means "nothing to show": no folder, no Git (127) or not a repository (128).
fn outcome(output: &Output) -> Result<GitStatus> {
    if output.exit != Some(0) {
        return Ok(GitStatus::NotRepo {
            detail: first_line(&output.stderr),
        });
    }
    parse(&output.stdout).ok_or_else(|| "Git 상태 출력을 읽을 수 없습니다.".into())
}

#[tauri::command]
pub async fn git_status(
    state: tauri::State<'_, AppState>,
    id: String,
    folder: String,
) -> Result<GitStatus> {
    query(&state.connections, &id, &folder).await
}

#[cfg(test)]
mod tests {
    use super::{Entry, GitStatus, MAX_ENTRIES, Mark, check_folder, first_line, outcome, parse};
    use crate::remote_exec::Output;

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
        let output = b"/srv/app\n\
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
        let output = b"/r\n# branch.oid (initial)\0# branch.head (detached)\0";
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
        let mut output = b"/r\n# branch.head main\0".to_vec();
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
        assert!(parse(b"warning\n# branch.head main\0").is_none());
        assert!(parse(b"C:\\r\n# branch.head main\0").is_none());
        assert!(matches!(
            parse(b"C:/Users/a/repo\n# branch.head main\0"),
            Some(GitStatus::Repo { root, .. }) if root == "C:/Users/a/repo"
        ));
        // A malformed record is skipped, not misread.
        let (.., entries, _) = repo(b"/r\n1 .M\0? \0? ok\0");
        assert_eq!(entries, vec![entry("ok", Mark::Untracked)]);
    }

    #[test]
    fn checks_the_folder_and_quotes_it() {
        assert!(check_folder("/home/a b/'x'").is_ok());
        for bad in ["", "relative", "~/x", "/a\0b"] {
            assert!(check_folder(bad).is_err(), "{bad:?}");
        }
        assert!(check_folder(&format!("/{}", "a".repeat(4096))).is_err());
        let script = super::status_script("/srv/it's $(x)");
        assert!(script.starts_with("cd -- '/srv/it'\\''s $(x)' && "));
        assert_eq!(script.matches("-c core.fsmonitor=false").count(), 2);
        assert_eq!(script.matches("GIT_OPTIONAL_LOCKS=0").count(), 2);
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
                outcome(&output),
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
