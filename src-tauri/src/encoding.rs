use crate::storage::Result;
pub fn default_encoding() -> String {
    "utf-8".into()
}
pub fn get(label: &str) -> Result<&'static encoding_rs::Encoding> {
    match label {
        "utf-8" => Ok(encoding_rs::UTF_8),
        "euc-kr" => Ok(encoding_rs::EUC_KR),
        "shift_jis" => Ok(encoding_rs::SHIFT_JIS),
        "gbk" => Ok(encoding_rs::GBK),
        "big5" => Ok(encoding_rs::BIG5),
        "windows-1252" => Ok(encoding_rs::WINDOWS_1252),
        _ => Err("지원하지 않는 인코딩입니다.".into()),
    }
}
pub fn encode(text: &str, label: &str) -> Result<Vec<u8>> {
    let (bytes, _, errors) = get(label)?.encode(text);
    if errors {
        return Err(
            "선택한 인코딩으로 표현할 수 없는 문자가 있습니다. 전송하지 않았습니다.".into(),
        );
    }
    Ok(bytes.into_owned())
}
/// The bytes for a file read under `label`, which may also name a byte order mark (`file_read`).
/// `encoding_rs` has no UTF-16 encoder, since browsers never send it.
pub fn encode_text(text: &str, label: &str) -> Result<Vec<u8>> {
    let utf16 = |bom: [u8; 2], unit: fn(u16) -> [u8; 2]| {
        let units = text.encode_utf16().flat_map(unit);
        bom.into_iter().chain(units).collect()
    };
    match label {
        "utf-8-bom" => Ok([b"\xEF\xBB\xBF", text.as_bytes()].concat()),
        "utf-16le" => Ok(utf16([0xFF, 0xFE], u16::to_le_bytes)),
        "utf-16be" => Ok(utf16([0xFE, 0xFF], u16::to_be_bytes)),
        _ => {
            let (bytes, _, errors) = get(label)?.encode(text);
            if errors {
                return Err(
                    "이 인코딩으로 쓸 수 없는 문자가 있어 저장하지 않았습니다. 해당 문자를 고치거나 상태바에서 인코딩을 바꾸세요."
                        .into(),
                );
            }
            Ok(bytes.into_owned())
        }
    }
}
/// Whether saving `text` under `label` gives `bytes` back. Some encodings read two byte sequences as
/// one character and can only write one of them, so a save would change lines nobody edited.
pub fn encodes_back(text: &str, label: &str, bytes: &[u8]) -> bool {
    encode_text(text, label).is_ok_and(|encoded| encoded == bytes)
}
pub fn to_local(bytes: &[u8], label: &str) -> Result<Vec<u8>> {
    if label == "original" {
        return Ok(bytes.to_vec());
    }
    let (text, errors) = get(label)?.decode_without_bom_handling(bytes);
    if errors {
        return Err(
            "파일 내용이 선택한 인코딩과 일치하지 않습니다. 인코딩을 다시 선택하세요.".into(),
        );
    }
    Ok(text.into_owned().into_bytes())
}
pub fn to_remote(bytes: &[u8], label: &str) -> Result<Vec<u8>> {
    if label == "original" {
        return Ok(bytes.to_vec());
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "로컬 편집 파일은 UTF-8로 저장하세요. 수정본은 보존됩니다.")?;
    encode(text, label)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_roundtrip_and_fail_closed() {
        for (label, text) in [
            ("utf-8", "한글 😀\r\n"),
            ("euc-kr", "한글 똠방각하\r\n"),
            ("shift_jis", "日本語\n"),
            ("gbk", "中文\n"),
        ] {
            let remote = encode(text, label).unwrap();
            assert_eq!(to_local(&remote, label).unwrap(), text.as_bytes());
            assert_eq!(to_remote(text.as_bytes(), label).unwrap(), remote);
        }
        assert!(encode("😀", "euc-kr").is_err());
        assert!(to_local(&[0xff], "utf-8").is_err());
        assert_eq!(
            to_remote(&[0, 255, 13, 10], "original").unwrap(),
            [0, 255, 13, 10]
        );
    }
    #[test]
    fn text_saves_back_under_the_label_it_was_read_with() {
        assert_eq!(
            encode_text("a한", "utf-8-bom").unwrap(),
            b"\xEF\xBB\xBFa\xED\x95\x9C"
        );
        assert_eq!(encode_text("한", "utf-16le").unwrap(), b"\xFF\xFE\x5C\xD5");
        assert_eq!(encode_text("한", "utf-16be").unwrap(), b"\xFE\xFF\xD5\x5C");
        assert_eq!(encode_text("😀", "utf-16le").unwrap().len(), 6);
        assert_eq!(
            encode_text("한글", "euc-kr").unwrap(),
            [0xC7, 0xD1, 0xB1, 0xDB]
        );
    }
    #[test]
    fn a_character_the_encoding_cannot_hold_stops_the_save() {
        let error = encode_text("한😀", "euc-kr").unwrap_err();
        assert!(error.contains("저장하지 않았습니다"));
        assert!(encode_text("x", "no-such").is_err());
    }
    #[test]
    fn only_bytes_that_come_back_the_same_count_as_saveable() {
        assert!(encodes_back("한글", "euc-kr", &[0xC7, 0xD1, 0xB1, 0xDB]));
        // Shift_JIS reads both of these as the same character and writes only the first.
        let (text, _) = encoding_rs::SHIFT_JIS.decode_without_bom_handling(&[0xFA, 0x54]);
        assert!(!encodes_back(&text, "shift_jis", &[0xFA, 0x54]));
    }
}
