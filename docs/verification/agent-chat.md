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

## AC.1 첫 단위 구현 (2026-11-10, `1c1661b`)

- **범위:** 연결 트리 SSH 세션 우클릭 **채팅으로 열기** → 로그인 전용 연결 → 서버에서 `claude` 경로 탐색과 분리 실행 → 텍스트 왕복. 탭을 닫으면 실행기를 끝내고 폴더를 지운다. 승인 화면이 없으므로 `--permission-prompts none`으로 실행해 승인이 필요한 동작은 CLI가 거부한다(AC.5에서 바꾼다).
- **구조:** `net_tools::link`의 시작·유지를 `login_only.rs`로 옮겨 네트워크 도구와 채팅이 함께 쓴다(도구는 유휴 5분, 채팅은 제한 없음). 프런트엔드의 연결 관리자는 `lib/loginLink.ts`로 내리고 도구의 `SourceLink`는 이를 상속한다. `App.tsx` 793→791줄.
- **자동 게이트(Mac, `1c1661b`):** `cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings` 통과, `cargo test --workspace` 655 통과. `npm run typecheck`, `lint`, `format:check` 통과, Vitest 108파일 1331 통과, Playwright 521 통과.
- **새 단위 테스트:** 실행기 스크립트의 ID 검사·인용·오프셋·줄 버퍼(Rust 7), Claude 출력 읽기(Rust 5), 채팅 상태 축약(Vitest 5). 기존 `net_tools::link`의 유휴 시험 3건은 `login_only`로 옮겼다.
- **미실행:** 실제 앱에서의 채팅 왕복(Mac 실기기 확인 대기), Windows 네이티브 검사(`test-chat-native.mjs`는 아직 없음), CI.
- **작업 폴더(`4b2ef0f`):** 사이드바 파일 트리의 폴더 우클릭 **여기서 채팅 열기**는 그 폴더에서 바로 연다. 연결 트리의 **채팅으로 열기…**는 폴더를 묻고 그 세션의 최근 폴더 8개를 제안한다(`dachsterm.chatFolders`). 폴더 검사는 에이전트 시작과 함께 `lib/shell.ts`의 `folderProblem`을 쓴다. 게이트: typecheck·lint·format 통과, Vitest 109파일 1335 통과, Playwright 521 통과. 실제 앱 확인은 대기.
- **이 PC 채팅(`8408b60`):** 로컬 셸 탭(WSL 제외)의 파일 트리 폴더 우클릭 **여기서 채팅 열기**로 앱이 `claude`를 자식 프로세스로 실행한다(`chat_start_local`). 경로는 `PATH`(macOS는 `login_path` 적용분)와 `~/.local/bin`, 폴더는 절대 경로이면서 실제 폴더여야 한다. 게이트(Mac): format·typecheck·lint 통과, Vitest 1335, Playwright 521, `cargo test --workspace` 658, clippy 통과. 실제 앱 확인 대기. Windows에서는 `claude.exe`만 찾는다(npm 설치본의 `.cmd`는 미지원).
- **로컬 폴더 메뉴 결함(`580cfbf`):** 사용자가 디버그 앱에서 로컬 폴더 우클릭에 **여기서 채팅 열기**가 없다고 알렸다. `LocalFilePanel`이 `folderMenu`를 쓰지 않아 앱이 넘긴 폴더 항목이 그려지지 않았다. 고친 뒤 `tests/ui/local-files.spec.ts`(새 fixture)가 수정 전 실패·수정 후 통과함을 확인했다. 게이트: typecheck·lint·format, Vitest 1335, Playwright 522 통과.

## AC.2 편집기식 채팅 화면 (2026-11-10, `2467421`)

- **범위:** `--include-partial-messages`로 답을 실시간 표시하고, 블록이 끝나면 완성본으로 바꾼다. 답은 파일 미리보기의 정화된 Markdown으로 그린다(`lib/markdown.ts`, `components/MarkdownPreview.tsx`로 옮김). 생각 시작·끝(걸린 초), 도구 호출 한 줄 요약과 결과, `Edit`·`Write`의 전후 내용을 점이 있는 단계 줄로 보인다. 작업 중에는 **작업 중지**(`chat_interrupt`, Claude `control_request interrupt`)가 보이고, 중지한 턴은 오류가 아니라 "중지했습니다."로 끝난다.
- **실측(로컬 `claude` 2.1.319, `sonnet`):** 부분 메시지 `content_block_start`·`text_delta`·`input_json_delta`·`content_block_stop`, 도구 결과의 `content`가 문자열로 왔다. 생각 블록은 이번 실행에서 나오지 않아 표준 형식(`thinking`)으로 구현하고 단위 테스트만 했다.
- **게이트(Mac, `2467421`):** format·typecheck·lint 통과, Vitest 1339, Playwright 524(새 `chat.spec.ts` 2건: 스트리밍·도구·diff·중지, 완성본 교체), `cargo test --workspace` 662, clippy 통과. fixture 스크린샷으로 배치를 확인했다.
- **대기:** 실제 앱 확인, 생각 블록 실측, 승인 카드와 권한 칩(AC.5).
- **입력창 도구(`c58e644`):** 시작할 때 `initialize`로 모델 14개·명령 58개·에이전트·권한 모드를 받는다(계정 정보는 넘기지 않고 단위 테스트로 확인). 턴마다 `get_context_usage`로 사용률과 항목별 토큰을 받는다. 모델 변경은 `set_model`(실측 성공), 추론 강도의 대화 중 변경(`set_effort`)은 CLI가 지원하지 않아 넣지 않았다. 서브에이전트는 `task_started`의 `local_agent`만 센다. `/`로 시작하면 명령 목록(화살표·Enter·Tab·Esc), 모델 칩 메뉴, 컨텍스트 원과 내역, 서브에이전트 목록. 게이트: Vitest 1341, Playwright 525(`chat.spec.ts` 3건), `cargo test --workspace` 665, clippy·format·typecheck·lint 통과. 실제 앱 확인 대기.
- **effort·권한·사용량·에이전트·복사(`d12f0f8`):** 실측(로컬 `claude` 2.1.319): effort는 `set_effort`가 없고 `apply_flag_settings {effortLevel}`이 성공하며 `get_settings`의 `effective.effortLevel`에 반영된다. `get_usage`가 세션 비용·줄 수·5시간/7일 사용률을, `rate_limit_event`가 실시간 사용률을 준다. 계정은 플랜과 이메일만 화면에 넘긴다(조직은 넘기지 않음을 단위 테스트로 확인). 권한 모드에서 생략을 고를 수 있게 `--allow-dangerously-skip-permissions`로 시작한다. 서브에이전트는 시작한 도구 호출 아래에 상태와 요약을 보인다. 대화 글자 선택, 메시지 복사 버튼, 탭 메뉴의 대화 복사(Markdown, 도구 출력 제외), 머리글 `+`와 탭 메뉴의 같은 위치 새 채팅. `App.tsx` 793줄 유지. 게이트: Vitest 1342, Playwright 526(`chat.spec.ts` 4건), `cargo test --workspace` 666, clippy·format·typecheck·lint 통과. 실제 앱 확인 대기.
- **WebKit 정렬·Ultracode(`a196912`):** 사용자가 Mac 앱에서 모델 메뉴가 가운데 정렬로 보인다고 알렸다. WebKit 버튼이 내용을 가운데에 두기 때문이며 Chromium 테스트로는 드러나지 않았다. `playwright.config.ts`에 macOS에서만 도는 WebKit 프로젝트(`*.webkit.spec.ts`)를 두고 `macos.yml`이 WebKit을 설치한다. 새 검사는 수정 전 항목 글자가 351px 안쪽에서 시작해 실패, 수정 후 통과했다. Ultracode는 실측으로 `/effort ultracode on|off`를 사용자 턴으로 보내면 켜지고 꺼지며(세션 한정, `get_settings`에는 나오지 않음), 모델 메뉴의 스위치로 넣었다. 게이트: Vitest 1342, Playwright 527(WebKit 1 포함), `cargo test --workspace` 666, clippy·format·typecheck·lint 통과. Windows CI와 실제 앱 확인 대기.
- **첨부(`3b803b4`):** 입력창 `+`(OS 파일 선택), 파일 끌어다 놓기(`useFileDrop`), 이미지 붙여넣기(`prompt_clipboard_inspect`로 확인한 이미지만, 보낼 때 같은 내용인지 다시 확인). 보낼 때 SSH 채팅은 AT.5의 `prompt_files_upload`·`prompt_clipboard_image`로 서버 `~/.cache/dachsterm/prompt/`에 올리고, 이 PC 채팅은 파일 경로를 그대로 쓰며 클립보드 이미지는 임시 폴더 `dachsterm-chat`(0700, 파일 0600, 7일 뒤 정리)에 저장한다. 메시지 끝에 "첨부한 파일:" 목록으로 경로를 붙인다. 게이트: Vitest 1345, Playwright 528(`chat.spec.ts` 5건), `cargo test --workspace` 667, clippy·format·typecheck·lint 통과. **대기:** 실제 앱의 OS 드래그, WKWebView에서 붙여넣기 이벤트에 이미지 파일이 실리는지, 원격 업로드 왕복.

## AC.5 승인 카드 (2026-11-10, `04ecd29`)

- **실측(로컬 `claude` 2.1.319, `sonnet`, `--setting-sources project`):** 질문 도구(`AskUserQuestion`)는 `can_use_tool`로 오고, `updatedInput`에 `answers: {질문: 고른 이름}`을 더해 허용하면 에이전트가 그 답을 받는다("Blue" 선택 → 답 "Blue"). 권한 제안(`permission_suggestions`, 원래 `destination: localSettings`)을 `session`으로 바꿔 `updatedPermissions`로 돌려보내도 다음 턴의 같은 명령을 다시 물었다. 설정 파일은 써지지 않았다.
- **구현:** 시작 옵션을 `--permission-prompts none`에서 `--permission-prompt-tool stdio`로 바꿨다. 요청의 입력은 Rust가 채팅별로 보관하고(`asking`), `chat_answer`가 허용(같은 입력)·질문 답(입력+answers)·거부를 돌려보낸다. 카드는 명령이나 파일, 설명, 편집 전후를 보이고 이번만 허용·이 채팅에서 묻지 않기·거부를 고른다. "이 채팅에서 묻지 않기"는 위 실측 때문에 앱이 기억한다: 파일 편집 도구는 모두, `Bash`는 같은 명령, 그 밖에는 같은 도구. 답하지 않은 카드는 턴이 끝나면 "답하기 전에 끝남"이 된다.
- **게이트(Mac, `04ecd29`):** Vitest 1346, Playwright 529(`chat.spec.ts` 6건: 이번만·채팅 동안·자동 허용·거부·질문 답), `cargo test --workspace` 669, clippy·format·typecheck·lint 통과.
- **대기:** 실제 앱에서 카드로 허용·거부, 서버 채팅의 승인, 탭·현황판의 "입력 대기" 표시(AC.4), 끊긴 동안 대기한 승인의 복원(AC.9).


## 입력 대기·제목 줄 진입점·서버 채팅 재접속 (2026-11-10, `04ecd29` 위 미커밋 트리)

- **입력 대기(AC.4 일부):** 승인이나 질문이 답을 기다리면 채팅 탭 제목 뒤에 터미널 탭과 같은 `입력 대기` 배지가, 턴이 돌면 `작업 중`이 붙는다(`chatStatus.ts`). 상태바 에이전트 현황에도 같은 값의 행(`채팅 · <위치>`)이 들어가고, 행을 고르거나 `Ctrl/Cmd+Shift+.`로 그 탭으로 간다. 현황판의 행 출처를 터미널 전용에서 `AgentSource` 목록으로 일반화했다. 독립 창의 채팅과 OS 알림은 아직 없다.
- **진입점(설계안 §9.7):** 제목 줄 채팅 아이콘과 `Ctrl/Cmd+Shift+A`(`Shift+L`은 로컬 터미널과 겹쳐 사용자 결정으로 변경)가 팝오버를 연다. 새 채팅은 **현재 탭 따라가기**(포커스된 SSH 탭의 서버와 셸 폴더, 로컬 셸이면 이 PC, 채팅 탭이면 그 옆) 또는 **고정** 작업 영역에서 열린다. 모드·고정·최근 작업 영역 6개는 `dachsterm.chatLaunch`에 저장하고 읽을 때 검증한다. 입력을 기다리는 채팅 수가 아이콘에 표시된다.
- **연결 공유:** 터미널 탭에서 연 SSH 채팅(따라가기, 파일 트리 **여기서 채팅 열기**)은 그 터미널의 연결로 시작해 OTP를 다시 묻지 않는다. 연결 트리와 고정 위치는 로그인 전용 연결을 새로 연다.
- **서버 채팅 재접속(AC.9 일부):** 채팅 ID와 연결 ID를 분리했다. 연결이 끊기면 채팅은 `disconnected`가 되고 스트리밍 중인 답, 실행 중 도구, 답하지 않은 승인 카드를 그대로 둔다(카드 버튼만 잠김). **다시 연결**은 터미널 연결이 살아 있으면 그것으로, 아니면 새 로그인으로 `chat_attach`를 호출해 읽던 바이트부터 이어 읽는다. 끊긴 동안 쓰인 출력과 그 사이 나온 승인 요청이 먼저 오고, 끊기기 전 승인은 백엔드가 입력을 보관하고 있어 다시 붙은 뒤 답할 수 있다. 에이전트가 끊긴 동안 끝났으면 남은 출력을 읽고 끝을 알린다.
- **함께 고침:** 브라우저 실행처럼 채널을 만들 수 없을 때 채팅이 "시작하는 중"에 멈추던 문제(채널 생성이 `try` 밖). `chatState.ts`가 400줄을 넘어 타입(`chatTypes.ts`)과 표시 함수(`chatText.ts`)를 나눴다. `App.tsx`는 793줄 유지.
- **실행기 스크립트 실측(Mac `/bin/sh`, 가짜 실행 폴더):** 끝난 에이전트는 오프셋 뒤 출력(`line2`, `line3`)을 읽고 종료 0, 폴더가 없으면 종료 3, 살아 있는 에이전트는 새 줄(`line4`)까지 따라가다 끝나면 종료 0.
- **게이트(Mac, 미커밋 트리):** `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -D warnings` 통과, `cargo test --workspace --locked` 670 통과(무시 3)+1. `npm run format:check`, `lint`, `typecheck` 통과, Vitest 112파일 1357 통과, Playwright 532 통과. 새 검사: `chat.spec.ts`의 끊김 중 승인 유지·터미널 연결로 다시 붙기·새 로그인으로 다시 붙기, `chat-launcher.spec.ts`(단축키, 따라갈 탭 없음 안내, 고정 저장, Esc, 새 채팅 탭), 단위 테스트(`chatStatus`, `chatPlaces`, 재접속 상태 전이, 단축키, `attach_script`).
- **미실행:** 실제 앱의 russh 경로로 끊고 다시 붙기(컨테이너 `dachsterm-ac1`), 터미널 연결 공유로 실제 `claude` 시작, 탭 배지와 팝오버의 실제 앱 화면(Mac WKWebView, Windows), 조용한 망 끊김(keepalive가 끊김을 알리기 전 **다시 연결**을 누를 수 없음), CI.
