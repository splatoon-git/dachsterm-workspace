//! Shared parts of the endurance probe: process resources, runner actions and output drains.
//! The probe measures the product engine in this process. It has no WebView, so its memory is
//! the Rust side of the app only.
use super::*;
use std::time::Instant;

pub mod cycles;
pub mod faults;
pub mod long;
pub mod output;
pub mod quit;
pub mod transfer;

pub struct Ctx {
    pub manager: Arc<Connections>,
    pub store: Arc<Store>,
    pub paths: Vec<PathBuf>,
    pub profile: Profile,
    pub dir: PathBuf,
}

impl Ctx {
    pub async fn client(&self) -> Result<Client> {
        self.client_with(self.profile.clone()).await
    }
    pub async fn client_with(&self, profile: Profile) -> Result<Client> {
        let mut c = begin(
            &self.manager,
            &self.store,
            &self.paths,
            profile,
            env("PASSWORD"),
        )?;
        c.connected(false).await?;
        Ok(c)
    }
    /// The number of connections and published handles must return to these after each check.
    pub fn counts(&self) -> (usize, usize) {
        (
            self.manager.entries.lock().unwrap().len(),
            self.manager.live.lock().unwrap().len(),
        )
    }
}

#[derive(Clone, Copy, serde::Serialize)]
pub struct Sample {
    pub seconds: f64,
    pub rss_kib: u64,
    pub fds: u64,
    pub threads: u64,
}

/// Resident memory, open descriptors (handles on Windows) and threads of this process.
pub fn sample(started: Instant) -> Result<Sample> {
    let seconds = started.elapsed().as_secs_f64();
    #[cfg(target_os = "macos")]
    {
        let pid = std::process::id().to_string();
        let rss = std::process::Command::new("/bin/ps")
            .args(["-o", "rss=", "-p", &pid])
            .output()?;
        let threads = std::process::Command::new("/bin/ps")
            .args(["-M", "-p", &pid])
            .output()?;
        // read_dir holds one descriptor of its own while it lists.
        let fds = std::fs::read_dir("/dev/fd")?.count() as u64 - 1;
        Ok(Sample {
            seconds,
            rss_kib: String::from_utf8(rss.stdout)?.trim().parse()?,
            fds,
            threads: String::from_utf8(threads.stdout)?.lines().count() as u64 - 1,
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "$p=Get-Process -Id {}; Write-Output ($p.WorkingSet64.ToString()+','+$p.HandleCount.ToString()+','+$p.Threads.Count.ToString())",
                    std::process::id()
                ),
            ])
            .creation_flags(0x08000000)
            .output()?;
        let values: Vec<u64> = String::from_utf8(output.stdout)?
            .trim()
            .split(',')
            .map(str::parse)
            .collect::<std::result::Result<_, _>>()?;
        Ok(Sample {
            seconds,
            rss_kib: values[0] / 1024,
            fds: values[1],
            threads: values[2],
        })
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = seconds;
        Err("resource sampling supports macOS and Windows".into())
    }
}

/// Samples every 250ms until dropped and keeps the highest resident memory.
pub struct Peak {
    stop: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<u64>,
}
impl Peak {
    pub fn start() -> Self {
        let (stop, mut stopped) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(async move {
            let started = Instant::now();
            let mut peak = 0;
            loop {
                if let Ok(s) = tokio::task::spawn_blocking(move || sample(started).ok()).await
                    && let Some(s) = s
                {
                    peak = peak.max(s.rss_kib);
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {}
                    _ = stopped.changed() => return peak,
                }
            }
        });
        Self { stop, task }
    }
    pub async fn finish(self) -> u64 {
        let _ = self.stop.send(true);
        self.task.await.unwrap_or(0)
    }
}

/// Asks the runner to act on this process or the server, as `ACTION <id> <kind> <seconds>`.
/// The runner writes `<id>.done` in the signal folder once the action and its wait are over;
/// `faults::run` watches for it while it observes the connections.
pub fn action(kind: &str, seconds: u64) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    println!("ACTION {id} {kind} {seconds}");
    id
}
/// What a drain saw: bytes after the command, frames, and how long until the marker.
pub struct Drained {
    pub bytes: u64,
    pub frames: u64,
    pub seconds: f64,
}

/// Reads output to `marker` without keeping it, so hundreds of MiB cost no memory here.
/// Each frame is acknowledged after `render`, standing in for the time xterm takes per frame.
pub async fn drain(c: &mut Client, marker: &[u8], render: Duration) -> Result<Drained> {
    let started = Instant::now();
    let mut tail: Vec<u8> = Vec::new();
    let (mut bytes, mut frames) = (0, 0);
    loop {
        let event = timeout(Duration::from_secs(60), c.rx.recv())
            .await?
            .ok_or("event stream ended")?;
        match event {
            Event::Data { seq, bytes: data } => {
                if !render.is_zero() {
                    tokio::time::sleep(render).await;
                }
                c.manager.control(&c.id)?.ack.send(seq)?;
                bytes += data.len() as u64;
                frames += 1;
                tail.extend_from_slice(&data);
                if tail.windows(marker.len()).any(|w| w == marker) {
                    return Ok(Drained {
                        bytes,
                        frames,
                        seconds: started.elapsed().as_secs_f64(),
                    });
                }
                let keep = tail.len().saturating_sub(marker.len());
                tail.drain(..keep);
            }
            Event::State { status, message } if matches!(status.as_str(), "closed" | "error") => {
                return Err(format!("connection ended: {message}").into());
            }
            _ => {}
        }
    }
}

/// A file of `size` bytes from a fixed generator, and its SHA-256.
pub fn random_file(path: &std::path::Path, size: u64, seed: u64) -> Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Write;
    let mut out = std::io::BufWriter::with_capacity(1 << 20, std::fs::File::create(path)?);
    let mut hash = Sha256::new();
    let mut state = seed | 1;
    let mut block = vec![0u8; 1 << 20];
    let mut left = size;
    while left > 0 {
        for word in block.as_chunks_mut::<8>().0 {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            word.copy_from_slice(&state.to_le_bytes());
        }
        let n = left.min(block.len() as u64) as usize;
        out.write_all(&block[..n])?;
        hash.update(&block[..n]);
        left -= n as u64;
    }
    out.flush()?;
    Ok(format!("{:x}", hash.finalize()))
}
pub fn file_hash(path: &std::path::Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash)?;
    Ok(format!("{:x}", hash.finalize()))
}
pub async fn remote_hash(ctx: &Ctx, id: &str, path: &str) -> Result<String> {
    let out = shell(&ctx.manager, id, &format!("sha256sum '{path}'")).await?;
    Ok(out
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string())
}
/// Temporary names the queue leaves while a transfer is open.
pub async fn leftovers(
    ctx: &Ctx,
    id: &str,
    remote_dir: &str,
    local_dir: &std::path::Path,
) -> Result<Vec<String>> {
    let out = shell(&ctx.manager, id, &format!("ls -A '{remote_dir}'")).await?;
    let mut found: Vec<String> = out
        .lines()
        .filter(|l| l.contains(".dachsterm-"))
        .map(|l| format!("remote:{l}"))
        .collect();
    for entry in std::fs::read_dir(local_dir)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if name.contains(".dachsterm-") {
            found.push(format!("local:{name}"));
        }
    }
    Ok(found)
}

/// Waits until the job leaves the active states and returns it.
pub async fn settled(
    q: &dachsterm::sftp::Transfers,
    id: &str,
    limit: Duration,
) -> Result<dachsterm::sftp::Transfer> {
    timeout(limit, async {
        loop {
            let t = q.list().into_iter().find(|t| t.id == id).unwrap();
            if !matches!(t.status.as_str(), "queued" | "scanning" | "running") {
                return t;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .map_err(|_| "transfer did not settle".into())
}
pub async fn progressed(q: &dachsterm::sftp::Transfers, id: &str, fraction: f64) -> Result<()> {
    timeout(Duration::from_secs(900), async {
        loop {
            let t = q.list().into_iter().find(|t| t.id == id).unwrap();
            if t.total > 0 && t.done as f64 >= t.total as f64 * fraction {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .map_err(|_| "transfer made no progress".into())
}
/// Size of the transfers the fault and quit checks keep running. It must outlast the fault;
/// a smaller one fits a slow server path.
pub fn fault_size() -> u64 {
    std::env::var("DACHSTERM_ENDURANCE_FAULT_MIB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(512)
        * 1048576
}
pub fn mib(bytes: u64) -> f64 {
    bytes as f64 / 1048576.0
}
