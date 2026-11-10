//! The sidebar Git view's listing (GE.7): the same query as the status bar's, but with staged and
//! unstaged sides apart and untracked files one by one instead of as folders.
use super::{MAX_ENTRIES, Record, StopReason, first_line, scan, status_commands};
use crate::{
    AppState,
    git_diff::{Change, change},
    git_run::{GitHost, NO_GIT, git_read},
    remote_exec::{Failure, Limits, Output},
    source::Source,
    storage::Result,
};
use serde::Serialize;
use std::time::Duration;

/// Listing every untracked file walks more of the tree than the status bar's query does.
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT: usize = 8 * 1024 * 1024;

/// One changed file. A file can be changed on both sides, so each side has its own change.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ViewEntry {
    pub path: String,
    pub old_path: Option<String>,
    /// HEAD against the index. `conflict` when a merge left the file unresolved.
    pub index: Option<Change>,
    /// The index against the working tree. `untracked` for a file Git does not know.
    pub worktree: Option<Change>,
    /// The name is valid UTF-8. Other names are shown with replacement characters and cannot be
    /// asked for, since the shown name is not the real one.
    pub readable: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitViewResult {
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
        entries: Vec<ViewEntry>,
        /// More than `MAX_ENTRIES` changes; only the first ones are listed.
        truncated: bool,
    },
    NotRepo {
        detail: String,
    },
    /// Git itself is missing where this tab runs it, which the view explains how to fix.
    NoGit {
        detail: String,
    },
    Stopped {
        reason: StopReason,
    },
}

fn entry(record: &Record) -> ViewEntry {
    let (index, worktree) = match record.kind {
        b'u' => (Some(Change::Conflict), Some(Change::Conflict)),
        b'?' => (None, Some(Change::Untracked)),
        _ => (
            record.xy.first().and_then(|x| change(&[*x])),
            record.xy.get(1).and_then(|y| change(&[*y])),
        ),
    };
    let lossy = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
    ViewEntry {
        path: lossy(record.path),
        old_path: record.old_path.map(lossy),
        index,
        worktree,
        readable: std::str::from_utf8(record.path).is_ok()
            && record
                .old_path
                .is_none_or(|old| std::str::from_utf8(old).is_ok()),
    }
}

fn parse(stdout: &[u8], spelled: Option<&str>) -> Option<GitViewResult> {
    let scanned = scan(stdout, spelled)?;
    Some(GitViewResult::Repo {
        root: scanned.root,
        branch: scanned.branch,
        oid: scanned.oid,
        upstream: scanned.upstream,
        ahead: scanned.ahead,
        behind: scanned.behind,
        entries: scanned
            .records
            .iter()
            .take(MAX_ENTRIES)
            .map(entry)
            .collect(),
        truncated: scanned.records.len() > MAX_ENTRIES,
    })
}

fn outcome(host: &GitHost, output: &Output, folder: &str) -> Result<GitViewResult> {
    match output.exit {
        Some(0) => parse(&output.stdout, host.spells_folder().then_some(folder))
            .ok_or_else(|| "Git 상태 출력을 읽을 수 없습니다.".into()),
        Some(NO_GIT) => Ok(GitViewResult::NoGit {
            detail: host.no_git_text().into(),
        }),
        _ => Ok(GitViewResult::NotRepo {
            detail: first_line(&output.stderr),
        }),
    }
}

pub async fn query(host: &GitHost, folder: &str) -> Result<GitViewResult> {
    let limits = Limits {
        timeout: TIMEOUT,
        max_output: MAX_OUTPUT,
    };
    let commands = status_commands(&["--untracked-files=all"]);
    match git_read(host, folder, &commands, limits).await {
        Ok(output) => outcome(host, &output, folder),
        Err(Failure::TimedOut) => Ok(GitViewResult::Stopped {
            reason: StopReason::Timeout,
        }),
        Err(Failure::TooLarge) => Ok(GitViewResult::Stopped {
            reason: StopReason::TooLarge,
        }),
        Err(Failure::Other(message)) => Err(message),
    }
}

#[tauri::command]
pub async fn git_view(
    state: tauri::State<'_, AppState>,
    source: Source,
    folder: String,
) -> Result<GitViewResult> {
    let host = GitHost::resolve(&state.connections, &state.locals, &source).await?;
    query(&host, &folder).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(output: &[u8]) -> (Vec<ViewEntry>, bool) {
        match parse(output, None) {
            Some(GitViewResult::Repo {
                entries, truncated, ..
            }) => (entries, truncated),
            other => panic!("{other:?}"),
        }
    }

    fn sides(entry: &ViewEntry) -> (&str, Option<Change>, Option<Change>) {
        (entry.path.as_str(), entry.index, entry.worktree)
    }

    #[test]
    fn keeps_the_staged_and_unstaged_sides_apart() {
        let output = "/srv/app\n\0# branch.head main\0\
1 M. N... 100644 100644 100644 a b staged.rs\0\
1 .M N... 100644 100644 100644 a b unstaged.rs\0\
1 MM N... 100644 100644 100644 a b both.rs\0\
1 A. N... 000000 100644 100644 0 b new file.txt\0\
1 AD N... 000000 100644 000000 0 b gone again.txt\0\
1 .D N... 100644 100644 000000 a a missing.txt\0\
1 .T N... 100644 100644 120000 a a link\0\
2 R. N... 100644 100644 100644 a a R100 새 이름.txt\0old name.txt\0\
u UU N... 100644 100644 100644 100644 a b c conflict.txt\0\
? src/deep/untracked.md\0";
        let (list, truncated) = entries(output.as_bytes());
        assert!(!truncated);
        use Change::*;
        assert_eq!(
            list.iter().map(sides).collect::<Vec<_>>(),
            vec![
                ("staged.rs", Some(Modified), None),
                ("unstaged.rs", None, Some(Modified)),
                ("both.rs", Some(Modified), Some(Modified)),
                ("new file.txt", Some(Added), None),
                ("gone again.txt", Some(Added), Some(Deleted)),
                ("missing.txt", None, Some(Deleted)),
                ("link", None, Some(TypeChanged)),
                ("새 이름.txt", Some(Renamed), None),
                ("conflict.txt", Some(Conflict), Some(Conflict)),
                ("src/deep/untracked.md", None, Some(Untracked)),
            ]
        );
        assert_eq!(list[7].old_path.as_deref(), Some("old name.txt"));
        assert!(list.iter().all(|e| e.readable));
    }

    #[test]
    fn a_name_that_is_not_utf8_shows_but_cannot_be_asked_for() {
        let (list, _) = entries(b"/r\n\0? bad\xffname\0? ok\0");
        assert_eq!(list[0].path, "bad\u{fffd}name");
        assert!(!list[0].readable);
        assert!(list[1].readable);
    }

    #[test]
    fn stops_listing_at_the_entry_limit() {
        let mut output = b"/r\n\0".to_vec();
        for n in 0..=MAX_ENTRIES {
            output.extend_from_slice(format!("? f{n}\0").as_bytes());
        }
        let (list, truncated) = entries(&output);
        assert_eq!(list.len(), MAX_ENTRIES);
        assert!(truncated);
    }

    #[test]
    fn a_missing_git_is_told_apart_from_a_folder_outside_a_repository() {
        let host = GitHost::Native(None);
        let output = |exit, stderr: &str| Output {
            stdout: vec![],
            stderr: stderr.into(),
            exit,
        };
        assert_eq!(
            outcome(&host, &output(Some(127), "sh: git: not found"), "/x"),
            Ok(GitViewResult::NoGit {
                detail: "이 PC에서 git을 찾지 못했습니다.".into()
            })
        );
        assert_eq!(
            outcome(
                &host,
                &output(Some(128), "fatal: not a git repository"),
                "/x"
            ),
            Ok(GitViewResult::NotRepo {
                detail: "fatal: not a git repository".into()
            })
        );
    }

    #[test]
    fn serializes_for_the_window() {
        let entry = ViewEntry {
            path: "a".into(),
            old_path: None,
            index: Some(Change::Renamed),
            worktree: None,
            readable: true,
        };
        assert_eq!(
            serde_json::to_string(&entry).unwrap(),
            r#"{"path":"a","oldPath":null,"index":"renamed","worktree":null,"readable":true}"#
        );
    }

    fn git(folder: &std::path::Path, args: &[&str]) {
        let program = crate::git_credential::git_program().unwrap();
        let status = std::process::Command::new(program)
            .current_dir(folder)
            .args([
                "-c",
                "user.name=probe",
                "-c",
                "user.email=probe@example.invalid",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(status.status.success(), "{args:?}: {status:?}");
    }

    /// The real Git output of this PC's git for the same change set the OpenSSH fixture checks.
    #[tokio::test]
    async fn lists_a_real_repository_on_this_pc() {
        let Some(program) = crate::git_credential::git_program() else {
            return;
        };
        let repo = std::env::temp_dir().join(format!("dachsterm-view-{} 한글", std::process::id()));
        std::fs::create_dir_all(repo.join("deep").join("er")).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("edited.txt"), "a\n").unwrap();
        std::fs::write(repo.join("both.txt"), "a\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-qm", "init"]);
        std::fs::write(repo.join("edited.txt"), "b\n").unwrap();
        std::fs::write(repo.join("both.txt"), "b\n").unwrap();
        git(&repo, &["add", "both.txt"]);
        std::fs::write(repo.join("both.txt"), "c\n").unwrap();
        std::fs::write(repo.join("staged.txt"), "n\n").unwrap();
        git(&repo, &["add", "staged.txt"]);
        std::fs::write(repo.join("deep").join("er").join("새 파일.txt"), "u\n").unwrap();

        let host = GitHost::Native(Some(program));
        let inside = repo.join("deep");
        let GitViewResult::Repo {
            root,
            branch,
            entries,
            ..
        } = query(&host, inside.to_str().unwrap()).await.unwrap()
        else {
            panic!("not a repository");
        };
        assert!(
            root.ends_with(&format!("dachsterm-view-{} 한글", std::process::id())),
            "{root}"
        );
        assert_eq!(branch.as_deref(), Some("main"));
        let mut found: Vec<_> = entries.iter().map(sides).collect();
        found.sort_by_key(|(path, ..)| path.to_string());
        use Change::*;
        assert_eq!(
            found,
            vec![
                ("both.txt", Some(Modified), Some(Modified)),
                ("deep/er/새 파일.txt", None, Some(Untracked)),
                ("edited.txt", None, Some(Modified)),
                ("staged.txt", Some(Added), None),
            ]
        );
        std::fs::remove_dir_all(&repo).unwrap();
    }

    /// Needs a WSL distribution with git: `DACHSTERM_WSL=<name> cargo test ... -- --ignored`.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore]
    async fn lists_a_repository_inside_wsl() {
        let name = std::env::var("DACHSTERM_WSL").expect("DACHSTERM_WSL");
        let wsl = std::path::PathBuf::from(std::env::var("SystemRoot").unwrap())
            .join("System32")
            .join("wsl.exe");
        let mut target = crate::local::Target::for_test(&format!("wsl:{name}"), "wsl");
        target.program = wsl.clone();
        let folder = format!("/tmp/dachsterm view {} it's", std::process::id());
        let setup = "mkdir -p \"$1/deep/er\" && cd \"$1\" && git init -q -b main && \
                     git config user.email p@example.invalid && git config user.name p && \
                     echo a > edited.txt && echo a > both.txt && git add . && git commit -qm init && \
                     echo b > edited.txt && echo b > both.txt && git add both.txt && \
                     echo c > both.txt && echo n > staged.txt && git add staged.txt && \
                     echo u > deep/er/untracked.txt";
        let made = std::process::Command::new(&wsl)
            .args([
                "--distribution",
                &name,
                "--exec",
                "sh",
                "-c",
                setup,
                "sh",
                &folder,
            ])
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");
        let host = GitHost::local(target).await.unwrap();
        let GitViewResult::Repo { root, entries, .. } =
            query(&host, &format!("{folder}/deep")).await.unwrap()
        else {
            panic!("not a repository");
        };
        assert_eq!(root, folder);
        let mut found: Vec<_> = entries.iter().map(sides).collect();
        found.sort_by_key(|(path, ..)| path.to_string());
        use Change::*;
        assert_eq!(
            found,
            vec![
                ("both.txt", Some(Modified), Some(Modified)),
                ("deep/er/untracked.txt", None, Some(Untracked)),
                ("edited.txt", None, Some(Modified)),
                ("staged.txt", Some(Added), None),
            ]
        );
        std::process::Command::new(&wsl)
            .args(["--distribution", &name, "--exec", "rm", "-rf", &folder])
            .status()
            .unwrap();
    }

    #[tokio::test]
    async fn refuses_ftp_before_running_anything() {
        let ftp = Source::Ftp {
            connection_id: "f".into(),
        };
        let failed = GitHost::resolve(&Default::default(), &Default::default(), &ftp).await;
        assert_eq!(
            failed.err().as_deref(),
            Some("FTP 연결에서는 Git을 쓸 수 없습니다.")
        );
    }
}
