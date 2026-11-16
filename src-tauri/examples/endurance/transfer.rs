//! A large file up and back down through the persistent queue, compared by SHA-256.
use super::*;
use dachsterm::sftp::Transfers;
use serde_json::json;

pub async fn run(ctx: &Ctx) -> Result<serde_json::Value> {
    let size: u64 = std::env::var("DACHSTERM_ENDURANCE_TRANSFER_MIB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2048)
        * 1048576;
    let baseline = ctx.counts();
    let c = super::long::Stream::start(ctx.client().await?);
    let local = ctx.dir.join("transfer");
    std::fs::create_dir_all(&local)?;
    let source = local.join("upload.bin");
    let started = std::time::Instant::now();
    let hash = random_file(&source, size, 0x5eed_0001)?;
    println!(
        "INFO generated {}MiB in {:.1}s",
        mib(size),
        started.elapsed().as_secs_f64()
    );
    let remote_dir = format!("/tmp/endurance-{}", uuid::Uuid::new_v4());
    shell(&ctx.manager, &c.id, &format!("mkdir -p '{remote_dir}'")).await?;
    let q = Arc::new(Transfers::default());
    q.recover(ctx.store.clone())?;
    let mut legs = Vec::new();
    let mut failures = Vec::new();
    for upload in [true, false] {
        let (remote, target) = if upload {
            (format!("{remote_dir}/big.bin"), source.clone())
        } else {
            (format!("{remote_dir}/big.bin"), local.join("download.bin"))
        };
        let peak = Peak::start();
        let started = std::time::Instant::now();
        let id = q.enqueue(
            ctx.manager.clone(),
            c.id.clone(),
            vec![(remote.clone(), target.clone())],
            upload,
            "error",
            false,
        )?[0]
            .clone();
        let t = settled(&q, &id, Duration::from_secs(7200)).await?;
        let seconds = started.elapsed().as_secs_f64();
        let peak = peak.finish().await;
        let direction = if upload { "upload" } else { "download" };
        if t.status != "completed" {
            println!(
                "FAIL {direction} {} after {seconds:.0}s at {:.0}MiB: {}",
                t.status,
                mib(t.done),
                t.message
            );
            failures.push(json!({
                "direction": direction,
                "status": t.status,
                "message": t.message,
                "seconds": seconds,
                "doneBytes": t.done,
                "peakRssKiB": peak,
            }));
            break;
        }
        let matched = if upload {
            remote_hash(ctx, &c.id, &remote).await? == hash
        } else {
            file_hash(&target)? == hash
        };
        assert!(matched, "transferred bytes differ");
        println!(
            "PASS {direction} {}MiB exact SHA-256: {:.1}s, {:.1}MiB/s, peak RSS {}MiB",
            mib(size),
            seconds,
            mib(size) / seconds,
            peak / 1024
        );
        legs.push(json!({
            "direction": direction,
            "bytes": size,
            "seconds": seconds,
            "mibPerSecond": mib(size) / seconds,
            "peakRssKiB": peak,
            "sha256Match": matched,
        }));
    }
    let left = leftovers(ctx, &c.id, &remote_dir, &local).await?;
    // A failed leg keeps its partial file for a resume; that is not a leftover.
    assert!(
        left.is_empty() || !failures.is_empty(),
        "temporary files left: {left:?}"
    );
    shell(&ctx.manager, &c.id, &format!("rm -rf '{remote_dir}'")).await?;
    std::fs::remove_dir_all(&local)?;
    let (mut c, _) = c.finish().await?;
    c.stop().await?;
    assert_eq!(
        ctx.counts(),
        baseline,
        "connection or handle leak after transfer"
    );
    if failures.is_empty() {
        println!("PASS transfer leaves no temporary files and no connections");
    }
    Ok(json!({ "legs": legs, "leftovers": left, "failures": failures }))
}
