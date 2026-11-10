//! Codex thread items and the requests that wait for the user, as chat events.
use super::{MAX_DETAIL, MAX_OUTPUT, MAX_SUMMARY, Reader, cut, text};
use crate::chat::event::{ChatEvent, Question, QuestionOption};
use serde_json::{Value, json};

/// A shell command as the agent wrote it: `/bin/zsh -lc '<command>'` comes back as `<command>`.
pub(super) fn unwrapped(command: &str) -> String {
    for flag in [" -lc '", " -c '"] {
        let Some(at) = command.find(flag) else {
            continue;
        };
        let shell = &command[..at];
        if !shell.contains(' ') && shell.ends_with("sh") && command.ends_with('\'') {
            let inner = &command[at + flag.len()..command.len() - 1];
            return inner.replace("'\\''", "'");
        }
    }
    command.to_string()
}

fn line_of(text: &str) -> String {
    cut(text.lines().next().unwrap_or_default(), MAX_SUMMARY)
}

/// An MCP result's text blocks.
fn content_text(result: &Value) -> String {
    let text = result["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    cut(&text, MAX_OUTPUT)
}

fn questions(list: &Value) -> Vec<Question> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|q| {
            Some(Question {
                question: q["question"].as_str()?.to_string(),
                header: text(q, "header"),
                multi: false,
                options: q["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|o| {
                        Some(QuestionOption {
                            label: o["label"].as_str()?.to_string(),
                            detail: text(o, "description"),
                        })
                    })
                    .collect(),
            })
        })
        .collect()
}

impl Reader {
    pub(super) fn item_started(&mut self, item: &Value) -> Vec<ChatEvent> {
        let id = text(item, "id");
        let tool = |name: &str, summary: String| {
            vec![ChatEvent::ToolStarted {
                id: id.clone(),
                name: name.into(),
                summary,
                edit: None,
            }]
        };
        match item["type"].as_str().unwrap_or_default() {
            "reasoning" => vec![ChatEvent::Thinking { done: false }],
            "commandExecution" => tool("Bash", line_of(&unwrapped(&text(item, "command")))),
            "fileChange" => {
                let paths = item["changes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|c| c["path"].as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                let paths = cut(&paths, MAX_SUMMARY);
                self.changes.insert(id.clone(), paths.clone());
                tool("Edit", paths)
            }
            "mcpToolCall" => {
                let name = format!("{}.{}", text(item, "server"), text(item, "tool"));
                let argument = item["arguments"]
                    .as_object()
                    .and_then(|a| a.values().find_map(Value::as_str))
                    .unwrap_or_default();
                tool(&name, line_of(argument))
            }
            "webSearch" => tool("WebSearch", line_of(&text(item, "query"))),
            "collabAgentToolCall" => {
                self.note_spawned(item);
                tool("Agent", line_of(&text(item, "prompt")))
            }
            "subAgentActivity" => self.agent_activity(item),
            _ => vec![],
        }
    }

    pub(super) fn item_completed(&mut self, item: &Value) -> Vec<ChatEvent> {
        let id = text(item, "id");
        let status = item["status"].as_str().unwrap_or_default();
        let finished = |ok: bool, output: String| {
            vec![ChatEvent::ToolFinished {
                id: id.clone(),
                ok,
                output,
            }]
        };
        match item["type"].as_str().unwrap_or_default() {
            "agentMessage" => match item["text"].as_str() {
                Some(text) if !text.is_empty() => vec![ChatEvent::Text { text: text.into() }],
                _ => vec![],
            },
            "reasoning" => vec![ChatEvent::Thinking { done: true }],
            "commandExecution" => {
                let output = cut(
                    item["aggregatedOutput"].as_str().unwrap_or_default(),
                    MAX_OUTPUT,
                );
                let exit = item["exitCode"].as_i64();
                let ok = status == "completed" && exit.unwrap_or(0) == 0;
                let output = match (status, exit) {
                    ("declined", _) => "실행하지 않았습니다.".to_string(),
                    (_, Some(code)) if code != 0 && output.is_empty() => {
                        format!("종료 코드 {code}")
                    }
                    _ => output,
                };
                finished(ok, output)
            }
            "fileChange" => {
                self.changes.remove(&id);
                let diff = item["changes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|c| format!("{}\n{}", text(c, "path"), text(c, "diff")))
                    .collect::<Vec<_>>()
                    .join("\n");
                let output = match status {
                    "declined" => "바꾸지 않았습니다.".to_string(),
                    _ => cut(&diff, MAX_OUTPUT),
                };
                finished(status == "completed", output)
            }
            "mcpToolCall" => match item["error"]["message"].as_str() {
                Some(error) => finished(false, cut(error, MAX_OUTPUT)),
                None => finished(true, content_text(&item["result"])),
            },
            "webSearch" => finished(true, String::new()),
            "collabAgentToolCall" => {
                self.note_spawned(item);
                finished(status != "failed", String::new())
            }
            "subAgentActivity" => self.agent_activity(item),
            _ => vec![],
        }
    }

    /// The threads a collaboration call started, so their activity can be shown under it.
    fn note_spawned(&mut self, item: &Value) {
        for thread in item["receiverThreadIds"].as_array().into_iter().flatten() {
            if let Some(thread) = thread.as_str() {
                self.spawned.insert(thread.into(), text(item, "id"));
            }
        }
    }

    /// A subagent's start or end. It may be reported when the item starts and again when it ends.
    fn agent_activity(&mut self, item: &Value) -> Vec<ChatEvent> {
        let thread = text(item, "agentThreadId");
        match item["kind"].as_str() {
            Some("started") if self.running.insert(thread.clone()) => {
                vec![ChatEvent::AgentStarted {
                    call: self.spawned.get(&thread).cloned().unwrap_or_default(),
                    role: line_of(&text(item, "agentPath")),
                    task: String::new(),
                    id: thread,
                }]
            }
            Some(kind @ ("completed" | "interrupted")) if self.running.remove(&thread) => {
                vec![ChatEvent::AgentFinished {
                    id: thread,
                    ok: kind == "completed",
                    summary: String::new(),
                }]
            }
            _ => vec![],
        }
    }

    /// A request from the agent that waits for the user. Requests the chat cannot answer, such as
    /// token refreshes for an app-managed login, are left alone.
    pub(super) fn asks(&mut self, method: &str, id: &Value, params: &Value) -> Vec<ChatEvent> {
        let request = match id {
            Value::String(id) => format!("codex-{id}"),
            other => format!("codex-{other}"),
        };
        let mut input = json!({ "id": id, "method": method });
        let reason = cut(params["reason"].as_str().unwrap_or_default(), MAX_DETAIL);
        let (tool, summary, detail, questions) = match method {
            "item/commandExecution/requestApproval" => (
                "Bash".to_string(),
                line_of(&unwrapped(params["command"].as_str().unwrap_or_default())),
                reason,
                vec![],
            ),
            "item/fileChange/requestApproval" => {
                let item = params["itemId"].as_str().unwrap_or_default();
                let paths = self.changes.get(item).cloned();
                let root = params["grantRoot"].as_str().map(String::from);
                (
                    "Edit".to_string(),
                    paths.or(root).unwrap_or_default(),
                    reason,
                    vec![],
                )
            }
            "item/permissions/requestApproval" => {
                input["permissions"] = params["permissions"].clone();
                (
                    "권한".to_string(),
                    line_of(params["cwd"].as_str().unwrap_or_default()),
                    reason,
                    vec![],
                )
            }
            "item/tool/requestUserInput" => {
                input["questions"] = params["questions"].clone();
                (
                    "질문".to_string(),
                    String::new(),
                    String::new(),
                    questions(&params["questions"]),
                )
            }
            "mcpServer/elicitation/request" => (
                "MCP".to_string(),
                line_of(params["serverName"].as_str().unwrap_or_default()),
                cut(params["message"].as_str().unwrap_or_default(), MAX_DETAIL),
                vec![],
            ),
            _ => return vec![],
        };
        vec![ChatEvent::ApprovalAsked {
            request,
            tool,
            summary,
            detail,
            edit: None,
            questions,
            input,
        }]
    }
}
