use crate::{
    remote_exec::{self, Failure, Limits},
    ssh::Connections,
    storage::Result,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    pub mount: String,
    pub total: u64,
    pub used: u64,
    pub available: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub at: u64,
    pub cpu: Option<f64>,
    pub memory_total: u64,
    pub memory_used: u64,
    pub rx: Option<f64>,
    pub tx: Option<f64>,
    pub load: String,
    pub disks: Vec<Disk>,
    pub interfaces: Vec<String>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Monitor {
    pub connection_id: String,
    pub enabled: bool,
    pub interval: u64,
    pub interface: String,
    pub status: String,
    pub message: String,
    pub history: Vec<Sample>,
}
struct Job {
    view: Monitor,
    stop: watch::Sender<bool>,
    generation: String,
}
#[derive(Default)]
pub struct Monitors {
    entries: Mutex<HashMap<String, Job>>,
}
struct Raw {
    total: u64,
    idle: u64,
    memory_total: u64,
    memory_used: u64,
    net: HashMap<String, (u64, u64)>,
    load: String,
    disks: Vec<Disk>,
    time: Instant,
}
fn parse(text: &str) -> Result<Raw> {
    let sections: Vec<_> = text.split("\nDACHSTERM_SECTION\n").collect();
    if sections.len() != 5 {
        return Err("Linux /proc 지표를 읽을 수 없습니다.".into());
    }
    let cpu: Vec<u64> = sections[0]
        .lines()
        .find(|l| l.starts_with("cpu "))
        .ok_or("CPU 지표 없음")?
        .split_whitespace()
        .skip(1)
        .take(8)
        .map(|v| v.parse::<u64>().map_err(|_| "CPU 형식 오류"))
        .collect::<std::result::Result<_, _>>()?;
    if cpu.len() < 4 {
        return Err("CPU 지표 오류".into());
    }
    let mem: HashMap<&str, u64> = sections[1]
        .lines()
        .filter_map(|l| {
            let mut v = l.split_whitespace();
            Some((v.next()?, v.next()?.parse().ok()?))
        })
        .collect();
    let total = *mem.get("MemTotal:").ok_or("메모리 지표 없음")?;
    let available = *mem.get("MemAvailable:").ok_or("MemAvailable 미지원")?;
    let net = sections[2]
        .lines()
        .filter_map(|l| {
            let (name, counters) = l.split_once(':')?;
            let values: Vec<u64> = counters
                .split_whitespace()
                .filter_map(|v| v.parse().ok())
                .collect();
            (values.len() >= 16).then(|| (name.trim().into(), (values[0], values[8])))
        })
        .collect();
    let disks = sections[4]
        .lines()
        .skip(1)
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() < 6 {
                return None;
            }
            Some(Disk {
                mount: fields[5..].join(" "),
                total: fields[1].parse::<u64>().ok()?.saturating_mul(1024),
                used: fields[2].parse::<u64>().ok()?.saturating_mul(1024),
                available: fields[3].parse::<u64>().ok()?.saturating_mul(1024),
            })
        })
        .collect();
    Ok(Raw {
        total: cpu.iter().sum(),
        idle: cpu[3] + cpu.get(4).copied().unwrap_or(0),
        memory_total: total * 1024,
        memory_used: total.saturating_sub(available) * 1024,
        net,
        load: sections[3]
            .split_whitespace()
            .take(3)
            .collect::<Vec<_>>()
            .join(" / "),
        disks,
        time: Instant::now(),
    })
}
fn sample(raw: &Raw, previous: Option<&Raw>, interface: &str) -> Sample {
    let cpu = previous.and_then(|p| {
        let total = raw.total.checked_sub(p.total)?;
        let idle = raw.idle.checked_sub(p.idle)?;
        (total > 0 && idle <= total).then(|| 100.0 * (total - idle) as f64 / total as f64)
    });
    let mut rx = 0.;
    let mut tx = 0.;
    let mut valid = previous.is_some();
    let mut count = 0;
    for (name, (received, sent)) in &raw.net {
        if name == "lo" || (interface != "all" && name != interface) {
            continue;
        }
        count += 1;
        if let Some(p) = previous
            && let Some((pr, pt)) = p.net.get(name)
            && let Some(dr) = received.checked_sub(*pr)
            && let Some(dt) = sent.checked_sub(*pt)
        {
            let elapsed = raw.time.duration_since(p.time).as_secs_f64();
            if elapsed > 0. {
                rx += dr as f64 / elapsed;
                tx += dt as f64 / elapsed;
            } else {
                valid = false;
            }
        } else {
            valid = false;
        }
    }
    let mut interfaces: Vec<_> = raw
        .net
        .keys()
        .filter(|n| n.as_str() != "lo")
        .cloned()
        .collect();
    interfaces.sort();
    Sample {
        at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        cpu,
        memory_total: raw.memory_total,
        memory_used: raw.memory_used,
        rx: (valid && count > 0).then_some(rx),
        tx: (valid && count > 0).then_some(tx),
        load: raw.load.clone(),
        disks: raw.disks.clone(),
        interfaces,
    }
}
/// `/proc` is Linux only; other servers report the unsupported message below.
const COLLECT: &str = r"LC_ALL=C; export LC_ALL; cat /proc/stat; printf '\nDACHSTERM_SECTION\n'; cat /proc/meminfo; printf '\nDACHSTERM_SECTION\n'; cat /proc/net/dev; printf '\nDACHSTERM_SECTION\n'; cat /proc/loadavg; printf '\nDACHSTERM_SECTION\n'; df -Pk";
async fn collect(connections: &Connections, id: &str) -> Result<Raw> {
    let handle = connections.handle(id)?;
    let limits = Limits {
        timeout: Duration::from_secs(10),
        max_output: 256 * 1024,
    };
    let output =
        remote_exec::run(&handle, COLLECT, limits)
            .await
            .map_err(|failure| match failure {
                Failure::TimedOut => "지표 수집 시간 초과".into(),
                other => String::from(other),
            })?;
    if output.exit != Some(0) {
        return Err("수집 명령을 지원하지 않거나 거부되었습니다.".into());
    }
    parse(&String::from_utf8_lossy(&output.stdout))
}
impl Monitors {
    pub fn get(&self, id: &str) -> Option<Monitor> {
        self.entries.lock().unwrap().get(id).map(|j| j.view.clone())
    }
    pub fn configure(
        self: &Arc<Self>,
        connections: Arc<Connections>,
        id: String,
        enabled: bool,
        interval: u64,
        interface: String,
    ) -> Result<()> {
        if !(2..=60).contains(&interval) || interface.len() > 100 {
            return Err("수집 간격은 2~60초입니다.".into());
        }
        let mut disconnected = connections.control(&id)?.stop.subscribe();
        let generation = uuid::Uuid::new_v4().to_string();
        let (stop, mut stopped) = watch::channel(false);
        {
            let mut entries = self.entries.lock().unwrap();
            if entries.len() > 64 {
                entries.retain(|_, v| v.view.status != "disconnected");
            }
            if let Some(old) = entries.remove(&id) {
                let _ = old.stop.send(true);
            }
            entries.insert(
                id.clone(),
                Job {
                    view: Monitor {
                        connection_id: id.clone(),
                        enabled,
                        interval,
                        interface: interface.clone(),
                        status: if enabled { "measuring" } else { "disabled" }.into(),
                        message: if enabled {
                            "첫 샘플 측정 중"
                        } else {
                            "모니터링 꺼짐"
                        }
                        .into(),
                        history: Vec::new(),
                    },
                    stop,
                    generation: generation.clone(),
                },
            );
        }
        if !enabled {
            return Ok(());
        }
        let manager = self.clone();
        tokio::spawn(async move {
            let mut previous = None;
            loop {
                let result = tokio::select! {biased;_=disconnected.changed()=>break,_=stopped.changed()=>return,r=collect(&connections,&id)=>r};
                {
                    let mut entries = manager.entries.lock().unwrap();
                    let Some(job) = entries.get_mut(&id) else {
                        return;
                    };
                    if job.generation != generation {
                        return;
                    }
                    match result {
                        Ok(raw) => {
                            let sample = sample(&raw, previous.as_ref(), &interface);
                            previous = Some(raw);
                            job.view.history.push(sample);
                            if job.view.history.len() > 120 {
                                job.view.history.remove(0);
                            }
                            job.view.status = "ready".into();
                            job.view.message = "Linux · 독립 채널 수집".into();
                        }
                        Err(e) => {
                            previous = None;
                            job.view.status = "error".into();
                            job.view.message = e;
                        }
                    }
                }
                tokio::select! {_=stopped.changed()=>return,_=disconnected.changed()=>break,_=tokio::time::sleep(Duration::from_secs(interval))=>{}}
            }
            if let Some(job) = manager.entries.lock().unwrap().get_mut(&id)
                && job.generation == generation
            {
                job.view.status = "disconnected".into();
                job.view.message = "연결 종료 · 마지막 값".into();
            }
        });
        Ok(())
    }
}
#[tauri::command]
pub fn monitor_get(state: tauri::State<'_, crate::AppState>, id: String) -> Option<Monitor> {
    state.monitors.get(&id)
}
#[tauri::command]
pub async fn monitor_configure(
    state: tauri::State<'_, crate::AppState>,
    id: String,
    enabled: bool,
    interval: u64,
    interface: String,
) -> Result<()> {
    state
        .monitors
        .configure(state.connections.clone(), id, enabled, interval, interface)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn raw(cpu: u64, idle: u64, net: u64) -> Raw {
        Raw {
            total: cpu,
            idle,
            memory_total: 100,
            memory_used: 60,
            net: HashMap::from([("eth0".into(), (net, net))]),
            load: "0 / 0 / 0".into(),
            disks: vec![],
            time: Instant::now(),
        }
    }
    #[test]
    fn first_delta_and_counter_reset() {
        let first = raw(100, 50, 100);
        assert!(sample(&first, None, "all").cpu.is_none());
        let mut next = raw(200, 75, 200);
        next.time = first.time + Duration::from_secs(2);
        let s = sample(&next, Some(&first), "all");
        assert_eq!(s.cpu, Some(75.));
        assert_eq!(s.rx, Some(50.));
        let reset = raw(1, 1, 1);
        let s = sample(&reset, Some(&next), "all");
        assert!(s.cpu.is_none());
        assert!(s.rx.is_none());
    }
    #[test]
    fn invalid_or_unsupported_output() {
        assert!(parse("unavailable").is_err());
    }
}
