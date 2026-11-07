//! Finds well-known editors by install location. A bare name needs PATH, which a GUI launch may lack.
use serde::Serialize;
use std::path::PathBuf;

/// Where an install root comes from.
#[derive(Clone, Copy)]
enum Root {
    /// `%LOCALAPPDATA%\Programs`, for per-user installs.
    UserPrograms,
    /// `%ProgramFiles%` and `%ProgramFiles(x86)%`.
    Programs,
    /// `%WINDIR%\System32`.
    System,
    /// `/Applications` and `~/Applications`.
    Applications,
    /// `/System/Applications`, for the editors macOS ships.
    SystemApplications,
}

/// A known editor: the id stored in settings, the name shown, and the executable under its roots.
struct Known {
    id: &'static str,
    name: &'static str,
    root: Root,
    relative: &'static str,
}

const fn known(id: &'static str, name: &'static str, root: Root, relative: &'static str) -> Known {
    Known {
        id,
        name,
        root,
        relative,
    }
}

// Order is the order shown: code editors first, then plain text editors. An id may appear more
// than once for different install places; the first one found wins.
const WINDOWS: &[Known] = &[
    known(
        "code",
        "Visual Studio Code",
        Root::UserPrograms,
        "Microsoft VS Code/Code.exe",
    ),
    known(
        "code",
        "Visual Studio Code",
        Root::Programs,
        "Microsoft VS Code/Code.exe",
    ),
    known("cursor", "Cursor", Root::UserPrograms, "cursor/Cursor.exe"),
    known(
        "windsurf",
        "Windsurf",
        Root::UserPrograms,
        "Windsurf/Windsurf.exe",
    ),
    known("zed", "Zed", Root::UserPrograms, "Zed/Zed.exe"),
    known(
        "subl",
        "Sublime Text",
        Root::Programs,
        "Sublime Text/sublime_text.exe",
    ),
    known(
        "subl",
        "Sublime Text",
        Root::Programs,
        "Sublime Text 3/sublime_text.exe",
    ),
    known(
        "notepad++",
        "Notepad++",
        Root::Programs,
        "Notepad++/notepad++.exe",
    ),
    known(
        "editplus",
        "EditPlus",
        Root::Programs,
        "EditPlus/editplus.exe",
    ),
    known("notepad", "메모장", Root::System, "notepad.exe"),
];
const MACOS: &[Known] = &[
    known(
        "code",
        "Visual Studio Code",
        Root::Applications,
        "Visual Studio Code.app/Contents/Resources/app/bin/code",
    ),
    known(
        "cursor",
        "Cursor",
        Root::Applications,
        "Cursor.app/Contents/Resources/app/bin/cursor",
    ),
    known(
        "windsurf",
        "Windsurf",
        Root::Applications,
        "Windsurf.app/Contents/Resources/app/bin/windsurf",
    ),
    known(
        "zed",
        "Zed",
        Root::Applications,
        "Zed.app/Contents/MacOS/cli",
    ),
    known(
        "subl",
        "Sublime Text",
        Root::Applications,
        "Sublime Text.app/Contents/SharedSupport/bin/subl",
    ),
    known(
        "bbedit",
        "BBEdit",
        Root::Applications,
        "BBEdit.app/Contents/Helpers/bbedit_tool",
    ),
    known(
        "cot",
        "CotEditor",
        Root::Applications,
        "CotEditor.app/Contents/SharedSupport/bin/cot",
    ),
    known(
        "textedit",
        "텍스트 편집기",
        Root::SystemApplications,
        "TextEdit.app/Contents/MacOS/TextEdit",
    ),
];

fn table() -> &'static [Known] {
    if cfg!(windows) { WINDOWS } else { MACOS }
}

fn roots(root: Root) -> Vec<PathBuf> {
    let env = |name: &str| std::env::var_os(name).map(PathBuf::from);
    match root {
        Root::UserPrograms => env("LOCALAPPDATA")
            .map(|p| p.join("Programs"))
            .into_iter()
            .collect(),
        Root::Programs => ["ProgramFiles", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(env)
            .collect(),
        Root::System => env("WINDIR")
            .map(|p| p.join("System32"))
            .into_iter()
            .collect(),
        Root::Applications => std::iter::once(PathBuf::from("/Applications"))
            .chain(dirs::home_dir().map(|home| home.join("Applications")))
            .collect(),
        Root::SystemApplications => vec![PathBuf::from("/System/Applications")],
    }
}

/// An editor found on this computer.
#[derive(Serialize, Debug, PartialEq)]
pub struct Installed {
    pub id: &'static str,
    pub name: &'static str,
    pub path: String,
}

fn installed_in(table: &[Known], roots: impl Fn(Root) -> Vec<PathBuf>) -> Vec<Installed> {
    let mut found: Vec<Installed> = Vec::new();
    for entry in table {
        if found.iter().any(|f| f.id == entry.id) {
            continue;
        }
        if let Some(path) = roots(entry.root)
            .into_iter()
            .map(|root| root.join(entry.relative))
            .find(|path| path.is_file())
        {
            found.push(Installed {
                id: entry.id,
                name: entry.name,
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
    found
}

/// The known editors installed here, in display order, one per id.
pub fn installed() -> Vec<Installed> {
    installed_in(table(), roots)
}

/// Returns the installed editor, or the given value for custom paths and unknown names.
pub fn resolve(program: &str) -> PathBuf {
    installed_in(table(), roots)
        .into_iter()
        .find(|editor| editor.id == program)
        .map(|editor| PathBuf::from(editor.path))
        .unwrap_or_else(|| PathBuf::from(program))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn finds_every_known_editor_in_its_roots_once() {
        for table in [WINDOWS, MACOS] {
            let first = tempfile::tempdir().unwrap();
            let second = tempfile::tempdir().unwrap();
            let roots = |_| vec![first.path().to_path_buf(), second.path().to_path_buf()];
            assert!(installed_in(table, roots).is_empty());
            for entry in table {
                let path = second.path().join(entry.relative);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(&path, "").unwrap();
            }
            let found = installed_in(table, roots);
            let mut ids: Vec<_> = table.iter().map(|k| k.id).collect();
            ids.dedup();
            assert_eq!(found.iter().map(|f| f.id).collect::<Vec<_>>(), ids);
        }
    }

    #[test]
    fn prefers_the_first_install_place_of_an_id() {
        let dir = tempfile::tempdir().unwrap();
        for relative in [
            "Sublime Text/sublime_text.exe",
            "Sublime Text 3/sublime_text.exe",
        ] {
            let path = dir.path().join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "").unwrap();
        }
        let found = installed_in(WINDOWS, |_| vec![dir.path().to_path_buf()]);
        let subl = found.iter().find(|f| f.id == "subl").unwrap();
        assert!(subl.path.ends_with("sublime_text.exe"));
        assert!(!subl.path.contains("Sublime Text 3"));
    }

    #[test]
    fn keeps_custom_programs_unchanged() {
        assert_eq!(
            resolve("/opt/editor/bin/edit"),
            Path::new("/opt/editor/bin/edit")
        );
        assert_eq!(resolve("vim"), Path::new("vim"));
    }
}
