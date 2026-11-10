use serde::Serialize;

/// What a chat tab shows, the same whichever agent CLI produced it (design §2.2).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ChatEvent {
    /// The agent's session began, or a new one replaced it.
    Started { session: String, model: String },
    /// A finished piece of the agent's reply.
    Text { text: String },
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
