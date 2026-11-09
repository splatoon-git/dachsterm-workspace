//! Builds kubectl command lines and runs scripts where the cluster's kubectl lives.
use super::{
    local_run,
    settings::KubeSettings,
    state::{KubeState, classify},
};
use crate::{
    remote_exec::{self, Limits, Output, Refusable, Streamed, quote},
    ssh::Host,
};
use russh::client;
use std::{ops::ControlFlow, sync::Arc, time::Duration};

/// Longer than `--request-timeout`, which retries turn into about 36 seconds when an API server
/// does not answer (KV.0). Closing the channel at this limit is what actually ends the wait.
const KUBECTL: Limits = Limits {
    timeout: Duration::from_secs(12),
    max_output: 1024 * 1024,
};

/// Where a tab's kubectl runs. A local cluster's tab has no connection to hand over.
#[derive(Clone)]
pub enum Link {
    Ssh(Arc<client::Handle<Host>>),
    Local,
}
impl Link {
    pub fn runner<'a>(&'a self, kube: &'a KubeSettings) -> Runner<'a> {
        self.runner_for(&kube.kubectl)
    }
    /// For detection, which does not know kubectl's path when it starts.
    pub fn runner_for<'a>(&'a self, kubectl: &'a str) -> Runner<'a> {
        match self {
            Link::Ssh(handle) => Runner::Ssh(handle),
            Link::Local => Runner::Local { kubectl },
        }
    }
    /// The settings came from the screen, and what they may hold depends on where they will run.
    pub fn check(&self, kube: &KubeSettings) -> crate::storage::Result<()> {
        match self {
            Link::Ssh(_) => kube.validate(),
            Link::Local => kube.validate_local(),
        }
    }
}

pub enum Runner<'a> {
    Ssh(&'a client::Handle<Host>),
    /// `kubectl` is the path in the settings, not found again here (rules §11).
    Local {
        kubectl: &'a str,
    },
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
        self.cluster_within(context, 8, args)
    }
    pub fn cluster_within(&self, context: &str, seconds: u32, args: &str) -> String {
        format!(
            "{} --context {} --request-timeout={seconds}s {args}",
            self.prefix(),
            quote(context),
        )
    }
    /// For a long-lived `exec` or `logs -f`, where `--request-timeout` would end the stream.
    pub fn streaming(&self, context: &str, args: &str) -> String {
        format!("{} --context {} {args}", self.prefix(), quote(context))
    }
}

pub enum Failed {
    /// The script could not start or finish; the caller decides whether that matters.
    Stopped(remote_exec::Failure),
    ChannelLimit,
}
impl Failed {
    pub fn into_state(self) -> KubeState {
        match self {
            Failed::ChannelLimit => KubeState::ChannelLimit,
            Failed::Stopped(remote_exec::Failure::TimedOut) => KubeState::TimedOut,
            Failed::Stopped(remote_exec::Failure::TooLarge) => KubeState::TooLarge,
            Failed::Stopped(failure) => KubeState::Unknown {
                message: String::from(failure),
            },
        }
    }
}

fn refused_or_failed(failure: Refusable) -> Failed {
    match failure {
        Refusable::ChannelRefused => Failed::ChannelLimit,
        Refusable::Failure(failure) => Failed::Stopped(failure),
    }
}

impl Runner<'_> {
    /// A local runner takes one `Kubectl` command line. Its callers branch on `is_local` wherever
    /// a server would have run a pipeline, because the filtering policy is different (design KV.11).
    pub async fn script(&self, script: &str, limits: Limits) -> Result<Output, Failed> {
        match self {
            Runner::Ssh(handle) => remote_exec::run_refusable(handle, script, limits)
                .await
                .map_err(refused_or_failed),
            Runner::Local { kubectl } => local_run::run(kubectl, script, limits)
                .await
                .map_err(Failed::Stopped),
        }
    }

    pub fn is_local(&self) -> bool {
        matches!(self, Runner::Local { .. })
    }

    /// The same runner with kubectl's path now known.
    pub fn with_kubectl<'b>(&'b self, path: &'b str) -> Runner<'b> {
        match self {
            Runner::Ssh(handle) => Runner::Ssh(handle),
            Runner::Local { .. } => Runner::Local { kubectl: path },
        }
    }

    /// For output too long to hold, such as a log search: stdout reaches `on_stdout` as it arrives.
    pub async fn stream(
        &self,
        script: &str,
        limits: Limits,
        on_stdout: impl FnMut(&[u8]) -> ControlFlow<()>,
    ) -> Result<Streamed, Failed> {
        match self {
            Runner::Ssh(handle) => remote_exec::stream_refusable(handle, script, limits, on_stdout)
                .await
                .map_err(refused_or_failed),
            Runner::Local { kubectl } => local_run::stream(kubectl, script, limits, on_stdout)
                .await
                .map_err(Failed::Stopped),
        }
    }

    /// Runs a setup check. It lists almost nothing, so running out of time means no API server.
    pub async fn kubectl(&self, command: &str) -> Result<Output, KubeState> {
        self.kubectl_bounded(command, KUBECTL)
            .await
            .map_err(|state| match state {
                KubeState::TimedOut => KubeState::Unreachable,
                KubeState::TooLarge => KubeState::Unknown {
                    message: String::from(remote_exec::Failure::TooLarge),
                },
                state => state,
            })
    }

    /// Runs a kubectl command and returns its stdout, or the state that stopped it.
    pub async fn kubectl_bounded(
        &self,
        command: &str,
        limits: Limits,
    ) -> Result<Output, KubeState> {
        let output = self
            .script(command, limits)
            .await
            .map_err(Failed::into_state)?;
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
