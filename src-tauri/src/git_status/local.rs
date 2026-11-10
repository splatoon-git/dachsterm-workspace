//! Git status of a folder in a local or WSL tab (DX.15). The query, limits and result are those
//! of a remote folder; `git_run` decides where Git runs. What is left here is the spelling of the
//! root, which only this PC's git needs.
use super::GitStatus;
use crate::{AppState, git_run::GitHost, storage::Result};

/// The repository root in the folder's own spelling, so the app can match the shell's folders
/// and the file panel's rows against it. Git prints the real path instead, which differs for a
/// Windows short name (`ADMINI~1`), a `subst` drive or a symbolic link on the way. Removing the
/// prefix Git reports from the folder gives the same root as the shell sees it.
pub(super) fn root_as_shell_spells(folder: &str, rev_parse: &str) -> String {
    let mut lines = rev_parse.lines().map(|l| l.trim_end_matches('\r'));
    let toplevel = lines.next().unwrap_or_default().to_string();
    let depth = lines
        .next()
        .unwrap_or_default()
        .split('/')
        .filter(|s| !s.is_empty())
        .count();
    let mut spelled = folder.to_string();
    if cfg!(windows) {
        spelled = spelled.replace('\\', "/");
        if spelled.as_bytes().get(1) == Some(&b':') {
            spelled[..1].make_ascii_uppercase();
        }
    }
    let mut parts: Vec<&str> = spelled.trim_end_matches('/').split('/').collect();
    // A folder shorter than its own prefix cannot be cut; Git's own path is used then.
    if parts.len() <= depth {
        return toplevel;
    }
    parts.truncate(parts.len() - depth);
    match parts.join("/") {
        root if root.is_empty() || root.ends_with(':') => format!("{root}/"),
        root => root,
    }
}

#[tauri::command]
pub async fn local_git_status(
    state: tauri::State<'_, AppState>,
    target_id: String,
    folder: String,
    untracked_files: bool,
) -> Result<GitStatus> {
    let target = state.locals.target(&target_id)?;
    super::query(&GitHost::local(target).await?, &folder, untracked_files).await
}

#[cfg(test)]
mod tests {
    use super::root_as_shell_spells;
    use crate::{
        git_run::GitHost,
        git_status::{self, GitStatus},
        local::Target,
    };

    async fn query(target: &Target, folder: &str) -> Result<GitStatus, String> {
        git_status::query(&GitHost::local(target.clone()).await?, folder, false).await
    }

    #[test]
    fn the_root_keeps_the_folder_spelling() {
        let real = "/real/repo\nsrc/deep/\n";
        assert_eq!(
            root_as_shell_spells("/link/repo/src/deep", real),
            "/link/repo"
        );
        assert_eq!(
            root_as_shell_spells("/link/repo/src/deep/", real),
            "/link/repo"
        );
        assert_eq!(
            root_as_shell_spells("/link/repo", "/real/repo\n\n"),
            "/link/repo"
        );
        assert_eq!(root_as_shell_spells("/src", "/\nsrc/\n"), "/");
        assert_eq!(root_as_shell_spells("/", "/\n\n"), "/");
        assert_eq!(root_as_shell_spells("/a", "/r\nx/y/z/\n"), "/r");
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_root_keeps_short_names_and_uses_slashes() {
        let real = "C:/Users/Administrator/repo\nsrc/\n";
        assert_eq!(
            root_as_shell_spells(r"c:\Users\ADMINI~1\repo\src", real),
            "C:/Users/ADMINI~1/repo"
        );
        assert_eq!(root_as_shell_spells(r"C:\src", "C:/\nsrc/\n"), "C:/");
        assert_eq!(root_as_shell_spells(r"D:\", "D:/\n\n"), "D:/");
    }

    fn git(folder: &std::path::Path, args: &[&str]) {
        let program = crate::git_credential::git_program().unwrap();
        let status = std::process::Command::new(program)
            .current_dir(folder)
            .args(args)
            .output()
            .unwrap();
        assert!(status.status.success(), "{args:?}");
    }

    /// Runs this PC's real git; skipped where none is installed.
    #[tokio::test]
    async fn reads_a_real_repository_and_quietly_skips_other_folders() {
        if crate::git_credential::git_program().is_none() {
            return;
        }
        let base = std::env::temp_dir().join(format!("dachsterm-git-{}", std::process::id()));
        let repo = base.join("repo 한글");
        std::fs::create_dir_all(repo.join("src")).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        std::fs::write(repo.join("src").join("new.txt"), "x").unwrap();
        let shell = Target::for_test("shell", "shell");
        let inside = repo.join("src");
        match query(&shell, inside.to_str().unwrap()).await.unwrap() {
            GitStatus::Repo {
                root,
                branch,
                entries,
                ..
            } => {
                // The temporary folder may be a Windows short name, which Git expands.
                assert!(root.ends_with("/repo 한글"), "{root}");
                assert!(
                    root.starts_with('/') || root.as_bytes()[1] == b':',
                    "{root}"
                );
                assert_eq!(branch.as_deref(), Some("main"));
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].path, "src/");
            }
            other => panic!("{other:?}"),
        }
        let outside = query(&shell, base.to_str().unwrap()).await.unwrap();
        assert!(matches!(outside, GitStatus::NotRepo { .. }), "{outside:?}");
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// A repository set up by someone else. The new content has the same size, or Git would know
    /// the file changed without reading it through the filter. A
    /// plain `git status` runs the program in this config.
    #[cfg(unix)]
    fn repository_with_filter(name: &str, extra: &[(&str, &str)]) -> std::path::PathBuf {
        let base =
            std::env::temp_dir().join(format!("dachsterm-filter-{name}-{}", std::process::id()));
        let repo = base.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.name", "test"]);
        git(&repo, &["config", "user.email", "test@example.invalid"]);
        std::fs::write(repo.join("f.txt"), "one\n").unwrap();
        git(&repo, &["add", "f.txt"]);
        git(&repo, &["commit", "-q", "-m", "first"]);
        let marker = base.join("ran");
        let program = format!("touch '{}'; cat", marker.display());
        git(
            &repo,
            &["config", &format!("filter.{name}.clean"), &program],
        );
        for (key, value) in extra {
            git(&repo, &["config", key, value]);
        }
        std::fs::write(
            repo.join(".gitattributes"),
            format!("f.txt filter={name}\n"),
        )
        .unwrap();
        std::fs::write(repo.join("f.txt"), "two\n").unwrap();
        repo
    }

    /// Unix only: the filter is a shell line and marks the base folder.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_repositorys_own_filter_does_not_run_when_a_tab_shows_it() {
        if crate::git_credential::git_program().is_none() {
            return;
        }
        let shell = Target::for_test("shell", "shell");
        for (name, extra) in [
            ("plain", &[][..]),
            ("needed", &[("filter.needed.required", "true")][..]),
        ] {
            let repo = repository_with_filter(name, extra);
            let base = repo.parent().unwrap().to_path_buf();
            let result = query(&shell, repo.to_str().unwrap()).await.unwrap();
            match result {
                GitStatus::Repo { entries, .. } => {
                    assert!(entries.iter().any(|e| e.path == "f.txt"), "{entries:?}");
                }
                other => panic!("{other:?}"),
            }
            let view = git_status::view::query(
                &GitHost::local(shell.clone()).await.unwrap(),
                repo.to_str().unwrap(),
            )
            .await
            .unwrap();
            assert!(
                !base.join("ran").exists(),
                "{name}: the filter ran: {view:?}"
            );
            std::fs::remove_dir_all(&base).unwrap();
        }
    }

    /// `git -c` splits at the first `=`, so this filter could not be turned off and must not run.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_filter_that_cannot_be_turned_off_stops_the_query() {
        if crate::git_credential::git_program().is_none() {
            return;
        }
        let repo = repository_with_filter("a=b", &[]);
        let base = repo.parent().unwrap().to_path_buf();
        let shell = Target::for_test("shell", "shell");
        assert!(query(&shell, repo.to_str().unwrap()).await.is_err());
        assert!(!base.join("ran").exists());
        std::fs::remove_dir_all(&base).unwrap();
    }

    /// Needs a WSL distribution with git: `DACHSTERM_WSL=<name> cargo test ... -- --ignored`.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore]
    async fn reads_a_repository_inside_wsl() {
        let name = std::env::var("DACHSTERM_WSL").expect("DACHSTERM_WSL");
        let wsl = std::path::PathBuf::from(std::env::var("SystemRoot").unwrap())
            .join("System32")
            .join("wsl.exe");
        let mut target = Target::for_test(&format!("wsl:{name}"), "wsl");
        target.program = wsl.clone();
        let folder = format!("/tmp/dachsterm git {} it's", std::process::id());
        let setup = "mkdir -p \"$1/src\" && cd \"$1\" && git init -q && touch src/new.txt";
        let made = std::process::Command::new(&wsl)
            .args([
                "--distribution",
                &name,
                "--exec",
                "sh",
                "-c",
                setup,
                "sh",
                &folder,
            ])
            .output()
            .unwrap();
        assert!(made.status.success(), "{made:?}");
        match query(&target, &format!("{folder}/src")).await.unwrap() {
            GitStatus::Repo { root, entries, .. } => {
                assert_eq!(root, folder);
                assert_eq!(entries[0].path, "src/");
            }
            other => panic!("{other:?}"),
        }
        let outside = query(&target, "/").await.unwrap();
        assert!(matches!(outside, GitStatus::NotRepo { .. }), "{outside:?}");
        std::process::Command::new(&wsl)
            .args(["--distribution", &name, "--exec", "rm", "-rf", &folder])
            .status()
            .unwrap();
    }
}
