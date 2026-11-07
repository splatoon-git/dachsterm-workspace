//! First-connection host key trust, moved out of `ssh.rs` unchanged.
use super::{Event, Host};
use crate::{hostkeys, storage::Result};
use russh::keys::{HashAlg, PublicKeyOrCertificate};
use std::time::Duration;
use tokio::time::timeout;

impl Host {
    pub(super) async fn verify(&mut self, key: &PublicKeyOrCertificate) -> Result<bool> {
        if key.certificate().is_some() {
            return Err("호스트 인증서는 아직 지원되지 않습니다.".into());
        }
        let key = &key.public_key();
        if hostkeys::check(&self.paths, &self.profile.host, self.profile.port, key)? {
            return Ok(true);
        }
        let _ = self.waiting.send(true);
        let challenge = uuid::Uuid::new_v4().to_string();
        *self.trust_request.lock().unwrap() = Some(challenge.clone());
        (self.sink)(Event::HostKey {
            challenge,
            host: self.profile.host.clone(),
            port: self.profile.port,
            algorithm: key.algorithm().to_string(),
            fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        })?;
        tokio::select! {
            biased;
            _ = self.stop.changed() => return Err("호스트키 확인이 취소되었습니다.".into()),
            result = timeout(Duration::from_secs(120), self.trust.changed()) => {
                result.map_err(|_| "호스트키 확인 시간이 초과되었습니다.")?.map_err(|_| "호스트키 확인이 취소되었습니다.")?;
            }
        }
        self.trust_request.lock().unwrap().take();
        if *self.trust.borrow() != Some(true) {
            return Err("호스트키 신뢰를 거부했습니다.".into());
        }
        let _ = self.waiting.send(false);
        let _guard = self.manager.host_lock.lock().unwrap();
        // Recheck under the writer lock: simultaneous first connections cannot overwrite trust.
        if !hostkeys::check(&self.paths, &self.profile.host, self.profile.port, key)? {
            hostkeys::remember(&self.paths[0], &self.profile.host, self.profile.port, key)?;
        }
        Ok(true)
    }
}
