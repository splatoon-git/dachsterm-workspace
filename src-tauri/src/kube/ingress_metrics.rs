//! Per-host traffic from the `/metrics` of ingress-nginx controllers, read through the API server's
//! pod proxy. Only this controller is supported; its upstream is archived, so this does not grow
//! (design KV.8). Counters stay cumulative here and the screen turns them into rates.
use super::{
    log_search::{STATUS, kubectl_status},
    runner::{Failed, Kubectl, Runner},
    settings::{KubeSettings, check_namespace, check_pod},
    snapshot::{fields, records, shown},
    state::{KubeState, classify},
};
use crate::remote_exec::{Limits, quote};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    time::Duration,
};

pub const CONTROLLER_LABELS: &str =
    "app.kubernetes.io/name=ingress-nginx,app.kubernetes.io/component=controller";
/// Not declared as a container port by the manifests (KV.0), so it cannot be discovered.
const METRICS_PORT: u32 = 10254;
const PREFIX: &str = "nginx_ingress_controller_";
/// Everything but histogram buckets, which are most of the output and nothing here reads them.
const WANTED: &str = "^nginx_ingress_controller_(requests|request_duration_seconds_(sum|count)|nginx_process_connections|config_last_reload_successful)";
const MAX_CONTROLLERS: usize = 10;
const MAX_FIELD: usize = 256;
const REQUEST_TIMEOUT_SECONDS: u32 = 12;
const LIMITS: Limits = Limits {
    timeout: Duration::from_secs(15),
    max_output: 16 * 1024 * 1024,
};

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Controller {
    namespace: String,
    name: String,
    container: String,
}

pub fn parse_controllers(output: &str) -> Option<Vec<Controller>> {
    records(output)
        .map(|line| {
            let [namespace, name, annotated, first] = fields::<4>(line)?;
            Some(Controller {
                namespace: shown(namespace, MAX_FIELD),
                name: shown(name, MAX_FIELD),
                container: match shown(annotated, MAX_FIELD) {
                    container if container.is_empty() => shown(first, MAX_FIELD),
                    container => container,
                },
            })
        })
        .collect()
}

/// Cumulative since each controller started, summed across controllers.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTraffic {
    host: String,
    ok: f64,
    redirect: f64,
    client_error: f64,
    server_error: f64,
    other: f64,
    duration_sum: f64,
    duration_count: f64,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Traffic {
    /// The Ingress list failed, so nothing further was read.
    NotRead,
    /// No running ingress-nginx controller. Configuration checks do not need one.
    NoController,
    /// The controller's pods could not be listed.
    ControllersUnknown {
        state: KubeState,
    },
    /// `/metrics` answered but carries no controller metrics: `--enable-metrics` is off.
    Off,
    /// `pods/proxy` get was refused.
    ProxyForbidden,
    Failed {
        state: KubeState,
    },
    Ready {
        controllers: usize,
        read: usize,
        hosts: Vec<HostTraffic>,
        connections: f64,
    },
}

#[derive(Debug, Default, PartialEq)]
struct Sample {
    enabled: bool,
    hosts: BTreeMap<String, HostTraffic>,
    connections: f64,
}

/// `name{key="value",...} 12.5`. Values are unescaped as the exposition format defines.
fn parse_line(line: &str) -> Option<(&str, BTreeMap<String, String>, f64)> {
    let brace = line.find('{')?;
    let name = &line[..brace];
    let mut rest = &line[brace + 1..];
    let mut labels = BTreeMap::new();
    loop {
        rest = rest.trim_start_matches([',', ' ']);
        if let Some(after) = rest.strip_prefix('}') {
            rest = after;
            break;
        }
        let equals = rest.find('=')?;
        let key = rest[..equals].to_string();
        rest = rest[equals + 1..].strip_prefix('"')?;
        let mut value = String::new();
        let mut chars = rest.char_indices();
        let end = loop {
            let (at, c) = chars.next()?;
            match c {
                '"' => break at,
                '\\' => match chars.next()?.1 {
                    'n' => value.push('\n'),
                    other => value.push(other),
                },
                other => value.push(other),
            }
        };
        rest = &rest[end + 1..];
        labels.insert(key, value);
    }
    let value: f64 = rest.split_whitespace().next()?.parse().ok()?;
    value.is_finite().then_some((name, labels, value))
}

fn entry<'a>(sample: &'a mut Sample, labels: &BTreeMap<String, String>) -> &'a mut HostTraffic {
    // `_` is the server block that catches a rule with no host.
    let raw = labels.get("host").map_or("", String::as_str);
    let host = if raw == "_" {
        String::new()
    } else {
        shown(raw, MAX_FIELD)
    };
    sample
        .hosts
        .entry(host.clone())
        .or_insert_with(|| HostTraffic {
            host,
            ..HostTraffic::default()
        })
}

/// Output from a third party: a line that does not parse is skipped rather than failing the rest.
fn parse_metrics(text: &str) -> Sample {
    let mut sample = Sample::default();
    for line in records(text) {
        let Some((name, labels, value)) = parse_line(line) else {
            continue;
        };
        let Some(short) = name.strip_prefix(PREFIX) else {
            continue;
        };
        sample.enabled = true;
        match short {
            "requests" => {
                let status = labels.get("status").map_or("", String::as_str);
                let traffic = entry(&mut sample, &labels);
                match status.as_bytes().first() {
                    Some(b'2') => traffic.ok += value,
                    Some(b'3') => traffic.redirect += value,
                    Some(b'4') => traffic.client_error += value,
                    Some(b'5') => traffic.server_error += value,
                    _ => traffic.other += value,
                }
            }
            "request_duration_seconds_sum" => entry(&mut sample, &labels).duration_sum += value,
            "request_duration_seconds_count" => entry(&mut sample, &labels).duration_count += value,
            "nginx_process_connections"
                if labels.get("state").is_some_and(|state| state == "active") =>
            {
                sample.connections += value;
            }
            _ => {}
        }
    }
    sample
}

/// How one controller's `/metrics` came back.
#[derive(Debug, PartialEq)]
enum Reading {
    Metrics(Sample),
    Failed(KubeState),
}

/// grep exits 1 when nothing matches, so kubectl's own status travels on stderr (KV.5).
fn script(kube: &KubeSettings, controller: &Controller) -> String {
    let path = format!(
        "/api/v1/namespaces/{}/pods/{}:{METRICS_PORT}/proxy/metrics",
        controller.namespace, controller.name
    );
    let raw = Kubectl {
        command: &kube.kubectl,
        kubeconfig: &kube.kubeconfig,
    }
    .cluster_within(
        &kube.context,
        REQUEST_TIMEOUT_SECONDS,
        &format!("get --raw {}", quote(&path)),
    );
    format!(
        "{{ {raw}; printf '\\n{STATUS} %s\\n' \"$?\" >&2; }} | grep -aE {}",
        quote(WANTED)
    )
}

async fn read_one(
    runner: &Runner<'_>,
    kube: &KubeSettings,
    controller: &Controller,
    hosts: &BTreeSet<String>,
) -> Reading {
    if check_namespace(&controller.namespace).is_err() || check_pod(&controller.name).is_err() {
        return Reading::Failed(KubeState::Unknown {
            message: "컨트롤러 파드 이름이 올바르지 않습니다.".into(),
        });
    }
    let output = match runner.script(&script(kube, controller), LIMITS).await {
        Ok(output) => output,
        Err(Failed::ChannelLimit) => return Reading::Failed(KubeState::ChannelLimit),
        Err(failed) => return Reading::Failed(failed.into_state()),
    };
    let (status, stderr) = kubectl_status(&output.stderr);
    match classify(status, stderr) {
        KubeState::Ready => {
            let mut sample = parse_metrics(&String::from_utf8_lossy(&output.stdout));
            sample.hosts.retain(|host, _| hosts.contains(host));
            Reading::Metrics(sample)
        }
        state => Reading::Failed(state),
    }
}

fn add(total: &mut HostTraffic, more: &HostTraffic) {
    total.ok += more.ok;
    total.redirect += more.redirect;
    total.client_error += more.client_error;
    total.server_error += more.server_error;
    total.other += more.other;
    total.duration_sum += more.duration_sum;
    total.duration_count += more.duration_count;
}

/// Any controller with metrics makes the result. Otherwise a refused proxy is the only reason worth
/// saying, then a controller that is simply off, and only then a read that failed.
fn merge(readings: Vec<Reading>, controllers: usize) -> Traffic {
    let mut hosts: BTreeMap<String, HostTraffic> = BTreeMap::new();
    let (mut read, mut connections, mut off) = (0, 0.0, false);
    let (mut forbidden, mut failed) = (false, None);
    for reading in readings {
        match reading {
            Reading::Metrics(sample) if sample.enabled => {
                read += 1;
                connections += sample.connections;
                for (host, traffic) in sample.hosts {
                    add(
                        hosts.entry(host).or_insert_with(|| HostTraffic {
                            host: traffic.host.clone(),
                            ..HostTraffic::default()
                        }),
                        &traffic,
                    );
                }
            }
            Reading::Metrics(_) => off = true,
            Reading::Failed(KubeState::Forbidden) => forbidden = true,
            Reading::Failed(state) => failed = failed.or(Some(state)),
        }
    }
    if read > 0 {
        Traffic::Ready {
            controllers,
            read,
            hosts: hosts.into_values().collect(),
            connections,
        }
    } else if forbidden {
        Traffic::ProxyForbidden
    } else if off {
        Traffic::Off
    } else {
        Traffic::Failed {
            state: failed.unwrap_or(KubeState::Unknown {
                message: "컨트롤러 메트릭을 읽지 못했습니다.".into(),
            }),
        }
    }
}

/// One after another, stopping at a refusal: every other controller would be refused the same way.
pub async fn read(
    runner: &Runner<'_>,
    kube: &KubeSettings,
    controllers: &[Controller],
    hosts: &BTreeSet<String>,
) -> Traffic {
    let mut readings = Vec::new();
    for controller in controllers.iter().take(MAX_CONTROLLERS) {
        let reading = read_one(runner, kube, controller, hosts).await;
        let refused = reading == Reading::Failed(KubeState::Forbidden);
        readings.push(reading);
        if refused {
            break;
        }
    }
    merge(readings, controllers.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn requests(host: &str, status: &str, value: u32) -> String {
        format!(
            "nginx_ingress_controller_requests{{canary=\"\",controller_class=\"k8s.io/ingress-nginx\",host=\"{host}\",ingress=\"a\",method=\"GET\",namespace=\"web\",path=\"/\",service=\"s\",status=\"{status}\"}} {value}\n"
        )
    }

    fn sample(lines: &str) -> Reading {
        Reading::Metrics(parse_metrics(lines))
    }

    fn ready_hosts(traffic: Traffic) -> (usize, Vec<HostTraffic>) {
        match traffic {
            Traffic::Ready { read, hosts, .. } => (read, hosts),
            other => panic!("expected Ready, got {other:?}"),
        }
    }

    #[test]
    fn statuses_are_grouped_by_host() {
        let text = [
            requests("ok.local", "200", 60),
            requests("ok.local", "201", 5),
            requests("ok.local", "404", 20),
            requests("ok.local", "302", 2),
            requests("ok.local", "503", 15),
            requests("dead.local", "503", 7),
        ]
        .concat();
        let result = parse_metrics(&text);
        assert!(result.enabled);
        let ok = &result.hosts["ok.local"];
        assert_eq!(
            (ok.ok, ok.redirect, ok.client_error, ok.server_error),
            (65.0, 2.0, 20.0, 15.0)
        );
        assert_eq!(result.hosts["dead.local"].server_error, 7.0);
    }

    #[test]
    fn durations_and_active_connections_are_read() {
        let text = "nginx_ingress_controller_request_duration_seconds_sum{host=\"a\",status=\"200\"} 1.5\n\
                    nginx_ingress_controller_request_duration_seconds_count{host=\"a\",status=\"200\"} 3\n\
                    nginx_ingress_controller_nginx_process_connections{controller_pod=\"p\",state=\"active\"} 4\n\
                    nginx_ingress_controller_nginx_process_connections{controller_pod=\"p\",state=\"waiting\"} 9\n";
        let result = parse_metrics(text);
        assert_eq!(result.hosts["a"].duration_sum, 1.5);
        assert_eq!(result.hosts["a"].duration_count, 3.0);
        assert_eq!(result.connections, 4.0);
    }

    #[test]
    fn escaped_label_values_do_not_end_the_value_early() {
        let (name, labels, value) =
            parse_line(r#"nginx_ingress_controller_requests{path="/a\"b,c\\d",host="x"} 2"#)
                .unwrap();
        assert_eq!(name, "nginx_ingress_controller_requests");
        assert_eq!(labels["path"], "/a\"b,c\\d");
        assert_eq!(labels["host"], "x");
        assert_eq!(value, 2.0);
    }

    #[test]
    fn odd_lines_are_skipped() {
        let text = format!(
            "# HELP nginx_ingress_controller_requests x\nnot metrics\n{}nginx_ingress_controller_requests{{host=\"a\"}} NaN\n",
            requests("a", "200", 1)
        );
        assert_eq!(parse_metrics(&text).hosts["a"].ok, 1.0);
    }

    #[test]
    fn the_catch_all_server_counts_toward_the_rule_with_no_host() {
        assert_eq!(parse_metrics(&requests("_", "200", 3)).hosts[""].ok, 3.0);
    }

    #[test]
    fn metrics_that_answer_without_the_controllers_names_are_off() {
        let readings = vec![sample("go_gc_duration_seconds{quantile=\"0\"} 1\n")];
        assert_eq!(merge(readings, 1), Traffic::Off);
    }

    #[test]
    fn a_controller_with_metrics_but_no_requests_yet_is_on_and_empty() {
        let readings = vec![sample(
            "nginx_ingress_controller_config_last_reload_successful{controller_pod=\"p\"} 1\n",
        )];
        let (read, hosts) = ready_hosts(merge(readings, 1));
        assert_eq!(read, 1);
        assert!(hosts.is_empty());
    }

    #[test]
    fn controllers_are_added_together() {
        let readings = vec![
            sample(&requests("a", "200", 3)),
            sample(&requests("a", "200", 4)),
        ];
        let (read, hosts) = ready_hosts(merge(readings, 2));
        assert_eq!(read, 2);
        assert_eq!(hosts[0].ok, 7.0);
    }

    #[test]
    fn a_refused_proxy_is_the_only_reason_shown() {
        let readings = vec![Reading::Failed(KubeState::Forbidden)];
        assert_eq!(merge(readings, 1), Traffic::ProxyForbidden);
    }

    #[test]
    fn one_controller_reading_is_enough_and_says_how_many() {
        let readings = vec![
            sample(&requests("a", "200", 3)),
            Reading::Failed(KubeState::TimedOut),
        ];
        match merge(readings, 2) {
            Traffic::Ready {
                controllers, read, ..
            } => assert_eq!((controllers, read), (2, 1)),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_failed_read_says_why() {
        let readings = vec![Reading::Failed(KubeState::TimedOut)];
        assert_eq!(
            merge(readings, 1),
            Traffic::Failed {
                state: KubeState::TimedOut
            }
        );
    }

    #[test]
    fn the_script_filters_on_the_server_and_keeps_kubectls_own_status() {
        let kube = KubeSettings {
            context: "ctx".into(),
            namespace: String::new(),
            kubectl: "kubectl".into(),
            kubeconfig: String::new(),
            operate: false,
        };
        let text = script(
            &kube,
            &Controller {
                namespace: "ingress-nginx".into(),
                name: "c-1".into(),
                container: "controller".into(),
            },
        );
        assert!(text.contains("/api/v1/namespaces/ingress-nginx/pods/c-1:10254/proxy/metrics"));
        assert!(text.contains(STATUS));
        assert!(text.contains("grep -aE"));
    }

    #[test]
    fn controller_records_prefer_the_annotated_container() {
        let list = parse_controllers("n\tc\tmain\tfirst\nn\td\t<no value>\tfirst\n").unwrap();
        assert_eq!(list[0].container, "main");
        assert_eq!(list[1].container, "first");
    }
}
