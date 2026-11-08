//! What a terminal connection tells its window.
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Replay {
        active: bool,
    },
    AuthPrompt {
        challenge: String,
        name: String,
        instructions: String,
        prompts: Vec<AuthPrompt>,
    },
    State {
        status: String,
        message: String,
    },
    HostKey {
        challenge: String,
        host: String,
        port: u16,
        algorithm: String,
        fingerprint: String,
    },
    Data {
        seq: u64,
        bytes: Vec<u8>,
    },
    AgentSign(crate::agent_forward::SignRequest),
    /// Also says why HTTPS Git credentials are refused (DX.12). Like the requests, it is never
    /// replayed to another window.
    AgentNotice {
        message: String,
    },
    GitCredential(crate::git_credential::CredentialRequest),
}
#[derive(Clone, Serialize)]
pub struct AuthPrompt {
    pub prompt: String,
    pub echo: bool,
}
