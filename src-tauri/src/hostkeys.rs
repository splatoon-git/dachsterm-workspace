//! Exact, wildcard, negated and OpenSSH hashed hosts; revoked keys always win.
use crate::storage::Result;
use base64::{Engine, engine::general_purpose::STANDARD};
use hmac::{Hmac, Mac};
use russh::keys::PublicKey;
use std::io::Read;
use std::path::Path;
fn pattern(pattern: &str, host: &str) -> bool {
    if pattern.starts_with("|1|") {
        let parts: Vec<_> = pattern.split('|').collect();
        if parts.len() != 4 {
            return false;
        }
        let (Ok(salt), Ok(hash)) = (STANDARD.decode(parts[2]), STANDARD.decode(parts[3])) else {
            return false;
        };
        return Hmac::<sha1::Sha1>::new_from_slice(&salt).is_ok_and(|mac| {
            mac.chain_update(host.as_bytes())
                .verify_slice(&hash)
                .is_ok()
        });
    }
    let p = pattern.to_ascii_lowercase();
    let h = host.to_ascii_lowercase();
    let (p, h) = (p.as_bytes(), h.as_bytes());
    let (mut i, mut j, mut star, mut mark) = (0, 0, None, 0);
    while j < h.len() {
        if i < p.len() && (p[i] == b'?' || p[i] == h[j]) {
            i += 1;
            j += 1;
        } else if i < p.len() && p[i] == b'*' {
            star = Some(i);
            i += 1;
            mark = j;
        } else if let Some(s) = star {
            mark += 1;
            j = mark;
            i = s + 1;
        } else {
            return false;
        }
    }
    while i < p.len() && p[i] == b'*' {
        i += 1;
    }
    i == p.len()
}
fn matches(patterns: &str, host: &str) -> bool {
    let mut matched = false;
    for p in patterns.split(',') {
        if let Some(p) = p.strip_prefix('!') {
            if pattern(p, host) {
                return false;
            }
        } else if pattern(p, host) {
            matched = true;
        }
    }
    matched
}
pub fn check(paths: &[std::path::PathBuf], host: &str, port: u16, key: &PublicKey) -> Result<bool> {
    let target = if port == 22 {
        host.to_owned()
    } else {
        format!("[{host}]:{port}")
    };
    let mut found = false;
    let mut accepted = false;
    for path in paths {
        let file = match std::fs::File::open(path) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("known_hosts 파일을 읽을 수 없습니다.".into()),
        };
        let mut content = String::new();
        file.take(4 * 1024 * 1024 + 1)
            .read_to_string(&mut content)
            .map_err(|_| "known_hosts 파일을 읽을 수 없습니다.")?;
        if content.len() > 4 * 1024 * 1024 {
            return Err("known_hosts 파일이 허용 크기를 초과했습니다.".into());
        }
        for line in content
            .lines()
            .filter(|l| !l.trim_start().starts_with('#') && !l.trim().is_empty())
        {
            let mut words = line.split_whitespace();
            let first = words.next().unwrap();
            let (marker, hosts) = if first.starts_with('@') {
                (first, words.next().unwrap_or(""))
            } else {
                ("", first)
            };
            if !matches(hosts, &target) {
                continue;
            }
            let algorithm = words.next().ok_or("known_hosts 형식 오류")?;
            let data = words.next().ok_or("known_hosts 형식 오류")?;
            let recorded = PublicKey::from_openssh(&format!("{algorithm} {data}"))
                .map_err(|_| "known_hosts 공개키 형식 오류")?;
            if marker == "@revoked" {
                if recorded.key_data() == key.key_data() {
                    return Err("폐기된 호스트키입니다. 연결을 차단했습니다.".into());
                }
                continue;
            }
            if !marker.is_empty() {
                return Err(
                    "이 대상의 known_hosts 인증서/마커는 지원되지 않습니다. 연결을 차단했습니다."
                        .into(),
                );
            }
            found = true;
            accepted |= recorded.key_data() == key.key_data();
        }
    }
    if found && !accepted {
        Err("호스트키가 변경되었습니다. 서버 관리자와 known_hosts를 확인하세요. 연결을 차단했습니다.".into())
    } else {
        Ok(accepted)
    }
}
pub fn remember(path: &Path, host: &str, port: u16, key: &PublicKey) -> Result<()> {
    russh::keys::known_hosts::learn_known_hosts_path(host, port, key, path)
        .map_err(|_| "known_hosts 저장에 실패했습니다.".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_patterns() {
        assert!(matches("*.example,!bad.example", "ok.example"));
        assert!(!matches("*.example,!bad.example", "bad.example"));
        assert!(matches("[localhost]:2222", "[localhost]:2222"));
        assert!(!matches("localhost", "[localhost]:2222"));
    }
    #[test]
    fn hashed_hosts_are_scoped_to_host_and_port() {
        let salt = b"fixture-public-salt";
        let mac = Hmac::<sha1::Sha1>::new_from_slice(salt)
            .unwrap()
            .chain_update(b"[localhost]:2222")
            .finalize()
            .into_bytes();
        let hashed = format!("|1|{}|{}", STANDARD.encode(salt), STANDARD.encode(mac));
        assert!(matches(&hashed, "[localhost]:2222"));
        assert!(!matches(&hashed, "localhost"));
        assert!(!matches(&hashed, "[localhost]:2223"));
        assert!(!matches("|1|malformed|hash", "localhost"));
    }
}
