# 에이전트 채팅 — 설계안

- 요청: 2026-11-09 사용자. SSH 세션을 터미널 없이 채팅으로 열고, IDE 확장 같은 채팅 화면과 서브에이전트 표시, 전역 권한·프로그램 설정을 제공한다.
- 시안: [에이전트 채팅 시안](https://claude.ai/artifact/SNkBvraiykzn2LD8ZRjCt3) (채팅 탭, 터미널 표시, 시작 화면, 설정)
- 실측: [검증 기록](../verification/agent-chat.md#ac0-실측-2026-11-09)
- 작업 ID: AC. [roadmap §25](../roadmap.md). [agent-terminal](agent-terminal.md), [developer-workflow](developer-workflow.md) 위에 쌓는다.

## 1. 목표와 경계

- 저장된 SSH 세션을 **채팅으로 열기**로 연다. 셸 화면 없이 대화, 도구 사용, 서브에이전트, diff, 승인을 GUI로 본다. 일반 터미널 탭은 그대로 둔다.
- 대상 프로그램은 `claude`와 `codex`다. 화면에는 외부 제품명 대신 명령 이름을 쓴다(engineering-rules §3).
- **앱은 모델 API를 호출하지 않는다.** 사용자가 서버에 설치하고 직접 로그인한 CLI를 실행하고 그 구조화 출력을 표시한다. CLI의 OAuth 토큰과 설정 파일은 읽지도, 저장하지도, 중계하지도 않는다.
- 서버에 프로그램을 설치하지 않는다. 채팅마다 임시 폴더를 쓰고 끝나면 지운다. `codex app-server daemon bootstrap`처럼 서버에 관리 서비스를 올리는 경로는 쓰지 않는다.
- 이 기능으로 roadmap §18·§19의 "앱 안 AI 호출 제외"는 **"앱이 직접 모델을 호출하지 않는다"로 좁힌다.** 내장 모델·API 키 입력은 계속 제외다.

**약관:** 공식 문서는 제3자 제품이 Claude.ai 로그인을 제공하거나 구독 자격 증명을 중계하는 것을 금지하고, 사용자가 수정되지 않은 CLI에 자기 구독으로 로그인하는 것은 허용한다. GUI가 `claude -p`를 구동하는 경우는 명시가 없다. **공개 배포 전에 Anthropic에 확인한다.** 그 전까지 개인 사용 기능으로 다룬다.

## 2. 구조

```text
React 채팅 탭 ── IPC ── chat/ (Rust) ── SSH exec 채널 ── 서버의 분리 실행기 ── claude | codex
                         │                                 ├ in (FIFO)
                         │ 어댑터가 정규화                  └ out.jsonl (로그)
                         └ ChatEvent 스트림
```

### 2.1 분리 실행기 (AC.1)

SSH 채널에 CLI를 직접 묶지 않는다. 파이프가 끊기면 Claude는 진행 중인 도구까지만 하고 종료했다. 분리 실행은 두 CLI 모두 끊긴 뒤 턴을 끝냈고 다시 붙어 다음 턴을 보낼 수 있었다.

- 위치: `${XDG_RUNTIME_DIR:-$HOME/.cache}/dachsterm/chat/<id>/`, 폴더 0700, 파일 0600. `<id>`는 앱이 만든 영숫자다.
- 파일: `in`(FIFO), `out.jsonl`, `err.log`, `pid`, `meta`(프로그램·폴더·시작 시각).
- 시작: `nohup sh -c 'exec <명령> <>in >out.jsonl 2>err.log' &`. 명령은 `remote_exec::quote`로 인용한다. `.dachsterm-*` 전송 임시 이름 규약과 겹치지 않는다.
- 보기: `tail -c +<오프셋> -F out.jsonl`을 실행 채널로 스트리밍한다. 다시 붙을 때는 앱이 처리한 바이트 위치부터 받는다. 앱을 새로 시작했으면 처음부터 다시 읽어 화면을 복원한다.
- 입력: 메시지마다 짧은 실행 채널로 FIFO에 쓴다. 한 줄 전체를 `PIPE_BUF` 안에서 쓸 수 없으면 앞에서 `flock`이 아니라 앱 쪽 큐로 직렬화한다.
- 종료: `TERM` 뒤 폴더 삭제. `pid`가 죽어 있고 7일이 지난 폴더는 다음 채팅 시작 때 정리한다.
- 로그 상한: 기본 64MiB. 넘으면 사용자에게 알리고 턴 경계에서 새 프로세스를 `--resume`/`thread/resume`으로 시작한다.
- 경로: SSH 비대화형 셸에는 `~/.local/bin`이 없을 수 있다(DX.7). 로그인 셸로 찾은 절대 경로를 쓰며, 방법은 AC.1에서 실측한다. 없으면 설치 안내를 보여 주고 앱이 설치하지 않는다.
- 로컬 채팅: FIFO 없이 자식 프로세스 파이프로 실행한다. Windows에 같은 방식이 없고 로컬은 망 끊김이 없기 때문이다. 앱을 끝내면 함께 끝난다.
- Windows 서버는 지원하지 않고 오류로 알린다.
- 탭마다 새 SSH 연결이다(DX.7과 같음). OTP 서버는 다시 묻고 동시 연결 상한을 쓴다.

**보안:** 프롬프트와 출력이 서버의 0600 파일에 남는다. CLI 자체 대화 기록과 같은 신뢰 경계다. 비밀 인자를 명령줄에 넣지 않는다(프로세스 목록에 보임). 서버 출력은 신뢰하지 않으며 HTML로 렌더링하지 않고 원격 이미지를 불러오지 않는다. 숨김·방향 제어 문자는 AT.2와 같이 제거한다.

### 2.2 정규화 이벤트 (AC.2, AC.3)

`src-tauri/src/chat/`에 어댑터를 두고 프런트엔드는 프로그램별 형식을 모른다. 프로토콜이 버전마다 바뀌므로 파서는 Rust 한 곳에 모으고, 모르는 타입은 버리되 버린 종류를 개수로 세어 진단에 표시한다.

```rust
enum ChatEvent {
    Started { session, model, mode },
    Text { agent, delta },            // agent: None이면 메인
    Thinking { agent, seconds },
    ToolStarted { agent, id, kind, summary },
    ToolFinished { agent, id, ok, detail },
    AgentStarted { id, parent, role, task },
    AgentFinished { id, status, summary },
    ApprovalAsked { id, kind, command_or_path, reason, session_option },
    ApprovalSettled { id },
    Diff { path, unified },
    ModeChanged { mode },
    TurnFinished { status },          // Done | Interrupted | Failed(원인 enum)
    Unknown { count },
}
```

| 정규화 | Claude | Codex |
|---|---|---|
| 세션 ID | `system/init.session_id` | `thread/start` 응답 |
| 본문 | `stream_event`, `assistant` | `item/agentMessage/delta` |
| 도구 | `tool_use` / `tool_result` | `commandExecution`, 파일 변경, MCP 항목 |
| 서브 시작 | `task_started` 중 `task_type:"local_agent"` | `subAgentActivity kind:started` |
| 서브 소속 | `parent_tool_use_id` → `tool_use_id`, `spawn_depth` | `agentThreadId`, `agentPath`, `thread.parentThreadId` |
| 서브 종료 | `task_notification.status/summary` | `subAgentActivity kind:completed` |
| 승인 | `control_request can_use_tool` | `item/*/requestApproval` |
| 승인 해소 | 같은 `tool_use_id`의 `tool_result` | `serverRequest/resolved` |
| 턴 끝 | `result` | **메인 `threadId`의** `turn/completed` |
| 작업 중 입력 | 사용자 메시지 전송(같은 턴에 합쳐짐) | `turn/steer` |
| 중단 | `control_request interrupt` | `turn/interrupt` |
| 이어가기 | `--resume <id>` | `thread/resume` |

- Claude의 백그라운드 명령(`task_type:"local_bash"`)은 서브에이전트로 세지 않는다.
- 승인과 턴 상태는 재생 가능해야 한다. 다시 붙었을 때 답이 없는 승인 요청은 해소 신호가 없는 것으로 판단해 카드를 복원한다(AC.9에서 실측).

### 2.3 IPC

명령은 `chat_start`, `chat_attach`, `chat_send`, `chat_answer`, `chat_interrupt`, `chat_set_mode`, `chat_close`, `chat_list`다. engineering-rules §5의 네 곳을 함께 고친다. 출력은 `Channel<ChatEvent>`로 보낸다. 터미널과 달리 화면 렌더 ACK를 받지 않고, 프레임 크기 상한과 문자 단위 병합으로 부담을 줄인다. 망·파일을 쓰므로 모두 `async`다.

## 3. 권한과 전역 설정 (AC.6)

설정 창 **에이전트 > 채팅**에 둔다. `dachsterm.chatDefaults`(읽을 때 검증).

| 설정 | 값 |
|---|---|
| 세션 더블클릭 동작 | 터미널(기본) / 채팅. 저장된 세션별로 덮어쓴다 |
| 기본 프로그램 | `claude` / `codex` |
| 프로그램별 권한 | 아래 표 |
| 프로그램별 모델·추론 강도 | 기본 / 선택값 |

세션별 열기 방식은 `storage.rs`의 프로필 필드로 저장하고, 이관 형식에는 새 스키마 버전으로 넣는다([session-transfer](../session-transfer.md)). 나머지는 전역이다.

| 화면 이름 | Claude 시작 | Codex `thread/start`·`turn/start` |
|---|---|---|
| 기본 | `--permission-mode manual` | `approvalPolicy:on-request`, `sandbox:workspace-write` |
| 편집 자동 승인 | `--permission-mode acceptEdits` | (없음) |
| 계획 | `--permission-mode plan` | (없음) |
| 자동 | `--permission-mode auto` | `approvalsReviewer:auto_review`, `workspace-write` (CLI의 `--approve-for-me`와 같은지 AC.3에서 확인) |
| 권한 확인 생략 (위험) | `--dangerously-skip-permissions` | `approvalPolicy:never`, `sandbox:danger-full-access` |

- 프로그램과 모드의 목록은 `features/agents/agentOptions.ts` 한 곳에서 관리하고 채팅용 값을 추가한다.
- 입력창의 권한 칩으로 열린 채팅의 모드를 바꾼다. Claude는 `set_permission_mode`, Codex는 다음 `turn/start`의 인자다.
- Claude는 처음부터 위험 모드가 아니어도 입력창에서 바꿀 수 있게 항상 `--allow-dangerously-skip-permissions`로 시작한다. 이 옵션 없이는 `bypass_not_launched`로 거부된다(실측). 판정은 메시지가 아니라 `error_code`로 한다(규칙 §6).
- 위험 모드는 사용자가 전역 기본값으로 고를 수 있다. 고를 때 `dangerWarning`을 보이고, 쓰는 동안 입력창 칩을 경고색과 글자로 표시한다. 탭 제목에는 넣지 않는다. 앱의 SSH 서명·Git 자격 증명 승인은 이 모드에서도 유지된다.
- `isDangerousCommand`는 터미널 시작 명령용이다. 채팅의 경고는 현재 모드로 판단한다. `--allow-dangerously-*`가 항상 붙기 때문이다.
- `root` 계정에서 위험 모드가 거부되면 CLI 오류를 그대로 채팅에 표시한다(실측 대기).

## 4. 화면 (AC.4, AC.5, AC.7)

시안을 따른다. 색·글꼴·간격은 테마 토큰만 쓴다(§8 규칙). CSS는 `features/chat/chat.css`.

- **탭 종류 `chat`:** `WorkspaceGrid`의 평탄한 목록에 들어가 분할·이동·독립 창이 터미널 탭과 같게 동작한다. `session.ts`의 분기에 끼워 넣지 않고 탭 내용 컴포넌트만 나눈다. `App.tsx`는 순증 없이 고친다.
- **대화:** 사용자 입력 상자, 본문, 접힌 생각·도구 요약, 서브에이전트 카드, diff, 승인 카드가 흐름 안에 온다. Markdown은 기존 정화 경로를 재사용한다.
- **입력창:** `+`(첨부, AT.5 경로), `/`(프로그램이 보고한 명령 목록), 서브 수, 모델 칩, 권한 칩, 전송·중지. 작업 중에도 입력을 받는다.
- **실행 그래프:** 메인에서 서브가 갈라졌다 합쳐지는 레인. 행을 고르면 해당 에이전트의 단계를 보여 준다. 서브가 없으면 패널을 열지 않는다.
- **승인 카드:** 명령이나 경로, 이유, `이번만 허용`, `이 세션 동안 허용`(프로그램이 제공할 때만), `거부`.
- **현황판:** 채팅 탭도 `AgentBoard`와 같은 값으로 보고한다. 알림은 AT.3 경로를 쓴다.
- **터미널로 열기:** 끝난 턴에서만 활성화한다. 분리 실행기를 닫고 같은 ID로 `claude --resume`·`codex resume`을 터미널 탭에 연다.
- 공유 코드는 계층을 내린다. `features/git/unifiedDiff.ts`를 쓰려면 `lib`로 옮긴다. 기능 간 import를 만들지 않는다(§7).

## 5. 터미널 탭의 서브에이전트 표시 (AC.8)

채팅과 별개로 터미널 탭에서도 수를 표시한다. 훅의 `terminalSequence`는 OSC 777을 허용한다.

- `SubagentStart`, `SubagentStop` 훅이 `OSC 777;DachsTerm;agent;start|stop;<id>;<type>`을 보낸다. 값은 AT.2의 `id` 문자 규칙으로 검사하고 탭당 64개로 제한한다.
- 표시할 수 있는 것은 종류, 경과 시간, 상태뿐이다. 현재 단계는 채팅 탭에서만 보인다.
- 훅은 앱이 설치하지 않는다. `AgentHookGuide`의 복사용 예시에 추가하며, stdin JSON을 읽어야 하므로 지금의 고정 출력보다 길어진다.
- 구현 전 `hooks` 문서 원문과 실제 동작을 확인한다.

## 6. 작업 순서

| ID | 내용 | 합격 기준 |
|---|---|---|
| AC.0 | 실측 | 프로토콜·끊김 기록. **Mac 로컬 파이프분 완료, 실제 SSH는 AC.1로 이월** |
| AC.1 | 분리 실행기 | 실제 SSH에서 시작·끊김·재접속·종료·정리, 경로 탐색, 비UTF-8 세션 거부 |
| AC.2 | Claude 어댑터와 정규화 | 기록한 스트림으로 단위 테스트, 실제 CLI 왕복 |
| AC.3 | Codex 어댑터 | `threadId` 분리 포함 단위 테스트, 실제 CLI 왕복 |
| AC.4 | 채팅 탭 UI | 탭 분할·이동·독립 창, 긴 출력 성능, 스트리밍 |
| AC.5 | 승인·권한 전환·중단 | 허용·거부·세션 허용·위험 전환 오류 처리 |
| AC.6 | 전역 설정과 시작 화면, 세션별 열기 방식 | 설정 저장·검증, 이관 스키마 |
| AC.7 | 실행 그래프와 현황판 | 중첩 서브, 병렬 서브, 독립 창 보고 |
| AC.8 | 터미널 탭 서브 표시 | 훅 실측, 표시와 수명 |
| AC.9 | 재접속·복원·이어가기·터미널로 열기 | 승인 대기 중 끊김 복원, 로그 상한 재시작 |
| AC.10 | 문서·회귀·Mac 실기기 | 전체 게이트, 패키지된 앱, 양 OS |

## 7. 제외

| 항목 | 판단 |
|---|---|
| IDE 확장 실행 호환, `/ide` 서버 구현 | 사용자 결정으로 제외(2026-11-09) |
| 앱이 직접 모델 호출, API 키 입력 | 제외 |
| 서버 상주 서비스 설치 | 제외. 분리 실행기로 해결한다 |
| 컨텍스트·사용량 표시 | 미결정. Codex·Claude 모두 값은 스트림에 있다 |
| 한 채팅을 여러 PC에서 동시에 열기 | 후속. 입력 순서 보장이 없다 |
| Windows 서버 | 후속 |

## 8. 공개 배포 전 확인

1. Anthropic에 GUI의 `claude -p` 구동 허용 여부 확인.
2. Codex `app-server` experimental 상태와 프로토콜 변경 대응.
3. 어댑터가 모르는 형식을 만났을 때 터미널로 안내하는 경로.
