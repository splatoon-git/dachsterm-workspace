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

- `root` 계정의 `--dangerously-skip-permissions` 동작.
- 승인의 "세션 동안 허용"(`permission_suggestions`의 적용 형식, Codex `acceptForSession`).
- Codex의 `auto_review`가 `--approve-for-me`와 같은지.
- Windows 앱에서의 동작, Mac 실기기 앱.

## AC.1 실제 SSH 실측 (2026-11-10)

- **환경:** Mac의 Docker 일회용 서버. `tests/openssh` 이미지에 `claude` 2.1.321(공식 설치 스크립트, `~/.local/bin`)과 `codex-cli` 0.167.0(npm, `/usr/local/bin`)을 더했다. 사용자가 컨테이너 안에서 직접 로그인했다. 이미지 정의는 저장소에 넣지 않았다.
- **연결:** 시스템 `ssh`의 실행 채널(`-F /dev/null`, 이 검사용 일회용 키). 앱의 russh 경로가 아니다. 끊김은 클라이언트 `ssh` 프로세스를 강제 종료해 만들었다. 망이 조용히 끊기는 경우(FIN 없음)는 재지 않았다.
- 분리 실행기는 설계안 §2.1의 `nohup sh -c 'exec "$@" <>in >out.jsonl 2>err.log'`, 위치는 `$HOME/.cache/dachsterm/chat/<id>`다.

| 항목 | 결과 |
|---|---|
| 경로: 실행 채널 그대로 | `codex`만 찾음. `claude`(`~/.local/bin`)는 못 찾음 |
| 경로: `$SHELL -lc` | 둘 다 찾음 |
| 경로: `$SHELL -ic` | `claude`를 못 찾음(설치 스크립트가 로그인 셸 설정에 경로를 넣음) |
| 직접 연결, 명령 중 클라이언트 종료 | 서버의 `claude`가 명령을 끝내고(표식 생성) 그 뒤 종료. 로컬 파이프 실측과 같다 |
| 분리 실행, 승인 대기 중 끊김 | 20초 뒤에도 살아 있고 명령은 실행되지 않았다. 다시 읽은 로그에서 `tool_result`가 없는 `can_use_tool` 1건을 찾아 허용하자 실행되고 턴이 끝났다 |
| 분리 실행, 명령 중 끊김 후 바이트 오프셋으로 다시 붙기 | 25초 뒤 다시 붙어 `result`를 받았다. 표식 생성. 끊긴 동안의 출력을 잃지 않았다 |
| 세션 도중 위험 모드 전환 | `--allow-dangerously-skip-permissions`로 시작한 세션에서 `set_permission_mode bypassPermissions` 성공 |
| 종료와 정리 | `TERM`으로 종료, 폴더 삭제, 남은 프로세스 없음 |
| `codex`, 분리 실행, 승인 대기 중 끊김 | 20초 뒤에도 살아 있고 명령은 실행되지 않았다. 다시 읽은 로그에서 `serverRequest/resolved`가 없는 `requestApproval` 1건을 찾아 `accept`로 답하자 실행되고 턴이 끝났다 |
| `codex`, 명령 중 끊김 후 바이트 오프셋으로 다시 붙기 | 25초 뒤 다시 붙어 메인 스레드의 `turn/completed`를 받았다. 표식 생성 |
| `codex`, 종료와 정리 | `TERM`으로 종료, 폴더 삭제, 남은 프로세스 없음 |
| **`codex` 샌드박스** | `workspace-write`에서 명령이 `bwrap: No permissions to create a new namespace`로 실패했다(exit 1). 턴은 `completed`로 끝나 실패가 턴 상태에 드러나지 않는다. `danger-full-access`에서는 실행됐다. 비특권 user namespace를 막은 컨테이너·서버에서 Codex의 기본 모드는 명령을 실행하지 못한다 |

- `codex`는 처음에 서버 로그인이 되지 않아 401로 실패했고, 사용자가 다시 로그인한 뒤 위 결과를 얻었다.
- 분리 실행으로 띄운 `codex` 0.167.0은 Node 18(Debian bookworm)의 npm 설치본이다.
- `pgrep -fc 'claude -p'`는 검사 명령의 셸 자신도 센다. 숫자는 그만큼 빼서 읽었다.
- systemd의 `/run/user/<uid>`는 마지막 세션이 끝나면 지워질 수 있어 실행 폴더로 쓰지 않는다. 컨테이너에 systemd가 없어 재지 못했다. `KillUserProcesses=yes`인 서버에서는 분리 실행도 로그아웃 때 종료될 수 있다(tmux와 같음).
