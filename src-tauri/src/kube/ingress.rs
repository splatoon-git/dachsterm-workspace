//! `kube_ingress`: the configuration check of every Ingress, which does not depend on a controller,
//! and per-host traffic for ingress-nginx (design KV.8). Values from the cluster are untrusted, so
//! they are bounded here and only ever shown as text.
use super::{
    ingress_metrics::{self, Controller, Traffic},
    runner::{Kubectl, Runner},
    settings::KubeSettings,
    snapshot::{self, Data, Kind, Service, decode, fields, malformed, now_ms, records, shown},
    state::KubeState,
    templates,
};
use crate::remote_exec::{Limits, quote};
use serde::Serialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    time::{Duration, Instant},
};

/// One read among several in a slot, so each is held to what `kube_snapshot` allows for one.
const LIMITS: Limits = Limits {
    timeout: Duration::from_secs(20),
    max_output: 32 * 1024 * 1024,
};
const REQUEST_TIMEOUT_SECONDS: u32 = 18;
const MAX_FIELD: usize = 512;
const MAX_HOSTS: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Backend {
    Ok,
    /// The Service the path names does not exist.
    NoService,
    /// The Service exists and has no ready endpoint.
    NoReady,
    /// Not a Service with endpoints to count: a resource backend or an `ExternalName`.
    External,
    /// The Services could not be read, so nothing is known either way.
    Unchecked,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    host: String,
    path: String,
    path_type: String,
    service: String,
    port: String,
    /// From `spec.defaultBackend`, for requests that no rule matches.
    is_default: bool,
    backend: Backend,
    ready_endpoints: usize,
    not_ready_endpoints: usize,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tls {
    secret: String,
    hosts: Vec<String>,
    missing: bool,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ingress {
    namespace: String,
    name: String,
    class_name: String,
    addresses: Vec<String>,
    tls: Vec<Tls>,
    rules: Vec<Rule>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    state: KubeState,
    /// `None` when the list itself could not be read; `state` says why.
    ingresses: Option<Vec<Ingress>>,
    /// `Ready` when backends were checked, otherwise why they could not be.
    services_state: KubeState,
    secrets_state: KubeState,
    controllers: Vec<Controller>,
    traffic: Traffic,
    collected_at: u64,
    elapsed_ms: u64,
}

fn text(value: &str) -> String {
    shown(value, MAX_FIELD)
}

fn list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(text)
        .filter(|item| !item.is_empty())
        .take(MAX_HOSTS)
        .collect()
}

fn rule(entry: &str) -> Option<Rule> {
    let [host, path, path_type, service, port]: [&str; 5] =
        entry.split(';').collect::<Vec<_>>().try_into().ok()?;
    Some(Rule {
        host: text(host),
        path: text(&decode(path)),
        path_type: text(path_type),
        service: text(service),
        port: text(port),
        is_default: false,
        backend: Backend::Unchecked,
        ready_endpoints: 0,
        not_ready_endpoints: 0,
    })
}

fn default_rule(value: &str) -> Option<Rule> {
    let (service, port) = value.split_once(';')?;
    Some(Rule {
        is_default: true,
        ..rule(&format!(";;;{service};{port}"))?
    })
}

fn tls(entry: &str) -> Option<Tls> {
    let (secret, hosts) = entry.split_once(';')?;
    Some(Tls {
        secret: text(secret),
        hosts: list(hosts),
        missing: false,
    })
}

fn ingress(line: &str) -> Option<Ingress> {
    let [
        namespace,
        name,
        class_name,
        addresses,
        tls_entries,
        default_backend,
        rules,
    ] = fields::<7>(line)?;
    let mut parsed = rules
        .split('|')
        .filter(|entry| !entry.is_empty())
        .map(rule)
        .collect::<Option<Vec<_>>>()?;
    if !default_backend.is_empty() {
        parsed.push(default_rule(default_backend)?);
    }
    Some(Ingress {
        namespace: text(namespace),
        name: text(name),
        class_name: text(class_name),
        addresses: list(addresses),
        tls: tls_entries
            .split('|')
            .filter(|entry| !entry.is_empty())
            .map(tls)
            .collect::<Option<Vec<_>>>()?,
        rules: parsed,
    })
}

fn parse_ingresses(output: &str) -> Option<Vec<Ingress>> {
    records(output).map(ingress).collect()
}

fn parse_secrets(output: &str) -> Option<BTreeSet<(String, String)>> {
    records(output)
        .map(|line| {
            let [namespace, name] = fields::<2>(line)?;
            Some((text(namespace), text(name)))
        })
        .collect()
}

fn parse_services(output: &str, namespace: &str) -> Option<Vec<Service>> {
    match snapshot::parse(Kind::Services, output, namespace)? {
        Data::Services(services) => Some(services),
        _ => None,
    }
}

/// Only the path's own Service decides. Endpoints that are starting count as not ready.
fn check_backends(items: &mut [Ingress], services: &[Service]) {
    let by_name: BTreeMap<(&str, &str), &Service> = services
        .iter()
        .map(|service| ((service.namespace.as_str(), service.name.as_str()), service))
        .collect();
    for item in items {
        for rule in &mut item.rules {
            if rule.service.is_empty() {
                rule.backend = Backend::External;
                continue;
            }
            let Some(service) = by_name.get(&(item.namespace.as_str(), rule.service.as_str()))
            else {
                rule.backend = Backend::NoService;
                continue;
            };
            rule.ready_endpoints = service.ready_endpoints;
            rule.not_ready_endpoints = service.not_ready_endpoints;
            rule.backend = if service.service_type == "ExternalName" {
                Backend::External
            } else if service.ready_endpoints == 0 {
                Backend::NoReady
            } else {
                Backend::Ok
            };
        }
    }
}

/// Only names are compared; the value of a Secret is never requested from the template.
fn check_secrets(items: &mut [Ingress], secrets: &BTreeSet<(String, String)>) {
    for item in items {
        for tls in &mut item.tls {
            tls.missing = !tls.secret.is_empty()
                && !secrets.contains(&(item.namespace.clone(), tls.secret.clone()));
        }
    }
}

fn known_hosts(items: &[Ingress]) -> BTreeSet<String> {
    items
        .iter()
        .flat_map(|item| item.rules.iter().map(|rule| rule.host.clone()))
        .collect()
}

struct Reader<'a> {
    runner: &'a Runner<'a>,
    kubectl: Kubectl<'a>,
    context: &'a str,
}

impl Reader<'_> {
    async fn read<T>(
        &self,
        args: &str,
        parse: impl FnOnce(&str) -> Option<T>,
    ) -> Result<T, KubeState> {
        let command = self
            .kubectl
            .cluster_within(self.context, REQUEST_TIMEOUT_SECONDS, args);
        let output = self.runner.kubectl_bounded(&command, LIMITS).await?;
        parse(&String::from_utf8_lossy(&output.stdout)).ok_or_else(malformed)
    }
}

fn go_template(template: &str) -> String {
    format!("-o go-template={}", quote(template))
}

fn scope(namespace: &str) -> String {
    if namespace.is_empty() {
        "-A".to_string()
    } else {
        format!("-n {}", quote(namespace))
    }
}

/// Reads one after another under the single slot the command holds, so a report never takes more
/// of the connection's channels than any other poll.
pub async fn collect(runner: &Runner<'_>, kube: &KubeSettings) -> Report {
    let started = Instant::now();
    let reader = Reader {
        runner,
        kubectl: Kubectl {
            command: &kube.kubectl,
            kubeconfig: &kube.kubeconfig,
        },
        context: &kube.context,
    };
    let scope = scope(&kube.namespace);
    let finish = |state, ingresses, services_state, secrets_state, controllers, traffic| Report {
        state,
        ingresses,
        services_state,
        secrets_state,
        controllers,
        traffic,
        collected_at: now_ms(),
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
    };

    let listed = reader
        .read(
            &format!(
                "get ingresses.networking.k8s.io {scope} {}",
                go_template(templates::INGRESSES)
            ),
            parse_ingresses,
        )
        .await;
    let mut items = match listed {
        Ok(items) => items,
        Err(state) => {
            return finish(
                state,
                None,
                KubeState::Ready,
                KubeState::Ready,
                Vec::new(),
                Traffic::NotRead,
            );
        }
    };

    let services_state = if items.is_empty() {
        KubeState::Ready
    } else {
        let namespace = kube.namespace.clone();
        match reader
            .read(
                &format!(
                    "get services,endpoints {scope} {}",
                    go_template(templates::SERVICES)
                ),
                move |output| parse_services(output, &namespace),
            )
            .await
        {
            Ok(services) => {
                check_backends(&mut items, &services);
                KubeState::Ready
            }
            Err(state) => state,
        }
    };

    let wants_secrets = items
        .iter()
        .any(|item| item.tls.iter().any(|tls| !tls.secret.is_empty()));
    let secrets_state = if wants_secrets {
        match reader
            .read(
                &format!(
                    "get secrets {scope} {}",
                    go_template(templates::SECRET_NAMES)
                ),
                parse_secrets,
            )
            .await
        {
            Ok(secrets) => {
                check_secrets(&mut items, &secrets);
                KubeState::Ready
            }
            Err(state) => state,
        }
    } else {
        KubeState::Ready
    };

    let hosts = known_hosts(&items);
    let (controllers, traffic) = match reader
        .read(
            &format!(
                "get pods -A -l {} --field-selector=status.phase=Running {}",
                ingress_metrics::CONTROLLER_LABELS,
                go_template(templates::INGRESS_CONTROLLERS)
            ),
            ingress_metrics::parse_controllers,
        )
        .await
    {
        Ok(list) if list.is_empty() => (list, Traffic::NoController),
        Ok(list) => {
            let traffic = ingress_metrics::read(runner, kube, &list, &hosts).await;
            (list, traffic)
        }
        Err(state) => (Vec::new(), Traffic::ControllersUnknown { state }),
    };

    finish(
        KubeState::Ready,
        Some(items),
        services_state,
        secrets_state,
        controllers,
        traffic,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const WEB: &str = "web\tshop\tnginx\t10.0.0.5,<no value>,\tshop-cert;shop.example.com,|\t\t\
                       shop.example.com;%2Fapi%3Fa%3Bb;Prefix;api;80|shop.example.com;;Exact;web;http|\n";

    fn service(name: &str, kind: &str, ready: usize) -> Service {
        Service {
            namespace: "web".into(),
            name: name.into(),
            service_type: kind.into(),
            ready_endpoints: ready,
            ..Service::default()
        }
    }

    #[test]
    fn a_record_becomes_rules_with_their_paths_decoded() {
        let items = parse_ingresses(WEB).unwrap();
        assert_eq!(items[0].namespace, "web");
        assert_eq!(items[0].class_name, "nginx");
        assert_eq!(items[0].addresses, ["10.0.0.5"]);
        assert_eq!(items[0].tls[0].secret, "shop-cert");
        assert_eq!(items[0].tls[0].hosts, ["shop.example.com"]);
        assert_eq!(items[0].rules[0].path, "/api?a;b");
        assert_eq!(items[0].rules[0].service, "api");
        assert_eq!(items[0].rules[0].port, "80");
        assert_eq!(items[0].rules[1].path, "");
        assert_eq!(items[0].rules[1].port, "http");
    }

    #[test]
    fn a_missing_host_or_class_or_status_is_empty_rather_than_go_templates_placeholder() {
        let line = "a\tb\t<no value>\t\t\t\t<no value>;%2F;Prefix;svc;8080|\n";
        let items = parse_ingresses(line).unwrap();
        assert_eq!(items[0].class_name, "");
        assert!(items[0].addresses.is_empty());
        assert_eq!(items[0].rules[0].host, "");
    }

    #[test]
    fn a_rule_without_http_and_a_default_backend_are_both_kept() {
        let line = "a\tb\t\t\t\tfallback;9000\tonly.host;;;;|\n";
        let items = parse_ingresses(line).unwrap();
        assert_eq!(items[0].rules.len(), 2);
        assert_eq!(items[0].rules[0].host, "only.host");
        assert_eq!(items[0].rules[0].service, "");
        assert!(items[0].rules[1].is_default);
        assert_eq!(items[0].rules[1].service, "fallback");
        assert_eq!(items[0].rules[1].port, "9000");
    }

    #[test]
    fn a_broken_record_is_not_silently_dropped() {
        assert!(parse_ingresses("a\tb\n").is_none());
        assert!(parse_ingresses("a\tb\t\t\t\t\thost;;too;few|\n").is_none());
    }

    #[test]
    fn backends_are_judged_by_their_own_service() {
        let mut items = parse_ingresses(WEB).unwrap();
        check_backends(&mut items, &[service("api", "ClusterIP", 0)]);
        assert_eq!(items[0].rules[0].backend, Backend::NoReady);
        assert_eq!(items[0].rules[1].backend, Backend::NoService);

        check_backends(
            &mut items,
            &[
                service("api", "ClusterIP", 2),
                service("web", "ExternalName", 0),
            ],
        );
        assert_eq!(items[0].rules[0].backend, Backend::Ok);
        assert_eq!(items[0].rules[0].ready_endpoints, 2);
        assert_eq!(items[0].rules[1].backend, Backend::External);
    }

    #[test]
    fn a_service_of_the_same_name_elsewhere_does_not_count() {
        let mut items = parse_ingresses(WEB).unwrap();
        let mut other = service("api", "ClusterIP", 3);
        other.namespace = "other".into();
        check_backends(&mut items, &[other]);
        assert_eq!(items[0].rules[0].backend, Backend::NoService);
    }

    #[test]
    fn a_path_with_no_service_is_not_a_failure() {
        let line = "a\tb\t\t\t\t\thost;%2F;Prefix;;|\n";
        let mut items = parse_ingresses(line).unwrap();
        check_backends(&mut items, &[]);
        assert_eq!(items[0].rules[0].backend, Backend::External);
    }

    #[test]
    fn a_tls_secret_is_found_by_namespace_and_name() {
        let mut items = parse_ingresses(WEB).unwrap();
        let secrets = parse_secrets("other\tshop-cert\n").unwrap();
        check_secrets(&mut items, &secrets);
        assert!(items[0].tls[0].missing);
        let secrets = parse_secrets("web\tshop-cert\n").unwrap();
        check_secrets(&mut items, &secrets);
        assert!(!items[0].tls[0].missing);
    }

    #[test]
    fn tls_without_a_secret_uses_the_default_certificate() {
        let line = "a\tb\t\t\t;x.example.com,|\t\t\n";
        let mut items = parse_ingresses(line).unwrap();
        check_secrets(&mut items, &BTreeSet::new());
        assert!(!items[0].tls[0].missing);
    }
}
