//! The agent CLIs a chat can run (design §2.2). Everything that differs between them is decided
//! here, so the commands in `chat.rs` stay the same for both.
use super::{approval::Decision, claude, codex, event::ChatEvent};
use crate::storage::Result;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Program {
    Claude,
    Codex,
}

impl Program {
    pub fn of(name: &str) -> Result<Self> {
        match name {
            claude::PROGRAM => Ok(Self::Claude),
            codex::PROGRAM => Ok(Self::Codex),
            _ => Err("알 수 없는 에이전트 프로그램입니다.".into()),
        }
    }
    /// The command name, as the user installed it.
    pub fn name(self) -> &'static str {
        match self {
            Self::Claude => claude::PROGRAM,
            Self::Codex => codex::PROGRAM,
        }
    }
    /// Arguments after the program's path.
    pub fn arguments(self) -> Vec<String> {
        match self {
            Self::Claude => claude::arguments(),
            Self::Codex => codex::arguments(),
        }
    }
    pub fn reader(self) -> Reader {
        match self {
            Self::Claude => Reader::Claude(Default::default()),
            Self::Codex => Reader::Codex(Box::default()),
        }
    }
}

/// What a request from the chat comes to: a line for the agent, an event the chat shows at once
/// because the agent takes the setting only with the next turn, or nothing to do.
pub enum Change {
    Line(String),
    Event(ChatEvent),
    Nothing,
}

/// The agent's output reader, which also builds what is sent to the agent: Codex requests name the
/// thread and turn its output named.
pub enum Reader {
    Claude(claude::Reader),
    Codex(Box<codex::Reader>),
}

impl Reader {
    pub fn read(&mut self, line: &str) -> Vec<ChatEvent> {
        match self {
            Self::Claude(reader) => reader.read(line),
            Self::Codex(reader) => reader.read(line),
        }
    }

    /// The lines that start the conversation once the agent runs.
    pub fn opening(&mut self) -> Vec<String> {
        match self {
            Self::Claude(_) => vec![claude::initialize_message(), claude::settings_message()],
            Self::Codex(reader) => reader.opening(),
        }
    }

    pub fn user_message(&mut self, text: &str) -> Result<String> {
        match self {
            Self::Claude(_) => Ok(claude::user_message(text)),
            Self::Codex(reader) => reader.user_message(text),
        }
    }

    pub fn interrupt(&mut self) -> Change {
        match self {
            Self::Claude(_) => Change::Line(claude::interrupt_message()),
            Self::Codex(reader) => reader
                .interrupt_message()
                .map_or(Change::Nothing, Change::Line),
        }
    }

    /// Asks how full the context is. Codex reports it after every request on its own.
    pub fn context(&mut self) -> Change {
        match self {
            Self::Claude(_) => Change::Line(claude::context_message()),
            Self::Codex(_) => Change::Nothing,
        }
    }

    pub fn usage(&mut self) -> Change {
        match self {
            Self::Claude(_) => Change::Line(claude::usage_message()),
            Self::Codex(reader) => Change::Line(reader.usage_message()),
        }
    }

    pub fn model(&mut self, model: &str) -> Result<Change> {
        match self {
            Self::Claude(_) => match claude::model_problem(model) {
                Some(problem) => Err(problem.into()),
                None => Ok(Change::Line(claude::model_message(model))),
            },
            Self::Codex(reader) => {
                reader.set_model(model)?;
                Ok(Change::Nothing)
            }
        }
    }

    pub fn effort(&mut self, level: &str) -> Result<Change> {
        match self {
            Self::Claude(_) => claude::effort_message(level)
                .map(Change::Line)
                .ok_or_else(|| "알 수 없는 노력 수준입니다.".into()),
            Self::Codex(reader) => Ok(Change::Event(reader.set_effort(level)?)),
        }
    }

    pub fn mode(&mut self, mode: &str) -> Result<Change> {
        match self {
            Self::Claude(_) => claude::mode_message(mode)
                .map(Change::Line)
                .ok_or_else(|| "알 수 없는 권한 모드입니다.".into()),
            Self::Codex(reader) => Ok(Change::Event(reader.set_mode(mode)?)),
        }
    }

    pub fn ultracode(&mut self, on: bool) -> Result<Change> {
        match self {
            Self::Claude(_) => Ok(Change::Line(claude::ultracode_message(on))),
            Self::Codex(_) => Err("이 에이전트에서는 쓸 수 없습니다.".into()),
        }
    }

    /// The answer to an approval, given the input the request was kept with.
    pub fn answer(&self, request: &str, input: &Value, decision: Decision) -> String {
        match self {
            Self::Claude(_) => super::approval::answer_message(request, input, decision),
            Self::Codex(_) => codex::answer_message(input, decision),
        }
    }
}
