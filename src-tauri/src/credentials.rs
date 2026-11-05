use crate::storage::Result;
use zeroize::Zeroizing;
fn entry(id: &str) -> Result<keyring::Entry> {
    keyring::Entry::new("app.daxterm.desktop", id)
        .map_err(|_| "OS 보안 저장소를 사용할 수 없습니다. 저장 없이 연결할 수 있습니다.".into())
}
pub fn get(id: &str) -> Result<Zeroizing<String>> {
    entry(id)?
        .get_password()
        .map(Zeroizing::new)
        .map_err(|_| "저장된 인증정보를 읽을 수 없습니다. 다시 입력하세요.".into())
}
pub fn set(id: &str, value: &str) -> Result<()> {
    entry(id)?
        .set_password(value)
        .map_err(|_| "OS 보안 저장소 저장 실패. 비밀정보는 파일에 저장되지 않았습니다.".into())
}
pub fn delete(id: &str) -> Result<()> {
    match entry(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("OS 보안 저장소 삭제 실패. 다시 시도하세요.".into()),
    }
}
