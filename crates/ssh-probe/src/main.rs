//! Phase 0 laboratory binary. No desktop commands or persisted credentials.
mod socks;
use anyhow::{Context, Result, ensure};
use russh::{
    Channel, ChannelMsg, Disconnect, client,
    keys::{PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate, decode_secret_key},
};
use russh_sftp::client::SftpSession;
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc, oneshot},
    time::timeout,
};
type Session = client::Handle<PinnedHost>;
struct PinnedHost {
    key: Vec<u8>,
    forwarded: mpsc::Sender<Channel<client::Msg>>,
}
impl client::Handler for PinnedHost {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(key.certificate().is_none()
            && key
                .public_key()
                .to_bytes()
                .is_ok_and(|bytes| bytes == self.key))
    }
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        _: &str,
        _: u32,
        _: &str,
        _: u32,
        reply: client::ChannelOpenHandle,
        _: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if self.forwarded.try_send(channel).is_ok() {
            reply.accept().await;
        }
        Ok(())
    }
}
fn value(key: &str) -> Result<String> {
    std::env::var(format!("DACHSTERM_PROBE_{key}"))
        .map_err(|_| anyhow::anyhow!("missing fixture input"))
}
async fn connect(pin: Vec<u8>) -> Result<(Session, mpsc::Receiver<Channel<client::Msg>>)> {
    let (tx, rx) = mpsc::channel(4);
    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(20)),
        channel_buffer_size: 16,
        ..Default::default()
    };
    let port: u16 = value("PORT")?.parse()?;
    let session = timeout(
        Duration::from_secs(10),
        client::connect(
            Arc::new(config),
            ("127.0.0.1", port),
            PinnedHost {
                key: pin,
                forwarded: tx,
            },
        ),
    )
    .await??;
    Ok((session, rx))
}
async fn password(pin: Vec<u8>) -> Result<(Session, mpsc::Receiver<Channel<client::Msg>>)> {
    let (mut session, rx) = connect(pin).await?;
    ensure!(
        session
            .authenticate_password("probe", value("PASSWORD")?)
            .await?
            .success(),
        "password rejected"
    );
    Ok((session, rx))
}
async fn disconnect(session: &Session) -> Result<()> {
    session
        .disconnect(Disconnect::ByApplication, "probe complete", "en")
        .await?;
    Ok(())
}
async fn collect(mut channel: Channel<client::Msg>) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut status = None;
    while let Some(message) = channel.wait().await {
        match message {
            ChannelMsg::Data { data } => {
                ensure!(output.len() + data.len() <= 1024 * 1024, "output cap");
                output.extend_from_slice(&data);
            }
            ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
            _ => {}
        }
    }
    ensure!(status == Some(0), "remote command failed");
    Ok(output)
}
async fn command(session: &Session, command: &str) -> Result<Vec<u8>> {
    let channel = session.channel_open_session().await?;
    channel.exec(true, command).await?;
    collect(channel).await
}
async fn sftp(session: &Session) -> Result<SftpSession> {
    let channel = session.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    Ok(SftpSession::new(channel.into_stream()).await?)
}
async fn auth_and_pty(pin: &[u8]) -> Result<()> {
    ensure!(
        connect(vec![0; pin.len()]).await.is_err(),
        "mismatched host accepted"
    );
    println!("PASS russh mismatched host key rejected before authentication");
    let (mut denied, _) = connect(pin.to_vec()).await?;
    ensure!(
        !denied
            .authenticate_password("probe", "deliberately-invalid-fixture-input")
            .await?
            .success()
    );
    disconnect(&denied).await?;
    println!("PASS russh incorrect password rejected");
    for encrypted in [false, true] {
        let (mut session, _) = connect(pin.to_vec()).await?;
        let passphrase = value("PASSPHRASE")?;
        let encoded = value(if encrypted {
            "ENCRYPTED_KEY"
        } else {
            "PLAIN_KEY"
        })?;
        if encrypted {
            ensure!(decode_secret_key(&encoded, Some("invalid-fixture-input")).is_err());
        }
        let key = decode_secret_key(&encoded, encrypted.then_some(passphrase.as_str()))?;
        ensure!(
            session
                .authenticate_publickey("probe", PrivateKeyWithHashAlg::new(Arc::new(key), None))
                .await?
                .success()
        );
        ensure!(command(&session, "printf 'key-ok'").await? == b"key-ok");
        disconnect(&session).await?;
        println!(
            "PASS russh {} key authentication",
            if encrypted {
                "encrypted (+ wrong passphrase rejected)"
            } else {
                "plain"
            }
        );
    }
    let (session, _) = password(pin.to_vec()).await?;
    let mut channel = session.channel_open_session().await?;
    channel
        .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
        .await?;
    channel.request_shell(true).await?;
    channel
        .data(&b"stty -echo; printf '\\nREADY\\n'\n"[..])
        .await?;
    let mut received = Vec::new();
    while !received.windows(7).any(|w| w == b"READY\r\n") {
        if let Some(ChannelMsg::Data { data }) = channel.wait().await {
            received.extend_from_slice(&data);
            ensure!(received.len() < 65536);
        }
    }
    channel.window_change(111, 37, 0, 0).await?;
    channel
        .data("stty size; printf '한글 UTF-8\\n'; exit\n".as_bytes())
        .await?;
    let output = String::from_utf8(collect(channel).await?)?;
    ensure!(output.contains("37 111") && output.contains("한글 UTF-8"));
    disconnect(&session).await?;
    println!("PASS russh password / interactive PTY input-output / UTF-8 / resize 80x24 -> 111x37");
    Ok(())
}
async fn transfer(session: &Session, path: &'static str, fill: u8) -> Result<()> {
    let sftp = sftp(session).await?;
    let payload = vec![fill; 2 * 1024 * 1024];
    let mut file = sftp.create(path).await?;
    file.write_all(&payload).await?;
    file.shutdown().await?;
    let mut file = sftp.open(path).await?;
    let mut result = Vec::new();
    file.read_to_end(&mut result).await?;
    file.shutdown().await?;
    ensure!(payload == result, "SFTP roundtrip mismatch");
    sftp.remove_file(path).await?;
    sftp.close().await?;
    Ok(())
}
async fn concurrent_transfer(pin: &[u8]) -> Result<()> {
    let (session, _) = password(pin.to_vec()).await?;
    let mut output = session.channel_open_session().await?;
    output.request_pty(true, "xterm", 80, 24, 0, 0, &[]).await?;
    output.exec(true, "python3 -u -c 'import time; [(print(\"terminal-tick\"), time.sleep(.01)) for _ in range(2000)]'").await?;
    let ticks = Arc::new(AtomicUsize::new(0));
    let counter = ticks.clone();
    let (stop_tx, mut stop_rx) = oneshot::channel();
    let output_task = tokio::spawn(async move {
        loop {
            tokio::select! { _ = &mut stop_rx => { output.close().await?; break; }, message = output.wait() => match message { Some(ChannelMsg::Data { .. }) => { counter.fetch_add(1, Ordering::SeqCst); }, None => break, _ => {} } }
        }
        Ok::<_, anyhow::Error>(())
    });
    tokio::try_join!(
        transfer(&session, "/home/probe/한글 a.bin", 91),
        transfer(&session, "/home/probe/b.bin", 173)
    )?;
    ensure!(ticks.load(Ordering::SeqCst) > 0, "terminal starved");
    println!("PASS russh two concurrent 2MiB SFTP roundtrips while PTY output continues");
    let sftp = sftp(&session).await?;
    let mut file = sftp.create("/home/probe/cancel.bin").await?;
    let (ready_tx, ready_rx) = oneshot::channel();
    let (cancel_tx, mut cancel_rx) = oneshot::channel();
    let worker = tokio::spawn(async move {
        let block = vec![5; 32768];
        file.write_all(&block).await?;
        let _ = ready_tx.send(());
        loop {
            tokio::select! { biased; _ = &mut cancel_rx => break, result = file.write_all(&block) => { result?; } }
        }
        file.shutdown().await?;
        sftp.remove_file("/home/probe/cancel.bin").await?;
        sftp.close().await?;
        Ok::<_, anyhow::Error>(())
    });
    ready_rx.await?;
    let before = ticks.load(Ordering::SeqCst);
    let _ = cancel_tx.send(());
    timeout(Duration::from_secs(5), worker).await???;
    ensure!(command(&session, "printf alive").await? == b"alive");
    timeout(Duration::from_secs(3), async {
        while ticks.load(Ordering::SeqCst) <= before {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    let _ = stop_tx.send(());
    output_task.await??;
    disconnect(&session).await?;
    println!(
        "PASS SFTP cancel closes file, removes partial output, joins worker; PTY and connection survive"
    );
    Ok(())
}
async fn roundtrip(stream: &mut (impl AsyncReadExt + AsyncWriteExt + Unpin)) -> Result<()> {
    let payload = b"dachsterm-forward-roundtrip";
    stream.write_all(payload).await?;
    let mut result = vec![0; payload.len()];
    stream.read_exact(&mut result).await?;
    ensure!(result == payload);
    stream.shutdown().await?;
    Ok(())
}
async fn forwarding(pin: &[u8]) -> Result<()> {
    let (session, mut forwarded) = password(pin.to_vec()).await?;
    let local = TcpListener::bind(("127.0.0.1", 0)).await?;
    let address = local.local_addr()?;
    let channel = session
        .channel_open_direct_tcpip("127.0.0.1", 9000, "127.0.0.1", 0)
        .await?;
    let bridge = tokio::spawn(async move {
        let (mut socket, _) = local.accept().await?;
        tokio::io::copy_bidirectional(&mut socket, &mut channel.into_stream())
            .await
            .map(|_| ())
    });
    roundtrip(&mut TcpStream::connect(address).await?).await?;
    bridge.await??;
    let rebound = TcpListener::bind(address).await?;
    drop(rebound);
    println!("PASS local forwarding loopback roundtrip / listener released");
    let remote_port = session.tcpip_forward("127.0.0.1", 0).await?;
    let echo = TcpListener::bind(("127.0.0.1", 0)).await?;
    let echo_addr = echo.local_addr()?;
    let local_echo = tokio::spawn(async move {
        let (mut s, _) = echo.accept().await?;
        let (mut r, mut w) = s.split();
        tokio::io::copy(&mut r, &mut w).await
    });
    let remote_bridge = tokio::spawn(async move {
        let channel = forwarded
            .recv()
            .await
            .context("missing forwarded channel")?;
        let mut socket = TcpStream::connect(echo_addr).await?;
        tokio::io::copy_bidirectional(&mut socket, &mut channel.into_stream()).await?;
        Ok::<_, anyhow::Error>(())
    });
    // Only a numeric, server-assigned port is interpolated into this fixed fixture command.
    let cmd = format!(
        "python3 -c 'import socket; s=socket.create_connection((\"127.0.0.1\", {remote_port})); s.sendall(b\"remote-ok\"); assert s.recv(9)==b\"remote-ok\"; s.close(); print(\"remote-ok\")'"
    );
    ensure!(command(&session, &cmd).await? == b"remote-ok\n");
    remote_bridge.await??;
    local_echo.await??;
    session
        .cancel_tcpip_forward("127.0.0.1", remote_port)
        .await?;
    let check = format!(
        "python3 -c 'import socket; s=socket.socket(); assert s.connect_ex((\"127.0.0.1\", {remote_port})) != 0; print(\"closed\")'"
    );
    ensure!(command(&session, &check).await? == b"closed\n");
    println!("PASS remote forwarding roundtrip / cancel / remote listener closed");
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let addr = listener.local_addr()?;
    let socks_client = tokio::spawn(async move {
        let mut stream = TcpStream::connect(addr).await?;
        stream.write_all(&[5, 1, 0]).await?;
        let mut hello = [0; 2];
        stream.read_exact(&mut hello).await?;
        ensure!(hello == [5, 0]);
        let mut request = vec![5, 1, 0, 3, 9];
        request.extend_from_slice(b"localhost");
        request.extend_from_slice(&9000_u16.to_be_bytes());
        stream.write_all(&request).await?;
        let mut reply = [0; 10];
        stream.read_exact(&mut reply).await?;
        ensure!(reply[1] == 0);
        roundtrip(&mut stream).await
    });
    let (mut socket, _) = listener.accept().await?;
    let (host, port) = socks::request(&mut socket).await?;
    let channel = session
        .channel_open_direct_tcpip(&host, u32::from(port), "127.0.0.1", 0)
        .await?;
    socket.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
    tokio::io::copy_bidirectional(&mut socket, &mut channel.into_stream()).await?;
    socks_client.await??;
    drop(listener);
    disconnect(&session).await?;
    println!("PASS SOCKS5 TCP CONNECT domain target resolved by SSH server / bounded parser");
    Ok(())
}
async fn disconnect_transfer(pin: &[u8]) -> Result<()> {
    let (session, _) = password(pin.to_vec()).await?;
    let sftp = sftp(&session).await?;
    let mut file = sftp.create("/home/probe/disconnect.bin").await?;
    file.write_all(&[1; 32768]).await?;
    let worker = tokio::spawn(async move {
        let block = vec![1; 32768];
        loop {
            if file.write_all(&block).await.is_err() {
                break;
            }
        }
    });
    disconnect(&session).await?;
    timeout(Duration::from_secs(5), worker).await??;
    timeout(Duration::from_secs(5), async {
        while !session.is_closed() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await?;
    ensure!(session.channel_open_session().await.is_err());
    let (next, _) = password(pin.to_vec()).await?;
    let cleanup = self::sftp(&next).await?;
    cleanup.remove_file("/home/probe/disconnect.bin").await?;
    cleanup.close().await?;
    disconnect(&next).await?;
    println!(
        "PASS disconnect during transfer / worker joined / closed session rejects channels / partial removed"
    );
    Ok(())
}
fn ssh2_comparison() -> Result<()> {
    use std::io::{Read, Write};
    let port: u16 = value("PORT")?.parse()?;
    let stream = std::net::TcpStream::connect(("127.0.0.1", port))?;
    let mut session = ssh2::Session::new()?;
    let pin = PublicKey::from_openssh(&value("RSA_HOST_KEY")?)?.to_bytes()?;
    session.method_pref(ssh2::MethodType::HostKey, "rsa-sha2-512,rsa-sha2-256")?;
    session.set_timeout(10_000);
    session.set_tcp_stream(stream);
    if let Err(error) = session.handshake() {
        println!(
            "FAIL ssh2 handshake code {:?}; supported host algorithms: {:?}",
            error.code(),
            session.supported_algs(ssh2::MethodType::HostKey)?
        );
        return Err(error.into());
    }
    println!("PASS ssh2 handshake");
    ensure!(session.host_key().context("missing host key")?.0 == pin);
    ensure!(
        session
            .userauth_password("probe", "invalid-fixture-input")
            .is_err()
    );
    session.userauth_password("probe", &value("PASSWORD")?)?;
    ensure!(session.authenticated());
    let mut channel = session.channel_session()?;
    channel.request_pty("xterm", None, Some((80, 24, 0, 0)))?;
    channel.request_pty_size(111, 37, None, None)?;
    channel.exec("stty size; printf 'ssh2-ok'")?;
    let mut output = String::new();
    channel.read_to_string(&mut output)?;
    channel.wait_close()?;
    ensure!(output.contains("37 111") && output.contains("ssh2-ok"));
    let sftp = session.sftp()?;
    let path = std::path::Path::new("/home/probe/ssh2.bin");
    let payload = vec![17; 65536];
    {
        let mut file = sftp.create(path)?;
        file.write_all(&payload)?;
    }
    let mut returned = Vec::new();
    {
        let mut file = sftp.open(path)?;
        file.read_to_end(&mut returned)?;
    }
    ensure!(returned == payload);
    sftp.unlink(path)?;
    drop(sftp);
    let mut direct = session.channel_direct_tcpip("127.0.0.1", 9000, None)?;
    direct.write_all(b"echo")?;
    let mut echoed = [0; 4];
    direct.read_exact(&mut echoed)?;
    ensure!(&echoed == b"echo");
    direct.send_eof()?;
    direct.close()?;
    session.disconnect(None, "probe complete", None)?;
    println!(
        "PASS ssh2 password + bad-password / pinned host / PTY resize / SFTP / direct-tcpip baseline"
    );
    Ok(())
}
async fn run() -> Result<()> {
    let pin = PublicKey::from_openssh(&value("HOST_KEY")?)?.to_bytes()?;
    for (name, operation) in [
        ("authentication and PTY", 0),
        ("concurrent SFTP and cancel", 1),
        ("forwarding and SOCKS5", 2),
        ("disconnect cleanup", 3),
    ] {
        println!("RUN {name}");
        timeout(Duration::from_secs(90), async {
            match operation {
                0 => auth_and_pty(&pin).await,
                1 => concurrent_transfer(&pin).await,
                2 => forwarding(&pin).await,
                _ => disconnect_transfer(&pin).await,
            }
        })
        .await
        .context("stage timeout")??;
    }
    println!("RUN ssh2 comparison");
    tokio::task::spawn_blocking(ssh2_comparison).await??;
    Ok(())
}
#[tokio::main]
async fn main() {
    if run().await.is_err() {
        eprintln!("FAIL SSH probe; see last RUN/PASS stage (error payload redacted)");
        std::process::exit(1);
    }
    println!("PASS all implemented Windows/Linux OpenSSH probes");
}
