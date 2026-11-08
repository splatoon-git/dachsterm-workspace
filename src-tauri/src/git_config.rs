//! A target's `git config` (GE.10). Only the settings the app lists are read or written, so a
//! token kept elsewhere in the file (`http.extraHeader`, a URL rewrite) never leaves the target.
//! Files are never edited directly: every change is one `git config` command.
pub mod program;

use crate::{
    AppState,
    git_run::{GitHost, NO_GIT, git_run},
    git_status::first_line,
    remote_exec::{Failure, Limits, quote},
    source::{GitSource, Source},
    storage::Result,
};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const LIMITS: Limits = Limits {
    timeout: Duration::from_secs(10),
    max_output: 1024 * 1024,
};
const MAX_VALUE: usize = 4096;
const MAX_CHANGES: usize = 32;

/// What can be done to a setting.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Text,
    Choice(&'static [&'static str]),
    /// Shown, and replaced only by a value the user types.
    Typed,
    /// A list that only grows here.
    List,
}

const ON_OFF: Kind = Kind::Choice(&["true", "false"]);
/// `(key, kind)`, in the spelling Git's documentation uses.
const FIELDS: [(&str, Kind); 16] = [
    ("user.name", Kind::Text),
    ("user.email", Kind::Text),
    ("init.defaultBranch", Kind::Text),
    ("pull.rebase", Kind::Choice(&["false", "true", "merges"])),
    ("pull.ff", Kind::Choice(&["true", "false", "only"])),
    ("fetch.prune", ON_OFF),
    ("push.autoSetupRemote", ON_OFF),
    (
        "push.default",
        Kind::Choice(&["simple", "current", "upstream", "matching", "nothing"]),
    ),
    ("core.autocrlf", Kind::Choice(&["true", "input", "false"])),
    ("core.eol", Kind::Choice(&["lf", "crlf", "native"])),
    ("core.editor", Kind::Text),
    (
        "merge.conflictStyle",
        Kind::Choice(&["merge", "diff3", "zdiff3"]),
    ),
    ("rebase.autoStash", ON_OFF),
    ("rerere.enabled", ON_OFF),
    ("credential.helper", Kind::Typed),
    ("safe.directory", Kind::List),
];

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Scope {
    Global,
    Local { folder: String },
}

impl Scope {
    fn flag(&self) -> &'static str {
        match self {
            Scope::Global => "--global",
            Scope::Local { .. } => "--local",
        }
    }

    /// Git needs a folder to start in. A global command starts outside any repository the app
    /// happens to be in.
    fn folder(&self, host: &GitHost) -> String {
        match (self, host) {
            (Scope::Local { folder }, _) => folder.clone(),
            (Scope::Global, GitHost::Native(_)) => {
                std::env::temp_dir().to_string_lossy().into_owned()
            }
            (Scope::Global, _) => "/".into(),
        }
    }
}

#[derive(Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Change {
    /// `all` replaces every value of a setting that has several.
    Set {
        key: String,
        value: String,
        all: bool,
    },
    Unset {
        key: String,
        all: bool,
    },
    Add {
        key: String,
        value: String,
    },
}

impl Change {
    fn key(&self) -> &str {
        match self {
            Change::Set { key, .. } | Change::Unset { key, .. } | Change::Add { key, .. } => key,
        }
    }

    /// What the user sees and what runs come from here, so the two cannot differ.
    fn command(&self, scope: &Scope) -> Vec<String> {
        let mut args = vec!["config".to_string(), scope.flag().to_string()];
        match self {
            Change::Set { key, value, all } => {
                if *all {
                    args.push("--replace-all".into());
                }
                args.extend([key.clone(), value.clone()]);
            }
            Change::Unset { key, all } => {
                args.push(if *all { "--unset-all" } else { "--unset" }.into());
                args.push(key.clone());
            }
            Change::Add { key, value } => {
                args.extend(["--add".to_string(), key.clone(), value.clone()]);
            }
        }
        args
    }
}

fn check_value(key: &str, value: &str) -> Result<()> {
    if value.is_empty() || value.len() > MAX_VALUE || value.chars().any(char::is_control) {
        return Err(format!("{key} 값이 올바르지 않습니다."));
    }
    Ok(())
}

fn check(change: &Change, scope: &Scope) -> Result<()> {
    let key = change.key();
    let Some((_, kind)) = FIELDS.iter().find(|(name, _)| *name == key) else {
        return Err(format!("앱에서 바꿀 수 없는 Git 설정입니다: {key}"));
    };
    // Git reads this one only from system, global and command line settings.
    if *kind == Kind::List && matches!(scope, Scope::Local { .. }) {
        return Err("safe.directory는 저장소 설정에 쓸 수 없습니다.".into());
    }
    match (change, *kind) {
        (Change::Set { value, .. }, Kind::Text | Kind::Typed) => check_value(key, value),
        (Change::Set { value, .. }, Kind::Choice(allowed)) => {
            if allowed.contains(&value.as_str()) {
                Ok(())
            } else {
                Err(format!("{key}에 쓸 수 없는 값입니다."))
            }
        }
        (Change::Unset { .. }, Kind::Text | Kind::Choice(_)) => Ok(()),
        (Change::Add { value, .. }, Kind::List) => check_value(key, value),
        _ => Err(format!("{key}에는 이 동작을 쓸 수 없습니다.")),
    }
}

fn check_all(changes: &[Change], scope: &Scope) -> Result<()> {
    if changes.len() > MAX_CHANGES {
        return Err("한 번에 바꿀 수 있는 항목 수를 넘었습니다.".into());
    }
    changes.iter().try_for_each(|change| check(change, scope))
}

/// One setting as the target has it. `values` is in file order, so the last one is in effect.
#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub key: String,
    pub values: Vec<String>,
    /// Something is set that may hold a secret, so its text stays on the target.
    pub hidden: bool,
}

/// An inline helper is a shell command, and a helper's arguments can carry a token.
fn may_hold_secret(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    value.trim_start().starts_with('!')
        || value.contains('@')
        || ["password", "passwd", "token", "secret", "key="]
            .iter()
            .any(|word| lower.contains(word))
}

/// Git prints section and variable names in lower case, and the expression is matched to that.
fn key_pattern() -> String {
    let names: Vec<String> = FIELDS
        .iter()
        .map(|(name, _)| name.to_ascii_lowercase().replace('.', "\\."))
        .collect();
    format!("^({})$", names.join("|"))
}

/// `--null --get-regexp` output: `key\nvalue\0`, or `key\0` for a setting with no value.
fn parse(stdout: &[u8]) -> Vec<Entry> {
    let mut found: Vec<Entry> = Vec::new();
    for record in stdout.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let (name, value) = match record.iter().position(|b| *b == b'\n') {
            Some(at) => (&record[..at], &record[at + 1..]),
            None => (record, &record[record.len()..]),
        };
        let name = String::from_utf8_lossy(name);
        let Some((key, _)) = FIELDS.iter().find(|(k, _)| k.eq_ignore_ascii_case(&name)) else {
            continue;
        };
        let value = String::from_utf8_lossy(value).into_owned();
        let secret = *key == "credential.helper" && may_hold_secret(&value);
        let at = found.iter().position(|e| e.key == *key).unwrap_or_else(|| {
            found.push(Entry {
                key: (*key).into(),
                values: Vec::new(),
                hidden: false,
            });
            found.len() - 1
        });
        let entry = &mut found[at];
        entry.hidden |= secret;
        entry.values.push(value);
    }
    for entry in &mut found {
        if entry.hidden {
            entry.values.clear();
        }
    }
    found
}

fn failure_text(failure: Failure) -> String {
    match failure {
        Failure::TimedOut => "Git 설정 명령이 제한 시간 안에 끝나지 않았습니다.".into(),
        Failure::TooLarge => "Git 설정 출력이 너무 큽니다.".into(),
        Failure::Other(text) => text,
    }
}

fn or_default(detail: String, text: &str) -> String {
    if detail.is_empty() {
        text.into()
    } else {
        detail
    }
}

pub async fn read(host: &GitHost, scope: &Scope) -> Result<Vec<Entry>> {
    let command = vec![
        "config".to_string(),
        scope.flag().to_string(),
        "--null".to_string(),
        "--get-regexp".to_string(),
        key_pattern(),
    ];
    let output = git_run(host, &scope.folder(host), &[command], LIMITS)
        .await
        .map_err(failure_text)?;
    match output.exit {
        Some(0) => Ok(parse(&output.stdout)),
        // Nothing matched, which is also what a missing settings file reports here.
        Some(1) => Ok(Vec::new()),
        Some(NO_GIT) => Err(host.no_git_text().into()),
        _ => Err(or_default(
            first_line(&output.stderr),
            "Git 설정을 읽지 못했습니다.",
        )),
    }
}

/// Commands stop at the first failure, with a NUL byte after each one that finished.
fn applied(stdout: &[u8]) -> usize {
    stdout.iter().filter(|b| **b == 0).count()
}

pub async fn write(host: &GitHost, scope: &Scope, changes: &[Change]) -> Result<()> {
    check_all(changes, scope)?;
    if changes.is_empty() {
        return Ok(());
    }
    let commands: Vec<Vec<String>> = changes.iter().map(|c| c.command(scope)).collect();
    let output = git_run(host, &scope.folder(host), &commands, LIMITS)
        .await
        .map_err(failure_text)?;
    match output.exit {
        Some(0) => Ok(()),
        Some(NO_GIT) => Err(host.no_git_text().into()),
        _ => {
            let done = applied(&output.stdout);
            let detail = or_default(first_line(&output.stderr), "Git이 오류로 끝났습니다.");
            Err(format!(
                "{}개 중 {done}개만 적용했습니다. {detail}",
                changes.len()
            ))
        }
    }
}

/// An argument that reads the same with or without quotes.
fn plain(arg: &str) -> bool {
    !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./:=@,+".contains(c))
}

/// The command as the user would type it where it runs. This PC's Git runs without a shell, so
/// the double quotes there are only how the arguments are shown.
fn shown(args: &[String], windows: bool) -> String {
    let shown = args.iter().map(|arg| {
        if plain(arg) {
            arg.clone()
        } else if windows {
            format!("\"{}\"", arg.replace('"', "\\\""))
        } else {
            quote(arg)
        }
    });
    std::iter::once("git".to_string())
        .chain(shown)
        .collect::<Vec<_>>()
        .join(" ")
}

fn preview(changes: &[Change], scope: &Scope, windows: bool) -> Result<Vec<String>> {
    check_all(changes, scope)?;
    Ok(changes
        .iter()
        .map(|change| shown(&change.command(scope), windows))
        .collect())
}

#[tauri::command]
pub async fn git_config_read(
    state: tauri::State<'_, AppState>,
    source: Source,
    scope: Scope,
) -> Result<Vec<Entry>> {
    let host = GitHost::resolve(&state.connections, &state.locals, &source).await?;
    read(&host, &scope).await
}

#[tauri::command]
pub async fn git_config_preview(
    state: tauri::State<'_, AppState>,
    source: Source,
    scope: Scope,
    changes: Vec<Change>,
) -> Result<Vec<String>> {
    let windows = match source.for_git()? {
        GitSource::Ssh(_) => false,
        GitSource::Local(id) => cfg!(windows) && state.locals.target(id)?.kind != "wsl",
    };
    preview(&changes, &scope, windows)
}

#[tauri::command]
pub async fn git_config_write(
    state: tauri::State<'_, AppState>,
    source: Source,
    scope: Scope,
    changes: Vec<Change>,
) -> Result<()> {
    let host = GitHost::resolve(&state.connections, &state.locals, &source).await?;
    write(&host, &scope, &changes).await
}

#[cfg(test)]
mod tests;
