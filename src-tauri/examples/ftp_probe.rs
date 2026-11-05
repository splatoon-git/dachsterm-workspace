use daxterm::{
    ftp,
    sftp::Transfers,
    ssh::{Connections, Event},
    storage::{Profile, Store},
};
use std::{sync::Arc, time::Duration};
use tokio::time::{sleep, timeout};
use zeroize::Zeroizing;
fn env(name: &str) -> String {
    std::env::var(format!("DAXTERM_{name}")).expect("FTP fixture environment missing")
}
async fn connect(
    manager: &Arc<Connections>,
    store: &Arc<Store>,
    profile: Profile,
    secret: String,
) -> Result<String, Box<dyn std::error::Error>> {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    manager.start(
        id.clone(),
        profile,
        Zeroizing::new(secret),
        vec![],
        Arc::new(move |event| tx.send(event).map_err(|_| "probe closed".into())),
        store.clone(),
    )?;
    timeout(Duration::from_secs(20), async {
        while let Some(event) = rx.recv().await {
            if let Event::State { status, message } = event {
                if status == "connected" {
                    return Ok::<_, String>(());
                }
                if status == "error" {
                    return Err(message);
                }
            }
        }
        Err("no connection status".into())
    })
    .await??;
    Ok(id)
}
async fn settled(
    transfers: &Transfers,
    id: &str,
) -> Result<daxterm::sftp::Transfer, Box<dyn std::error::Error>> {
    timeout(Duration::from_secs(60), async {
        loop {
            let t = transfers.list().into_iter().find(|t| t.id == id).unwrap();
            if t.status != "running" {
                return t;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .map_err(Into::into)
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = tempfile::tempdir()?;
    let store = Arc::new(Store::open(&root.path().join("sessions.db"))?);
    let manager = Arc::new(Connections::default());
    for (protocol, port, encoding) in [
        ("ftp", env("FTP_PORT"), "utf-8"),
        ("ftps", env("FTPS_PORT"), "utf-8"),
        ("ftp", env("FTP_LEGACY_PORT"), "euc-kr"),
    ] {
        let profile = store.save(
            Profile {
                id: String::new(),
                name: format!("fixture-{protocol}-{encoding}"),
                host: "127.0.0.1".into(),
                port: port.parse()?,
                username: "fixture".into(),
                auth: "password".into(),
                protocol: protocol.into(),
                tls_ca_path: if protocol == "ftps" {
                    env("FTP_CA")
                } else {
                    String::new()
                },
                encoding: encoding.into(),
                key_path: String::new(),
                group_id: None,
                favorite: false,
                timeout: 10,
                keepalive: 5,
                last_connected: None,
                has_secret: false,
            },
            None,
        )?;
        if protocol == "ftps" {
            let mut untrusted = profile.clone();
            untrusted.tls_ca_path.clear();
            assert!(
                connect(&manager, &store, untrusted, env("FTP_PASSWORD"))
                    .await
                    .is_err()
            );
            println!("PASS FTPS refuses untrusted certificate without plaintext fallback");
        }
        let id = connect(&manager, &store, profile.clone(), env("FTP_PASSWORD")).await?;
        println!("CHECK {protocol}/{encoding}: connected");
        let session = manager.ftp_session(&id)?;
        let directory = format!("/한글 {}", uuid::Uuid::new_v4());
        ftp::change(&session, "mkdir", &directory, "").await?;
        let remote = format!("{directory}/공백 파일.bin");
        let source = root.path().join(format!("{}.bin", uuid::Uuid::new_v4()));
        let data: Vec<u8> = (0..32 * 1024 * 1024).map(|i| (i % 251) as u8).collect();
        std::fs::write(&source, &data)?;
        println!("CHECK {protocol}/{encoding}: directory ready");
        let transfers = Arc::new(Transfers::default());
        transfers.recover(store.clone())?;
        let job = transfers.start(
            manager.clone(),
            id.clone(),
            remote.clone(),
            source.clone(),
            true,
        )?;
        timeout(Duration::from_secs(15), async {
            while !transfers.list().iter().any(|t| t.id == job && t.done > 0) {
                sleep(Duration::from_millis(1)).await;
            }
        })
        .await?;
        println!("CHECK {protocol}/{encoding}: upload streaming");
        transfers.cancel(&job);
        let paused = settled(&transfers, &job).await?;
        println!("CHECK {protocol}/{encoding}: upload paused");
        assert_eq!(paused.status, "paused");
        assert!(paused.done < paused.total);
        // Simulate application restart: recover the plan from SQLite before resuming.
        let recovered = Arc::new(Transfers::default());
        recovered.recover(store.clone())?;
        assert!(
            recovered
                .list()
                .iter()
                .any(|t| t.id == job && t.status == "paused")
        );
        recovered.resume(
            manager.clone(),
            job.clone(),
            profile.id.clone(),
            Some(id.clone()),
        )?;
        println!("CHECK {protocol}/{encoding}: resume scheduled");
        let done = settled(&recovered, &job).await?;
        if done.status != "completed" {
            return Err(done.message.into());
        }
        println!("CHECK {protocol}/{encoding}: upload resumed");
        let listing = ftp::list(&session, &directory).await?;
        assert!(
            listing
                .entries
                .iter()
                .any(|e| e.name == "공백 파일.bin" && e.size == Some(data.len() as u64))
        );
        let local = root
            .path()
            .join(format!("{}.download", uuid::Uuid::new_v4()));
        let down = recovered.start(
            manager.clone(),
            id.clone(),
            remote.clone(),
            local.clone(),
            false,
        )?;
        timeout(Duration::from_secs(15), async {
            while !recovered.list().iter().any(|t| t.id == down && t.done > 0) {
                sleep(Duration::from_millis(1)).await;
            }
        })
        .await?;
        println!("CHECK {protocol}/{encoding}: download streaming");
        recovered.cancel(&down);
        assert_eq!(settled(&recovered, &down).await?.status, "paused");
        recovered.resume(
            manager.clone(),
            down.clone(),
            profile.id.clone(),
            Some(id.clone()),
        )?;
        let done = settled(&recovered, &down).await?;
        if done.status != "completed" {
            return Err(done.message.into());
        }
        assert_eq!(std::fs::read(&local)?, data);
        println!("CHECK {protocol}/{encoding}: download resumed");
        let copies = format!("{directory}/copies");
        ftp::change(&session, "mkdir", &copies, "").await?;
        let result = ftp::batch(&session, "copy", std::slice::from_ref(&remote), &copies).await?;
        assert!(result.errors.is_empty());
        let result = ftp::batch(&session, "copy", std::slice::from_ref(&remote), &copies).await?;
        assert_eq!(result.errors.len(), 1);
        let renamed = format!("{directory}/renamed.bin");
        ftp::change(&session, "rename", &remote, &renamed).await?;
        let result = ftp::batch(&session, "delete", std::slice::from_ref(&directory), "/").await?;
        assert!(result.errors.is_empty());
        manager.control(&id)?.stop.send_replace(true);
        println!(
            "PASS {protocol}/{encoding} real login, Unicode paths, 32MiB upload/download REST resume, persisted recovery, binary equality and file operations"
        );
    }
    manager.shutdown();
    println!("PASS FTP/FTPS integration");
    Ok(())
}
