use daxterm::{editor::Editors, sftp, ssh::Connections};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
pub async fn files(
    manager: Arc<Connections>,
    id: &str,
    profile: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let root = format!("/tmp/daxterm-{} 한글", uuid::Uuid::new_v4());
    sftp::change(&manager, id, "mkdir", &root, "").await?;
    let local = tempfile::tempdir()?;
    let source = local.path().join("source.txt");
    let mut data = "한글 file roundtrip\r\n".repeat(10000).into_bytes();
    data.extend(0u8..=255);
    data.extend_from_slice(&[239, 187, 191, 0, 13, 10]);
    std::fs::write(&source, &data)?;
    let remote = format!("{root}/공백 파일.txt");
    let s = sftp::open(&manager, id).await?;
    sftp::transfer(
        &s,
        &remote,
        &source,
        &format!("{remote}.part"),
        &local.path().join("unused"),
        true,
        |_, _| {},
    )
    .await?;
    let dest = local.path().join("download.txt");
    sftp::transfer(
        &s,
        &remote,
        &dest,
        "",
        &local.path().join("download.part"),
        false,
        |_, _| {},
    )
    .await?;
    assert_eq!(std::fs::read(&dest)?, data);
    assert!(
        sftp::transfer(
            &s,
            &remote,
            &source,
            &format!("{remote}.part"),
            &dest,
            true,
            |_, _| {}
        )
        .await
        .is_err()
    );
    sftp::change(&manager, id, "chmod", &remote, "640").await?;
    assert_eq!(
        s.metadata(&remote).await?.permissions.unwrap() & 0o777,
        0o640
    );
    let listing = sftp::list(&manager, id, &root).await?;
    assert_eq!(listing.entries.len(), 1);
    let editor = Editors::default();
    // A missing executable exercises preserved recovery. The editor file itself is then changed as a real editor would.
    let edit = editor
        .start(
            &manager,
            id.into(),
            profile.into(),
            remote.clone(),
            &local.path().join("edits"),
            "daxterm-nonexistent-editor",
            &[],
            "original",
        )
        .await?;
    std::fs::write(&edit.local, b"local revision")?;
    editor
        .entries
        .lock()
        .unwrap()
        .get_mut(&edit.id)
        .unwrap()
        .status = "watching".into();
    editor.sync(&manager, &edit.id, "auto", None).await?;
    assert_eq!(editor.list()[0].status, "pending");
    assert_eq!(s.read(&remote).await?, data);
    editor.pause(&edit.id)?;
    assert_eq!(editor.list()[0].status, "recovery");
    assert_eq!(std::fs::read(&edit.local)?, b"local revision");

    let mut file = s.create(&remote).await?;
    file.write_all(b"remote revision").await?;
    file.shutdown().await?;
    assert!(
        editor
            .sync(&manager, &edit.id, "retry", None)
            .await
            .is_err()
    );
    assert_eq!(editor.list()[0].status, "conflict");
    assert_eq!(std::fs::read(&edit.local)?, b"local revision");
    editor.sync(&manager, &edit.id, "overwrite", None).await?;
    assert_eq!(s.read(&remote).await?, b"local revision");
    assert_eq!(
        s.metadata(&remote).await?.permissions.unwrap() & 0o777,
        0o640
    );
    let legacy = format!("{root}/legacy.txt");
    let legacy_bytes = daxterm::encoding::encode("한글 원본\r\n", "euc-kr")?;
    let mut file = s.create(&legacy).await?;
    file.write_all(&legacy_bytes).await?;
    file.shutdown().await?;
    let edit = editor
        .start(
            &manager,
            id.into(),
            profile.into(),
            legacy.clone(),
            &local.path().join("edits"),
            "daxterm-nonexistent-editor",
            &[],
            "euc-kr",
        )
        .await?;
    assert_eq!(std::fs::read(&edit.local)?, "한글 원본\r\n".as_bytes());
    std::fs::write(&edit.local, "한글 😀")?;
    assert!(
        editor
            .sync(&manager, &edit.id, "retry", None)
            .await
            .is_err()
    );
    assert_eq!(s.read(&legacy).await?, legacy_bytes);
    std::fs::write(&edit.local, "한글 수정\r\n")?;
    editor.sync(&manager, &edit.id, "retry", None).await?;
    assert_eq!(
        s.read(&legacy).await?,
        daxterm::encoding::encode("한글 수정\r\n", "euc-kr")?
    );
    editor.set_mode(&edit.id, "auto").await?;
    std::fs::write(&edit.local, "자동 저장")?;
    editor.sync(&manager, &edit.id, "auto", None).await?;
    assert_eq!(
        s.read(&legacy).await?,
        daxterm::encoding::encode("자동 저장", "euc-kr")?
    );
    editor.set_mode(&edit.id, "manual").await?;
    std::fs::write(&edit.local, "수동 저장")?;
    editor.sync(&manager, &edit.id, "auto", None).await?;
    assert_eq!(
        editor
            .list()
            .into_iter()
            .find(|e| e.id == edit.id)
            .unwrap()
            .status,
        "pending"
    );
    assert_eq!(
        s.read(&legacy).await?,
        daxterm::encoding::encode("자동 저장", "euc-kr")?
    );
    editor.sync(&manager, &edit.id, "retry", None).await?;
    assert_eq!(
        s.read(&legacy).await?,
        daxterm::encoding::encode("수동 저장", "euc-kr")?
    );
    std::fs::write(&edit.local, vec![b'A'; 32 * 1024 * 1024])?;
    let upload = editor.sync(&manager, &edit.id, "retry", None);
    let cancel = async {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            while !editor
                .list()
                .iter()
                .any(|e| e.id == edit.id && e.status == "uploading")
            {
                tokio::time::sleep(std::time::Duration::from_millis(1)).await;
            }
            editor.pause(&edit.id)
        })
        .await
    };
    let (result, cancelled) = tokio::join!(upload, cancel);
    cancelled??;
    assert!(result.is_err());
    assert_eq!(
        s.read(&legacy).await?,
        daxterm::encoding::encode("수동 저장", "euc-kr")?
    );
    assert!(edit.local.exists());
    assert!(
        sftp::list(&manager, id, &root)
            .await?
            .entries
            .iter()
            .all(|entry| !entry.name.ends_with(".part"))
    );
    println!(
        "PASS external editor ask/auto/manual upload and active cancellation preserves local revision and remote original"
    );
    sftp::change(&manager, id, "delete", &legacy, "").await?;
    println!(
        "PASS CP949 external-edit UTF-8 working copy, re-encode, unrepresentable character preserves remote"
    );
    let copied_dir = format!("{root}/copies");
    sftp::change(&manager, id, "mkdir", &copied_dir, "").await?;
    let result = daxterm::file_ops::batch(
        &manager,
        id,
        id,
        "copy",
        std::slice::from_ref(&remote),
        &copied_dir,
    )
    .await?;
    assert_eq!(result.completed.len(), 1);
    assert!(result.errors.is_empty());
    assert_eq!(
        s.read(format!("{copied_dir}/공백 파일.txt")).await?,
        b"local revision"
    );
    let duplicate = daxterm::file_ops::batch(
        &manager,
        id,
        id,
        "copy",
        std::slice::from_ref(&remote),
        &copied_dir,
    )
    .await?;
    assert_eq!(duplicate.errors.len(), 1);
    let recursive = daxterm::file_ops::batch(
        &manager,
        id,
        id,
        "copy",
        std::slice::from_ref(&copied_dir),
        &root,
    )
    .await?;
    assert_eq!(recursive.completed.len(), 1);
    assert!(
        s.try_exists(format!("{copied_dir} 복사 1/공백 파일.txt"))
            .await?
    );
    let moved = daxterm::file_ops::batch(
        &manager,
        id,
        id,
        "move",
        &[format!("{copied_dir}/공백 파일.txt")],
        &format!("{copied_dir} 복사 1"),
    )
    .await?;
    assert_eq!(moved.errors.len(), 1);
    let inside = daxterm::file_ops::batch(
        &manager,
        id,
        id,
        "copy",
        std::slice::from_ref(&root),
        &copied_dir,
    )
    .await?;
    assert_eq!(inside.errors.len(), 1);
    for format in ["zip", "tar", "tar.gz"] {
        let archive = format!("{root}/bundle.{format}");
        let output = format!("{root}/extract-{format}");
        daxterm::archive::run(
            &manager,
            id,
            daxterm::archive::Request {
                operation: "compress".into(),
                paths: vec![copied_dir.clone()],
                target: archive.clone(),
                format: format.into(),
                encoding: "auto".into(),
                limit_mb: 2,
            },
        )
        .await?;
        daxterm::archive::run(
            &manager,
            id,
            daxterm::archive::Request {
                operation: "extract".into(),
                paths: vec![archive.clone()],
                target: output.clone(),
                format: format.into(),
                encoding: "auto".into(),
                limit_mb: 2,
            },
        )
        .await?;
        assert_eq!(
            s.read(format!("{output}/copies/공백 파일.txt")).await?,
            b"local revision"
        );
        assert!(
            daxterm::archive::run(
                &manager,
                id,
                daxterm::archive::Request {
                    operation: "extract".into(),
                    paths: vec![archive],
                    target: output,
                    format: format.into(),
                    encoding: "auto".into(),
                    limit_mb: 2
                }
            )
            .await
            .is_err()
        );
    }
    {
        use base64::Engine;
        for (index,payload) in ["UEsDBBQAAAAAAAAAIQAMfn/YBAAAAAQAAAANAAAALi4vZXNjYXBlLnR4dHRlc3RQSwECFAAUAAAAAAAAACEADH5/2AQAAAAEAAAADQAAAAAAAAAAAAAAgAEAAAAALi4vZXNjYXBlLnR4dFBLBQYAAAAAAQABADsAAAAvAAAAAAA=","UEsDBBQAAAAAAAAAIQAMfn/YBAAAAAQAAAANAAAAL2Fic29sdXRlLnR4dHRlc3RQSwECFAAUAAAAAAAAACEADH5/2AQAAAAEAAAADQAAAAAAAAAAAAAAgAEAAAAAL2Fic29sdXRlLnR4dFBLBQYAAAAAAQABADsAAAAvAAAAAAA=","UEsDBBQAAAAAAAAAIQBASv+xDQAAAA0AAAAEAAAAbGluay4uLy4uL291dHNpZGVQSwECFAAUAAAAAAAAACEAQEr/sQ0AAAANAAAABAAAAAAAAAAAAAAA/6EAAAAAbGlua1BLBQYAAAAAAQABADIAAAAvAAAAAAA="].into_iter().enumerate() {
        let bad=format!("{root}/unsafe-{index}.zip");let target=format!("{root}/rejected-{index}");
        let mut file=s.create(&bad).await?;file.write_all(&base64::engine::general_purpose::STANDARD.decode(payload)?).await?;file.shutdown().await?;
        assert!(daxterm::archive::run(&manager,id,daxterm::archive::Request{operation:"extract".into(),paths:vec![bad],target:target.clone(),format:"zip".into(),encoding:"auto".into(),limit_mb:2}).await.is_err());
        assert!(!s.try_exists(target).await?);
    }
    }
    println!(
        "PASS native SFTP copy/recursive copy/no-clobber/descendant guard and ZIP/TAR/TGZ archive roundtrip"
    );
    let renamed = format!("{root}/renamed.txt");
    sftp::change(&manager, id, "rename", &remote, &renamed).await?;
    sftp::change(&manager, id, "delete", &renamed, "").await?;
    let removed = daxterm::file_ops::batch(
        &manager,
        id,
        id,
        "delete",
        std::slice::from_ref(&root),
        "/tmp",
    )
    .await?;
    assert!(removed.errors.is_empty());
    assert!(!s.try_exists(&root).await?);
    println!(
        "PASS product SFTP unicode/space roundtrip, no-clobber, metadata, editor conflict/recovery/atomic replacement"
    );
    Ok(())
}
#[allow(dead_code)]
fn main() {}

pub async fn services(
    manager: Arc<Connections>,
    id: &str,
    profile: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    use daxterm::{
        monitoring::Monitors,
        sftp::Transfers,
        tunnels::{Config, Tunnels},
    };
    use std::time::Duration;
    use tokio::{
        io::AsyncReadExt,
        net::{TcpListener, TcpStream},
        time::{sleep, timeout},
    };
    let tunnels = Arc::new(Tunnels::default());
    let config = Config {
        id: uuid::Uuid::new_v4().to_string(),
        profile_id: profile.into(),
        name: "probe".into(),
        kind: "local".into(),
        port: 0,
        host: "127.0.0.1".into(),
        target_port: 9000,
        auto_start: false,
    };
    let local = tunnels
        .start(manager.clone(), id.into(), config.clone())
        .await?;
    let port = tunnels.list().iter().find(|s| s.id == local).unwrap().port;
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await?;
    socket.write_all(b"local").await?;
    let mut bytes = [0; 5];
    timeout(Duration::from_secs(5), socket.read_exact(&mut bytes)).await??;
    assert_eq!(&bytes, b"local");
    drop(socket);
    let mut conflict = config.clone();
    conflict.id = uuid::Uuid::new_v4().to_string();
    conflict.port = port;
    assert!(
        tunnels
            .start(manager.clone(), id.into(), conflict)
            .await
            .is_err()
    );
    let mut dynamic = config.clone();
    dynamic.kind = "dynamic".into();
    dynamic.id = uuid::Uuid::new_v4().to_string();
    let dynamic = tunnels.start(manager.clone(), id.into(), dynamic).await?;
    let port = tunnels
        .list()
        .iter()
        .find(|s| s.id == dynamic)
        .unwrap()
        .port;
    let mut socket = TcpStream::connect(("127.0.0.1", port)).await?;
    socket.write_all(&[5, 1, 0]).await?;
    let mut auth = [0; 2];
    socket.read_exact(&mut auth).await?;
    assert_eq!(auth, [5, 0]);
    let mut request = vec![5, 1, 0, 3, 9];
    request.extend_from_slice(b"localhost");
    request.extend_from_slice(&9000u16.to_be_bytes());
    socket.write_all(&request).await?;
    let mut response = [0; 10];
    socket.read_exact(&mut response).await?;
    assert_eq!(response[1], 0);
    socket.write_all(b"socks").await?;
    socket.read_exact(&mut bytes).await?;
    assert_eq!(&bytes, b"socks");
    drop(socket);
    let echo = TcpListener::bind(("127.0.0.1", 0)).await?;
    let echo_port = echo.local_addr()?.port();
    let echo_task = tokio::spawn(async move {
        let (mut s, _) = echo.accept().await.unwrap();
        let mut data = [0; 6];
        s.read_exact(&mut data).await.unwrap();
        s.write_all(&data).await.unwrap();
    });
    let mut remote = config.clone();
    remote.id = uuid::Uuid::new_v4().to_string();
    remote.kind = "remote".into();
    remote.target_port = echo_port;
    let remote = tunnels.start(manager.clone(), id.into(), remote).await?;
    let port = tunnels.list().iter().find(|s| s.id == remote).unwrap().port;
    let h = manager.handle(id)?;
    let channel = h
        .channel_open_direct_tcpip("127.0.0.1", port as u32, "127.0.0.1", 0)
        .await?;
    let mut stream = channel.into_stream();
    stream.write_all(b"remote").await?;
    let mut bytes = [0; 6];
    timeout(Duration::from_secs(5), stream.read_exact(&mut bytes)).await??;
    assert_eq!(&bytes, b"remote");
    drop(stream);
    echo_task.await?;
    for tunnel in [&local, &dynamic, &remote] {
        tunnels.stop(tunnel);
    }
    timeout(Duration::from_secs(8), async {
        while tunnels.list().iter().any(|s| s.status == "running") {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await?;
    assert!(
        h.channel_open_direct_tcpip("127.0.0.1", port as u32, "127.0.0.1", 0)
            .await
            .is_err()
    );
    println!("PASS product local/remote/SOCKS5 domain echo, port conflict, listener cancellation");
    let monitors = Arc::new(Monitors::default());
    monitors.configure(manager.clone(), id.into(), true, 2, "all".into())?;
    timeout(Duration::from_secs(10), async {
        loop {
            if monitors.get(id).is_some_and(|m| m.history.len() >= 2) {
                break;
            }
            sleep(Duration::from_millis(50)).await;
        }
    })
    .await?;
    let view = monitors.get(id).unwrap();
    assert!(view.history[0].cpu.is_none());
    assert!(view.history[1].cpu.is_some());
    assert!(view.history[1].memory_total > 0);
    assert!(view.history[1].disks.iter().any(|d| d.mount == "/"));
    monitors.configure(manager.clone(), id.into(), false, 5, "all".into())?;
    println!(
        "PASS product Linux metrics independent exec, initial sample, CPU/NET delta, memory and disk"
    );
    let transfers = Arc::new(Transfers::default());
    let dir = tempfile::tempdir()?;
    let source = dir.path().join("large.bin");
    std::fs::File::create(&source)?.set_len(128 * 1024 * 1024)?;
    let remote = format!("/tmp/cancel-{}", uuid::Uuid::new_v4());
    let job = transfers.start(
        manager.clone(),
        id.into(),
        remote.clone(),
        source.clone(),
        true,
    )?;
    timeout(Duration::from_secs(10), async {
        while !transfers.list().iter().any(|t| t.id == job && t.done > 0) {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await?;
    transfers.cancel(&job);
    timeout(Duration::from_secs(10), async {
        while transfers
            .list()
            .iter()
            .any(|t| t.id == job && t.status == "running")
        {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await?;
    let job = transfers.list().into_iter().find(|t| t.id == job).unwrap();
    assert_eq!(job.status, "paused");
    assert!(job.done < job.total);
    let s = sftp::open(&manager, id).await?;
    assert!(!s.try_exists(&remote).await?);
    let staging = format!("{remote}.daxterm-{}.part", job.id);
    assert!(s.try_exists(&staging).await?);
    // Mutate a committed prefix byte; resume must reject, never append to it.
    let mut part = s
        .open_with_flags(&staging, russh_sftp::protocol::OpenFlags::WRITE)
        .await?;
    part.write_all(&[1]).await?;
    part.shutdown().await?;
    let profile = manager.control(id)?.profile.id.clone();
    transfers.resume(
        manager.clone(),
        job.id.clone(),
        profile.clone(),
        Some(id.into()),
    )?;
    timeout(Duration::from_secs(10), async {
        while transfers
            .list()
            .iter()
            .any(|j| j.id == job.id && j.status == "running")
        {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await?;
    assert!(
        transfers
            .list()
            .iter()
            .any(|j| j.id == job.id && j.message.contains("내용이 원본과 다릅니다"))
    );
    let mut part = s
        .open_with_flags(&staging, russh_sftp::protocol::OpenFlags::WRITE)
        .await?;
    part.write_all(&[0]).await?;
    part.shutdown().await?;
    transfers.resume(
        manager.clone(),
        job.id.clone(),
        profile.clone(),
        Some(id.into()),
    )?;
    timeout(Duration::from_secs(60), async {
        while transfers
            .list()
            .iter()
            .any(|j| j.id == job.id && j.status == "running")
        {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await?;
    assert!(
        transfers
            .list()
            .iter()
            .any(|j| j.id == job.id && j.status == "completed")
    );
    assert_eq!(s.metadata(&remote).await?.size, Some(128 * 1024 * 1024));
    assert!(!s.try_exists(&staging).await?);
    let download = dir.path().join("download.bin");
    let down = transfers.start(
        manager.clone(),
        id.into(),
        remote.clone(),
        download.clone(),
        false,
    )?;
    timeout(Duration::from_secs(10), async {
        while !transfers.list().iter().any(|j| j.id == down && j.done > 0) {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await?;
    transfers.cancel(&down);
    timeout(Duration::from_secs(10), async {
        while transfers
            .list()
            .iter()
            .any(|j| j.id == down && j.status == "running")
        {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await?;
    assert!(!download.exists());
    transfers.resume(manager.clone(), down.clone(), profile, Some(id.into()))?;
    timeout(Duration::from_secs(60), async {
        while transfers
            .list()
            .iter()
            .any(|j| j.id == down && j.status == "running")
        {
            sleep(Duration::from_millis(20)).await;
        }
    })
    .await?;
    assert!(
        transfers
            .list()
            .iter()
            .any(|j| j.id == down && j.status == "completed")
    );
    assert_eq!(std::fs::read(&source)?, std::fs::read(&download)?);
    s.remove_file(&remote).await?;
    println!(
        "PASS product SFTP 128MiB upload/download pause/resume, full prefix mismatch rejection, exact roundtrip and staging cleanup"
    );
    Ok(())
}
