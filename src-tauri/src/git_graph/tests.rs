use super::*;
use crate::git_diff::Change;
use std::{io::Write, path::Path, process::Stdio};

#[path = "../../examples/git_checks/graph_fixture.rs"]
mod fixture;

const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccc";

fn output(stdout: &[u8], stderr: &str, exit: u32) -> Output {
    Output {
        stdout: stdout.to_vec(),
        stderr: stderr.as_bytes().to_vec(),
        exit: Some(exit),
    }
}

fn native() -> GitHost {
    GitHost::Native(Some("git".into()))
}

#[test]
fn only_a_full_object_name_is_a_hash() {
    assert!(check_hash(HASH_A).is_ok());
    assert!(check_hash(&"a".repeat(64)).is_ok());
    for bad in [
        "",
        "HEAD",
        "abc1234",
        "--all",
        &"A".repeat(40),
        &format!("-{}", "a".repeat(39)),
        &format!("{}\n", "a".repeat(39)),
    ] {
        assert!(check_hash(bad).is_err(), "{bad:?}");
    }
}

#[test]
fn the_log_command_cannot_start_a_signature_program_or_be_reformatted() {
    let command = graph_command(100, &["HEAD".into(), "refs/remotes/origin/main".into()]);
    for needed in [
        "--no-show-signature",
        "--no-color",
        "--encoding=UTF-8",
        "--topo-order",
        "--decorate=full",
        "--max-count=101",
    ] {
        assert!(command.iter().any(|arg| arg == needed), "{needed}");
    }
    // Start points come last, closed by `--`.
    assert_eq!(
        command[command.len() - 3..],
        ["HEAD", "refs/remotes/origin/main", "--"]
    );
    let files = files_command(Some(HASH_A), HASH_B);
    for needed in ["--no-ext-diff", "--no-textconv", "--name-status"] {
        assert!(files.iter().any(|arg| arg == needed), "{needed}");
    }
    assert_eq!(files[files.len() - 3..], [HASH_A, HASH_B, "--"]);
    assert!(
        files_command(None, HASH_B)
            .iter()
            .any(|arg| arg == "--root")
    );
}

fn start(
    stdout: &[u8],
    stderr: &str,
    exit: u32,
) -> std::result::Result<Vec<String>, GitGraphResult> {
    start_points(&native(), &output(stdout, stderr, exit))
}

#[test]
fn walks_head_and_its_upstream_or_says_why_it_cannot() {
    assert_eq!(
        start(b"abc\n\0refs/remotes/origin/main\n", "", 0),
        Ok(vec!["HEAD".into(), "refs/remotes/origin/main".into()])
    );
    // No upstream, or a detached HEAD: the second command failed after the first passed.
    assert_eq!(
        start(b"abc\n\0", "fatal: no upstream", 128),
        Ok(vec!["HEAD".into()])
    );
    assert_eq!(start(b"", "", 1), Err(GitGraphResult::Empty));
    assert_eq!(
        start(b"", "fatal: not a git repository", 128),
        Err(GitGraphResult::NotRepo {
            detail: "fatal: not a git repository".into()
        })
    );
    assert!(matches!(
        start(b"", "sh: git: not found", 127),
        Err(GitGraphResult::NoGit { .. })
    ));
    // Anything but a full ref name is left out rather than passed on.
    assert_eq!(start(b"abc\n\0--all\n", "", 0), Ok(vec!["HEAD".into()]));
    assert_eq!(start(b"abc\n\0refs/\xff\n", "", 0), Ok(vec!["HEAD".into()]));
}

#[test]
fn reads_every_kind_of_reference() {
    let reference = |kind, name: &str, current| GraphRef {
        kind,
        name: name.into(),
        current,
    };
    assert_eq!(parse_refs(b""), vec![]);
    assert_eq!(
        parse_refs(
            b"HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main, \
              refs/remotes/origin/HEAD, refs/heads/a,b, refs/stash"
        ),
        vec![
            reference(RefKind::Branch, "main", true),
            reference(RefKind::Tag, "v1", false),
            reference(RefKind::Remote, "origin/main", false),
            reference(RefKind::Branch, "a,b", false),
        ]
    );
    assert_eq!(
        parse_refs(b"HEAD, refs/heads/x"),
        vec![
            reference(RefKind::Head, "HEAD", true),
            reference(RefKind::Branch, "x", false),
        ]
    );
}

fn log_record(hash: &str, parents: &str, decoration: &str, subject: &str) -> String {
    format!("{hash}\0{parents}\0작성자\01700000000\0{decoration}\0{subject}\0\n")
}

#[test]
fn reads_records_and_tells_whether_older_commits_exist() {
    let stdout = [
        log_record(
            HASH_A,
            &format!("{HASH_B} {HASH_C}"),
            "HEAD -> refs/heads/m",
            "merge",
        ),
        log_record(HASH_B, HASH_C, "", "제목, with comma"),
        log_record(HASH_C, "", "", "root"),
    ]
    .concat();
    let Some(GitGraphResult::Graph { commits, has_more }) = parse_log(stdout.as_bytes(), 2) else {
        panic!("not read");
    };
    assert!(has_more);
    assert_eq!(commits.len(), 2);
    assert_eq!(commits[0].parents, vec![HASH_B, HASH_C]);
    assert_eq!(commits[0].author, "작성자");
    assert_eq!(commits[0].time, 1_700_000_000);
    assert_eq!(commits[1].subject, "제목, with comma");
    let Some(GitGraphResult::Graph { commits, has_more }) = parse_log(stdout.as_bytes(), 3) else {
        panic!("not read");
    };
    assert!(!has_more);
    assert!(commits[2].parents.is_empty());
}

#[test]
fn output_it_cannot_trust_is_an_error_and_a_broken_date_is_not() {
    assert_eq!(
        parse_log(log_record("xyz", "", "", "s").as_bytes(), 1),
        None
    );
    let stdout = format!("{HASH_A}\0\0a\0not-a-date\0\0s\0\n");
    let Some(GitGraphResult::Graph { commits, .. }) = parse_log(stdout.as_bytes(), 1) else {
        panic!("not read");
    };
    assert_eq!(commits[0].time, 0);
}

#[test]
fn serializes_for_the_window() {
    let result = GitGraphResult::Graph {
        commits: vec![],
        has_more: true,
    };
    assert_eq!(
        serde_json::to_string(&result).unwrap(),
        r#"{"kind":"graph","commits":[],"hasMore":true}"#
    );
    assert_eq!(
        serde_json::to_string(&GitGraphResult::Empty).unwrap(),
        r#"{"kind":"empty"}"#
    );
}

fn git_at(repo: &Path, step: &[&str]) {
    let program = crate::git_credential::git_program().unwrap();
    let done = std::process::Command::new(program)
        .current_dir(repo)
        .envs(fixture::ENV)
        .args(step)
        .output()
        .unwrap();
    assert!(done.status.success(), "{step:?}: {done:?}");
}

fn repository(name: &str) -> std::path::PathBuf {
    let repo = std::env::temp_dir().join(format!("dachsterm-{name}-{} 한글", std::process::id()));
    let _ = std::fs::remove_dir_all(&repo);
    std::fs::create_dir_all(&repo).unwrap();
    repo
}

#[tokio::test]
async fn reads_a_real_history_with_a_merge_a_tag_and_an_upstream() {
    let Some(program) = crate::git_credential::git_program() else {
        return;
    };
    let repo = repository("graph");
    for step in fixture::STEPS {
        git_at(&repo, step);
    }
    let host = GitHost::Native(Some(program));
    let folder = repo.to_str().unwrap();
    let GitGraphResult::Graph { commits, has_more } = query(&host, folder, 100).await.unwrap()
    else {
        panic!("not a graph");
    };
    assert!(!has_more);
    assert_eq!(fixture::rows(&commits), fixture::expected());

    // The merge lists its files against the first parent, and a root commit against nothing.
    let merge = detail(&host, folder, &commits[0].hash).await.unwrap();
    assert_eq!(merge.message, "merge feature");
    assert_eq!(merge.parents.len(), 2);
    assert_eq!(merge.author, "그래프");
    std::fs::remove_dir_all(&repo).unwrap();
}

#[tokio::test]
async fn a_commit_lists_its_files_against_its_first_parent() {
    let Some(program) = crate::git_credential::git_program() else {
        return;
    };
    let repo = repository("graph-files");
    git_at(&repo, &["init", "-q"]);
    git_at(&repo, &["checkout", "-q", "-b", "main"]);
    std::fs::write(repo.join("old name.txt"), "same text in both\n").unwrap();
    std::fs::write(repo.join("gone.txt"), "x\n").unwrap();
    git_at(&repo, &["add", "."]);
    git_at(&repo, &["commit", "-q", "--no-gpg-sign", "-m", "root"]);
    git_at(&repo, &["mv", "old name.txt", "새 이름.txt"]);
    git_at(&repo, &["rm", "-q", "gone.txt"]);
    std::fs::write(repo.join("added.txt"), "y\n").unwrap();
    git_at(&repo, &["add", "."]);
    git_at(
        &repo,
        &["commit", "-q", "--no-gpg-sign", "-m", "제목\n\n본문 줄"],
    );

    let host = GitHost::Native(Some(program));
    let folder = repo.to_str().unwrap();
    let GitGraphResult::Graph { commits, .. } = query(&host, folder, 10).await.unwrap() else {
        panic!("not a graph");
    };
    assert_eq!(commits[0].subject, "제목");
    let changed = detail(&host, folder, &commits[0].hash).await.unwrap();
    assert_eq!(changed.message, "제목\n\n본문 줄");
    assert!(!changed.truncated);
    let mut files: Vec<_> = changed
        .files
        .iter()
        .map(|file| (file.path.as_str(), file.old_path.as_deref(), file.change))
        .collect();
    files.sort_by_key(|(path, ..)| path.to_string());
    assert_eq!(
        files,
        vec![
            ("added.txt", None, Change::Added),
            ("gone.txt", None, Change::Deleted),
            ("새 이름.txt", Some("old name.txt"), Change::Renamed),
        ]
    );

    let root = detail(&host, folder, &commits[1].hash).await.unwrap();
    assert!(root.parents.is_empty());
    let mut names: Vec<_> = root.files.iter().map(|file| file.path.as_str()).collect();
    names.sort();
    assert_eq!(names, vec!["gone.txt", "old name.txt"]);
    std::fs::remove_dir_all(&repo).unwrap();
}

#[tokio::test]
async fn a_long_history_stops_at_the_limit_and_says_so() {
    let Some(program) = crate::git_credential::git_program() else {
        return;
    };
    let repo = repository("graph-big");
    git_at(&repo, &["init", "-q"]);
    let mut import = std::process::Command::new(&program)
        .current_dir(&repo)
        .args(["fast-import", "--quiet"])
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    import
        .stdin
        .take()
        .unwrap()
        .write_all(fixture::big_history(MAX_COMMITS + 50).as_bytes())
        .unwrap();
    assert!(import.wait().unwrap().success());
    git_at(&repo, &["symbolic-ref", "HEAD", "refs/heads/big"]);

    let host = GitHost::Native(Some(program));
    let folder = repo.to_str().unwrap();
    for (asked, shown, more) in [
        (1, 1, true),
        (100, 100, true),
        (MAX_COMMITS, MAX_COMMITS, true),
        // The window cannot ask for more than the limit.
        (MAX_COMMITS * 5, MAX_COMMITS, true),
        (0, 1, true),
    ] {
        let GitGraphResult::Graph { commits, has_more } =
            query(&host, folder, asked).await.unwrap()
        else {
            panic!("not a graph");
        };
        assert_eq!((commits.len(), has_more), (shown, more), "{asked}");
    }
    std::fs::remove_dir_all(&repo).unwrap();
}

#[tokio::test]
async fn a_repository_before_its_first_commit_is_empty() {
    let Some(program) = crate::git_credential::git_program() else {
        return;
    };
    let repo = repository("graph-empty");
    git_at(&repo, &["init", "-q"]);
    let host = GitHost::Native(Some(program));
    assert_eq!(
        query(&host, repo.to_str().unwrap(), 10).await.unwrap(),
        GitGraphResult::Empty
    );
    std::fs::remove_dir_all(&repo).unwrap();
}

#[tokio::test]
async fn a_folder_outside_a_repository_is_told_apart() {
    let Some(program) = crate::git_credential::git_program() else {
        return;
    };
    let folder = repository("graph-none");
    let host = GitHost::Native(Some(program));
    let spelled = folder.to_str().unwrap();
    assert!(matches!(
        query(&host, spelled, 10).await.unwrap(),
        GitGraphResult::NotRepo { .. }
    ));
    assert!(matches!(
        query(&GitHost::Native(None), spelled, 10).await.unwrap(),
        GitGraphResult::NoGit { .. }
    ));
    std::fs::remove_dir_all(&folder).unwrap();
}

/// A repository's `log.showSignature` and `gpg.program` must not run for a signed-looking commit.
#[tokio::test]
async fn a_repositorys_signature_program_does_not_run() {
    let Some(program) = crate::git_credential::git_program() else {
        return;
    };
    let repo = repository("graph-gpg");
    git_at(&repo, &["init", "-q"]);
    git_at(&repo, &["checkout", "-q", "-b", "main"]);
    git_at(
        &repo,
        &["commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "c"],
    );
    // A commit carrying a signature header, made without a signing program.
    let head = std::process::Command::new(&program)
        .current_dir(&repo)
        .args(["cat-file", "commit", "HEAD"])
        .output()
        .unwrap();
    let raw = String::from_utf8(head.stdout).unwrap();
    let signed = raw.replacen(
        "\n\n",
        "\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n abc\n -----END PGP SIGNATURE-----\n\n",
        1,
    );
    let mut hash = std::process::Command::new(&program)
        .current_dir(&repo)
        .args(["hash-object", "-t", "commit", "-w", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    hash.stdin
        .take()
        .unwrap()
        .write_all(signed.as_bytes())
        .unwrap();
    let id = String::from_utf8(hash.wait_with_output().unwrap().stdout).unwrap();
    git_at(&repo, &["update-ref", "refs/heads/main", id.trim()]);

    let marker = repo.join("gpg-ran");
    let script = repo.join("fake-gpg.sh");
    std::fs::write(
        &script,
        format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    )
    .unwrap();
    git_at(&repo, &["config", "log.showSignature", "true"]);
    git_at(&repo, &["config", "gpg.program", script.to_str().unwrap()]);

    // A plain `git log` does run it here, so the checks below would catch it.
    let plain = std::process::Command::new(&program)
        .current_dir(&repo)
        .args(["log", "-1", "--format=%s"])
        .output()
        .unwrap();
    assert!(plain.status.success(), "{plain:?}");
    assert!(
        marker.exists(),
        "the fixture's signature program did not run"
    );
    std::fs::remove_file(&marker).unwrap();

    let host = GitHost::Native(Some(program.clone()));
    let GitGraphResult::Graph { commits, .. } =
        query(&host, repo.to_str().unwrap(), 10).await.unwrap()
    else {
        panic!("not a graph");
    };
    assert_eq!(commits[0].subject, "c");
    assert!(!marker.exists(), "the repository's signature program ran");
    detail(&host, repo.to_str().unwrap(), &commits[0].hash)
        .await
        .unwrap();
    assert!(!marker.exists(), "the repository's signature program ran");
    std::fs::remove_dir_all(&repo).unwrap();
}

/// Needs a WSL distribution with git: `DACHSTERM_WSL=<name> cargo test ... -- --ignored`.
#[cfg(windows)]
#[tokio::test]
#[ignore]
async fn wsl_reads_the_same_graph_and_stops_at_the_limit() {
    let name = std::env::var("DACHSTERM_WSL").expect("DACHSTERM_WSL");
    let wsl = std::path::PathBuf::from(std::env::var("SystemRoot").unwrap())
        .join("System32")
        .join("wsl.exe");
    let run = |script: &str| {
        let done = std::process::Command::new(&wsl)
            .args(["--distribution", &name, "--exec", "sh", "-c", script])
            .output()
            .unwrap();
        assert!(done.status.success(), "{done:?}");
    };
    let id = std::process::id();
    let folder = format!("/tmp/dachsterm graph {id} it's");
    let big = format!("/tmp/dachsterm-graph-big-{id}");
    run(&fixture::shell_setup(&folder));
    run(&fixture::shell_big_history(&big, MAX_COMMITS + 50));

    let mut target = crate::local::Target::for_test(&format!("wsl:{name}"), "wsl");
    target.program = wsl.clone();
    let host = GitHost::local(target).await.unwrap();
    let GitGraphResult::Graph { commits, has_more } = query(&host, &folder, 100).await.unwrap()
    else {
        panic!("not a graph");
    };
    assert!(!has_more);
    assert_eq!(fixture::rows(&commits), fixture::expected());
    let merge = detail(&host, &folder, &commits[0].hash).await.unwrap();
    assert_eq!(merge.parents.len(), 2);

    let GitGraphResult::Graph { commits, has_more } =
        query(&host, &big, MAX_COMMITS).await.unwrap()
    else {
        panic!("not a graph");
    };
    assert_eq!((commits.len(), has_more), (MAX_COMMITS, true));

    run(&format!(
        "rm -rf {} {}",
        fixture::single_quote(&folder),
        fixture::single_quote(&big)
    ));
}
