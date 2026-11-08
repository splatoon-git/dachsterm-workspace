//! Route trace from this PC by ICMP echo with a rising TTL. The system's ICMP API needs no
//! administrator rights and its status codes do not depend on the Windows language (TL.0).
use super::trace_parse::Hop;
use crate::storage::Result;
use std::{ffi::c_void, net::Ipv4Addr, ptr};
use tokio::sync::watch;
use windows_sys::Win32::{
    Foundation::{GetLastError, HANDLE, INVALID_HANDLE_VALUE},
    NetworkManagement::IpHelper::{
        ICMP_ECHO_REPLY, IP_DEST_HOST_UNREACHABLE, IP_DEST_NET_UNREACHABLE,
        IP_DEST_PORT_UNREACHABLE, IP_DEST_PROT_UNREACHABLE, IP_OPTION_INFORMATION,
        IP_REQ_TIMED_OUT, IP_SUCCESS, IP_TTL_EXPIRED_REASSEM, IP_TTL_EXPIRED_TRANSIT,
        IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho,
    },
};

const WAIT_MS: u32 = 1000;
/// A second try per hop, because devices often rate-limit these replies.
const TRIES: u32 = 2;
const PAYLOAD: [u8; 32] = [0x44; 32];
/// Room for the reply and the 8 bytes of ICMP error Windows may add, in `u64` for alignment.
const REPLY_WORDS: usize = (size_of::<ICMP_ECHO_REPLY>() + PAYLOAD.len() + 8).div_ceil(8) + 2;

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        // SAFETY: the handle came from `IcmpCreateFile` and is closed only here.
        unsafe { IcmpCloseHandle(self.0) };
    }
}

#[derive(Debug, PartialEq)]
struct Echo {
    status: u32,
    address: Option<Ipv4Addr>,
    rtt_ms: Option<f64>,
}

fn send(handle: &Handle, destination: Ipv4Addr, ttl: u8) -> Echo {
    let options = IP_OPTION_INFORMATION {
        Ttl: ttl,
        Tos: 0,
        Flags: 0,
        OptionsSize: 0,
        OptionsData: ptr::null_mut(),
    };
    let mut reply = [0_u64; REPLY_WORDS];
    // SAFETY: the buffers outlive the call, the reply buffer is aligned for `ICMP_ECHO_REPLY` and
    // its stated size is its real size. The call is synchronous and bounded by `WAIT_MS`.
    let count = unsafe {
        IcmpSendEcho(
            handle.0,
            u32::from_ne_bytes(destination.octets()),
            PAYLOAD.as_ptr() as *const c_void,
            PAYLOAD.len() as u16,
            &options,
            reply.as_mut_ptr() as *mut c_void,
            size_of_val(&reply) as u32,
            WAIT_MS,
        )
    };
    if count == 0 {
        // SAFETY: reads this thread's last error, which the failed call just set.
        let status = unsafe { GetLastError() };
        return Echo {
            status,
            address: None,
            rtt_ms: None,
        };
    }
    // SAFETY: the call reported a reply, so the buffer starts with an `ICMP_ECHO_REPLY`.
    let echo = unsafe { &*(reply.as_ptr() as *const ICMP_ECHO_REPLY) };
    Echo {
        status: echo.Status,
        address: Some(Ipv4Addr::from(echo.Address.to_ne_bytes())),
        rtt_ms: Some(f64::from(echo.RoundTripTime)),
    }
}

fn hop_of(ttl: u8, echo: Echo) -> Option<Hop> {
    let answered = |reached, unreachable| {
        Some(Hop {
            hop: ttl,
            address: echo.address.map(|address| address.to_string()),
            rtt_ms: echo.rtt_ms,
            reached,
            unreachable,
        })
    };
    match echo.status {
        IP_SUCCESS => answered(true, false),
        IP_TTL_EXPIRED_TRANSIT | IP_TTL_EXPIRED_REASSEM => answered(false, false),
        IP_DEST_HOST_UNREACHABLE
        | IP_DEST_NET_UNREACHABLE
        | IP_DEST_PROT_UNREACHABLE
        | IP_DEST_PORT_UNREACHABLE => answered(false, true),
        // `IP_REQ_TIMED_OUT`, and anything else that came without a device to name.
        _ => None,
    }
}

const fn ends(hop: &Hop) -> bool {
    hop.reached || hop.unreachable
}

/// Blocks, for at most about a minute (30 hops, two 1-second tries).
pub fn trace(
    destination: Ipv4Addr,
    max_hops: u8,
    cancel: watch::Receiver<bool>,
    mut on_hop: impl FnMut(Hop),
) -> Result<()> {
    // SAFETY: takes no arguments and the handle is checked before use.
    let handle = unsafe { IcmpCreateFile() };
    if handle == INVALID_HANDLE_VALUE {
        return Err("이 PC에서 ICMP를 사용할 수 없습니다.".into());
    }
    let handle = Handle(handle);
    for ttl in 1..=max_hops {
        let mut answer = None;
        for _ in 0..TRIES {
            if *cancel.borrow() {
                return Ok(());
            }
            let echo = send(&handle, destination, ttl);
            debug_assert!(echo.status != IP_REQ_TIMED_OUT || echo.address.is_none());
            answer = hop_of(ttl, echo);
            if answer.is_some() {
                break;
            }
        }
        let hop = answer.unwrap_or(Hop {
            hop: ttl,
            address: None,
            rtt_ms: None,
            reached: false,
            unreachable: false,
        });
        let last = ends(&hop);
        on_hop(hop);
        if last {
            break;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn echo(status: u32) -> Echo {
        Echo {
            status,
            address: Some(Ipv4Addr::new(10, 0, 0, 1)),
            rtt_ms: Some(2.0),
        }
    }

    #[test]
    fn status_codes_become_hops() {
        assert!(hop_of(3, echo(IP_SUCCESS)).unwrap().reached);
        let passing = hop_of(1, echo(IP_TTL_EXPIRED_TRANSIT)).unwrap();
        assert!(!passing.reached && !passing.unreachable);
        assert_eq!(passing.address.as_deref(), Some("10.0.0.1"));
        assert!(
            hop_of(2, echo(IP_DEST_NET_UNREACHABLE))
                .unwrap()
                .unreachable
        );
        assert_eq!(hop_of(4, echo(IP_REQ_TIMED_OUT)), None);
    }

    #[test]
    fn the_loopback_is_reached_on_the_first_hop() {
        let (_stop, cancel) = watch::channel(false);
        let mut hops = Vec::new();
        trace(Ipv4Addr::LOCALHOST, 30, cancel, |hop| hops.push(hop)).unwrap();
        assert_eq!(hops.len(), 1, "{hops:?}");
        assert!(hops[0].reached);
        assert_eq!(hops[0].address.as_deref(), Some("127.0.0.1"));
    }

    #[test]
    fn a_cancelled_trace_sends_nothing() {
        let (stop, cancel) = watch::channel(false);
        stop.send(true).unwrap();
        let mut hops = 0;
        trace(Ipv4Addr::LOCALHOST, 30, cancel, |_| hops += 1).unwrap();
        assert_eq!(hops, 0);
    }
}
