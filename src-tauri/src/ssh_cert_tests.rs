use super::*;
use crate::ssh_keys::tests::{generate, keygen};
use std::{
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
};

/// Signs `key.pub` into `key-cert.pub` with `ca`, like the connect fixture's `init.sh`.
fn sign(dir: &Path, ca: &str, key: &str, extra: &[&str]) -> String {
    let status = Command::new(keygen())
        .args(["-q", "-s", ca, "-I", "test"])
        .args(extra)
        .arg(dir.join(format!("{key}.pub")))
        .status()
        .expect("ssh-keygen at its system path");
    assert!(status.success());
    dir.join(format!("{key}-cert.pub"))
        .to_string_lossy()
        .into_owned()
}
fn cert(path: &str) -> Certificate {
    Certificate::from_openssh(std::fs::read_to_string(path).unwrap().trim()).unwrap()
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

#[test]
fn checks_the_pair_the_period_and_the_principals() {
    let dir = tempfile::tempdir().unwrap();
    let ca = generate(dir.path(), "ca", &["-t", "ed25519"], "");
    let key_path = generate(dir.path(), "user", &["-t", "ed25519"], "");
    let key = crate::ssh_keys::load(&key_path, "").unwrap();
    let valid = cert(&sign(
        dir.path(),
        &ca,
        "user",
        &["-n", "alice,bob", "-V", "-5m:+1d"],
    ));
    assert_eq!(check(&valid, &key, "alice", now()), Ok(None));
    let warning = check(&valid, &key, "carol", now()).unwrap().unwrap();
    assert!(warning.contains("alice, bob") && warning.contains("'carol'"));
    let expired = cert(&sign(
        dir.path(),
        &ca,
        "user",
        &["-n", "alice", "-V", "-2d:-1d"],
    ));
    assert!(
        check(&expired, &key, "alice", now())
            .unwrap_err()
            .starts_with("인증서가 만료되었습니다(만료 ")
    );
    let later = cert(&sign(
        dir.path(),
        &ca,
        "user",
        &["-n", "alice", "-V", "+1d:+2d"],
    ));
    assert!(
        check(&later, &key, "alice", now())
            .unwrap_err()
            .contains("아직 시작되지")
    );
    let anyone = cert(&sign(dir.path(), &ca, "user", &[]));
    assert_eq!(
        check(&anyone, &key, "whoever", now()),
        Ok(None),
        "no principals"
    );
    let host = cert(&sign(dir.path(), &ca, "user", &["-h", "-n", "server"]));
    assert!(
        check(&host, &key, "alice", now())
            .unwrap_err()
            .contains("호스트 인증서")
    );
    let other_path = generate(dir.path(), "other", &["-t", "ed25519"], "");
    let other = crate::ssh_keys::load(&other_path, "").unwrap();
    assert!(
        check(&valid, &other, "alice", now())
            .unwrap_err()
            .contains("짝이 맞지")
    );
}

#[test]
fn a_named_certificate_stops_the_login_and_a_stale_one_beside_the_key_is_skipped() {
    let dir = tempfile::tempdir().unwrap();
    let ca = generate(dir.path(), "ca", &["-t", "ed25519"], "");
    let key_path = generate(dir.path(), "id", &["-t", "ed25519"], "");
    let key = crate::ssh_keys::load(&key_path, "").unwrap();
    let mut p = crate::storage::tests::profile();
    p.auth = "key".into();
    p.key_path = key_path.clone();
    p.username = "alice".into();
    let notices = Arc::new(Mutex::new(Vec::new()));
    let seen = notices.clone();
    let sink: Sink = Arc::new(move |e| {
        if let Event::State { message, .. } = e {
            seen.lock().unwrap().push(message);
        }
        Ok(())
    });
    assert!(
        for_login(&p, &key, &sink).unwrap().is_none(),
        "no cert file"
    );
    let expired = sign(dir.path(), &ca, "id", &["-n", "alice", "-V", "-2d:-1d"]);
    assert!(for_login(&p, &key, &sink).unwrap().is_none(), "skipped");
    assert!(notices.lock().unwrap()[0].ends_with("인증서 없이 키로 로그인합니다."));
    p.cert_path = expired;
    assert!(for_login(&p, &key, &sink).unwrap_err().contains("만료"));
    let valid = sign(dir.path(), &ca, "id", &["-n", "alice", "-V", "-5m:+1d"]);
    p.cert_path.clear();
    assert!(
        for_login(&p, &key, &sink).unwrap().is_some(),
        "found beside the key"
    );
    p.cert_path = valid;
    assert!(for_login(&p, &key, &sink).unwrap().is_some());
    p.cert_path = dir.path().join("missing").to_string_lossy().into_owned();
    assert!(
        for_login(&p, &key, &sink)
            .unwrap_err()
            .contains("읽을 수 없습니다")
    );
    p.cert_path = format!("{key_path}.pub");
    assert!(
        for_login(&p, &key, &sink)
            .unwrap_err()
            .contains("형식이 아닙니다")
    );
}

#[test]
fn utc_dates() {
    assert_eq!(utc(0), "1970-01-01 00:00 UTC");
    assert_eq!(utc(1_700_000_000), "2023-11-14 22:13 UTC");
    assert_eq!(utc(951_782_400), "2000-02-29 00:00 UTC");
}
