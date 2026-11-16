//! Sleep and network faults while a ticking shell, an idle shell and a transfer are open. The
//! runner does the fault: it stops this process (a stand-in for sleep), stops the server's
//! session processes (an SSH-level black hole), kills them, or takes the server off its network.
use super::long::{Stream, ticking};
use super::*;
use dachsterm::sftp::Transfers;
use serde_json::json;
use std::time::Instant;

pub struct Fault {
    /// What the runner does: `suspend`, `suspend-drop`, `freeze` or `link`.
    pub kind: &'static str,
    pub seconds: u64,
    /// The connections must still work afterwards. Otherwise they must end, and say so.
    pub survive: bool,
    /// How long to keep watching after the runner is done.
    pub after: u64,
}

pub const ALL: [(&str, Fault); 6] = [
    (
        "suspend",
        Fault {
            kind: "suspend",
            seconds: 120,
            survive: true,
            after: 15,
        },
    ),
    (
        "suspend-drop",
        Fault {
            kind: "suspend-drop",
            seconds: 120,
            survive: false,
            after: 120,
        },
    ),
    (
        "blip",
        Fault {
            kind: "freeze",
            seconds: 8,
            survive: true,
            after: 15,
        },
    ),
    // Longer than one SFTP request may wait (10s in russh-sftp), shorter than keepalive
    // detection (about 60s): a Wi-Fi hand-over or a busy server disk.
    (
        "stall",
        Fault {
            kind: "freeze",
            seconds: 12,
            survive: true,
            after: 15,
        },
    ),
    (
        "blackhole",
        Fault {
            kind: "freeze",
            seconds: 150,
            survive: false,
            after: 30,
        },
    ),
    (
        "link",
        Fault {
            kind: "link",
            seconds: 20,
            survive: false,
            after: 120,
        },
    ),
];

pub async fn run(ctx: &Ctx, name: &str, f: &Fault) -> Result<serde_json::Value> {
    let baseline = ctx.counts();
    let ticks = Stream::start(ticking(ctx).await?);
    // Endless output drawn at 2ms a frame: a frame is almost always waiting for its ACK.
    let busy = ctx.client().await?;
    busy.send(&format!(
        "stty -echo; {}; yes \"$L\"\n",
        super::output::LINE
    ))
    .await?;
    let busy = Stream::rendering(busy, Duration::from_millis(2));
    let idle = ctx.client().await?;
    idle.send("stty -echo\n").await?;
    let idle = Stream::start(idle);
    let holder = Stream::start(ctx.client().await?);
    let local = ctx.dir.join(format!("fault-{name}"));
    std::fs::create_dir_all(&local)?;
    let source = local.join("up.bin");
    let hash = random_file(&source, fault_size(), 0xfa17)?;
    let remote_dir = format!("/tmp/endurance-{name}-{}", uuid::Uuid::new_v4());
    shell(
        &ctx.manager,
        &holder.id,
        &format!("mkdir -p '{remote_dir}'"),
    )
    .await?;
    let remote = format!("{remote_dir}/up.bin");
    let q = Arc::new(Transfers::default());
    q.recover(ctx.store.clone())?;
    let job = q.enqueue(
        ctx.manager.clone(),
        holder.id.clone(),
        vec![(remote.clone(), source.clone())],
        true,
        "error",
        false,
    )?[0]
        .clone();
    progressed(&q, &job, 0.05).await?;
    let before = q.list().into_iter().find(|t| t.id == job).unwrap().done;

    // The runner acts now. Watch the connections and the transfer until it is done and
    // for `after` seconds more, or until everything that should end has ended.
    let signal = PathBuf::from(std::env::var("DACHSTERM_ENDURANCE_SIGNALS")?);
    let act = action(f.kind, f.seconds);
    let t0 = Instant::now();
    let mut resumed: Option<Instant> = None;
    let mut ticks_end = None;
    let mut idle_end = None;
    let mut busy_end = None;
    let mut transfer_end: Option<(f64, String, String)> = None;
    loop {
        let at = t0.elapsed().as_secs_f64();
        if ticks_end.is_none() && ticks.ended() {
            ticks_end = Some(at);
        }
        if idle_end.is_none() && idle.ended() {
            idle_end = Some(at);
        }
        if busy_end.is_none() && busy.ended() {
            busy_end = Some(at);
        }
        if transfer_end.is_none() {
            let t = q.list().into_iter().find(|t| t.id == job).unwrap();
            if !matches!(t.status.as_str(), "queued" | "scanning" | "running") {
                transfer_end = Some((at, t.status, t.message));
            }
        }
        let file = signal.join(format!("{act}.done"));
        if resumed.is_none() && file.exists() {
            std::fs::remove_file(file)?;
            resumed = Some(Instant::now());
        }
        if let Some(r) = resumed {
            let settled_all = ticks_end.is_some()
                && idle_end.is_some()
                && busy_end.is_some()
                && transfer_end.is_some();
            if r.elapsed().as_secs() >= f.after || (!f.survive && settled_all) {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let fault_seconds = resumed.unwrap().duration_since(t0).as_secs_f64();
    println!(
        "INFO {name}: fault {fault_seconds:.0}s; ticking end {ticks_end:?}s, idle end {idle_end:?}s, transfer {:?}",
        transfer_end.as_ref().map(|t| (t.0, t.1.clone()))
    );

    let idle_ping = if f.survive && !idle.ended() {
        Some(idle.ping(1).await?)
    } else {
        None
    };
    let (mut tick_client, tick_stats) = ticks.finish().await?;
    let (mut idle_client, idle_stats) = idle.finish().await?;
    let (mut busy_client, busy_stats) = busy.finish().await?;
    println!(
        "INFO {name}: busy shell {:.0}MiB drawn, ended {:?} at {:?}s",
        mib(busy_stats.bytes),
        busy_stats.ended,
        busy_end
    );
    if f.survive {
        assert!(
            tick_stats.ended.is_none(),
            "{name}: ticking shell ended: {:?}",
            tick_stats.ended
        );
        assert!(
            idle_stats.ended.is_none(),
            "{name}: idle shell ended: {:?}",
            idle_stats.ended
        );
        assert!(
            tick_stats.gaps.is_empty(),
            "{name}: ticks lost {:?}",
            tick_stats.gaps
        );
        tick_client.stop().await?;
        idle_client.stop().await?;
    } else {
        // Ended connections are already removed; there is nothing to stop.
        drop((tick_client, idle_client));
        for (what, s) in [("ticking", &tick_stats), ("idle", &idle_stats)] {
            let message = s
                .ended
                .as_deref()
                .ok_or(format!("{name}: {what} shell still open"))?;
            assert!(
                message.starts_with("error"),
                "{name}: {what} ended without an error: {message}"
            );
        }
    }

    // Recorded rather than asserted, so the rest of the check still runs and reports.
    let mut failures = Vec::new();
    match (&busy_stats.ended, f.survive) {
        (None, _) => busy_client.stop().await?,
        (Some(m), true) => failures.push(format!("busy shell ended: {m}")),
        (Some(m), false) if !m.starts_with("error") => {
            failures.push(format!("busy shell ended without an error: {m}"))
        }
        _ => {}
    }

    // Docker does not restore the published port after a network reconnect, so nothing can
    // connect to this fixture again. The resume after a lost connection is checked by
    // `blackhole` and `suspend-drop`; here only the detection is measured.
    if f.kind == "link" {
        let t = settled(&q, &job, Duration::from_secs(600)).await?;
        if t.status == "completed" {
            failures.push("transfer completed across a lost link".into());
        }
        let (_, holder_stats) = holder.finish().await?;
        if holder_stats.ended.is_none() {
            failures.push("holder connection still open".into());
        }
        timeout(Duration::from_secs(20), async {
            while ctx.counts() != baseline {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .map_err(|_| format!("{name}: connections not returned"))?;
        std::fs::remove_dir_all(&local)?;
        let verdict = if failures.is_empty() { "PASS" } else { "FAIL" };
        println!("{verdict} {name}: every connection and the transfer ended with an error");
        return Ok(json!({
            "fault": f.kind,
            "faultSeconds": fault_seconds,
            "ticking": tick_stats,
            "idle": idle_stats,
            "busy": busy_stats,
            "tickingEndSeconds": ticks_end,
            "idleEndSeconds": idle_end,
            "busyEndSeconds": busy_end,
            "transferFirstSettle": transfer_end.map(|t| json!({"seconds": t.0, "status": t.1, "message": t.2})),
            "transfer": {"status": t.status, "message": t.message, "done": t.done},
            "failures": failures,
        }));
    }

    // The transfer finishes on its own, or is resumed on a new connection, byte for byte.
    let fresh = Stream::start(ctx.client().await?);
    let mut t = settled(&q, &job, Duration::from_secs(600)).await?;
    let first = (t.status.clone(), t.message.clone());
    if f.survive && t.status != "completed" {
        failures.push(format!(
            "transfer {} at {}MiB: {}",
            t.status,
            t.done / 1048576,
            t.message
        ));
    }
    let mut resumed_from = None;
    if t.status != "completed" {
        resumed_from = Some(t.done);
        q.resume(
            ctx.manager.clone(),
            job.clone(),
            ctx.profile.id.clone(),
            Some(fresh.id.clone()),
        )?;
        t = settled(&q, &job, Duration::from_secs(600)).await?;
    }
    assert_eq!(t.status, "completed", "{name}: transfer {}", t.message);
    let exact = remote_hash(ctx, &fresh.id, &remote).await? == hash;
    assert!(exact, "{name}: transferred bytes differ");
    let left = leftovers(ctx, &fresh.id, &remote_dir, &local).await?;
    assert!(left.is_empty(), "{name}: temporary files left: {left:?}");
    shell(&ctx.manager, &fresh.id, &format!("rm -rf '{remote_dir}'")).await?;
    std::fs::remove_dir_all(&local)?;
    let (mut fresh, _) = fresh.finish().await?;
    fresh.stop().await?;
    // The holder's connection ended with the fault, or ends now.
    let (mut holder, holder_stats) = holder.finish().await?;
    if holder_stats.ended.is_none() {
        holder.stop().await?;
    }
    timeout(Duration::from_secs(20), async {
        while ctx.counts() != baseline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .map_err(|_| format!("{name}: connections not returned"))?;
    let verdict = if failures.is_empty() { "PASS" } else { "FAIL" };
    println!(
        "{verdict} {name}: connections {} as expected, transfer exact ({} first, resumed from {:?}), no temporary files",
        if f.survive {
            "survived"
        } else {
            "ended with an error"
        },
        first.0,
        resumed_from
    );
    Ok(json!({
        "fault": f.kind,
        "faultSeconds": fault_seconds,
        "expectSurvive": f.survive,
        "ticking": tick_stats,
        "idle": idle_stats,
        "busy": busy_stats,
        "busyEndSeconds": busy_end,
        "failures": failures,
        "tickingEndSeconds": ticks_end,
        "idleEndSeconds": idle_end,
        "transferAtFaultBytes": before,
        "transferFirstSettle": transfer_end.map(|t| json!({"seconds": t.0, "status": t.1, "message": t.2})),
        "transferFirst": {"status": first.0, "message": first.1},
        "resumedFromBytes": resumed_from,
        "idlePingSeconds": idle_ping,
        "sha256Match": exact,
    }))
}
