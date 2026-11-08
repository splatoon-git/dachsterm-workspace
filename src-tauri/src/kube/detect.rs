//! Finds kubectl and a kubeconfig once, then checks them. Nothing here reads a kubeconfig's
//! contents, and every check runs as the account that logged in.
use super::{
    runner::{Failed, Kubectl, Runner},
    settings::{KubeSettings, check_context, check_kubectl, check_namespace},
    state::KubeState,
};
use crate::remote_exec::{Limits, quote};
use serde::Serialize;
use std::time::Duration;

const LOCATE: Limits = Limits {
    timeout: Duration::from_secs(8),
    max_output: 1024 * 1024,
};
const RKE2_KUBECTL: &str = "/var/lib/rancher/rke2/bin/kubectl";
const COPY_NAME: &str = ".kube/dachsterm.config";
/// Tried in this order after `$KUBECONFIG`. `~` stands for the account's home folder.
const KNOWN_CONFIGS: [&str; 5] = [
    "~/.kube/dachsterm.config",
    "~/.kube/config",
    "/etc/rancher/rke2/rke2.yaml",
    "/etc/rancher/k3s/k3s.yaml",
    "/etc/kubernetes/admin.conf",
];
const MAX_NAMES: usize = 5000;

pub enum Source {
    /// The session's stored choice. Fixed paths, no rc files.
    Saved(KubeSettings),
    Scan,
    Manual {
        kubectl: String,
        kubeconfig: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub state: KubeState,
    pub kubectl: String,
    pub kubeconfig: String,
    pub context: String,
    pub contexts: Vec<String>,
    pub namespaces: Vec<String>,
    /// The account may not list namespaces. It can still work in one it knows.
    pub namespaces_forbidden: bool,
    /// Typed in the server terminal when the account needs its own copy of a kubeconfig.
    pub copy_command: Option<String>,
    /// The stored choice this result checked, so the screen can open without asking again.
    pub saved: Option<KubeSettings>,
}

#[derive(Debug, Default, PartialEq)]
struct Environment {
    kubectl: Option<String>,
    kubeconfig: String,
    home: String,
}

fn clean_kubectl(value: &str) -> Option<String> {
    (value.starts_with('/') && !value.contains(' ') && check_kubectl(value).is_ok())
        .then(|| value.to_string())
}

/// `K=`, `C=` and `H=` lines. An alias or function reported for kubectl is not a path to run.
fn parse_environment(text: &str) -> Environment {
    let mut environment = Environment::default();
    for line in text.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(value) = line.strip_prefix("K=") {
            environment.kubectl = clean_kubectl(value);
        } else if let Some(value) = line.strip_prefix("C=") {
            environment.kubeconfig = value.to_string();
        } else if let Some(value) = line.strip_prefix("H=") {
            environment.home = value.to_string();
        }
    }
    environment
}

const REPORT: &str = "printf 'K=%s\\nC=%s\\nH=%s\\n' \"$(command -v kubectl 2>/dev/null)\" \"$KUBECONFIG\" \"$HOME\"";

/// What an interactive login shell knows. `</dev/null` keeps a `read` in an rc file from waiting
/// on a channel that never sends EOF. Only what lies between the two marks counts.
fn login_script(begin: &str, end: &str) -> String {
    let inner = format!("printf '%s\\n' {begin}; {REPORT}; printf '%s\\n' {end}");
    format!(
        "s=${{SHELL:-/bin/sh}}; \"$s\" -lic {} </dev/null 2>/dev/null",
        quote(&inner)
    )
}

fn between<'a>(text: &'a str, begin: &str, end: &str) -> Option<&'a str> {
    let start = text.find(begin)? + begin.len();
    let finish = start + text[start..].find(end)?;
    Some(&text[start..finish])
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Access {
    Readable,
    Unreadable,
    Missing,
}

/// One `R`, `U` or `N` line per path. A folder that cannot be entered makes `test -e` say the file
/// is missing, so such a parent counts as unreadable.
fn access_script(paths: &[String]) -> String {
    let check = "c() { if [ -e \"$1\" ]; then if [ -r \"$1\" ] && [ ! -d \"$1\" ]; then s=R; else s=U; fi; \
                 else d=$(dirname -- \"$1\"); if [ -d \"$d\" ] && [ ! -x \"$d\" ]; then s=U; else s=N; fi; fi; \
                 printf '%s %s\\n' \"$s\" \"$1\"; }";
    let calls: Vec<String> = paths
        .iter()
        .map(|path| format!("c {}", quote(path)))
        .collect();
    format!("{check}\n{}", calls.join("\n"))
}

fn parse_access(text: &str, path: &str) -> Access {
    text.lines()
        .filter_map(|line| line.strip_suffix('\r').unwrap_or(line).split_once(' '))
        .find(|(_, found)| *found == path)
        .map_or(Access::Missing, |(status, _)| match status {
            "R" => Access::Readable,
            "U" => Access::Unreadable,
            _ => Access::Missing,
        })
}

/// The stored choice or the user's input stand alone; a scan goes on to the known locations.
struct Search {
    primary: Vec<String>,
    known: Vec<String>,
    scanning: bool,
}
impl Search {
    fn paths(&self) -> Vec<String> {
        let mut all = self.primary.clone();
        for path in &self.known {
            if !all.contains(path) {
                all.push(path.clone());
            }
        }
        all
    }
}

#[derive(Debug, PartialEq)]
struct Choice {
    state: KubeState,
    kubeconfig: String,
}

/// `$KUBECONFIG` may list several files, and kubectl refuses all of them if one is unreadable, so
/// only the readable ones are kept. The first readable file wins so a private copy made after an
/// "unreadable" result is picked up even while `$KUBECONFIG` still points at the root-only file.
fn choose(search: &Search, text: &str) -> Choice {
    let access = |path: &String| parse_access(text, path);
    let readable: Vec<&str> = search
        .primary
        .iter()
        .filter(|path| access(path) == Access::Readable)
        .map(String::as_str)
        .collect();
    if !readable.is_empty() {
        return Choice {
            state: KubeState::Ready,
            kubeconfig: readable.join(":"),
        };
    }
    let fallback = if search.scanning {
        search.known.as_slice()
    } else {
        &[]
    };
    if let Some(path) = fallback
        .iter()
        .find(|path| access(path) == Access::Readable)
    {
        return Choice {
            state: KubeState::Ready,
            kubeconfig: path.clone(),
        };
    }
    match search
        .primary
        .iter()
        .chain(fallback)
        .find(|path| access(path) == Access::Unreadable)
    {
        Some(path) => Choice {
            state: KubeState::ConfigUnreadable,
            kubeconfig: path.clone(),
        },
        None => Choice {
            state: KubeState::ConfigMissing,
            kubeconfig: search.primary.first().cloned().unwrap_or_default(),
        },
    }
}

/// A root-only original the account could copy. Its own earlier copy is not a source.
fn copy_source(search: &Search, text: &str) -> Option<String> {
    search
        .paths()
        .into_iter()
        .filter(|path| !path.ends_with(COPY_NAME))
        .find(|path| parse_access(text, path) == Access::Unreadable)
}

/// `~/.kube/dachsterm.config` so an existing `~/.kube/config` is never overwritten.
fn copy_command(source: &str) -> String {
    format!(
        "mkdir -p ~/.kube && sudo install -m 600 -o \"$(id -u)\" -g \"$(id -g)\" {} ~/.kube/dachsterm.config",
        quote(source)
    )
}

fn known_paths(home: &str) -> Vec<String> {
    KNOWN_CONFIGS
        .iter()
        .filter_map(|path| match path.strip_prefix('~') {
            Some(rest) if home.starts_with('/') => Some(format!("{home}{rest}")),
            Some(_) => None,
            None => Some((*path).to_string()),
        })
        .collect()
}

fn split_config(value: &str) -> Vec<String> {
    value
        .split(':')
        .filter(|entry| entry.starts_with('/') && !entry.chars().any(char::is_control))
        .map(String::from)
        .collect()
}

fn names(text: &str, check: fn(&str) -> Result<(), String>, strip: &str) -> Vec<String> {
    text.lines()
        .map(|line| line.trim().strip_prefix(strip).unwrap_or(line.trim()))
        .filter(|name| !name.is_empty() && check(name).is_ok())
        .take(MAX_NAMES)
        .map(String::from)
        .collect()
}

/// Anything but "the server refused a channel" just means this step found nothing.
async fn lines(runner: &Runner<'_>, script: &str) -> Result<Option<String>, KubeState> {
    match runner.script(script, LOCATE).await {
        Ok(output) => Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned())),
        Err(Failed::ChannelLimit) => Err(KubeState::ChannelLimit),
        Err(Failed::Stopped(_)) => Ok(None),
    }
}

fn unique_mark() -> String {
    format!("DACHSTERM-KUBE-{}", uuid::Uuid::new_v4().simple())
}

async fn from_login_shell(runner: &Runner<'_>) -> Result<Environment, KubeState> {
    let (begin, end) = (unique_mark(), unique_mark());
    let text = lines(runner, &login_script(&begin, &end)).await?;
    Ok(text
        .as_deref()
        .and_then(|text| between(text, &begin, &end))
        .map(parse_environment)
        .unwrap_or_default())
}

struct Located {
    kubectl: Option<String>,
    search: Search,
}

async fn locate(runner: &Runner<'_>, source: &Source) -> Result<Located, KubeState> {
    let text = lines(runner, REPORT)
        .await?
        .ok_or_else(|| KubeState::Unknown {
            message: "이 서버에서는 원격 명령을 실행할 수 없습니다.".into(),
        })?;
    let plain = parse_environment(&text);
    let known = known_paths(&plain.home);
    let given = |kubectl: &str, kubeconfig: &str| Located {
        kubectl: Some(kubectl.to_string()),
        search: Search {
            primary: split_config(kubeconfig),
            known: known.clone(),
            scanning: false,
        },
    };
    match source {
        Source::Saved(saved) => Ok(given(&saved.kubectl, &saved.kubeconfig)),
        Source::Manual {
            kubectl,
            kubeconfig,
        } => Ok(given(kubectl, kubeconfig)),
        Source::Scan => {
            // A `.bashrc` often holds only one of the two, so either one missing asks the shell.
            let login = if plain.kubectl.is_none() || plain.kubeconfig.is_empty() {
                from_login_shell(runner).await?
            } else {
                Environment::default()
            };
            let mut kubectl = plain.kubectl.or(login.kubectl);
            if kubectl.is_none()
                && lines(runner, &format!("[ -x {RKE2_KUBECTL} ] && echo found"))
                    .await?
                    .is_some_and(|text| text.contains("found"))
            {
                kubectl = Some(RKE2_KUBECTL.into());
            }
            let env = if plain.kubeconfig.is_empty() {
                login.kubeconfig
            } else {
                plain.kubeconfig
            };
            Ok(Located {
                kubectl,
                search: Search {
                    primary: split_config(&env),
                    known,
                    scanning: true,
                },
            })
        }
    }
}

fn chosen_context(
    asked: Option<&str>,
    contexts: &[String],
    current: Option<&str>,
) -> Option<String> {
    match asked {
        Some(name) => contexts.iter().find(|c| *c == name).cloned(),
        None => current
            .filter(|name| contexts.iter().any(|c| c == name))
            .map(String::from)
            .or_else(|| contexts.first().cloned()),
    }
}

async fn fill(
    runner: &Runner<'_>,
    source: &Source,
    context: Option<&str>,
    found: &mut Detection,
) -> Result<(), KubeState> {
    let located = locate(runner, source).await?;
    found.kubectl = located.kubectl.ok_or(KubeState::KubectlMissing)?;
    let without_config = located.search.primary.is_empty()
        && matches!(source, Source::Manual { kubeconfig, .. } if kubeconfig.is_empty());
    if !without_config {
        let text = lines(runner, &access_script(&located.search.paths()))
            .await?
            .ok_or_else(|| KubeState::Unknown {
                message: "kubeconfig를 확인하지 못했습니다.".into(),
            })?;
        let choice = choose(&located.search, &text);
        found.kubeconfig = choice.kubeconfig;
        found.copy_command = copy_source(&located.search, &text).map(|path| copy_command(&path));
        if choice.state != KubeState::Ready {
            return Err(choice.state);
        }
    }
    let kubectl = Kubectl {
        command: &found.kubectl,
        kubeconfig: &found.kubeconfig,
    };
    let listed = runner
        .kubectl(&kubectl.local("config get-contexts -o name"))
        .await?;
    found.contexts = names(&String::from_utf8_lossy(&listed.stdout), check_context, "");
    let current = match runner
        .kubectl(&kubectl.local("config current-context"))
        .await
    {
        Ok(output) => Some(String::from_utf8_lossy(&output.stdout).trim().to_string()),
        Err(KubeState::ChannelLimit) => return Err(KubeState::ChannelLimit),
        Err(_) => None,
    };
    let asked = context.or(match source {
        Source::Saved(saved) => Some(saved.context.as_str()),
        _ => None,
    });
    found.context = chosen_context(asked, &found.contexts, current.as_deref())
        .ok_or(KubeState::ContextMissing)?;
    match runner
        .kubectl(&kubectl.cluster(&found.context, "get namespaces -o name"))
        .await
    {
        Ok(output) => {
            found.namespaces = names(
                &String::from_utf8_lossy(&output.stdout),
                check_namespace,
                "namespace/",
            );
            Ok(())
        }
        Err(KubeState::Forbidden) => {
            found.namespaces_forbidden = true;
            Ok(())
        }
        Err(state) => Err(state),
    }
}

/// Runs in sequence, so it occupies one channel at a time.
pub async fn detect(runner: &Runner<'_>, source: Source, context: Option<&str>) -> Detection {
    let mut found = Detection {
        state: KubeState::Ready,
        kubectl: String::new(),
        kubeconfig: String::new(),
        context: String::new(),
        contexts: Vec::new(),
        namespaces: Vec::new(),
        namespaces_forbidden: false,
        copy_command: None,
        saved: match &source {
            Source::Saved(saved) => Some(saved.clone()),
            _ => None,
        },
    };
    if let Err(state) = fill(runner, &source, context, &mut found).await {
        found.state = state;
    }
    found
}

#[cfg(test)]
mod tests;
