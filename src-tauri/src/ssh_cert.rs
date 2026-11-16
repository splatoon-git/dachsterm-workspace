//! OpenSSH user certificates for a login key file (CG.3). A server refuses an expired or
//! mismatched certificate without saying why (CG.0), so the app checks the pair, the validity
//! period and the principals before it tries one.
use crate::{
    ssh::{Event, Sink},
    storage::{Profile, Result},
};
use russh::keys::{Certificate, PrivateKey, ssh_key::certificate::CertType};
use std::{io::Read, path::PathBuf};

const MAX_FILE: u64 = 64 * 1024;

/// A certificate and whether the user named it (`cert_path`) rather than it sitting next to the key.
pub struct Found {
    pub cert: Certificate,
    pub named: bool,
}

/// The profile's `cert_path`, or OpenSSH's `<key_path>-cert.pub` when that file exists.
pub fn find(p: &Profile) -> Result<Option<Found>> {
    let named = !p.cert_path.is_empty();
    let path = if named {
        PathBuf::from(&p.cert_path)
    } else {
        PathBuf::from(format!("{}-cert.pub", p.key_path))
    };
    if !named && !path.is_file() {
        return Ok(None);
    }
    let mut text = String::new();
    std::fs::File::open(&path)
        .and_then(|f| f.take(MAX_FILE + 1).read_to_string(&mut text))
        .map_err(|_| "인증서 파일을 읽을 수 없습니다.")?;
    if text.len() as u64 > MAX_FILE {
        return Err("인증서 파일이 너무 큽니다.".into());
    }
    let cert = Certificate::from_openssh(text.trim())
        .map_err(|_| "OpenSSH 인증서 파일 형식이 아닙니다.")?;
    Ok(Some(Found { cert, named }))
}

/// `Err` for what cannot work (another key, a host certificate, outside its period), `Ok(Some)`
/// with a warning when the principals do not list the user: the server decides that one.
pub fn check(cert: &Certificate, key: &PrivateKey, user: &str, now: u64) -> Result<Option<String>> {
    if cert.cert_type() != CertType::User {
        return Err("사용자 인증서가 아닙니다(호스트 인증서).".into());
    }
    if cert.public_key() != key.public_key().key_data() {
        return Err("인증서가 개인키와 짝이 맞지 않습니다. 인증서 파일을 확인하세요.".into());
    }
    if now < cert.valid_after() {
        return Err(format!(
            "인증서 유효 기간이 아직 시작되지 않았습니다(시작 {}).",
            utc(cert.valid_after())
        ));
    }
    if now >= cert.valid_before() {
        return Err(format!(
            "인증서가 만료되었습니다(만료 {}).",
            utc(cert.valid_before())
        ));
    }
    let principals = cert.valid_principals();
    if principals.is_empty() || principals.iter().any(|p| p == user) {
        return Ok(None);
    }
    let listed: Vec<&str> = principals.iter().take(5).map(String::as_str).collect();
    Ok(Some(format!(
        "인증서 주체({})에 사용자 '{user}'가 없어 서버가 거부할 수 있습니다.",
        listed.join(", ")
    )))
}

/// The certificate to log in with. A certificate the user named stops the login when it cannot
/// work; one found next to the key is skipped with a notice, and the key is tried alone, as OpenSSH
/// does with a stale `-cert.pub`.
pub fn for_login(p: &Profile, key: &PrivateKey, sink: &Sink) -> Result<Option<Certificate>> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let notice = |message: String| {
        sink(Event::State {
            status: "authenticating".into(),
            message,
        })
    };
    let found = match find(p) {
        Ok(found) => found,
        Err(e) if p.cert_path.is_empty() => {
            notice(format!("{e} 인증서 없이 키로 로그인합니다."))?;
            None
        }
        Err(e) => return Err(e),
    };
    let Some(Found { cert, named }) = found else {
        return Ok(None);
    };
    match check(&cert, key, &p.username, now) {
        Ok(warning) => {
            if let Some(warning) = warning {
                notice(warning)?;
            }
            Ok(Some(cert))
        }
        Err(e) if named => Err(e),
        Err(e) => {
            notice(format!("{e} 인증서 없이 키로 로그인합니다."))?;
            Ok(None)
        }
    }
}

/// `YYYY-MM-DD HH:MM UTC` from Unix seconds (days to civil date, Hinnant's algorithm).
fn utc(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let minutes = seconds % 86_400 / 60;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02} UTC",
        minutes / 60,
        minutes % 60
    )
}

#[cfg(test)]
#[path = "ssh_cert_tests.rs"]
mod tests;
