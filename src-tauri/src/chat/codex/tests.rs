use super::{items::unwrapped, *};

// Shapes recorded from codex-cli 0.156.0 (AC.3); texts and IDs replaced.
const THREAD: &str = r#"{"id":2,"result":{"thread":{"id":"th1","status":{"type":"idle"}},"model":"gpt-x","modelProvider":"openai","approvalPolicy":"on-request","approvalsReviewer":"user","sandbox":{"type":"workspaceWrite"},"reasoningEffort":"high"}}"#;
const ACCOUNT: &str = r#"{"id":3,"result":{"account":{"type":"chatgpt","email":"me@example.com","planType":"pro"},"requiresOpenaiAuth":true}}"#;
const MODELS: &str = r#"{"id":4,"result":{"data":[{"id":"gpt-x","model":"gpt-x","displayName":"GPT-X","description":"Big.","hidden":false,"supportedReasoningEfforts":[{"reasoningEffort":"low","description":""},{"reasoningEffort":"high","description":""}],"defaultReasoningEffort":"low","isDefault":true},{"id":"old","model":"old","displayName":"Old","description":"","hidden":true,"supportedReasoningEfforts":[]}],"nextCursor":null}}"#;

fn started() -> Reader {
    let mut reader = Reader::default();
    let opening = reader.opening();
    assert_eq!(opening.len(), 5);
    let methods: Vec<Value> = opening
        .iter()
        .map(|l| serde_json::from_str::<Value>(l).unwrap()["method"].clone())
        .collect();
    assert_eq!(
        methods,
        [
            "initialize",
            "initialized",
            "thread/start",
            "account/read",
            "model/list"
        ]
    );
    reader.read(r#"{"id":1,"result":{"userAgent":"x","platformOs":"linux"}}"#);
    reader
}

fn sent(line: &str) -> Value {
    serde_json::from_str(line).unwrap()
}

fn notify(method: &str, params: Value) -> String {
    json!({ "method": method, "params": params }).to_string()
}

fn item(kind: &str, thread: &str, item: Value) -> String {
    notify(
        kind,
        json!({ "threadId": thread, "turnId": "t1", "item": item }),
    )
}

#[test]
fn starts_a_thread_and_reads_what_the_agent_offers() {
    let mut reader = started();
    assert!(reader.user_message("hi").is_err(), "no thread yet");
    assert_eq!(
        reader.read(THREAD),
        [
            ChatEvent::Started {
                session: "th1".into(),
                model: "gpt-x".into()
            },
            ChatEvent::Mode {
                mode: "default".into()
            },
            ChatEvent::Effort {
                level: "high".into()
            },
        ]
    );
    assert!(reader.read(ACCOUNT).is_empty());
    let [
        ChatEvent::Capabilities {
            models,
            permission_mode,
            account,
            ..
        },
    ] = &reader.read(MODELS)[..]
    else {
        panic!();
    };
    assert_eq!(models.len(), 1, "hidden models are left out");
    assert_eq!(models[0].label, "GPT-X");
    assert_eq!(models[0].levels, ["low", "high"]);
    assert_eq!(permission_mode, "default");
    assert_eq!(account.plan, "pro");
}

#[test]
fn a_message_starts_a_turn_with_the_chosen_settings_and_joins_a_running_one() {
    let mut reader = started();
    reader.read(THREAD);
    reader.set_model("gpt-y").unwrap();
    assert!(reader.set_model("bad name").is_err());
    reader.set_effort("low").unwrap();
    assert_eq!(
        reader.set_mode("bypassPermissions").unwrap(),
        ChatEvent::Mode {
            mode: "bypassPermissions".into()
        }
    );
    assert!(reader.set_mode("acceptEdits").is_err());
    let first = sent(&reader.user_message("hello").unwrap());
    assert_eq!(first["method"], "turn/start");
    let params = &first["params"];
    assert_eq!(params["threadId"], "th1");
    assert_eq!(params["input"][0]["text"], "hello");
    assert_eq!(params["model"], "gpt-y");
    assert_eq!(params["effort"], "low");
    assert_eq!(params["approvalPolicy"], "never");
    assert_eq!(params["sandboxPolicy"]["type"], "dangerFullAccess");
    // The answer names the turn before `turn/started` does; a stop reaches it at once.
    let answer =
        json!({ "id": first["id"], "result": { "turn": { "id": "t1", "status": "inProgress" } } });
    assert!(reader.read(&answer.to_string()).is_empty());
    let stop = sent(&reader.interrupt_message().unwrap());
    assert_eq!(stop["params"], json!({ "threadId": "th1", "turnId": "t1" }));
    // A second message while the turn runs joins it; a refusal then is only a problem.
    let second = sent(&reader.user_message("also").unwrap());
    let refused = json!({ "id": second["id"], "error": { "code": -32600, "message": "busy" } });
    assert_eq!(
        reader.read(&refused.to_string()),
        [ChatEvent::Problem {
            text: "메시지를 전하지 못했습니다. busy".into()
        }]
    );
}

#[test]
fn a_refused_first_message_ends_the_turn() {
    let mut reader = started();
    reader.read(THREAD);
    let line = sent(&reader.user_message("hello").unwrap());
    let refused = json!({ "id": line["id"], "error": { "message": "no" } });
    assert_eq!(
        reader.read(&refused.to_string()),
        [ChatEvent::TurnFinished {
            ok: false,
            detail: Some("no".into())
        }]
    );
    assert!(reader.interrupt_message().is_none(), "no turn to stop");
}

#[test]
fn reads_a_turn_of_the_main_thread_only() {
    let mut reader = started();
    reader.read(THREAD);
    let turn = |status: &str| json!({ "id": "t1", "status": status, "error": null });
    reader.read(&notify(
        "turn/started",
        json!({ "threadId": "th1", "turn": turn("inProgress") }),
    ));
    let delta = json!({ "threadId": "th1", "turnId": "t1", "itemId": "m1", "delta": "안" });
    assert_eq!(
        reader.read(&notify("item/agentMessage/delta", delta)),
        [ChatEvent::TextDelta { text: "안".into() }]
    );
    let message =
        json!({ "type": "agentMessage", "id": "m1", "text": "안녕", "phase": "final_answer" });
    assert_eq!(
        reader.read(&item("item/completed", "th1", message.clone())),
        [ChatEvent::Text {
            text: "안녕".into()
        }]
    );
    // A subagent's thread has items and turns of its own.
    assert!(
        reader
            .read(&item("item/completed", "sub", message))
            .is_empty()
    );
    let sub_done = json!({ "threadId": "sub", "turn": turn("completed") });
    assert!(reader.read(&notify("turn/completed", sub_done)).is_empty());
    let usage = |input: u64, output: u64| {
        let tokens = json!({ "totalTokens": input + output, "inputTokens": input, "cachedInputTokens": 10, "cacheWriteInputTokens": 0, "outputTokens": output, "reasoningOutputTokens": 0 });
        json!({ "threadId": "th1", "turnId": "t1", "tokenUsage": { "total": tokens, "last": tokens, "modelContextWindow": 1000 } })
    };
    assert_eq!(
        reader.read(&notify("thread/tokenUsage/updated", usage(240, 10))),
        [ChatEvent::Context {
            model: "gpt-x".into(),
            percentage: 25,
            used: 250,
            max: 1000,
            parts: vec![]
        }]
    );
    let done = json!({ "threadId": "th1", "turn": turn("completed") });
    assert_eq!(
        reader.read(&notify("turn/completed", done)),
        [
            ChatEvent::TurnUsage {
                input: 240,
                cache_read: 10,
                cache_write: 0,
                output: 10,
                cost: 0.0
            },
            ChatEvent::TurnFinished {
                ok: true,
                detail: None
            }
        ]
    );
    let stopped = json!({ "threadId": "th1", "turn": turn("interrupted") });
    let [_, ChatEvent::TurnFinished { ok: false, detail }] =
        &reader.read(&notify("turn/completed", stopped))[..]
    else {
        panic!();
    };
    assert_eq!(detail.as_deref(), Some("중지되었습니다."));
}

#[test]
fn a_command_its_approval_and_a_refusal() {
    let mut reader = started();
    reader.read(THREAD);
    let command = json!({ "type": "commandExecution", "id": "e1", "command": "/bin/zsh -lc 'curl -sI https://example.com | head -1'", "status": "inProgress", "aggregatedOutput": null, "exitCode": null });
    assert_eq!(
        reader.read(&item("item/started", "th1", command)),
        [ChatEvent::ToolStarted {
            id: "e1".into(),
            name: "Bash".into(),
            summary: "curl -sI https://example.com | head -1".into(),
            edit: None
        }]
    );
    let ask = r#"{"method":"item/commandExecution/requestApproval","id":0,"params":{"kind":"command","threadId":"th1","turnId":"t1","itemId":"e1","reason":"Allow network?","command":"/bin/zsh -lc 'curl -sI https://example.com | head -1'","availableDecisions":["accept","cancel"]}}"#;
    let [
        ChatEvent::ApprovalAsked {
            request,
            tool,
            summary,
            detail,
            input,
            ..
        },
    ] = &reader.read(ask)[..]
    else {
        panic!();
    };
    assert_eq!((request.as_str(), tool.as_str()), ("codex-0", "Bash"));
    assert_eq!(summary, "curl -sI https://example.com | head -1");
    assert_eq!(detail, "Allow network?");
    assert_eq!(
        sent(&answer_message(input, Decision::Deny)),
        json!({ "id": 0, "result": { "decision": "decline" } })
    );
    assert_eq!(
        sent(&answer_message(input, Decision::Allow))["result"]["decision"],
        "accept"
    );
    let declined = json!({ "type": "commandExecution", "id": "e1", "command": "x", "status": "declined", "aggregatedOutput": null, "exitCode": null });
    assert_eq!(
        reader.read(&item("item/completed", "th1", declined)),
        [ChatEvent::ToolFinished {
            id: "e1".into(),
            ok: false,
            output: "실행하지 않았습니다.".into()
        }]
    );
    let failed = json!({ "type": "commandExecution", "id": "e2", "command": "false", "status": "failed", "aggregatedOutput": "", "exitCode": 1 });
    let [
        ChatEvent::ToolFinished {
            ok: false, output, ..
        },
    ] = &reader.read(&item("item/completed", "th1", failed))[..]
    else {
        panic!();
    };
    assert_eq!(output, "종료 코드 1");
}

#[test]
fn a_file_change_names_its_files_on_the_card() {
    let mut reader = started();
    reader.read(THREAD);
    let change = json!({ "type": "fileChange", "id": "f1", "status": "inProgress", "changes": [{ "path": "/w/a.txt", "kind": { "type": "add" }, "diff": "+ok" }] });
    reader.read(&item("item/started", "th1", change.clone()));
    let ask = json!({ "method": "item/fileChange/requestApproval", "id": "r7", "params": { "threadId": "th1", "turnId": "t1", "itemId": "f1", "reason": null } });
    let [
        ChatEvent::ApprovalAsked {
            request,
            tool,
            summary,
            ..
        },
    ] = &reader.read(&ask.to_string())[..]
    else {
        panic!();
    };
    assert_eq!(
        (request.as_str(), tool.as_str(), summary.as_str()),
        ("codex-r7", "Edit", "/w/a.txt")
    );
    let mut done = change;
    done["status"] = json!("completed");
    assert_eq!(
        reader.read(&item("item/completed", "th1", done)),
        [ChatEvent::ToolFinished {
            id: "f1".into(),
            ok: true,
            output: "/w/a.txt\n+ok".into()
        }]
    );
}

#[test]
fn answers_a_question_by_its_id() {
    let mut reader = started();
    let ask = json!({ "method": "item/tool/requestUserInput", "id": 9, "params": { "threadId": "th1", "turnId": "t1", "itemId": "q", "isBlocking": true, "questions": [{ "id": "colour", "header": "Colour", "question": "Which colour?", "isOther": false, "isSecret": false, "options": [{ "label": "Red", "description": "warm" }, { "label": "Blue", "description": "" }] }] } });
    let [
        ChatEvent::ApprovalAsked {
            questions, input, ..
        },
    ] = &reader.read(&ask.to_string())[..]
    else {
        panic!();
    };
    assert_eq!(questions[0].options[1].label, "Blue");
    let answers = HashMap::from([("Which colour?".to_string(), "Blue".to_string())]);
    assert_eq!(
        sent(&answer_message(input, Decision::Answer(answers))),
        json!({ "id": 9, "result": { "answers": { "colour": { "answers": ["Blue"] } } } })
    );
}

#[test]
fn follows_subagents_and_usage_windows() {
    let mut reader = started();
    reader.read(THREAD);
    let call = json!({ "type": "collabAgentToolCall", "id": "c1", "tool": "spawn", "status": "completed", "senderThreadId": "th1", "receiverThreadIds": ["sub"], "prompt": "look around" });
    reader.read(&item("item/completed", "th1", call));
    let activity = |kind: &str| json!({ "type": "subAgentActivity", "id": format!("a-{kind}"), "kind": kind, "agentThreadId": "sub", "agentPath": "explorer" });
    let started = reader.read(&item("item/started", "th1", activity("started")));
    assert_eq!(
        started,
        [ChatEvent::AgentStarted {
            id: "sub".into(),
            call: "c1".into(),
            role: "explorer".into(),
            task: String::new()
        }]
    );
    assert!(
        reader
            .read(&item("item/completed", "th1", activity("started")))
            .is_empty()
    );
    assert_eq!(
        reader.read(&item("item/completed", "th1", activity("completed"))),
        [ChatEvent::AgentFinished {
            id: "sub".into(),
            ok: true,
            summary: String::new()
        }]
    );
    let limits = notify(
        "account/rateLimits/updated",
        json!({ "rateLimits": { "primary": { "usedPercent": 64, "windowDurationMins": 10080, "resetsAt": 1794403881 }, "secondary": null } }),
    );
    assert_eq!(
        reader.read(&limits),
        [ChatEvent::Limits {
            limits: vec![Limit {
                name: "seven_day".into(),
                percent: 64.0,
                resets_at: "1794403881".into()
            }]
        }]
    );
}

#[test]
fn a_shell_wrapper_is_taken_off_only_when_it_is_one() {
    assert_eq!(unwrapped("/bin/zsh -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
    assert_eq!(unwrapped("bash -c 'ls'"), "ls");
    assert_eq!(unwrapped("git log -c 'x'"), "git log -c 'x'");
    assert_eq!(unwrapped("ls -la"), "ls -la");
}

/// Events of the real CLI until one matches, or none within the time a small turn takes.
async fn until(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<ChatEvent>,
    seen: &mut Vec<ChatEvent>,
    done: impl Fn(&ChatEvent) -> bool,
) {
    let wait = async {
        while let Some(event) = events.recv().await {
            let found = done(&event);
            seen.push(event);
            if found {
                return;
            }
        }
        panic!("the agent stopped: {seen:?}");
    };
    tokio::time::timeout(std::time::Duration::from_secs(180), wait)
        .await
        .unwrap_or_else(|_| panic!("no answer in time: {seen:?}"));
}

/// The real CLI through the pipes a chat on this PC uses: the opening sent at once, a turn, its
/// end. It spends one small turn of the logged-in account.
#[tokio::test]
#[ignore = "needs codex installed and logged in; cargo test real_codex -- --ignored"]
async fn real_codex_round_trip() {
    use crate::chat::local;
    use std::{
        ops::ControlFlow,
        sync::{Arc, Mutex},
    };
    let folder =
        std::env::temp_dir().join(format!("dachsterm-codex-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&folder).unwrap();
    let program = local::locate(PROGRAM).unwrap();
    let (agent, stdout, _stderr) = local::start(&program, &arguments(), &folder).unwrap();
    let reader = Arc::new(Mutex::new(Reader::default()));
    let (sender, mut events) = tokio::sync::mpsc::unbounded_channel();
    let reading = {
        let reader = reader.clone();
        tokio::spawn(local::read_lines(stdout, move |line| {
            for event in reader.lock().unwrap().read(line) {
                let _ = sender.send(event);
            }
            ControlFlow::Continue(())
        }))
    };
    let opening = reader.lock().unwrap().opening();
    for line in opening {
        agent.send(&line).await.unwrap();
    }
    let mut seen = vec![];
    until(&mut events, &mut seen, |e| {
        matches!(e, ChatEvent::Capabilities { .. })
    })
    .await;
    assert!(
        seen.iter()
            .any(|e| matches!(e, ChatEvent::Started { session, .. } if !session.is_empty()))
    );
    let line = {
        let mut reader = reader.lock().unwrap();
        reader.set_effort("low").unwrap();
        reader
            .user_message("Reply with exactly one word: pong. Do not run any tools.")
            .unwrap()
    };
    agent.send(&line).await.unwrap();
    until(&mut events, &mut seen, |e| {
        matches!(e, ChatEvent::TurnFinished { .. })
    })
    .await;
    agent.stop();
    reading.abort();
    let _ = std::fs::remove_dir_all(&folder);
    assert!(
        seen.iter()
            .any(|e| matches!(e, ChatEvent::TurnFinished { ok: true, .. })),
        "{seen:?}"
    );
    assert!(
        seen.iter()
            .any(|e| matches!(e, ChatEvent::Text { text } if text.to_lowercase().contains("pong"))),
        "{seen:?}"
    );
}
