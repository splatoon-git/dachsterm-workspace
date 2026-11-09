//! vLLM and DCGM exporter metrics, from Prometheus text (design KV.10). The metric names are the
//! original terminal tool's. They have only been checked against stand-in text in this repository,
//! not against a real engine (docs/verification/kubernetes-workspace.md). Every value is untrusted.
use super::{
    metrics::{label_value, parse_line},
    snapshot::shown,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};

const MAX_VLLM_SERIES: usize = 512;
const MAX_LABELS: usize = 512;
const MAX_NAME: usize = 256;
const MAX_DEVICES: usize = 256;
const MAX_POD_NAME: usize = 320;
const MAX_DEVICE_PODS: usize = 16;
const MAX_GPU_VALUE: f64 = 1e12;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VllmMetric {
    Run,
    Wait,
    Kv,
    Done,
    Input,
    Output,
    TtftSum,
    TtftCount,
    E2eSum,
    E2eCount,
    QueueSum,
    QueueCount,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VllmSeries {
    pub metric: VllmMetric,
    /// Empty when the engine sends no `model_name` label.
    pub model: String,
    /// Identifies the series between two samples, so a reset of one is seen.
    pub labels: String,
    pub value: f64,
}

#[derive(Debug, PartialEq)]
pub struct VllmParsed {
    pub process_start: Option<f64>,
    pub series: Vec<VllmSeries>,
}

const LEGACY_KV: &str = "vllm:gpu_cache_usage_perc";

fn vllm_metric(name: &str) -> Option<VllmMetric> {
    use VllmMetric::*;
    Some(match name {
        "vllm:num_requests_running" => Run,
        "vllm:num_requests_waiting" => Wait,
        "vllm:kv_cache_usage_perc" => Kv,
        "vllm:request_success_total" => Done,
        "vllm:prompt_tokens_total" => Input,
        "vllm:generation_tokens_total" => Output,
        "vllm:time_to_first_token_seconds_sum" => TtftSum,
        "vllm:time_to_first_token_seconds_count" => TtftCount,
        "vllm:e2e_request_latency_seconds_sum" => E2eSum,
        "vllm:e2e_request_latency_seconds_count" => E2eCount,
        "vllm:request_queue_time_seconds_sum" => QueueSum,
        "vllm:request_queue_time_seconds_count" => QueueCount,
        _ => return None,
    })
}

fn model_of(labels: &str) -> String {
    shown(
        &label_value(labels, "model_name").unwrap_or_default(),
        MAX_NAME,
    )
}

/// `None` when the answer has neither running requests nor completions: not this engine's metrics.
pub fn parse_vllm(text: &str) -> Option<VllmParsed> {
    let mut process_start = None;
    let mut series: Vec<VllmSeries> = Vec::new();
    let mut seen: HashSet<(VllmMetric, String)> = HashSet::new();
    // Older engines report the same ratio under the GPU name. It is never added to the new one.
    let mut legacy: HashMap<String, f64> = HashMap::new();
    for (name, labels, value) in text.lines().filter_map(parse_line) {
        if name == "process_start_time_seconds" {
            process_start = Some(value);
        } else if value < 0.0 {
            continue;
        } else if name == LEGACY_KV {
            let entry = legacy.entry(model_of(labels)).or_insert(value);
            *entry = entry.max(value);
        } else if let Some(metric) = vllm_metric(name) {
            let labels = shown(labels, MAX_LABELS);
            if series.len() < MAX_VLLM_SERIES && seen.insert((metric, labels.clone())) {
                series.push(VllmSeries {
                    metric,
                    model: model_of(&labels),
                    labels,
                    value,
                });
            }
        }
    }
    for (model, value) in legacy {
        let reported = |s: &VllmSeries| s.metric == VllmMetric::Kv && s.model == model;
        if !series.iter().any(reported) && series.len() < MAX_VLLM_SERIES {
            series.push(VllmSeries {
                metric: VllmMetric::Kv,
                model,
                labels: String::new(),
                value,
            });
        }
    }
    let usable = |wanted: VllmMetric| series.iter().any(|s| s.metric == wanted);
    (usable(VllmMetric::Run) || usable(VllmMetric::Done)).then_some(VllmParsed {
        process_start,
        series,
    })
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuDevice {
    pub node: String,
    /// The device's UUID, or a MIG instance of it. One device even if two exporters report it.
    pub id: String,
    pub gpu: String,
    pub model: String,
    /// Percent.
    pub util: Option<f64>,
    /// MiB.
    pub used: Option<f64>,
    pub total: Option<f64>,
    pub temp: Option<f64>,
    pub power: Option<f64>,
    /// `namespace/pod` assigned to this device, by the exporter's own labels.
    pub pods: Vec<String>,
}

#[derive(Default)]
struct Readings {
    device: GpuDevice,
    free: Option<f64>,
}

/// Empty when the answer has no GPU readings.
pub fn parse_gpu(text: &str, node: &str) -> Vec<GpuDevice> {
    let mut devices: BTreeMap<String, Readings> = BTreeMap::new();
    for (name, labels, value) in text.lines().filter_map(parse_line) {
        if !(0.0..=MAX_GPU_VALUE).contains(&value) {
            continue;
        }
        let known = matches!(
            name,
            "DCGM_FI_DEV_GPU_UTIL"
                | "DCGM_FI_DEV_FB_USED"
                | "DCGM_FI_DEV_FB_FREE"
                | "DCGM_FI_DEV_GPU_TEMP"
                | "DCGM_FI_DEV_POWER_USAGE"
        );
        if !known {
            continue;
        }
        let label = |key: &str| label_value(labels, key).unwrap_or_default();
        let gpu = label("gpu");
        let uuid = Some(label("UUID"))
            .filter(|u| !u.is_empty())
            .unwrap_or(gpu.clone());
        if uuid.is_empty() {
            continue;
        }
        let mig = label("GPU_I_ID");
        let suffix = if mig.is_empty() {
            String::new()
        } else {
            format!("/MIG-{mig}")
        };
        let id = shown(&format!("{uuid}{suffix}"), MAX_NAME);
        if !devices.contains_key(&id) && devices.len() >= MAX_DEVICES {
            continue;
        }
        let entry = devices.entry(id.clone()).or_default();
        entry.device.id = id;
        entry.device.node = shown(node, MAX_NAME);
        entry.device.gpu = shown(&format!("{gpu}{suffix}"), MAX_NAME);
        let model = label("modelName");
        if !model.is_empty() {
            entry.device.model = shown(&model, MAX_NAME);
        }
        match name {
            "DCGM_FI_DEV_GPU_UTIL" => entry.device.util = Some(value),
            "DCGM_FI_DEV_FB_USED" => entry.device.used = Some(value),
            "DCGM_FI_DEV_FB_FREE" => entry.free = Some(value),
            "DCGM_FI_DEV_GPU_TEMP" => entry.device.temp = Some(value),
            _ => entry.device.power = Some(value),
        }
        let (pod, namespace) = (label("pod"), label("namespace"));
        if !pod.is_empty() && !namespace.is_empty() {
            let assigned = shown(&format!("{namespace}/{pod}"), MAX_POD_NAME);
            let pods = &mut entry.device.pods;
            if !pods.contains(&assigned) && pods.len() < MAX_DEVICE_PODS {
                pods.push(assigned);
            }
        }
    }
    devices
        .into_values()
        .map(|mut readings| {
            readings.device.total = readings.device.used.zip(readings.free).map(|(u, f)| u + f);
            readings.device.pods.sort();
            readings.device
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stand-in text in the shape the original terminal tool parses. No real engine produced it.
    const VLLM: &str = r#"# HELP vllm:num_requests_running Running
vllm:num_requests_running{engine="0",model_name="qwen"} 2.0
vllm:num_requests_waiting{engine="0",model_name="qwen"} 1.0
vllm:kv_cache_usage_perc{engine="0",model_name="qwen"} 0.5
vllm:gpu_cache_usage_perc{engine="0",model_name="qwen"} 0.9
vllm:request_success_total{finish_reason="stop",model_name="qwen"} 10.0
vllm:request_success_total{finish_reason="length",model_name="qwen"} 3.0
vllm:generation_tokens_total{model_name="qwen"} 900.0
vllm:prompt_tokens_total{model_name="qwen"} 400.0
vllm:time_to_first_token_seconds_sum{model_name="qwen"} 4.0
vllm:time_to_first_token_seconds_count{model_name="qwen"} 8.0
vllm:e2e_request_latency_seconds_sum{model_name="qwen"} 40.0
vllm:e2e_request_latency_seconds_count{model_name="qwen"} 8.0
vllm:request_queue_time_seconds_sum{model_name="qwen"} 1.0
vllm:request_queue_time_seconds_count{model_name="qwen"} 8.0
process_start_time_seconds 1700000000.5
python_gc_objects_collected_total 99
"#;

    fn value(parsed: &VllmParsed, metric: VllmMetric) -> Vec<f64> {
        parsed
            .series
            .iter()
            .filter(|s| s.metric == metric)
            .map(|s| s.value)
            .collect()
    }

    #[test]
    fn every_metric_is_read_with_its_model_and_labels() {
        let parsed = parse_vllm(VLLM).unwrap();
        assert_eq!(parsed.process_start, Some(1700000000.5));
        assert_eq!(value(&parsed, VllmMetric::Run), [2.0]);
        assert_eq!(value(&parsed, VllmMetric::Wait), [1.0]);
        assert_eq!(value(&parsed, VllmMetric::Done), [10.0, 3.0]);
        assert_eq!(value(&parsed, VllmMetric::Output), [900.0]);
        assert_eq!(value(&parsed, VllmMetric::Input), [400.0]);
        assert_eq!(value(&parsed, VllmMetric::TtftSum), [4.0]);
        assert_eq!(value(&parsed, VllmMetric::TtftCount), [8.0]);
        assert_eq!(value(&parsed, VllmMetric::E2eSum), [40.0]);
        assert_eq!(value(&parsed, VllmMetric::E2eCount), [8.0]);
        assert_eq!(value(&parsed, VllmMetric::QueueSum), [1.0]);
        assert_eq!(value(&parsed, VllmMetric::QueueCount), [8.0]);
        assert!(parsed.series.iter().all(|s| s.model == "qwen"));
        assert_eq!(parsed.series.len(), 13);
    }

    #[test]
    fn the_newer_cache_name_wins_and_ratios_are_never_added() {
        assert_eq!(value(&parse_vllm(VLLM).unwrap(), VllmMetric::Kv), [0.5]);
    }

    #[test]
    fn the_older_cache_name_is_used_per_model_at_its_highest() {
        let parsed = parse_vllm(
            "vllm:num_requests_running{model_name=\"a\"} 1\n\
             vllm:gpu_cache_usage_perc{engine=\"0\",model_name=\"a\"} 0.25\n\
             vllm:gpu_cache_usage_perc{engine=\"1\",model_name=\"a\"} 0.75\n\
             vllm:kv_cache_usage_perc{model_name=\"b\"} 0.1\n\
             vllm:gpu_cache_usage_perc{model_name=\"b\"} 0.9\n",
        )
        .unwrap();
        let of = |model: &str| {
            parsed
                .series
                .iter()
                .filter(|s| s.metric == VllmMetric::Kv && s.model == model)
                .map(|s| s.value)
                .collect::<Vec<_>>()
        };
        assert_eq!(of("a"), [0.75]);
        assert_eq!(of("b"), [0.1]);
    }

    #[test]
    fn an_answer_without_requests_or_completions_is_not_this_engine() {
        assert_eq!(parse_vllm("up 1\nprocess_start_time_seconds 5\n"), None);
        assert_eq!(
            parse_vllm("vllm:kv_cache_usage_perc{model_name=\"a\"} 0.5\n"),
            None
        );
        assert!(parse_vllm("vllm:request_success_total{model_name=\"a\"} 1\n").is_some());
    }

    #[test]
    fn a_missing_model_label_is_kept_for_the_screen_to_name() {
        let parsed = parse_vllm("vllm:num_requests_running 1\n").unwrap();
        assert_eq!(parsed.series[0].model, "");
    }

    #[test]
    fn labels_with_quotes_and_braces_keep_their_model() {
        let parsed =
            parse_vllm("vllm:num_requests_running{model_name=\"a\\\"}b\",x=\"y z\"} 4\n").unwrap();
        assert_eq!(parsed.series[0].model, "a\"}b");
        assert_eq!(parsed.series[0].value, 4.0);
    }

    #[test]
    fn negative_or_broken_values_and_repeated_series_are_ignored() {
        let parsed = parse_vllm(
            "vllm:num_requests_running{model_name=\"a\"} -1\n\
             vllm:num_requests_waiting{model_name=\"a\"} NaN\n\
             vllm:request_success_total{model_name=\"a\"} 7\n\
             vllm:request_success_total{model_name=\"a\"} 9\n",
        )
        .unwrap();
        assert!(value(&parsed, VllmMetric::Run).is_empty());
        assert!(value(&parsed, VllmMetric::Wait).is_empty());
        assert_eq!(value(&parsed, VllmMetric::Done), [7.0]);
    }

    #[test]
    fn the_series_kept_from_one_answer_are_bounded() {
        let text: String = (0..MAX_VLLM_SERIES + 40)
            .map(|i| format!("vllm:request_success_total{{model_name=\"a\",x=\"{i}\"}} 1\n"))
            .collect();
        assert_eq!(parse_vllm(&text).unwrap().series.len(), MAX_VLLM_SERIES);
    }

    /// Stand-in text in the shape the original terminal tool parses.
    const DCGM: &str = r#"DCGM_FI_DEV_GPU_UTIL{gpu="0",UUID="GPU-a",modelName="A100",namespace="ai",pod="serve-0"} 87
DCGM_FI_DEV_FB_USED{gpu="0",UUID="GPU-a",modelName="A100",namespace="ai",pod="serve-0"} 1000
DCGM_FI_DEV_FB_FREE{gpu="0",UUID="GPU-a",modelName="A100",namespace="ai",pod="serve-0"} 3000
DCGM_FI_DEV_GPU_TEMP{gpu="0",UUID="GPU-a",modelName="A100"} 61
DCGM_FI_DEV_POWER_USAGE{gpu="0",UUID="GPU-a",modelName="A100"} 250.5
DCGM_FI_DEV_SM_CLOCK{gpu="0",UUID="GPU-a"} 1000
"#;

    #[test]
    fn a_device_is_read_with_its_memory_total_and_assigned_pod() {
        let devices = parse_gpu(DCGM, "gpu-1");
        assert_eq!(
            devices,
            vec![GpuDevice {
                node: "gpu-1".into(),
                id: "GPU-a".into(),
                gpu: "0".into(),
                model: "A100".into(),
                util: Some(87.0),
                used: Some(1000.0),
                total: Some(4000.0),
                temp: Some(61.0),
                power: Some(250.5),
                pods: vec!["ai/serve-0".into()],
            }]
        );
    }

    #[test]
    fn mig_instances_are_separate_devices() {
        let text = "DCGM_FI_DEV_GPU_UTIL{gpu=\"0\",UUID=\"GPU-a\",GPU_I_ID=\"1\"} 10\n\
                    DCGM_FI_DEV_GPU_UTIL{gpu=\"0\",UUID=\"GPU-a\",GPU_I_ID=\"2\"} 20\n";
        let devices = parse_gpu(text, "n");
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0].id, "GPU-a/MIG-1");
        assert_eq!(devices[0].gpu, "0/MIG-1");
        assert_eq!(devices[1].util, Some(20.0));
    }

    #[test]
    fn a_device_is_identified_by_index_only_when_there_is_no_uuid() {
        let devices = parse_gpu("DCGM_FI_DEV_GPU_UTIL{gpu=\"3\"} 1\n", "n");
        assert_eq!(devices[0].id, "3");
        assert!(parse_gpu("DCGM_FI_DEV_GPU_UTIL{x=\"y\"} 1\n", "n").is_empty());
    }

    #[test]
    fn memory_total_needs_both_readings_and_bad_values_are_dropped() {
        let devices = parse_gpu(
            "DCGM_FI_DEV_FB_USED{gpu=\"0\"} 100\n\
             DCGM_FI_DEV_GPU_UTIL{gpu=\"0\"} -5\n\
             DCGM_FI_DEV_GPU_TEMP{gpu=\"0\"} 1e13\n",
            "n",
        );
        assert_eq!(devices[0].total, None);
        assert_eq!(devices[0].util, None);
        assert_eq!(devices[0].temp, None);
    }

    #[test]
    fn devices_from_one_answer_are_bounded() {
        let text: String = (0..MAX_DEVICES + 9)
            .map(|i| format!("DCGM_FI_DEV_GPU_UTIL{{gpu=\"{i}\"}} 1\n"))
            .collect();
        assert_eq!(parse_gpu(&text, "n").len(), MAX_DEVICES);
    }
}
