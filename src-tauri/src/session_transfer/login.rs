//! Login settings in other tools' files (CG.3): a certificate for the key file, and Pageant.
use super::Preview;
use crate::storage::Profile;

/// A certificate path for a session that logs in with a key file. Paths that need expanding
/// are left for the user, like `IdentityFile`'s.
pub(super) fn certificate(out: &mut Preview, p: &mut Profile, path: &str) {
    if matches!(path, "" | "none") {
        return;
    }
    if p.auth != "key" {
        out.warn("개인키 파일이 없는 세션의 인증서 경로는 가져오지 않았습니다.");
    } else if path.contains(['%', '$', '~']) {
        out.warn("환경변수·홈·토큰 인증서 경로는 적용 전 다시 지정하세요.");
    } else {
        p.cert_path = path.into();
    }
}

/// OpenSSH's `CertificateFile` (its first value), and what a session chooses itself instead of a
/// file: an `IdentityAgent` that points at Pageant (`agent_source`) and `ForwardX11` (CG.9, never
/// turned on by an import, like agent forwarding).
pub(super) fn openssh<'a>(out: &mut Preview, p: &mut Profile, get: impl Fn(&str) -> &'a str) {
    certificate(out, p, get("certificatefile"));
    if matches!(
        get("forwardx11").to_ascii_lowercase().as_str(),
        "yes" | "true"
    ) {
        out.warn("ForwardX11은 켜지 않았습니다. 필요한 세션은 고급 옵션에서 X11 포워딩을 켜세요.");
    }
    if get("identityagent")
        .to_ascii_lowercase()
        .contains("pageant")
    {
        out.warn("IdentityAgent의 Pageant 지정은 가져오지 않습니다. Windows에서 세션의 인증 에이전트를 Pageant로 고르세요.");
    }
}

/// A file from Windows may name Pageant, which only Windows has.
pub(super) fn pageant_elsewhere(out: &mut Preview) {
    if cfg!(not(windows))
        && out
            .bundle
            .profiles
            .iter()
            .any(|p| p.agent_source == "pageant")
    {
        out.warn("Pageant를 쓰는 세션은 Windows에서만 연결할 수 있습니다.");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_certificate_needs_a_key_file_and_a_plain_path() {
        let mut out = Preview::new();
        let mut p = crate::storage::tests::profile();
        certificate(&mut out, &mut p, "/k/id-cert.pub");
        assert!(
            p.cert_path.is_empty() && out.warnings.len() == 1,
            "password login"
        );
        p.auth = "key".into();
        p.key_path = "/k/id".into();
        certificate(&mut out, &mut p, "~/.ssh/id-cert.pub");
        assert!(p.cert_path.is_empty() && out.warnings.len() == 2);
        certificate(&mut out, &mut p, "none");
        assert!(p.cert_path.is_empty());
        let values = |k: &str| match k {
            "certificatefile" => "/k/id-cert.pub",
            "identityagent" => r"\\.\pipe\pageant.user.abc",
            "forwardx11" => "yes",
            _ => "",
        };
        openssh(&mut out, &mut p, values);
        assert_eq!(p.cert_path, "/k/id-cert.pub");
        assert!(out.warnings.last().unwrap().contains("Pageant"));
        assert!(out.warnings.iter().any(|w| w.starts_with("ForwardX11")) && !p.forward_x11);
        p.auth = "agent".into();
        p.agent_source = "pageant".into();
        out.bundle.profiles.push(p);
        let before = out.warnings.len();
        pageant_elsewhere(&mut out);
        assert_eq!(out.warnings.len(), before + usize::from(cfg!(not(windows))));
    }
}
