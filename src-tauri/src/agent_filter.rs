//! Frames a server sends to the forwarded agent, and which of them may reach the local agent.
//! The server is untrusted: lengths are checked before anything is read, and every message that
//! is not on the allow list is answered here without touching the local agent.

/// The same bound OpenSSH and russh use for one agent message.
pub const MAX_FRAME: usize = 256 * 1024;
/// `SSH_AGENT_FAILURE`, length-prefixed.
pub const FAILURE: [u8; 5] = [0, 0, 0, 1, 5];
pub const REQUEST_IDENTITIES: u8 = 11;
const IDENTITIES_ANSWER: u8 = 12;
const SIGN_REQUEST: u8 = 13;
const EXTENSION: u8 = 27;
const USERAUTH_REQUEST: u8 = 50;
const SESSION_BIND: &[u8] = b"session-bind@openssh.com";
/// Shown text from a server stays short. The card is not a place for a document.
const MAX_TEXT: usize = 128;

#[derive(Debug, PartialEq, Eq)]
pub struct BadFrame;

/// Takes one whole message body off the front of `buffer`. `Ok(None)` waits for more bytes.
pub fn take_frame(buffer: &mut Vec<u8>) -> Result<Option<Vec<u8>>, BadFrame> {
    let Some(header) = buffer.get(..4) else {
        return Ok(None);
    };
    let length = u32::from_be_bytes(header.try_into().unwrap()) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(BadFrame);
    }
    if buffer.len() < 4 + length {
        return Ok(None);
    }
    let body = buffer[4..4 + length].to_vec();
    buffer.drain(..4 + length);
    Ok(Some(body))
}

pub fn frame(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(body.len() + 4);
    out.extend_from_slice(&(body.len() as u32).to_be_bytes());
    out.extend_from_slice(body);
    out
}

#[derive(Debug, PartialEq, Eq)]
pub enum Purpose {
    /// The server signs in to another SSH server, as `git push` over SSH does.
    Login {
        user: String,
    },
    /// A file or commit signature (`SSHSIG`), with the namespace the signer chose.
    Signature {
        namespace: String,
    },
    Unknown,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Forward,
    Sign {
        key: Vec<u8>,
        purpose: Purpose,
    },
    /// The host key the remote client says it is talking to.
    Bind {
        host_key: Vec<u8>,
    },
    /// Adding, removing, locking and every other request. Answered with `FAILURE`.
    Refuse,
}

pub fn classify(body: &[u8]) -> Verdict {
    let Some((&kind, rest)) = body.split_first() else {
        return Verdict::Refuse;
    };
    let mut reader = Reader(rest);
    match kind {
        REQUEST_IDENTITIES => Verdict::Forward,
        SIGN_REQUEST => match (reader.string(), reader.string()) {
            (Some(key), Some(data)) => Verdict::Sign {
                key: key.to_vec(),
                purpose: purpose(data),
            },
            _ => Verdict::Refuse,
        },
        EXTENSION if reader.string() == Some(SESSION_BIND) => match reader.string() {
            Some(host_key) => Verdict::Bind {
                host_key: host_key.to_vec(),
            },
            None => Verdict::Refuse,
        },
        _ => Verdict::Refuse,
    }
}

fn purpose(data: &[u8]) -> Purpose {
    if let Some(rest) = data.strip_prefix(b"SSHSIG") {
        return match Reader(rest).string() {
            Some(namespace) => Purpose::Signature {
                namespace: plain(namespace),
            },
            None => Purpose::Unknown,
        };
    }
    let mut reader = Reader(data);
    let login = reader.string().is_some() && reader.byte() == Some(USERAUTH_REQUEST);
    match reader.string() {
        Some(user) if login => Purpose::Login { user: plain(user) },
        _ => Purpose::Unknown,
    }
}

/// Key blobs and comments from an `IDENTITIES_ANSWER`. Anything malformed gives no names.
pub fn identities(body: &[u8]) -> Vec<(Vec<u8>, String)> {
    if body.first() != Some(&IDENTITIES_ANSWER) {
        return vec![];
    }
    let mut reader = Reader(&body[1..]);
    let count = reader.u32().unwrap_or(0).min(1024);
    let mut out = Vec::new();
    for _ in 0..count {
        let (Some(key), Some(comment)) = (reader.string(), reader.string()) else {
            return vec![];
        };
        out.push((key.to_vec(), plain(comment)));
    }
    out
}

/// Server text shown as plain text: no control, hidden or direction characters, and short.
pub fn plain(bytes: &[u8]) -> String {
    plain_up_to(bytes, MAX_TEXT)
}

/// Text that came from a server, without anything that could disguise it on screen.
pub fn plain_up_to(bytes: &[u8], limit: usize) -> String {
    String::from_utf8_lossy(bytes)
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(*c as u32, 0xad | 0x61c | 0x200b..=0x200f | 0x202a..=0x202e | 0x2060..=0x206f | 0xfeff)
        })
        .take(limit)
        .collect()
}

struct Reader<'a>(&'a [u8]);
impl<'a> Reader<'a> {
    fn byte(&mut self) -> Option<u8> {
        let (first, rest) = self.0.split_first()?;
        self.0 = rest;
        Some(*first)
    }
    fn u32(&mut self) -> Option<u32> {
        let value = u32::from_be_bytes(self.0.get(..4)?.try_into().ok()?);
        self.0 = &self.0[4..];
        Some(value)
    }
    fn string(&mut self) -> Option<&'a [u8]> {
        let length = self.u32()? as usize;
        let value = self.0.get(..length)?;
        self.0 = &self.0[length..];
        Some(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn string(value: &[u8]) -> Vec<u8> {
        let mut out = (value.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(value);
        out
    }
    fn sign(data: &[u8]) -> Vec<u8> {
        [vec![SIGN_REQUEST], string(b"key"), string(data), vec![0; 4]].concat()
    }

    #[test]
    fn frames_are_bounded_and_split_at_their_length() {
        let mut buffer = [frame(&[11]), frame(&[11, 1])].concat();
        buffer.extend_from_slice(&[0, 0]);
        assert_eq!(take_frame(&mut buffer), Ok(Some(vec![11])));
        assert_eq!(take_frame(&mut buffer), Ok(Some(vec![11, 1])));
        assert_eq!(take_frame(&mut buffer), Ok(None));
        buffer.extend_from_slice(&[0, 1]);
        assert_eq!(take_frame(&mut buffer), Ok(None), "waits for the body");
        let mut empty = vec![0, 0, 0, 0];
        assert_eq!(take_frame(&mut empty), Err(BadFrame));
        let mut large = ((MAX_FRAME + 1) as u32).to_be_bytes().to_vec();
        assert_eq!(take_frame(&mut large), Err(BadFrame));
        let mut largest = (MAX_FRAME as u32).to_be_bytes().to_vec();
        assert_eq!(take_frame(&mut largest), Ok(None));
    }

    #[test]
    fn only_listing_signing_and_session_bind_pass() {
        assert_eq!(classify(&[REQUEST_IDENTITIES]), Verdict::Forward);
        // Add, remove, remove all, smartcard, lock, unlock, constrained add, and unknown numbers.
        for number in [17, 18, 19, 20, 21, 22, 23, 25, 26, 0, 5, 12, 255] {
            assert_eq!(classify(&[number, 0, 0, 0, 0]), Verdict::Refuse, "{number}");
        }
        let bind = [vec![EXTENSION], string(SESSION_BIND), string(b"host")].concat();
        assert_eq!(
            classify(&bind),
            Verdict::Bind {
                host_key: b"host".to_vec()
            }
        );
        let query = [vec![EXTENSION], string(b"query")].concat();
        assert_eq!(classify(&query), Verdict::Refuse);
        assert_eq!(classify(&[EXTENSION]), Verdict::Refuse);
        assert_eq!(classify(&[]), Verdict::Refuse);
        assert_eq!(classify(&[SIGN_REQUEST, 0, 0, 0, 9]), Verdict::Refuse);
    }

    #[test]
    fn a_sign_request_says_what_it_signs() {
        let login = [
            string(b"session"),
            vec![USERAUTH_REQUEST],
            string(b"git"),
            string(b"ssh-connection"),
        ]
        .concat();
        assert_eq!(
            classify(&sign(&login)),
            Verdict::Sign {
                key: b"key".to_vec(),
                purpose: Purpose::Login { user: "git".into() }
            }
        );
        let signature = [b"SSHSIG".to_vec(), string(b"git")].concat();
        assert!(matches!(
            classify(&sign(&signature)),
            Verdict::Sign { purpose: Purpose::Signature { namespace }, .. } if namespace == "git"
        ));
        assert!(matches!(
            classify(&sign(b"anything")),
            Verdict::Sign {
                purpose: Purpose::Unknown,
                ..
            }
        ));
    }

    #[test]
    fn server_text_is_plain_and_short() {
        assert_eq!(plain("a\u{202e}b\x1b[31mc\u{200b}".as_bytes()), "ab[31mc");
        assert_eq!(plain(&[b'x'; 500]).len(), MAX_TEXT);
        assert_eq!(plain(&[0xff, b'a']), "\u{fffd}a");
    }

    #[test]
    fn identity_names_come_from_a_well_formed_answer_only() {
        let answer = [
            vec![IDENTITIES_ANSWER],
            2u32.to_be_bytes().to_vec(),
            string(b"k1"),
            string(b"me@pc"),
            string(b"k2"),
            string(b"other"),
        ]
        .concat();
        assert_eq!(
            identities(&answer),
            vec![
                (b"k1".to_vec(), "me@pc".to_string()),
                (b"k2".to_vec(), "other".to_string())
            ]
        );
        assert!(identities(&answer[..answer.len() - 1]).is_empty());
        assert!(identities(&[FAILURE[4]]).is_empty());
    }
}
