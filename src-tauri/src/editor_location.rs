//! Finds well-known editors by install location. A bare name needs PATH, which a GUI launch may lack.
use std::path::PathBuf;

const WINDOWS: &[(&str, &str)] = &[
    ("code", "Microsoft VS Code/Code.exe"),
    ("cursor", "cursor/Cursor.exe"),
    ("subl", "Sublime Text/sublime_text.exe"),
];
const MACOS: &[(&str, &str)] = &[
    (
        "code",
        "Visual Studio Code.app/Contents/Resources/app/bin/code",
    ),
    ("cursor", "Cursor.app/Contents/Resources/app/bin/cursor"),
    ("subl", "Sublime Text.app/Contents/SharedSupport/bin/subl"),
];

fn install_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            roots.push(PathBuf::from(local).join("Programs"));
        }
        if let Some(programs) = std::env::var_os("ProgramFiles") {
            roots.push(PathBuf::from(programs));
        }
    } else {
        roots.push(PathBuf::from("/Applications"));
        if let Some(home) = dirs::home_dir() {
            roots.push(home.join("Applications"));
        }
    }
    roots
}

fn find(program: &str, table: &[(&str, &str)], roots: &[PathBuf]) -> Option<PathBuf> {
    let (_, relative) = table.iter().find(|(name, _)| *name == program)?;
    roots
        .iter()
        .map(|root| root.join(relative))
        .find(|path| path.is_file())
}

/// Returns the installed editor, or the given value for custom paths and unknown names.
pub fn resolve(program: &str) -> PathBuf {
    let table = if cfg!(windows) { WINDOWS } else { MACOS };
    find(program, table, &install_roots()).unwrap_or_else(|| PathBuf::from(program))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn finds_every_known_editor_in_any_root() {
        for table in [WINDOWS, MACOS] {
            for (name, relative) in table {
                let first = tempfile::tempdir().unwrap();
                let second = tempfile::tempdir().unwrap();
                let roots = [first.path().to_path_buf(), second.path().to_path_buf()];
                assert_eq!(find(name, table, &roots), None);
                let installed = second.path().join(relative);
                std::fs::create_dir_all(installed.parent().unwrap()).unwrap();
                std::fs::write(&installed, "").unwrap();
                assert_eq!(find(name, table, &roots), Some(installed));
            }
        }
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
