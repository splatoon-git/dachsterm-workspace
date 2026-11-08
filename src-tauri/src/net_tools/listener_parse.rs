//! Reads the port lists of other programs. All of this text comes from the machine being looked
//! at, so it is parsed into fields here and only those fields travel on.
use super::listeners::{Listener, Process, Protocol};
use crate::remote_ports::{self, Port};
use std::{
    collections::{BTreeMap, HashMap},
    net::Ipv6Addr,
};

const TCP_LISTEN: &str = "0A";
const UDP_BOUND: &str = "07";

/// One socket as a tool printed it. `process` is what it could tell about the owner, if anything.
#[derive(Debug, PartialEq, Eq)]
pub struct Socket {
    pub protocol: Protocol,
    pub address: String,
    pub port: u16,
    pub process: Option<(String, Option<u32>)>,
}

/// Splits a script's output at its `@@name` marker lines.
pub fn sections(output: &str) -> HashMap<&str, String> {
    let mut found: HashMap<&str, String> = HashMap::new();
    let mut current = None;
    for line in output.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            found.entry(name.trim()).or_default();
            current = Some(name.trim());
        } else if let Some(name) = current {
            let body = found.get_mut(name).unwrap();
            body.push_str(line);
            body.push('\n');
        }
    }
    found
}

fn normalize(host: &str) -> String {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let host = host.split('%').next().unwrap_or(host);
    match host.parse::<Ipv6Addr>() {
        Ok(v6) => v6
            .to_ipv4_mapped()
            .map_or(v6.to_string(), |v4| v4.to_string()),
        Err(_) => host.to_string(),
    }
}

fn split_at(text: &str, at: usize) -> Option<(String, u16)> {
    Some((normalize(&text[..at]), text[at + 1..].parse().ok()?))
}

/// `0.0.0.0:22`, `[::1]:631`, `:::22`, `*:22`, and BSD's `*.22` and `::1.631`.
fn host_and_port(text: &str) -> Option<(String, u16)> {
    let colon = text.rfind(':');
    let dot = text.rfind('.');
    match (colon, dot) {
        (Some(c), Some(d)) if d > c => split_at(text, d),
        (Some(c), _) => split_at(text, c),
        (None, Some(d)) => split_at(text, d),
        (None, None) => None,
    }
}

fn protocol(name: &str) -> Option<Protocol> {
    if name.starts_with("tcp") {
        Some(Protocol::Tcp)
    } else if name.starts_with("udp") {
        Some(Protocol::Udp)
    } else {
        None
    }
}

/// `ss -lntup`.
pub fn ss(text: &str) -> Vec<Socket> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            let protocol = protocol(fields.first()?)?;
            let (address, port) = host_and_port(fields.get(4)?)?;
            Some(Socket {
                protocol,
                address,
                port,
                process: fields
                    .get(6..)
                    .and_then(|rest| rest.iter().find_map(|f| ss_process(f))),
            })
        })
        .collect()
}

/// `users:(("sshd",pid=10,fd=3),("sshd",pid=11,fd=3))`: the first owner.
fn ss_process(field: &str) -> Option<(String, Option<u32>)> {
    let rest = field.strip_prefix("users:((\"")?;
    let (name, rest) = rest.split_once('"')?;
    let pid = rest
        .split(',')
        .find_map(|part| part.strip_prefix("pid="))
        .and_then(|pid| pid.split(')').next())
        .and_then(|pid| pid.parse().ok());
    Some((name.to_string(), pid))
}

/// `netstat -lntup` on Linux and `netstat -an` elsewhere.
pub fn netstat(text: &str) -> Vec<Socket> {
    text.lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            let protocol = protocol(fields.first()?)?;
            let (address, port) = host_and_port(fields.get(3)?)?;
            let foreign = fields.get(4)?;
            let listening = match protocol {
                Protocol::Tcp => fields[5..].iter().any(|f| f.contains("LISTEN")),
                Protocol::Udp => foreign.ends_with('*'),
            };
            if !listening {
                return None;
            }
            let owner = fields[5..]
                .iter()
                .find(|field| field.contains('/'))
                .and_then(|field| field.split_once('/'));
            Some(Socket {
                protocol,
                address,
                port,
                process: owner
                    .map(|(pid, name)| (name.trim_end_matches(':').to_string(), pid.parse().ok())),
            })
        })
        .collect()
}

/// `lsof -F`: one field per line, and a new file or process ends the file before it.
pub fn lsof(text: &str) -> Vec<Socket> {
    #[derive(Default)]
    struct File {
        protocol: Option<Protocol>,
        name: Option<String>,
    }
    fn close(file: &mut File, owner: &(Option<String>, Option<u32>), sockets: &mut Vec<Socket>) {
        let File { protocol, name } = std::mem::take(file);
        let (Some(protocol), Some(name)) = (protocol, name) else {
            return;
        };
        // `->` is a connected socket, not one waiting for connections.
        if name.contains("->") {
            return;
        }
        if let Some((address, port)) = host_and_port(&name) {
            sockets.push(Socket {
                protocol,
                address,
                port,
                process: owner.0.clone().map(|command| (command, owner.1)),
            });
        }
    }
    let mut sockets = Vec::new();
    let mut owner = (None, None);
    let mut file = File::default();
    for line in text.lines() {
        let Some(tag) = line.chars().next() else {
            continue;
        };
        let value = &line[tag.len_utf8()..];
        match tag {
            'p' => {
                close(&mut file, &owner, &mut sockets);
                owner = (None, value.parse().ok());
            }
            'f' => close(&mut file, &owner, &mut sockets),
            'c' => owner.0 = Some(value.to_string()),
            'P' => file.protocol = protocol(&value.to_ascii_lowercase()),
            'n' => file.name = Some(value.to_string()),
            _ => {}
        }
    }
    close(&mut file, &owner, &mut sockets);
    sockets
}

type Key = (Protocol, String, u16);

fn listener(key: Key, process: Process) -> Listener {
    let (protocol, address, port) = key;
    Listener {
        protocol,
        address,
        port,
        process,
    }
}

/// The list straight from one tool. A socket without an owner gets `missing`.
pub fn from_sockets(sockets: Vec<Socket>, missing: Process) -> Vec<Listener> {
    let mut merged = BTreeMap::new();
    for socket in sockets {
        let process = match socket.process {
            Some((name, pid)) => Process::Known { name, pid },
            None => missing.clone(),
        };
        merged
            .entry((socket.protocol, socket.address, socket.port))
            .or_insert(process);
    }
    merged
        .into_iter()
        .map(|(key, process)| listener(key, process))
        .collect()
}

/// The kernel's tables, as (protocol, table, wanted state). None when no table could be read.
pub fn tables(found: &HashMap<&str, String>) -> Option<Vec<(Protocol, Port)>> {
    let mut any = false;
    let mut out = Vec::new();
    for (name, protocol, state) in [
        ("table tcp", Protocol::Tcp, TCP_LISTEN),
        ("table tcp6", Protocol::Tcp, TCP_LISTEN),
        ("table udp", Protocol::Udp, UDP_BOUND),
        ("table udp6", Protocol::Udp, UDP_BOUND),
    ] {
        if let Some(ports) = found.get(name).and_then(|t| remote_ports::table(t, state)) {
            any = true;
            out.extend(ports.into_iter().map(|port| (protocol, port)));
        }
    }
    any.then_some(out)
}

/// The kernel's list decides what exists, and a tool's output only names the owners. `sockets` is
/// None when no such tool ran. A tool that ran and left a name out could not see that process.
pub fn with_owners(table: Vec<(Protocol, Port)>, sockets: Option<Vec<Socket>>) -> Vec<Listener> {
    let missing = if sockets.is_some() {
        Process::Denied
    } else {
        Process::Unavailable
    };
    let mut owners: HashMap<Key, (String, Option<u32>)> = HashMap::new();
    for socket in sockets.unwrap_or_default() {
        if let Some(process) = socket.process {
            owners
                .entry((socket.protocol, socket.address, socket.port))
                .or_insert(process);
        }
    }
    let mut merged = BTreeMap::new();
    for (protocol, Port { port, host }) in table {
        let exact = owners.get(&(protocol, host.clone(), port));
        let any = owners.get(&(protocol, "*".to_string(), port));
        let process = match exact.or(any) {
            Some((name, pid)) => Process::Known {
                name: name.clone(),
                pid: *pid,
            },
            None => missing.clone(),
        };
        merged.entry((protocol, host, port)).or_insert(process);
    }
    merged
        .into_iter()
        .map(|(key, process)| listener(key, process))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known(name: &str, pid: u32) -> Process {
        Process::Known {
            name: name.into(),
            pid: Some(pid),
        }
    }

    #[test]
    fn reads_ss_lines_with_and_without_an_owner() {
        let text = "Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n\
tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=10,fd=3),(\"sshd\",pid=11,fd=3))\n\
tcp LISTEN 0 128 [::]:80 [::]:*\n\
udp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:* users:((\"systemd-resolve\",pid=77,fd=13))\n\
tcp LISTEN 0 10 *:8080 *:* users:((\"java\",pid=9,fd=4))\n";
        let sockets = ss(text);
        assert_eq!(sockets.len(), 4);
        assert_eq!(
            sockets[0],
            Socket {
                protocol: Protocol::Tcp,
                address: "0.0.0.0".into(),
                port: 22,
                process: Some(("sshd".into(), Some(10))),
            }
        );
        assert_eq!(sockets[1].address, "::");
        assert_eq!(sockets[1].process, None);
        assert_eq!(sockets[2].protocol, Protocol::Udp);
        assert_eq!(sockets[2].address, "127.0.0.53");
        assert_eq!(sockets[3].address, "*");
    }

    #[test]
    fn reads_netstat_from_linux_and_busybox() {
        let text = "Active Internet connections (only servers)\n\
Proto Recv-Q Send-Q Local Address Foreign Address State PID/Program name\n\
tcp 0 0 0.0.0.0:22 0.0.0.0:* LISTEN 1/sshd: /usr/sbin/s\n\
tcp6 0 0 :::80 :::* LISTEN -\n\
tcp 0 0 10.0.0.1:50000 10.0.0.2:22 ESTABLISHED 3/ssh\n\
udp 0 0 0.0.0.0:68 0.0.0.0:* 12/dhclient\n";
        let sockets = netstat(text);
        assert_eq!(sockets.len(), 3);
        assert_eq!(sockets[0].process, Some(("sshd".into(), Some(1))));
        assert_eq!((sockets[1].address.as_str(), sockets[1].port), ("::", 80));
        assert_eq!(sockets[1].process, None);
        assert_eq!(sockets[2].process, Some(("dhclient".into(), Some(12))));
    }

    #[test]
    fn reads_bsd_netstat() {
        let text = "Active Internet connections (including servers)\n\
Proto Recv-Q Send-Q Local Address Foreign Address (state)\n\
tcp4 0 0 *.22 *.* LISTEN\n\
tcp4 0 0 127.0.0.1.8080 *.* LISTEN\n\
tcp6 0 0 ::1.631 *.* LISTEN\n\
tcp4 0 0 10.0.0.1.22 10.0.0.2.5000 ESTABLISHED\n\
udp4 0 0 *.68 *.*\n\
udp4 0 0 10.0.0.1.5353 10.0.0.2.53\n";
        let sockets = netstat(text);
        let summary: Vec<_> = sockets
            .iter()
            .map(|s| (s.address.as_str(), s.port))
            .collect();
        assert_eq!(
            summary,
            [("*", 22), ("127.0.0.1", 8080), ("::1", 631), ("*", 68)]
        );
        assert!(sockets.iter().all(|s| s.process.is_none()));
    }

    #[test]
    fn reads_lsof_fields_in_any_order_within_a_file() {
        let text = "p123\ncnginx\nf6\nPTCP\nn*:80\nf7\nn[::1]:631\nPTCP\n\
p456\ncmDNS\nf3\nPUDP\nn*:5353\nf4\nPUDP\nn10.0.0.1:50->10.0.0.2:53\n";
        let sockets = lsof(text);
        assert_eq!(sockets.len(), 3);
        assert_eq!(sockets[0].process, Some(("nginx".into(), Some(123))));
        assert_eq!((sockets[1].address.as_str(), sockets[1].port), ("::1", 631));
        assert_eq!(sockets[2].protocol, Protocol::Udp);
        assert_eq!(sockets[2].process, Some(("mDNS".into(), Some(456))));
    }

    #[test]
    fn output_that_is_none_of_these_gives_no_sockets() {
        for parse in [ss, netstat, lsof] {
            assert_eq!(
                parse("COMMAND PID USER FD\nsh 1 root 0u\n\nnot a table\n"),
                vec![]
            );
            assert_eq!(parse(""), vec![]);
        }
    }

    const TCP: &str = "  sl  local_address rem_address st\n\
   0: 00000000:0016 00000000:0000 0A 0\n\
   1: 0100007F:1F90 0100007F:D431 01 0\n";
    const UDP: &str = "  sl  local_address rem_address st\n\
   0: 00000000:0044 00000000:0000 07 0\n\
   1: 0100007F:1234 0100007F:0035 01 0\n";

    #[test]
    fn splits_a_script_into_its_sections() {
        let found = sections("@@table tcp\nabc\n@@table tcp6\n@@ss\nx\ny\n");
        assert_eq!(found["table tcp"], "abc\n");
        assert_eq!(found["table tcp6"], "");
        assert_eq!(found["ss"], "x\ny\n");
    }

    #[test]
    fn the_kernel_decides_what_exists_and_tools_name_owners() {
        let text = format!("@@table tcp\n{TCP}@@table udp\n{UDP}@@table tcp6\n");
        let found = sections(&text);
        let table = tables(&found).unwrap();
        assert_eq!(table.len(), 2, "only listening TCP and bound UDP");
        let sockets = vec![Socket {
            protocol: Protocol::Tcp,
            address: "*".into(),
            port: 22,
            process: Some(("sshd".into(), Some(1))),
        }];
        let list = with_owners(table, Some(sockets));
        assert_eq!(list[0].port, 22);
        assert_eq!(list[0].process, known("sshd", 1));
        assert_eq!(list[1].protocol, Protocol::Udp);
        assert_eq!(list[1].process, Process::Denied);
    }

    #[test]
    fn without_a_tool_the_owner_is_unavailable_rather_than_denied() {
        let text = format!("@@table tcp\n{TCP}");
        let found = sections(&text);
        let list = with_owners(tables(&found).unwrap(), None);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].process, Process::Unavailable);
    }

    #[test]
    fn a_server_with_no_tables_is_not_an_empty_list() {
        assert!(tables(&sections("@@table tcp\n@@table udp\n")).is_none());
    }

    #[test]
    fn a_list_from_one_tool_drops_repeats() {
        let socket = || Socket {
            protocol: Protocol::Udp,
            address: "*".into(),
            port: 5353,
            process: None,
        };
        let list = from_sockets(vec![socket(), socket()], Process::Unavailable);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].process, Process::Unavailable);
    }
}
