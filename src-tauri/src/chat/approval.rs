//! Approvals (AC.5). With `--permission-prompt-tool stdio` the agent asks before a tool call that
//! needs one, as a `can_use_tool` control request, and waits. The app answers with the call's own
//! input: allowed as it is, allowed with the user's answers to a question, or refused.
//! Shapes measured with claude 2.1.319 (docs/verification/agent-chat.md).
use super::event::{ChatEvent, Question, QuestionOption};
use serde_json::{Value, json};
use std::collections::HashMap;

const MAX_TEXT: usize = 2000;

fn cut(text: &str) -> String {
    text.chars().take(MAX_TEXT).collect()
}

/// The choices of the question tool, which asks the user rather than asking to run something.
fn questions(input: &Value) -> Vec<Question> {
    input["questions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|q| {
            Some(Question {
                question: q["question"].as_str()?.to_string(),
                header: q["header"].as_str().unwrap_or_default().to_string(),
                multi: q["multiSelect"].as_bool().unwrap_or(false),
                options: q["options"]
                    .as_array()?
                    .iter()
                    .filter_map(|o| {
                        Some(QuestionOption {
                            label: o["label"].as_str()?.to_string(),
                            detail: o["description"].as_str().unwrap_or_default().to_string(),
                        })
                    })
                    .collect(),
            })
        })
        .collect()
}

/// A `can_use_tool` request as a chat event. `summary` and `edit` read the input as the step line
/// does, so the card and the step say the same thing.
pub fn asked(
    request_id: &str,
    request: &Value,
    summary: impl Fn(&str, &Value) -> String,
    edit: impl Fn(&str, &Value) -> Option<super::event::Edit>,
) -> ChatEvent {
    let tool = request["tool_name"].as_str().unwrap_or_default();
    let input = &request["input"];
    ChatEvent::ApprovalAsked {
        request: request_id.to_string(),
        tool: tool.to_string(),
        summary: summary(tool, input),
        detail: cut(request["description"].as_str().unwrap_or_default()),
        edit: edit(tool, input),
        questions: questions(input),
        input: input.clone(),
    }
}

/// What the user decided. `answers` maps each question to the chosen labels, joined by ", ".
pub enum Decision {
    Allow,
    Answer(HashMap<String, String>),
    Deny,
}

/// The control response for a request, given the input the agent asked with.
pub fn answer_message(request_id: &str, input: &Value, decision: Decision) -> String {
    let response = match decision {
        Decision::Allow => json!({ "behavior": "allow", "updatedInput": input }),
        Decision::Answer(answers) => {
            let mut input = input.clone();
            if let Some(fields) = input.as_object_mut() {
                fields.insert("answers".into(), json!(answers));
            }
            json!({ "behavior": "allow", "updatedInput": input })
        }
        Decision::Deny => json!({ "behavior": "deny", "message": "사용자가 거부했습니다." }),
    };
    json!({
        "type": "control_response",
        "response": { "subtype": "success", "request_id": request_id, "response": response },
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question_request() -> Value {
        json!({
            "subtype": "can_use_tool",
            "tool_name": "AskUserQuestion",
            "input": { "questions": [{
                "question": "Which colour?", "header": "Colour", "multiSelect": false,
                "options": [{ "label": "Red", "description": "Pick Red" }, { "label": "Blue" }]
            }]},
            "tool_use_id": "t1"
        })
    }

    #[test]
    fn reads_a_question_and_answers_it_in_its_input() {
        let ChatEvent::ApprovalAsked {
            questions, input, ..
        } = asked("r1", &question_request(), |_, _| String::new(), |_, _| None)
        else {
            panic!();
        };
        assert_eq!(questions[0].options[1].label, "Blue");
        let answers = HashMap::from([("Which colour?".to_string(), "Blue".to_string())]);
        let line: Value =
            serde_json::from_str(&answer_message("r1", &input, Decision::Answer(answers))).unwrap();
        let response = &line["response"]["response"];
        assert_eq!(line["response"]["request_id"], "r1");
        assert_eq!(response["behavior"], "allow");
        assert_eq!(response["updatedInput"]["answers"]["Which colour?"], "Blue");
        assert_eq!(response["updatedInput"]["questions"][0]["header"], "Colour");
    }

    #[test]
    fn allows_with_the_same_input_or_refuses() {
        let input = json!({ "command": "rm -rf build" });
        let allow: Value =
            serde_json::from_str(&answer_message("r2", &input, Decision::Allow)).unwrap();
        assert_eq!(allow["response"]["response"]["updatedInput"], input);
        let deny: Value =
            serde_json::from_str(&answer_message("r2", &input, Decision::Deny)).unwrap();
        assert_eq!(deny["response"]["response"]["behavior"], "deny");
    }
}
