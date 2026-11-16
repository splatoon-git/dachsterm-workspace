use super::*;

#[test]
fn displays_name_a_socket_or_a_tcp_port() {
    let fixture = parse_display("127.0.0.1:40000").unwrap();
    assert_eq!(fixture.target, Target::Tcp("127.0.0.1".into(), 46000));
    assert!(parse_display("h:59536").is_none(), "past the last port");
    let tcp = parse_display("localhost:10.2").unwrap();
    assert_eq!(tcp.target, Target::Tcp("localhost".into(), 6010));
    assert_eq!((tcp.number.as_str(), tcp.screen), ("10", 2));
    assert_eq!(
        parse_display("[::1]:0").unwrap().target,
        Target::Tcp("::1".into(), 6000)
    );
    #[cfg(unix)]
    {
        assert_eq!(
            parse_display(":0").unwrap().target,
            Target::Unix("/tmp/.X11-unix/X0".into())
        );
        assert_eq!(
            parse_display("/private/tmp/com.apple.launchd.ab/org.xquartz:0")
                .unwrap()
                .target,
            Target::Unix("/private/tmp/com.apple.launchd.ab/org.xquartz:0".into())
        );
    }
    for bad in ["", "host", "host:x", "host:0.x", "bad host:0"] {
        assert!(parse_display(bad).is_none(), "{bad}");
    }
}

fn record(number: &str, name: &str, cookie: &[u8]) -> Vec<u8> {
    let mut out = vec![1, 0];
    for field in [
        b"host".as_slice(),
        number.as_bytes(),
        name.as_bytes(),
        cookie,
    ] {
        out.extend_from_slice(&(field.len() as u16).to_be_bytes());
        out.extend_from_slice(field);
    }
    out
}

#[test]
fn the_cookie_comes_from_the_matching_xauthority_record() {
    let mut file = record("1", PROTOCOL, &[1; 16]);
    file.extend(record("0", "XDM-AUTHORIZATION-1", &[2; 16]));
    file.extend(record("0", PROTOCOL, &[3; 16]));
    assert_eq!(find_cookie(&file, "0"), Some(vec![3; 16]));
    assert_eq!(find_cookie(&file, "1"), Some(vec![1; 16]));
    assert_eq!(find_cookie(&file, "2"), None);
    assert_eq!(
        find_cookie(&file[..10], "0"),
        None,
        "a cut file is no cookie"
    );
}

/// An X client's setup packet with the given byte order, name and cookie.
fn setup(order: u8, name: &[u8], cookie: &[u8]) -> Vec<u8> {
    let w = |n: usize| {
        let n = n as u16;
        if order == b'l' {
            n.to_le_bytes()
        } else {
            n.to_be_bytes()
        }
    };
    let pad = |n: usize| (4 - n % 4) % 4;
    let mut out = vec![order, 0];
    out.extend(w(11));
    out.extend(w(0));
    out.extend(w(name.len()));
    out.extend(w(cookie.len()));
    out.extend([0, 0]);
    out.extend_from_slice(name);
    out.extend(std::iter::repeat_n(0, pad(name.len())));
    out.extend_from_slice(cookie);
    out.extend(std::iter::repeat_n(0, pad(cookie.len())));
    out
}

#[tokio::test]
async fn the_fake_cookie_is_swapped_in_either_byte_order() {
    let fake = [9u8; 16];
    for order in *b"lB" {
        let packet = setup(order, PROTOCOL.as_bytes(), &fake);
        let swapped = swap_cookie(&mut &packet[..], &fake, Some(&[5; 16])).await;
        assert_eq!(swapped, Some(setup(order, PROTOCOL.as_bytes(), &[5; 16])));
        let open = swap_cookie(&mut &packet[..], &fake, None).await;
        assert_eq!(open, Some(setup(order, b"", b"")), "no cookie on this PC");
    }
    let wrong = setup(b'l', PROTOCOL.as_bytes(), &[8; 16]);
    assert_eq!(swap_cookie(&mut &wrong[..], &fake, None).await, None);
    let other = setup(b'B', b"XDM-AUTHORIZATION-1", &fake);
    assert_eq!(swap_cookie(&mut &other[..], &fake, None).await, None);
    let mut odd = setup(b'l', PROTOCOL.as_bytes(), &fake);
    odd[0] = b'x';
    assert_eq!(swap_cookie(&mut &odd[..], &fake, None).await, None);
    let mut huge = setup(b'B', PROTOCOL.as_bytes(), &fake);
    huge[8..10].copy_from_slice(&4000u16.to_be_bytes());
    assert_eq!(swap_cookie(&mut &huge[..], &fake, None).await, None);
}
