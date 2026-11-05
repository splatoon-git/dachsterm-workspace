//! Laboratory-only SOCKS5 CONNECT parser; production listener belongs to Phase 3.
use anyhow::{Result, ensure};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
pub async fn request(stream: &mut (impl AsyncRead + AsyncWrite + Unpin)) -> Result<(String, u16)> {
    ensure!(stream.read_u8().await? == 5, "SOCKS version");
    let count = stream.read_u8().await? as usize;
    let mut methods = vec![0; count];
    stream.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        stream.write_all(&[5, 255]).await?;
        anyhow::bail!("no supported method");
    }
    stream.write_all(&[5, 0]).await?;
    let mut head = [0; 4];
    stream.read_exact(&mut head).await?;
    if head[0] != 5 || head[1] != 1 || head[2] != 0 {
        stream.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        anyhow::bail!("only TCP CONNECT supported");
    }
    let host = match head[3] {
        1 => {
            let mut address = [0; 4];
            stream.read_exact(&mut address).await?;
            std::net::Ipv4Addr::from(address).to_string()
        }
        3 => {
            let length = stream.read_u8().await? as usize;
            ensure!(length > 0);
            let mut bytes = vec![0; length];
            stream.read_exact(&mut bytes).await?;
            let host = String::from_utf8(bytes)?;
            ensure!(
                host.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
            );
            host
        }
        4 => {
            let mut address = [0; 16];
            stream.read_exact(&mut address).await?;
            std::net::Ipv6Addr::from(address).to_string()
        }
        _ => {
            stream.write_all(&[5, 8, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
            anyhow::bail!("address type");
        }
    };
    let port = stream.read_u16().await?;
    ensure!(port > 0);
    Ok((host, port))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn rejects_udp_and_auth_without_waiting_for_destination() {
        for input in [vec![5, 1, 2], vec![5, 1, 0, 5, 3, 0, 1]] {
            let (mut client, mut server) = tokio::io::duplex(128);
            client.write_all(&input).await.unwrap();
            client.shutdown().await.unwrap();
            assert!(request(&mut server).await.is_err());
        }
    }
}
