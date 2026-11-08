use super::parse::{parse_file, parse_list, parse_refs};
use super::*;
use crate::git_status::MAX_ENTRIES;

fn branch(name: &str) -> DiffBase {
    DiffBase::Branch {
        reference: name.into(),
    }
}

#[test]
fn accepts_only_listed_namespaces_and_valid_ref_names() {
    for good in [
        "refs/heads/main",
        "refs/heads/feat/dx6-review",
        "refs/remotes/origin/main",
        "refs/heads/한글",
    ] {
        assert!(check_ref(good).is_ok(), "{good}");
    }
    for bad in [
        "main",
        "HEAD",
        "refs/tags/v1",
        "refs/heads/",
        "refs/heads/a..b",
        "refs/heads/a b",
        "refs/heads/-x y",
        "refs/heads/x@{1}",
        "refs/heads/x.lock",
        "refs/heads/x/",
        "refs/heads/.x",
        "refs/heads/x^",
        "refs/heads/x:y",
        "refs/heads/x\n",
        "refs/heads/$(id)*",
    ] {
        assert!(check_ref(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn keeps_paths_inside_the_root() {
    for good in [
        "a.txt",
        "src/new file.rs",
        "한글/파일.txt",
        "-rf",
        ":(top)x",
    ] {
        assert!(check_path(good).is_ok(), "{good}");
    }
    for bad in ["", "/etc/passwd", "../x", "a/../../x", "a\0b"] {
        assert!(check_path(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn commands_turn_off_programs_and_keep_paths_after_the_separator() {
    let list = list_commands("abc123");
    assert_eq!(list.len(), 3);
    for diff in &list[..2] {
        for needed in [
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "diff.noprefix=false",
        ] {
            assert!(diff.iter().any(|a| a == needed), "{needed}");
        }
        assert_eq!(diff[diff.len() - 3..], ["--end-of-options", "abc123", "--"]);
    }
    assert_eq!(list[2][0], "ls-files");

    let tracked = file_commands("abc", "$(reboot) x", Some("-old"));
    assert_eq!(tracked.len(), 1);
    let tail = &tracked[0][tracked[0].len() - 6..];
    assert_eq!(
        tail,
        [
            "--dst-prefix=b/",
            "--end-of-options",
            "abc",
            "--",
            "-old",
            "$(reboot) x"
        ]
    );
    assert!(tracked[0].iter().any(|a| a == "core.quotePath=false"));

    let untracked = untracked_commands("n.txt");
    assert_eq!(
        untracked[0][untracked[0].len() - 4..],
        ["--no-index", "--", "/dev/null", "n.txt"]
    );
}

#[test]
fn reads_every_kind_of_change_with_counts() {
    let mut out = Vec::new();
    for field in [
        "M",
        "src/main.rs",
        "A",
        "new file.txt",
        "D",
        "gone.txt",
        "R087",
        "old name.txt",
        "새 이름.txt",
        "M",
        "image.png",
        "T",
        "link",
        "",
        "3\t1\tsrc/main.rs",
        "2\t0\tnew file.txt",
        "0\t4\tgone.txt",
        "1\t1\t",
        "old name.txt",
        "새 이름.txt",
        "-\t-\timage.png",
        "1\t1\tlink",
        "",
        "untracked 파일.md",
        "",
    ] {
        out.extend_from_slice(field.as_bytes());
        out.push(0);
    }
    let DiffList::Files { files, truncated } = parse_list(&out[..out.len() - 1]) else {
        panic!("not a list");
    };
    assert!(!truncated);
    let summary: Vec<_> = files
        .iter()
        .map(|f| {
            (
                f.path.as_str(),
                f.old_path.as_deref(),
                f.change,
                f.added,
                f.removed,
                f.binary,
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            (
                "src/main.rs",
                None,
                Change::Modified,
                Some(3),
                Some(1),
                false
            ),
            ("new file.txt", None, Change::Added, Some(2), Some(0), false),
            ("gone.txt", None, Change::Deleted, Some(0), Some(4), false),
            (
                "새 이름.txt",
                Some("old name.txt"),
                Change::Renamed,
                Some(1),
                Some(1),
                false
            ),
            ("image.png", None, Change::Modified, None, None, true),
            ("link", None, Change::TypeChanged, Some(1), Some(1), false),
            (
                "untracked 파일.md",
                None,
                Change::Untracked,
                None,
                None,
                false
            ),
        ]
    );
    assert!(files.iter().all(|f| f.readable));
}

#[test]
fn an_empty_diff_and_a_non_utf8_name() {
    assert_eq!(
        parse_list(b"\0\0"),
        DiffList::Files {
            files: vec![],
            truncated: false
        }
    );
    let DiffList::Files { files, .. } = parse_list(b"\0\0bad\xffname\0") else {
        panic!("not a list");
    };
    assert_eq!(files.len(), 1);
    assert!(!files[0].readable);
    assert_eq!(files[0].path, "bad\u{fffd}name");
}

#[test]
fn stops_at_the_entry_limit() {
    let mut out = b"\0\0".to_vec();
    for n in 0..=MAX_ENTRIES {
        out.extend_from_slice(format!("f{n}\0").as_bytes());
    }
    let DiffList::Files { files, truncated } = parse_list(&out) else {
        panic!("not a list");
    };
    assert_eq!(files.len(), MAX_ENTRIES);
    assert!(truncated);
}

#[test]
fn reads_worktrees_and_refs() {
    let out = b"/srv/app\n\0\
worktree /srv/app\nHEAD 0123\nbranch refs/heads/main\n\n\
worktree /srv/app/.claude/worktrees/fix login\nHEAD 4567\nbranch refs/heads/fix\n\n\
worktree /srv/detached\nHEAD 89ab\ndetached\n\n\
worktree relative\n\n\0\
refs/heads/fix\nrefs/heads/main\nrefs/remotes/origin/HEAD\nrefs/remotes/origin/main\nrefs/heads/bad name\n";
    let refs = parse_refs(out).unwrap();
    assert_eq!(refs.root, "/srv/app");
    assert_eq!(
        refs.worktrees,
        vec![
            Worktree {
                path: "/srv/app".into(),
                branch: Some("refs/heads/main".into())
            },
            Worktree {
                path: "/srv/app/.claude/worktrees/fix login".into(),
                branch: Some("refs/heads/fix".into())
            },
            Worktree {
                path: "/srv/detached".into(),
                branch: None
            },
        ]
    );
    assert_eq!(
        refs.refs,
        vec![
            "refs/heads/fix",
            "refs/heads/main",
            "refs/remotes/origin/main"
        ]
    );
    assert!(parse_refs(b"warning\n\0\0").is_none());
    assert!(parse_refs(b"/r\n\0only two parts").is_none());
    assert_eq!(
        parse_refs(b"C:/repo\n\0worktree C:/repo\nbranch refs/heads/main\n\n\0")
            .unwrap()
            .worktrees[0]
            .path,
        "C:/repo"
    );
    assert!(parse_refs(b"/r\nno separator").is_none());
}

#[test]
fn reads_the_file_header_line() {
    assert_eq!(
        parse_file(b"large 3000000\n"),
        Some(FileDiff::TooLarge {
            size: Some(3_000_000)
        })
    );
    assert_eq!(
        parse_file(b"diff\ndiff --git a/x b/x\n\xff"),
        Some(FileDiff::Text {
            text: "diff --git a/x b/x\n\u{fffd}".into()
        })
    );
    assert_eq!(
        parse_file(b"diff\n"),
        Some(FileDiff::Text { text: "".into() })
    );
    assert!(parse_file(b"rc noise").is_none());
}

#[test]
fn failed_steps_name_their_cause() {
    let out = |exit, stderr: &str| Output {
        stdout: vec![],
        stderr: stderr.into(),
        exit,
    };
    assert_eq!(
        checked(out(Some(128), "fatal: bad\nmore"), "diff를"),
        Err("diff를 읽을 수 없습니다. fatal: bad".into())
    );
    assert_eq!(
        checked(out(Some(2), ""), "diff를"),
        Err("저장소 폴더에 들어갈 수 없습니다.".into())
    );
    assert!(checked(out(Some(0), ""), "diff를").is_ok());
}

#[test]
fn base_is_a_tagged_union() {
    let parsed: DiffBase =
        serde_json::from_str(r#"{"kind":"branch","ref":"refs/heads/main"}"#).unwrap();
    assert_eq!(parsed, branch("refs/heads/main"));
    let parsed: DiffBase = serde_json::from_str(r#"{"kind":"workingTree"}"#).unwrap();
    assert_eq!(parsed, DiffBase::WorkingTree);
}

pub(super) fn git(folder: &std::path::Path, args: &[&str]) {
    let program = crate::git_credential::git_program().unwrap();
    let done = std::process::Command::new(program)
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
    assert!(done.status.success(), "{args:?}: {done:?}");
}

/// This PC's real git, as the diff tab (GE.8) will run it. Skipped where none is installed.
#[tokio::test]
async fn reads_a_real_repository_without_a_shell() {
    let Some(program) = crate::git_credential::git_program() else {
        return;
    };
    let repo = std::env::temp_dir().join(format!("dachsterm-diff-{} 한글", std::process::id()));
    std::fs::create_dir_all(&repo).unwrap();
    let root = repo.to_str().unwrap().replace('\\', "/");
    let host = GitHost::Native(Some(program));
    git(&repo, &["init", "-q", "-b", "main"]);
    std::fs::write(repo.join("tracked.txt"), "a\n").unwrap();

    // Before the first commit the base is the empty tree.
    let DiffList::Files { files, .. } = list(&host, &root, &DiffBase::WorkingTree).await.unwrap()
    else {
        panic!("stopped");
    };
    assert_eq!(
        files.iter().map(|f| f.change).collect::<Vec<_>>(),
        vec![Change::Untracked]
    );

    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    git(&repo, &["branch", "base"]);
    std::fs::write(repo.join("tracked.txt"), "a\nb\n").unwrap();
    std::fs::write(repo.join("새 파일.txt"), "u\n").unwrap();
    std::fs::write(repo.join("big.log"), vec![b'x'; MAX_FILE as usize + 1]).unwrap();

    let found = refs(&host, &root).await.unwrap();
    assert_eq!(found.refs, vec!["refs/heads/base", "refs/heads/main"]);
    assert_eq!(
        found.worktrees[0].branch.as_deref(),
        Some("refs/heads/main")
    );

    let base = DiffBase::Branch {
        reference: "refs/heads/base".into(),
    };
    let DiffList::Files { files, .. } = list(&host, &root, &base).await.unwrap() else {
        panic!("stopped");
    };
    let mut changed: Vec<_> = files
        .iter()
        .map(|f| (f.path.as_str(), f.change, f.added))
        .collect();
    changed.sort_by_key(|f| f.0.to_string());
    assert_eq!(
        changed,
        vec![
            ("big.log", Change::Untracked, None),
            ("tracked.txt", Change::Modified, Some(1)),
            ("새 파일.txt", Change::Untracked, None),
        ]
    );

    let working_tree = DiffBase::WorkingTree;
    let request = |path, untracked| FileRequest {
        root: &root,
        base: &working_tree,
        path,
        old_path: None,
        untracked,
    };
    let FileDiff::Text { text } = file(&host, request("tracked.txt", false)).await.unwrap() else {
        panic!("not text");
    };
    assert!(
        text.contains("--- a/tracked.txt\n+++ b/tracked.txt\n"),
        "{text}"
    );
    let FileDiff::Text { text } = file(&host, request("새 파일.txt", true)).await.unwrap()
    else {
        panic!("not text");
    };
    assert!(
        text.contains("+++ b/새 파일.txt") && text.contains("\n+u\n"),
        "{text}"
    );
    assert_eq!(
        file(&host, request("big.log", true)).await.unwrap(),
        FileDiff::TooLarge {
            size: Some(MAX_FILE + 1)
        }
    );
    let missing = DiffBase::Branch {
        reference: "refs/heads/nope".into(),
    };
    assert_eq!(
        list(&host, &root, &missing).await.err().as_deref(),
        Some("비교할 브랜치를 찾을 수 없습니다. 목록을 새로 고치세요.")
    );
    std::fs::remove_dir_all(&repo).unwrap();
}
