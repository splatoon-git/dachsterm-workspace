//! Read-only diff of a repository for the review tab (DX.6), run through `git_run` like every
//! other Git query (GE.7). It adds the switches that keep a repository's own settings from
//! starting a program (external diff, textconv) or changing the format the app parses (prefixes,
//! colour, relative paths). Diff text is returned to the window only and never logged.
mod parse;
pub mod sides;
#[cfg(test)]
mod tests;

use crate::{
    AppState,
    git_run::{GitHost, SizeGuard, args, git_run, git_run_guarded},
    git_status::{StopReason, first_line},
    remote_exec::{Failure, Limits, Output},
    source::Source,
    storage::Result,
};
pub(crate) use parse::{change, parse_list};
use parse::{parse_file, parse_refs};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);
/// Three NUL-separated listings of at most `MAX_ENTRIES` paths each.
const MAX_LIST_OUTPUT: usize = 8 * 1024 * 1024;
/// A file larger than this is not shown. The diff of one may hold both sides.
pub const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_FILE_OUTPUT: usize = 2 * MAX_FILE as usize + 64 * 1024;
const MAX_REFS_OUTPUT: usize = 1024 * 1024;
pub const MAX_REFS: usize = 2000;
const MAX_PATH: usize = 4096;

/// Starts every diff. User settings cannot move the `a/`, `b/` prefixes or colour the output, and
/// no repository setting runs a diff or textconv program. Header paths stay readable: by default
/// Git writes a non-ASCII name such as a Korean one as quoted octal escapes.
fn diff() -> Vec<String> {
    args([
        "-c",
        "diff.noprefix=false",
        "-c",
        "diff.mnemonicPrefix=false",
        "-c",
        "diff.relative=false",
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames",
    ])
}

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
pub(crate) fn check_ref(reference: &str) -> Result<()> {
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

fn limits(max_output: usize) -> Limits {
    Limits {
        timeout: TIMEOUT,
        max_output,
    }
}

fn base_missing(exit: Option<u32>) -> Failure {
    Failure::Other(match exit {
        Some(2) => "저장소 폴더에 들어갈 수 없습니다.".to_string(),
        _ => "비교할 브랜치를 찾을 수 없습니다. 목록을 새로 고치세요.".to_string(),
    })
}

fn object_name(stdout: &[u8]) -> String {
    let last = stdout.rsplit(|b| *b == 0).next().unwrap_or_default();
    String::from_utf8_lossy(last).trim().to_string()
}

/// The commit or tree the working tree is compared with: HEAD or, before the first commit, the
/// empty tree; or the merge base of HEAD and a branch.
async fn base_object(
    host: &GitHost,
    root: &str,
    base: &DiffBase,
) -> std::result::Result<String, Failure> {
    let reply = match base {
        DiffBase::WorkingTree => {
            let head = args(["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
            let found = git_run(host, root, &[head], limits(MAX_REFS_OUTPUT)).await?;
            if found.exit == Some(0) {
                return Ok(object_name(&found.stdout));
            }
            if found.exit == Some(2) {
                return Err(base_missing(found.exit));
            }
            let empty = args(["hash-object", "-t", "tree", "/dev/null"]);
            git_run(host, root, &[empty], limits(MAX_REFS_OUTPUT)).await?
        }
        DiffBase::Branch { reference } => {
            let known = args(["show-ref", "--verify", "-q", "--end-of-options", reference]);
            let merge_base = args(["merge-base", "--end-of-options", "HEAD", reference]);
            git_run(host, root, &[known, merge_base], limits(MAX_REFS_OUTPUT)).await?
        }
    };
    if reply.exit != Some(0) {
        return Err(base_missing(reply.exit));
    }
    Ok(object_name(&reply.stdout))
}

fn list_commands(base: &str) -> Vec<Vec<String>> {
    let compare = |mode: &str| {
        let mut command = diff();
        command.extend(args([mode, "-z", "--end-of-options", base, "--"]));
        command
    };
    vec![
        compare("--name-status"),
        compare("--numstat"),
        args(["ls-files", "--others", "--exclude-standard", "-z"]),
    ]
}

const PREFIXES: [&str; 2] = ["--src-prefix=a/", "--dst-prefix=b/"];

fn file_commands(base: &str, path: &str, old_path: Option<&str>) -> Vec<Vec<String>> {
    let mut command = diff();
    command.extend(args(PREFIXES));
    command.extend(args(["--end-of-options", base, "--"]));
    command.extend(old_path.map(String::from));
    command.push(path.to_string());
    vec![command]
}

fn untracked_commands(path: &str) -> Vec<Vec<String>> {
    let mut command = diff();
    command.extend(args(PREFIXES));
    command.extend(args(["--no-index", "--", "/dev/null", path]));
    vec![command]
}

/// A failed step is an error the review shows: the folder or Git itself.
pub(crate) fn checked(output: Output, what: &str) -> Result<Vec<u8>> {
    if output.exit == Some(0) {
        return Ok(output.stdout);
    }
    let detail = first_line(&output.stderr);
    Err(match output.exit {
        Some(2) => "저장소 폴더에 들어갈 수 없습니다.".to_string(),
        _ if detail.is_empty() => format!("{what} 읽을 수 없습니다."),
        _ => format!("{what} 읽을 수 없습니다. {detail}"),
    })
}

fn check_base(base: &DiffBase) -> Result<()> {
    match base {
        DiffBase::WorkingTree => Ok(()),
        DiffBase::Branch { reference } => check_ref(reference),
    }
}

pub async fn refs(host: &GitHost, folder: &str) -> Result<GitRefs> {
    let commands = [
        args(["rev-parse", "--show-toplevel"]),
        args(["worktree", "list", "--porcelain"]),
        args([
            "for-each-ref",
            "--format=%(refname)",
            "refs/heads",
            "refs/remotes",
        ]),
    ];
    let output = git_run(host, folder, &commands, limits(MAX_REFS_OUTPUT)).await?;
    let stdout = checked(output, "Git 저장소를")?;
    parse_refs(&stdout).ok_or_else(|| "Git 저장소 정보를 읽을 수 없습니다.".into())
}

async fn list_output(
    host: &GitHost,
    root: &str,
    base: &DiffBase,
) -> std::result::Result<Vec<u8>, Failure> {
    let object = base_object(host, root, base).await?;
    let output = git_run(host, root, &list_commands(&object), limits(MAX_LIST_OUTPUT)).await?;
    checked(output, "변경 파일 목록을").map_err(Failure::Other)
}

pub async fn list(host: &GitHost, root: &str, base: &DiffBase) -> Result<DiffList> {
    check_base(base)?;
    match list_output(host, root, base).await {
        Ok(stdout) => Ok(parse_list(&stdout)),
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

async fn file_output(
    host: &GitHost,
    request: &FileRequest<'_>,
) -> std::result::Result<Vec<u8>, Failure> {
    let FileRequest {
        root,
        base,
        path,
        old_path,
        untracked,
    } = *request;
    // The working tree file's size decides before any diff runs. A deleted file has none.
    let guard = SizeGuard {
        path,
        max: MAX_FILE,
    };
    let limits = limits(MAX_FILE_OUTPUT);
    let mut output = if untracked {
        git_run_guarded(host, root, &guard, &untracked_commands(path), limits).await?
    } else {
        let object = base_object(host, root, base).await?;
        let commands = file_commands(&object, path, old_path);
        git_run_guarded(host, root, &guard, &commands, limits).await?
    };
    // `--no-index` exits 1 when the two sides differ, which they always do here.
    if untracked && output.exit == Some(1) {
        output.exit = Some(0);
    }
    checked(output, "diff를").map_err(Failure::Other)
}

pub async fn file(host: &GitHost, request: FileRequest<'_>) -> Result<FileDiff> {
    check_base(request.base)?;
    check_path(request.path)?;
    if let Some(old) = request.old_path {
        check_path(old)?;
    }
    match file_output(host, &request).await {
        Ok(stdout) => parse_file(&stdout).ok_or_else(|| "diff 출력을 읽을 수 없습니다.".into()),
        Err(Failure::TimedOut) => Ok(FileDiff::TimedOut),
        Err(Failure::TooLarge) => Ok(FileDiff::TooLarge { size: None }),
        Err(Failure::Other(message)) => Err(message),
    }
}

#[tauri::command]
pub async fn git_refs(
    state: tauri::State<'_, AppState>,
    source: Source,
    folder: String,
) -> Result<GitRefs> {
    let host = GitHost::resolve(&state.connections, &state.locals, &source).await?;
    refs(&host, &folder).await
}

#[tauri::command]
pub async fn git_diff_files(
    state: tauri::State<'_, AppState>,
    id: String,
    root: String,
    base: DiffBase,
) -> Result<DiffList> {
    list(&GitHost::ssh(&state.connections, &id)?, &root, &base).await
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
    file(&GitHost::ssh(&state.connections, &id)?, request).await
}
