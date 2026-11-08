//! TLS for the service check. It reads the certificate whether or not it can be trusted and reports
//! the trust result separately. That is only safe because nothing is ever sent over this connection
//! except a `HEAD` request with no credentials; do not reuse this verifier anywhere else.
use super::dial::ByteStream;
use crate::agent_filter::plain_up_to;
use serde::Serialize;
use std::{
    io::{self, ErrorKind},
    sync::{Arc, Mutex},
    time::Duration,
};
use suppaftp::tokio_rustls::{
    TlsConnector,
    client::TlsStream,
    rustls::{
        CertificateError, ClientConfig, DigitallySignedStruct, Error as TlsError, ProtocolVersion,
        RootCertStore, SignatureScheme,
        client::{
            WebPkiServerVerifier,
            danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
        },
        crypto::{self, CryptoProvider, ring},
        pki_types::{CertificateDer, ServerName, UnixTime},
    },
};
use tokio::time::timeout;
use x509_cert::{
    Certificate,
    der::{DateTime, Decode},
    ext::pkix::{SubjectAltName, name::GeneralName},
    name::Name,
};

const HANDSHAKE_WAIT: Duration = Duration::from_secs(5);
const MAX_NAME: usize = 256;
const MAX_NAMES: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Trust {
    Trusted,
    SelfSigned,
    UnknownIssuer,
    Expired,
    NotYetValid,
    NameMismatch,
    Invalid,
    /// This PC's certificate store could not be read, so nothing can be said either way.
    NoRoots,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CertificateInfo {
    pub subject: Option<String>,
    pub issuer: Option<String>,
    /// `YYYY-MM-DD`, in UTC.
    pub not_before: String,
    pub not_after: String,
    pub names: Vec<String>,
    /// How many alternative names did not fit in `names`.
    pub more_names: usize,
    pub self_signed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Failure {
    NotTls,
    Unsupported,
    Refused,
    Closed,
    TimedOut,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TlsStep {
    pub version: Option<String>,
    pub trust: Option<Trust>,
    pub certificate: Option<CertificateInfo>,
    pub failure: Option<Failure>,
}

/// Records what the usual verification would have said, and lets the handshake go on either way.
#[derive(Debug)]
struct Observer {
    verifier: Option<Arc<WebPkiServerVerifier>>,
    provider: Arc<CryptoProvider>,
    seen: Arc<Mutex<Option<Seen>>>,
}
#[derive(Debug)]
struct Seen {
    der: Vec<u8>,
    verdict: Trust,
}

impl ServerCertVerifier for Observer {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let verdict = match &self.verifier {
            None => Trust::NoRoots,
            Some(verifier) => match verifier.verify_server_cert(
                end_entity,
                intermediates,
                server_name,
                ocsp_response,
                now,
            ) {
                Ok(_) => Trust::Trusted,
                Err(error) => trust_of(&error),
            },
        };
        *self.seen.lock().unwrap() = Some(Seen {
            der: end_entity.to_vec(),
            verdict,
        });
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn trust_of(error: &TlsError) -> Trust {
    let TlsError::InvalidCertificate(error) = error else {
        return Trust::Invalid;
    };
    match error {
        CertificateError::UnknownIssuer => Trust::UnknownIssuer,
        CertificateError::Expired | CertificateError::ExpiredContext { .. } => Trust::Expired,
        CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. } => {
            Trust::NotYetValid
        }
        CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. } => {
            Trust::NameMismatch
        }
        _ => Trust::Invalid,
    }
}

/// A self-signed certificate fails as an unknown issuer, or as a CA used directly when it was made
/// with OpenSSL's defaults (rustls has no variant for that one), so the certificate settles it.
fn refine(verdict: Trust, certificate: Option<&CertificateInfo>) -> Trust {
    match (verdict, certificate) {
        (Trust::UnknownIssuer | Trust::Invalid, Some(info)) if info.self_signed => {
            Trust::SelfSigned
        }
        _ => verdict,
    }
}

fn text(bytes: &[u8]) -> String {
    plain_up_to(bytes, MAX_NAME)
}

/// Only the common name: the whole subject's order and escaping differ between tools (TL.0).
fn common_name(name: &Name) -> Option<String> {
    let value = name.common_name().ok()??.value().into_owned();
    Some(text(value.as_bytes())).filter(|value| !value.is_empty())
}

fn date(time: DateTime) -> String {
    format!("{:04}-{:02}-{:02}", time.year(), time.month(), time.day())
}

fn alternative_names(certificate: &Certificate) -> Vec<String> {
    let Ok(Some((_, names))) = certificate
        .tbs_certificate()
        .get_extension::<SubjectAltName>()
    else {
        return Vec::new();
    };
    names
        .0
        .iter()
        .filter_map(|name| match name {
            GeneralName::DnsName(name) => Some(text(name.as_bytes())),
            GeneralName::IpAddress(address) => match address.as_bytes().len() {
                4 => <[u8; 4]>::try_from(address.as_bytes())
                    .ok()
                    .map(|octets| std::net::IpAddr::from(octets).to_string()),
                16 => <[u8; 16]>::try_from(address.as_bytes())
                    .ok()
                    .map(|octets| std::net::IpAddr::from(octets).to_string()),
                _ => None,
            },
            _ => None,
        })
        .collect()
}

/// None for anything malformed: a broken certificate is reported, not fatal.
pub fn certificate_info(der: &[u8]) -> Option<CertificateInfo> {
    let certificate = Certificate::from_der(der).ok()?;
    let tbs = certificate.tbs_certificate();
    let names = alternative_names(&certificate);
    let more_names = names.len().saturating_sub(MAX_NAMES);
    Some(CertificateInfo {
        subject: common_name(tbs.subject()),
        issuer: common_name(tbs.issuer()),
        not_before: date(tbs.validity().not_before.to_date_time()),
        not_after: date(tbs.validity().not_after.to_date_time()),
        names: names.into_iter().take(MAX_NAMES).collect(),
        more_names,
        self_signed: tbs.subject() == tbs.issuer(),
    })
}

/// Empty or partly unreadable stores still give whatever could be read.
async fn load_roots() -> Option<Arc<RootCertStore>> {
    let found = tokio::task::spawn_blocking(rustls_native_certs::load_native_certs)
        .await
        .ok()?;
    let mut roots = RootCertStore::empty();
    roots.add_parsable_certificates(found.certs);
    (!roots.is_empty()).then(|| Arc::new(roots))
}

pub struct Shaken {
    pub stream: TlsStream<Box<dyn ByteStream>>,
    pub step: TlsStep,
}

fn failure_of(error: &io::Error) -> Failure {
    match error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<TlsError>())
    {
        Some(TlsError::InvalidMessage(_)) => Failure::NotTls,
        Some(TlsError::InappropriateMessage { .. }) => Failure::NotTls,
        Some(TlsError::InappropriateHandshakeMessage { .. }) => Failure::NotTls,
        Some(TlsError::PeerIncompatible(_)) => Failure::Unsupported,
        Some(TlsError::AlertReceived(_)) => Failure::Refused,
        _ if error.kind() == ErrorKind::UnexpectedEof => Failure::Closed,
        _ if error.kind() == ErrorKind::ConnectionReset => Failure::Closed,
        _ => Failure::Failed,
    }
}

pub async fn handshake(stream: Box<dyn ByteStream>, host: &str) -> Result<Shaken, Box<TlsStep>> {
    let unstarted = |failure| {
        Box::new(TlsStep {
            version: None,
            trust: None,
            certificate: None,
            failure: Some(failure),
        })
    };
    let name = ServerName::try_from(host.to_string()).map_err(|_| unstarted(Failure::Failed))?;
    let provider = Arc::new(ring::default_provider());
    let verifier = match load_roots().await {
        Some(roots) => WebPkiServerVerifier::builder_with_provider(roots, provider.clone())
            .build()
            .ok(),
        None => None,
    };
    let seen = Arc::new(Mutex::new(None));
    let observer = Arc::new(Observer {
        verifier,
        provider: provider.clone(),
        seen: seen.clone(),
    });
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| unstarted(Failure::Failed))?
        .dangerous()
        .with_custom_certificate_verifier(observer)
        .with_no_client_auth();
    let result = timeout(
        HANDSHAKE_WAIT,
        TlsConnector::from(Arc::new(config)).connect(name, stream),
    )
    .await;
    let seen = seen.lock().unwrap().take();
    let (trust, certificate) = match seen {
        Some(seen) => {
            let certificate = certificate_info(&seen.der);
            (
                Some(refine(seen.verdict, certificate.as_ref())),
                certificate,
            )
        }
        None => (None, None),
    };
    let step = |version, failure| TlsStep {
        version,
        trust,
        certificate: certificate.clone(),
        failure,
    };
    match result {
        Err(_) => Err(Box::new(step(None, Some(Failure::TimedOut)))),
        Ok(Err(error)) => Err(Box::new(step(None, Some(failure_of(&error))))),
        Ok(Ok(stream)) => {
            let version = match stream.get_ref().1.protocol_version() {
                Some(ProtocolVersion::TLSv1_3) => Some("1.3".to_string()),
                Some(ProtocolVersion::TLSv1_2) => Some("1.2".to_string()),
                _ => None,
            };
            Ok(Shaken {
                stream,
                step: step(version, None),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use suppaftp::tokio_rustls::rustls::{AlertDescription, CertificateError as E, InvalidMessage};

    fn info(self_signed: bool) -> CertificateInfo {
        CertificateInfo {
            subject: None,
            issuer: None,
            not_before: String::new(),
            not_after: String::new(),
            names: Vec::new(),
            more_names: 0,
            self_signed,
        }
    }

    #[test]
    fn each_verification_failure_keeps_its_meaning() {
        for (error, trust) in [
            (E::UnknownIssuer, Trust::UnknownIssuer),
            (E::Expired, Trust::Expired),
            (E::NotValidYet, Trust::NotYetValid),
            (E::NotValidForName, Trust::NameMismatch),
            (E::BadSignature, Trust::Invalid),
        ] {
            assert_eq!(trust_of(&TlsError::InvalidCertificate(error)), trust);
        }
        assert_eq!(trust_of(&TlsError::HandshakeNotComplete), Trust::Invalid);
    }

    #[test]
    fn a_self_signed_certificate_is_called_that_only_for_issuer_failures() {
        let own = info(true);
        assert_eq!(refine(Trust::UnknownIssuer, Some(&own)), Trust::SelfSigned);
        assert_eq!(refine(Trust::Invalid, Some(&own)), Trust::SelfSigned);
        assert_eq!(refine(Trust::Expired, Some(&own)), Trust::Expired);
        assert_eq!(
            refine(Trust::UnknownIssuer, Some(&info(false))),
            Trust::UnknownIssuer
        );
        assert_eq!(refine(Trust::UnknownIssuer, None), Trust::UnknownIssuer);
    }

    #[test]
    fn handshake_errors_say_whether_the_server_speaks_tls() {
        let wrapped = |error: TlsError| io::Error::new(ErrorKind::InvalidData, error);
        assert_eq!(
            failure_of(&wrapped(TlsError::InvalidMessage(
                InvalidMessage::InvalidContentType
            ))),
            Failure::NotTls
        );
        assert_eq!(
            failure_of(&wrapped(TlsError::AlertReceived(
                AlertDescription::HandshakeFailure
            ))),
            Failure::Refused
        );
        assert_eq!(
            failure_of(&ErrorKind::UnexpectedEof.into()),
            Failure::Closed
        );
        assert_eq!(
            failure_of(&ErrorKind::ConnectionReset.into()),
            Failure::Closed
        );
        assert_eq!(failure_of(&ErrorKind::Other.into()), Failure::Failed);
    }

    /// Public half only: the key was thrown away when this was made.
    const SELF_SIGNED: &str = concat!(
        "MIIDdzCCAl+gAwIBAgIUWzMwXJxfP6NThc8lKHzp706ty+MwDQYJKoZIhvcNAQELBQAwNDEXMBUGA1UECgwORGFj",
        "aHNUZXJtIFRlc3QxGTAXBgNVBAMMEOyEnOu5hOyKpCDsi5ztl5gwHhcNMjYxMTA4MTQ1MjA1WhcNMzYxMTA1MTQ1",
        "MjA1WjA0MRcwFQYDVQQKDA5EYWNoc1Rlcm0gVGVzdDEZMBcGA1UEAwwQ7ISc67mE7IqkIOyLnO2XmDCCASIwDQYJ",
        "KoZIhvcNAQEBBQADggEPADCCAQoCggEBAKxlOBDXCib7G/88UTpJ4cppztwxMi6vcTCk6O/ldVTOcBc3416cqrem",
        "gmGpQ8Al7ht1rCh3LIV16SgwtbzATHaZt0vnZja3L7d+3uxRD5V+I7r5G1FP94br499CIAcK0vrmCo69k4fwuJly",
        "Mnp2mRczQ2EgaekGwZ1Q9AdXYgvj3XG552CQLZfsAOh5JT4zKe5J0IQoKJwymS0k5LMnYjecbBKwKGtiusEZNlZ2",
        "YHy2PYR7yg1x+JEdjHbJeHlR68fWTdluymzCJ3yfQra9p1h8IlzuFn8xto1HGtd9q5RzODNJqMNjgSO0uxRJPP5v",
        "xw9Bozw8tjWCf1xJmYGblp8CAwEAAaOBgDB+MB0GA1UdDgQWBBS21TfyRTJUnWBDvfQDxH3t8XT4UjAfBgNVHSME",
        "GDAWgBS21TfyRTJUnWBDvfQDxH3t8XT4UjAPBgNVHRMBAf8EBTADAQH/MCsGA1UdEQQkMCKCC3N2Yy5leGFtcGxl",
        "gg0qLnN2Yy5leGFtcGxlhwQKAAAFMA0GCSqGSIb3DQEBCwUAA4IBAQBS91VOkKuZXauEIWigjsM3PVGRPZ8cIRhz",
        "k7D9nf6LEVpfpplXxJETbrMMF9k7r1imDzXD3uDk7ErKEPCFPeCkH+9sxbJZrSEjb1s1wlQW9gs/OHFRo9+Egyzg",
        "dbGNKmSVKQheCertOGC34pRibZBeXE86/Pg8YiKw25pDosPTelAvA5Q9p5l/eFERP6BUv/UcMZnbJKYbb+iXvGah",
        "CV9BPvkahkly4qIpDe9fqLdyQZLfYXxzhoktsZZs2AnD/mkmLx0wFMNJgTdqaQeDIpkqQFgary16ozPO1lataepP",
        "6gMw1Y7UXBmBlkr+7esYNNwWNvMWwspZF1n6flV/PJGV",
    );

    #[test]
    fn reads_what_a_certificate_says() {
        use base64::Engine;
        let der = base64::engine::general_purpose::STANDARD
            .decode(SELF_SIGNED)
            .unwrap();
        let info = certificate_info(&der).unwrap();
        assert_eq!(info.subject.as_deref(), Some("서비스 시험"));
        assert_eq!(info.issuer.as_deref(), Some("서비스 시험"));
        assert!(info.self_signed);
        assert_eq!(info.not_before, "2026-11-08");
        assert_eq!(info.not_after, "2036-11-05");
        assert_eq!(info.names, ["svc.example", "*.svc.example", "10.0.0.5"]);
        assert_eq!(info.more_names, 0);
    }

    #[test]
    fn a_malformed_certificate_is_not_an_error_or_a_panic() {
        for bytes in [&b""[..], b"\x30\x82", b"not a certificate", &[0xff; 64]] {
            assert_eq!(certificate_info(bytes), None);
        }
    }
}
