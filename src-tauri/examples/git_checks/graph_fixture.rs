//! One commit history built the same way on every kind of host, and what its graph must read as
//! (GE.14). Dates are fixed, so Git's order does not depend on how fast the steps ran. Shared by
//! the unit tests (this PC, WSL) and the OpenSSH check.
#![allow(dead_code)]
use super::{GraphCommit, RefKind};
use std::collections::HashMap;

pub const ENV: [(&str, &str); 6] = [
    ("GIT_AUTHOR_NAME", "그래프"),
    ("GIT_AUTHOR_EMAIL", "graph@example.invalid"),
    ("GIT_AUTHOR_DATE", "1700000000 +0000"),
    ("GIT_COMMITTER_NAME", "그래프"),
    ("GIT_COMMITTER_EMAIL", "graph@example.invalid"),
    ("GIT_COMMITTER_DATE", "1700000000 +0000"),
];

/// A branch merged back into `main`, a tag, and an upstream with one commit `main` lacks.
pub const STEPS: &[&[&str]] = &[
    &["init", "-q"],
    &["checkout", "-q", "-b", "main"],
    &["commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "c1"],
    &["commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "c2"],
    &["checkout", "-q", "-b", "feature"],
    &["commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "f1"],
    &[
        "commit",
        "-q",
        "--allow-empty",
        "--no-gpg-sign",
        "-m",
        "f2 한글",
    ],
    &["tag", "v1"],
    &["checkout", "-q", "main"],
    &["commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "c3"],
    &[
        "merge",
        "-q",
        "--no-ff",
        "--no-gpg-sign",
        "-m",
        "merge feature",
        "feature",
    ],
    &["checkout", "-q", "-b", "elsewhere", "HEAD~1"],
    &["commit", "-q", "--allow-empty", "--no-gpg-sign", "-m", "u1"],
    &["update-ref", "refs/remotes/origin/main", "HEAD"],
    &["checkout", "-q", "main"],
    &["branch", "-q", "-D", "elsewhere"],
    &["config", "remote.origin.url", "/nonexistent"],
    &[
        "config",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/*",
    ],
    &["config", "branch.main.remote", "origin"],
    &["config", "branch.main.merge", "refs/heads/main"],
];

/// Subject, the subjects of its parents, and its references, newest first.
pub type Row = (String, Vec<String>, Vec<String>);

pub fn expected() -> Vec<Row> {
    let row = |subject: &str, parents: &[&str], refs: &[&str]| -> Row {
        (
            subject.to_string(),
            parents.iter().map(|p| p.to_string()).collect(),
            refs.iter().map(|r| r.to_string()).collect(),
        )
    };
    vec![
        row("merge feature", &["c3", "f2 한글"], &["*branch main"]),
        row("f2 한글", &["f1"], &["tag v1", "branch feature"]),
        row("f1", &["c2"], &[]),
        row("u1", &["c3"], &["remote origin/main"]),
        row("c3", &["c2"], &[]),
        row("c2", &["c1"], &[]),
        row("c1", &[], &[]),
    ]
}

/// Subjects stand in for hashes, so a history is comparable between hosts.
pub fn rows(commits: &[GraphCommit]) -> Vec<Row> {
    let subject: HashMap<&str, &str> = commits
        .iter()
        .map(|commit| (commit.hash.as_str(), commit.subject.as_str()))
        .collect();
    commits
        .iter()
        .map(|commit| {
            let refs = commit.refs.iter().map(|item| {
                let kind = match item.kind {
                    RefKind::Head => "head",
                    RefKind::Branch => "branch",
                    RefKind::Remote => "remote",
                    RefKind::Tag => "tag",
                };
                format!(
                    "{}{kind} {}",
                    if item.current { "*" } else { "" },
                    item.name
                )
            });
            (
                commit.subject.clone(),
                commit
                    .parents
                    .iter()
                    .map(|parent| subject[parent.as_str()].to_string())
                    .collect(),
                refs.collect(),
            )
        })
        .collect()
}

pub fn single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// The steps as one `sh` script, for hosts where commands run through a shell.
pub fn shell_setup(folder: &str) -> String {
    let env: Vec<String> = ENV
        .iter()
        .map(|(key, value)| format!("export {key}={}", single_quote(value)))
        .collect();
    let steps: Vec<String> = STEPS
        .iter()
        .map(|step| {
            let words: Vec<String> = step.iter().map(|word| single_quote(word)).collect();
            format!("git {}", words.join(" "))
        })
        .collect();
    format!(
        "set -e\nmkdir -p {folder}\ncd {folder}\n{}\n{}\n",
        env.join("\n"),
        steps.join("\n"),
        folder = single_quote(folder)
    )
}

/// A linear history of `count` commits on `big`, as `git fast-import` input.
pub fn big_history(count: usize) -> String {
    (0..count)
        .map(|at| {
            format!(
                "commit refs/heads/big\ncommitter p <p@example.invalid> {} +0000\ndata 1\nx\n\n",
                1_700_000_000 + at
            )
        })
        .collect()
}

/// The same history made by a shell. An exec's argument is too short to hold all of it.
pub fn shell_big_history(folder: &str, count: usize) -> String {
    format!(
        "set -e\nmkdir -p {folder}\ncd {folder}\ngit init -q\ni=0\nwhile [ \"$i\" -lt {count} ]; do \
         i=$((i+1)); printf 'commit refs/heads/big\\ncommitter p <p@example.invalid> %s +0000\\n\
         data 1\\nx\\n\\n' $((1700000000+i)); done | git fast-import --quiet\n\
         git symbolic-ref HEAD refs/heads/big\n",
        folder = single_quote(folder)
    )
}
