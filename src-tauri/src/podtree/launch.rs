//! Command that starts the staged PodTree script in its PTY.
use super::{Launch, quote};

pub(super) fn start_command(launch: &Launch, path: &str) -> String {
    // A local command runs under the Bash that bash_target chose, while PATH may find another
    // (macOS /bin/bash is 3.2). SSH runs this in the remote login shell, where $BASH can be unset.
    let bash = if launch.location.kind == "local" {
        "\"$BASH\""
    } else {
        "bash"
    };
    format!(
        "export DACHSTERM_EMBEDDED=1 KUBECTL=kubectl; exec {bash} {} --context {} -n {} {}",
        quote(&format!("{path}/podtree.sh")),
        quote(&launch.context),
        quote(&launch.namespace),
        if launch.operational {
            ""
        } else {
            "--read-only"
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::podtree::Location;

    fn launch(kind: &str, operational: bool) -> Launch {
        Launch {
            location: Location {
                kind: kind.into(),
                id: "id".into(),
            },
            context: "prod".into(),
            namespace: "web".into(),
            operational,
        }
    }

    #[test]
    fn local_keeps_the_chosen_bash_and_ssh_uses_the_remote_path() {
        let local = start_command(&launch("local", false), "/tmp/d");
        assert!(
            local.contains("exec \"$BASH\" '/tmp/d/podtree.sh'"),
            "{local}"
        );
        let ssh = start_command(&launch("ssh", false), "/tmp/d");
        assert!(ssh.contains("exec bash '/tmp/d/podtree.sh'"), "{ssh}");
    }

    #[test]
    fn read_only_unless_operational() {
        assert!(start_command(&launch("ssh", false), "/d").ends_with("--read-only"));
        assert!(!start_command(&launch("ssh", true), "/d").contains("--read-only"));
    }
}
