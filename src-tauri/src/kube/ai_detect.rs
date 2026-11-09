//! Which pods serve vLLM or DCGM metrics, and where (design KV.10). The rules are the original
//! terminal tool's. Everything here comes from the cluster and is untrusted: a name that could not
//! be a Kubernetes name is dropped, and a path that is not metrics-shaped is never requested.
use super::{
    metrics::is_metrics_path,
    settings::{check_namespace, check_pod},
    snapshot::{decode, shown},
};
use serde::Serialize;

/// Pods are named in a proxy URL, and each tries up to four ports.
const MAX_PORT_TRIES: usize = 4;
const MAX_NODE: usize = 253;
const FIELDS: usize = 13;
const VLLM_DEFAULT_PORT: &str = "8000";
const DCGM_DEFAULT_PORT: &str = "9400";
const DEFAULT_PATH: &str = "/metrics";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AiKind {
    Vllm,
    Dcgm,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AiTarget {
    pub kind: AiKind,
    pub namespace: String,
    pub pod: String,
    pub node: String,
    /// Changes when the pod is replaced or a container restarts: counters start over then.
    pub identity: String,
    pub ports: Vec<u16>,
    /// `None` when the annotation names something other than a metrics endpoint.
    pub path: Option<String>,
}

fn kind_of(monitor: &str, hint: &str) -> Option<AiKind> {
    match monitor.to_ascii_lowercase().as_str() {
        "off" => None,
        "vllm" => Some(AiKind::Vllm),
        "dcgm" => Some(AiKind::Dcgm),
        _ if hint.contains("dcgm-exporter") || hint.contains("dcgm_exporter") => Some(AiKind::Dcgm),
        _ if hint.contains("vllm") => Some(AiKind::Vllm),
        _ => None,
    }
}

/// The first `--port 8000` or `--port=8000` on the command line.
fn command_port(command: &str) -> Option<&str> {
    command.match_indices("--port").find_map(|(at, flag)| {
        let digits = command[at + flag.len()..].strip_prefix(['=', ' '])?;
        let end = digits
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(digits.len());
        (end > 0).then(|| &digits[..end])
    })
}

fn port_number(text: &str) -> Option<u16> {
    let plain = (1..=5).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit());
    plain
        .then(|| text.parse().ok())
        .flatten()
        .filter(|p| *p != 0)
}

/// An annotated port is the only one tried. Otherwise the command line, the declared ports, and
/// the engine's default, in that order.
fn candidate_ports(kind: AiKind, annotated: &str, command: &str, declared: &str) -> Vec<u16> {
    let default = match kind {
        AiKind::Vllm => VLLM_DEFAULT_PORT,
        AiKind::Dcgm => DCGM_DEFAULT_PORT,
    };
    let texts: Vec<&str> = if annotated.is_empty() {
        command_port(command)
            .into_iter()
            .chain(declared.split(','))
            .chain([default])
            .collect()
    } else {
        vec![annotated]
    };
    let mut ports = Vec::new();
    for port in texts.into_iter().filter_map(port_number) {
        if !ports.contains(&port) && ports.len() < MAX_PORT_TRIES {
            ports.push(port);
        }
    }
    ports
}

fn first_set(values: [&str; 2]) -> &str {
    values.into_iter().find(|v| !v.is_empty()).unwrap_or("")
}

fn target_of(line: &str, scope: &str, only_dcgm: bool) -> Option<AiTarget> {
    let fields: Vec<&str> = line.split('\t').collect();
    let &[
        namespace,
        pod,
        node,
        phase,
        uid,
        restarts,
        declared,
        command,
        monitor,
        metrics_port,
        metrics_path,
        prometheus_port,
        prometheus_path,
    ] = <&[&str; FIELDS]>::try_from(fields.as_slice()).ok()?;
    let command = decode(command);
    let hint = format!("{pod} {command}").to_ascii_lowercase();
    let kind = kind_of(&decode(monitor), &hint)?;
    if phase != "Running"
        || (only_dcgm && kind != AiKind::Dcgm)
        || (kind == AiKind::Vllm && !scope.is_empty() && namespace != scope)
        || check_namespace(namespace).is_err()
        || check_pod(pod).is_err()
    {
        return None;
    }
    let port = decode(first_set([metrics_port, prometheus_port]));
    let path = decode(first_set([metrics_path, prometheus_path]));
    let path = if path.is_empty() { DEFAULT_PATH } else { &path };
    Some(AiTarget {
        kind,
        namespace: namespace.to_string(),
        pod: pod.to_string(),
        node: shown(node, MAX_NODE),
        identity: format!("{uid}|{restarts}"),
        ports: candidate_ports(kind, &port, &command, declared),
        path: is_metrics_path(path).then(|| path.to_string()),
    })
}

/// `scope` is the workspace's namespace. vLLM stays inside it while a GPU exporter may be anywhere.
pub fn detect(rows: &str, scope: &str, only_dcgm: bool) -> Vec<AiTarget> {
    rows.lines()
        .filter_map(|line| target_of(line, scope, only_dcgm))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Row<'a> {
        namespace: &'a str,
        pod: &'a str,
        phase: &'a str,
        declared: &'a str,
        command: &'a str,
        monitor: &'a str,
        metrics_port: &'a str,
        metrics_path: &'a str,
        prometheus_port: &'a str,
        prometheus_path: &'a str,
    }

    fn line(row: Row) -> String {
        let or = |value: &'static str, other: &str| {
            if other.is_empty() {
                value.to_string()
            } else {
                other.to_string()
            }
        };
        [
            or("ai", row.namespace),
            or("serve-0", row.pod),
            "gpu-1".to_string(),
            or("Running", row.phase),
            "uid-1".to_string(),
            "0,1,".to_string(),
            row.declared.to_string(),
            row.command.to_string(),
            row.monitor.to_string(),
            row.metrics_port.to_string(),
            row.metrics_path.to_string(),
            row.prometheus_port.to_string(),
            row.prometheus_path.to_string(),
        ]
        .join("\t")
    }

    fn one(row: Row) -> Option<AiTarget> {
        detect(&line(row), "", false).into_iter().next()
    }

    #[test]
    fn the_engine_is_found_by_image_command_or_pod_name() {
        let by_image = one(Row {
            command: "vllm%2Fvllm-openai%3Av0.6 ",
            ..Row::default()
        })
        .unwrap();
        assert_eq!(by_image.kind, AiKind::Vllm);
        assert_eq!(by_image.ports, [8000]);
        assert_eq!(by_image.path.as_deref(), Some("/metrics"));
        assert_eq!(by_image.identity, "uid-1|0,1,");
        let upper_image = one(Row {
            command: "Registry%2FVLLM-Server%3A1 ",
            ..Row::default()
        });
        assert_eq!(upper_image.unwrap().kind, AiKind::Vllm);
        let by_name = one(Row {
            pod: "my-vllm-0",
            command: "other%2Fimage ",
            ..Row::default()
        });
        assert_eq!(by_name.unwrap().kind, AiKind::Vllm);
        assert!(
            one(Row {
                command: "nginx ",
                ..Row::default()
            })
            .is_none()
        );
    }

    #[test]
    fn a_gpu_exporter_is_found_with_its_own_default_port() {
        for image in ["nvidia%2Fdcgm-exporter%3A3 ", "nvcr%2Fdcgm_exporter "] {
            let found = one(Row {
                command: image,
                ..Row::default()
            })
            .unwrap();
            assert_eq!(found.kind, AiKind::Dcgm);
            assert_eq!(found.ports, [9400]);
        }
    }

    #[test]
    fn the_annotation_overrides_the_guess_and_can_turn_it_off() {
        let forced = one(Row {
            command: "custom%2Fengine ",
            monitor: "VLLM",
            ..Row::default()
        });
        assert_eq!(forced.unwrap().kind, AiKind::Vllm);
        let exporter = one(Row {
            command: "vllm%2Fserver ",
            monitor: "dcgm",
            ..Row::default()
        });
        assert_eq!(exporter.unwrap().kind, AiKind::Dcgm);
        assert!(
            one(Row {
                command: "vllm%2Fserver ",
                monitor: "off",
                ..Row::default()
            })
            .is_none()
        );
    }

    #[test]
    fn only_running_pods_are_read() {
        assert!(
            one(Row {
                phase: "Pending",
                command: "vllm ",
                ..Row::default()
            })
            .is_none()
        );
    }

    #[test]
    fn a_namespace_scope_keeps_vllm_inside_it_but_not_exporters() {
        let vllm = line(Row {
            namespace: "other",
            command: "vllm ",
            ..Row::default()
        });
        let exporter = line(Row {
            namespace: "gpu-operator",
            command: "dcgm-exporter ",
            ..Row::default()
        });
        let rows = format!("{vllm}\n{exporter}\n");
        let found = detect(&rows, "ai", false);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].namespace, "gpu-operator");
        let vllm_here = line(Row {
            command: "vllm ",
            ..Row::default()
        });
        assert!(detect(&vllm_here, "ai", true).is_empty());
    }

    #[test]
    fn ports_come_from_the_annotation_alone_or_else_in_order_and_capped() {
        let annotated = one(Row {
            command: "vllm --port%3D1234 ",
            declared: "9000,",
            metrics_port: "7000",
            prometheus_port: "7001",
            ..Row::default()
        });
        assert_eq!(annotated.unwrap().ports, [7000]);
        let prometheus = one(Row {
            command: "vllm ",
            prometheus_port: "7001",
            ..Row::default()
        });
        assert_eq!(prometheus.unwrap().ports, [7001]);
        let guessed = one(Row {
            command: "vllm --port 8001 ",
            declared: "9000,8001,9001,9002,9003,",
            ..Row::default()
        });
        assert_eq!(guessed.unwrap().ports, [8001, 9000, 9001, 9002]);
    }

    #[test]
    fn the_command_port_is_read_from_a_quoted_shell_line() {
        assert_eq!(
            command_port("python -m vllm serve --port=8080 --x"),
            Some("8080")
        );
        assert_eq!(command_port("serve --port 9 --port 10"), Some("9"));
        assert_eq!(command_port("serve --portable 80 --port x"), None);
    }

    #[test]
    fn bad_ports_are_dropped() {
        let found = one(Row {
            command: "vllm ",
            declared: "0,70000,abc,+80,8081,",
            ..Row::default()
        });
        assert_eq!(found.unwrap().ports, [8081, 8000]);
        let annotated = one(Row {
            command: "vllm ",
            metrics_port: "%3Breboot",
            ..Row::default()
        });
        assert_eq!(annotated.unwrap().ports, Vec::<u16>::new());
    }

    /// A pod's annotation must not choose what the API server's proxy reaches.
    #[test]
    fn a_path_that_is_not_a_metrics_endpoint_has_no_path_to_request() {
        for path in [
            "%2Fadmin%2Fdelete",
            "%2F..%2Fmetrics",
            "%2Fmetrics%3Fx%3D1",
            "%2Fmetrics%3Breboot",
            "metrics",
        ] {
            let found = one(Row {
                command: "vllm ",
                metrics_path: path,
                ..Row::default()
            });
            assert_eq!(found.unwrap().path, None, "{path}");
        }
        let custom = one(Row {
            command: "vllm ",
            metrics_path: "%2Fstats%2Fprometheus",
            prometheus_path: "%2Fignored%2Fmetrics",
            ..Row::default()
        });
        assert_eq!(custom.unwrap().path.as_deref(), Some("/stats/prometheus"));
        let prometheus = one(Row {
            command: "vllm ",
            prometheus_path: "%2Fv2%2Fmetrics",
            ..Row::default()
        });
        assert_eq!(prometheus.unwrap().path.as_deref(), Some("/v2/metrics"));
    }

    #[test]
    fn names_that_could_not_be_kubernetes_names_are_dropped() {
        assert!(
            one(Row {
                pod: "a/../b",
                command: "vllm ",
                ..Row::default()
            })
            .is_none()
        );
        assert!(
            one(Row {
                namespace: "$(reboot)",
                command: "vllm ",
                ..Row::default()
            })
            .is_none()
        );
    }

    #[test]
    fn a_line_with_the_wrong_number_of_fields_is_skipped() {
        assert!(detect("vllm\tonly\ttwo\n", "", false).is_empty());
    }
}
