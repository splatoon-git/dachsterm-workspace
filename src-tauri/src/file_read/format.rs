//! Telling what a file is from its name and first bytes, and turning its bytes into text. Nothing
//! here touches a connection, so every format decision can be tested on plain bytes.
use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Text,
    Image(&'static str),
    Binary(&'static str),
}

const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";
const UTF16LE_BOM: &[u8] = b"\xFF\xFE";
const UTF16BE_BOM: &[u8] = b"\xFE\xFF";

const IMAGES: &[(&[u8], &str)] = &[
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xFF\xD8\xFF", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
];
/// Formats that are binary even when the first bytes happen to hold no NUL.
const BINARIES: &[(&[u8], &str)] = &[
    (b"%PDF-", "PDF 문서"),
    (b"PK\x03\x04", "ZIP 압축"),
    (b"\x1f\x8b", "GZIP 압축"),
    (b"7z\xBC\xAF\x27\x1C", "7-Zip 압축"),
    (b"Rar!\x1a\x07", "RAR 압축"),
    (b"\x7fELF", "ELF 실행 파일"),
    (b"BM", "BMP 이미지"),
    (b"\x00\x00\x01\x00", "ICO 아이콘"),
    (b"MZ", "Windows 실행 파일"),
];

fn is_webp(head: &[u8]) -> bool {
    head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WEBP"
}
fn has_extension(name: &str, extension: &str) -> bool {
    name.rsplit_once('.')
        .is_some_and(|(_, found)| found.eq_ignore_ascii_case(extension))
}

/// Magic numbers come before the name, so a misnamed PNG still shows as a picture. `BM` and `MZ` are
/// also how ordinary text can begin, so those two count only with a NUL in the first bytes.
pub fn classify(name: &str, head: &[u8]) -> Kind {
    if let Some((_, mime)) = IMAGES.iter().find(|(magic, _)| head.starts_with(magic)) {
        return Kind::Image(mime);
    }
    if is_webp(head) {
        return Kind::Image("image/webp");
    }
    if [UTF8_BOM, UTF16LE_BOM, UTF16BE_BOM]
        .iter()
        .any(|bom| head.starts_with(bom))
    {
        return if has_extension(name, "svg") {
            Kind::Image("image/svg+xml")
        } else {
            Kind::Text
        };
    }
    let has_nul = head.contains(&0);
    let binary = BINARIES.iter().find(|(magic, _)| head.starts_with(magic));
    match binary {
        Some((magic, format)) if has_nul || !matches!(*magic, b"BM" | b"MZ") => {
            return Kind::Binary(format);
        }
        _ => {}
    }
    if has_nul {
        return Kind::Binary("바이너리");
    }
    if has_extension(name, "svg") {
        return Kind::Image("image/svg+xml");
    }
    Kind::Text
}

#[derive(Debug, PartialEq, Eq)]
pub struct Decoded {
    pub text: String,
    pub encoding: String,
    /// Some bytes were not valid, so the text holds replacement characters. Saving it would
    /// destroy those bytes.
    pub lossy: bool,
}

fn decoded(encoding: &'static Encoding, label: &str, bytes: &[u8]) -> Decoded {
    let (text, lossy) = encoding.decode_without_bom_handling(bytes);
    Decoded {
        text: text.into_owned(),
        encoding: label.into(),
        lossy,
    }
}

/// Text that would not save back to the same bytes counts as lossy: the tab must not let it be edited.
pub fn decode(
    bytes: &[u8],
    chosen: Option<(&'static Encoding, &str)>,
    fallback: (&'static Encoding, &str),
) -> Decoded {
    let mut result = decode_with(bytes, chosen, fallback);
    result.lossy =
        result.lossy || !crate::encoding::encodes_back(&result.text, &result.encoding, bytes);
    result
}

/// `chosen` is the user's pick and is applied as is. Otherwise a byte order mark settles it, and
/// without one the connection's encoding does: UTF-8 for SFTP and local files, the session's for FTP.
fn decode_with(
    bytes: &[u8],
    chosen: Option<(&'static Encoding, &str)>,
    fallback: (&'static Encoding, &str),
) -> Decoded {
    if let Some((encoding, label)) = chosen {
        return decoded(encoding, label, bytes);
    }
    if let Some(rest) = bytes.strip_prefix(UTF8_BOM) {
        return decoded(UTF_8, "utf-8-bom", rest);
    }
    if let Some(rest) = bytes.strip_prefix(UTF16LE_BOM) {
        return decoded(UTF_16LE, "utf-16le", rest);
    }
    if let Some(rest) = bytes.strip_prefix(UTF16BE_BOM) {
        return decoded(UTF_16BE, "utf-16be", rest);
    }
    decoded(fallback.0, fallback.1, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use encoding_rs::{EUC_KR, SHIFT_JIS};

    const UTF: (&Encoding, &str) = (UTF_8, "utf-8");

    #[test]
    fn pictures_are_known_by_their_first_bytes_whatever_the_name() {
        assert_eq!(
            classify("a.dat", b"\x89PNG\r\n\x1a\nrest"),
            Kind::Image("image/png")
        );
        assert_eq!(
            classify("a", b"\xFF\xD8\xFF\xE0"),
            Kind::Image("image/jpeg")
        );
        assert_eq!(classify("a", b"GIF89a.."), Kind::Image("image/gif"));
        assert_eq!(
            classify("a", b"RIFF\0\0\0\0WEBPVP8 "),
            Kind::Image("image/webp")
        );
    }

    #[test]
    fn svg_needs_its_extension_because_it_is_text_inside() {
        let svg = b"<svg xmlns='http://www.w3.org/2000/svg'/>";
        assert_eq!(classify("a.SVG", svg), Kind::Image("image/svg+xml"));
        assert_eq!(classify("a.xml", svg), Kind::Text);
        assert_eq!(
            classify("a.svg", b"\xEF\xBB\xBF<svg/>"),
            Kind::Image("image/svg+xml")
        );
    }

    #[test]
    fn known_formats_and_nul_bytes_are_binary() {
        assert_eq!(classify("a.pdf", b"%PDF-1.7\n"), Kind::Binary("PDF 문서"));
        assert_eq!(classify("a.txt", b"PK\x03\x04"), Kind::Binary("ZIP 압축"));
        assert_eq!(
            classify("a.exe", b"MZ\x90\x00"),
            Kind::Binary("Windows 실행 파일")
        );
        assert_eq!(classify("a.txt", b"abc\0def"), Kind::Binary("바이너리"));
    }

    #[test]
    fn text_that_begins_like_a_binary_format_stays_text() {
        assert_eq!(classify("names.txt", b"MZ is a postcode\n"), Kind::Text);
        assert_eq!(classify("notes.txt", b"BMW\n"), Kind::Text);
    }

    #[test]
    fn utf16_is_text_despite_its_nul_bytes() {
        assert_eq!(classify("a.txt", b"\xFF\xFEa\0b\0"), Kind::Text);
        assert_eq!(classify("a.txt", b"\xFE\xFF\0a\0b"), Kind::Text);
        assert_eq!(classify("a.txt", b""), Kind::Text);
    }

    #[test]
    fn a_byte_order_mark_settles_the_encoding_and_is_left_out_of_the_text() {
        let plain = decode(b"\xEF\xBB\xBFhi", None, UTF);
        assert_eq!((plain.text.as_str(), plain.lossy), ("hi", false));
        assert_eq!(plain.encoding, "utf-8-bom");
        let little = decode(b"\xFF\xFE\x5C\xD5", None, UTF);
        assert_eq!(
            (little.text.as_str(), little.encoding.as_str()),
            ("한", "utf-16le")
        );
        let big = decode(b"\xFE\xFF\xD5\x5C", None, UTF);
        assert_eq!(
            (big.text.as_str(), big.encoding.as_str()),
            ("한", "utf-16be")
        );
    }

    #[test]
    fn invalid_utf8_is_reported_instead_of_hidden() {
        let result = decode(b"ok \xC7\xD1", None, UTF);
        assert!(result.lossy);
        assert!(result.text.contains('\u{FFFD}'));
        assert!(!decode("한글".as_bytes(), None, UTF).lossy);
    }

    #[test]
    fn an_ftp_session_encoding_reads_its_own_bytes() {
        let (bytes, _, _) = EUC_KR.encode("한글");
        let result = decode(&bytes, None, (EUC_KR, "euc-kr"));
        assert_eq!(
            (result.text.as_str(), result.encoding.as_str(), result.lossy),
            ("한글", "euc-kr", false)
        );
    }

    #[test]
    fn bytes_that_would_not_save_back_the_same_count_as_lossy() {
        // Valid Shift_JIS, but a save would write the character's other byte sequence.
        let result = decode(&[0xFA, 0x54], Some((SHIFT_JIS, "shift_jis")), UTF);
        assert!(result.lossy);
        assert!(!decode("한글".as_bytes(), None, UTF).lossy);
        assert!(!decode(b"\xFF\xFEa\0", None, UTF).lossy);
        assert!(!decode(b"\xEF\xBB\xBFa", None, UTF).lossy);
    }

    #[test]
    fn the_users_choice_wins_over_a_byte_order_mark_and_the_fallback() {
        let (bytes, _, _) = EUC_KR.encode("한글");
        let result = decode(&bytes, Some((EUC_KR, "euc-kr")), UTF);
        assert_eq!((result.text.as_str(), result.lossy), ("한글", false));
        let bom = decode(b"\xEF\xBB\xBFa", Some((UTF_8, "utf-8")), UTF);
        assert_eq!(bom.text, "\u{FEFF}a");
    }
}
