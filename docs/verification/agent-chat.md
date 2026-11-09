# 에이전트 채팅 검증 기록

[설계안](../design/agent-chat.md)의 실행 결과를 적는다.

## AC.0 실측 (2026-11-09)

- **환경:** macOS 26(Darwin 25.5), `claude` 2.1.319, `codex-cli` 0.156.0. 사용자 본인 로그인. 임시 폴더에서 실행했고 Claude 모델은 `haiku`, Codex는 기본 모델이다.
- **범위:** 로컬 프로세스의 stdin/stdout 파이프로 CLI를 직접 구동했다. **실제 SSH 채널은 거치지 않았다.** 파이프를 닫아 끊김을 흉내 냈으므로 sshd의 실제 동작은 대기다.
- **승인 측정 조건:** 처음 실행은 사용자 설정(허용 목록·훅)이 승인을 처리해 승인 요청이 나오지 않았다. 승인·대기열·중단은 `--setting-sources project --permission-mode manual`로 다시 쟀다.

### Claude (`claude -p --input-format stream-json --output-format stream-json --verbose`)

| 항목 | 결과 |
|---|---|
| 초기화 | `control_request` `initialize`에 `control_response`로 명령 목록 등이 온다 |
| 한 프로세스의 여러 턴 | 된다. 턴마다 `system/init`과 `result`가 온다 |
| 스트리밍 | `--include-partial-messages`로 `stream_event`가 오고 `parent_tool_use_id`가 붙는다 |
| 승인 요청 | `--permission-prompt-tool stdio`면 `control_request` `can_use_tool`이 온다. 키: `tool_name`, `input`, `description`, `display_name`, `tool_use_id`, `blocked_path`, `permission_suggestions` |
| 허용 | `{behavior:"allow", updatedInput}`로 명령이 실행됐다 |
| 거부 | `{behavior:"deny", message}`로 실행되지 않았고 `tool_result`가 오류로 왔다. 파일도 생기지 않았다 |
| 작업 중 입력 | 도구 실행 중 보낸 사용자 메시지는 **같은 턴에 합쳐졌다**(`result` 1건, 답은 뒤 지시를 반영) |
| 중단 | `control_request` `interrupt`에 즉시 응답(`still_queued: []`). `result` `error_during_execution`, 실행 중이던 명령의 뒤 동작은 일어나지 않았다 |
| 서브에이전트 | `system/task_started`(`task_id`, `tool_use_id`, `subagent_type`, `description`, `spawn_depth`, `task_type:"local_agent"`), `task_updated`, `task_notification`(`status`, `summary`, `usage`). 서브의 메시지에는 시작한 도구 호출 ID가 `parent_tool_use_id`로 붙는다(`--forward-subagent-text`) |
| 백그라운드 명령 | `task_type:"local_bash"`, `is_backgrounded`, `background_tasks_changed`. 서브에이전트와 `task_type`으로 구분해야 한다 |
| 세션 도중 모드 변경 | `set_permission_mode`가 동작한다. `bypassPermissions`는 `--allow-dangerously-skip-permissions` 없이 시작하면 `error_code:"bypass_not_launched"`로 거부되고, 그 옵션으로 시작하면 성공한다 |
| 사용자 훅 | 사용자 설정의 훅이 `system/hook_started`, `hook_response`로 스트림에 나타난다 |

### Codex (`codex app-server`, stdio JSON-RPC)

| 항목 | 결과 |
|---|---|
| 시작 | `initialize` → `initialized` → `thread/start`. 응답에 모델, 승인 정책, 샌드박스가 온다 |
| 항목 흐름 | `item/started`, `item/completed`(`userMessage`, `agentMessage`, `commandExecution`, `reasoning`, `collabAgentToolCall`, `subAgentActivity`), `item/agentMessage/delta` |
| 승인 요청 | 서버가 `item/commandExecution/requestApproval`을 요청으로 보낸다. `{decision:"accept"}` 응답으로 실행됐고 `serverRequest/resolved`가 왔다 |
| 작업 중 입력 | `turn/steer`로 보낸 지시가 명령 뒤 `userMessage`로 같은 턴에 들어갔다 |
| 중단 | `turn/interrupt`에 즉시 `{}` 응답, `turn/completed` 상태 `interrupted` |
| 서브에이전트 | `subAgentActivity`(`kind: started/completed`, `agentThreadId`, `agentPath`). 서브도 자기 `threadId`로 `turn/started`, `turn/completed`를 보낸다 |
| **주의** | `turn/completed`를 `threadId`로 거르지 않으면 서브의 종료를 메인 턴 종료로 오인한다. 첫 측정 스크립트가 이 실수로 턴 4의 중단을 잘못된 ID로 보냈고(`-32600`), 재측정으로 바로잡았다 |
| 스키마 | `codex app-server generate-json-schema`로 뽑을 수 있다. 앱 서버 자체가 experimental로 표시돼 있다 |

### 끊김

| 경우 | 결과 |
|---|---|
| Claude, 파이프를 도구 실행 중 닫음 | 진행 중이던 도구까지는 끝났고(표식 파일 생성) 18.6초 뒤 프로세스 종료 |
| Claude, FIFO와 로그 파일로 분리 실행 | 클라이언트가 사라져도 턴 완료, FIFO에 새 메시지를 쓰자 1.0초 만에 다음 턴 결과. `TERM`으로 종료 |
| Codex, 같은 방식으로 분리 실행 | 턴 완료, 다시 붙어 다음 턴 완료 |

분리 실행 명령: `nohup sh -c 'exec <CLI> <>in >out.jsonl 2>err.log' &`. `<>`로 FIFO를 읽기·쓰기로 열어 쓰는 쪽이 모두 닫혀도 EOF가 되지 않는다.

### 대기

- 실제 SSH 실행 채널에서의 끊김과 재접속. Docker 일회용 서버에서 사용자가 로그인해 잰다(AC.1).
- Finder로 띄운 앱이 아니라 SSH 비대화형 셸에서의 `claude`·`codex` 경로 탐색(AC.1).
- `root` 계정의 `--dangerously-skip-permissions` 동작.
- 승인이 대기 중일 때 끊겼다가 다시 붙은 경우(AC.9).
- 승인의 "세션 동안 허용"(`permission_suggestions`의 적용 형식, Codex `acceptForSession`).
- Codex의 `auto_review`가 `--approve-for-me`와 같은지.
- Windows 앱에서의 동작, Mac 실기기 앱.
