//! This PC's listening sockets and their owners on Windows. `netstat` is not used because its
//! output changes with the language. Toolhelp gives every process's name without administrator
//! rights, unlike opening each process (TL.0: 28/28 names against 14/28 paths).
use super::listeners::{Listener, Process, Protocol};
use crate::storage::Result;
use std::{
    collections::HashMap,
    ffi::c_void,
    mem::{size_of, size_of_val},
    net::{Ipv4Addr, Ipv6Addr},
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, INVALID_HANDLE_VALUE, NO_ERROR},
    NetworkManagement::IpHelper::{
        GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID,
        MIB_UDP6ROW_OWNER_PID, MIB_UDPROW_OWNER_PID, TCP_TABLE_OWNER_PID_LISTENER,
        UDP_TABLE_OWNER_PID,
    },
    Networking::WinSock::{AF_INET, AF_INET6},
    System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    },
};

const FAILED: &str = "포트 목록을 읽지 못했습니다.";

/// Asks with a growing buffer: the table can get longer between the size query and the read.
/// `u32` keeps the alignment the table's rows need.
fn table(query: impl Fn(*mut c_void, &mut u32) -> u32) -> Result<Vec<u32>> {
    let mut size = 0_u32;
    for _ in 0..8 {
        let mut buffer = vec![0_u32; (size as usize).div_ceil(4).max(1)];
        match query(buffer.as_mut_ptr().cast(), &mut size) {
            NO_ERROR => return Ok(buffer),
            ERROR_INSUFFICIENT_BUFFER => {}
            _ => break,
        }
    }
    Err(FAILED.into())
}

/// The rows after a table's `dwNumEntries`. All four tables are laid out this way.
fn rows<R>(buffer: &[u32]) -> Result<&[R]> {
    let count = *buffer.first().ok_or(FAILED)? as usize;
    let bytes = count
        .checked_mul(size_of::<R>())
        .and_then(|bytes| bytes.checked_add(size_of::<u32>()))
        .ok_or(FAILED)?;
    if bytes > size_of_val(buffer) {
        return Err(FAILED.into());
    }
    // SAFETY: the bounds were checked above, the buffer is `u32`-aligned as `R` requires (every row
    // type here holds only u32 and u8 arrays), and the OS filled exactly these rows.
    Ok(unsafe { std::slice::from_raw_parts(buffer.as_ptr().add(1).cast(), count) })
}

/// The port is in network byte order, in the low 16 bits.
fn port(raw: u32) -> u16 {
    u16::from_be(raw as u16)
}
fn v4(raw: u32) -> String {
    Ipv4Addr::from(raw.to_ne_bytes()).to_string()
}
fn v6(raw: [u8; 16]) -> String {
    Ipv6Addr::from(raw).to_string()
}

fn tcp(family: u32) -> Result<Vec<u32>> {
    table(|buffer, size| {
        // SAFETY: `buffer` holds `*size` bytes, and the call only writes that many.
        unsafe { GetExtendedTcpTable(buffer, size, 0, family, TCP_TABLE_OWNER_PID_LISTENER, 0) }
    })
}
fn udp(family: u32) -> Result<Vec<u32>> {
    table(|buffer, size| {
        // SAFETY: as in `tcp`.
        unsafe { GetExtendedUdpTable(buffer, size, 0, family, UDP_TABLE_OWNER_PID, 0) }
    })
}

/// Process ID to executable name.
fn process_names() -> HashMap<u32, String> {
    let mut names = HashMap::new();
    // SAFETY: the snapshot is checked, the entry's `dwSize` is set as the API requires, and the
    // handle is closed on the only path out.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return names;
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut more = Process32FirstW(snapshot, &mut entry) != 0;
        while more {
            let name = &entry.szExeFile;
            let end = name.iter().position(|c| *c == 0).unwrap_or(name.len());
            names.insert(entry.th32ProcessID, String::from_utf16_lossy(&name[..end]));
            more = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
    }
    names
}

pub fn list() -> Result<Vec<Listener>> {
    let names = process_names();
    let owner = |pid: u32| match names.get(&pid) {
        Some(name) => Process::Known {
            name: name.clone(),
            pid: Some(pid),
        },
        None => Process::Unavailable,
    };
    let mut listeners = Vec::new();
    let mut add = |protocol, address, raw_port, pid| {
        listeners.push(Listener {
            protocol,
            address,
            port: port(raw_port),
            process: owner(pid),
        });
    };
    let buffer = tcp(AF_INET as u32)?;
    for row in rows::<MIB_TCPROW_OWNER_PID>(&buffer)? {
        add(
            Protocol::Tcp,
            v4(row.dwLocalAddr),
            row.dwLocalPort,
            row.dwOwningPid,
        );
    }
    let buffer = tcp(AF_INET6 as u32)?;
    for row in rows::<MIB_TCP6ROW_OWNER_PID>(&buffer)? {
        add(
            Protocol::Tcp,
            v6(row.ucLocalAddr),
            row.dwLocalPort,
            row.dwOwningPid,
        );
    }
    let buffer = udp(AF_INET as u32)?;
    for row in rows::<MIB_UDPROW_OWNER_PID>(&buffer)? {
        add(
            Protocol::Udp,
            v4(row.dwLocalAddr),
            row.dwLocalPort,
            row.dwOwningPid,
        );
    }
    let buffer = udp(AF_INET6 as u32)?;
    for row in rows::<MIB_UDP6ROW_OWNER_PID>(&buffer)? {
        add(
            Protocol::Udp,
            v6(row.ucLocalAddr),
            row.dwLocalPort,
            row.dwOwningPid,
        );
    }
    listeners
        .sort_by(|a, b| (a.port, a.protocol, &a.address).cmp(&(b.port, b.protocol, &b.address)));
    Ok(listeners)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_a_socket_this_test_opened_with_its_name() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let wanted = listener.local_addr().unwrap().port();
        let list = list().unwrap();
        let found = list
            .iter()
            .find(|l| l.port == wanted && l.protocol == Protocol::Tcp)
            .expect("the socket is listed");
        assert_eq!(found.address, "127.0.0.1");
        let Process::Known { name, pid } = &found.process else {
            panic!("the owner is named");
        };
        assert_eq!(*pid, Some(std::process::id()));
        assert!(name.to_lowercase().ends_with(".exe"), "{name}");
    }

    #[test]
    fn a_table_shorter_than_it_claims_is_an_error() {
        assert!(rows::<MIB_TCPROW_OWNER_PID>(&[3, 0]).is_err());
        assert!(rows::<MIB_TCPROW_OWNER_PID>(&[]).is_err());
        assert!(rows::<MIB_TCPROW_OWNER_PID>(&[0]).unwrap().is_empty());
    }

    #[test]
    fn the_port_is_network_order() {
        assert_eq!(port(u32::from(0x5000_u16.to_be())), 0x5000);
    }
}
