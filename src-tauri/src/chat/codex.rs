//! `codex app-server`: JSON-RPC over stdio, one message per line (docs/verification/agent-chat.md,
//! AC.0 and AC.3). Unlike `claude -p`, the app asks and the agent answers by request ID, so the
//! reader keeps what each request was for, the conversation's thread and its running turn. The
//! protocol is marked experimental; anything unrecognised is skipped rather than shown.
use super::{
    approval::Decision,
    claude::cut,
    event::{Account, ChatEvent, Choice, Limit},
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

pub const PROGRAM: &str = "codex";
const MAX_DETAIL: usize = 500;
const MAX_SUMMARY: usize = 200;
const MAX_OUTPUT: usize = 8000;

pub fn arguments() -> Vec<String> {
    vec!["app-server".into()]
}

/// The permission modes offered for this program, by the names the chat uses. Codex has no
/// edit-only or plan mode; it has a read-only sandbox instead (design §3).
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
enum Mode {
    /// Asks before leaving the workspace sandbox.
    #[default]
    Default,
    ReadOnly,
    /// A reviewer agent answers the approvals instead of the user.
    Auto,
    /// No sandbox and no approvals.
    Bypass,
}

impl Mode {
    fn of(name: &str) -> Option<Self> {
        Some(match name {
            "default" => Self::Default,
            "readOnly" => Self::ReadOnly,
            "auto" => Self::Auto,
            "bypassPermissions" => Self::Bypass,
            _ => return None,
        })
    }
    fn name(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::ReadOnly => "readOnly",
            Self::Auto => "auto",
            Self::Bypass => "bypassPermissions",
        }
    }
    /// `turn/start` overrides, which hold for that turn and the ones after it.
    fn settings(self) -> Value {
        let workspace = json!({
            "type": "workspaceWrite", "writableRoots": [], "networkAccess": false,
            "excludeTmpdirEnvVar": false, "excludeSlashTmp": false,
        });
        let (approval, reviewer, sandbox) = match self {
            Self::Default => ("on-request", "user", workspace),
            Self::ReadOnly => (
                "on-request",
                "user",
                json!({ "type": "readOnly", "networkAccess": false }),
            ),
            Self::Auto => ("on-request", "auto_review", workspace),
            Self::Bypass => ("never", "user", json!({ "type": "dangerFullAccess" })),
        };
        json!({ "approvalPolicy": approval, "approvalsReviewer": reviewer, "sandboxPolicy": sandbox })
    }
}

/// What one of the app's requests was, so its answer can be read.
#[derive(Clone, Copy, Debug)]
enum Asked {
    Initialize,
    Thread,
    Account,
    Models,
    Limits,
    /// `steering` when a turn was running: the message joins it instead of starting one.
    Turn {
        steering: bool,
    },
    Interrupt,
}

/// Token totals of the thread, for what one turn used.
#[derive(Clone, Copy, Default)]
struct Tokens {
    input: u64,
    cached: u64,
    cache_write: u64,
    output: u64,
}

impl Tokens {
    fn of(breakdown: &Value) -> Self {
        let count = |key: &str| breakdown[key].as_u64().unwrap_or_default();
        Self {
            input: count("inputTokens"),
            cached: count("cachedInputTokens"),
            cache_write: count("cacheWriteInputTokens"),
            output: count("outputTokens"),
        }
    }
}

/// Turns output lines into chat events and builds the app's requests, which need the thread and
/// the turn the output named.
#[derive(Default)]
pub struct Reader {
    next: u64,
    asked: HashMap<u64, Asked>,
    thread: Option<String>,
    turn: Option<String>,
    model: String,
    /// The user's choices for the next turns. Codex takes them with each `turn/start`.
    chosen: Option<String>,
    effort: Option<String>,
    mode: Mode,
    account: Option<Account>,
    total: Tokens,
    at_turn_start: Tokens,
    /// The tool call that started each subagent thread, and the subagents still running.
    spawned: HashMap<String, String>,
    running: HashSet<String>,
    /// The files of each change, for its approval card, which names only the change.
    changes: HashMap<String, String>,
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_string()
}

/// A usage window by its length; the chat names the five-hour and weekly ones.
fn limit(window: &Value) -> Option<Limit> {
    let name = match window["windowDurationMins"].as_u64() {
        Some(300) => "five_hour".to_string(),
        Some(10080) => "seven_day".to_string(),
        Some(minutes) if minutes % 1440 == 0 => format!("{}일", minutes / 1440),
        Some(minutes) if minutes % 60 == 0 => format!("{}시간", minutes / 60),
        Some(minutes) => format!("{minutes}분"),
        None => "사용량".to_string(),
    };
    Some(Limit {
        name,
        percent: window["usedPercent"].as_f64()?,
        resets_at: window["resetsAt"]
            .as_u64()
            .map(|at| at.to_string())
            .unwrap_or_default(),
    })
}

fn limits(snapshot: &Value) -> Vec<Limit> {
    ["primary", "secondary"]
        .iter()
        .filter_map(|key| limit(&snapshot[key]))
        .collect()
}

fn models(list: &Value) -> Vec<Choice> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["hidden"] != true && m["model"].is_string())
        .map(|m| Choice {
            value: text(m, "model"),
            label: text(m, "displayName"),
            detail: cut(&text(m, "description"), MAX_SUMMARY),
            hint: text(m, "model"),
            levels: m["supportedReasoningEfforts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|e| e["reasoningEffort"].as_str().map(String::from))
                .collect(),
        })
        .collect()
}

/// The reply to one of the agent's requests, from what the card kept of it.
pub fn answer_message(input: &Value, decision: Decision) -> String {
    let deny = matches!(decision, Decision::Deny);
    let result = match input["method"].as_str().unwrap_or_default() {
        "item/tool/requestUserInput" => {
            let answers = match decision {
                // The card names a question by its text; the agent by its ID.
                Decision::Answer(answers) => input["questions"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|q| {
                        let chosen = answers.get(q["question"].as_str()?)?;
                        let labels: Vec<&str> = chosen.split(", ").collect();
                        Some((q["id"].as_str()?.to_string(), json!({ "answers": labels })))
                    })
                    .collect(),
                _ => serde_json::Map::new(),
            };
            json!({ "answers": answers })
        }
        "item/permissions/requestApproval" => json!({
            "permissions": if deny { json!({}) } else { input["permissions"].clone() },
            "scope": "turn",
        }),
        "mcpServer/elicitation/request" => json!({
            "action": if deny { "decline" } else { "accept" },
            "content": null,
            "_meta": null,
        }),
        _ => json!({ "decision": if deny { "decline" } else { "accept" } }),
    };
    json!({ "id": input["id"], "result": result }).to_string()
}

impl Reader {
    fn request(&mut self, asked: Asked, method: &str, params: Value) -> String {
        self.next += 1;
        self.asked.insert(self.next, asked);
        json!({ "id": self.next, "method": method, "params": params }).to_string()
    }

    /// The lines that start a conversation, in order. The agent handles them one after another.
    pub fn opening(&mut self) -> Vec<String> {
        let client = json!({
            "clientInfo": { "name": "dachsterm", "title": "DachsTerm", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": null,
        });
        let mode = self.mode.settings();
        let thread = json!({
            "approvalPolicy": mode["approvalPolicy"],
            "approvalsReviewer": mode["approvalsReviewer"],
            "sandbox": "workspace-write",
        });
        vec![
            self.request(Asked::Initialize, "initialize", client),
            json!({ "method": "initialized" }).to_string(),
            self.request(Asked::Thread, "thread/start", thread),
            self.request(Asked::Account, "account/read", json!({})),
            self.request(Asked::Models, "model/list", json!({})),
        ]
    }

    /// One user message. During a turn the agent adds it to that turn (AC.3 measurement).
    pub fn user_message(&mut self, message: &str) -> Result<String, String> {
        let thread = self
            .thread
            .clone()
            .ok_or("에이전트가 아직 시작하는 중입니다. 잠시 뒤 다시 보내세요.")?;
        let mut params = self.mode.settings();
        params["threadId"] = json!(thread);
        params["input"] = json!([{ "type": "text", "text": message, "text_elements": [] }]);
        if let Some(model) = &self.chosen {
            params["model"] = json!(model);
        }
        if let Some(effort) = &self.effort {
            params["effort"] = json!(effort);
        }
        let steering = self.turn.is_some();
        Ok(self.request(Asked::Turn { steering }, "turn/start", params))
    }

    /// Stops the running turn, or nothing when none runs.
    pub fn interrupt_message(&mut self) -> Option<String> {
        let params = json!({ "threadId": self.thread.clone()?, "turnId": self.turn.clone()? });
        Some(self.request(Asked::Interrupt, "turn/interrupt", params))
    }

    pub fn usage_message(&mut self) -> String {
        self.request(Asked::Limits, "account/rateLimits/read", Value::Null)
    }

    /// The model for the next turns. Codex lists models by plain names.
    pub fn set_model(&mut self, model: &str) -> Result<(), &'static str> {
        let fine = !model.is_empty()
            && model.len() <= 64
            && model
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
        if !fine {
            return Err("모델 이름을 확인하세요.");
        }
        self.chosen = Some(model.to_string());
        Ok(())
    }

    pub fn set_effort(&mut self, level: &str) -> Result<ChatEvent, &'static str> {
        if level.is_empty() || level.len() > 16 || !level.chars().all(|c| c.is_ascii_lowercase()) {
            return Err("알 수 없는 노력 수준입니다.");
        }
        self.effort = Some(level.to_string());
        Ok(ChatEvent::Effort {
            level: level.into(),
        })
    }

    pub fn set_mode(&mut self, mode: &str) -> Result<ChatEvent, &'static str> {
        self.mode = Mode::of(mode).ok_or("알 수 없는 권한 모드입니다.")?;
        Ok(ChatEvent::Mode {
            mode: self.mode.name().into(),
        })
    }

    pub fn read(&mut self, line: &str) -> Vec<ChatEvent> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return vec![];
        };
        match (value["method"].as_str(), value.get("id")) {
            (Some(method), Some(id)) => self.asks(method, id, &value["params"]),
            (Some(method), None) => self.notified(method, &value["params"]),
            (None, Some(id)) => self.answered(id, &value),
            _ => vec![],
        }
    }

    /// Whether a notification is about the conversation itself rather than a subagent's thread.
    fn main(&self, params: &Value) -> bool {
        self.thread.is_some() && params["threadId"].as_str() == self.thread.as_deref()
    }

    fn answered(&mut self, id: &Value, value: &Value) -> Vec<ChatEvent> {
        let Some(asked) = id.as_u64().and_then(|id| self.asked.remove(&id)) else {
            return vec![];
        };
        if let Some(error) = value.get("error") {
            let message = cut(error["message"].as_str().unwrap_or("오류"), MAX_DETAIL);
            return match asked {
                Asked::Thread => vec![ChatEvent::Problem {
                    text: format!("대화를 시작하지 못했습니다. {message}"),
                }],
                Asked::Turn { steering: false } => vec![ChatEvent::TurnFinished {
                    ok: false,
                    detail: Some(message),
                }],
                Asked::Turn { steering: true } => vec![ChatEvent::Problem {
                    text: format!("메시지를 전하지 못했습니다. {message}"),
                }],
                Asked::Interrupt => vec![ChatEvent::Problem {
                    text: format!("중지하지 못했습니다. {message}"),
                }],
                // The chat works without these; their indicators stay empty.
                Asked::Initialize | Asked::Account | Asked::Models | Asked::Limits => vec![],
            };
        }
        let result = &value["result"];
        match asked {
            Asked::Thread => {
                let session = text(&result["thread"], "id");
                self.thread = Some(session.clone());
                self.model = text(result, "model");
                let mut events = vec![
                    ChatEvent::Started {
                        session,
                        model: self.model.clone(),
                    },
                    ChatEvent::Mode {
                        mode: self.mode.name().into(),
                    },
                ];
                if let Some(level) = result["reasoningEffort"].as_str() {
                    events.push(ChatEvent::Effort {
                        level: level.into(),
                    });
                }
                events
            }
            Asked::Account => {
                let account = &result["account"];
                self.account = Some(Account {
                    plan: text(account, "planType"),
                    email: text(account, "email"),
                });
                vec![]
            }
            Asked::Models => vec![ChatEvent::Capabilities {
                models: models(&result["data"]),
                commands: vec![],
                agents: vec![],
                permission_mode: self.mode.name().into(),
                account: self.account.clone().unwrap_or(Account {
                    plan: String::new(),
                    email: String::new(),
                }),
            }],
            Asked::Limits => {
                let limits = limits(&result["rateLimits"]);
                if limits.is_empty() {
                    return vec![];
                }
                vec![ChatEvent::Limits { limits }]
            }
            Asked::Turn { steering: false } if result["turn"]["status"] == "inProgress" => {
                // Known here before `turn/started`, so a stop right away reaches the turn.
                self.turn.get_or_insert_with(|| text(&result["turn"], "id"));
                vec![]
            }
            _ => vec![],
        }
    }

    fn notified(&mut self, method: &str, params: &Value) -> Vec<ChatEvent> {
        match method {
            "account/rateLimits/updated" => {
                let limits = limits(&params["rateLimits"]);
                if limits.is_empty() {
                    return vec![];
                }
                vec![ChatEvent::Limits { limits }]
            }
            // Subagents run in threads of their own; their turns and items are theirs (AC.0).
            _ if !self.main(params) => vec![],
            "turn/started" => {
                self.turn = Some(text(&params["turn"], "id"));
                self.at_turn_start = self.total;
                vec![]
            }
            "turn/completed" => {
                self.turn = None;
                let turn = &params["turn"];
                let (now, then) = (self.total, self.at_turn_start);
                let usage = ChatEvent::TurnUsage {
                    input: now.input.saturating_sub(then.input),
                    cache_read: now.cached.saturating_sub(then.cached),
                    cache_write: now.cache_write.saturating_sub(then.cache_write),
                    output: now.output.saturating_sub(then.output),
                    cost: 0.0,
                };
                let detail = match turn["status"].as_str() {
                    Some("completed") => None,
                    Some("interrupted") => Some("중지되었습니다.".to_string()),
                    _ => Some(cut(
                        turn["error"]["message"].as_str().unwrap_or("실패했습니다."),
                        MAX_DETAIL,
                    )),
                };
                vec![
                    usage,
                    ChatEvent::TurnFinished {
                        ok: detail.is_none(),
                        detail,
                    },
                ]
            }
            "item/agentMessage/delta" => match params["delta"].as_str() {
                Some(delta) if !delta.is_empty() => {
                    vec![ChatEvent::TextDelta { text: delta.into() }]
                }
                _ => vec![],
            },
            "item/started" => self.item_started(&params["item"]),
            "item/completed" => self.item_completed(&params["item"]),
            "thread/tokenUsage/updated" => {
                let usage = &params["tokenUsage"];
                self.total = Tokens::of(&usage["total"]);
                let used = usage["last"]["totalTokens"].as_u64().unwrap_or_default();
                let Some(max) = usage["modelContextWindow"].as_u64().filter(|m| *m > 0) else {
                    return vec![];
                };
                vec![ChatEvent::Context {
                    model: self.model.clone(),
                    percentage: (used.saturating_mul(100) / max).min(100) as u32,
                    used,
                    max,
                    parts: vec![],
                }]
            }
            _ => vec![],
        }
    }
}

mod items;
#[cfg(test)]
mod tests;
