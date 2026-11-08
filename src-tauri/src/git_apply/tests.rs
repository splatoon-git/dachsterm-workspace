use super::*;
use crate::{
    git_diff::Change,
    git_status::view::{GitViewResult, ViewEntry, query},
};
use std::path::{Path, PathBuf};

fn paths(names: &[&str]) -> Vec<String> {
    names.iter().map(|s| s.to_string()).collect()
}

#[test]
fn reads_each_action_from_the_window() {
    let read = |text: &str| serde_json::from_str::<GitAction>(text).unwrap();
    assert_eq!(
        read(r#"{"kind":"stage","paths":["a"]}"#),
        GitAction::Stage {
            paths: Some(paths(&["a"]))
        }
    );
    assert_eq!(
        read(r#"{"kind":"unstage","paths":null}"#),
        GitAction::Unstage { paths: None }
    );
    assert_eq!(
        read(r#"{"kind":"branchCreate","name":"x"}"#),
        GitAction::BranchCreate { name: "x".into() }
    );
    assert_eq!(
        read(r#"{"kind":"stashPush","message":"m","includeUntracked":true}"#),
        GitAction::StashPush {
            message: "m".into(),
            include_untracked: true
        }
    );
    assert_eq!(read(r#"{"kind":"stashPop"}"#), GitAction::StashPop);
    assert!(serde_json::from_str::<GitAction>(r#"{"kind":"push"}"#).is_err());
    assert!(serde_json::from_str::<GitAction>(r#"{"kind":"fetch"}"#).is_err());
}

#[test]
fn every_path_comes_after_the_separator() {
    let commands = plan(&GitAction::Stage {
        paths: Some(paths(&["--force", ":(top)*", "[a].txt"])),
    })
    .unwrap();
    assert_eq!(
        commands,
        vec![args(["add", "-A", "--", "--force", ":(top)*", "[a].txt"])]
    );
    let commands = plan(&GitAction::Discard {
        paths: paths(&["-a"]),
        untracked: paths(&["-b"]),
    })
    .unwrap();
    assert_eq!(
        commands,
        vec![
            args(["checkout", "-q", "--", "-a"]),
            args(["clean", "-f", "-q", "--", "-b"]),
        ]
    );
}

#[test]
fn the_whole_repository_has_no_path_list() {
    let plan_of = |action| plan(&action).unwrap();
    assert_eq!(
        plan_of(GitAction::Stage { paths: None }),
        vec![args(["add", "-A"])]
    );
    assert_eq!(
        plan_of(GitAction::Unstage { paths: None }),
        vec![args(["reset", "-q"])]
    );
}

#[test]
fn a_long_list_is_split_and_loses_nothing() {
    let names: Vec<String> = (0..2000)
        .map(|n| format!("a-long-directory-name/{n:04}-file.txt"))
        .collect();
    let commands = plan(&GitAction::Stage {
        paths: Some(names.clone()),
    })
    .unwrap();
    assert!(commands.len() > 1);
    for command in &commands {
        assert_eq!(&command[..3], ["add", "-A", "--"]);
        let size: usize = command[3..].iter().map(|p| quote(p).len() + 1).sum();
        assert!(size <= MAX_TEXT, "{size}");
    }
    let rest: Vec<String> = commands.iter().flat_map(|c| c[3..].to_vec()).collect();
    assert_eq!(rest, names);
}

#[test]
fn refuses_paths_outside_the_repository_and_empty_lists() {
    for bad in ["/etc/passwd", "../x", "a/../../b", "", "a\0b"] {
        assert!(
            plan(&GitAction::Stage {
                paths: Some(paths(&[bad]))
            })
            .is_err(),
            "{bad:?}"
        );
    }
    assert!(
        plan(&GitAction::Stage {
            paths: Some(Vec::new())
        })
        .is_err()
    );
    assert!(
        plan(&GitAction::Discard {
            paths: Vec::new(),
            untracked: Vec::new()
        })
        .is_err()
    );
    // A name that only looks like a parent folder stays allowed.
    assert!(
        plan(&GitAction::Stage {
            paths: Some(paths(&["a..b/c..", "..d"]))
        })
        .is_ok()
    );
}

#[test]
fn names_cannot_be_read_as_options() {
    let branch = |name: &str| {
        plan(&GitAction::BranchCreate {
            name: name.to_string(),
        })
    };
    assert!(branch("feat/기능-1").is_ok());
    for bad in ["", "-b", "--force", "a b", "a\nb"] {
        assert!(branch(bad).is_err(), "{bad:?}");
    }
    assert!(
        plan(&GitAction::Checkout {
            branch: "-f".into()
        })
        .is_err()
    );
    assert!(
        plan(&GitAction::Tag {
            name: "-d".into(),
            message: String::new()
        })
        .is_err()
    );
}

#[test]
fn a_commit_needs_a_message_unless_it_amends() {
    let commit = |message: &str, amend| {
        plan(&GitAction::Commit {
            message: message.to_string(),
            amend,
        })
    };
    let magic = MAGIC_PATHSPECS;
    assert_eq!(
        commit("-x", false).unwrap(),
        vec![args([magic, "commit", "-q", "-m", "-x"])]
    );
    assert_eq!(
        commit("n", true).unwrap(),
        vec![args([magic, "commit", "-q", "--amend", "-m", "n"])]
    );
    assert_eq!(
        commit("  \n", true).unwrap(),
        vec![args([magic, "commit", "-q", "--amend", "--no-edit"])]
    );
    assert!(commit("  ", false).is_err());
    assert!(commit(&"m".repeat(MAX_TEXT + 1), false).is_err());
}

#[test]
fn the_output_line_leaves_out_messages_and_is_cut() {
    assert_eq!(
        shown(&args([MAGIC_PATHSPECS, "commit", "-q", "-m", "비밀 계획"])),
        "git commit -q -m …"
    );
    assert_eq!(
        shown(&args(["tag", "-a", "-m", "노트", "v1"])),
        "git tag -a -m … v1"
    );
    let long = "x".repeat(MAX_SHOWN * 2);
    let line = shown(&args(["add", "-A", "--", &long]));
    assert_eq!(line.chars().count(), MAX_SHOWN + 1);
    assert!(line.ends_with('…'));
    assert_eq!(shown(&args(["add", "a\nb"])), "git add ab");
}

#[test]
fn results_serialize_for_the_window() {
    assert_eq!(
        serde_json::to_string(&GitApplyResult::Failed {
            commands: vec!["git x".into()],
            reason: FailReason::NoGit,
            detail: "d".into(),
        })
        .unwrap(),
        r#"{"kind":"failed","commands":["git x"],"reason":"noGit","detail":"d"}"#
    );
    assert_eq!(
        serde_json::to_string(&GitApplyResult::Done { commands: vec![] }).unwrap(),
        r#"{"kind":"done","commands":[]}"#
    );
}

#[tokio::test]
async fn a_missing_git_is_reported_as_that() {
    let folder = std::env::temp_dir();
    let done = apply(
        &GitHost::Native(None),
        folder.to_str().unwrap(),
        &GitAction::StashPop,
    )
    .await
    .unwrap();
    assert_eq!(
        done,
        GitApplyResult::Failed {
            commands: vec!["git stash pop -q".into()],
            reason: FailReason::NoGit,
            detail: "이 PC에서 git을 찾지 못했습니다.".into(),
        }
    );
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

/// Writes one file into the repository, wherever that is.
type WriteFile<'a> = &'a dyn Fn(&str, &str);

fn sides(entry: &ViewEntry) -> (&str, Option<Change>, Option<Change>) {
    (entry.path.as_str(), entry.index, entry.worktree)
}

async fn listed(host: &GitHost, root: &str) -> Vec<(String, Option<Change>, Option<Change>)> {
    let GitViewResult::Repo { entries, .. } = query(host, root).await.unwrap() else {
        panic!("not a repository");
    };
    let mut found: Vec<_> = entries
        .iter()
        .map(sides)
        .map(|(path, index, worktree)| (path.to_string(), index, worktree))
        .collect();
    found.sort_by(|a, b| a.0.cmp(&b.0));
    found
}

async fn head(host: &GitHost, root: &str) -> (Option<String>, Option<String>) {
    let GitViewResult::Repo { branch, oid, .. } = query(host, root).await.unwrap() else {
        panic!("not a repository");
    };
    (branch, oid)
}

async fn done(host: &GitHost, root: &str, action: GitAction) -> Vec<String> {
    match apply(host, root, &action).await.unwrap() {
        GitApplyResult::Done { commands } => commands,
        other => panic!("{action:?}: {other:?}"),
    }
}

/// Every action against one real repository, each result read back through the Git view's query.
async fn run_scenario(host: &GitHost, root: &str, write: WriteFile<'_>) {
    use Change::*;
    let name = |path: &str| path.to_string();
    write("kept.txt", "a\n");
    write("edit.txt", "a\n");
    write("[a].txt", "a\n");
    write("a.txt", "a\n");
    write("한글 파일.txt", "a\n");
    write("-dash.txt", "a\n");

    // Before the first commit: stage everything, and unstage works without HEAD.
    let shown_stage = done(host, root, GitAction::Stage { paths: None }).await;
    assert_eq!(shown_stage, ["git add -A"]);
    assert_eq!(listed(host, root).await.len(), 6);
    done(host, root, GitAction::Unstage { paths: None }).await;
    assert!(
        listed(host, root)
            .await
            .iter()
            .all(|(_, index, _)| index.is_none())
    );
    done(host, root, GitAction::Stage { paths: None }).await;
    let shown_commit = done(
        host,
        root,
        GitAction::Commit {
            message: "첫 커밋\n\n본문".into(),
            amend: false,
        },
    )
    .await;
    assert_eq!(shown_commit, ["git commit -q -m …"]);
    assert!(listed(host, root).await.is_empty());
    let first = head(host, root).await;
    assert_eq!(first.0.as_deref(), Some("main"));

    // A file's name is read literally: `[a].txt` is not a pattern matching `a.txt`.
    write("[a].txt", "b\n");
    write("a.txt", "b\n");
    write("한글 파일.txt", "b\n");
    write("-dash.txt", "b\n");
    done(
        host,
        root,
        GitAction::Stage {
            paths: Some(paths(&["[a].txt", "한글 파일.txt", "-dash.txt"])),
        },
    )
    .await;
    assert_eq!(
        listed(host, root).await,
        vec![
            (name("-dash.txt"), Some(Modified), None),
            (name("[a].txt"), Some(Modified), None),
            (name("a.txt"), None, Some(Modified)),
            (name("한글 파일.txt"), Some(Modified), None),
        ]
    );
    done(
        host,
        root,
        GitAction::Unstage {
            paths: Some(paths(&["[a].txt", "-dash.txt"])),
        },
    )
    .await;
    assert_eq!(
        listed(host, root).await,
        vec![
            (name("-dash.txt"), None, Some(Modified)),
            (name("[a].txt"), None, Some(Modified)),
            (name("a.txt"), None, Some(Modified)),
            (name("한글 파일.txt"), Some(Modified), None),
        ]
    );

    // Discard goes back to the index: the staged side of a file survives.
    done(
        host,
        root,
        GitAction::Discard {
            paths: paths(&["[a].txt"]),
            untracked: Vec::new(),
        },
    )
    .await;
    assert_eq!(
        listed(host, root).await,
        vec![
            (name("-dash.txt"), None, Some(Modified)),
            (name("a.txt"), None, Some(Modified)),
            (name("한글 파일.txt"), Some(Modified), None),
        ]
    );
    // Longer than before: Git trusts a file with the same size and second as its index entry.
    write("한글 파일.txt", "cccc\n");
    done(
        host,
        root,
        GitAction::Discard {
            paths: paths(&["한글 파일.txt", "-dash.txt"]),
            untracked: Vec::new(),
        },
    )
    .await;
    assert_eq!(
        listed(host, root).await,
        vec![
            (name("a.txt"), None, Some(Modified)),
            (name("한글 파일.txt"), Some(Modified), None),
        ]
    );

    // Deleting an untracked file leaves the one a pattern would also match.
    write("n1.txt", "n\n");
    write("[n]1.txt", "n\n");
    done(
        host,
        root,
        GitAction::Discard {
            paths: Vec::new(),
            untracked: paths(&["[n]1.txt"]),
        },
    )
    .await;
    assert_eq!(
        listed(host, root).await,
        vec![
            (name("a.txt"), None, Some(Modified)),
            (name("n1.txt"), None, Some(Untracked)),
            (name("한글 파일.txt"), Some(Modified), None),
        ]
    );
    done(
        host,
        root,
        GitAction::Discard {
            paths: paths(&["a.txt"]),
            untracked: paths(&["n1.txt"]),
        },
    )
    .await;
    assert_eq!(
        listed(host, root).await,
        vec![(name("한글 파일.txt"), Some(Modified), None)]
    );

    // Amending keeps the message when none is given, and replaces the commit.
    done(
        host,
        root,
        GitAction::Commit {
            message: String::new(),
            amend: true,
        },
    )
    .await;
    assert!(listed(host, root).await.is_empty());
    let amended = head(host, root).await;
    assert_ne!(amended.1, first.1);

    // A branch is made and switched to, and switching back works.
    done(
        host,
        root,
        GitAction::BranchCreate {
            name: "feat/새 작업".replace(' ', "-"),
        },
    )
    .await;
    assert_eq!(head(host, root).await.0.as_deref(), Some("feat/새-작업"));
    done(
        host,
        root,
        GitAction::Checkout {
            branch: "main".into(),
        },
    )
    .await;
    assert_eq!(head(host, root).await.0.as_deref(), Some("main"));

    // Stash takes untracked files only when asked, and pop brings everything back.
    write("kept.txt", "stash\n");
    write("s.txt", "s\n");
    done(
        host,
        root,
        GitAction::StashPush {
            message: "작업 중".into(),
            include_untracked: false,
        },
    )
    .await;
    assert_eq!(
        listed(host, root).await,
        vec![(name("s.txt"), None, Some(Untracked))]
    );
    done(host, root, GitAction::StashPop).await;
    assert_eq!(listed(host, root).await.len(), 2);
    let with = done(
        host,
        root,
        GitAction::StashPush {
            message: String::new(),
            include_untracked: true,
        },
    )
    .await;
    assert_eq!(with, ["git stash push -q --include-untracked"]);
    assert_eq!(listed(host, root).await, vec![]);
    done(host, root, GitAction::StashPop).await;
    assert_eq!(listed(host, root).await.len(), 2);

    // Tags, plain and annotated. Git refuses a second one of the same name in its own words.
    let tag = |name: &str, message: &str| GitAction::Tag {
        name: name.into(),
        message: message.into(),
    };
    done(host, root, tag("v1", "")).await;
    done(host, root, tag("v2", "릴리스")).await;
    let GitApplyResult::Failed { reason, detail, .. } =
        apply(host, root, &tag("v1", "")).await.unwrap()
    else {
        panic!("a second tag v1 was made");
    };
    assert_eq!(reason, FailReason::Git);
    assert!(detail.contains("already exists"), "{detail}");

    // A branch that does not exist says so, and nothing changes.
    let missing = GitAction::Checkout {
        branch: "no-such-branch".into(),
    };
    assert!(matches!(
        apply(host, root, &missing).await.unwrap(),
        GitApplyResult::Failed {
            reason: FailReason::Git,
            ..
        }
    ));
    assert_eq!(head(host, root).await.0.as_deref(), Some("main"));
}

fn native_git(folder: &Path, command: &[&str]) {
    let program = crate::git_credential::git_program().unwrap();
    let done = std::process::Command::new(program)
        .current_dir(folder)
        .args(command)
        .output()
        .unwrap();
    assert!(done.status.success(), "{command:?}: {done:?}");
}

/// A new repository of this PC's git that ignores the user's own hooks and signing settings.
fn native_repo(label: &str) -> (GitHost, PathBuf, String) {
    let program = crate::git_credential::git_program().unwrap();
    let repo = std::env::temp_dir().join(format!(
        "dachsterm-apply-{label}-{} 한글",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&repo);
    std::fs::create_dir_all(&repo).unwrap();
    native_git(&repo, &["init", "-q", "-b", "main"]);
    for (key, value) in [
        ("user.name", "probe"),
        ("user.email", "probe@example.invalid"),
        ("commit.gpgsign", "false"),
        ("tag.gpgsign", "false"),
        ("core.autocrlf", "false"),
        ("core.hooksPath", ".git/hooks"),
    ] {
        native_git(&repo, &["config", key, value]);
    }
    let root = repo.to_str().unwrap().to_string();
    (GitHost::Native(Some(program)), repo, root)
}

fn has_git() -> bool {
    crate::git_credential::git_program().is_some()
}

#[tokio::test]
async fn every_action_on_a_real_repository_of_this_pc() {
    if !has_git() {
        return;
    }
    let (host, repo, root) = native_repo("scenario");
    let write = |name: &str, content: &str| std::fs::write(repo.join(name), content).unwrap();
    // Windows has no file names with `*` or `:`, so `[` is the pattern character tried here.
    run_scenario(&host, &root, &write).await;
    std::fs::remove_dir_all(&repo).unwrap();
}

#[tokio::test]
async fn a_commit_without_an_identity_points_at_the_settings() {
    if !has_git() {
        return;
    }
    let (host, repo, root) = native_repo("identity");
    // Empty values override the user's global name: strict identity checks refuse them.
    native_git(&repo, &["config", "user.name", ""]);
    native_git(&repo, &["config", "user.email", ""]);
    std::fs::write(repo.join("f"), "x").unwrap();
    done(&host, &root, GitAction::Stage { paths: None }).await;
    let result = apply(
        &host,
        &root,
        &GitAction::Commit {
            message: "m".into(),
            amend: false,
        },
    )
    .await
    .unwrap();
    let GitApplyResult::Failed { reason, detail, .. } = result else {
        panic!("{result:?}");
    };
    assert_eq!(reason, FailReason::Identity);
    assert!(!detail.is_empty());
    std::fs::remove_dir_all(&repo).unwrap();
}

fn hook(repo: &Path, script: &str) {
    let path = repo.join(".git").join("hooks").join("pre-commit");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, script).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[tokio::test]
async fn a_failing_hook_shows_its_own_first_line() {
    if !has_git() {
        return;
    }
    let (host, repo, root) = native_repo("hook");
    hook(&repo, "#!/bin/sh\necho 'lint: 3 errors' >&2\nexit 1\n");
    std::fs::write(repo.join("f"), "x").unwrap();
    done(&host, &root, GitAction::Stage { paths: None }).await;
    let commit = GitAction::Commit {
        message: "m".into(),
        amend: false,
    };
    assert_eq!(
        apply(&host, &root, &commit).await.unwrap(),
        GitApplyResult::Failed {
            commands: vec!["git commit -q -m …".into()],
            reason: FailReason::Git,
            detail: "lint: 3 errors".into(),
        }
    );
    std::fs::remove_dir_all(&repo).unwrap();
}

/// `git_run` sets literal pathspecs for itself. A hook's own patterns must keep their meaning.
#[tokio::test]
async fn a_hook_can_still_use_pathspec_magic() {
    if !has_git() {
        return;
    }
    let (host, repo, root) = native_repo("magic");
    hook(
        &repo,
        "#!/bin/sh\ntest -n \"$(git diff --cached --name-only -- ':(top)f')\" || \
         { echo 'pathspec magic is off' >&2; exit 1; }\n",
    );
    std::fs::write(repo.join("f"), "x").unwrap();
    done(&host, &root, GitAction::Stage { paths: None }).await;
    done(
        &host,
        &root,
        GitAction::Commit {
            message: "m".into(),
            amend: false,
        },
    )
    .await;
    assert!(head(&host, &root).await.1.is_some());
    std::fs::remove_dir_all(&repo).unwrap();
}

/// More than the pipe holds and more than the app keeps: the commit must still finish.
#[tokio::test]
async fn a_hook_writing_more_than_is_kept_does_not_stall_the_commit() {
    if !has_git() {
        return;
    }
    let (host, repo, root) = native_repo("noisy");
    hook(
        &repo,
        "#!/bin/sh\ni=0\nwhile [ $i -lt 5000 ]; do\n\
         echo 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' >&2\n\
         i=$((i+1))\ndone\nexit 0\n",
    );
    std::fs::write(repo.join("f"), "x").unwrap();
    done(&host, &root, GitAction::Stage { paths: None }).await;
    let run = done(
        &host,
        &root,
        GitAction::Commit {
            message: "m".into(),
            amend: false,
        },
    );
    tokio::time::timeout(Duration::from_secs(60), run)
        .await
        .expect("the commit stalled on its hook's output");
    assert!(head(&host, &root).await.1.is_some());
    std::fs::remove_dir_all(&repo).unwrap();
}

/// Needs a WSL distribution with git: `DACHSTERM_WSL=<name> cargo test ... -- --ignored`.
#[cfg(windows)]
#[tokio::test]
#[ignore]
async fn every_action_on_a_real_repository_inside_wsl() {
    let name = std::env::var("DACHSTERM_WSL").expect("DACHSTERM_WSL");
    let wsl = PathBuf::from(std::env::var("SystemRoot").unwrap())
        .join("System32")
        .join("wsl.exe");
    let mut target = crate::local::Target::for_test(&format!("wsl:{name}"), "wsl");
    target.program = wsl.clone();
    let folder = format!("/tmp/dachsterm apply {} it's", std::process::id());
    let sh = |script: &str, extra: &[&str]| {
        let mut command = std::process::Command::new(&wsl);
        command.args(["--distribution", &name, "--exec", "sh", "-c", script, "sh"]);
        command.args(extra);
        let done = command.output().unwrap();
        assert!(done.status.success(), "{done:?}");
    };
    sh(
        "rm -rf \"$1\"; mkdir -p \"$1\" && cd \"$1\" && git init -q -b main && \
         git config user.email p@example.invalid && git config user.name p && \
         git config commit.gpgsign false && git config tag.gpgsign false",
        &[&folder],
    );
    let write =
        |file: &str, text: &str| sh("printf '%s' \"$3\" > \"$1/$2\"", &[&folder, file, text]);
    let host = GitHost::local(target).await.unwrap();
    run_scenario(&host, &folder, &write).await;
    sh("rm -rf \"$1\"", &[&folder]);
}
