//! What a port check is asked to try. This is the only parser of that input: it decides the attempt
//! count the user confirms, and the limits are not configurable (design §6, §7).
use crate::storage::Result;
use std::{
    collections::{BTreeSet, HashSet},
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
};

pub const MAX_HOSTS: usize = 256;
pub const MAX_ATTEMPTS: usize = 4096;

#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    pub hosts: Vec<String>,
    pub ports: Vec<u16>,
}
impl Plan {
    pub fn attempts(&self) -> usize {
        self.hosts.len() * self.ports.len()
    }
}

/// A name that goes into a socket call or, quoted, a remote command. Never a leading `-`, which a
/// remote tool would read as an option.
pub fn is_host_name(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 253
        && !text.starts_with(['-', '.'])
        && text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

fn tokens(text: &str) -> impl Iterator<Item = &str> {
    text.split(|c: char| c == ',' || c.is_whitespace())
        .filter(|token| !token.is_empty())
}

fn range(token: &str) -> Result<Vec<String>> {
    let (network, bits) = token.split_once('/').unwrap_or((token, ""));
    let address: Ipv4Addr = network
        .parse()
        .map_err(|_| format!("대역은 IPv4만 쓸 수 있습니다: {token}"))?;
    let bits: u32 = bits
        .parse()
        .ok()
        .filter(|bits| *bits <= 32)
        .ok_or(format!("대역의 접두사 길이가 잘못되었습니다: {token}"))?;
    let count = 1_u64 << (32 - bits);
    if count > MAX_HOSTS as u64 {
        return Err(format!(
            "대역이 너무 큽니다: {token} ({count}개). 한 번에 {MAX_HOSTS}개까지 점검합니다."
        ));
    }
    let start = u32::from(address) & !((count - 1) as u32);
    Ok((0..count as u32)
        .map(|offset| Ipv4Addr::from(start + offset).to_string())
        .collect())
}

fn expand(token: &str) -> Result<Vec<String>> {
    if token.contains('/') {
        return range(token);
    }
    let bare = token
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(token);
    if let Ok(address) = bare.parse::<IpAddr>() {
        return Ok(vec![address.to_string()]);
    }
    // A malformed address must not fall through to being looked up as a name.
    if bare.contains(':') || bare.parse::<Ipv6Addr>().is_ok() || !is_host_name(bare) {
        return Err(format!("대상 형식이 잘못되었습니다: {token}"));
    }
    Ok(vec![bare.to_ascii_lowercase()])
}

fn hosts(text: &str) -> Result<Vec<String>> {
    let mut seen = HashSet::new();
    let mut hosts = Vec::new();
    for token in tokens(text) {
        for host in expand(token)? {
            if seen.insert(host.clone()) {
                hosts.push(host);
            }
            if hosts.len() > MAX_HOSTS {
                return Err(format!("대상은 한 번에 {MAX_HOSTS}개까지 점검합니다."));
            }
        }
    }
    if hosts.is_empty() {
        return Err("대상을 입력하세요.".into());
    }
    Ok(hosts)
}

fn port(text: &str) -> Result<u16> {
    text.parse()
        .ok()
        .filter(|port| *port != 0)
        .ok_or(format!("포트는 1~65535 사이여야 합니다: {text}"))
}

fn ports(text: &str) -> Result<Vec<u16>> {
    let mut ports = BTreeSet::new();
    for token in tokens(text) {
        let (first, last) = match token.split_once('-') {
            Some((first, last)) => (port(first)?, port(last)?),
            None => (port(token)?, port(token)?),
        };
        if first > last {
            return Err(format!("포트 범위가 거꾸로입니다: {token}"));
        }
        ports.extend(first..=last);
    }
    if ports.is_empty() {
        return Err("포트를 입력하세요.".into());
    }
    Ok(ports.into_iter().collect())
}

pub fn plan(targets: &str, port_list: &str) -> Result<Plan> {
    let plan = Plan {
        hosts: hosts(targets)?,
        ports: ports(port_list)?,
    };
    if plan.attempts() > MAX_ATTEMPTS {
        return Err(format!(
            "시도가 {}회입니다. 한 번에 {MAX_ATTEMPTS}회까지 점검합니다.",
            plan.attempts()
        ));
    }
    Ok(plan)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_hosts_addresses_and_ports() {
        let plan = plan("db.example, 10.0.0.5 [::1]", "22,80 8000-8002").unwrap();
        assert_eq!(plan.hosts, ["db.example", "10.0.0.5", "::1"]);
        assert_eq!(plan.ports, [22, 80, 8000, 8001, 8002]);
        assert_eq!(plan.attempts(), 15);
    }

    #[test]
    fn a_range_is_every_address_of_the_network() {
        let plan = plan("10.0.0.9/30", "22").unwrap();
        assert_eq!(
            plan.hosts,
            ["10.0.0.8", "10.0.0.9", "10.0.0.10", "10.0.0.11"]
        );
        assert_eq!(super::plan("10.1.2.3/24", "22").unwrap().hosts.len(), 256);
        assert_eq!(super::plan("10.1.2.3/32", "22").unwrap().hosts.len(), 1);
    }

    #[test]
    fn repeats_are_tried_once() {
        let plan = plan(
            "Web.Example web.example 10.0.0.1 10.0.0.1/32",
            "80,80,79-81",
        )
        .unwrap();
        assert_eq!(plan.hosts, ["web.example", "10.0.0.1"]);
        assert_eq!(plan.ports, [79, 80, 81]);
    }

    #[test]
    fn limits_cannot_be_exceeded() {
        assert!(
            plan("10.0.0.0/23", "22")
                .unwrap_err()
                .contains("너무 큽니다")
        );
        assert!(plan("0.0.0.0/0", "22").unwrap_err().contains("너무 큽니다"));
        assert!(
            plan("10.0.0.0/24 10.0.1.0", "22")
                .unwrap_err()
                .contains("256개까지")
        );
        assert!(plan("10.0.0.0/24", "1-17").unwrap_err().contains("4352회"));
        assert_eq!(plan("10.0.0.0/24", "1-16").unwrap().attempts(), 4096);
    }

    #[test]
    fn rejects_what_is_not_a_target() {
        for bad in [
            "-oProxyCommand=x",
            "a b;reboot",
            "$(id)",
            "한글.example",
            "::g",
            "fe80::/64",
            "10.0.0.0/33",
            "10.0.0.0/x",
            ".leading",
            "",
        ] {
            assert!(plan(bad, "22").is_err(), "{bad}");
        }
    }

    #[test]
    fn rejects_what_is_not_a_port() {
        for bad in ["", "0", "65536", "90-80", "a", "1-", "22;id"] {
            assert!(plan("10.0.0.1", bad).is_err(), "{bad}");
        }
        assert_eq!(plan("10.0.0.1", "65535").unwrap().ports, [65535]);
    }
}
