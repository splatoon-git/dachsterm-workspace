//! `claude -p` in stream-json mode (docs/verification/agent-chat.md, AC.0). The CLI's message
//! shapes change between versions, so everything about them stays in this file and anything
//! unrecognised is skipped rather than shown.
use super::event::{ChatEvent, Edit};
use serde_json::{Value, json};
use std::collections::HashMap;

pub const PROGRAM: &str = "claude";
const MAX_DETAIL: usize = 500;
const MAX_SUMMARY: usize = 200;
/// A tool's output or an edit's text in the chat; the full text stays in the agent's own record.
const MAX_OUTPUT: usize = 8000;

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
        "--include-partial-messages",
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

/// Stops the running turn. The CLI answers with a failed `result`.
pub fn interrupt_message() -> String {
    json!({
        "type": "control_request",
        "request_id": format!("interrupt-{}", uuid::Uuid::new_v4().simple()),
        "request": { "subtype": "interrupt" },
    })
    .to_string()
}

fn cut(text: &str, limit: usize) -> String {
    let mut kept: String = text.chars().take(limit).collect();
    if kept.len() < text.len() {
        kept.push('…');
    }
    kept
}

/// One line that says what a tool call is about: its command, file, pattern or address.
fn summary(name: &str, input: &Value) -> String {
    let field = |key: &str| input.get(key).and_then(Value::as_str);
    let chosen = match name {
        "Bash" => field("command"),
        "Read" | "Write" | "Edit" | "MultiEdit" => field("file_path"),
        "NotebookEdit" => field("notebook_path"),
        "Grep" | "Glob" => field("pattern"),
        "WebFetch" => field("url"),
        "WebSearch" => field("query"),
        "Agent" | "Task" => field("description"),
        _ => None,
    }
    .or_else(|| input.as_object()?.values().find_map(Value::as_str))
    .unwrap_or_default();
    cut(chosen.lines().next().unwrap_or_default(), MAX_SUMMARY)
}

fn edit_of(name: &str, input: &Value) -> Option<Edit> {
    let field = |key: &str| input.get(key).and_then(Value::as_str);
    let (before, after) = match name {
        "Edit" => (field("old_string")?, field("new_string")?),
        "Write" => ("", field("content")?),
        _ => return None,
    };
    Some(Edit {
        path: field("file_path")?.to_string(),
        before: cut(before, MAX_OUTPUT),
        after: cut(after, MAX_OUTPUT),
    })
}

/// A tool result's text. It comes as a string or as a list of blocks.
fn output_of(content: &Value) -> String {
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    };
    cut(&text, MAX_OUTPUT)
}

/// Turns output lines into chat events, remembering what it needs across lines.
#[derive(Default)]
pub struct Reader {
    session: Option<String>,
    /// The kind of each content block of the message being streamed, by index.
    blocks: HashMap<u64, String>,
}

impl Reader {
    pub fn read(&mut self, line: &str) -> Vec<ChatEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return vec![];
        };
        // Subagents' own messages carry the tool call that started them (AC.7).
        if !value["parent_tool_use_id"].is_null() {
            return vec![];
        }
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
            (Some("stream_event"), _) => self.stream(&value["event"]),
            (Some("assistant"), _) => value["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|block| match block["type"].as_str()? {
                    "text" => {
                        let text = block["text"].as_str().filter(|t| !t.is_empty())?;
                        Some(ChatEvent::Text { text: text.into() })
                    }
                    "tool_use" => {
                        let name = block["name"].as_str()?.to_string();
                        Some(ChatEvent::ToolStarted {
                            id: block["id"].as_str()?.to_string(),
                            summary: summary(&name, &block["input"]),
                            edit: edit_of(&name, &block["input"]),
                            name,
                        })
                    }
                    _ => None,
                })
                .collect(),
            (Some("user"), _) => value["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|block| block["type"] == "tool_result")
                .filter_map(|block| {
                    Some(ChatEvent::ToolFinished {
                        id: block["tool_use_id"].as_str()?.to_string(),
                        ok: !block["is_error"].as_bool().unwrap_or(false),
                        output: output_of(&block["content"]),
                    })
                })
                .collect(),
            (Some("result"), subtype) => {
                let failed = value["is_error"].as_bool().unwrap_or(true);
                let detail =
                    failed.then(|| cut(text("result").or(subtype).unwrap_or("오류"), MAX_DETAIL));
                vec![ChatEvent::TurnFinished {
                    ok: !failed,
                    detail,
                }]
            }
            _ => vec![],
        }
    }

    /// Partial messages: the reply as it is written and when thinking starts and stops.
    fn stream(&mut self, event: &Value) -> Vec<ChatEvent> {
        let index = event["index"].as_u64().unwrap_or_default();
        match event["type"].as_str() {
            Some("message_start") => {
                self.blocks.clear();
                vec![]
            }
            Some("content_block_start") => {
                let kind = event["content_block"]["type"].as_str().unwrap_or_default();
                self.blocks.insert(index, kind.to_string());
                if kind == "thinking" {
                    vec![ChatEvent::Thinking { done: false }]
                } else {
                    vec![]
                }
            }
            Some("content_block_delta") if event["delta"]["type"] == "text_delta" => {
                match event["delta"]["text"].as_str() {
                    Some(text) if !text.is_empty() => {
                        vec![ChatEvent::TextDelta { text: text.into() }]
                    }
                    _ => vec![],
                }
            }
            Some("content_block_stop")
                if self.blocks.remove(&index).as_deref() == Some("thinking") =>
            {
                vec![ChatEvent::Thinking { done: true }]
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
            [
                ChatEvent::Text {
                    text: "안녕".into()
                },
                ChatEvent::ToolStarted {
                    id: "t1".into(),
                    name: "Bash".into(),
                    summary: String::new(),
                    edit: None,
                },
            ]
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

    // Partial message and tool shapes recorded from claude 2.1.319; texts replaced.
    const STREAM: [&str; 5] = [
        r#"{"type":"stream_event","event":{"type":"message_start","message":{}},"parent_tool_use_id":null}"#,
        r#"{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}},"parent_tool_use_id":null}"#,
        r#"{"type":"stream_event","event":{"type":"content_block_stop","index":0},"parent_tool_use_id":null}"#,
        r#"{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"반"}},"parent_tool_use_id":null}"#,
        r#"{"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{"}},"parent_tool_use_id":null}"#,
    ];
    const EDIT: &str = r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"/w/a.txt","old_string":"hello","new_string":"bye","replace_all":false}}]},"parent_tool_use_id":null}"#;
    const RESULT: &str = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"The file was updated"}]},"parent_tool_use_id":null}"#;
    const FAILED_TOOL: &str = r#"{"type":"user","message":{"content":[{"tool_use_id":"t3","type":"tool_result","is_error":true,"content":[{"type":"text","text":"denied"}]}]},"parent_tool_use_id":null}"#;

    #[test]
    fn streams_thinking_and_text_and_skips_tool_input_deltas() {
        let mut reader = Reader::default();
        let events: Vec<_> = STREAM.iter().flat_map(|line| reader.read(line)).collect();
        assert_eq!(
            events,
            [
                ChatEvent::Thinking { done: false },
                ChatEvent::Thinking { done: true },
                ChatEvent::TextDelta { text: "반".into() },
            ]
        );
    }

    #[test]
    fn a_tool_call_and_its_result() {
        let mut reader = Reader::default();
        assert_eq!(
            reader.read(EDIT),
            [ChatEvent::ToolStarted {
                id: "t2".into(),
                name: "Edit".into(),
                summary: "/w/a.txt".into(),
                edit: Some(Edit {
                    path: "/w/a.txt".into(),
                    before: "hello".into(),
                    after: "bye".into()
                }),
            }]
        );
        assert_eq!(
            reader.read(RESULT),
            [ChatEvent::ToolFinished {
                id: "t2".into(),
                ok: true,
                output: "The file was updated".into()
            }]
        );
        assert_eq!(
            reader.read(FAILED_TOOL),
            [ChatEvent::ToolFinished {
                id: "t3".into(),
                ok: false,
                output: "denied".into()
            }]
        );
    }

    #[test]
    fn a_command_is_summed_up_by_its_first_line() {
        let input = json!({ "command": "cd /w\nnpm test", "description": "run" });
        assert_eq!(summary("Bash", &input), "cd /w");
        assert_eq!(summary("Unknown", &json!({ "x": "y" })), "y");
    }

    #[test]
    fn an_interrupt_is_one_control_line() {
        let value: Value = serde_json::from_str(&interrupt_message()).unwrap();
        assert_eq!(value["request"]["subtype"], "interrupt");
    }

    #[test]
    fn a_user_message_is_one_json_line() {
        let line = user_message("줄\n바꿈 \"따옴표\"");
        assert!(!line.contains('\n'));
        let value: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["message"]["content"], "줄\n바꿈 \"따옴표\"");
    }
}
