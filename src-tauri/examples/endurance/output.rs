//! Large output through the product terminal path: throughput with an immediate ACK (the
//! engine's own ceiling), with a per-frame render delay (what a slower renderer leaves), and
//! how long Ctrl+C takes to stop an endless stream.
use super::*;
use serde_json::json;

/// One `ls -l`-like line with colour and Korean, as real output mixes them.
pub const LINE: &str = "L=$(printf 'drwxr-xr-x  2 probe probe  4096 Nov 16 12:00 \\033[1;34m한글 폴더 directory-name-0123456789\\033[0m')";

pub async fn run(ctx: &Ctx) -> Result<serde_json::Value> {
    let size: u64 = std::env::var("DACHSTERM_ENDURANCE_OUTPUT_MIB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(256);
    let baseline = ctx.counts();
    let mut c = ctx.client().await?;
    c.send(&format!("stty -echo; {LINE}; printf 'READY_%s\\n' OUT\n"))
        .await?;
    drain(&mut c, b"READY_OUT", Duration::ZERO).await?;
    let mut runs = Vec::new();
    // The full size at the engine's own pace, then smaller runs with a render delay per frame.
    for (mib_size, render_ms) in [(size, 0u64), (64, 1), (64, 4), (32, 16)] {
        let peak = Peak::start();
        c.send(&format!(
            "yes \"$L\" | head -c {}; printf '\\nOUT_%s\\n' DONE\n",
            mib_size * 1048576
        ))
        .await?;
        let d = drain(&mut c, b"OUT_DONE", Duration::from_millis(render_ms)).await?;
        let peak = peak.finish().await;
        let rate = mib(d.bytes) / d.seconds;
        println!(
            "PASS output {mib_size}MiB render {render_ms}ms/frame: {:.1}MiB/s, {} frames, {:.0}KiB/frame, peak RSS {}MiB",
            rate,
            d.frames,
            d.bytes as f64 / d.frames as f64 / 1024.0,
            peak / 1024
        );
        runs.push(json!({
            "requestedMiB": mib_size,
            "renderMsPerFrame": render_ms,
            "receivedBytes": d.bytes,
            "frames": d.frames,
            "seconds": d.seconds,
            "mibPerSecond": rate,
            "peakRssKiB": peak,
        }));
    }
    // Ctrl+C during an endless stream: time and bytes until the prompt answers again.
    let mut interrupts = Vec::new();
    for render_ms in [0u64, 4] {
        c.send("yes \"$L\"\n").await?;
        let warm = drain_bytes(&mut c, 32 * 1048576, Duration::from_millis(render_ms)).await?;
        assert!(warm >= 32 * 1048576);
        c.send("\x03").await?;
        c.send("printf 'INT_%s\\n' DONE\n").await?;
        let d = drain(&mut c, b"INT_DONE", Duration::from_millis(render_ms)).await?;
        println!(
            "PASS Ctrl+C under endless output, render {render_ms}ms/frame: prompt after {:.2}s and {:.1}MiB",
            d.seconds,
            mib(d.bytes)
        );
        interrupts.push(json!({
            "renderMsPerFrame": render_ms,
            "secondsToPrompt": d.seconds,
            "bytesAfterInterrupt": d.bytes,
        }));
    }
    c.stop().await?;
    assert_eq!(
        ctx.counts(),
        baseline,
        "connection or handle leak after output"
    );
    Ok(json!({ "runs": runs, "interrupts": interrupts }))
}

/// Reads at least `count` bytes of output.
async fn drain_bytes(c: &mut Client, count: u64, render: Duration) -> Result<u64> {
    let mut bytes = 0;
    while bytes < count {
        let event = timeout(Duration::from_secs(60), c.rx.recv())
            .await?
            .ok_or("event stream ended")?;
        if let Event::Data { seq, bytes: data } = event {
            if !render.is_zero() {
                tokio::time::sleep(render).await;
            }
            c.manager.control(&c.id)?.ack.send(seq)?;
            bytes += data.len() as u64;
        }
    }
    Ok(bytes)
}
