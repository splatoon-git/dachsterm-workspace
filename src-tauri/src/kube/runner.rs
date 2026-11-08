//! Builds kubectl command lines and runs scripts where the cluster's kubectl lives.
use super::state::{KubeState, classify};
use crate::{
    remote_exec::{self, Limits, Output, Refusable, quote},
    ssh::Host,
};
use russh::client;
use std::time::Duration;

/// Longer than `--request-timeout`, which retries turn into about 36 seconds when an API server
/// does not answer (KV.0). Closing the channel at this limit is what actually ends the wait.
const KUBECTL: Limits = Limits {
    timeout: Duration::from_secs(12),
    max_output: 1024 * 1024,
};

/// `Local` joins this in KV.11.
pub enum Runner<'a> {
    Ssh(&'a client::Handle<Host>),
}

pub struct Kubectl<'a> {
    pub command: &'a str,
    pub kubeconfig: &'a str,
}
impl Kubectl<'_> {
    /// `command` has passed `check_kubectl`, so its words need no quoting and may be two words.
    fn prefix(&self) -> String {
        if self.kubeconfig.is_empty() {
            self.command.to_string()
        } else {
            format!("KUBECONFIG={} {}", quote(self.kubeconfig), self.command)
        }
    }
    /// Reads the kubeconfig on the server. There is no cluster to time out against.
    pub fn local(&self, args: &str) -> String {
        format!("{} {args}", self.prefix())
    }
    /// Always names the context: the global current-context is neither used nor changed.
    pub fn cluster(&self, context: &str, args: &str) -> String {
        format!(
            "{} --context {} --request-timeout=8s {args}",
            self.prefix(),
            quote(context),
        )
    }
}

pub enum Failed {
    /// The script could not start or finish; the caller decides whether that matters.
    Stopped(remote_exec::Failure),
    ChannelLimit,
}

impl Runner<'_> {
    pub async fn script(&self, script: &str, limits: Limits) -> Result<Output, Failed> {
        let Runner::Ssh(handle) = self;
        remote_exec::run_refusable(handle, script, limits)
            .await
            .map_err(|failure| match failure {
                Refusable::ChannelRefused => Failed::ChannelLimit,
                Refusable::Failure(failure) => Failed::Stopped(failure),
            })
    }

    /// Runs a kubectl command and returns its stdout, or the state that stopped it.
    pub async fn kubectl(&self, command: &str) -> Result<Output, KubeState> {
        let output = self
            .script(command, KUBECTL)
            .await
            .map_err(|failed| match failed {
                Failed::ChannelLimit => KubeState::ChannelLimit,
                Failed::Stopped(remote_exec::Failure::TimedOut) => KubeState::Unreachable,
                Failed::Stopped(failure) => KubeState::Unknown {
                    message: String::from(failure),
                },
            })?;
        match classify(output.exit, &output.stderr) {
            KubeState::Ready => Ok(output),
            state => Err(state),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Kubectl;

    #[test]
    fn every_call_names_its_config_and_context() {
        let kubectl = Kubectl {
            command: "/opt/kubectl",
            kubeconfig: "/etc/a b.yaml",
        };
        assert_eq!(
            kubectl.cluster("kind-x", "get namespaces -o name"),
            "KUBECONFIG='/etc/a b.yaml' /opt/kubectl --context 'kind-x' --request-timeout=8s get namespaces -o name"
        );
        assert_eq!(
            kubectl.local("config current-context"),
            "KUBECONFIG='/etc/a b.yaml' /opt/kubectl config current-context"
        );
    }

    #[test]
    fn a_command_without_a_config_keeps_its_own_default() {
        let kubectl = Kubectl {
            command: "microk8s kubectl",
            kubeconfig: "",
        };
        assert_eq!(
            kubectl.cluster("x'y", "get pods"),
            "microk8s kubectl --context 'x'\\''y' --request-timeout=8s get pods"
        );
    }
}
