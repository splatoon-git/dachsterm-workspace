//! Proxy negotiation against fixed answers. The answers are the ones tinyproxy and microsocks gave
//! in the CG.0 measurement (docs/verification/commercial-gaps.md §2).
use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex};

/// Runs `client` against a proxy that reads `expect` bytes, answers `answer`, then sends a banner.
async fn talk<F, Fut>(expect: usize, answer: &'static [u8], client: F) -> (Result<()>, Vec<u8>)
where
    F: FnOnce(DuplexStream) -> Fut,
    Fut: std::future::Future<Output = (Result<()>, DuplexStream)>,
{
    let (near, mut far) = duplex(64 * 1024);
    let proxy = tokio::spawn(async move {
        let mut seen = vec![0u8; expect];
        far.read_exact(&mut seen).await.unwrap();
        far.write_all(answer).await.unwrap();
        far.write_all(b"SSH-2.0-banner\r\n").await.unwrap();
        (seen, far)
    });
    let (result, mut near) = client(near).await;
    let (seen, _far) = proxy.await.unwrap();
    if result.is_ok() {
        // Nothing after the proxy's answer was consumed: the SSH banner is still there.
        let mut banner = [0u8; 16];
        near.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"SSH-2.0-banner\r\n");
    }
    (result, seen)
}

type Auth = Option<(&'static str, &'static str)>;
const CONNECT: &[u8] = b"CONNECT target:22 HTTP/1.1\r\nHost: target:22\r\n\r\n";

async fn http(answer: &'static [u8], auth: Auth) -> Result<()> {
    let expect = match auth {
        // `user:pw` is `dXNlcjpwdw==`.
        Some(_) => CONNECT.len() + "Proxy-Authorization: Basic dXNlcjpwdw==\r\n".len(),
        None => CONNECT.len(),
    };
    talk(expect, answer, |mut s| async move {
        (http_connect(&mut s, "target", 22, auth).await, s)
    })
    .await
    .0
}

#[tokio::test]
async fn http_connect_sends_basic_auth_and_leaves_the_banner() {
    let (result, seen) = talk(
        CONNECT.len() + 41,
        b"HTTP/1.0 200 Connection established\r\nProxy-agent: tinyproxy/1.11.1\r\n\r\n",
        |mut s| async move {
            (
                http_connect(&mut s, "target", 22, Some(("user", "pw"))).await,
                s,
            )
        },
    )
    .await;
    result.unwrap();
    assert_eq!(
        String::from_utf8(seen).unwrap(),
        "CONNECT target:22 HTTP/1.1\r\nHost: target:22\r\nProxy-Authorization: Basic dXNlcjpwdw==\r\n\r\n"
    );
}

#[tokio::test]
async fn http_errors_follow_the_measured_status_codes() {
    let user = Some(("user", "pw"));
    let cases: [(&'static [u8], Auth, &str); 6] = [
        (
            b"HTTP/1.0 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"x\"\r\n\r\n",
            None,
            AUTH_REQUIRED,
        ),
        (b"HTTP/1.0 401 Unauthorized\r\n\r\n", user, AUTH_FAILED),
        (b"HTTP/1.0 407 Proxy Authentication Required\r\n\r\n", user, AUTH_FAILED),
        (b"HTTP/1.1 403 Access violation\r\n\r\n", None, NOT_ALLOWED),
        (
            b"HTTP/1.1 500 Unable to connect\r\n\r\n",
            None,
            "프록시가 목적지에 연결하지 못했습니다(HTTP/1.1 500 Unable to connect).",
        ),
        (
            b"HTTP/1.1 400 Bad Request\r\n\r\n",
            None,
            "프록시가 연결을 거부했습니다(HTTP/1.1 400 Bad Request).",
        ),
    ];
    for (answer, auth, expected) in cases {
        assert_eq!(http(answer, auth).await.unwrap_err(), expected);
    }
    assert!(
        http(b"SSH-2.0-OpenSSH\r\n\r\n", None)
            .await
            .unwrap_err()
            .contains("HTTP 프록시가 아닌")
    );
}

#[tokio::test]
async fn http_header_is_bounded_and_a_closed_proxy_is_reported() {
    let (near, mut far) = duplex(64 * 1024);
    let flood = tokio::spawn(async move {
        let mut seen = vec![0u8; CONNECT.len()];
        far.read_exact(&mut seen).await.unwrap();
        let _ = far.write_all(b"HTTP/1.0 200 OK\r\n").await;
        let _ = far.write_all(&[b'x'; MAX_HEADER]).await;
        far
    });
    let mut near = near;
    assert_eq!(
        http_connect(&mut near, "target", 22, None)
            .await
            .unwrap_err(),
        "프록시 응답 헤더가 너무 깁니다."
    );
    drop(flood.await.unwrap());
    let (mut near, far) = duplex(1024);
    drop(far);
    assert_eq!(
        http_connect(&mut near, "target", 22, None)
            .await
            .unwrap_err(),
        CLOSED
    );
}

#[tokio::test]
async fn http_brackets_an_ipv6_target() {
    let request = b"CONNECT [::1]:2222 HTTP/1.1\r\nHost: [::1]:2222\r\n\r\n";
    let (result, seen) = talk(
        request.len(),
        b"HTTP/1.1 200 OK\r\n\r\n",
        |mut s| async move { (http_connect(&mut s, "::1", 2222, None).await, s) },
    )
    .await;
    result.unwrap();
    assert_eq!(seen, request);
}

/// A SOCKS5 proxy that checks each message and answers it in turn.
async fn socks(host: &'static str, auth: Auth, steps: Vec<(Vec<u8>, &'static [u8])>) -> Result<()> {
    let (mut near, mut far) = duplex(64 * 1024);
    let proxy = tokio::spawn(async move {
        for (expect, answer) in steps {
            let mut seen = vec![0u8; expect.len()];
            if far.read_exact(&mut seen).await.is_err() {
                return;
            }
            assert_eq!(seen, expect);
            far.write_all(answer).await.unwrap();
        }
        far.write_all(b"SSH-2.0-banner\r\n").await.unwrap();
        // Keep the stream open until the client is done with it.
        let _ = far.read(&mut [0u8; 1]).await;
    });
    let result = socks5(&mut near, host, 22, auth).await;
    if result.is_ok() {
        let mut banner = [0u8; 16];
        near.read_exact(&mut banner).await.unwrap();
        assert_eq!(&banner, b"SSH-2.0-banner\r\n");
    }
    drop(near);
    proxy.await.unwrap();
    result
}

fn domain_request(host: &str) -> Vec<u8> {
    let mut r = vec![5, 1, 0, 3, host.len() as u8];
    r.extend_from_slice(host.as_bytes());
    r.extend_from_slice(&22u16.to_be_bytes());
    r
}

#[tokio::test]
async fn socks5_sends_a_name_for_the_proxy_to_resolve_and_authenticates() {
    socks(
        "target",
        Some(("user", "pw")),
        vec![
            (vec![5, 2, 0, 2], &[5, 2]),
            (b"\x01\x04user\x02pw".to_vec(), &[1, 0]),
            (domain_request("target"), &[5, 0, 0, 1, 10, 0, 0, 2, 0, 22]),
        ],
    )
    .await
    .unwrap();
    // No user name offers only "no authentication"; a domain-name bound address is read off.
    socks(
        "target",
        None,
        vec![
            (vec![5, 1, 0], &[5, 0]),
            (
                domain_request("target"),
                b"\x05\x00\x00\x03\x04edge\x00\x16",
            ),
        ],
    )
    .await
    .unwrap();
    let mut v4 = vec![5, 1, 0, 1, 10, 1, 2, 3];
    v4.extend_from_slice(&22u16.to_be_bytes());
    let bound: &'static [u8] = &[
        5, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 22,
    ];
    socks(
        "10.1.2.3",
        None,
        vec![(vec![5, 1, 0], &[5, 0]), (v4, bound)],
    )
    .await
    .unwrap();
    let mut v6 = vec![5, 1, 0, 4];
    v6.extend_from_slice(&"::1".parse::<std::net::Ipv6Addr>().unwrap().octets());
    v6.extend_from_slice(&22u16.to_be_bytes());
    socks(
        "::1",
        None,
        vec![
            (vec![5, 1, 0], &[5, 0]),
            (v6, &[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
        ],
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn socks5_errors_follow_the_measured_replies() {
    let user = Some(("user", "pw"));
    let login = (b"\x01\x04user\x02pw".to_vec(), &[1u8, 0][..]);
    assert_eq!(
        socks("target", None, vec![(vec![5, 1, 0], &[5, 0xff])])
            .await
            .unwrap_err(),
        AUTH_REQUIRED
    );
    assert_eq!(
        socks(
            "target",
            user,
            vec![
                (vec![5, 2, 0, 2], &[5, 2]),
                (b"\x01\x04user\x02pw".to_vec(), &[1, 2])
            ]
        )
        .await
        .unwrap_err(),
        AUTH_FAILED
    );
    assert!(
        socks("target", user, vec![(vec![5, 2, 0, 2], &[5, 0xff])])
            .await
            .unwrap_err()
            .contains("지원하지 않는 인증")
    );
    for (code, expected) in [
        (2u8, NOT_ALLOWED.to_string()),
        (
            1,
            "프록시가 목적지에 연결하지 못했습니다(SOCKS 코드 1).".into(),
        ),
        (
            5,
            "프록시가 목적지에 연결하지 못했습니다(SOCKS 코드 5).".into(),
        ),
    ] {
        let answer: &'static [u8] = Box::leak(vec![5, code, 0, 1].into_boxed_slice());
        let result = socks(
            "target",
            user,
            vec![
                (vec![5, 2, 0, 2], &[5, 2]),
                login.clone(),
                (domain_request("target"), answer),
            ],
        )
        .await;
        assert_eq!(result.unwrap_err(), expected);
    }
    assert!(
        socks("target", None, vec![(vec![5, 1, 0], &[4, 0])])
            .await
            .unwrap_err()
            .contains("SOCKS5 프록시가 아닌")
    );
}
