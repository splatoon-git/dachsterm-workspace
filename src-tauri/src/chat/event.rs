use serde::Serialize;

/// What a chat tab shows, the same whichever agent CLI produced it (design §2.2).
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ChatEvent {
    /// The agent's session began, or a new one replaced it.
    Started { session: String, model: String },
    /// More of the agent's reply as it is written. A `Text` for the same block follows.
    TextDelta { text: String },
    /// A finished piece of the agent's reply. It replaces the deltas written for it.
    Text { text: String },
    /// The agent began (`done: false`) or finished thinking.
    Thinking { done: bool },
    /// The agent called a tool. `summary` is one line: the command, file or pattern.
    ToolStarted {
        id: String,
        name: String,
        summary: String,
        edit: Option<Edit>,
    },
    /// A tool call's result, cut to a length a chat can show.
    ToolFinished {
        id: String,
        ok: bool,
        output: String,
    },
    /// What the agent offers, from its answer to `initialize`. Of the account only the plan and the
    /// address reach the screen, as the CLI's own status shows them.
    Capabilities {
        models: Vec<Choice>,
        commands: Vec<Choice>,
        agents: Vec<Choice>,
        permission_mode: String,
        account: Account,
    },
    /// The effort level in use: `low` to `max`.
    Effort { level: String },
    /// The permission mode in use after a change.
    Mode { mode: String },
    /// The session's cost and edits so far, and the account's usage limits.
    Usage {
        cost: f64,
        added: u64,
        removed: u64,
        limits: Vec<Limit>,
    },
    /// The account's usage limits as the agent reports them during a turn.
    Limits { limits: Vec<Limit> },
    /// What the last turn used, cache included.
    TurnUsage {
        input: u64,
        cache_read: u64,
        cache_write: u64,
        output: u64,
        cost: f64,
    },
    /// How full the context window is, in whole percent, with what takes the room. `model` is the
    /// one in use, known here before the first turn reports it.
    Context {
        model: String,
        percentage: u32,
        used: u64,
        max: u64,
        parts: Vec<ContextPart>,
    },
    /// A subagent started. `role` is its type, `task` what it was asked.
    AgentStarted {
        id: String,
        /// The tool call that started it, so the chat can show it under that step.
        call: String,
        role: String,
        task: String,
    },
    AgentFinished {
        id: String,
        ok: bool,
        summary: String,
    },
    /// The agent waits for the user before a tool call. `input` stays here, for the answer.
    ApprovalAsked {
        request: String,
        tool: String,
        summary: String,
        detail: String,
        edit: Option<Edit>,
        /// The question tool's questions, empty for any other tool.
        questions: Vec<Question>,
        #[serde(skip)]
        input: serde_json::Value,
    },
    /// A request to the agent failed, such as a model change. `text` says which and why.
    Problem { text: String },
    /// The turn is over. `detail` says why when it failed.
    TurnFinished { ok: bool, detail: Option<String> },
    /// The agent will say nothing more on this attach: it exited, or the connection went.
    Ended {
        reason: EndReason,
        detail: Option<String>,
    },
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum EndReason {
    /// The agent process exited. `detail` is the end of its error output.
    Exited,
    /// The SSH connection broke. The agent keeps running on the server.
    Disconnected,
    /// Its output could not be read, for example a line beyond the size limit.
    Unreadable,
}

/// A file edit as the agent asked for it: the text it replaces and the new text, both cut short.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub path: String,
    pub before: String,
    pub after: String,
}

/// One thing the user can pick: a model, a command or an agent. `hint` is a command's arguments,
/// or the full model name a model choice stands for.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub value: String,
    pub label: String,
    pub detail: String,
    pub hint: String,
    /// A model's effort levels. Empty for anything else.
    pub levels: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// The subscription, such as `Claude Max`. Empty when the agent uses an API key.
    pub plan: String,
    pub email: String,
}

/// One usage window: `five_hour` or `seven_day`, how much is used and when it starts over.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub name: String,
    pub percent: f64,
    /// RFC 3339, or Unix seconds as the agent's own events give it.
    pub resets_at: String,
}

/// A share of the context window. `free` marks room still unused.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextPart {
    pub name: String,
    pub tokens: u64,
    pub free: bool,
}

/// One question of the agent's question tool. `multi` allows more than one option.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub question: String,
    pub header: String,
    pub multi: bool,
    pub options: Vec<QuestionOption>,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub detail: String,
}
