//! Telnet option negotiation and data framing (RFC 854, 855, 1091, 1073, 1143). Pure: bytes in,
//! output and replies out, so frame boundaries and every option can be tested without a server.
//!
//! Accepted: the server echoing (`WILL ECHO`), suppressing go-ahead (`WILL SGA`), binary in both
//! directions, and our terminal type and window size (`DO TTYPE`, `DO NAWS`). Everything else is
//! refused. An answer is sent only when an option's state changes, so two sides that keep asking
//! cannot loop (RFC 1143).
pub const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

pub const BINARY: u8 = 0;
pub const ECHO: u8 = 1;
pub const SGA: u8 = 3;
pub const TTYPE: u8 = 24;
pub const NAWS: u8 = 31;
const TTYPE_IS: u8 = 0;
const TTYPE_SEND: u8 = 1;
/// The terminal type xterm.js answers to, as the SSH terminal asks for its PTY.
const TERMINAL_TYPE: &[u8] = b"XTERM-256COLOR";
/// A subnegotiation longer than this is not one we asked for; the rest is dropped.
const MAX_SB: usize = 512;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
    Data,
    /// The last byte was a CR in data, so a NUL after it is padding (RFC 854).
    Cr,
    Iac,
    Command(u8),
    Sub,
    SubIac,
}

/// What one read gives: bytes for the screen and bytes to send back to the server.
#[derive(Default, Debug, PartialEq, Eq)]
pub struct Parsed {
    pub data: Vec<u8>,
    pub reply: Vec<u8>,
}

pub struct Telnet {
    state: State,
    sub: Vec<u8>,
    /// Options the server does (`him` in RFC 1143) and options we do (`us`).
    remote: [bool; 256],
    local: [bool; 256],
    size: (u16, u16),
}

fn accepts_remote(option: u8) -> bool {
    matches!(option, ECHO | SGA | BINARY)
}
fn accepts_local(option: u8) -> bool {
    matches!(option, TTYPE | NAWS | BINARY)
}

/// Doubles every IAC, as data and subnegotiation values must carry it.
fn escape_into(out: &mut Vec<u8>, bytes: &[u8]) {
    for &b in bytes {
        out.push(b);
        if b == IAC {
            out.push(IAC);
        }
    }
}

impl Telnet {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            state: State::Data,
            sub: Vec::new(),
            remote: [false; 256],
            local: [false; 256],
            size: (cols, rows),
        }
    }

    /// The server sends binary, so a CR is data like any other byte.
    fn binary_in(&self) -> bool {
        self.remote[BINARY as usize]
    }

    pub fn feed(&mut self, bytes: &[u8]) -> Parsed {
        let mut out = Parsed::default();
        for &b in bytes {
            self.state = match self.state {
                State::Data | State::Cr if b == IAC => State::Iac,
                State::Cr if b == 0 => State::Data,
                State::Data | State::Cr => {
                    out.data.push(b);
                    if b == b'\r' && !self.binary_in() {
                        State::Cr
                    } else {
                        State::Data
                    }
                }
                State::Iac => match b {
                    IAC => {
                        out.data.push(IAC);
                        State::Data
                    }
                    DO | DONT | WILL | WONT => State::Command(b),
                    SB => {
                        self.sub.clear();
                        State::Sub
                    }
                    // NOP, GA, data mark and the rest carry nothing for a screen.
                    _ => State::Data,
                },
                State::Command(command) => {
                    self.negotiate(command, b, &mut out.reply);
                    State::Data
                }
                State::Sub if b == IAC => State::SubIac,
                State::Sub => {
                    if self.sub.len() < MAX_SB {
                        self.sub.push(b);
                    }
                    State::Sub
                }
                State::SubIac => match b {
                    SE => {
                        self.subnegotiation(&mut out.reply);
                        State::Data
                    }
                    IAC => {
                        if self.sub.len() < MAX_SB {
                            self.sub.push(IAC);
                        }
                        State::Sub
                    }
                    // A broken subnegotiation ends here; the byte is a command after IAC.
                    _ => State::Data,
                },
            };
        }
        out
    }

    fn negotiate(&mut self, command: u8, option: u8, reply: &mut Vec<u8>) {
        let index = option as usize;
        // Each answer changes the option's state; a request for the state it is in gets none.
        match command {
            WILL if self.remote[index] => {}
            WILL if accepts_remote(option) => {
                self.remote[index] = true;
                reply.extend_from_slice(&[IAC, DO, option]);
            }
            WILL => reply.extend_from_slice(&[IAC, DONT, option]),
            WONT if self.remote[index] => {
                self.remote[index] = false;
                reply.extend_from_slice(&[IAC, DONT, option]);
            }
            DO if self.local[index] => {}
            DO if accepts_local(option) => {
                self.local[index] = true;
                reply.extend_from_slice(&[IAC, WILL, option]);
                if option == NAWS {
                    self.naws_into(reply);
                }
            }
            DO => reply.extend_from_slice(&[IAC, WONT, option]),
            DONT if self.local[index] => {
                self.local[index] = false;
                reply.extend_from_slice(&[IAC, WONT, option]);
            }
            _ => {}
        }
    }

    fn subnegotiation(&mut self, reply: &mut Vec<u8>) {
        if self.sub.as_slice() == [TTYPE, TTYPE_SEND] && self.local[TTYPE as usize] {
            reply.extend_from_slice(&[IAC, SB, TTYPE, TTYPE_IS]);
            reply.extend_from_slice(TERMINAL_TYPE);
            reply.extend_from_slice(&[IAC, SE]);
        }
        self.sub.clear();
    }

    fn naws_into(&self, out: &mut Vec<u8>) {
        let (cols, rows) = self.size;
        out.extend_from_slice(&[IAC, SB, NAWS]);
        let mut size = Vec::with_capacity(4);
        size.extend_from_slice(&cols.to_be_bytes());
        size.extend_from_slice(&rows.to_be_bytes());
        escape_into(out, &size);
        out.extend_from_slice(&[IAC, SE]);
    }

    /// The window size changed. Returns what to send, which is nothing until the server asked.
    pub fn resize(&mut self, cols: u16, rows: u16) -> Vec<u8> {
        self.size = (cols, rows);
        let mut out = Vec::new();
        if self.local[NAWS as usize] {
            self.naws_into(&mut out);
        }
        out
    }

    /// The user's typing as it goes on the wire: IAC doubled, and a lone CR followed by NUL
    /// unless we send binary (RFC 854: CR must be followed by LF or NUL).
    pub fn encode_input(&self, input: &[u8]) -> Vec<u8> {
        let binary = self.local[BINARY as usize];
        let mut out = Vec::with_capacity(input.len() + 4);
        for (i, &b) in input.iter().enumerate() {
            out.push(b);
            if b == IAC {
                out.push(IAC);
            } else if b == b'\r' && !binary && input.get(i + 1) != Some(&b'\n') {
                out.push(0);
            }
        }
        out
    }

    /// Whether the server said it echoes. Shown nowhere yet; kept for tests and logs.
    #[cfg(test)]
    fn server_echoes(&self) -> bool {
        self.remote[ECHO as usize]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_negotiation_and_answers_what_it_supports() {
        let mut t = Telnet::new(80, 24);
        let p = t.feed(&[
            b'h', IAC, WILL, ECHO, IAC, WILL, SGA, IAC, DO, TTYPE, IAC, DO, NAWS, IAC, DO, 39, IAC,
            WILL, 5, b'i',
        ]);
        assert_eq!(p.data, b"hi");
        assert_eq!(
            p.reply,
            [
                IAC, DO, ECHO, IAC, DO, SGA, IAC, WILL, TTYPE, IAC, WILL, NAWS, IAC, SB, NAWS, 0,
                80, 0, 24, IAC, SE, IAC, WONT, 39, IAC, DONT, 5
            ]
        );
        assert!(t.server_echoes());
    }

    #[test]
    fn repeats_of_a_settled_option_get_no_answer() {
        let mut t = Telnet::new(80, 24);
        t.feed(&[IAC, WILL, ECHO, IAC, DO, NAWS]);
        let p = t.feed(&[IAC, WILL, ECHO, IAC, DO, NAWS]);
        assert!(p.reply.is_empty());
        let p = t.feed(&[IAC, WONT, ECHO, IAC, WONT, ECHO]);
        assert_eq!(p.reply, [IAC, DONT, ECHO]);
    }

    #[test]
    fn sequences_split_across_reads_are_joined() {
        let whole = [
            b'a', IAC, DO, TTYPE, IAC, SB, TTYPE, TTYPE_SEND, IAC, SE, b'b', IAC, IAC, b'c',
        ];
        let mut expected = Telnet::new(80, 24);
        let expected = expected.feed(&whole);
        for split in 0..whole.len() {
            let mut t = Telnet::new(80, 24);
            let mut a = t.feed(&whole[..split]);
            let b = t.feed(&whole[split..]);
            a.data.extend(b.data);
            a.reply.extend(b.reply);
            assert_eq!(a, expected, "split at {split}");
        }
        assert_eq!(expected.data, [b'a', b'b', IAC, b'c']);
        let mut ttype = vec![IAC, WILL, TTYPE, IAC, SB, TTYPE, TTYPE_IS];
        ttype.extend_from_slice(TERMINAL_TYPE);
        ttype.extend_from_slice(&[IAC, SE]);
        assert_eq!(expected.reply, ttype);
    }

    #[test]
    fn a_nul_after_cr_is_padding_unless_binary() {
        let mut t = Telnet::new(80, 24);
        assert_eq!(t.feed(b"a\r").data, b"a\r");
        assert_eq!(t.feed(b"\0b\r\n").data, b"b\r\n");
        t.feed(&[IAC, WILL, BINARY]);
        assert_eq!(t.feed(b"\r\0").data, b"\r\0");
    }

    #[test]
    fn input_doubles_iac_and_pads_a_lone_cr() {
        let mut t = Telnet::new(80, 24);
        assert_eq!(
            t.encode_input(&[b'x', IAC, b'\r']),
            [b'x', IAC, IAC, b'\r', 0]
        );
        assert_eq!(t.encode_input(b"a\r\n"), b"a\r\n");
        t.feed(&[IAC, DO, BINARY]);
        assert_eq!(t.encode_input(b"\r"), b"\r");
    }

    #[test]
    fn window_size_is_sent_once_asked_and_escapes_255() {
        let mut t = Telnet::new(80, 24);
        assert!(t.resize(100, 30).is_empty());
        let p = t.feed(&[IAC, DO, NAWS]);
        assert_eq!(&p.reply[3..], [IAC, SB, NAWS, 0, 100, 0, 30, IAC, SE]);
        assert_eq!(
            t.resize(255, 40),
            [IAC, SB, NAWS, 0, 255, 255, 0, 40, IAC, SE]
        );
    }

    #[test]
    fn an_endless_subnegotiation_is_bounded() {
        let mut t = Telnet::new(80, 24);
        let mut bytes = vec![IAC, SB, TTYPE];
        bytes.extend(std::iter::repeat_n(b'x', 10_000));
        bytes.extend_from_slice(&[IAC, SE, b'o', b'k']);
        let p = t.feed(&bytes);
        assert_eq!(p.data, b"ok");
        assert!(t.sub.capacity() <= 4096);
    }
}
