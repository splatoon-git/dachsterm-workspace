//! `claude -p` in stream-json mode (docs/verification/agent-chat.md, AC.0). The CLI's message
//! shapes change between versions, so everything about them stays in this file and anything
//! unrecognised is skipped rather than shown.
use super::event::{Account, ChatEvent, Choice, ContextPart, Edit, Limit};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

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
        // Approvals come to the app as control requests and wait for its answer (AC.5).
        "--permission-prompt-tool",
        "stdio",
        // Lets the user pick "skip permission checks" during the chat; it does not turn it on.
        "--allow-dangerously-skip-permissions",
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

/// A control request. The ID's prefix tells the reader what the answer is for.
fn control(kind: &str, request: Value) -> String {
    json!({
        "type": "control_request",
        "request_id": format!("{kind}-{}", uuid::Uuid::new_v4().simple()),
        "request": request,
    })
    .to_string()
}

/// Stops the running turn. The CLI answers with a failed `result`.
pub fn interrupt_message() -> String {
    control("interrupt", json!({ "subtype": "interrupt" }))
}

/// Asks what the agent offers: models, commands and agents.
pub fn initialize_message() -> String {
    control("init", json!({ "subtype": "initialize", "hooks": null }))
}

pub fn context_message() -> String {
    control("context", json!({ "subtype": "get_context_usage" }))
}

/// A model name as the CLI lists them: `default`, an alias or a full name with a variant.
pub fn model_problem(model: &str) -> Option<&'static str> {
    let fine = !model.is_empty()
        && model.len() <= 64
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-[]".contains(c));
    (!fine).then_some("모델 이름을 확인하세요.")
}

pub fn model_message(model: &str) -> String {
    control("model", json!({ "subtype": "set_model", "model": model }))
}

/// The effective settings, read once at start for the effort level in use.
pub fn settings_message() -> String {
    control("settings", json!({ "subtype": "get_settings" }))
}

pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// Changes the effort for the next turns. The CLI has no request of its own for it; it takes the
/// setting as a flag setting during the session (measured with 2.1.319).
pub fn effort_message(level: &str) -> Option<String> {
    EFFORTS.contains(&level).then(|| {
        control(
            "effort",
            json!({ "subtype": "apply_flag_settings", "settings": { "effortLevel": level } }),
        )
    })
}

/// The permission modes the chat offers. Skipping checks works because the agent was started with
/// `--allow-dangerously-skip-permissions`.
pub const MODES: [&str; 5] = [
    "default",
    "acceptEdits",
    "plan",
    "auto",
    "bypassPermissions",
];

pub fn mode_message(mode: &str) -> Option<String> {
    MODES.contains(&mode).then(|| {
        control(
            "mode",
            json!({ "subtype": "set_permission_mode", "mode": mode }),
        )
    })
}

/// Ultracode (dynamic workflows on every task) for this session. The CLI has no request for it;
/// its `/effort` command takes it as a turn of its own (measured with 2.1.319).
pub fn ultracode_message(on: bool) -> String {
    user_message(if on {
        "/effort ultracode on"
    } else {
        "/effort ultracode off"
    })
}

pub fn usage_message() -> String {
    control("usage", json!({ "subtype": "get_usage" }))
}

fn limits(windows: &Value, percent_of: impl Fn(&Value) -> Option<f64>, resets: &str) -> Vec<Limit> {
    ["five_hour", "seven_day"]
        .into_iter()
        .filter_map(|name| {
            let window = &windows[name];
            Some(Limit {
                name: name.into(),
                percent: percent_of(window)?,
                resets_at: match &window[resets] {
                    Value::String(at) => at.clone(),
                    Value::Number(at) => at.to_string(),
                    _ => String::new(),
                },
            })
        })
        .collect()
}

fn cut(text: &str, limit: usize) -> String {
    let mut kept: String = text.chars().take(limit).collect();
    if kept.len() < text.len() {
        kept.push('…');
    }
    kept
}

/// One line that says what a tool call is about: its command, file, pattern or address.
pub(super) fn summary(name: &str, input: &Value) -> String {
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

pub(super) fn edit_of(name: &str, input: &Value) -> Option<Edit> {
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

fn choices(list: &Value, value: &str, label: &str, detail: &str, hint: &str) -> Vec<Choice> {
    let field = |item: &Value, key: &str| item[key].as_str().unwrap_or_default().to_string();
    list.as_array()
        .into_iter()
        .flatten()
        .filter(|item| item[value].is_string())
        .map(|item| Choice {
            value: field(item, value),
            label: field(item, label),
            detail: cut(&field(item, detail), MAX_SUMMARY),
            hint: field(item, hint),
            levels: item["supportedEffortLevels"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|l| l.as_str().map(String::from))
                .collect(),
        })
        .collect()
}

/// The CLI's answer to one of the app's control requests, found by the request ID's prefix.
fn answer(response: &Value) -> Vec<ChatEvent> {
    let id = response["request_id"].as_str().unwrap_or_default();
    let body = &response["response"];
    let failed = response["subtype"] == "error";
    match (id.split('-').next().unwrap_or_default(), failed) {
        ("init", false) => vec![ChatEvent::Capabilities {
            models: choices(
                &body["models"],
                "value",
                "displayName",
                "description",
                "resolvedModel",
            ),
            commands: choices(
                &body["commands"],
                "name",
                "name",
                "description",
                "argumentHint",
            ),
            agents: choices(&body["agents"], "name", "name", "description", ""),
            permission_mode: body["current_permission_mode"]
                .as_str()
                .unwrap_or_default()
                .into(),
            account: Account {
                plan: body["account"]["subscriptionType"]
                    .as_str()
                    .unwrap_or_default()
                    .into(),
                email: body["account"]["email"].as_str().unwrap_or_default().into(),
            },
        }],
        ("settings", false) => body["effective"]["effortLevel"]
            .as_str()
            .map(|level| ChatEvent::Effort {
                level: level.into(),
            })
            .into_iter()
            .collect(),
        ("mode", false) => vec![ChatEvent::Mode {
            mode: body["mode"].as_str().unwrap_or_default().into(),
        }],
        ("usage", false) => vec![ChatEvent::Usage {
            cost: body["session"]["total_cost_usd"]
                .as_f64()
                .unwrap_or_default(),
            added: body["session"]["total_lines_added"]
                .as_u64()
                .unwrap_or_default(),
            removed: body["session"]["total_lines_removed"]
                .as_u64()
                .unwrap_or_default(),
            limits: limits(
                &body["rate_limits"],
                |w| w["utilization"].as_f64(),
                "resets_at",
            ),
        }],
        ("effort" | "mode", true) => vec![ChatEvent::Problem {
            text: format!(
                "설정을 바꾸지 못했습니다. {}",
                cut(response["error"].as_str().unwrap_or_default(), MAX_DETAIL)
            ),
        }],
        ("context", false) => {
            let parts = body["categories"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|c| c["kind"] == "used" || c["kind"] == "free")
                .filter_map(|c| {
                    Some(ContextPart {
                        name: c["name"].as_str()?.to_string(),
                        tokens: c["tokens"].as_u64()?,
                        free: c["kind"] == "free",
                    })
                })
                .collect();
            let percentage = body["percentage"].as_f64().unwrap_or_default();
            vec![ChatEvent::Context {
                model: body["model"].as_str().unwrap_or_default().to_string(),
                percentage: percentage.round().clamp(0.0, 100.0) as u32,
                used: body["totalTokens"].as_u64().unwrap_or_default(),
                max: body["maxTokens"].as_u64().unwrap_or_default(),
                parts,
            }]
        }
        ("model", true) => vec![ChatEvent::Problem {
            text: format!(
                "모델을 바꾸지 못했습니다. {}",
                cut(response["error"].as_str().unwrap_or_default(), MAX_DETAIL)
            ),
        }],
        _ => vec![],
    }
}

/// Turns output lines into chat events, remembering what it needs across lines.
#[derive(Default)]
pub struct Reader {
    session: Option<String>,
    model: Option<String>,
    /// Background tasks that are subagents, as opposed to commands run in the background.
    agents: HashSet<String>,
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
                let model = text("model").unwrap_or_default().to_string();
                if self.session.as_deref() == Some(session.as_str())
                    && self.model.as_deref() == Some(model.as_str())
                {
                    return vec![];
                }
                self.session = Some(session.clone());
                self.model = Some(model.clone());
                vec![ChatEvent::Started { session, model }]
            }
            (Some("system"), Some("task_started")) if value["task_type"] == "local_agent" => {
                let id = text("task_id").unwrap_or_default().to_string();
                self.agents.insert(id.clone());
                vec![ChatEvent::AgentStarted {
                    id,
                    call: text("tool_use_id").unwrap_or_default().to_string(),
                    role: text("subagent_type").unwrap_or("agent").to_string(),
                    task: cut(text("description").unwrap_or_default(), MAX_SUMMARY),
                }]
            }
            (Some("system"), Some("task_notification"))
                if self.agents.remove(text("task_id").unwrap_or_default()) =>
            {
                vec![ChatEvent::AgentFinished {
                    id: text("task_id").unwrap_or_default().to_string(),
                    ok: value["status"] == "completed",
                    summary: cut(text("summary").unwrap_or_default(), MAX_DETAIL),
                }]
            }
            (Some("control_response"), _) => answer(&value["response"]),
            (Some("control_request"), _) if value["request"]["subtype"] == "can_use_tool" => {
                vec![super::approval::asked(
                    text("request_id").unwrap_or_default(),
                    &value["request"],
                    summary,
                    edit_of,
                )]
            }
            // Utilization comes as a fraction here and as a percentage from `get_usage`.
            (Some("rate_limit_event"), _) => {
                let limits = limits(
                    &value["rate_limit_info"]["unifiedWindows"],
                    |w| Some(w["utilization"].as_f64()? * 100.0),
                    "resetsAt",
                );
                if limits.is_empty() {
                    return vec![];
                }
                vec![ChatEvent::Limits { limits }]
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
                let usage = &value["usage"];
                let count = |key: &str| usage[key].as_u64().unwrap_or_default();
                vec![
                    ChatEvent::TurnUsage {
                        input: count("input_tokens"),
                        cache_read: count("cache_read_input_tokens"),
                        cache_write: count("cache_creation_input_tokens"),
                        output: count("output_tokens"),
                        cost: value["total_cost_usd"].as_f64().unwrap_or_default(),
                    },
                    ChatEvent::TurnFinished {
                        ok: !failed,
                        detail,
                    },
                ]
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
            reader.read(DONE).last(),
            Some(&ChatEvent::TurnFinished {
                ok: true,
                detail: None
            })
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
            reader.read(FAILED).last(),
            Some(&ChatEvent::TurnFinished {
                ok: false,
                detail: Some("error_during_execution".into())
            })
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
    fn reads_what_the_agent_offers_without_the_account() {
        let line = json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": "init-1",
                "response": {
                    "account": { "email": "someone@example.com", "subscriptionType": "Claude Max", "organization": "Acme" },
                    "models": [{ "value": "default", "displayName": "Default", "description": "Opus" }],
                    "commands": [{ "name": "review", "description": "Review", "argumentHint": "[pr]" }],
                    "agents": [{ "name": "Explore", "description": "Looks around" }],
                    "current_permission_mode": "default"
                }
            }
        })
        .to_string();
        let events = Reader::default().read(&line);
        let ChatEvent::Capabilities {
            models,
            commands,
            agents,
            permission_mode,
            account,
        } = &events[0]
        else {
            panic!("{events:?}");
        };
        assert_eq!(models[0].label, "Default");
        assert_eq!(commands[0].hint, "[pr]");
        assert_eq!(agents[0].value, "Explore");
        assert_eq!(permission_mode, "default");
        assert_eq!(account.email, "someone@example.com");
        // Nothing else of the account, such as the organisation, reaches the screen.
        assert!(!format!("{events:?}").contains("Acme"));
    }

    #[test]
    fn reads_usage_limits_and_what_a_turn_used() {
        let usage = json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "usage-1", "response": {
                "session": { "total_cost_usd": 0.5, "total_lines_added": 12, "total_lines_removed": 3 },
                "rate_limits": {
                    "five_hour": { "utilization": 21, "resets_at": "2026-11-10T18:00:00Z" },
                    "seven_day": { "utilization": 81, "resets_at": "2026-11-12T00:00:00Z" }
                }
            }}
        })
        .to_string();
        let events = Reader::default().read(&usage);
        let ChatEvent::Usage { added, limits, .. } = &events[0] else {
            panic!("{events:?}");
        };
        assert_eq!(*added, 12);
        assert_eq!(limits[0].percent, 21.0);
        let live = r#"{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.21,"resetsAt":1794286200}}}}"#;
        let events = Reader::default().read(live);
        let ChatEvent::Limits { limits } = &events[0] else {
            panic!("{events:?}");
        };
        assert_eq!(limits[0].resets_at, "1794286200");
        assert!((limits[0].percent - 21.0).abs() < 1e-9);
        let turn = r#"{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.002,"usage":{"input_tokens":2,"cache_read_input_tokens":24142,"cache_creation_input_tokens":8509,"output_tokens":4}}"#;
        assert!(matches!(
            &Reader::default().read(turn)[0],
            ChatEvent::TurnUsage {
                cache_read: 24142,
                cache_write: 8509,
                ..
            }
        ));
        assert!(effort_message("max").is_some() && effort_message("turbo").is_none());
        assert!(mode_message("bypassPermissions").is_some() && mode_message("x").is_none());
        let on: Value = serde_json::from_str(&ultracode_message(true)).unwrap();
        assert_eq!(on["message"]["content"], "/effort ultracode on");
    }

    #[test]
    fn reads_context_use_and_a_failed_model_change() {
        let context = json!({
            "type": "control_response",
            "response": { "subtype": "success", "request_id": "context-1", "response": {
                "percentage": 12.6, "totalTokens": 25200, "maxTokens": 200000,
                "categories": [
                    { "name": "System prompt", "tokens": 3593, "kind": "used" },
                    { "name": "Deferred tools", "tokens": 9, "kind": "deferred" },
                    { "name": "Free space", "tokens": 170000, "kind": "free" }
                ]
            }}
        })
        .to_string();
        let events = Reader::default().read(&context);
        let ChatEvent::Context {
            percentage, parts, ..
        } = &events[0]
        else {
            panic!("{events:?}");
        };
        assert_eq!(*percentage, 13);
        assert_eq!(parts.len(), 2);
        assert!(parts[1].free);
        let refused = r#"{"type":"control_response","response":{"subtype":"error","request_id":"model-1","error":"unknown model"}}"#;
        assert!(matches!(
            &Reader::default().read(refused)[0],
            ChatEvent::Problem { text } if text.contains("unknown model")
        ));
        assert!(model_problem("claude-opus-5-5[1m]").is_none());
        assert!(model_problem("opus; rm").is_some());
    }

    #[test]
    fn follows_subagents_but_not_background_commands() {
        let mut reader = Reader::default();
        let agent = r#"{"type":"system","subtype":"task_started","task_id":"a1","tool_use_id":"t","description":"Look","subagent_type":"Explore","task_type":"local_agent"}"#;
        let bash = r#"{"type":"system","subtype":"task_started","task_id":"b1","description":"sleep","task_type":"local_bash"}"#;
        assert_eq!(reader.read(agent).len(), 1);
        assert!(reader.read(bash).is_empty());
        let done = r#"{"type":"system","subtype":"task_notification","task_id":"a1","status":"completed","summary":"found"}"#;
        assert_eq!(
            reader.read(done),
            [ChatEvent::AgentFinished {
                id: "a1".into(),
                ok: true,
                summary: "found".into()
            }]
        );
        let other = r#"{"type":"system","subtype":"task_notification","task_id":"b1","status":"completed"}"#;
        assert!(reader.read(other).is_empty());
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
