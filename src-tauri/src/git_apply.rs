//! The Git view's changes to a repository (GE.9): stage, commit, discard, branch, stash and tag.
//! Each runs through `git_run` with its safe settings, and paths are read literally after `--`.
//! Fetch, pull and push have no command here: the window types them in the tab's terminal, where
//! password and host key questions can be answered and the key and credential cards work.
use crate::{
    AppState,
    git_run::{GitHost, NO_GIT, args, git_run},
    git_status::{MAX_ENTRIES, first_line},
    remote_exec::{Failure, Limits, Output, quote},
    source::Source,
    storage::Result,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// A commit runs the repository's hooks, which can take a while.
const TIMEOUT: Duration = Duration::from_secs(120);
const IDENTITY_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_OUTPUT: usize = 8 * 1024 * 1024;
const MAX_PATH: usize = 4096;
const MAX_NAME: usize = 255;
/// Below the 32K of a Windows command line, which also carries the WSL script as one argument.
const MAX_TEXT: usize = 16 * 1024;
const MAX_SHOWN: usize = 300;
const MAGIC_PATHSPECS: &str = "--no-literal-pathspecs";

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitAction {
    /// `None` is the whole repository.
    Stage {
        paths: Option<Vec<String>>,
    },
    /// `None` is the whole repository.
    Unstage {
        paths: Option<Vec<String>>,
    },
    /// An empty message with `amend` keeps the commit's message.
    Commit {
        message: String,
        amend: bool,
    },
    /// Tracked files go back to the index, and `untracked` ones are deleted.
    Discard {
        paths: Vec<String>,
        untracked: Vec<String>,
    },
    BranchCreate {
        name: String,
    },
    Checkout {
        branch: String,
    },
    #[serde(rename_all = "camelCase")]
    StashPush {
        message: String,
        include_untracked: bool,
    },
    StashPop,
    /// An empty message makes a lightweight tag.
    Tag {
        name: String,
        message: String,
    },
}

/// What stopped an action, so the window can say what to do without reading Git's words.
#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum FailReason {
    /// A commit failed and Git has no author name or email to use.
    Identity,
    NoGit,
    Timeout,
    TooLarge,
    Git,
}

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GitApplyResult {
    /// `commands` is what ran, for the view's output area.
    Done { commands: Vec<String> },
    /// `detail` is Git's first line of error.
    Failed {
        commands: Vec<String>,
        reason: FailReason,
        detail: String,
    },
}

fn check_paths(paths: &[String]) -> Result<()> {
    if paths.is_empty() || paths.len() > MAX_ENTRIES {
        return Err("Git 작업의 파일 목록이 올바르지 않습니다.".into());
    }
    let bad = |path: &String| {
        path.is_empty()
            || path.len() > MAX_PATH
            || path.contains('\0')
            || path.starts_with('/')
            || path.split('/').any(|part| part == "..")
    };
    if paths.iter().any(bad) {
        return Err("저장소 안의 파일 경로가 아닙니다.".into());
    }
    Ok(())
}

/// Git checks a name fully and says what is wrong. This only keeps a name from being read as an
/// option or from breaking the line it is shown on.
fn check_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > MAX_NAME
        || name.starts_with('-')
        || name.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return Err("Git 이름이 올바르지 않습니다.".into());
    }
    Ok(())
}

fn check_text(text: &str, what: &str) -> Result<()> {
    if text.len() > MAX_TEXT || text.contains('\0') {
        return Err(format!("{what}가 너무 길거나 올바르지 않습니다."));
    }
    Ok(())
}

/// For a command without paths. `git_run` reads every pathspec literally, and child processes get
/// that too: `stash --include-untracked` runs `git clean ... :/`, which would then clean nothing,
/// and a commit hook's own `:(exclude)` patterns would stop matching.
fn without_paths<const N: usize>(parts: [&str; N]) -> Vec<String> {
    let mut command = vec![MAGIC_PATHSPECS.to_string()];
    command.extend(args(parts));
    command
}

/// `base -- paths...`, as several commands when the list would not fit on one command line.
fn with_paths(base: &[String], paths: &[String]) -> Vec<Vec<String>> {
    let start = || {
        let mut command = base.to_vec();
        command.push("--".into());
        command
    };
    let mut commands = Vec::new();
    let mut command = start();
    let mut size = 0;
    for path in paths {
        let cost = quote(path).len() + 1;
        if size > 0 && size + cost > MAX_TEXT {
            commands.push(std::mem::replace(&mut command, start()));
            size = 0;
        }
        command.push(path.clone());
        size += cost;
    }
    commands.push(command);
    commands
}

fn stage(paths: Option<&[String]>) -> Result<Vec<Vec<String>>> {
    let Some(paths) = paths else {
        return Ok(vec![args(["add", "-A"])]);
    };
    check_paths(paths)?;
    Ok(with_paths(&args(["add", "-A"]), paths))
}

/// `reset`, since `restore --staged` needs a first commit and Git 2.23.
fn unstage(paths: Option<&[String]>) -> Result<Vec<Vec<String>>> {
    let Some(paths) = paths else {
        return Ok(vec![args(["reset", "-q"])]);
    };
    check_paths(paths)?;
    Ok(with_paths(&args(["reset", "-q"]), paths))
}

fn commit(message: &str, amend: bool) -> Result<Vec<Vec<String>>> {
    check_text(message, "커밋 메시지")?;
    let mut command = without_paths(["commit", "-q"]);
    if amend {
        command.push("--amend".into());
    }
    if !message.trim().is_empty() {
        command.extend(["-m".to_string(), message.to_string()]);
    } else if amend {
        command.push("--no-edit".into());
    } else {
        return Err("커밋 메시지를 입력하세요.".into());
    }
    Ok(vec![command])
}

/// Tracked files first, so a failure there leaves every untracked file in place. `clean` deletes
/// only what Git itself considers untracked, unlike deleting the listed paths.
fn discard(paths: &[String], untracked: &[String]) -> Result<Vec<Vec<String>>> {
    let mut commands = Vec::new();
    if !paths.is_empty() {
        check_paths(paths)?;
        commands.extend(with_paths(&args(["checkout", "-q"]), paths));
    }
    if !untracked.is_empty() {
        check_paths(untracked)?;
        commands.extend(with_paths(&args(["clean", "-f", "-q"]), untracked));
    }
    if commands.is_empty() {
        return Err("Git 작업의 파일 목록이 올바르지 않습니다.".into());
    }
    Ok(commands)
}

fn stash_push(message: &str, include_untracked: bool) -> Result<Vec<Vec<String>>> {
    check_text(message, "stash 설명")?;
    let mut command = without_paths(["stash", "push", "-q"]);
    if include_untracked {
        command.push("--include-untracked".into());
    }
    if !message.trim().is_empty() {
        command.extend(["-m".to_string(), message.to_string()]);
    }
    Ok(vec![command])
}

fn tag(name: &str, message: &str) -> Result<Vec<Vec<String>>> {
    check_name(name)?;
    check_text(message, "태그 설명")?;
    let mut command = args(["tag"]);
    if !message.trim().is_empty() {
        command.extend(["-a".to_string(), "-m".to_string(), message.to_string()]);
    }
    command.push(name.to_string());
    Ok(vec![command])
}

/// The arguments after `git` of each command to run, in order.
fn plan(action: &GitAction) -> Result<Vec<Vec<String>>> {
    match action {
        GitAction::Stage { paths } => stage(paths.as_deref()),
        GitAction::Unstage { paths } => unstage(paths.as_deref()),
        GitAction::Commit { message, amend } => commit(message, *amend),
        GitAction::Discard { paths, untracked } => discard(paths, untracked),
        GitAction::BranchCreate { name } => {
            check_name(name)?;
            let mut command = without_paths(["checkout", "-q", "-b"]);
            command.push(name.clone());
            Ok(vec![command])
        }
        GitAction::Checkout { branch } => {
            check_name(branch)?;
            // The `--` makes it a branch even when a file has the same name.
            let mut command = without_paths(["checkout", "-q"]);
            command.extend([branch.clone(), "--".into()]);
            Ok(vec![command])
        }
        GitAction::StashPush {
            message,
            include_untracked,
        } => stash_push(message, *include_untracked),
        GitAction::StashPop => Ok(vec![without_paths(["stash", "pop", "-q"])]),
        GitAction::Tag { name, message } => tag(name, message),
    }
}

/// One line for the output area. A message is the user's own text and is not repeated there.
fn shown(command: &[String]) -> String {
    let mut parts = vec!["git"];
    let mut hide = false;
    for arg in command.iter().filter(|arg| *arg != MAGIC_PATHSPECS) {
        parts.push(if hide { "…" } else { arg });
        hide = arg == "-m";
    }
    let text = parts.join(" ");
    let mut line: String = text
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_SHOWN)
        .collect();
    if text.chars().filter(|c| !c.is_control()).count() > MAX_SHOWN {
        line.push('…');
    }
    line
}

/// Asked only after a commit failed: the same strict check Git makes, by its exit code instead of
/// by the words of its message, which also come after a hook's output.
async fn identity_missing(host: &GitHost, root: &str) -> bool {
    let commands = [
        args(["var", "GIT_AUTHOR_IDENT"]),
        args(["var", "GIT_COMMITTER_IDENT"]),
    ];
    let limits = Limits {
        timeout: IDENTITY_TIMEOUT,
        max_output: 64 * 1024,
    };
    git_run(host, root, &commands, limits)
        .await
        .is_ok_and(|output| !matches!(output.exit, Some(0) | Some(NO_GIT)))
}

async fn failed(
    host: &GitHost,
    root: &str,
    action: &GitAction,
    output: &Output,
    commands: Vec<String>,
) -> GitApplyResult {
    let mut detail = first_line(&output.stderr);
    if detail.is_empty() {
        // `stash pop` and `commit` report some failures on stdout.
        detail = first_line(&output.stdout);
    }
    let reason = if output.exit == Some(NO_GIT) {
        detail = host.no_git_text().into();
        FailReason::NoGit
    } else if matches!(action, GitAction::Commit { .. }) && identity_missing(host, root).await {
        FailReason::Identity
    } else {
        FailReason::Git
    };
    GitApplyResult::Failed {
        commands,
        reason,
        detail,
    }
}

/// `root` is the repository's top folder, since paths in an action are relative to it.
pub async fn apply(host: &GitHost, root: &str, action: &GitAction) -> Result<GitApplyResult> {
    let limits = Limits {
        timeout: TIMEOUT,
        max_output: MAX_OUTPUT,
    };
    let mut commands = Vec::new();
    let stopped = |commands, reason| GitApplyResult::Failed {
        commands,
        reason,
        detail: String::new(),
    };
    for command in plan(action)? {
        commands.push(shown(&command));
        let output = match git_run(host, root, std::slice::from_ref(&command), limits).await {
            Ok(output) => output,
            Err(Failure::TimedOut) => return Ok(stopped(commands, FailReason::Timeout)),
            Err(Failure::TooLarge) => return Ok(stopped(commands, FailReason::TooLarge)),
            Err(Failure::Other(message)) => return Err(message),
        };
        if output.exit != Some(0) {
            return Ok(failed(host, root, action, &output, commands).await);
        }
    }
    Ok(GitApplyResult::Done { commands })
}

#[tauri::command]
pub async fn git_apply(
    state: tauri::State<'_, AppState>,
    source: Source,
    root: String,
    action: GitAction,
) -> Result<GitApplyResult> {
    let host = GitHost::resolve(&state.connections, &state.locals, &source).await?;
    apply(&host, &root, &action).await
}

#[cfg(test)]
mod tests;
