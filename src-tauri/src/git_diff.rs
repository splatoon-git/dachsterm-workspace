//! Read-only diff of a remote repository for the review tab (DX.6). It runs Git with the same
//! program-free prefix as the status query, and adds the switches that keep a repository's own
//! settings from starting a program (external diff, textconv) or changing the format the app
//! parses (prefixes, colour, relative paths). Diff text is returned to the window only and never
//! logged.
use crate::{
    AppState,
    git_status::{MAX_ENTRIES, SAFE_GIT, StopReason, check_folder, first_line},
    remote_exec::{self, Failure, Limits, Output, quote},
    ssh::Connections,
    storage::Result,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};

const TIMEOUT: Duration = Duration::from_secs(10);
/// Three NUL-separated listings of at most `MAX_ENTRIES` paths each.
const MAX_LIST_OUTPUT: usize = 8 * 1024 * 1024;
/// A file larger than this is not shown. The diff of one may hold both sides.
pub const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_FILE_OUTPUT: usize = 2 * MAX_FILE as usize + 64 * 1024;
const MAX_REFS_OUTPUT: usize = 1024 * 1024;
pub const MAX_REFS: usize = 2000;
const MAX_PATH: usize = 4096;

/// Pathspecs are read literally, so a file named `:(top)*` is that file and not a pattern.
fn git() -> String {
    format!("GIT_LITERAL_PATHSPECS=1 {SAFE_GIT}")
}
/// After `git()`. User settings cannot move the `a/`, `b/` prefixes or colour the output, and no
/// repository setting runs a diff or textconv program. Header paths stay readable: by default Git
/// writes a non-ASCII name such as a Korean one as quoted octal escapes.
const DIFF: &str = "-c diff.noprefix=false -c diff.mnemonicPrefix=false -c diff.relative=false \
     -c core.quotePath=false diff --no-ext-diff --no-textconv --no-color --find-renames";

/// What the working tree is compared with.
#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffBase {
    /// HEAD, or the empty tree before the first commit.
    WorkingTree,
    /// The merge base of HEAD and a branch from `git_refs`.
    Branch {
        #[serde(rename = "ref")]
        reference: String,
    },
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    /// The checked-out branch as a full ref, or `None` when detached or bare.
    pub branch: Option<String>,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRefs {
    pub root: String,
    pub worktrees: Vec<Worktree>,
    /// Full names under `refs/heads/` and `refs/remotes/`.
    pub refs: Vec<String>,
    pub truncated: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum Change {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Conflict,
    Untracked,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    pub old_path: Option<String>,
    pub change: Change,
    /// Line counts, or `None` for a binary or untracked file.
    pub added: Option<u32>,
    pub removed: Option<u32>,
    pub binary: bool,
    /// The name is valid UTF-8. Other names are shown with replacement characters and cannot be
    /// asked for, since the shown name is not the real one.
    pub readable: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffList {
    Files {
        files: Vec<DiffFile>,
        truncated: bool,
    },
    Stopped {
        reason: StopReason,
    },
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileDiff {
    /// Unified diff text with `a/`, `b/` prefixes, converted lossily to UTF-8.
    Text {
        text: String,
    },
    /// Over `MAX_FILE`, with the working tree size when it was the reason.
    TooLarge {
        size: Option<u64>,
    },
    TimedOut,
}

/// Only names under the two namespaces the app lists, with nothing a ref name may not contain
/// (git-check-ref-format). The script then checks the ref exists before using it.
fn check_ref(reference: &str) -> Result<()> {
    let name = reference
        .strip_prefix("refs/heads/")
        .or_else(|| reference.strip_prefix("refs/remotes/"));
    let valid = name.is_some_and(|name| {
        !name.is_empty()
            && reference.len() <= 1024
            && !name.chars().any(|c| {
                c.is_control() || matches!(c, ' ' | '~' | '^' | ':' | '?' | '*' | '[' | '\\')
            })
            && !reference.contains("..")
            && !reference.contains("@{")
            && !reference.contains("//")
            && !reference.ends_with('/')
            && !reference.ends_with('.')
            && !reference.ends_with(".lock")
            && !reference.contains("/.")
    });
    if !valid {
        return Err("비교할 브랜치 이름이 올바르지 않습니다.".into());
    }
    Ok(())
}

/// A path the file list gave, relative to the root and staying inside it.
fn check_path(path: &str) -> Result<()> {
    let valid = !path.is_empty()
        && path.len() <= MAX_PATH
        && !path.starts_with('/')
        && !path.contains('\0')
        && path.split('/').all(|part| part != "..");
    if !valid {
        return Err("diff를 볼 파일 경로가 올바르지 않습니다.".into());
    }
    Ok(())
}

/// Enters the root and sets `$B` to the commit or tree the working tree is compared with.
fn base_script(root: &str, base: &DiffBase) -> String {
    let git = git();
    let enter = format!("cd -- {} || exit 2\n", quote(root));
    match base {
        DiffBase::WorkingTree => format!(
            "{enter}B=$({git} rev-parse --verify -q 'HEAD^{{commit}}') || \
             B=$({git} hash-object -t tree /dev/null) || exit 3\n"
        ),
        DiffBase::Branch { reference } => {
            let reference = quote(reference);
            format!(
                "{enter}{git} show-ref --verify -q --end-of-options {reference} || exit 3\n\
                 B=$({git} merge-base --end-of-options HEAD {reference}) || exit 3\n"
            )
        }
    }
}

pub fn list_script(root: &str, base: &DiffBase) -> String {
    let git = git();
    format!(
        "{}{git} {DIFF} --name-status -z --end-of-options \"$B\" -- && printf '\\000' && \
         {git} {DIFF} --numstat -z --end-of-options \"$B\" -- && printf '\\000' && \
         {git} ls-files --others --exclude-standard -z",
        base_script(root, base)
    )
}

pub fn file_script(
    root: &str,
    base: &DiffBase,
    path: &str,
    old_path: Option<&str>,
    untracked: bool,
) -> String {
    let git = git();
    let target = quote(path);
    // The working tree file's size decides before any diff runs. A deleted file has none.
    let size = format!(
        "S=$(wc -c < {target} 2>/dev/null | tr -d ' ')\n\
         case $S in ''|*[!0-9]*) ;; *) if [ \"$S\" -gt {MAX_FILE} ]; then \
         printf 'large %s\\n' \"$S\"; exit 0; fi ;; esac\nprintf 'diff\\n'\n"
    );
    let prefixes = "--src-prefix=a/ --dst-prefix=b/";
    if untracked {
        // `--no-index` exits 1 when the two sides differ, which they always do here.
        return format!(
            "cd -- {} || exit 2\n{size}{git} {DIFF} {prefixes} --no-index -- /dev/null {target}\n\
             c=$?; [ $c -le 1 ] || exit $c",
            quote(root)
        );
    }
    let paths = match old_path {
        Some(old) => format!("{} {target}", quote(old)),
        None => target,
    };
    format!(
        "{}{size}{git} {DIFF} {prefixes} --end-of-options \"$B\" -- {paths}",
        base_script(root, base)
    )
}

pub fn refs_script(folder: &str) -> String {
    let git = git();
    format!(
        "cd -- {} || exit 2\n{git} rev-parse --show-toplevel && {git} worktree list --porcelain \
         && printf '\\000' && {git} for-each-ref --format='%(refname)' refs/heads refs/remotes",
        quote(folder)
    )
}

fn text(bytes: &[u8]) -> (String, bool) {
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_string(), true),
        Err(_) => (String::from_utf8_lossy(bytes).into_owned(), false),
    }
}

/// `rev-parse --show-toplevel`, `worktree list --porcelain`, NUL, then one ref per line.
fn parse_refs(stdout: &[u8]) -> Option<GitRefs> {
    let newline = stdout.iter().position(|b| *b == b'\n')?;
    let root = String::from_utf8(stdout[..newline].to_vec()).ok()?;
    if !root.starts_with('/') {
        return None;
    }
    let rest = &stdout[newline + 1..];
    let split = rest.iter().position(|b| *b == 0)?;
    let mut worktrees = Vec::new();
    for record in String::from_utf8_lossy(&rest[..split]).split("\n\n") {
        let mut lines = record.lines();
        let Some(path) = lines.next().and_then(|l| l.strip_prefix("worktree ")) else {
            continue;
        };
        // A lossy path is not the real one, so it cannot be offered.
        if !path.starts_with('/') || path.contains('\u{fffd}') {
            continue;
        }
        let branch = lines.find_map(|l| l.strip_prefix("branch ").map(str::to_string));
        worktrees.push(Worktree {
            path: path.to_string(),
            branch,
        });
    }
    let mut refs = Vec::new();
    let mut truncated = false;
    for line in String::from_utf8_lossy(&rest[split + 1..]).lines() {
        if line.ends_with("/HEAD") || check_ref(line).is_err() {
            continue;
        }
        if refs.len() == MAX_REFS {
            truncated = true;
            break;
        }
        refs.push(line.to_string());
    }
    Some(GitRefs {
        root,
        worktrees,
        refs,
        truncated,
    })
}

fn change(status: &[u8]) -> Option<Change> {
    Some(match status.first()? {
        b'M' => Change::Modified,
        b'A' => Change::Added,
        b'D' => Change::Deleted,
        b'R' => Change::Renamed,
        b'C' => Change::Copied,
        b'T' => Change::TypeChanged,
        b'U' => Change::Conflict,
        _ => return None,
    })
}

/// Fields up to the empty one that ends a section, and the rest after it.
fn section(fields: &mut std::slice::Iter<'_, &[u8]>) -> Vec<Vec<u8>> {
    fields
        .take_while(|field| !field.is_empty())
        .map(|field| field.to_vec())
        .collect()
}

/// `--name-status -z`, NUL, `--numstat -z`, NUL, `ls-files --others -z`.
fn parse_list(stdout: &[u8]) -> DiffList {
    let all: Vec<&[u8]> = stdout.split(|b| *b == 0).collect();
    let mut fields = all.iter();
    let names = section(&mut fields);
    let counts = section(&mut fields);
    let untracked = section(&mut fields);

    // numstat: "added\tremoved\tpath", or "added\tremoved\t" followed by the old and new paths.
    let mut stats: HashMap<Vec<u8>, (Option<u32>, Option<u32>)> = HashMap::new();
    let mut counts = counts.into_iter();
    while let Some(record) = counts.next() {
        let mut parts = record.splitn(3, |b| *b == b'\t');
        let (Some(added), Some(removed), Some(path)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        let path = if path.is_empty() {
            counts.next();
            counts.next().unwrap_or_default()
        } else {
            path.to_vec()
        };
        let number = |n: &[u8]| std::str::from_utf8(n).ok().and_then(|n| n.parse().ok());
        stats.insert(path, (number(added), number(removed)));
    }

    let mut files = Vec::new();
    let mut truncated = false;
    let mut names = names.into_iter();
    while let Some(status) = names.next() {
        let Some(change) = change(&status) else {
            continue;
        };
        let two = matches!(change, Change::Renamed | Change::Copied);
        let old = if two { names.next() } else { None };
        let Some(path) = names.next() else { break };
        if files.len() == MAX_ENTRIES {
            truncated = true;
            break;
        }
        let (added, removed) = stats.get(&path).copied().unwrap_or((None, None));
        // numstat writes "-" for both counts of a binary file.
        let binary = stats.contains_key(&path) && added.is_none() && removed.is_none();
        let (path, mut readable) = text(&path);
        let old_path = old.map(|old| {
            let (old, ok) = text(&old);
            readable &= ok;
            old
        });
        files.push(DiffFile {
            path,
            old_path,
            change,
            added,
            removed,
            binary,
            readable,
        });
    }
    for path in untracked {
        if files.len() == MAX_ENTRIES {
            truncated = true;
            break;
        }
        let (path, readable) = text(&path);
        files.push(DiffFile {
            path,
            old_path: None,
            change: Change::Untracked,
            added: None,
            removed: None,
            binary: false,
            readable,
        });
    }
    DiffList::Files { files, truncated }
}

/// The first output line says whether the file was too large, then the diff follows.
fn parse_file(stdout: &[u8]) -> Option<FileDiff> {
    let newline = stdout.iter().position(|b| *b == b'\n')?;
    let head = std::str::from_utf8(&stdout[..newline]).ok()?;
    if let Some(size) = head.strip_prefix("large ") {
        return Some(FileDiff::TooLarge {
            size: size.trim().parse().ok(),
        });
    }
    (head == "diff").then(|| FileDiff::Text {
        text: String::from_utf8_lossy(&stdout[newline + 1..]).into_owned(),
    })
}

/// A failed step is an error the review shows: the folder, the branch or Git itself.
fn checked(output: Output, what: &str) -> Result<Vec<u8>> {
    if output.exit == Some(0) {
        return Ok(output.stdout);
    }
    let detail = first_line(&output.stderr);
    Err(match output.exit {
        Some(2) => "저장소 폴더에 들어갈 수 없습니다.".to_string(),
        Some(3) => "비교할 브랜치를 찾을 수 없습니다. 목록을 새로 고치세요.".to_string(),
        _ if detail.is_empty() => format!("{what} 읽을 수 없습니다."),
        _ => format!("{what} 읽을 수 없습니다. {detail}"),
    })
}

async fn run(
    connections: &Connections,
    id: &str,
    script: &str,
    max_output: usize,
) -> std::result::Result<Output, Failure> {
    let handle = connections.handle(id).map_err(Failure::Other)?;
    let limits = Limits {
        timeout: TIMEOUT,
        max_output,
    };
    remote_exec::run(&handle, script, limits).await
}

fn check_base(base: &DiffBase) -> Result<()> {
    match base {
        DiffBase::WorkingTree => Ok(()),
        DiffBase::Branch { reference } => check_ref(reference),
    }
}

pub async fn refs(connections: &Connections, id: &str, folder: &str) -> Result<GitRefs> {
    check_folder(folder)?;
    let output = run(connections, id, &refs_script(folder), MAX_REFS_OUTPUT).await?;
    let stdout = checked(output, "Git 저장소를")?;
    parse_refs(&stdout).ok_or_else(|| "Git 저장소 정보를 읽을 수 없습니다.".into())
}

pub async fn list(
    connections: &Connections,
    id: &str,
    root: &str,
    base: &DiffBase,
) -> Result<DiffList> {
    check_folder(root)?;
    check_base(base)?;
    let script = list_script(root, base);
    match run(connections, id, &script, MAX_LIST_OUTPUT).await {
        Ok(output) => Ok(parse_list(&checked(output, "변경 파일 목록을")?)),
        Err(Failure::TimedOut) => Ok(DiffList::Stopped {
            reason: StopReason::Timeout,
        }),
        Err(Failure::TooLarge) => Ok(DiffList::Stopped {
            reason: StopReason::TooLarge,
        }),
        Err(Failure::Other(message)) => Err(message),
    }
}

pub struct FileRequest<'a> {
    pub root: &'a str,
    pub base: &'a DiffBase,
    pub path: &'a str,
    pub old_path: Option<&'a str>,
    pub untracked: bool,
}

pub async fn file(
    connections: &Connections,
    id: &str,
    request: FileRequest<'_>,
) -> Result<FileDiff> {
    check_folder(request.root)?;
    check_base(request.base)?;
    check_path(request.path)?;
    if let Some(old) = request.old_path {
        check_path(old)?;
    }
    let script = file_script(
        request.root,
        request.base,
        request.path,
        request.old_path,
        request.untracked,
    );
    match run(connections, id, &script, MAX_FILE_OUTPUT).await {
        Ok(output) => parse_file(&checked(output, "diff를")?)
            .ok_or_else(|| "diff 출력을 읽을 수 없습니다.".into()),
        Err(Failure::TimedOut) => Ok(FileDiff::TimedOut),
        Err(Failure::TooLarge) => Ok(FileDiff::TooLarge { size: None }),
        Err(Failure::Other(message)) => Err(message),
    }
}

#[tauri::command]
pub async fn git_refs(
    state: tauri::State<'_, AppState>,
    id: String,
    folder: String,
) -> Result<GitRefs> {
    refs(&state.connections, &id, &folder).await
}

#[tauri::command]
pub async fn git_diff_files(
    state: tauri::State<'_, AppState>,
    id: String,
    root: String,
    base: DiffBase,
) -> Result<DiffList> {
    list(&state.connections, &id, &root, &base).await
}

#[tauri::command]
pub async fn git_diff_file(
    state: tauri::State<'_, AppState>,
    id: String,
    root: String,
    base: DiffBase,
    path: String,
    old_path: Option<String>,
    untracked: bool,
) -> Result<FileDiff> {
    let request = FileRequest {
        root: &root,
        base: &base,
        path: &path,
        old_path: old_path.as_deref(),
        untracked,
    };
    file(&state.connections, &id, request).await
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn scripts_quote_every_value_and_turn_off_programs() {
        let base = branch("refs/heads/it's");
        let script = list_script("/srv/a b", &base);
        assert!(script.starts_with("cd -- '/srv/a b' || exit 2\n"));
        assert!(script.contains("--end-of-options 'refs/heads/it'\\''s'"));
        assert_eq!(script.matches("--no-ext-diff --no-textconv").count(), 2);
        assert_eq!(script.matches("-c core.fsmonitor=false").count(), 5);
        assert_eq!(script.matches("GIT_LITERAL_PATHSPECS=1").count(), 5);
        let file = file_script(
            "/r",
            &DiffBase::WorkingTree,
            "$(reboot) x",
            Some("-old"),
            false,
        );
        assert!(file.contains("-- '-old' '$(reboot) x'"));
        assert!(file.contains("--src-prefix=a/ --dst-prefix=b/ --end-of-options \"$B\""));
        assert!(file.contains("-c diff.noprefix=false"));
        assert!(file.contains("-c core.quotePath=false"));
        let untracked = file_script("/r", &DiffBase::WorkingTree, "n.txt", None, true);
        assert!(untracked.contains("--no-index -- /dev/null 'n.txt'"));
        assert!(!untracked.contains("$B"));
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
        let out = b"/srv/app\n\
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
        assert!(parse_refs(b"warning\n\0").is_none());
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
            checked(out(Some(3), ""), "diff를"),
            Err("비교할 브랜치를 찾을 수 없습니다. 목록을 새로 고치세요.".into())
        );
        assert_eq!(
            checked(out(Some(128), "fatal: bad\nmore"), "diff를"),
            Err("diff를 읽을 수 없습니다. fatal: bad".into())
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
}
