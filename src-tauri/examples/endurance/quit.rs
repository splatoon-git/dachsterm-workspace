//! Quitting with an upload and a download running. `graceful` does what the app does on
//! ExitRequested (stop every connection, wait up to 3s). `kill` is split over two processes:
//! the runner kills the first with SIGKILL, and the second starts on the same data folder.
//! In both cases the restarted queue must offer to resume, and resuming must finish byte for byte.
use super::long::Stream;
use super::*;
use dachsterm::sftp::Transfers;
use serde_json::json;
use std::time::Instant;

#[derive(serde::Serialize, serde::Deserialize)]
struct Plan {
    remote_dir: String,
    up: String,
    down: String,
    up_hash: String,
    down_hash: String,
}

/// Starts both directions and returns once each has moved `fraction` of the way.
async fn start(ctx: &Ctx, q: &Arc<Transfers>, holder: &str, fraction: f64) -> Result<Plan> {
    let local = ctx.dir.join("quit");
    std::fs::create_dir_all(&local)?;
    let size = fault_size();
    let up_hash = random_file(&local.join("up.bin"), size, 0x0917)?;
    let remote_dir = format!("/tmp/endurance-quit-{}", uuid::Uuid::new_v4());
    let down_hash = shell(
        &ctx.manager,
        holder,
        &format!(
            "mkdir -p '{remote_dir}' && head -c {size} /dev/urandom > '{remote_dir}/down.bin' && sha256sum '{remote_dir}/down.bin'"
        ),
    )
    .await?
    .split_whitespace()
    .next()
    .unwrap_or_default()
    .to_string();
    let mut ids = Vec::new();
    for (upload, remote, path) in [
        (true, format!("{remote_dir}/up.bin"), local.join("up.bin")),
        (
            false,
            format!("{remote_dir}/down.bin"),
            local.join("down.bin"),
        ),
    ] {
        ids.push(
            q.enqueue(
                ctx.manager.clone(),
                holder.into(),
                vec![(remote, path)],
                upload,
                "error",
                false,
            )?[0]
                .clone(),
        );
    }
    for id in &ids {
        progressed(q, id, fraction).await?;
    }
    Ok(Plan {
        remote_dir,
        up: ids[0].clone(),
        down: ids[1].clone(),
        up_hash,
        down_hash,
    })
}

/// A new queue on the same store, as the next app start builds it; then resume both.
async fn recover(ctx: &Ctx, plan: &Plan) -> Result<serde_json::Value> {
    let q = Arc::new(Transfers::default());
    q.recover(ctx.store.clone())?;
    let mut after_restart = Vec::new();
    for id in [&plan.up, &plan.down] {
        let t = q
            .list()
            .into_iter()
            .find(|t| &t.id == id)
            .ok_or("job missing after restart")?;
        assert_eq!(
            t.status, "paused",
            "after restart: {} {}",
            t.status, t.message
        );
        after_restart.push(
            json!({"status": t.status, "message": t.message, "done": t.done, "total": t.total}),
        );
    }
    let fresh = Stream::start(ctx.client().await?);
    let started = Instant::now();
    for id in [&plan.up, &plan.down] {
        q.resume(
            ctx.manager.clone(),
            id.clone(),
            ctx.profile.id.clone(),
            Some(fresh.id.clone()),
        )?;
    }
    for id in [&plan.up, &plan.down] {
        let t = settled(&q, id, Duration::from_secs(600)).await?;
        assert_eq!(t.status, "completed", "{}", t.message);
    }
    let local = ctx.dir.join("quit");
    let up =
        remote_hash(ctx, &fresh.id, &format!("{}/up.bin", plan.remote_dir)).await? == plan.up_hash;
    let down = file_hash(&local.join("down.bin"))? == plan.down_hash;
    assert!(
        up && down,
        "resumed bytes differ (upload {up}, download {down})"
    );
    let left = leftovers(ctx, &fresh.id, &plan.remote_dir, &local).await?;
    assert!(left.is_empty(), "temporary files left: {left:?}");
    shell(
        &ctx.manager,
        &fresh.id,
        &format!("rm -rf '{}'", plan.remote_dir),
    )
    .await?;
    std::fs::remove_dir_all(&local)?;
    let (mut fresh, _) = fresh.finish().await?;
    fresh.stop().await?;
    Ok(json!({
        "afterRestart": after_restart,
        "resumeSeconds": started.elapsed().as_secs_f64(),
        "uploadExact": up,
        "downloadExact": down,
        "leftovers": left,
    }))
}

pub async fn graceful(ctx: &Ctx) -> Result<serde_json::Value> {
    let baseline = ctx.counts();
    let q = Arc::new(Transfers::default());
    q.recover(ctx.store.clone())?;
    let holder = Stream::start(ctx.client().await?);
    let plan = start(ctx, &q, &holder.id, 0.2).await?;
    // RunEvent::ExitRequested: stop every connection, then wait up to 3s for them to finish.
    let t0 = Instant::now();
    ctx.manager.shutdown();
    let closed = timeout(Duration::from_secs(3), async {
        while ctx.counts().0 != baseline.0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .is_ok();
    let closed_in = t0.elapsed().as_secs_f64();
    let mut at_exit = Vec::new();
    for id in [&plan.up, &plan.down] {
        let t = q.list().into_iter().find(|t| &t.id == id).unwrap();
        at_exit.push(json!({"status": t.status, "message": t.message, "done": t.done}));
    }
    println!(
        "INFO graceful exit: connections closed {closed} in {closed_in:.2}s, jobs {at_exit:?}"
    );
    assert!(closed, "connections still open 3s after exit");
    let _ = holder.finish().await?;
    // The app process ends here; this queue is never used again.
    drop(q);
    let recovered = recover(ctx, &plan).await?;
    assert_eq!(
        ctx.counts(),
        baseline,
        "connection or handle leak after quit"
    );
    println!(
        "PASS graceful exit during upload+download: restart offers resume, resumed bytes exact, no temporary files"
    );
    Ok(json!({"closedSeconds": closed_in, "atExit": at_exit, "recovery": recovered}))
}

/// First process: start both, record the plan and ask the runner for SIGKILL.
pub async fn kill_start(ctx: &Ctx) -> Result<serde_json::Value> {
    let q = Arc::new(Transfers::default());
    q.recover(ctx.store.clone())?;
    let holder = Stream::start(ctx.client().await?);
    let plan = start(ctx, &q, &holder.id, 0.3).await?;
    std::fs::write(ctx.dir.join("kill-plan.json"), serde_json::to_vec(&plan)?)?;
    let at_kill: Vec<_> = q
        .list()
        .into_iter()
        .map(|t| json!({"status": t.status, "done": t.done, "total": t.total}))
        .collect();
    println!("INFO before SIGKILL: {at_kill:?}");
    action("kill", 0);
    tokio::time::sleep(Duration::from_secs(120)).await;
    Err("the runner did not kill this process".into())
}

/// Second process on the same data folder.
pub async fn kill_recover(ctx: &Ctx) -> Result<serde_json::Value> {
    let plan: Plan = serde_json::from_slice(&std::fs::read(ctx.dir.join("kill-plan.json"))?)?;
    let recovered = recover(ctx, &plan).await?;
    println!(
        "PASS SIGKILL during upload+download: restart offers resume, resumed bytes exact, no temporary files"
    );
    Ok(json!({"recovery": recovered}))
}
