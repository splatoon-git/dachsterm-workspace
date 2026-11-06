use dachsterm::{
    sftp::{self, Transfers},
    ssh::Connections,
    storage::Store,
};
use std::{path::Path, sync::Arc, time::Duration};

async fn settled(q: &Transfers, id: &str) -> Result<sftp::Transfer, Box<dyn std::error::Error>> {
    tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            let t = q.list().into_iter().find(|t| t.id == id).unwrap();
            if !matches!(t.status.as_str(), "queued" | "scanning" | "running") {
                return t;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .map_err(Into::into)
}
async fn completed(q: &Transfers, id: &str) -> Result<(), Box<dyn std::error::Error>> {
    let t = settled(q, id).await?;
    assert_eq!(t.status, "completed", "{}", t.message);
    Ok(())
}
fn compare_tree(source: &Path, target: &Path) {
    for item in std::fs::read_dir(source).unwrap() {
        let item = item.unwrap();
        let dest = target.join(item.file_name());
        if item.file_type().unwrap().is_dir() {
            assert!(dest.is_dir());
            compare_tree(&item.path(), &dest);
        } else {
            assert_eq!(
                std::fs::read(item.path()).unwrap(),
                std::fs::read(dest).unwrap()
            );
        }
    }
}
pub async fn run(
    manager: Arc<Connections>,
    connection: &str,
    parent: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let local = tempfile::tempdir()?;
    let store = Arc::new(Store::open(&local.path().join("queue.db"))?);
    let q = Arc::new(Transfers::default());
    q.recover(store.clone())?;
    let source = local.path().join("한글 폴더");
    std::fs::create_dir_all(source.join("중첩 폴더/빈 폴더"))?;
    std::fs::create_dir(source.join("empty"))?;
    std::fs::write(source.join("같은 이름.txt"), "한글 파일\n원본")?;
    std::fs::write(
        source.join("중첩 폴더/같은 이름.txt"),
        b"nested different content",
    )?;
    for i in 0..24 {
        std::fs::write(
            source.join(format!("small {i:02}.bin")),
            vec![i; 257 + i as usize],
        )?;
    }
    let remote = format!(
        "{}/queue-{}",
        parent.trim_end_matches('/'),
        uuid::Uuid::new_v4()
    );
    let profile = manager.control(connection)?.profile.id.clone();
    let start =
        |q: &Arc<Transfers>, remote: String, local: std::path::PathBuf, upload, policy: &str| {
            q.enqueue(
                manager.clone(),
                connection.into(),
                vec![(remote, local)],
                upload,
                policy,
                false,
            )
            .map(|ids| ids[0].clone())
        };
    let up = start(&q, remote.clone(), source.clone(), true, "skip")?;
    completed(&q, &up).await?;
    assert_eq!(q.list().iter().find(|t| t.id == up).unwrap().files, 30);
    let out = local.path().join("왕복");
    let down = start(&q, remote.clone(), out.clone(), false, "skip")?;
    completed(&q, &down).await?;
    compare_tree(&source, &out);
    println!("PASS queue nested/empty/Korean/space/same-name/24-small-files exact roundtrip");

    std::fs::write(source.join("같은 이름.txt"), b"explicit overwrite revision")?;
    let skip = start(&q, remote.clone(), source.clone(), true, "skip")?;
    completed(&q, &skip).await?;
    assert_eq!(q.list().iter().find(|t| t.id == skip).unwrap().skipped, 26);
    let check = local.path().join("skip-check");
    let d = start(
        &q,
        format!("{remote}/같은 이름.txt"),
        check.clone(),
        false,
        "skip",
    )?;
    completed(&q, &d).await?;
    assert_eq!(std::fs::read(check)?, "한글 파일\n원본".as_bytes());
    let overwrite = start(
        &q,
        format!("{remote}/같은 이름.txt"),
        source.join("같은 이름.txt"),
        true,
        "overwrite",
    )?;
    completed(&q, &overwrite).await?;
    let output = local.path().join("overwrite-check");
    std::fs::write(&output, b"old local destination")?;
    let d = start(
        &q,
        format!("{remote}/같은 이름.txt"),
        output.clone(),
        false,
        "overwrite",
    )?;
    completed(&q, &d).await?;
    assert_eq!(std::fs::read(output)?, b"explicit overwrite revision");
    let rename = start(
        &q,
        format!("{remote}/같은 이름.txt"),
        source.join("같은 이름.txt"),
        true,
        "rename",
    )?;
    completed(&q, &rename).await?;
    let renamed = q.items(&rename, 0)?;
    assert!(renamed[0].name.contains("(DachsTerm "));
    println!("PASS queue skip/rename/explicit overwrite retains original until commit");

    let large = local.path().join("large.bin");
    std::fs::File::create(&large)?.set_len(64 * 1024 * 1024)?;
    let pending = start(
        &q,
        format!("{remote}/resume.bin"),
        large.clone(),
        true,
        "skip",
    )?;
    tokio::time::timeout(Duration::from_secs(60), async {
        while !q.list().iter().any(|t| t.id == pending && t.done > 0) {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await?;
    assert!(
        start(
            &q,
            format!("{remote}/resume.bin"),
            large.clone(),
            true,
            "skip"
        )
        .is_err()
    );
    q.control(std::slice::from_ref(&pending), "pause")?;
    assert_eq!(settled(&q, &pending).await?.status, "paused");
    let recovered = Arc::new(Transfers::default());
    recovered.recover(store.clone())?;
    assert_eq!(
        recovered
            .list()
            .iter()
            .find(|t| t.id == pending)
            .unwrap()
            .status,
        "paused"
    );
    assert!(
        recovered
            .resume(
                manager.clone(),
                pending.clone(),
                "wrong-profile".into(),
                Some(connection.into())
            )
            .is_err()
    );
    recovered.resume(
        manager.clone(),
        pending.clone(),
        profile.clone(),
        Some(connection.into()),
    )?;
    completed(&recovered, &pending).await?;
    let final_out = local.path().join("large-download");
    let d = start(
        &recovered,
        format!("{remote}/resume.bin"),
        final_out.clone(),
        false,
        "skip",
    )?;
    completed(&recovered, &d).await?;
    assert_eq!(std::fs::read(large)?, std::fs::read(final_out)?);
    println!("PASS queue 64MiB pause/persistent recover/identity rejection/resume exact bytes");

    let roots: Vec<_> = (0..6)
        .map(|i| (format!("{remote}/queued-{i}"), source.join("같은 이름.txt")))
        .collect();
    let jobs = recovered.enqueue(
        manager.clone(),
        connection.into(),
        roots,
        true,
        "skip",
        false,
    )?;
    assert!(
        recovered
            .list()
            .iter()
            .filter(|t| matches!(t.status.as_str(), "running" | "scanning"))
            .count()
            <= 2
    );
    recovered.control(&[jobs[5].clone()], "first")?;
    recovered.control(&jobs[2..], "cancel")?;
    for id in &jobs[..2] {
        completed(&recovered, id).await?;
    }
    for id in &jobs[2..] {
        assert_eq!(settled(&recovered, id).await?.status, "cancelled");
        recovered.resume(
            manager.clone(),
            id.clone(),
            profile.clone(),
            Some(connection.into()),
        )?;
        completed(&recovered, id).await?;
    }
    println!("PASS queue bounded concurrency/order/batch cancel/retry");

    let bad = local.path().join("link-tree");
    std::fs::create_dir(&bad)?;
    #[cfg(windows)]
    std::os::windows::fs::symlink_dir(&source, bad.join("junction-like-link"))?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(&source, bad.join("link"))?;
    let job = start(&recovered, format!("{remote}/links"), bad, true, "skip")?;
    assert_eq!(settled(&recovered, &job).await?.status, "failed");
    recovered.discard(&manager, &job, connection).await?;
    println!("PASS queue link traversal refusal and safe discard");
    let scan_root = local.path().join("bounded-scan");
    std::fs::create_dir(&scan_root)?;
    for i in 0..10_001 {
        std::fs::File::create(scan_root.join(format!("n{i}")))?;
    }
    let job = start(
        &recovered,
        format!("{remote}/bounded-scan"),
        scan_root,
        true,
        "skip",
    )?;
    recovered.control(std::slice::from_ref(&job), "pause")?;
    assert_eq!(settled(&recovered, &job).await?.status, "paused");
    recovered.resume(
        manager.clone(),
        job.clone(),
        profile.clone(),
        Some(connection.into()),
    )?;
    let failed = settled(&recovered, &job).await?;
    assert_eq!(failed.status, "failed");
    assert!(failed.message.contains("10,000"));
    recovered.discard(&manager, &job, connection).await?;
    let changing = local.path().join("changing.bin");
    std::fs::File::create(&changing)?.set_len(64 * 1024 * 1024)?;
    let job = start(
        &recovered,
        format!("{remote}/changing.bin"),
        changing.clone(),
        true,
        "skip",
    )?;
    tokio::time::timeout(Duration::from_secs(60), async {
        while !recovered.list().iter().any(|t| t.id == job && t.done > 0) {
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await?;
    recovered.control(std::slice::from_ref(&job), "pause")?;
    assert_eq!(settled(&recovered, &job).await?.status, "paused");
    std::fs::OpenOptions::new()
        .write(true)
        .open(&changing)?
        .set_len(64 * 1024 * 1024 + 1)?;
    recovered.resume(
        manager.clone(),
        job.clone(),
        profile.clone(),
        Some(connection.into()),
    )?;
    let failed = settled(&recovered, &job).await?;
    assert_eq!(failed.status, "failed");
    assert!(failed.message.contains("변경"));
    recovered.discard(&manager, &job, connection).await?;
    println!("PASS queue exploration pause, 10000-item bound and changed-source resume rejection");
    if manager.control(connection)?.profile.protocol == "ssh" {
        let s = sftp::open(&manager, connection).await?;
        let denied = format!("{remote}/denied");
        s.create_dir(&denied).await?;
        sftp::change(&manager, connection, "chmod", &denied, "500").await?;
        let job = start(
            &recovered,
            format!("{denied}/file"),
            source.join("같은 이름.txt"),
            true,
            "skip",
        )?;
        assert_eq!(settled(&recovered, &job).await?.status, "failed");
        sftp::change(&manager, connection, "chmod", &denied, "700").await?;
        recovered.discard(&manager, &job, connection).await?;
        // The disposable Docker fixture has a separate 64MiB /dev/shm. Never
        // exhaust a general filesystem or an unbounded target.
        let stat = s
            .fs_info("/dev/shm")
            .await?
            .ok_or("fixture statvfs support required")?;
        let capacity = stat.blocks * stat.fragment_size;
        assert!(
            capacity > 0 && capacity <= 128 * 1024 * 1024,
            "bounded fixture tmpfs required"
        );
        let disk_root = format!("/dev/shm/dachsterm-{}", uuid::Uuid::new_v4());
        s.create_dir(&disk_root).await?;
        let large = local.path().join("disk-full.bin");
        std::fs::File::create(&large)?.set_len(capacity + 1024 * 1024)?;
        let job = start(&recovered, format!("{disk_root}/file"), large, true, "skip")?;
        assert_eq!(settled(&recovered, &job).await?.status, "failed");
        assert!(!s.try_exists(format!("{disk_root}/file")).await?);
        recovered.discard(&manager, &job, connection).await?;
        s.remove_dir(&disk_root).await?;
        println!(
            "PASS queue real SFTP permission denied and bounded tmpfs ENOSPC preserve final targets"
        );
    }
    // Only this fixture's explicitly named tree is removed.
    if manager.control(connection)?.profile.protocol == "ssh" {
        dachsterm::file_ops::batch(
            &manager,
            connection,
            connection,
            "delete",
            std::slice::from_ref(&remote),
            "",
        )
        .await?;
    } else {
        dachsterm::ftp::batch(
            &*manager.ftp_session(connection)?,
            "delete",
            std::slice::from_ref(&remote),
            "",
        )
        .await?;
    }
    Ok(())
}
