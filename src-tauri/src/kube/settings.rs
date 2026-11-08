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
    /// Only `kube_action` will read this (KV.6). Saving from the setup screen keeps the stored value.
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

#[cfg(test)]
mod tests {
    use super::*;

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
