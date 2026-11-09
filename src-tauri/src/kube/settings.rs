//! What a session stores about its cluster. Paths and names only: a kubeconfig's contents never
//! reach the app (design §6).
use crate::storage::Result;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Workspace {
    #[default]
    Terminal,
    Kubernetes,
}
impl Workspace {
    pub fn is_terminal(&self) -> bool {
        *self == Workspace::Terminal
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KubeSettings {
    pub context: String,
    /// Empty means every namespace.
    pub namespace: String,
    pub kubectl: String,
    /// A path on the server. Empty leaves kubectl to its own default.
    pub kubeconfig: String,
    /// `kube_action` reads the stored value (KV.6). Only `kube_set_operate_mode` changes it.
    #[serde(default)]
    pub operate: bool,
}
impl KubeSettings {
    pub fn validate(&self) -> Result<()> {
        check_context(&self.context)?;
        check_namespace(&self.namespace)?;
        check_kubectl(&self.kubectl)?;
        check_kubeconfig(&self.kubeconfig)
    }

    /// A local cluster's kubectl runs on this computer, with no shell in the way.
    pub fn validate_local(&self) -> Result<()> {
        check_context(&self.context)?;
        check_namespace(&self.namespace)?;
        check_local_kubectl(&self.kubectl)?;
        check_local_kubeconfig(&self.kubeconfig)
    }
}

pub const MAX_NAME: usize = 512;

pub fn check_context(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > MAX_NAME || name.chars().any(char::is_control) {
        return Err("context 이름이 올바르지 않습니다.".into());
    }
    Ok(())
}

/// A DNS label, or empty for every namespace.
pub fn check_namespace(name: &str) -> Result<()> {
    let edge = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    let valid = name.is_empty()
        || (name.len() <= 63
            && name.starts_with(edge)
            && name.ends_with(edge)
            && name.chars().all(|c| edge(c) || c == '-'));
    if valid {
        Ok(())
    } else {
        Err("namespace 이름이 올바르지 않습니다.".into())
    }
}

/// A pod name, from the cluster or the screen: DNS subdomain rules.
pub fn check_pod(name: &str) -> Result<()> {
    let edge = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
    let valid = name.len() <= 253
        && name.starts_with(edge)
        && name.ends_with(edge)
        && name.chars().all(|c| edge(c) || c == '-' || c == '.');
    if valid {
        Ok(())
    } else {
        Err("파드 이름이 올바르지 않습니다.".into())
    }
}

/// A node name is a DNS subdomain, the same rule as a pod's.
pub fn check_node(name: &str) -> Result<()> {
    check_pod(name).map_err(|_| "노드 이름이 올바르지 않습니다.".to_string())
}

/// A DNS label, the same rule as a namespace except that it cannot be empty.
pub fn check_container(name: &str) -> Result<()> {
    if name.is_empty() || check_namespace(name).is_err() {
        return Err("컨테이너 이름이 올바르지 않습니다.".into());
    }
    Ok(())
}

/// What `kubectl logs --timestamps` prints before each line, and what `--since-time` takes:
/// RFC 3339, with a `Z` or a numeric offset such as `+09:00`.
pub fn is_log_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    (20..=40).contains(&bytes.len())
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && value
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '-' | ':' | '.' | '+' | 'T' | 'Z'))
}

/// The word is written into a command line, so only characters that mean nothing to a shell pass.
fn plain_word(word: &str) -> bool {
    !word.is_empty()
        && word
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-' | '+'))
}

/// An absolute path or a command such as `microk8s kubectl`. The app never runs `sudo` itself.
pub fn check_kubectl(command: &str) -> Result<()> {
    let words: Vec<&str> = command.split(' ').collect();
    if command.len() > 4096 || words.len() > 2 || !words.iter().all(|word| plain_word(word)) {
        return Err(
            "kubectl 명령은 경로나 두 단어까지 쓸 수 있고 셸 특수 문자는 넣을 수 없습니다.".into(),
        );
    }
    let program = words[0].rsplit('/').next().unwrap_or_default();
    if matches!(program, "sudo" | "doas" | "su" | "pkexec") {
        return Err(
            "앱은 sudo를 실행하지 않습니다. 접속한 계정으로 동작하는 명령을 넣으세요.".into(),
        );
    }
    Ok(())
}

pub fn check_kubeconfig(path: &str) -> Result<()> {
    if path.len() > 4096
        || path.chars().any(char::is_control)
        || !path
            .split(':')
            .all(|entry| path.is_empty() || entry.starts_with('/'))
    {
        return Err("kubeconfig는 서버의 절대 경로로 넣으세요.".into());
    }
    Ok(())
}

/// An absolute path to something named kubectl: the path decides what runs on this computer, and
/// it comes from the screen with every call. Spaces are fine, because no shell reads it.
pub fn check_local_kubectl(path: &str) -> Result<()> {
    let bad = || "kubectl 실행 파일의 절대 경로를 넣으세요.".to_string();
    let file = std::path::Path::new(path);
    if path.len() > 4096 || path.chars().any(char::is_control) || !file.is_absolute() {
        return Err(bad());
    }
    let name = file
        .file_name()
        .map(|name| name.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name.starts_with("kubectl") {
        Ok(())
    } else {
        Err(bad())
    }
}

pub const LOCAL_CONFIG_SEPARATOR: char = if cfg!(windows) { ';' } else { ':' };

/// Empty, or absolute paths joined the way this computer's `KUBECONFIG` joins them.
pub fn check_local_kubeconfig(paths: &str) -> Result<()> {
    if paths.len() > 4096
        || paths.chars().any(char::is_control)
        || !paths
            .split(LOCAL_CONFIG_SEPARATOR)
            .all(|entry| paths.is_empty() || std::path::Path::new(entry).is_absolute())
    {
        return Err("kubeconfig는 이 컴퓨터의 절대 경로로 넣으세요.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_local_kubectl_is_an_absolute_path_to_kubectl() {
        let good = if cfg!(windows) {
            vec![r"C:\Program Files\Docker\kubectl.exe", r"C:\k\kubectl.exe"]
        } else {
            vec![
                "/usr/local/bin/kubectl",
                "/Applications/Rancher Desktop.app/bin/kubectl",
            ]
        };
        for path in good {
            assert!(check_local_kubectl(path).is_ok(), "{path}");
        }
        for path in ["kubectl", "bin/kubectl", "/usr/bin/python3", "/k\n", ""] {
            assert!(check_local_kubectl(path).is_err(), "{path:?}");
        }
    }

    #[test]
    fn a_local_kubeconfig_is_empty_or_absolute() {
        assert!(check_local_kubeconfig("").is_ok());
        assert!(check_local_kubeconfig("relative").is_err());
        if cfg!(windows) {
            assert!(check_local_kubeconfig(r"C:\config;D:").is_ok());
        } else {
            assert!(check_local_kubeconfig("/a b/c:/d").is_ok());
            assert!(check_local_kubeconfig("/a:relative").is_err());
        }
    }

    #[test]
    fn kubectl_takes_a_path_or_two_plain_words() {
        for good in [
            "kubectl",
            "/var/lib/rancher/rke2/bin/kubectl",
            "microk8s kubectl",
            "k3s kubectl",
        ] {
            assert!(check_kubectl(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "a b c",
            "kubectl;reboot",
            "kubectl $(id)",
            "kubectl `id`",
            "kubectl|cat",
            "kubectl > /tmp/x",
            "kubectl  double",
            "~/bin/kubectl",
            "kubectl\n",
            "sudo kubectl",
            "/usr/bin/sudo kubectl",
            "doas kubectl",
        ] {
            assert!(check_kubectl(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn kubeconfig_is_empty_or_absolute() {
        for good in ["", "/etc/rancher/rke2/rke2.yaml", "/a b/c", "/a:/b"] {
            assert!(check_kubeconfig(good).is_ok(), "{good}");
        }
        for bad in ["relative", "~/.kube/config", "/a:relative", "/a\nb"] {
            assert!(check_kubeconfig(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn namespaces_follow_the_kubernetes_name_rule() {
        for good in ["", "default", "a", "kube-system", "a1-b2"] {
            assert!(check_namespace(good).is_ok(), "{good}");
        }
        for bad in ["-a", "a-", "A", "a_b", "a b", &"a".repeat(64)] {
            assert!(check_namespace(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn pods_and_containers_follow_the_kubernetes_name_rules() {
        for good in ["a", "web-8544d7896d-hfw9p", "web-0", "pod.with.dots"] {
            assert!(check_pod(good).is_ok(), "{good}");
        }
        for bad in ["", "-a", "a-", "A", "a b", "a;b", "$(id)", "a\nb"] {
            assert!(check_pod(bad).is_err(), "{bad:?}");
            assert!(check_container(bad).is_err(), "{bad:?}");
        }
        assert!(check_container("main").is_ok());
        assert!(check_container("a.b").is_err());
    }

    #[test]
    fn log_times_are_rfc3339_and_nothing_else() {
        for good in [
            "2026-11-08T12:00:00.123456789Z",
            "2026-11-08T21:00:00.123456789+09:00",
            "2026-11-08T12:00:00Z",
        ] {
            assert!(is_log_time(good), "{good}");
        }
        for bad in [
            "",
            "yesterday",
            "2026-11-08T12:00:00Z;reboot",
            "$(reboot)",
            "2026-11-08 12:00:00Z",
        ] {
            assert!(!is_log_time(bad), "{bad:?}");
        }
    }

    #[test]
    fn contexts_allow_the_characters_real_names_use() {
        for good in [
            "kind-dev",
            "kubernetes-admin@kubernetes",
            "arn:aws:eks:ap-northeast-2:1:cluster/x",
        ] {
            assert!(check_context(good).is_ok(), "{good}");
        }
        assert!(check_context("").is_err());
        assert!(check_context("a\nb").is_err());
    }
}
