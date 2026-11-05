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
}
