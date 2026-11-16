//! Terminal highlight and trigger rules (CG.7). The rules live in the app's `settings` table so
//! every window reads the same list. Matching runs in the web view: this module only stores and
//! checks what may be saved, above all that no rule can type into a password prompt.
use crate::{
    AppState,
    storage::{Result, Store},
};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};

const KEY: &str = "highlight_rules_v1";
pub const MAX_RULES: usize = 64;
const MAX_PATTERN: usize = 512;
const MAX_SEND: usize = 1024;
/// Every window reloads its rules when this is emitted.
pub const CHANGED_EVENT: &str = "highlight-rules";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Color {
    Danger,
    Warning,
    Success,
    Info,
    Accent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Scope {
    All,
    Tags { tags: Vec<String> },
    Sessions { ids: Vec<String> },
}

/// Text typed when the rule matches. `confirmed_at` records when the user accepted the warning.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Send {
    pub text: String,
    pub confirmed_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    pub name: String,
    pub pattern: String,
    pub ignore_case: bool,
    pub scope: Scope,
    pub color: Option<Color>,
    pub notify: bool,
    pub send: Option<Send>,
    pub enabled: bool,
}

#[derive(Default, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Library {
    pub revision: u64,
    pub items: Vec<Rule>,
}

/// Words of a password prompt. The web view also runs the pattern against sample prompts; this
/// side cannot run a JavaScript expression, so it refuses the words themselves.
const SECRET_WORDS: [&str; 6] = ["ssword", "asswd", "passphrase", "암호", "비밀번호", "비번"];

/// The pattern's letters without the expression's own characters, so `pass(word)?` and `p.ssw`
/// still read as the word.
fn mentions_secret(pattern: &str) -> bool {
    let letters: String = pattern
        .to_lowercase()
        .chars()
        .filter(|c| !"[](){}?*+|\\^$.".contains(*c))
        .collect();
    SECRET_WORDS.iter().any(|w| letters.contains(w))
}

fn validate_rule(rule: &Rule) -> Result<()> {
    let name = rule.name.trim();
    if rule.id.is_empty() || rule.id.len() > 100 {
        return Err("하이라이트 규칙 ID 형식 오류".into());
    }
    if name.is_empty() || name.chars().count() > 100 {
        return Err("규칙 이름은 1~100자로 입력하세요.".into());
    }
    if rule.pattern.is_empty() || rule.pattern.chars().count() > MAX_PATTERN {
        return Err(format!("{name}: 패턴은 1~{MAX_PATTERN}자로 입력하세요."));
    }
    match &rule.scope {
        Scope::All => {}
        Scope::Tags { tags } => {
            if tags.is_empty()
                || tags.len() > 32
                || tags.iter().any(|t| t.trim().is_empty() || t.len() > 100)
            {
                return Err(format!("{name}: 태그는 1~32개를 지정하세요."));
            }
        }
        Scope::Sessions { ids } => {
            if ids.is_empty()
                || ids.len() > 256
                || ids.iter().any(|i| i.is_empty() || i.len() > 100)
            {
                return Err(format!("{name}: 세션은 1~256개를 지정하세요."));
            }
        }
    }
    if rule.color.is_none() && !rule.notify && rule.send.is_none() {
        return Err(format!(
            "{name}: 색, 알림, 입력 보내기 중 하나는 켜야 합니다."
        ));
    }
    if let Some(send) = &rule.send {
        if mentions_secret(&rule.pattern) {
            return Err(format!(
                "{name}: 암호를 묻는 줄과 일치하는 규칙에는 입력 보내기를 켤 수 없습니다."
            ));
        }
        if send.confirmed_at == 0 {
            return Err(format!(
                "{name}: 입력 보내기는 확인한 뒤에만 켤 수 있습니다."
            ));
        }
        if send.text.is_empty()
            || send.text.len() > MAX_SEND
            || send.text.contains("PRIVATE KEY-----")
            || send
                .text
                .chars()
                .any(|c| c.is_control() && !['\t', '\n', '\r'].contains(&c))
        {
            return Err(format!(
                "{name}: 보낼 입력은 1KiB 이하이며 Tab·줄바꿈 이외 제어문자는 넣을 수 없습니다."
            ));
        }
    }
    Ok(())
}

fn validate(items: &[Rule]) -> Result<()> {
    if items.len() > MAX_RULES {
        return Err(format!(
            "하이라이트 규칙은 {MAX_RULES}개까지 저장할 수 있습니다."
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for rule in items {
        validate_rule(rule)?;
        if !ids.insert(&rule.id) {
            return Err("하이라이트 규칙 ID가 중복되었습니다.".into());
        }
    }
    Ok(())
}

pub fn read(store: &Store) -> Result<Library> {
    let raw = store.setting(KEY)?;
    if raw == "null" {
        return Ok(Library::default());
    }
    let library: Library = serde_json::from_str(&raw)
        .map_err(|_| "하이라이트 규칙 저장 형식 오류 · 원본을 보존했습니다.")?;
    validate(&library.items)?;
    Ok(library)
}

pub fn save(store: &Store, revision: u64, items: Vec<Rule>) -> Result<Library> {
    validate(&items)?;
    if read(store)?.revision != revision {
        return Err("다른 창에서 규칙이 바뀌었습니다. 다시 불러온 뒤 수정하세요.".into());
    }
    let next = Library {
        revision: revision.checked_add(1).ok_or("하이라이트 규칙 버전 상한")?,
        items,
    };
    store.set_setting(
        KEY,
        &serde_json::to_string(&next).map_err(|_| "하이라이트 규칙 저장 오류")?,
    )?;
    Ok(next)
}

#[tauri::command]
pub async fn highlight_rules(state: State<'_, AppState>) -> Result<Library> {
    let store = state.store.clone();
    tauri::async_runtime::spawn_blocking(move || read(&store))
        .await
        .map_err(|_| "하이라이트 규칙을 읽지 못했습니다.".to_string())?
}

#[tauri::command]
pub async fn highlight_rules_save(
    app: tauri::AppHandle,
    revision: u64,
    items: Vec<Rule>,
) -> Result<Library> {
    let handle = app.clone();
    let saved = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let _guard = state.mutation.lock().unwrap();
        save(&state.store, revision, items)
    })
    .await
    .map_err(|_| "하이라이트 규칙을 저장하지 못했습니다.".to_string())??;
    // A window that misses this keeps its rules until it reads them again; saving still worked.
    let _ = app.emit(CHANGED_EVENT, saved.revision);
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: &str) -> Rule {
        Rule {
            id: id.into(),
            name: "오류".into(),
            pattern: "ERROR".into(),
            ignore_case: false,
            scope: Scope::All,
            color: Some(Color::Danger),
            notify: false,
            send: None,
            enabled: true,
        }
    }

    fn store() -> Store {
        let dir = tempfile::tempdir().unwrap();
        Store::open(&dir.keep().join("s.sqlite3")).unwrap()
    }

    #[test]
    fn saves_and_reads_with_revision() {
        let store = store();
        assert_eq!(read(&store).unwrap().revision, 0);
        let saved = save(&store, 0, vec![rule("a")]).unwrap();
        assert_eq!(saved.revision, 1);
        assert_eq!(read(&store).unwrap().items, vec![rule("a")]);
        assert!(save(&store, 0, vec![]).unwrap_err().contains("다른 창"));
    }

    #[test]
    fn refuses_typing_into_password_prompts() {
        for pattern in [
            "[Pp]assword:",
            "pass(word)?",
            "Enter passphrase",
            "암호:",
            "비밀번호",
            "p.ssword",
        ] {
            let mut r = rule("a");
            r.pattern = pattern.into();
            r.send = Some(Send {
                text: "y\n".into(),
                confirmed_at: 1,
            });
            assert!(
                validate(&[r]).unwrap_err().contains("암호"),
                "{pattern} must be refused"
            );
        }
    }

    #[test]
    fn send_needs_confirmation_and_plain_text() {
        let mut r = rule("a");
        r.pattern = "Continue\\? \\[y/n\\]".into();
        r.send = Some(Send {
            text: "y\r".into(),
            confirmed_at: 0,
        });
        assert!(validate(std::slice::from_ref(&r)).is_err());
        r.send = Some(Send {
            text: "y\x1b".into(),
            confirmed_at: 5,
        });
        assert!(validate(std::slice::from_ref(&r)).is_err());
        r.send = Some(Send {
            text: "y\r".into(),
            confirmed_at: 5,
        });
        validate(&[r]).unwrap();
    }

    #[test]
    fn limits_count_size_and_duplicates() {
        let many: Vec<Rule> = (0..=MAX_RULES).map(|i| rule(&i.to_string())).collect();
        assert!(validate(&many).is_err());
        assert!(validate(&[rule("a"), rule("a")]).is_err());
        let mut long = rule("a");
        long.pattern = "x".repeat(MAX_PATTERN + 1);
        assert!(validate(&[long]).is_err());
        let mut idle = rule("a");
        idle.color = None;
        assert!(validate(&[idle]).is_err());
        let mut tags = rule("a");
        tags.scope = Scope::Tags { tags: vec![] };
        assert!(validate(&[tags]).is_err());
    }

    #[test]
    fn corrupt_storage_is_an_error_not_an_empty_list() {
        let store = store();
        store.set_setting(KEY, "{broken").unwrap();
        assert!(read(&store).is_err());
    }

    #[test]
    fn reads_the_web_view_shape() {
        let json = r#"{"revision":2,"items":[{"id":"r","name":"n","pattern":"x","ignoreCase":true,
            "scope":{"kind":"tags","tags":["db"]},"color":"warning","notify":true,
            "send":{"text":"y","confirmedAt":9},"enabled":false}]}"#;
        let library: Library = serde_json::from_str(json).unwrap();
        assert_eq!(library.items[0].color, Some(Color::Warning));
        validate(&library.items).unwrap();
    }
}
