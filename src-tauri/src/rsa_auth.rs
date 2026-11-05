//! RSA SSH authentication using ring, never the vulnerable RustCrypto rsa crate.
use crypto_bigint::{BoxedUint, NonZero};
use ring::{
    rand::SystemRandom,
    rsa::{KeyPair, KeyPairComponents, PublicKeyComponents},
    signature,
};
use russh::keys::{HashAlg, PrivateKey, agent::AgentIdentity};
use zeroize::{Zeroize, Zeroizing};

pub fn decode_pem(encoded: &str, password: &str) -> Result<PrivateKey, ()> {
    use russh::keys::ssh_key::{
        Mpint,
        private::{KeypairData, RsaKeypair, RsaPrivateKey},
        public::RsaPublicKey,
    };
    let (label, doc) = pkcs8::SecretDocument::from_pem(encoded).map_err(|_| ())?;
    let doc = if label == "ENCRYPTED PRIVATE KEY" {
        doc.decode_msg::<pkcs8::EncryptedPrivateKeyInfoRef<'_>>()
            .map_err(|_| ())?
            .decrypt(password)
            .map_err(|_| ())?
    } else {
        doc
    };
    let pkcs8;
    let der = if label == "RSA PRIVATE KEY" {
        doc.as_bytes()
    } else {
        pkcs8 = doc
            .decode_msg::<pkcs8::PrivateKeyInfoRef<'_>>()
            .map_err(|_| ())?;
        if pkcs8.algorithm.oid != pkcs1::ALGORITHM_OID {
            return Err(());
        }
        pkcs8.private_key.as_bytes()
    };
    let rsa = pkcs1::RsaPrivateKey::try_from(der).map_err(|_| ())?;
    if rsa.other_prime_infos.is_some() {
        return Err(());
    }
    let mp = |v: &[u8]| Mpint::from_positive_bytes(v);
    let public = RsaPublicKey::new(
        mp(rsa.public_exponent.as_bytes()),
        mp(rsa.modulus.as_bytes()),
    )
    .map_err(|_| ())?;
    let private = RsaPrivateKey::new(
        mp(rsa.private_exponent.as_bytes()),
        mp(rsa.coefficient.as_bytes()),
        mp(rsa.prime1.as_bytes()),
        mp(rsa.prime2.as_bytes()),
    )
    .map_err(|_| ())?;
    PrivateKey::new(
        KeypairData::Rsa(RsaKeypair::new(public, private).map_err(|_| ())?),
        "",
    )
    .map_err(|_| ())
}

pub struct RsaSigner(KeyPair);
#[derive(Debug)]
pub struct SignError;
impl From<russh::SendError> for SignError {
    fn from(_: russh::SendError) -> Self {
        Self
    }
}
impl RsaSigner {
    pub fn new(key: &PrivateKey) -> Result<Self, String> {
        let invalid =
            || "RSA 키는 2048~8192비트의 올바른 OpenSSH/PPK 개인키여야 합니다.".to_string();
        let rsa = key.key_data().rsa().ok_or_else(invalid)?;
        let n = rsa.public().n().as_positive_bytes().ok_or_else(invalid)?;
        if !(256..=1024).contains(&n.len()) {
            return Err(invalid());
        }
        let bytes = |m: &russh::keys::ssh_key::Mpint| {
            m.as_positive_bytes()
                .map(Vec::from)
                .map(Zeroizing::new)
                .ok_or_else(invalid)
        };
        let d = bytes(rsa.private().d())?;
        let p = bytes(rsa.private().p())?;
        let q = bytes(rsa.private().q())?;
        let iqmp = bytes(rsa.private().iqmp())?;
        // Fixed public modulus precision and constant-time remainder; no private
        // RSA exponentiation or padding implementation is supplied by the app.
        let precision = (n.len() * 8) as u32;
        let integer = |value: &[u8]| {
            BoxedUint::from_be_slice(value, precision)
                .map(Zeroizing::new)
                .map_err(|_| invalid())
        };
        let exponent = integer(&d)?;
        let crt = |prime: &[u8]| -> Result<Zeroizing<Vec<u8>>, String> {
            let prime = integer(prime)?;
            let minus_one =
                Zeroizing::new(prime.wrapping_sub(BoxedUint::one_with_precision(precision)));
            let divisor = NonZero::new((*minus_one).clone())
                .into_option()
                .ok_or_else(invalid)?;
            let remainder = Zeroizing::new(exponent.rem(&divisor));
            divisor.get().zeroize();
            Ok(Zeroizing::new(remainder.to_be_bytes().to_vec()))
        };
        let dp = crt(&p)?;
        let dq = crt(&q)?;
        let pair = KeyPair::from_components(&KeyPairComponents {
            public_key: PublicKeyComponents {
                n,
                e: rsa.public().e().as_positive_bytes().ok_or_else(invalid)?,
            },
            d: d.as_slice(),
            p: p.as_slice(),
            q: q.as_slice(),
            dP: trim(&dp),
            dQ: trim(&dq),
            qInv: iqmp.as_slice(),
        })
        .map_err(|_| invalid())?;
        Ok(Self(pair))
    }
}
fn trim(bytes: &[u8]) -> &[u8] {
    &bytes[bytes
        .iter()
        .position(|b| *b != 0)
        .unwrap_or(bytes.len() - 1)..]
}
fn string(out: &mut Vec<u8>, value: &[u8]) {
    out.extend_from_slice(&(value.len() as u32).to_be_bytes());
    out.extend_from_slice(value);
}
impl russh::Signer for RsaSigner {
    type Error = SignError;
    async fn auth_sign(
        &mut self,
        _: &AgentIdentity,
        hash: Option<HashAlg>,
        mut data: Vec<u8>,
    ) -> Result<Vec<u8>, Self::Error> {
        let (encoding, name) = match hash {
            Some(HashAlg::Sha256) => (&signature::RSA_PKCS1_SHA256, "rsa-sha2-256"),
            Some(HashAlg::Sha512) => (&signature::RSA_PKCS1_SHA512, "rsa-sha2-512"),
            _ => return Err(SignError),
        };
        let mut signature = vec![0; self.0.public().modulus_len()];
        self.0
            .sign(encoding, &SystemRandom::new(), &data, &mut signature)
            .map_err(|_| SignError)?;
        let mut blob = Vec::new();
        string(&mut blob, name.as_bytes());
        string(&mut blob, &signature);
        string(&mut data, &blob);
        Ok(data)
    }
}
