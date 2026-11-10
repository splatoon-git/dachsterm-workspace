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

- 위치: `$HOME/.cache/dachsterm/chat/<id>/`, 폴더 0700, 파일 0600. `<id>`는 앱이 만든 영숫자다. `XDG_RUNTIME_DIR`은 systemd가 마지막 세션 종료 때 지울 수 있어 쓰지 않는다.
- 파일: `in`(FIFO), `out.jsonl`, `err.log`, `pid`, `meta`(프로그램·폴더·시작 시각).
- 시작: `nohup sh -c 'exec <명령> <>in >out.jsonl 2>err.log' &`. 명령은 `remote_exec::quote`로 인용한다. `.dachsterm-*` 전송 임시 이름 규약과 겹치지 않는다.
- 보기: `tail -c +<오프셋> -F out.jsonl`을 실행 채널로 스트리밍한다. 다시 붙을 때는 앱이 처리한 바이트 위치부터 받는다. 앱을 새로 시작했으면 처음부터 다시 읽어 화면을 복원한다.
- 입력: 메시지마다 짧은 실행 채널로 FIFO에 쓴다. 한 줄 전체를 `PIPE_BUF` 안에서 쓸 수 없으면 앞에서 `flock`이 아니라 앱 쪽 큐로 직렬화한다.
- 종료: `TERM` 뒤 폴더 삭제. `pid`가 죽어 있고 7일이 지난 폴더는 다음 채팅 시작 때 정리한다.
- 로그 상한: 기본 64MiB. 넘으면 사용자에게 알리고 턴 경계에서 새 프로세스를 `--resume`/`thread/resume`으로 시작한다.
- 경로: 실행 채널에는 `~/.local/bin`이 없다(AC.1 실측, DX.7과 같음). 시작 전에 `"$SHELL" -lc 'command -v <명령>'`으로 절대 경로를 찾아 그 경로로 실행한다. `-ic`는 설치 스크립트가 넣은 경로를 찾지 못했다. 없으면 설치 안내를 보여 주고 앱이 설치하지 않는다.
- `KillUserProcesses=yes`인 systemd 서버에서는 로그아웃 때 분리 실행도 종료될 수 있다. tmux와 같은 한계로 안내한다.
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
- 승인과 턴 상태는 재생 가능해야 한다. 다시 붙었을 때 답이 없는 승인 요청은 해소 신호가 없는 것으로 판단해 카드를 복원한다. 두 CLI 모두 실제 SSH에서 끊긴 동안 승인 대기를 유지했고 다시 붙은 뒤의 응답으로 실행됐다(AC.1 실측).
- Codex 명령이 샌드박스 오류로 실패해도 턴은 `completed`로 끝난다. 명령 항목의 `status:failed`와 출력을 도구 결과에 그대로 보여 주고, `bwrap` 네임스페이스 오류면 "이 서버에서는 샌드박스를 쓸 수 없습니다"와 권한 모드 안내를 붙인다. 출력 문자열은 표시에만 쓰고, 안내 여부는 명령 실패와 샌드박스 모드로 정한다(규칙 §6).

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

engineering-rules §4는 제품 코드가 호출하지 않는 명령과 함수를 남기지 못하게 한다. 그래서 백엔드만 먼저 병합하지 않고, 작업 ID마다 화면에서 쓸 수 있는 데까지 세로로 자른다(2026-11-10 변경).

| ID | 내용 | 합격 기준 |
|---|---|---|
| AC.0 | 실측 | **완료.** Mac 로컬 파이프와 실제 SSH(시스템 `ssh`) 실측 |
| AC.1 | 첫 단위: 연결 트리 **채팅으로 열기** → `claude` 텍스트 대화 왕복. 로그인 전용 연결, 분리 실행기(시작·붙기·보내기·닫기), Claude 어댑터의 본문·턴 끝, 최소 채팅 탭(대화 목록과 입력창) | 앱의 russh 경로로 실제 SSH 왕복, 탭을 닫으면 서버 정리, 연결이 끊겨도 서버의 턴 유지 |
| AC.2 | 도구·생각·diff 표시, 스트리밍, 긴 대화 | 기록한 스트림 단위 테스트, 500턴 대화 스크롤 |
| AC.3 | `codex` 어댑터 | `threadId` 분리 포함 단위 테스트, 실제 CLI 왕복, 샌드박스 실패 안내 |
| AC.4 | 채팅 탭 배치: 분할·이동·독립 창, 현황판·알림 보고 | 탭 이동 시 재마운트 없음, 독립 창 상태 보고 |
| AC.5 | 승인·권한 전환·중단 | 허용·거부·세션 허용·위험 전환 오류 처리 |
| AC.6 | 전역 설정과 시작 화면, 세션별 열기 방식, 모델 목록 | 설정 저장·검증 |
| AC.7 | 실행 그래프 | 중첩 서브, 병렬 서브 |
| AC.8 | 터미널 탭 서브 표시 | 훅 실측, 표시와 수명 |
| AC.9 | 재접속·앱 재시작 복원·이어가기·터미널로 열기·로그 상한 | 승인 대기 중 끊김 복원, 앱 재시작 후 채팅 목록 |
| AC.11 | SSH 키 서명·Git 자격 증명 전달(§9.3) | 끊겼다 다시 붙은 뒤 `git push` 성공 |
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

## 9. 코드에 맞춘 구현 결정 (2026-11-10 보완)

### 9.1 연결

- 채팅은 **로그인까지만 하는 연결**을 쓴다. TL.5 네트워크 도구의 `net_tools::link`가 이미 PTY·셸·세션 로그·터널 자동 시작 없이 로그인만 한다.
- 채팅은 같은 시작·유지 로직이 필요하므로 복사하지 않는다(§4 공용화). `link::start`와 `hold`를 `ssh/login_only.rs`로 옮기고, 차이는 인자로 받는다.

  | 인자 | 네트워크 도구 | 채팅 |
  |---|---|---|
  | 유휴 종료 | 5분 | 없음(탭이 닫힐 때까지) |
  | 에이전트 전달 | 끔 | 프로필 설정(AC.11 전까지 끔) |
  | 터미널 연결 재사용 | 함 | 하지 않음. 터미널을 닫아도 채팅이 끊기지 않게 한다 |

- 연결 ID는 터미널과 같은 `Connections`의 32개 상한을 쓴다. 채팅 탭 하나가 연결 하나다.

### 9.2 IPC와 흐름

| 명령 | 하는 일 |
|---|---|
| `chat_open` | 로그인 전용 연결 시작. 상태와 로그인 질문은 기존 `Event::State`·인증 경로로 받는다 |
| `chat_start` | 경로 탐색 → 분리 실행기 시작 → 붙기. `Channel<ChatEvent>`를 받는다 |
| `chat_send` | 사용자 메시지 한 줄을 FIFO에 쓴다 |
| `chat_close` | 실행기 종료·폴더 삭제 후 연결 종료 |

- 붙기는 `remote_exec::stream_refusable`에 `tail -c +<오프셋> -F`를 시간 제한 없이 건다. 줄을 자르는 `Lines`를 재사용하고, 앞 단계 마커 처리도 그대로 쓴다.
- 보내기는 `printf '%s\n' <인용한 JSON> > in`이다. 첨부가 없는 텍스트 메시지는 명령줄 길이 안에 든다. 64KiB를 넘는 메시지는 거부한다(첨부는 AT.5 업로드 후 경로로 보낸다).
- 앱 쪽 보내기는 연결별 큐로 직렬화한다. FIFO 쓰기가 `PIPE_BUF`를 넘어도 쓰는 쪽이 하나라 섞이지 않는다.
- 끊기면 붙기 채널만 다시 연다. 오프셋은 Rust가 연결별로 기억한다.

### 9.3 SSH 키 서명과 Git 자격 증명 (AC.11)

분리 실행된 CLI의 `SSH_AUTH_SOCK`과 Git 자격 증명 소켓은 시작한 연결의 것이다. 연결이 끊기면 사라지고 다시 붙은 연결의 새 소켓은 이미 떠 있는 프로세스가 모른다. tmux 재접속과 같은 문제다(developer-workflow §10의 "고정 경로 소켓" 후보).

- 실행 폴더에 `agent.sock`, `git.sock` 링크를 두고 CLI에는 이 고정 경로를 환경 변수로 준다. 붙을 때마다 그 채널의 소켓으로 `ln -sfn`한다.
- 끊긴 동안 서명 요청은 실패한다. 다시 붙으면 다음 요청부터 성공한다. 실측해서 기록한다.
- AC.1에서는 전달하지 않는다. 채팅 안의 `git push`는 AC.11 전까지 실패할 수 있으며 화면에 그 이유를 표시한다.

### 9.4 저장

- 채팅 기록: `chats(id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, program TEXT NOT NULL, folder TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL)`. `PRAGMA user_version` 4→5 이행을 `storage.rs`에 추가한다. 대화 내용은 저장하지 않는다. 서버 로그와 CLI 대화 기록이 원본이다. AC.1은 열린 탭에서만 쓰고, 앱 재시작 후 목록은 AC.9다.
- 세션별 열기 방식: 프로필 JSON에 `open_as`(`terminal` 기본, `chat`)를 `serde(default)`로 더한다. 이관 형식 v2는 `additionalProperties: false`라서 이 값은 내보내지 않는다. 기기마다의 표시 선호로 다룬다.
- 전역 기본값: `dachsterm.chatDefaults`(localStorage, 읽을 때 검증). 프리셋과 같은 방식이다.

### 9.5 화면

- 탭: `workspaceLayout.ts`의 유니온에 `{ kind: 'chat'; id: string }`를 더하고, 열기·닫기는 `useReviewTabs`와 같은 `app/useChatTabs.tsx`가 맡는다. `App.tsx`는 순증 없이 훅 호출로만 연결한다.
- 기능 폴더: `src/features/chat/`(`ChatPane.tsx`, `chatEvents.ts` 순수 상태 축약과 테스트, `chat.css`).
- 긴 대화: 최근 200개 항목만 그리고, 위로 스크롤하면 200개씩 더 그린다. 접힌 도구 결과는 펼칠 때 그린다.
- 진입점: 연결 트리의 SSH 세션 우클릭 **채팅으로 열기**. 더블클릭 기본값은 AC.6이다.
- 모델 목록: `claude`는 `--help`의 별칭(`opus`, `sonnet`, `haiku`, `fable`)을 `agentOptions.ts`에 둔다. `codex`는 앱 서버의 `model/list`로 받는다(AC.6).

### 9.6 검증

- 단위: 어댑터는 AC.0·AC.1에서 기록한 스트림의 **형태만 남긴** 샘플로 테스트한다. 대화 원문과 계정 정보는 저장소에 넣지 않는다. 실행기 스크립트 생성, 인용, ID 검사도 단위 테스트한다.
- 네이티브(Windows): `scripts/test-chat-native.mjs`를 `verify-windows.ps1 -Native`에 연결한다. OpenSSH 검사 서버에 **기록된 스트림을 재생하는 가짜 `claude`**를 두어 로그인 없이 돈다. SSH는 실제이고 CLI만 대역이므로 결과는 "앱 경로 검증"으로 기록한다.
- 실제 CLI: 로그인한 일회용 서버(`dachsterm-ac1`)에서 사람이나 에이전트가 앱으로 실행하고 기록한다. Mac은 실기기에서 같은 절차를 따른다.

## 8. 공개 배포 전 확인

1. Anthropic에 GUI의 `claude -p` 구동 허용 여부 확인.
2. Codex `app-server` experimental 상태와 프로토콜 변경 대응.
3. 어댑터가 모르는 형식을 만났을 때 터미널로 안내하는 경로.
