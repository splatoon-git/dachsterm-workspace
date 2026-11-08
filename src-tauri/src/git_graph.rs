//! The Git view's read-only commit graph (GE.14), on top of `git_run`, so the three kinds of tab
//! run the same commands with the same safety settings. Nothing here changes a repository.
#[cfg(test)]
mod tests;

use crate::{
    AppState,
    git_diff::{DiffFile, DiffList, checked, parse_list},
    git_run::{GitHost, NO_GIT, args, git_run},
    git_status::{StopReason, first_line},
    remote_exec::{Failure, Limits, Output},
    source::Source,
    storage::Result,
};
use serde::Serialize;
use std::time::Duration;

/// The most commits one view shows. A history longer than this ends with a note.
pub const MAX_COMMITS: usize = 1000;
/// `--topo-order` may walk the whole history before printing the first commit.
const TIMEOUT: Duration = Duration::from_secs(15);
const MAX_LOG_OUTPUT: usize = 4 * 1024 * 1024;
const MAX_START_OUTPUT: usize = 64 * 1024;
/// One commit's message, or a NUL-separated list of at most `MAX_ENTRIES` paths.
const MAX_DETAIL_OUTPUT: usize = 8 * 1024 * 1024;

const GRAPH_FORMAT: &str = "--format=tformat:%H%x00%P%x00%an%x00%at%x00%D%x00%s%x00";
const DETAIL_FORMAT: &str = "--format=tformat:%H%x00%P%x00%an%x00%at%x00%B%x00";
const GRAPH_FIELDS: usize = 6;
const DETAIL_FIELDS: usize = 5;

#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum RefKind {
    /// A detached HEAD. An attached one is its branch with `current` set.
    Head,
    Branch,
    Remote,
    Tag,
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphRef {
    pub kind: RefKind,
    pub name: String,
    pub current: bool,
}

#[derive(Serialize, Debug, PartialEq, Eq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    /// Seconds since the epoch.
    pub time: i64,
    pub refs: Vec<GraphRef>,
    pub subject: String,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitGraphResult {
    #[serde(rename_all = "camelCase")]
    Graph {
        commits: Vec<GraphCommit>,
        /// Older commits exist past the ones asked for.
        has_more: bool,
    },
    /// A repository before its first commit.
    Empty,
    NotRepo {
        detail: String,
    },
    NoGit {
        detail: String,
    },
    Stopped {
        reason: StopReason,
    },
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    pub time: i64,
    pub message: String,
    /// Against the first parent, or the empty tree for a root commit.
    pub files: Vec<DiffFile>,
    /// The list stopped at its limit, or could not be read within one.
    pub truncated: bool,
}

fn limits(max_output: usize) -> Limits {
    Limits {
        timeout: TIMEOUT,
        max_output,
    }
}

/// A full object name. Only SHA-1 and SHA-256 lengths, so nothing else reaches Git's arguments.
fn check_hash(hash: &str) -> Result<()> {
    let valid = matches!(hash.len(), 40 | 64)
        && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    if !valid {
        return Err("커밋 해시가 올바르지 않습니다.".into());
    }
    Ok(())
}

/// A repository's settings cannot start a signature program, and its output encoding, colour
/// and decoration settings cannot change what is parsed.
fn log_command() -> Vec<String> {
    args([
        "log",
        "--no-color",
        "--no-show-signature",
        "--encoding=UTF-8",
    ])
}

/// Whether HEAD has a commit, then its upstream. The second one fails when there is none, which
/// is an ordinary case: the NUL `git_run` writes between them says the first one passed.
fn start_commands() -> [Vec<String>; 2] {
    [
        args(["rev-parse", "--verify", "-q", "HEAD^{commit}"]),
        args(["rev-parse", "--symbolic-full-name", "@{upstream}"]),
    ]
}

fn unavailable(host: &GitHost, output: &Output) -> GitGraphResult {
    if output.exit == Some(NO_GIT) {
        return GitGraphResult::NoGit {
            detail: host.no_git_text().into(),
        };
    }
    GitGraphResult::NotRepo {
        detail: first_line(&output.stderr),
    }
}

/// Where `git log` starts, or the result when there is nothing to walk.
fn start_points(
    host: &GitHost,
    output: &Output,
) -> std::result::Result<Vec<String>, GitGraphResult> {
    let mut parts = output.stdout.split(|b| *b == 0).skip(1);
    let Some(upstream) = parts.next() else {
        // `rev-parse --verify -q` exits 1 without a message when HEAD has no commit yet. Outside
        // a repository it is a fatal error, 128.
        return Err(if output.exit == Some(1) {
            GitGraphResult::Empty
        } else {
            unavailable(host, output)
        });
    };
    let mut points = vec!["HEAD".to_string()];
    if output.exit == Some(0) {
        // Git named it, and a name that starts `refs/` cannot be taken for an option.
        let name = std::str::from_utf8(upstream).map(str::trim).unwrap_or("");
        if name.starts_with("refs/") {
            points.push(name.to_string());
        }
    }
    Ok(points)
}

fn graph_command(limit: usize, points: &[String]) -> Vec<String> {
    let mut command = log_command();
    command.extend(args(["--topo-order", "--decorate=full", GRAPH_FORMAT]));
    // One more than asked for says whether older commits exist.
    command.push(format!("--max-count={}", limit + 1));
    command.extend(points.iter().cloned());
    command.push("--".into());
    command
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// `HEAD -> refs/heads/main, tag: refs/tags/v1, refs/remotes/origin/main`. A ref name cannot hold
/// a space, so the separator cannot be part of one.
fn parse_refs(decoration: &[u8]) -> Vec<GraphRef> {
    let decoration = text(decoration);
    let reference = |kind, name: &str, current| GraphRef {
        kind,
        name: name.to_string(),
        current,
    };
    decoration
        .split(", ")
        .filter_map(|item| {
            if item == "HEAD" {
                return Some(reference(RefKind::Head, "HEAD", true));
            }
            let (item, current) = match item.strip_prefix("HEAD -> ") {
                Some(rest) => (rest, true),
                None => (item, false),
            };
            let item = item.strip_prefix("tag: ").unwrap_or(item);
            if let Some(name) = item.strip_prefix("refs/heads/") {
                return Some(reference(RefKind::Branch, name, current));
            }
            if let Some(name) = item.strip_prefix("refs/tags/") {
                return Some(reference(RefKind::Tag, name, false));
            }
            // `origin/HEAD` only says which branch the remote points at.
            item.strip_prefix("refs/remotes/")
                .filter(|name| !name.ends_with("/HEAD"))
                .map(|name| reference(RefKind::Remote, name, false))
        })
        .collect()
}

/// The fields every record starts with: hash, parents, author, time.
struct Head {
    hash: String,
    parents: Vec<String>,
    author: String,
    time: i64,
}

fn parse_head(record: &[&[u8]]) -> Option<Head> {
    // `tformat` ends each record with a newline, which starts the next record's first field.
    let hash = std::str::from_utf8(record.first()?).ok()?.trim_start();
    check_hash(hash).ok()?;
    let parents = std::str::from_utf8(record.get(1)?).ok()?;
    let parents: Vec<String> = parents.split_whitespace().map(String::from).collect();
    if parents.iter().any(|parent| check_hash(parent).is_err()) {
        return None;
    }
    Some(Head {
        hash: hash.to_string(),
        parents,
        author: text(record.get(2)?),
        // A commit with a broken date is still part of the graph.
        time: std::str::from_utf8(record.get(3)?)
            .ok()
            .and_then(|time| time.parse().ok())
            .unwrap_or(0),
    })
}

fn parse_log(stdout: &[u8], limit: usize) -> Option<GitGraphResult> {
    let fields: Vec<&[u8]> = stdout.split(|b| *b == 0).collect();
    let mut commits = fields
        .as_chunks::<GRAPH_FIELDS>()
        .0
        .iter()
        .map(|record| {
            let head = parse_head(record)?;
            Some(GraphCommit {
                hash: head.hash,
                parents: head.parents,
                author: head.author,
                time: head.time,
                refs: parse_refs(record[4]),
                subject: text(record[5]),
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    Some(GitGraphResult::Graph { commits, has_more })
}

async fn read_graph(
    host: &GitHost,
    folder: &str,
    limit: usize,
) -> std::result::Result<GitGraphResult, Failure> {
    let start = git_run(host, folder, &start_commands(), limits(MAX_START_OUTPUT)).await?;
    let points = match start_points(host, &start) {
        Ok(points) => points,
        Err(result) => return Ok(result),
    };
    let command = graph_command(limit, &points);
    let output = git_run(host, folder, &[command], limits(MAX_LOG_OUTPUT)).await?;
    if output.exit != Some(0) {
        return Ok(unavailable(host, &output));
    }
    parse_log(&output.stdout, limit)
        .ok_or_else(|| Failure::Other("Git 이력을 읽을 수 없습니다.".into()))
}

/// The newest `limit` commits (at most `MAX_COMMITS`) reachable from HEAD and its upstream.
pub async fn query(host: &GitHost, folder: &str, limit: usize) -> Result<GitGraphResult> {
    match read_graph(host, folder, limit.clamp(1, MAX_COMMITS)).await {
        Ok(result) => Ok(result),
        Err(Failure::TimedOut) => Ok(GitGraphResult::Stopped {
            reason: StopReason::Timeout,
        }),
        Err(Failure::TooLarge) => Ok(GitGraphResult::Stopped {
            reason: StopReason::TooLarge,
        }),
        Err(Failure::Other(message)) => Err(message),
    }
}

fn detail_command(hash: &str) -> Vec<String> {
    let mut command = log_command();
    command.extend(args(["--max-count=1", DETAIL_FORMAT]));
    command.push(hash.to_string());
    command.push("--".into());
    command
}

/// The files a commit changed, as `--name-status -z`. `diff-tree` has no working tree to read.
fn files_command(parent: Option<&str>, hash: &str) -> Vec<String> {
    let mut command = args([
        "diff-tree",
        "-r",
        "-z",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--find-renames",
        "--name-status",
    ]);
    match parent {
        Some(parent) => command.push(parent.to_string()),
        None => command.extend(args(["--root", "--no-commit-id"])),
    }
    command.push(hash.to_string());
    command.push("--".into());
    command
}

fn parse_detail(stdout: &[u8]) -> Option<(Head, String)> {
    let fields: Vec<&[u8]> = stdout.split(|b| *b == 0).collect();
    let record = fields.get(..DETAIL_FIELDS)?;
    Some((parse_head(record)?, text(record[4]).trim_end().to_string()))
}

async fn read_files(
    host: &GitHost,
    folder: &str,
    parent: Option<&str>,
    hash: &str,
) -> Result<(Vec<DiffFile>, bool)> {
    let command = files_command(parent, hash);
    let output = match git_run(host, folder, &[command], limits(MAX_DETAIL_OUTPUT)).await {
        Ok(output) => output,
        // The message is still worth showing, so the list is marked as cut off.
        Err(Failure::TimedOut | Failure::TooLarge) => return Ok((Vec::new(), true)),
        Err(Failure::Other(message)) => return Err(message),
    };
    let stdout = checked(output, "바뀐 파일 목록을")?;
    match parse_list(&stdout) {
        DiffList::Files { files, truncated } => Ok((files, truncated)),
        DiffList::Stopped { .. } => Ok((Vec::new(), true)),
    }
}

pub async fn detail(host: &GitHost, folder: &str, hash: &str) -> Result<CommitDetail> {
    check_hash(hash)?;
    let limits = limits(MAX_DETAIL_OUTPUT);
    let output = match git_run(host, folder, &[detail_command(hash)], limits).await {
        Ok(output) => output,
        Err(Failure::TimedOut) => return Err("커밋을 읽는 시간이 초과되었습니다.".into()),
        Err(Failure::TooLarge) => return Err("커밋 메시지가 너무 커서 표시할 수 없습니다.".into()),
        Err(Failure::Other(message)) => return Err(message),
    };
    let stdout = checked(output, "커밋을")?;
    let (head, message) =
        parse_detail(&stdout).ok_or_else(|| "커밋 정보를 읽을 수 없습니다.".to_string())?;
    let parent = head.parents.first().map(String::as_str);
    let (files, truncated) = read_files(host, folder, parent, hash).await?;
    Ok(CommitDetail {
        hash: head.hash,
        parents: head.parents,
        author: head.author,
        time: head.time,
        message,
        files,
        truncated,
    })
}

#[tauri::command]
pub async fn git_graph(
    state: tauri::State<'_, AppState>,
    source: Source,
    folder: String,
    limit: u32,
) -> Result<GitGraphResult> {
    let host = GitHost::resolve(&state.connections, &state.locals, &source).await?;
    query(&host, &folder, limit as usize).await
}

#[tauri::command]
pub async fn git_commit_detail(
    state: tauri::State<'_, AppState>,
    source: Source,
    folder: String,
    hash: String,
) -> Result<CommitDetail> {
    let host = GitHost::resolve(&state.connections, &state.locals, &source).await?;
    detail(&host, &folder, &hash).await
}
