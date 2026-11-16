//! Finds where a file transfer starts in terminal output (CG.8). The marks are bytes a server
//! program prints (CG.0): `sz` sends ZRQINIT `**\x18B00`, `rz` sends ZRINIT `**\x18B01`, and
//! `tsz`/`trz` print `ESC 7 ::TRZSZ:TRANSFER:<S|R|D>:<version>:<id>[:<port>]` on a line of its
//! own. ZMODEM headers carry 8-bit bytes, so this runs on the raw output before any decoding.

/// What starts, and in which direction for this app.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Start {
    /// `sz`: the server sends, this app receives.
    ZmodemDownload,
    /// `rz`: the server receives, this app sends.
    ZmodemUpload,
    /// `tsz`.
    TrzszDownload,
    /// `trz`.
    TrzszUpload,
    /// `trz -d`: directories, which this app does not send.
    TrzszDirectory,
}

const ZRQINIT: &[u8] = b"**\x18B00";
const ZRINIT: &[u8] = b"**\x18B01";
const TRZSZ: &[u8] = b"\x1b7::TRZSZ:TRANSFER:";
/// A trzsz start line is short; anything longer is ordinary output that happens to match.
const MAX_TRZSZ_LINE: usize = 128;

/// What one chunk of output holds.
#[derive(Debug, PartialEq, Eq)]
pub enum Found {
    /// Output for the screen. Some bytes may be held back while they could begin a mark.
    Output(Vec<u8>),
    /// A transfer starts: the output before the mark, and what came after it, which belongs to
    /// the transfer.
    Start {
        before: Vec<u8>,
        start: Start,
        after: Vec<u8>,
    },
}

#[derive(Default)]
pub struct Detector {
    held: Vec<u8>,
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// How many bytes at the end could be the beginning of `mark`.
fn partial(data: &[u8], mark: &[u8]) -> usize {
    (1..mark.len().min(data.len() + 1))
        .rev()
        .find(|&n| data.ends_with(&mark[..n]))
        .unwrap_or(0)
}

fn trzsz_mode(line: &[u8]) -> Option<Start> {
    // `S:1.1.7:1234567890123[:port]`: a mode letter, a version and a 13-digit ID.
    let text = std::str::from_utf8(line).ok()?;
    let mut parts = text.trim_end_matches(['\r', '\n']).split(':');
    let mode = parts.next()?;
    let version = parts.next()?;
    let id = parts.next()?;
    if version.is_empty()
        || !version.chars().all(|c| c.is_ascii_digit() || c == '.')
        || id.len() != 13
        || !id.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    match mode {
        "S" => Some(Start::TrzszDownload),
        "R" => Some(Start::TrzszUpload),
        "D" => Some(Start::TrzszDirectory),
        _ => None,
    }
}

impl Detector {
    /// Bytes held back because they could begin a mark. Shown when no more output follows soon.
    pub fn flush(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.held)
    }

    pub fn holding(&self) -> bool {
        !self.held.is_empty()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Found {
        let mut data = std::mem::take(&mut self.held);
        data.extend_from_slice(chunk);
        let zmodem = [ZRQINIT, ZRINIT]
            .iter()
            .filter_map(|mark| find(&data, mark).map(|at| (at, *mark)))
            .min_by_key(|(at, _)| *at);
        let trzsz = find(&data, TRZSZ);
        match (zmodem, trzsz) {
            (Some((at, mark)), t) if t.is_none_or(|t| at < t) => {
                let start = if mark == ZRQINIT {
                    Start::ZmodemDownload
                } else {
                    Start::ZmodemUpload
                };
                // The header itself is the transfer's first input.
                let after = data.split_off(at);
                return Found::Start {
                    before: data,
                    start,
                    after,
                };
            }
            (_, Some(at)) => {
                let rest = &data[at + TRZSZ.len()..];
                match rest.iter().position(|&b| b == b'\n') {
                    Some(end) => {
                        if let Some(start) = trzsz_mode(&rest[..end]) {
                            let after = rest[end + 1..].to_vec();
                            data.truncate(at);
                            return Found::Start {
                                before: data,
                                start,
                                after,
                            };
                        }
                        // Not a start line after all: show it, and look on after it.
                        let rest = data.split_off(at + 1);
                        return match self.push(&rest) {
                            Found::Output(more) => {
                                data.extend(more);
                                Found::Output(data)
                            }
                            Found::Start {
                                before,
                                start,
                                after,
                            } => {
                                data.extend(before);
                                Found::Start {
                                    before: data,
                                    start,
                                    after,
                                }
                            }
                        };
                    }
                    None if data.len() - at <= MAX_TRZSZ_LINE => {
                        self.held = data.split_off(at);
                        return Found::Output(data);
                    }
                    None => {}
                }
            }
            _ => {}
        }
        let keep = [ZRQINIT, TRZSZ]
            .iter()
            .map(|mark| partial(&data, mark))
            .max()
            .unwrap_or(0);
        self.held = data.split_off(data.len() - keep);
        Found::Output(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all_output(d: &mut Detector, chunks: &[&[u8]]) -> Vec<u8> {
        let mut out = Vec::new();
        for c in chunks {
            match d.push(c) {
                Found::Output(b) => out.extend(b),
                other => panic!("unexpected {other:?}"),
            }
        }
        out.extend(d.flush());
        out
    }

    #[test]
    fn plain_output_passes_unchanged_even_with_look_alikes() {
        let mut d = Detector::default();
        let text: &[u8] = b"ls **\x18 ok\x1b7 saved\x1b8 *B00 ::TRZSZ: hi\r\n";
        assert_eq!(all_output(&mut d, &[text]), text);
    }

    #[test]
    fn finds_sz_and_rz_however_the_output_is_split() {
        let stream: Vec<u8> = [
            b"rz waiting\r\n".as_slice(),
            b"**\x18B0100000023be50\r\x8a\x11",
        ]
        .concat();
        for split in 0..stream.len() {
            let mut d = Detector::default();
            let mut before = Vec::new();
            let mut found = None;
            for chunk in [&stream[..split], &stream[split..]] {
                match d.push(chunk) {
                    Found::Output(b) => before.extend(b),
                    Found::Start {
                        before: b,
                        start,
                        after,
                    } => {
                        before.extend(b);
                        found = Some((start, after));
                        break;
                    }
                }
            }
            let (start, after) = found.unwrap_or_else(|| panic!("no start at {split}"));
            assert_eq!(start, Start::ZmodemUpload, "{split}");
            assert_eq!(before, b"rz waiting\r\n", "{split}");
            assert!(after.starts_with(b"**\x18B01"), "{split}");
        }
        let mut d = Detector::default();
        assert!(matches!(
            d.push(b"**\x18B00000000000000\r\x8a\x11"),
            Found::Start {
                start: Start::ZmodemDownload,
                ..
            }
        ));
    }

    #[test]
    fn finds_a_trzsz_line_split_anywhere_and_keeps_what_follows() {
        let stream: &[u8] = b"$ tsz a\r\n\x1b7::TRZSZ:TRANSFER:S:1.1.7:1763276400000:0\r\n#CFG:x";
        for split in 0..stream.len() {
            let mut d = Detector::default();
            let mut before = Vec::new();
            let mut found: Option<(Start, Vec<u8>)> = None;
            for chunk in [&stream[..split], &stream[split..]] {
                // Once a transfer starts, the rest of the output is the transfer's.
                if let Some((_, after)) = &mut found {
                    after.extend_from_slice(chunk);
                    continue;
                }
                match d.push(chunk) {
                    Found::Output(b) => before.extend(b),
                    Found::Start {
                        before: b,
                        start,
                        after,
                    } => {
                        before.extend(b);
                        found = Some((start, after));
                    }
                }
            }
            let (start, after) = found.unwrap_or_else(|| panic!("no start at {split}"));
            assert_eq!(
                (start, after.as_slice()),
                (Start::TrzszDownload, b"#CFG:x".as_slice())
            );
            assert_eq!(before, b"$ tsz a\r\n");
        }
        for (mode, start) in [("R", Start::TrzszUpload), ("D", Start::TrzszDirectory)] {
            let mut d = Detector::default();
            let line = format!("\x1b7::TRZSZ:TRANSFER:{mode}:1.1.7:1763276400020\r\n");
            assert!(matches!(d.push(line.as_bytes()), Found::Start { start: s, .. } if s == start));
        }
    }

    #[test]
    fn a_line_that_only_looks_like_trzsz_is_shown() {
        let mut d = Detector::default();
        let text: &[u8] = b"\x1b7::TRZSZ:TRANSFER:S:x:1\r\nnext\r\n";
        assert_eq!(all_output(&mut d, &[text]), text);
        let mut d = Detector::default();
        let long = [b"\x1b7::TRZSZ:TRANSFER:".as_slice(), &[b'9'; 200]].concat();
        assert_eq!(all_output(&mut d, &[&long]), long);
    }

    #[test]
    fn holds_only_what_could_begin_a_mark() {
        let mut d = Detector::default();
        assert_eq!(d.push(b"prompt $ *"), Found::Output(b"prompt $ ".to_vec()));
        assert!(d.holding());
        assert_eq!(d.flush(), b"*");
        assert_eq!(d.push(b"done\x1b"), Found::Output(b"done".to_vec()));
        assert_eq!(d.push(b"[0m"), Found::Output(b"\x1b[0m".to_vec()));
    }
}
