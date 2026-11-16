//! Several connections held open for a long time: numbered ticks every second with a burst of
//! 1MiB every five minutes, one idle shell, an interactive round trip every minute and a queue
//! round trip every five minutes. No tick may go missing and memory must level off.
use super::*;
use dachsterm::sftp::Transfers;
use serde_json::json;
use std::time::Instant;

pub const TICKS: &str = "stty -echo; i=0; while :; do i=$((i+1)); printf 'TICK %d\\n' $i; if [ $((i % 300)) -eq 0 ]; then head -c 1048576 /dev/zero | tr '\\0' 'y'; echo; fi; sleep 1; done\n";

#[derive(Default, Clone, serde::Serialize)]
pub struct Stats {
    pub ticks: u64,
    pub last: u64,
    pub gaps: Vec<(u64, u64)>,
    pub bytes: u64,
    pub max_silence: f64,
    pub ended: Option<String>,
    /// Seconds after the stream started when it ended.
    pub ended_at: Option<f64>,
}

/// Drains a connection in the background, counting `TICK n` lines, until `finish`.
pub struct Stream {
    stop: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<(Client, Stats)>,
    lines: tokio::sync::broadcast::Sender<String>,
    pub id: String,
    manager: Arc<Connections>,
}
impl Stream {
    pub fn start(c: Client) -> Self {
        Self::rendering(c, Duration::ZERO)
    }
    /// Acknowledges each frame `render` after it arrives, from a thread outside the runtime,
    /// as the WebView does from its own process. A stopped process resumes that wait where it
    /// left off, so the ACK comes after the engine's timers have already seen the lost time.
    pub fn rendering(mut c: Client, render: Duration) -> Self {
        let (stop, mut stopped) = tokio::sync::watch::channel(false);
        let (lines, _) = tokio::sync::broadcast::channel(256);
        let (id, manager, out) = (c.id.clone(), c.manager.clone(), lines.clone());
        let started = Instant::now();
        let task = tokio::spawn(async move {
            let mut stats = Stats::default();
            let mut line: Vec<u8> = Vec::new();
            let mut last_event = Instant::now();
            loop {
                tokio::select! {
                    event = c.rx.recv() => {
                        let Some(event) = event else {
                            stats.ended = Some("event stream ended".into());
                            stats.ended_at = Some(started.elapsed().as_secs_f64());
                            return (c, stats);
                        };
                        match event {
                            Event::Data { seq, bytes } => {
                                if let Ok(control) = c.manager.control(&c.id) {
                                    if render.is_zero() {
                                        let _ = control.ack.send(seq);
                                    } else {
                                        let _ = tokio::task::spawn_blocking(move || {
                                            std::thread::sleep(render);
                                            let _ = control.ack.send(seq);
                                        })
                                        .await;
                                    }
                                }
                                stats.max_silence = stats.max_silence.max(last_event.elapsed().as_secs_f64());
                                last_event = Instant::now();
                                stats.bytes += bytes.len() as u64;
                                for b in bytes {
                                    if b == b'\n' {
                                        let text = String::from_utf8_lossy(&line);
                                        if let Some(n) = text.trim().strip_prefix("TICK ").and_then(|n| n.parse::<u64>().ok()) {
                                            if stats.last != 0 && n != stats.last + 1 {
                                                stats.gaps.push((stats.last, n));
                                            }
                                            stats.last = n;
                                            stats.ticks += 1;
                                        } else {
                                            let _ = out.send(text.into_owned());
                                        }
                                        line.clear();
                                    } else if line.len() < 4096 {
                                        line.push(b);
                                    }
                                }
                            }
                            Event::State { status, message } if matches!(status.as_str(), "closed" | "error") => {
                                stats.ended = Some(format!("{status}: {message}"));
                                stats.ended_at = Some(started.elapsed().as_secs_f64());
                                return (c, stats);
                            }
                            _ => {}
                        }
                    }
                    _ = stopped.changed() => return (c, stats),
                }
            }
        });
        Self {
            stop,
            task,
            lines,
            id,
            manager,
        }
    }
    /// Seconds for a typed command's output to come back while the stream keeps draining.
    pub async fn ping(&self, n: u64) -> Result<f64> {
        let mut lines = self.lines.subscribe();
        let started = Instant::now();
        let input = format!("printf 'PONG_%s\\n' {n}\n").into_bytes();
        self.manager
            .control(&self.id)?
            .input
            .send(Input::Data(input))
            .await?;
        let want = format!("PONG_{n}");
        timeout(Duration::from_secs(30), async {
            loop {
                if lines.recv().await?.contains(&want) {
                    return Ok::<_, tokio::sync::broadcast::error::RecvError>(());
                }
            }
        })
        .await??;
        Ok(started.elapsed().as_secs_f64())
    }
    pub fn ended(&self) -> bool {
        self.task.is_finished()
    }
    pub async fn finish(self) -> Result<(Client, Stats)> {
        let _ = self.stop.send(true);
        Ok(self.task.await?)
    }
}

pub async fn ticking(ctx: &Ctx) -> Result<Client> {
    let c = ctx.client().await?;
    c.send(TICKS).await?;
    Ok(c)
}

pub async fn run(ctx: &Ctx) -> Result<serde_json::Value> {
    let minutes: u64 = std::env::var("DACHSTERM_ENDURANCE_MINUTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(60);
    let baseline = ctx.counts();
    let started = Instant::now();
    let mut streams = Vec::new();
    for _ in 0..5 {
        streams.push(Stream::start(ticking(ctx).await?));
    }
    let idle = ctx.client().await?;
    idle.send("stty -echo\n").await?;
    let idle = Stream::start(idle);
    let interactive = ctx.client().await?;
    interactive.send("stty -echo\n").await?;
    let interactive = Stream::start(interactive);
    let q = Arc::new(Transfers::default());
    q.recover(ctx.store.clone())?;
    let local = ctx.dir.join("long");
    std::fs::create_dir_all(&local)?;
    let source = local.join("round.bin");
    let hash = random_file(&source, 16 * 1048576, 0x10e6)?;
    let remote_dir = format!("/tmp/endurance-long-{}", uuid::Uuid::new_v4());
    shell(
        &ctx.manager,
        &interactive.id,
        &format!("mkdir -p '{remote_dir}'"),
    )
    .await?;
    let mut samples = vec![sample(started)?];
    let mut pings = Vec::new();
    let mut rounds = 0;
    for minute in 1..=minutes {
        let next = started + Duration::from_secs(minute * 60);
        tokio::time::sleep_until(next.into()).await;
        for (i, s) in streams.iter().enumerate() {
            assert!(!s.ended(), "stream {i} ended at minute {minute}");
        }
        assert!(!idle.ended(), "idle connection ended at minute {minute}");
        pings.push(interactive.ping(minute).await?);
        if minute % 5 == 0 {
            let remote = format!("{remote_dir}/round-{minute}.bin");
            let back = local.join(format!("back-{minute}.bin"));
            for (upload, path) in [(true, source.clone()), (false, back.clone())] {
                let id = q.enqueue(
                    ctx.manager.clone(),
                    interactive.id.clone(),
                    vec![(remote.clone(), path)],
                    upload,
                    "error",
                    false,
                )?[0]
                    .clone();
                let t = settled(&q, &id, Duration::from_secs(300)).await?;
                assert_eq!(t.status, "completed", "{}", t.message);
            }
            assert_eq!(
                file_hash(&back)?,
                hash,
                "round trip at minute {minute} differs"
            );
            std::fs::remove_file(back)?;
            shell(&ctx.manager, &interactive.id, &format!("rm -f '{remote}'")).await?;
            rounds += 1;
        }
        let s = sample(started)?;
        println!(
            "INFO minute {minute}: RSS {}MiB, fds {}, threads {}, ping {:.0}ms",
            s.rss_kib / 1024,
            s.fds,
            s.threads,
            pings.last().unwrap() * 1000.0
        );
        samples.push(s);
    }
    let mut stats = Vec::new();
    let mut clients = Vec::new();
    for s in streams {
        let (c, st) = s.finish().await?;
        clients.push(c);
        stats.push(st);
    }
    let idle_ping = idle.ping(0).await?;
    let (idle, idle_stats) = idle.finish().await?;
    clients.push(idle);
    for (i, s) in stats.iter().enumerate() {
        assert!(s.ended.is_none(), "stream {i}: {:?}", s.ended);
        assert!(s.gaps.is_empty(), "stream {i} lost ticks: {:?}", s.gaps);
        assert!(
            s.ticks + 5 >= minutes * 60,
            "stream {i} had only {} ticks",
            s.ticks
        );
    }
    assert!(
        idle_stats.ended.is_none(),
        "idle connection: {:?}",
        idle_stats.ended
    );
    for mut c in clients {
        c.stop().await?;
    }
    shell(
        &ctx.manager,
        &interactive.id,
        &format!("rm -rf '{remote_dir}'"),
    )
    .await?;
    let (mut interactive, _) = interactive.finish().await?;
    interactive.stop().await?;
    std::fs::remove_dir_all(&local)?;
    assert_eq!(
        ctx.counts(),
        baseline,
        "connection or handle leak after long run"
    );
    let warm = samples[samples.len().min(6) - 1];
    let last = *samples.last().unwrap();
    let max_ping = pings.iter().cloned().fold(0.0, f64::max);
    println!(
        "INFO long run {minutes}min: RSS start {}MiB, after 5min {}MiB, last {}MiB; fds {}→{}; threads {}→{}; max ping {:.0}ms; idle ping {:.0}ms; {} ticks per stream",
        samples[0].rss_kib / 1024,
        warm.rss_kib / 1024,
        last.rss_kib / 1024,
        warm.fds,
        last.fds,
        warm.threads,
        last.threads,
        max_ping * 1000.0,
        idle_ping * 1000.0,
        stats[0].ticks
    );
    assert!(
        last.rss_kib <= warm.rss_kib + 32 * 1024,
        "memory grew after warm-up"
    );
    assert!(max_ping < 1.0, "interactive round trip took {max_ping:.2}s");
    println!(
        "PASS {minutes}min: 5 streams without a lost tick, idle shell alive, {rounds} queue round trips exact"
    );
    Ok(json!({
        "minutes": minutes,
        "streams": stats,
        "idle": idle_stats,
        "idlePingSeconds": idle_ping,
        "pingSeconds": pings,
        "queueRoundTrips": rounds,
        "samples": samples,
    }))
}
