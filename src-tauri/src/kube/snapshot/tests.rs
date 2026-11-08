use super::*;

fn pods(text: &str) -> Vec<Pod> {
    match parse(Kind::Pods, text, "") {
        Some(Data::Pods(items)) => items,
        other => panic!("unexpected: {other:?}"),
    }
}

const RUNNING: &str = "web\tapi-7f9c-abc\tworker-1\tRunning\t\t2026-11-08T01:00:00Z\t<no value>\tReplicaSet/api-7f9c,\tapp=api,tier=front,\t100m;64Mi;200m;128Mi|<no value>;1Gi;;|\t\tapp;true;3;;;OOMKilled;2026-11-08T02:00:00Z;137|side;false;0;CrashLoopBackOff;;;;|\t<no value>\tapp\n";

#[test]
fn a_pod_record_keeps_every_field() {
    let [pod] = <[Pod; 1]>::try_from(pods(RUNNING)).unwrap();
    assert_eq!(pod.namespace, "web");
    assert_eq!(pod.name, "api-7f9c-abc");
    assert_eq!(pod.node, "worker-1");
    assert_eq!(pod.phase, "Running");
    assert!(!pod.deleting);
    assert_eq!(pod.owner_kind, "ReplicaSet");
    assert_eq!(pod.owner_name, "api-7f9c");
    assert_eq!(pod.labels["tier"], "front");
    assert_eq!(pod.container_count, 2);
    assert_eq!(pod.default_container, "app");
    assert_eq!(pod.containers[0].restarts, 3);
    assert_eq!(pod.containers[0].last_reason, "OOMKilled");
    assert_eq!(pod.containers[0].last_exit_code, Some(137));
    assert_eq!(pod.containers[1].last_exit_code, None);
    assert_eq!(pod.containers[1].waiting, "CrashLoopBackOff");
    assert!(!pod.containers[1].ready);
}

#[test]
fn the_default_container_annotation_wins_over_the_first_in_the_spec() {
    let line = RUNNING.replace("\t<no value>\tapp\n", "\tmain\tapp\n");
    assert_eq!(pods(&line)[0].default_container, "main");
}

#[test]
fn resources_are_summed_across_containers() {
    let [pod] = <[Pod; 1]>::try_from(pods(RUNNING)).unwrap();
    assert_eq!(pod.cpu_request, Some(100));
    assert_eq!(pod.memory_request, Some(64 * 1024 * 1024 + (1 << 30)));
    assert_eq!(pod.cpu_limit, Some(200));
    assert_eq!(pod.memory_limit, Some(128 * 1024 * 1024));
}

#[test]
fn a_pod_without_any_resources_has_none_rather_than_zero() {
    let line = "a\tb\t<no value>\tPending\t\t2026-11-08T01:00:00Z\t<no value>\t\t\t;;;|\t\t\t\t\n";
    let [pod] = <[Pod; 1]>::try_from(pods(line)).unwrap();
    assert_eq!(pod.cpu_request, None);
    assert_eq!(pod.memory_limit, None);
    assert_eq!(pod.node, "");
    assert_eq!(pod.owner_kind, "");
    assert_eq!(pod.container_count, 1);
    assert!(pod.containers.is_empty());
}

#[test]
fn a_deletion_time_means_the_pod_is_going_away() {
    let line = "a\tb\tn\tRunning\t\t2026-11-08T01:00:00Z\t2026-11-08T03:00:00Z\t\t\t\t\t\t\t\n";
    assert!(pods(line)[0].deleting);
}

#[test]
fn free_text_is_decoded_and_cannot_add_fields() {
    let line = "a\tb\tn\tFailed\tEvicted%09now+x\t2026\t<no value>\t\t\t\t\tc;false;0;bad%7Creason;;;;|\t\t\n";
    let pod = &pods(line)[0];
    // The tab inside the reason came through url-encoded; control characters are not displayed.
    assert_eq!(pod.reason, "Evictednow x");
    assert_eq!(pod.containers[0].waiting, "bad|reason");
}

#[test]
fn a_record_of_the_wrong_shape_is_refused_whole() {
    assert_eq!(parse(Kind::Pods, "only\ttwo\n", ""), None);
    let long = format!("a\t{}\n", "b".repeat(MAX_LINE));
    assert_eq!(parse(Kind::Workloads, &long, ""), None);
}

#[test]
fn long_values_are_cut_and_empty_output_is_empty() {
    let name = "x".repeat(MAX_FIELD + 50);
    let line = format!("Deployment\tweb\t{name}\t3\t2\n");
    let Some(Data::Workloads(items)) = parse(Kind::Workloads, &line, "") else {
        panic!("workloads");
    };
    assert_eq!(items[0].name.len(), MAX_FIELD);
    assert_eq!(parse(Kind::Pods, "", ""), Some(Data::Pods(vec![])));
}

#[test]
fn a_workload_with_no_ready_replicas_counts_zero() {
    let Some(Data::Workloads(items)) = parse(
        Kind::Workloads,
        "Deployment\tweb\tapi\t3\t<no value>\nDaemonSet\tkube\tproxy\t2\t2\n",
        "",
    ) else {
        panic!("workloads");
    };
    assert_eq!((items[0].desired, items[0].ready), (3, 0));
    assert_eq!(items[1].kind, "DaemonSet");
}

#[test]
fn services_join_their_endpoints() {
    let text = "Service\tweb\tapi\tClusterIP\tapp=api,tier=front,\n\
                Endpoints\tweb\tapi\t..\t.\n\
                Service\tweb\theadless\tClusterIP\t\n\
                Endpoints\tkube-system\torphan\t.\t\n";
    let Some(Data::Services(items)) = parse(Kind::Services, text, "") else {
        panic!("services");
    };
    assert_eq!(items.len(), 2);
    assert_eq!(items[0].name, "api");
    assert_eq!(items[0].selector["app"], "api");
    assert_eq!(
        (items[0].ready_endpoints, items[0].not_ready_endpoints),
        (2, 1)
    );
    assert!(items[1].selector.is_empty());
}

#[test]
fn nodes_report_readiness_and_allocatable() {
    let Some(Data::Nodes(items)) = parse(
        Kind::Nodes,
        "n1\tTrue\t<no value>\t4\t16284856Ki\nn2\tFalse\ttrue\t3800m\t8Gi\n",
        "",
    ) else {
        panic!("nodes");
    };
    assert!(items[0].ready && !items[0].unschedulable);
    assert_eq!(items[0].cpu_allocatable, Some(4000));
    assert_eq!(items[0].memory_allocatable, Some(16_284_856 * 1024));
    assert!(!items[1].ready && items[1].unschedulable);
}

#[test]
fn usage_columns_depend_on_the_scope() {
    let Some(Data::PodUsage(all)) = parse(
        Kind::PodUsage,
        "web  api-1  12m  34Mi\nkube  dns    <unknown>  <unknown>\n",
        "",
    ) else {
        panic!("all namespaces");
    };
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].namespace, "web");
    assert_eq!((all[0].cpu, all[0].memory), (12, 34 * 1024 * 1024));

    let Some(Data::PodUsage(one)) = parse(Kind::PodUsage, "api-1  12m  34Mi\n", "web") else {
        panic!("one namespace");
    };
    assert_eq!(one[0].namespace, "web");
    assert_eq!(parse(Kind::PodUsage, "api-1  12m  34Mi\n", ""), None);
}

#[test]
fn node_usage_reads_the_top_columns() {
    let Some(Data::NodeUsage(items)) = parse(
        Kind::NodeUsage,
        "n1  250m  6%  1024Mi  13%\nn2  <unknown>  <unknown>  <unknown>  <unknown>\n",
        "",
    ) else {
        panic!("node usage");
    };
    assert_eq!(items.len(), 1);
    assert_eq!((items[0].cpu, items[0].memory), (250, 1 << 30));
}

#[test]
fn events_are_newest_first_with_the_first_time_there_is() {
    let text = "web\tPod\ta\tBackOff\t<no value>\t2026-11-08T05:00:00.000000Z\t2026-11-08T04:00:00Z\tBack-off+restarting%0Afailed\n\
                web\tPod\tb\tFailed\t2026-11-08T06:00:00Z\t<no value>\t2026-11-08T01:00:00Z\tx\n";
    let Some(Data::Events(items)) = parse(Kind::Events, text, "") else {
        panic!("events");
    };
    assert_eq!(items[0].object_name, "b");
    assert_eq!(items[0].time, "2026-11-08T06:00:00Z");
    assert_eq!(items[1].time, "2026-11-08T05:00:00.000000Z");
    assert_eq!(items[1].message, "Back-off restartingfailed");
}

#[test]
fn events_are_capped() {
    let text: String = (0..MAX_EVENTS + 20)
        .map(|at| format!("n\tPod\tp\tR\t2026-{at:05}\t\t\tm\n"))
        .collect();
    let Some(Data::Events(items)) = parse(Kind::Events, &text, "") else {
        panic!("events");
    };
    assert_eq!(items.len(), MAX_EVENTS);
    assert_eq!(items[0].time, format!("2026-{:05}", MAX_EVENTS + 19));
}

#[test]
fn quantities() {
    for (value, expected) in [
        ("100m", 100),
        ("2", 2000),
        ("1.5", 1500),
        ("31415926n", 32),
        ("5000u", 5),
        ("1k", 1_000_000),
    ] {
        assert_eq!(cpu_millis(value), Some(expected), "{value}");
    }
    for (value, expected) in [
        ("64Mi", 64 * 1024 * 1024),
        ("1Gi", 1 << 30),
        ("1000Ki", 1_024_000),
        ("129M", 129_000_000),
        ("1G", 1_000_000_000),
        ("128974848000m", 128_974_848),
        ("1e3", 1000),
        ("2048", 2048),
        ("1E", 1_000_000_000_000_000_000),
    ] {
        assert_eq!(memory_bytes(value), Some(expected), "{value}");
    }
    for bad in ["", "abc", "<no value>", "-1", "NaN"] {
        assert_eq!(cpu_millis(bad), None, "{bad}");
        assert_eq!(memory_bytes(bad), None, "{bad}");
    }
}

#[test]
fn commands_name_their_scope_and_never_write() {
    let all = arguments(Kind::Pods, "");
    assert!(all.starts_with("get pods -A -o go-template='"));
    assert!(arguments(Kind::Pods, "web").starts_with("get pods -n 'web' -o go-template='"));
    assert_eq!(
        arguments(Kind::PodUsage, "web"),
        "top pods -n 'web' --no-headers"
    );
    assert_eq!(arguments(Kind::NodeUsage, "web"), "top nodes --no-headers");
    assert!(arguments(Kind::Events, "").contains("--field-selector type=Warning"));
    assert!(arguments(Kind::Nodes, "web").starts_with("get nodes -o"));
    assert!(arguments(Kind::Services, "").starts_with("get services,endpoints -A"));
    assert!(
        arguments(Kind::Workloads, "").starts_with("get deployments,statefulsets,daemonsets -A")
    );
}
