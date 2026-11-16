//! Login options beyond the auth method (CG.3): which agent signs, and a certificate for the key.
use super::{Profile, Result};

/// `system` is this PC's OpenSSH agent (`SSH_AUTH_SOCK`, or the Windows OpenSSH pipe).
pub const AGENT_SOURCES: [&str; 2] = ["system", "pageant"];

pub(super) fn system() -> String {
    "system".into()
}
pub(super) fn is_system(value: &String) -> bool {
    value == "system"
}

impl Profile {
    pub(crate) fn check_login(&self) -> Result<()> {
        if !AGENT_SOURCES.contains(&self.agent_source.as_str()) {
            return Err("인증 에이전트 종류를 확인하세요.".into());
        }
        if self.protocol != "ssh" && !is_system(&self.agent_source) {
            return Err("Pageant는 SSH 연결에서만 쓸 수 있습니다.".into());
        }
        if self.cert_path.len() > 4096 || self.cert_path.chars().any(char::is_control) {
            return Err("인증서 파일 경로를 확인하세요.".into());
        }
        if !self.cert_path.is_empty() && self.auth != "key" {
            return Err("인증서 파일은 개인키 인증에서만 쓸 수 있습니다.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use crate::storage::tests::profile;
    #[test]
    fn agent_source_and_certificate_follow_the_auth_method() {
        let mut p = profile();
        assert!(!serde_json::to_string(&p).unwrap().contains("agentSource"));
        p.auth = "agent".into();
        p.agent_source = "pageant".into();
        assert!(p.validate().is_ok());
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains(r#""agentSource":"pageant""#));
        p.agent_source = "gpg".into();
        assert!(p.validate().is_err());
        let mut ftp = profile();
        ftp.protocol = "ftp".into();
        ftp.agent_source = "pageant".into();
        assert!(ftp.validate().is_err());
        let mut key = profile();
        key.auth = "key".into();
        key.key_path = "/k/id".into();
        key.cert_path = "/k/id-cert.pub".into();
        assert!(key.validate().is_ok());
        assert!(
            serde_json::to_string(&key)
                .unwrap()
                .contains(r#""certPath":"/k/id-cert.pub""#)
        );
        key.cert_path = "a\nb".into();
        assert!(key.validate().is_err());
        key.cert_path = "/k/id-cert.pub".into();
        key.auth = "password".into();
        assert!(key.validate().is_err());
    }
}
