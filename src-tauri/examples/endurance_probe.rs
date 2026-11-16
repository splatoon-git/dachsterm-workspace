// Endurance checks of the product engine against the ephemeral OpenSSH fixture (roadmap 5.1):
// large output, large transfers, repeated and long connections, sleep and network faults, and
// quitting during transfers. `scripts/run-endurance.mjs` runs it and performs the faults.
// No secret output.
mod endurance;
#[path = "probe_client/mod.rs"]
mod probe_client;
use dachsterm::{
    ssh::{Connections, Event, Input},
    storage::{Profile, Store},
};
use endurance::*;
use probe_client::*;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tokio::time::timeout;

async fn run() -> Result<()> {
    let dir = PathBuf::from(std::env::var("DACHSTERM_ENDURANCE_DIR")?);
    std::fs::create_dir_all(&dir)?;
    let paths = vec![dir.join("known_hosts")];
    let store = Arc::new(Store::open(&dir.join("sessions.sqlite3"))?);
    let manager = Arc::new(Connections::default());
    // The second process of the kill check reuses the profile its queue records point at.
    let profile = match store.list()?.profiles.into_iter().next() {
        Some(p) => p,
        None => {
            let mut p = base();
            // The app's defaults, so detection times match a new session.
            p.keepalive = 15;
            p.timeout = 15;
            store.save(p, None)?
        }
    };
    if !paths[0].exists() {
        let mut first = begin(&manager, &store, &paths, profile.clone(), env("PASSWORD"))?;
        first.connected(true).await?;
        first.stop().await?;
    }
    let ctx = Ctx {
        manager,
        store,
        paths,
        profile,
        dir: dir.clone(),
    };
    let scenarios = std::env::var("DACHSTERM_ENDURANCE_SCENARIOS")?;
    let mut report = serde_json::Map::new();
    for name in scenarios.split(',') {
        let started = std::time::Instant::now();
        let result = match name {
            "output" => output::run(&ctx).await?,
            "transfer" => transfer::run(&ctx).await?,
            "cycles" => cycles::run(&ctx).await?,
            "long" => long::run(&ctx).await?,
            "quit-graceful" => quit::graceful(&ctx).await?,
            "quit-kill-start" => quit::kill_start(&ctx).await?,
            "quit-kill-recover" => quit::kill_recover(&ctx).await?,
            fault => {
                let (_, f) = faults::ALL
                    .iter()
                    .find(|(n, _)| *n == fault)
                    .ok_or(format!("unknown scenario {fault}"))?;
                faults::run(&ctx, fault, f).await?
            }
        };
        println!("INFO {name} took {:.0}s", started.elapsed().as_secs_f64());
        let failures = result["failures"].as_array().cloned().unwrap_or_default();
        report.insert(name.into(), result);
        // Written after each scenario, so a later failure keeps the earlier results.
        if let Ok(path) = std::env::var("DACHSTERM_ENDURANCE_REPORT") {
            std::fs::write(path, serde_json::to_vec_pretty(&report)?)?;
        }
        if !failures.is_empty() {
            return Err(format!("{name}: {failures:?}").into());
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    if let Err(e) = run().await {
        eprintln!("FAIL {e}");
        std::process::exit(1);
    }
}
