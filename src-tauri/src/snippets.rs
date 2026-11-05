use crate::{
    AppState,
    ssh::Input,
    storage::{Result, Store},
};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub description: String,
    pub body: String,
    pub group: String,
    pub tags: String,
}
#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Library {
    pub revision: u64,
    pub items: Vec<Snippet>,
}
pub fn read(store: &Store) -> Result<Library> {
    let raw = store.setting("snippets_v1")?;
    if raw == "null" {
        return Ok(Library::default());
    }
    if raw.len() > 1024 * 1024 + 1024 {
        return Err("스니펫 저장 크기 오류 · 원본을 보존했습니다.".into());
    }
    let library: Library =
        serde_json::from_str(&raw).map_err(|_| "스니펫 저장 형식 오류 · 원본을 보존했습니다.")?;
    validate(&library.items)?;
    Ok(library)
}
fn validate(items: &[Snippet]) -> Result<()> {
    if items.len() > 200 {
        return Err("스니펫은 200개까지 저장할 수 있습니다.".into());
    }
    let mut ids = std::collections::HashSet::new();
    for s in items {
        if s.id.is_empty()
            || s.id.len() > 100
            || !ids.insert(&s.id)
            || s.name.trim().is_empty()
            || s.name.len() > 300
            || s.description.len() > 3000
            || s.group.len() > 300
            || s.tags.len() > 1000
            || s.body.trim().is_empty()
            || s.body.len() > 16384
            || s.body.contains("PRIVATE KEY-----")
        {
            return Err("스니펫 필드·크기 오류 · 개인키는 저장할 수 없습니다.".into());
        }
    }
    if serde_json::to_vec(items)
        .map_err(|_| "스니펫 직렬화 오류")?
        .len()
        > 1024 * 1024
    {
        return Err("스니펫 전체 크기는 1MiB 이하여야 합니다.".into());
    }
    Ok(())
}
pub fn save(store: &Store, revision: u64, items: Vec<Snippet>) -> Result<Library> {
    validate(&items)?;
    if read(store)?.revision != revision {
        return Err("다른 창에서 변경되었습니다. 다시 불러온 뒤 수정하세요.".into());
    }
    let next = Library {
        revision: revision.checked_add(1).ok_or("스니펫 버전 상한")?,
        items,
    };
    store.set_setting(
        "snippets_v1",
        &serde_json::to_string(&next).map_err(|_| "스니펫 저장 오류")?,
    )?;
    Ok(next)
}
#[tauri::command]
pub fn snippet_list(state: State<AppState>) -> Result<Library> {
    read(&state.store)
}
#[tauri::command]
pub fn snippet_save(state: State<AppState>, revision: u64, items: Vec<Snippet>) -> Result<Library> {
    let _guard = state.mutation.lock().unwrap();
    save(&state.store, revision, items)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub id: String,
    pub bracketed: bool,
}
#[derive(Serialize)]
pub struct Delivery {
    pub id: String,
    pub error: Option<String>,
}
pub fn payload(body: &str, execute: bool, bracketed: bool) -> Result<String> {
    if body.is_empty()
        || body.len() > 16384
        || body
            .chars()
            .any(|c| c.is_control() && !['\t', '\n', '\r'].contains(&c))
    {
        return Err("명령은 16KiB 이하이며 Tab·줄바꿈 이외 제어문자는 보낼 수 없습니다.".into());
    }
    let body = body.replace("\r\n", "\n").replace('\n', "\r");
    let mut data = if bracketed {
        format!("\x1b[200~{body}\x1b[201~")
    } else {
        body
    };
    if execute {
        data.push('\r');
    }
    Ok(data)
}
// A separate dispatch path deliberately never consults the broadcast group.
// IDs are the immutable connections reviewed by the user, not profile/tab IDs.
#[tauri::command]
pub fn snippet_send(
    state: State<AppState>,
    window: tauri::Window,
    targets: Vec<Target>,
    body: String,
    execute: bool,
) -> Result<Vec<Delivery>> {
    if targets.is_empty() || targets.len() > 32 {
        return Err("대상은 1~32개를 선택하세요.".into());
    }
    let mut ids = std::collections::HashSet::new();
    if targets.iter().any(|t| !ids.insert(&t.id)) {
        return Err("대상 연결이 중복되었습니다.".into());
    }
    payload(&body, execute, false)?;
    Ok(targets
        .into_iter()
        .map(|t| {
            let send = || -> Result<()> {
                let data = payload(&body, execute, t.bracketed)?;
                let (queue, bytes) = if let Ok(c) = state.locals.control(&t.id) {
                    if window.label() != "main" || !c.ready() {
                        return Err("로컬 연결이 종료되었거나 다른 창 소유입니다.".into());
                    }
                    (c.input.clone(), data.into_bytes())
                } else {
                    state.connections.handle(&t.id)?;
                    let c = state.connections.control(&t.id)?;
                    c.broker.check(window.label())?;
                    (
                        c.input.clone(),
                        crate::encoding::encode(&data, &c.profile.encoding)?,
                    )
                };
                queue
                    .try_send(Input::Data(bytes))
                    .map_err(|_| "입력 대기열이 가득 찼거나 연결이 종료되었습니다.".into())
            };
            Delivery {
                id: t.id.clone(),
                error: send().err(),
            }
        })
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn item() -> Snippet {
        Snippet {
            id: "a".into(),
            name: "한글".into(),
            description: "".into(),
            group: "".into(),
            tags: "".into(),
            body: "printf '{{name}}'".into(),
        }
    }
    #[test]
    fn persistence_conflict_and_invalid_write_preserve_original() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        {
            let store = Store::open(&path).unwrap();
            save(&store, 0, vec![item()]).unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(read(&store).unwrap().items[0].name, "한글");
        assert!(save(&store, 0, vec![]).is_err());
        assert!(save(&store, 1, vec![item(), item()]).is_err());
        assert_eq!(read(&store).unwrap().items.len(), 1);
        save(&store, 1, vec![]).unwrap();
        assert!(read(&store).unwrap().items.is_empty());
    }
    #[test]
    fn paste_is_literal_bounded_and_enter_is_explicit() {
        assert_eq!(payload("echo 한글", false, false).unwrap(), "echo 한글");
        assert_eq!(
            payload("a\r\nb", true, true).unwrap(),
            "\x1b[200~a\rb\x1b[201~\r"
        );
        assert!(payload("\x1b[201~danger", false, true).is_err());
        assert!(payload(&"a".repeat(16385), true, false).is_err());
        let mut secret = item();
        secret.body = "-----BEGIN OPENSSH PRIVATE KEY-----".into();
        assert!(validate(&[secret]).is_err());
    }
}
