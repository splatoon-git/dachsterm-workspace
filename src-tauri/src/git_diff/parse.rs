//! Reading the output of the diff review's Git commands.
use super::{Change, DiffFile, DiffList, FileDiff, GitRefs, MAX_REFS, Worktree, check_ref};
use crate::git_status::{MAX_ENTRIES, windows_root};
use std::collections::HashMap;

/// Git prints an absolute path as `/x`, or as `C:/x` from this PC's git on Windows.
fn absolute(path: &str) -> bool {
    path.starts_with('/') || windows_root(path)
}

fn text(bytes: &[u8]) -> (String, bool) {
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_string(), true),
        Err(_) => (String::from_utf8_lossy(bytes).into_owned(), false),
    }
}

/// `rev-parse --show-toplevel`, `worktree list --porcelain`, then one ref per line, NUL between.
pub(super) fn parse_refs(stdout: &[u8]) -> Option<GitRefs> {
    let mut parts = stdout.splitn(3, |b| *b == 0);
    let (head, trees, names) = (parts.next()?, parts.next()?, parts.next()?);
    let head = std::str::from_utf8(head).ok()?;
    let root = head.lines().next()?.trim_end_matches('\r').to_string();
    if !absolute(&root) {
        return None;
    }
    let mut worktrees = Vec::new();
    for record in String::from_utf8_lossy(trees).split("\n\n") {
        let mut lines = record.lines();
        let Some(path) = lines.next().and_then(|l| l.strip_prefix("worktree ")) else {
            continue;
        };
        // A lossy path is not the real one, so it cannot be offered.
        if !absolute(path) || path.contains('\u{fffd}') {
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
    for line in String::from_utf8_lossy(names).lines() {
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

/// The change a status letter stands for. Other letters, such as `.`, are no change.
pub(crate) fn change(status: &[u8]) -> Option<Change> {
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
pub(super) fn parse_list(stdout: &[u8]) -> DiffList {
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
pub(super) fn parse_file(stdout: &[u8]) -> Option<FileDiff> {
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
