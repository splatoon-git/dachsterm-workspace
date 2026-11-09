//! Finding kubectl and a kubeconfig on this computer, for a local cluster (design KV.11). What the
//! shell knows is already in this process (`login_path`, macOS), so this only looks.
use super::{Located, Search, Source};
use crate::kube::settings::LOCAL_CONFIG_SEPARATOR;
use std::{
    ffi::OsString,
    fs::File,
    path::{Path, PathBuf},
};

const KUBECTL: &str = if cfg!(windows) {
    "kubectl.exe"
} else {
    "kubectl"
};
const KUBE_CONFIG: &str = ".kube/config";

/// Where tools install kubectl without adding it to `PATH`. `~` stands for the home folder.
#[cfg(windows)]
const KNOWN_FOLDERS: [&str; 1] = [r"C:\Program Files\Docker\Docker\resources\bin"];
#[cfg(not(windows))]
const KNOWN_FOLDERS: [&str; 4] = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "~/.rd/bin",
    "/Applications/Docker.app/Contents/Resources/bin",
];

fn home() -> Option<PathBuf> {
    let name = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
}

fn expand(folder: &str, home: Option<&Path>) -> Option<PathBuf> {
    match folder.strip_prefix("~/") {
        Some(rest) => home.map(|home| home.join(rest)),
        None => Some(PathBuf::from(folder)),
    }
}

#[cfg(unix)]
fn runnable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}
#[cfg(not(unix))]
fn runnable(path: &Path) -> bool {
    path.is_file()
}

/// Always an absolute path: a Finder-launched app must not run a bare name (rules §11).
fn find_kubectl(path: Option<OsString>, home: Option<&Path>) -> Option<String> {
    let listed = path
        .iter()
        .flat_map(std::env::split_paths)
        .filter(|folder| folder.is_absolute())
        .collect::<Vec<_>>();
    let known = KNOWN_FOLDERS
        .iter()
        .filter_map(|folder| expand(folder, home));
    listed
        .into_iter()
        .chain(known)
        .map(|folder| folder.join(KUBECTL))
        .find(|candidate| runnable(candidate))
        .map(|found| found.to_string_lossy().into_owned())
}

fn split_list(value: &str) -> Vec<String> {
    value
        .split(LOCAL_CONFIG_SEPARATOR)
        .filter(|entry| Path::new(entry).is_absolute() && !entry.chars().any(char::is_control))
        .map(String::from)
        .collect()
}

fn known_configs(home: Option<&Path>) -> Vec<String> {
    home.map(|home| home.join(KUBE_CONFIG).to_string_lossy().into_owned())
        .into_iter()
        .collect()
}

pub(super) fn locate(source: &Source) -> Located {
    let home = home();
    let known = known_configs(home.as_deref());
    let given = |kubectl: &str, kubeconfig: &str| Located {
        kubectl: Some(kubectl.to_string()),
        search: Search {
            primary: split_list(kubeconfig),
            known: known.clone(),
            scanning: false,
            separator: LOCAL_CONFIG_SEPARATOR,
        },
    };
    match source {
        Source::Saved(saved) => given(&saved.kubectl, &saved.kubeconfig),
        Source::Manual {
            kubectl,
            kubeconfig,
        } => given(kubectl, kubeconfig),
        Source::Scan => Located {
            kubectl: find_kubectl(std::env::var_os("PATH"), home.as_deref()),
            search: Search {
                primary: split_list(&std::env::var("KUBECONFIG").unwrap_or_default()),
                known: known.clone(),
                scanning: true,
                separator: LOCAL_CONFIG_SEPARATOR,
            },
        },
    }
}

/// The report `choose` reads, in the form a server's `access_script` writes it.
pub(super) fn access_report(paths: &[String]) -> String {
    paths
        .iter()
        .map(|path| format!("{} {path}\n", access(Path::new(path))))
        .collect()
}

fn access(path: &Path) -> char {
    match File::open(path).and_then(|file| file.metadata()) {
        Ok(meta) if meta.is_file() => 'R',
        Ok(_) => 'U',
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => 'U',
        Err(_) => 'N',
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::kube::detect::{KubeState, choose};
    use std::os::unix::fs::PermissionsExt;

    fn tool(dir: &Path, name: &str, mode: u32) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    #[test]
    fn kubectl_is_found_as_an_absolute_path_in_listed_folders() {
        let dir = tempfile::tempdir().unwrap();
        let found = tool(dir.path(), "kubectl", 0o755);
        let path = std::env::join_paths(["relative/bin".as_ref(), dir.path()]).unwrap();
        assert_eq!(
            find_kubectl(Some(path), None).as_deref(),
            found.to_str(),
            "a relative PATH entry must not win"
        );
    }

    #[test]
    fn a_file_that_cannot_run_is_not_kubectl() {
        let dir = tempfile::tempdir().unwrap();
        tool(dir.path(), "kubectl", 0o644);
        let path = dir.path().as_os_str().to_owned();
        // KNOWN_FOLDERS may still find a real one on a developer's machine.
        assert_ne!(
            find_kubectl(Some(path), None),
            Some(dir.path().join("kubectl").to_string_lossy().into_owned())
        );
    }

    #[test]
    fn a_tilde_folder_needs_a_home() {
        assert_eq!(expand("~/.rd/bin", None), None);
        assert_eq!(
            expand("~/.rd/bin", Some(Path::new("/h"))),
            Some(PathBuf::from("/h/.rd/bin"))
        );
    }

    #[test]
    fn the_access_report_is_what_choose_reads() {
        let dir = tempfile::tempdir().unwrap();
        let readable = tool(dir.path(), "a config", 0o600);
        let secret = dir.path().join("secret");
        std::fs::create_dir(&secret).unwrap();
        let missing = dir.path().join("missing");
        let paths: Vec<String> = [&readable, &secret, &missing]
            .iter()
            .map(|path| path.to_string_lossy().into_owned())
            .collect();
        let report = access_report(&paths);
        let search = Search {
            primary: paths.clone(),
            known: Vec::new(),
            scanning: false,
            separator: LOCAL_CONFIG_SEPARATOR,
        };
        let choice = choose(&search, &report);
        assert_eq!(choice.state, KubeState::Ready);
        assert_eq!(choice.kubeconfig, paths[0]);
    }

    #[test]
    fn a_folder_is_not_a_readable_config() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(access(dir.path()), 'U');
        assert_eq!(access(&dir.path().join("none")), 'N');
    }

    /// The whole local path with a stand-in kubectl, which answers the way the real one does.
    #[tokio::test]
    async fn detection_runs_the_kubectl_it_was_given_with_the_kubeconfig_it_found() {
        use crate::kube::{detect::detect, runner::Runner};
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("calls");
        let body = format!(
            "#!/bin/sh\necho \"$KUBECONFIG|$*\" >> {log}\ncase \"$*\" in\n\
             'config get-contexts -o name') printf 'kind-a\\nkind-b\\n';;\n\
             'config current-context') printf 'kind-b\\n';;\n\
             *'get namespaces'*) printf 'namespace/default\\nnamespace/web\\n';;\nesac\n",
            log = log.display()
        );
        let kubectl = dir.path().join("kubectl");
        std::fs::write(&kubectl, body).unwrap();
        std::fs::set_permissions(&kubectl, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = dir.path().join("my config");
        std::fs::write(&config, "x").unwrap();
        let config = config.to_string_lossy().into_owned();

        let found = detect(
            &Runner::Local { kubectl: "" },
            Source::Manual {
                kubectl: kubectl.to_string_lossy().into_owned(),
                kubeconfig: config.clone(),
            },
            None,
        )
        .await;

        assert_eq!(found.state, KubeState::Ready);
        assert_eq!(found.kubeconfig, config);
        assert_eq!(found.context, "kind-b");
        assert_eq!(found.namespaces, ["default", "web"]);
        assert_eq!(found.copy_command, None);
        let calls = std::fs::read_to_string(log).unwrap();
        assert!(
            calls
                .lines()
                .all(|line| line.starts_with(&format!("{config}|"))),
            "{calls}"
        );
    }

    #[test]
    fn a_kubeconfig_list_keeps_absolute_entries() {
        assert_eq!(split_list("/a/b:relative::/c d"), ["/a/b", "/c d"]);
    }
}
