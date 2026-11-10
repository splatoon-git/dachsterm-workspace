//! `claude -p` in stream-json mode (docs/verification/agent-chat.md, AC.0). The CLI's message
//! shapes change between versions, so everything about them stays in this file and anything
//! unrecognised is skipped rather than shown.
use super::event::ChatEvent;
use serde_json::{Value, json};

pub const PROGRAM: &str = "claude";
const MAX_DETAIL: usize = 500;

/// Arguments after the program path. Until approvals have a screen (AC.5), anything that would ask
/// is refused by the CLI itself instead of waiting for an answer no one can give.
pub fn arguments() -> Vec<String> {
    [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-prompts",
        "none",
    ]
    .map(String::from)
    .to_vec()
}

/// One user turn as the CLI reads it on stdin.
pub fn user_message(text: &str) -> String {
    json!({
        "type": "user",
        "message": { "role": "user", "content": text },
        "session_id": "",
        "parent_tool_use_id": null,
    })
    .to_string()
}

fn short(text: &str) -> String {
    let mut cut: String = text.chars().take(MAX_DETAIL).collect();
    if cut.len() < text.len() {
        cut.push('…');
    }
    cut
}

/// Turns output lines into chat events, remembering what it needs across lines.
#[derive(Default)]
pub struct Reader {
    session: Option<String>,
}

impl Reader {
    pub fn read(&mut self, line: &str) -> Vec<ChatEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return vec![];
        };
        let text = |key: &str| value.get(key).and_then(Value::as_str);
        match (text("type"), text("subtype")) {
            (Some("system"), Some("init")) => {
                let session = text("session_id").unwrap_or_default().to_string();
                if self.session.as_deref() == Some(session.as_str()) {
                    return vec![];
                }
                self.session = Some(session.clone());
                vec![ChatEvent::Started {
                    session,
                    model: text("model").unwrap_or_default().to_string(),
                }]
            }
            // Subagents' own messages carry the tool call that started them (AC.7).
            (Some("assistant"), _) if value["parent_tool_use_id"].is_null() => {
                let blocks = value["message"]["content"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                let joined: Vec<&str> = blocks
                    .iter()
                    .filter(|b| b["type"] == "text")
                    .filter_map(|b| b["text"].as_str())
                    .filter(|t| !t.is_empty())
                    .collect();
                if joined.is_empty() {
                    return vec![];
                }
                vec![ChatEvent::Text {
                    text: joined.join("\n\n"),
                }]
            }
            (Some("result"), subtype) => {
                let failed = value["is_error"].as_bool().unwrap_or(true);
                let detail = failed.then(|| short(text("result").or(subtype).unwrap_or("오류")));
                vec![ChatEvent::TurnFinished {
                    ok: !failed,
                    detail,
                }]
            }
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shapes recorded from claude 2.1.319 and 2.1.321; texts replaced.
    const INIT: &str = r#"{"type":"system","subtype":"init","session_id":"s1","model":"claude-haiku-5-5","cwd":"/w","tools":[]}"#;
    const TEXT: &str = r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"안녕"},{"type":"tool_use","id":"t1","name":"Bash","input":{}}]},"parent_tool_use_id":null,"session_id":"s1"}"#;
    const SUB: &str = r#"{"type":"assistant","message":{"content":[{"type":"text","text":"sub"}]},"parent_tool_use_id":"toolu_1"}"#;
    const DONE: &str =
        r#"{"type":"result","subtype":"success","is_error":false,"result":"안녕","num_turns":1}"#;
    const FAILED: &str = r#"{"type":"result","subtype":"error_during_execution","is_error":true}"#;

    #[test]
    fn reads_a_turn() {
        let mut reader = Reader::default();
        assert_eq!(
            reader.read(INIT),
            [ChatEvent::Started {
                session: "s1".into(),
                model: "claude-haiku-5-5".into()
            }]
        );
        assert_eq!(
            reader.read(TEXT),
            [ChatEvent::Text {
                text: "안녕".into()
            }]
        );
        assert_eq!(
            reader.read(DONE),
            [ChatEvent::TurnFinished {
                ok: true,
                detail: None
            }]
        );
    }

    #[test]
    fn a_repeated_init_for_the_same_session_says_nothing() {
        let mut reader = Reader::default();
        reader.read(INIT);
        assert!(reader.read(INIT).is_empty());
    }

    #[test]
    fn skips_subagents_unknown_lines_and_noise() {
        let mut reader = Reader::default();
        for line in [
            SUB,
            "",
            "not json",
            r#"{"type":"stream_event"}"#,
            r#"{"type":"rate_limit_event"}"#,
        ] {
            assert!(reader.read(line).is_empty(), "{line}");
        }
    }

    #[test]
    fn a_failed_turn_says_why() {
        let mut reader = Reader::default();
        assert_eq!(
            reader.read(FAILED),
            [ChatEvent::TurnFinished {
                ok: false,
                detail: Some("error_during_execution".into())
            }]
        );
    }

    #[test]
    fn a_user_message_is_one_json_line() {
        let line = user_message("줄\n바꿈 \"따옴표\"");
        assert!(!line.contains('\n'));
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["message"]["content"], "줄\n바꿈 \"따옴표\"");
    }
}
