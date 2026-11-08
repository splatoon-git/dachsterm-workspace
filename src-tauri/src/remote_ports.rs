//! Lists ports a server listens on, so a server's development address can open on this PC. The
//! command is fixed, takes no user input, needs no tools and runs only when the user asks.
use crate::{
    AppState,
    remote_exec::{self, Limits},
    storage::Result,
};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    net::{Ipv4Addr, Ipv6Addr},
    time::Duration,
};

const LISTEN: &str = "0A";
const COMMAND: &str = "cat /proc/net/tcp /proc/net/tcp6";

#[derive(Serialize, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub struct Port {
    pub port: u16,
    pub host: String,
}

/// Kernel addresses are hex in host byte order, one 32-bit word at a time.
fn address(hex: &str) -> Option<String> {
    let word = |i: usize| u32::from_str_radix(hex.get(i..i + 8)?, 16).ok();
    match hex.len() {
        8 => Some(Ipv4Addr::from(word(0)?.to_le_bytes()).to_string()),
        32 => {
            let mut bytes = [0; 16];
            for index in 0..4 {
                bytes[index * 4..][..4].copy_from_slice(&word(index * 8)?.to_le_bytes());
            }
            let v6 = Ipv6Addr::from(bytes);
            Some(
                v6.to_ipv4_mapped()
                    .map_or(v6.to_string(), |v4| v4.to_string()),
            )
        }
        _ => None,
    }
}

/// None means the output is not this table, as on a server without Linux `/proc`.
pub(crate) fn parse(output: &str) -> Option<Vec<Port>> {
    table(output, LISTEN)
}

/// The sockets of a `/proc/net` table that are in `wanted` state. The network tools also read UDP.
pub(crate) fn table(output: &str, wanted: &str) -> Option<Vec<Port>> {
    if !output.lines().any(|line| line.contains("local_address")) {
        return None;
    }
    let mut ports = BTreeSet::new();
    for line in output.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        let (Some(local), Some(state)) = (fields.get(1), fields.get(3)) else {
            continue;
        };
        if *state != wanted {
            continue;
        }
        let Some((host, port)) = local.split_once(':') else {
            continue;
        };
        if let (Some(host), Ok(port)) = (address(host), u16::from_str_radix(port, 16)) {
            ports.insert(Port { port, host });
        }
    }
    Some(ports.into_iter().collect())
}

#[tauri::command]
pub async fn remote_ports(state: tauri::State<'_, AppState>, id: String) -> Result<Vec<Port>> {
    let handle = state.connections.handle(&id)?;
    let limits = Limits {
        timeout: Duration::from_secs(5),
        max_output: 1024 * 1024,
    };
    // `tcp6` is missing where IPv6 is off, so a failed `cat` can still have the table we need.
    let output = remote_exec::run(&handle, COMMAND, limits).await?;
    parse(&String::from_utf8_lossy(&output.stdout))
        .ok_or("이 서버에서는 포트 목록을 읽을 수 없습니다.".into())
}

#[cfg(test)]
mod tests {
    use super::{Port, address, parse};

    const TCP: &str = "  sl  local_address rem_address   st tx_queue rx_queue\n\
   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000\n\
   1: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000\n\
   2: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000\n";
    const TCP6: &str = "  sl  local_address                         remote_address  st\n\
   0: 00000000000000000000000000000000:1F41 00000000000000000000000000000000:0000 0A 0\n\
   1: 00000000000000000000000001000000:1F42 00000000000000000000000000000000:0000 0A 0\n\
   2: 0000000000000000FFFF00000100007F:1F43 00000000000000000000000000000000:0000 0A 0\n";

    fn port(port: u16, host: &str) -> Port {
        Port {
            port,
            host: host.into(),
        }
    }

    #[test]
    fn reads_listening_ports_from_both_tables() {
        assert_eq!(
            parse(&format!("{TCP}{TCP6}")).unwrap(),
            vec![
                port(22, "0.0.0.0"),
                port(3000, "127.0.0.1"),
                port(8001, "::"),
                port(8002, "::1"),
                port(8003, "127.0.0.1"),
            ]
        );
    }

    #[test]
    fn output_without_the_table_is_not_an_empty_list() {
        assert!(parse("cat: /proc/net/tcp: No such file or directory\n").is_none());
        assert!(parse("").is_none());
        assert_eq!(parse("  sl  local_address\n").unwrap(), vec![]);
    }

    #[test]
    fn ignores_rc_noise_and_listing_the_same_port_twice() {
        let doubled = format!("hello from rc\n{TCP}{TCP}");
        assert_eq!(parse(&doubled).unwrap().len(), 2);
        assert_eq!(address("0100007"), None);
        assert_eq!(address("ZZZZZZZZ"), None);
    }
}
