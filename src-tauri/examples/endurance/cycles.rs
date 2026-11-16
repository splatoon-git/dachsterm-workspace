//! Repeated connect, 1MiB of output and close. Every connection and handle must be returned,
//! and memory, descriptors and threads must level off after a warm-up.
use super::*;
use serde_json::json;

const WARM_UP: usize = 30;

pub async fn run(ctx: &Ctx) -> Result<serde_json::Value> {
    let cycles: usize = std::env::var("DACHSTERM_ENDURANCE_CYCLES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300);
    let baseline = ctx.counts();
    let started = std::time::Instant::now();
    let mut samples = vec![(0usize, sample(started)?)];
    for cycle in 1..=cycles {
        let mut c = ctx
            .client()
            .await
            .map_err(|e| format!("cycle {cycle} connect: {e}"))?;
        c.send(
            "stty -echo; head -c 1048576 /dev/zero | tr '\\0' 'x'; printf '\\nCYCLE_%s\\n' DONE\n",
        )
        .await?;
        let d = drain(&mut c, b"CYCLE_DONE", Duration::ZERO).await?;
        assert!(d.bytes >= 1048576, "cycle {cycle} output short");
        c.stop().await?;
        drop(c);
        assert_eq!(
            ctx.counts(),
            baseline,
            "cycle {cycle}: connection or handle leak"
        );
        if cycle % 10 == 0 {
            // Closing tasks finish shortly after the close event; sample a settled process.
            tokio::time::sleep(Duration::from_millis(200)).await;
            let s = sample(started)?;
            samples.push((cycle, s));
            println!(
                "INFO cycle {cycle}: RSS {}MiB, fds {}, threads {}",
                s.rss_kib / 1024,
                s.fds,
                s.threads
            );
        }
    }
    let warm = samples
        .iter()
        .find(|(c, _)| *c >= WARM_UP)
        .map(|(_, s)| *s)
        .ok_or("too few cycles for a warm-up")?;
    let last = samples.last().unwrap().1;
    let max_rss = samples.iter().map(|(_, s)| s.rss_kib).max().unwrap();
    // Least-squares slope after the warm-up, in KiB per 100 cycles.
    let after: Vec<(f64, f64)> = samples
        .iter()
        .filter(|(c, _)| *c >= WARM_UP)
        .map(|(c, s)| (*c as f64, s.rss_kib as f64))
        .collect();
    let n = after.len() as f64;
    let (mx, my) = (
        after.iter().map(|p| p.0).sum::<f64>() / n,
        after.iter().map(|p| p.1).sum::<f64>() / n,
    );
    let slope = after.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum::<f64>()
        / after.iter().map(|p| (p.0 - mx).powi(2)).sum::<f64>()
        * 100.0;
    println!(
        "INFO {cycles} cycles in {:.0}s: RSS start {}MiB, after warm-up {}MiB, last {}MiB, max {}MiB, slope {:.0}KiB/100 cycles; fds {}→{}; threads {}→{}",
        started.elapsed().as_secs_f64(),
        samples[0].1.rss_kib / 1024,
        warm.rss_kib / 1024,
        last.rss_kib / 1024,
        max_rss / 1024,
        slope,
        warm.fds,
        last.fds,
        warm.threads,
        last.threads
    );
    assert!(
        last.rss_kib <= warm.rss_kib + 32 * 1024,
        "resident memory grew more than 32MiB after warm-up"
    );
    assert!(last.fds <= warm.fds + 4, "descriptors grew after warm-up");
    assert!(
        last.threads <= warm.threads + 4,
        "threads grew after warm-up"
    );
    println!(
        "PASS {cycles} connect/1MiB/close cycles return every connection, descriptor and thread"
    );
    Ok(json!({
        "cycles": cycles,
        "seconds": started.elapsed().as_secs_f64(),
        "slopeKiBPer100Cycles": slope,
        "samples": samples.iter().map(|(c, s)| json!({"cycle": c, "sample": s})).collect::<Vec<_>>(),
    }))
}
