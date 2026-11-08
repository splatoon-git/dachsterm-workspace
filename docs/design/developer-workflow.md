# 개발자 작업 흐름 — 설계안

- 작업 ID: **DX.0~DX.14**, 설계일: **2026-11-07**(DX.11~DX.14는 2026-11-08 추가).
- 현재 상태: **DX.1~DX.14 구현. 실제 CLI 에이전트·외부 push 수동 확인과 Mac 실기기(M.15) 대기. DX.12.0 실측 완료, DX.13.0 Windows 실측 완료(Mac 항목 대기). DX.13·DX.14는 Windows 네이티브 합격, Mac 대기.** 상태 정본은 [progress.md](../progress.md), 범위 정본은 [roadmap.md §19](../roadmap.md)이다.
- 선행 설계: [에이전트 터미널 지원](agent-terminal.md)(AT). 이 문서는 AT 위에 서버 작업 기반, Git, 여러 에이전트 운영을 더한다.
- 기준 자료: Claude Code 공식 문서(2026-11-07 확인), russh 0.65.1 문서, OpenSSH·tmux 매뉴얼, 저장소 코드 `a01efa6`.
- 문서로 확정되지 않은 동작은 **DX.0 실측**으로 표시했다. 실측 전에는 사실로 취급하지 않는다. 크기, 시간, 개수 값은 구현 출발점인 제안값이다.

## 1. 목표와 경계

**서버에서 CLI 코딩 에이전트와 Git으로 일하는 개발자를 위한 SSH 클라이언트**를 만든다. MobaXterm과 기능 수로 경쟁하지 않고 다음 작업 흐름을 끊기지 않게 한다.

1. 서버에 접속하면 끊겨도 작업이 유지되고, 내 PC의 키로 `git push`할 수 있다.
2. 저장소 폴더를 고르고 worktree에서 에이전트를 시작한다.
3. 여러 서버의 에이전트를 맡겨 두고, 입력을 기다리는 것만 찾아간다.
4. 고친 코드를 앱 안에서 검토하고, 줄에 남긴 의견을 에이전트 프롬프트로 보낸다.
5. 서버에서 push할 때 앱이 서명 요청을 보여주고 승인을 받는다.

AT의 원칙을 그대로 따른다: 전용 모드 없음, 화면 글자 해석 없음, 서버 자동 변경 없음, 앱 안 AI 호출 없음. 여기에 다음 경계를 더한다.

| 경계 | 내용 |
|---|---|
| **Git은 읽기만 한다** | 상태와 diff만 조회한다. stage, commit, push, 되돌리기, 그래프 UI는 만들지 않는다. 쓰기는 터미널과 에이전트의 일이다 |
| **도구가 가진 기능을 쓴다** | worktree 생성과 정리는 `claude --worktree`에 맡긴다. 프리셋은 명령 문자열 데이터일 뿐이며, 다른 CLI도 같은 방식으로 추가한다 |
| **서버 쓰기는 사용자의 명시적 동작뿐이다** | 훅과 tmux 설정은 안내서에 복사 가능한 예시로만 둔다 |
| **폴링하지 않는다** | Git 조회는 사건이 있을 때만 한다. SSH 채널과 서버 부하를 상시 쓰지 않는다 |
| **사용자 문구에 외부 제품명을 쓰지 않는다** | 앱 화면과 사용 안내서는 "CLI 에이전트"처럼 일반 표현을 쓴다(규칙 §3). 제품명은 이 문서 같은 내부 문서에만 둔다 |

## 2. 코드에서 확인한 제약

| 제약 | 근거 | 설계에 미치는 영향 |
|---|---|---|
| `session.ts`가 399줄이다 | 상한 400줄. AT 설계 당시 392줄 | AT.1의 `integrations.ts` 분리에서 OSC 등록(`session.ts:135-155`)을 먼저 옮겨 여유를 만든다 |
| `App.tsx` 1336줄, `FilePanel.tsx` 988줄, `ssh.rs` 755줄 | 순증 금지 대상 | `App.tsx`는 `Tab`(`App.tsx:59`)을 옮겨 예산을 만든다. `FilePanel`은 건드리지 않는다. `ssh.rs`는 §4 DX.2대로 상쇄한다 |
| `Broker::send`가 `Data`가 아닌 모든 이벤트를 `state`에 저장하고 창 인계 때 재생한다 | `windows.rs:34-48`, `:56-65` | 연결 후 보내는 일회성 이벤트가 `connected` 상태를 덮어쓴다. 일회성 이벤트는 저장에서 제외해야 한다 |
| 경로 따라가기 훅은 프롬프트를 감지해 셸에 글자를 입력한다 | `directoryHook.ts:93-124` | tmux에 다시 붙으면 에이전트나 Vim이 도는 패널에 입력될 수 있다. tmux 세션에서는 끈다 |
| 원격 실행 코드가 이미 여러 벌이고 셸 인용 함수도 두 벌이다 | `shell_probe.rs`, `monitoring.rs`, `archive.rs`, `podtree.rs:75`, 구조 검토 B10 | 규칙 §4에 따라 네 번째를 복사하지 않고 공용화한다(DX.1) |
| OSC를 웹뷰가 파싱한다 | `session.ts:141-155` | 독립 창의 상태를 메인 창이 모른다. 현황판에는 창 간 전달이 필요하다 |
| `Profile`이 `deny_unknown_fields`이고 세션 JSON이 스키마 v3이다 | `storage.rs:11`, `session-format.schema.json` | 새 필드를 넣으면 이관 경로를 함께 정해야 한다. 가져온 파일로 agent forwarding이 켜지면 안 된다 |
| 일반 셸 탭은 연결마다 PTY가 하나다. PodTree 탭만 기존 연결에 채널을 추가한다 | `ssh.rs:484-497`, `podtree.rs:420-431` | 같은 서버의 셸 탭 추가는 새 SSH 연결이며 OTP를 다시 묻는다. 셸 탭의 채널 공유는 수명, 창 분리, 로그 규칙이 달라 B1 이후 후속이다 |

## 3. 공통 구조

### 3.1 새 파일

| 파일 | 역할 | 작업 |
|---|---|---|
| `src-tauri/src/remote_exec.rs` | 제한된 원격 명령 실행, POSIX 인용, 출력 표식 처리 | DX.1 |
| `src-tauri/src/agent_forward.rs` | 로컬 agent 연결과 채널 중계, 수명, 개수 제한 | DX.2 |
| `src-tauri/src/agent_filter.rs` | agent 프로토콜 프레임 파서와 허용 판단. 순수 로직 | DX.2 |
| `src-tauri/src/terminal_start.rs` | tmux 시작 명령 생성과 이름 검증. 순수 로직 | DX.3 |
| `src-tauri/src/git_status.rs` | 상태 명령과 porcelain v2 파서 | DX.5 |
| `src-tauri/src/git_diff.rs` | diff 명령, 입력 검증, 상한 | DX.6 |
| `features/terminal/AgentSignPrompt.tsx` | 서명 승인 대화상자 | DX.2 |
| `features/git/gitStatus.ts`, `useGitStatus.ts` | 조회 일정(단일 요청, 사건 기반)과 요약 | DX.5 |
| `features/git/unifiedDiff.ts` | diff 파서와 좌우 행 구성. 순수 로직 | DX.6 |
| `features/git/ReviewPanel.tsx`, `DiffView.tsx`, `git.css` | 검토 패널 | DX.6 |
| `features/agents/AgentLaunchDialog.tsx`, `AgentPresetSettings.tsx`, `presets.ts`, `features/terminal/launch.ts`, `app/useAgentLaunch.tsx` | 에이전트 시작 확인, 프리셋 편집, 프롬프트 입력, 두 기능 연결 (계획 이름 `AgentLauncher.tsx`에서 바꿈) | DX.7 |
| `app/AgentBoard.tsx`, `agentRows.ts`, `agentStatus.ts`, `useAgentBoard.ts` | 현황판과 합치기 로직. 탭 상태와 Git 결과를 잇는 코드라 `app/`에 둔다(DX.8 절) | DX.8 |
| `features/terminal/commandMarks.ts` | OSC 133 표식, 이동, 긴 명령 판단 | DX.9 |
| `components/fileDecorations.ts` | 파일 트리 행 표시용 컨텍스트 | DX.5 |
| `app/SessionTab.tsx`, `app/ReviewDock.tsx` | `Tab` 이동과 검토 패널 연결 | AT.2, DX.6 |
| `src-tauri/src/ssh_keys.rs` | 개인키 읽기·해독. `ssh.rs`에서 옮겨 로그인과 내장 agent가 함께 쓴다 | DX.11 |
| `src-tauri/src/agent_keys.rs` | 내장 agent의 키 목록, 서명, 시스템 agent 목록과 합치기 | DX.11 |
| `features/sessions/ForwardKeysField.tsx` | 세션 고급 옵션의 전달할 키 목록 | DX.11 |
| `src-tauri/src/git_credential.rs` | 원격 소켓 전달, 요청 파서, 승인 대기, 이 PC 쪽 출처 | DX.12 |
| `features/terminal/GitCredentialCard.tsx` | 자격 증명 승인과 직접 입력 카드 | DX.12 |
| `src-tauri/src/local_agent.rs`, `local_agent/pipe.rs`, `local_agent/settings.rs` | 로컬·WSL 탭의 pipe·소켓 수신, 탭 수명, 셸 환경 변수 / Windows pipe의 DACL / 앱 설정과 명령 | DX.13 |
| `src-tauri/src/agent_relay.rs` | agent 요청 하나에 답하는 중계. 원격 채널과 로컬 탭이 함께 쓴다(`agent_forward.rs`에서 옮김) | DX.13 |
| `src-tauri/src/approval.rs` | 승인 카드의 소유자(원격 연결 / 로컬 탭)와 이벤트 대상. DX.12도 쓴다 | DX.13 |
| `components/KeyFileList.tsx`, `components/keyFiles.ts`, `features/agents/LocalAgentSettings.tsx` | 키 파일 목록(세션 폼과 설정 창 공용, `features/sessions/forwardKeys.ts`에서 옮김), 설정 창 › 에이전트의 로컬 탭 절 | DX.13 |
| `src-tauri/src/credential_helper.rs` | `dachsterm git-credential get` 실행 모드. 화면 없이 pipe로 중계 | DX.14 |
| `src-tauri/src/git_credential/wsl.rs` | WSL 탭의 자격 증명 pipe, 셸 환경, 요청 처리(구현에서 추가) | DX.14 |

기능 간 직접 import를 만들지 않는다(규칙 §7). `App`이 `features/git`의 값을 `components/fileDecorations.ts` 컨텍스트로 내려보내면 `FileTreeRow`가 표시한다. 이 방식이면 `FilePanel.tsx`를 수정하지 않는다.

### 3.2 세션 설정

`Profile`에 두 필드를 추가한다. `serde(default)`이므로 DB 스키마 변경은 없다.

| 필드 | 기본값 | 검증 |
|---|---|---|
| `forwardAgent: bool` | `false` | SSH만 허용 |
| `tmuxSession: String` | 빈 값(끔) | SSH만 허용. `[A-Za-z0-9_-]`, 1~64바이트 |

- 폼에서는 **고급 옵션**에 둔다. 값이 있으면 자동으로 펼친다(`hasConnectionOverrides`).
- **세션 JSON v3은 바꾸지 않는다.** 내보내기와 가져오기에서 두 값을 기본값으로 되돌린다. 신뢰할 수 없는 파일이 키 사용 권한을 켜는 경로를 막기 위해서다. tmux 이름 이관이 필요해지면 v4에서 별도로 다룬다.
- 템플릿과 일괄 수정(`session_management.rs`)에는 1차에서 넣지 않는다.
- "같은 접속 대상" 비교(`commands.rs:46,124,231`, B6)에 넣지 않는다. 이 값을 바꿔도 저장된 비밀을 지우면 안 된다.

## 4. 작업별 설계

### DX.0 — 실측 (게이트)

AT.0과 같은 환경에서 함께 실행하고 결과를 `docs/verification/developer-workflow.md`에 기록한다.

| 질문 | 결과에 따른 처리 |
|---|---|
| 훅의 `terminalSequence` OSC 777이 tmux 안에서 DachsTerm까지 오는가. `allow-passthrough` 끔·`on`·`all`, 보이는 창·숨은 창 각각 | DX.4의 지원 조건 확정. 오지 않으면 DX.4 중단 |
| `jq` 없이 고정 JSON만 출력하는 훅이 동작하는가 | 안내서 예시 확정 |
| "작업 중"에 쓸 훅 이벤트(`UserPromptSubmit` 등)가 있는가 | DX.4 표 확정. 공식 문서에서 이벤트 이름을 다시 확인한다 |
| `agent_forward(true)`를 서버가 거부하면 russh가 어떻게 알리는가(`AllowAgentForwarding no`) | 사용자 안내 시점 결정 |
| 전달된 agent로 `ssh-add -l`, 실제 `git push`가 되는가. Windows OpenSSH agent와 Unix 각각 | DX.2 합격 기준 |
| `session-bind@openssh.com` 전달과 `ssh-add -h` 제한 키가 동작하는가 | 동작하지 않으면 미지원으로 안내 |
| Finder로 실행한 Mac 앱에 `SSH_AUTH_SOCK`이 있는가 | 없으면 agent 인증과 전달 모두 대체 경로 필요 |
| PTY + `exec` 시작에서 tmux가 정상 동작하는가(resize, 한글, 재접속 후 붙기) | DX.3 합격 기준 |
| `MaxSessions` 기본값에서 터미널, SFTP, 모니터링, 터널, Git 조회가 함께 동작하는가 | 실패 빈도가 높으면 조회 빈도 제한 강화 |
| `claude --worktree`의 작업 폴더가 `git worktree list --porcelain`에 나타나는가 | DX.6 worktree 선택 확정 |

### DX.1 — 공용 원격 실행

새 기능의 원격 명령은 모두 이 모듈을 거친다.

```rust
pub struct Limits { pub timeout: Duration, pub max_output: usize }
pub struct Output { pub stdout: Vec<u8>, pub stderr: Vec<u8>, pub exit: Option<u32> }
pub async fn run(handle: &Handle, script: &str, limits: Limits) -> Result<Output>;
pub fn quote(value: &str) -> String; // POSIX 작은따옴표 인용
```

- `script`는 `sh -c '<인용>'`으로 감싼다. fish나 csh 로그인 셸에서도 같은 문법으로 동작하게 하기 위해서다.
- 로그인 셸의 rc 파일이 출력을 섞을 수 있으므로(`shell_probe.rs:9`) 표준 출력 시작을 표식으로 구분하고 표식 뒤만 파싱한다.
- 시간 초과와 출력 초과는 채널을 닫고 오류를 반환한다. 호출이 취소되면 채널도 닫힌다.
- 구현: AT.6과 DX.3의 선행으로 먼저 넣었다. `stderr`는 쓰는 곳이 없어 `Output`에서 뺐다.
- `podtree.rs:75`의 `quote`와 `shell_probe.rs`를 이 모듈로 옮긴다. 표준 입력을 쓰는 `archive.rs`와 주기 수집용 `monitoring.rs`는 정책이 달라 B10에서 별도로 판단한다. AT.6의 `remote_ports`는 이 모듈을 쓴다.
- DX.5에서 `stderr`를 되살렸다(수동 조회 때 첫 줄 표시). 시간·출력 초과는 `Failure::{TimedOut, TooLarge}`로 구분해 호출자가 문구가 아니라 종류로 분기한다(규칙 §6). `String` 변환이 있어 기존 호출의 `?`는 그대로다.

**B10 판단(2026-11-07):**

| 대상 | 판단 | 근거 |
|---|---|---|
| `monitoring.rs` 수집 | **옮긴다.** 완료 | 주기성은 호출하는 루프의 정책이고 한 번의 수집은 시간·출력 상한이 있는 읽기 명령이라 이 모듈과 정책이 같다. 옮기면 세 가지가 고쳐진다: ① 시간 초과 때 채널을 닫지 않아 서버 프로세스와 채널이 남던 것(2초 주기라 `MaxSessions`를 잠식할 수 있다), ② 로그인 셸의 rc 출력이 섞이던 것, ③ fish·csh 로그인 셸에서 `LC_ALL=C; export LC_ALL`이 문법 오류이던 것(`sh -c`로 해결). 상한(10초, 256KiB), 종료 코드 확인, 시간 초과 문구는 유지했다. 차이: stderr도 256KiB 상한에 포함한다 |
| `archive.rs` | **옮기지 않는다** | ① 요청 JSON을 표준 입력으로 보내고 EOF를 보내야 하는데 `run`은 표준 입력이 없다. 이 한 곳을 위해 공용 API를 넓히지 않는다. ② 시간 초과(600초) 때 채널을 닫으면 압축 해제가 이름 바꾸기 도중에 끊길 수 있다. 지금은 서버 작업을 끝까지 두고 "서버의 작업 상태와 임시 폴더를 확인하라"고 안내하는데, 이 모듈은 시간 초과 때 채널을 닫는 것이 정책이라 반대다. ③ 실행 프로그램이 `sh`가 아니라 `python3 -c`라 표식 줄 처리가 필요 없다(응답은 JSON 한 개). 인용 함수도 결과가 같아 바꾸지 않는다. 표준 입력이 필요한 두 번째 기능이 생기면 그때 `run`에 입력 인자를 더한다 |

### DX.2 — Agent forwarding과 서명 승인

**필요한 이유:** 서버에서 내 키로 `git push`하려면 필요하다. 그러나 [OpenSSH 문서](https://man.openbsd.org/ssh_config)가 경고하듯 서버에서 권한을 얻은 사람은 키를 빼 갈 수는 없어도 agent에 등록된 키로 서명할 수 있다. **서버에서 도는 에이전트도 같은 위치에 있다.** 그래서 단순 전달이 아니라 필터와 승인을 함께 넣는다. 이 점이 제품의 차별점이기도 하다.

**연결:**

- 최종 서버의 터미널 채널에서 `request_shell` 전에 `channel.agent_forward(true)`를 호출한다. Git 조회 등 exec 채널에는 요청하지 않는다.
- `Handler::server_channel_open_agent_forward`를 구현한다. `Host`에 `forward_agent` 필드를 두고 **요청한 연결이 아니면 거부한다.** 경유 호스트는 프로필 값과 무관하게 항상 거부한다. 서버의 요청만으로 agent에 닿아서는 안 된다.
- 인증 방식이 `agent`가 아니어도 쓸 수 있다.
- 로컬 연결: Windows는 기존 `agent_pipe()`의 named pipe, Unix는 `SSH_AUTH_SOCK`의 소켓이다. 두 OS를 같은 변경에서 구현한다(규칙 §11). agent에 연결할 수 없으면 채널을 거부하고 연결당 한 번 안내한다.
- 연결당 채널 8개로 제한한다. 태스크 소유자는 연결이고, `stop` 수신과 채널 종료 시 끝난다(규칙 §6).
- `ssh.rs`는 순증 금지이므로 handler에는 위임 호출만 넣고, `Host::verify`의 호스트키 흐름을 하위 모듈로 옮겨 상쇄한다.

**필터(`agent_filter.rs`):** 서버에서 온 프레임을 파싱해 허용 목록만 통과시킨다. 프레임은 256KiB로 제한하고 형식이 틀리면 채널을 닫는다.

| 메시지 | 처리 |
|---|---|
| `REQUEST_IDENTITIES`(11) | 통과 |
| `SIGN_REQUEST`(13) | 승인 후 통과. 거부와 시간 초과는 `FAILURE` |
| `EXTENSION`(27) 중 `session-bind@openssh.com` | 통과 |
| 그 밖의 모든 메시지(키 추가, 삭제, 잠금, 기타 확장) | 로컬 agent에 보내지 않고 `FAILURE` 응답 |

**서명 승인:**

- 기본은 매번 확인이다. 선택지는 **거부**, **이번만 허용**, **이 연결에서 10분 허용**이다. 허용 상태는 메모리에만 둔다. 60초 안에 답이 없으면 거부한다.
- 대화상자 내용: 세션 이름, 키 코멘트와 SHA-256 지문, 그리고 해석 가능한 경우 요청 내용(SSH 로그인이면 사용자 이름, `SSHSIG`면 서명 namespace). `session-bind`를 받았으면 대상 호스트키 지문도 표시한다. 서버 문자열은 일반 텍스트로 표시하고 숨김 문자를 제거한다.
- 포커스가 다른 곳에 있으면 AT.3 경로로 알림을 보내고 탭을 입력 대기로 표시한다.
- 무인 실행에는 맞지 않는다. 안내서에서 무인 push는 서버 전용 배포 키를 쓰도록 권한다.

**이벤트:** `Event::AgentSign`을 추가하고 `agent_sign_reply`로 답한다. `Broker::send`는 이 이벤트를 **`state`에 저장하지 않는다**(§2). 승인 대기 중에 창을 옮기면 요청이 사라지고 시간 초과로 거부되어 안전한 쪽으로 실패한다. 대기 맵은 락을 쥔 채 await하지 않는다.

**합격:** 서버에서 `ssh-add -l`이 내 키를 보여주고 승인 후 실제 Git 서버로 push된다. 거부하면 push가 실패한다. 서버의 `ssh-add -D`가 로컬 키를 지우지 못한다. 경유 호스트와 옵션을 끈 연결에서는 agent 채널이 거부된다.

**TW 반영과 구현에서 정한 것(2026-11-07):**

- **대화상자가 아니라 창 안 카드다.** 호스트키 확인 카드(`trust-card`)와 같은 자리에 `features/terminal/AgentSignCard.tsx`를 띄운다. 터미널이 보여야 내가 실행한 명령의 요청인지 판단할 수 있기 때문이다. 카드는 포커스를 가져가지 않아 터미널에 치던 키가 답이 되지 않는다. 남은 초를 표시하고, 좁은 칸에서는 상세만 줄어들고 버튼은 화면에 남는다. 그래서 §3.1의 `AgentSignPrompt.tsx`는 만들지 않았다.
- 대기 중인 요청은 탭과 독립 창에 `입력 대기`로 표시한다(`useSignWaiting`). 포커스가 터미널 밖이면 AT.3의 `programNotifier`로 알림을 보낸다. 요청은 받은 연결 ID에 묶여 재접속 뒤에는 표시되지 않는다.
- `forwardAgent`는 세션 폼의 접힌 고급 옵션에 체크박스로 두었다(`AgentForwardField.tsx`). 켜져 있으면 고급 옵션이 펼쳐진다. 새 전역 설정과 단축키는 없다. 카드의 세 버튼만으로 답한다.
- 서버 거부를 알리려고 `Event::AgentNotice`를 하나 더 두었다. `AgentSign`과 함께 `Broker` 상태에 저장하지 않는다. 안내는 연결당 한 번이다(서버가 전달 요청을 거부, 로컬 agent 연결 불가).
- 전달 요청은 PTY 요청 **전에** `want_reply=true`로 보내고 응답을 받는다. 셸 뒤에 받으면 tmux의 `exec` 거부(`ChannelMsg::Failure`) 처리와 섞이기 때문이다. 성공했을 때만 그 연결의 채널을 받는다.
- 서명 요청의 키가 로컬 agent 목록에 없으면 묻지 않고 `FAILURE`를 준다. 목록은 같은 agent 연결에 `REQUEST_IDENTITIES`를 보내 얻고, 키 코멘트 표시에도 쓴다.
- `ssh.rs`는 751줄에서 730줄이 됐다. `Host::verify`를 `ssh/host_key.rs`로 옮겼다. `session.ts`는 400줄을 넘지 않도록 `release()`와 같은 내용을 복사하던 `dispose()`와 종료 명령 분기 두 곳을 합쳤다.
- DX.0 중 이번에 실측한 것: `AllowAgentForwarding no` 서버는 요청에 `CHANNEL_FAILURE`로 답하고 russh는 `ChannelMsg::Failure`로 전달한다. 원격 `ssh`가 보내는 `session-bind@openssh.com`이 통과해 카드에 대상 호스트키를 표시한다. `ssh-add -h` 제한 키와 Finder로 실행한 Mac 앱의 `SSH_AUTH_SOCK`은 아직 실측하지 않았다.

### DX.3 — tmux 세션 연결

**시작 방식:** 프롬프트에 글자를 입력하지 않고 PTY + `exec`으로 시작한다. 셸 상태에 의존하지 않고, 실행 중인 프로그램에 입력이 들어갈 일이 없다.

```sh
command -v tmux >/dev/null 2>&1 || {
  printf '\033]777;DachsTerm;tmux;missing\007'
  exec "${SHELL:-/bin/sh}" -l
}
exec tmux new-session -A -s '<이름>'
```

- `ssh.rs:496`의 `request_shell` 자리를 `terminal_start::begin(&channel, &profile)` 호출로 바꾼다. `exec`을 거부하는 서버에서는 오류를 표시한다. 사용자가 켠 옵션이므로 조용히 대체하지 않는다.
- tmux가 없으면 일반 셸로 시작하고 앱이 안내한다.

**함께 바뀌는 동작:**

| 항목 | 처리 |
|---|---|
| 경로 따라가기, 조작표 훅 | **tmux 세션에서는 설치하지 않는다**(§2). `session.ts:78`의 `mode`가 `'none'`을 반환한다 |
| 파일 트리 따라가기 | 탭 활성화와 새로고침 때 `tmux display-message -p -t '=<이름>:' '#{pane_current_path}'`를 조회한다. 폴링하지 않는다 |
| 재접속 | 같은 세션에 다시 붙는다. 명령을 재실행하지 않는다는 원칙은 유지된다. 사용 안내서의 "재접속은 새 셸" 문구에 예외를 추가한다 |
| 탭 닫기 | 서버 세션은 유지된다. 처음 닫을 때 한 번 안내한다. 앱에서 세션을 종료하는 기능은 넣지 않는다 |
| 스크롤백 | tmux가 소유한다. 앱 스크롤백에 남지 않으므로 안내서에 `set -g mouse on`을 적는다 |
| `SSH_AUTH_SOCK` | 다시 붙은 기존 패널은 옛 소켓을 가리킬 수 있다. `eval "$(tmux show-environment -s SSH_AUTH_SOCK)"`를 안내서와 기본 명령에 넣는다 |

**구현에서 더한 것:**

- UTF-8 세션은 `tmux -u`로 시작한다. exec에는 로그인 환경이 없어 로케일이 비어 있을 수 있고, 그러면 tmux가 한글을 다른 문자로 바꾼다.
- 로그인 셸이 fish나 csh여도 같게 동작하도록 시작 명령을 `sh -c`로 감싼다.
- `exec`을 거부하면 서버의 `Failure` 응답을 받아 오류로 표시한다. russh의 `exec`은 응답을 기다리지 않으므로 읽기 루프에서 처리하며, tmux 연결에만 적용한다.
- 새로고침 대신 탐색기의 **경로 가져오기**로 활성 패널의 폴더를 조회한다. `FilePanel`이 순증 금지이기 때문이다.
- 탭을 처음 닫을 때 한 번 안내하고(`app/tmuxNotice.ts`), 연결 상태 줄에도 tmux 표시를 둔다.
- `SSH_AUTH_SOCK` 항목은 DX.2에서 다룬다. agent 전달이 아직 없어 이번 시작 명령에는 넣지 않았다.

**안내서에 넣을 설정(Claude Code 문서 기준, 앱이 쓰지 않는다):**

```text
set -g allow-passthrough on
set -g focus-events on
set -s extended-keys on
set -as terminal-features 'xterm*:extkeys'
```

**합격:** 연결이 끊긴 뒤 재접속하면 실행 중이던 Claude Code가 그대로 보인다. tmux가 없는 서버에서는 일반 셸과 안내가 나온다. 어떤 경우에도 앱이 패널에 글자를 입력하지 않는다.

### DX.4 — tmux 안의 에이전트 상태

공식 문서상 Claude Code는 tmux 안에서 OSC 7501을 쓸 수 없다. 대신 훅의 `terminalSequence`는 OSC 777을 허용하고 tmux 안에서도 동작한다고 되어 있다. 이 경로로 같은 상태 저장소를 채운다. **DX.0에서 확인되어야 진행한다.**

| 훅 이벤트 | 시퀀스 | 상태 |
|---|---|---|
| `PermissionRequest`, `PreToolUse`(`AskUserQuestion`), `Notification`(`permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`) | `OSC 777;DachsTerm;status;blocked` | 입력 대기 |
| `Stop` | `OSC 777;DachsTerm;status;done` | 완료 |
| `StopFailure` | `OSC 777;DachsTerm;status;error` | 오류 |
| `UserPromptSubmit`, `PostToolUse` | `OSC 777;DachsTerm;status;working` | 작업 중 |

- AT.2의 `programStatus` 레코드에 고정 `id=hook`으로 넣는다. 탭 합치기, 알림, 수명 규칙은 AT.2와 같다. 값은 허용 목록의 네 단어만 받고 나머지는 무시한다.
- **앱이 훅을 설치하지 않는다.** 안내서와 설정 화면에 복사용 예시를 둔다. 예시는 `jq` 없이 고정 JSON을 출력한다.
- 표현의 한계를 안내한다: 한 탭의 tmux 패널 여러 개는 구별되지 않고, 다른 tmux 창에 가려진 패널의 신호는 오지 않는다([실측](../verification/agent-terminal.md)).
- `PostToolUse`는 설계 뒤 추가했다. 승인에 답한 뒤 다음 보고까지 탭이 `입력 대기`로 남는 것을 막는다.
- `Notification`은 종류를 제한한다. 전체를 받으면 `idle_prompt`(응답 후 약 60초 입력 없음)가 끝난 작업을 `입력 대기`로 바꾼다. 실제 실행에서 발견했다.
- 질문 도구는 `PermissionRequest`나 알림 발생이 문서에 보장되지 않아 `PreToolUse`로 받는다.

### DX.5 — Git 상태 표시

**명령(고정 형식, 경로만 인용):**

```sh
cd -- <폴더> && printf <표식> && git rev-parse --show-toplevel &&
LC_ALL=C GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false status --porcelain=v2 --branch -z
```

- `core.fsmonitor`는 저장소 설정만으로 프로그램을 실행할 수 있어 끈다. `GIT_OPTIONAL_LOCKS=0`은 사용자의 Git 작업과 잠금이 충돌하지 않게 한다.
- **남는 위험:** clean 필터는 드라이버 이름이 저장소마다 달라 옵션으로 끌 수 없다. 설정 `gitStatus`로 자동 조회를 끌 수 있게 하고 안내서에 적는다. `safe.directory`는 그대로 존중하며 앱이 예외를 추가하지 않는다.
- 상한: 시간 5초, 출력 1MiB, 항목 5,000개(넘으면 "많음" 표시). 시간 초과가 나면 그 저장소의 자동 조회를 멈추고 수동 새로고침만 남긴다.
- 저장소가 아니거나 Git이 없으면 조용히 표시하지 않는다. 오류 문구로 분기하지 않고(규칙 §6), 수동 새로고침 때만 stderr 첫 줄을 보여준다. 이름이 비UTF-8인 경로는 표시만 하고 동작 대상에서 뺀다.

**조회 시점(`useGitStatus`):** 동시 요청 1개, 대기 1개로 제한하고 연결·폴더별로 관리한다.

| 사건 | 최소 간격 |
|---|---|
| 터미널 폴더 변경, 파일 트리 새로고침 | 500ms |
| 프롬프트 복귀(`OSC 1337;CurrentDir`) | 5초 |
| 탭 활성화 | 마지막 조회 후 30초 |
| 프로그램 상태가 `done`, `blocked`로 바뀜 | 5초 |

타이머 폴링은 없다. `MaxSessions`에 걸려 실패하면 다음 사건까지 기다린다.

**표시:**

- 탭: 작은 글씨 자리에 `작업 중 · main ●3`처럼 상태 뒤에 붙인다. 업스트림 차이는 툴팁에 넣는다. 접근성 이름에 전체 문장을 넣는다.
- 파일 트리: 행 오른쪽에 `M`, `A`, `D`, `?`, `U`를 글자로 표시하고, 폴더에는 하위 변경 표시만 둔다. 색은 `status` 토큰만 쓴다.
- 대상은 SSH 탭이다. FTP, PodTree, 로컬 탭에는 등록하지 않는다. 로컬 탭은 실행 경로 규칙(§11)과 WSL 경로 변환이 달라 후속으로 둔다. → 2026-11-08 DX.15에서 로컬·WSL 탭에도 넣었다(아래 DX.15).

**기본 명령:** `guideData.ts`에 Git 분류를 추가한다. `status`, `diff --stat`, `log --oneline --graph`, `branch -vv`, `stash list`, `worktree list`, `reflog`. 읽기 명령만 넣고, 기존처럼 복사만 한다.

**구현(2026-11-07)과 설계에서 바꾼 것:**

- 백엔드는 `git_status.rs`(조회 전용 모듈)다. DX.6이 같은 안전 접두사(`SAFE_GIT`)를 쓴다. 명령의 `printf <표식>`은 `remote_exec`가 이미 rc 출력을 가르므로 뺐다. 결과는 `repo | notRepo | stopped` 판별 유니온이고, 연결 실패 같은 오류만 `Err`다.
- **표시 위치(사용자 결정):** 브랜치와 변경 수는 탭이 아니라 **상태바**에 둔다(`app/GitStatusItem.tsx`). 대상은 포커스된 칸의 활성 SSH 탭이다. 업스트림 차이는 툴팁에 넣고, 누르면 수동 조회다. 탭(`SessionTab`)에는 접근성 이름(`… Git main, 변경 3개`)과 툴팁만 덧붙인다.
- **파일 트리:** `fileTree.tsx`의 `useFileTree`가 행에 절대 경로를 붙이고 목록을 받을 때마다 `listed`를 알린다. `FileTreeRow`가 `components/fileDecorations.ts` 컨텍스트로 표시한다. `App`은 사이드바의 `SidebarFiles`를 같은 이름의 `app/SidebarFiles.tsx`(Git 컨텍스트 제공자)로 바꿔 import 한 줄만 달라졌고, `FilePanel.tsx`는 수정하지 않았다.
- **조회 일정:** `features/git/gitStatus.ts`의 `GitScheduler`(순수, 단위 테스트). 간격 안에 다시 온 사건은 남은 시간 뒤 한 번만 실행하고(타이머 반복 없음), 탭 활성화는 최근 결과가 있으면 버린다. 프롬프트 복귀는 DX.9의 OSC 133;A를 쓴다(재생 중 제외). 조회 결과는 저장소 루트로도 저장해 하위 폴더는 같은 결과를 쓴다.
- **시간·출력 초과:** `stopped`로 받아 그 폴더와 루트의 자동 조회를 멈추고 상태바에 **Git 조회 멈춤**(누르면 수동 조회)을 둔다. 출력 1MiB 초과도 같은 처리다.
- **수동 조회:** 자동 조회를 끄면 상태바에 작은 **Git** 버튼만 남는다. 상시 버튼을 늘리지 않으려고 자동 조회를 끈 경우에만 보인다. 실패 때만 첫 줄을 `Git · …`로 보여 준다.
- 비UTF-8 경로는 손실 변환된 이름으로 표시만 된다. 동작 대상 제외는 경로로 동작하는 DX.6에서 처리한다.

### DX.6 — diff 검토와 프롬프트 전달

서버에서 에이전트가 고친 코드를 VS Code Remote 없이 검토하는 기능이다. **이 제품의 핵심 차별점으로 삼는다.**

**위치:** 작업 영역 오른쪽 도킹 패널(`app/ReviewDock.tsx`)이다. 터미널을 보면서 검토하고, 프롬프트를 보낼 대상이 분명하다. 좁은 창에서는 패널이 영역을 덮고 닫을 수 있다. 1차는 메인 창의 활성 SSH 탭만 대상으로 한다. 독립 창은 후속이다.

**비교 대상(판별 유니온):**

```ts
type DiffBase =
  | { kind: 'workingTree' }              // HEAD 대비 전체
  | { kind: 'branch'; ref: string };     // 선택한 브랜치와의 merge-base 대비
```

`ref`는 앱이 `git for-each-ref`로 받은 목록에 있는 값만 받고 `--end-of-options` 뒤에 넣는다. 패널 위에서 `git worktree list --porcelain`으로 찾은 worktree를 선택할 수 있다. 저장소 루트의 탭에서 `.claude/worktrees/<이름>`의 작업을 보려면 필요하다.

**명령:** 파일 목록은 `git diff --numstat -z`와 `git ls-files --others --exclude-standard -z`로 구한다. 파일 내용은 다음과 같다.

```sh
git -c core.fsmonitor=false -c diff.noprefix=false -c diff.mnemonicPrefix=false \
  diff --no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ <기준> -- <경로>
```

- 외부 diff와 textconv는 저장소 설정만으로 프로그램을 실행할 수 있어 끈다. 사용자 설정이 파서를 깨지 않도록 접두사를 고정한다.
- 추적되지 않은 파일은 `git diff --no-index -- /dev/null <경로>`로 보여준다. 종료 코드 1은 정상이다.
- 상한: 목록 5,000개, 파일 2MiB, 시간 10초. 넘으면 파일 크기와 함께 터미널에서 볼 명령을 안내한다. 바이너리는 "바이너리 변경"으로 표시한다. 내용은 UTF-8 손실 변환으로 표시한다.

**표시:**

- `unifiedDiff.ts`를 직접 작성한다. 형식이 단순하고 단위 테스트가 쉬워 Monaco 같은 무거운 의존성을 추가하지 않는다. 구문 강조는 1차에서 뺀다.
- 넓으면 좌우, 좁으면 위아래로 표시한다. 행은 가상화한다. 한 줄은 4,000자에서 자른다.
- 색은 `status.success`, `status.error`에서 파생하고 `+`, `−` 기호를 함께 표시한다.

**프롬프트로 보내기:**

1. 행 범위를 선택하고 의견을 적으면 패널의 **검토 목록**에 쌓인다. 앱을 닫으면 사라지는 임시 목록이다.
2. **프롬프트로 보내기**를 누르면 대상 탭 이름을 보여주고 `src/foo.ts:42-47 의견` 형식의 줄을 `terminal.paste`로 넣는다.
3. **Enter는 보내지 않는다.** 내용 수정과 전송은 사용자가 한다. 대상 연결이 바뀌었거나 끊겼으면 넣지 않고 복사를 제공한다.

서버 파일을 외부 편집기로 여는 동작은 1차에서 뺀다. 편집기 선택이 `FilePanel` 소유이고 U2 분리가 먼저 필요하다. 경로 복사와 터미널 입력은 제공한다.

**합격:** 수정, 추가, 삭제, 이름 변경, 추적되지 않은 파일, 바이너리, 공백이 포함된 경로, 한글 경로가 올바르게 표시된다. 악성 `diff.external`과 `core.fsmonitor`가 있는 저장소에서 프로그램이 실행되지 않는다. 의견이 Enter 없이 프롬프트에 들어간다.

**TW 반영과 구현에서 정한 것(2026-11-08):**

- **도킹 패널이 아니라 탭 종류다.** `TabRef`에 `{ kind: 'review'; id }`를 더했고 키는 `review:<id>`다. 상태와 터미널 연결은 `app/useReviewTabs.tsx`, 화면은 `features/git/ReviewPane.tsx`(`DiffView.tsx`, `ReviewNotes.tsx`, `useReviewData.ts`, `review.css`)다. 그래서 §3.1의 `ReviewPanel.tsx`, `app/ReviewDock.tsx`, `git.css`는 만들지 않았다. 진입점은 SSH 탭 우클릭 메뉴의 **변경 검토**와 `Ctrl/Cmd+Shift+G`다. 셸 폴더를 모르거나 연결 전이면 메뉴 항목이 비활성이다. 기본 위치는 원래 터미널 칸의 오른쪽 분할(`openBeside`)이고, 700px 이하 좁은 창에서는 같은 칸에 연다. 끌기·분할·확대는 다른 탭과 같고 탭 메뉴에 분리 항목이 없다(§10 후속).
- **대상 고정:** 검토 탭은 열 때의 탭 ID, 연결 ID, 셸 폴더, 세션 이름을 기억하고 탭 제목에 `변경 검토 · 이름`을 표시한다. 같은 탭·연결·폴더에서 다시 열면 있던 탭을 보여 준다. 조회도 기억한 연결로 한다. 대상 탭이 닫혔거나, 연결 ID가 바뀌었거나(재접속), 연결이 끊겼거나, 동시 입력 대상(`inputReach > 1`)이면 넣지 않고 사유와 **복사**를 보여 준다. 넣은 뒤에는 대상 탭을 선택하고 포커스를 옮긴다. 목록은 보낸 뒤에도 남고 **비우기**로 지운다.
- **붙여넣기 형식:** xterm `paste`로 넣는다. 대상이 bracketed paste 모드이면 의견마다 한 줄, 아니면 줄바꿈이 Enter가 되므로 ` / `로 이어 한 줄로 넣는다. 서버가 준 경로와 의견의 제어 문자는 공백으로 바꾼다. ESC로 bracketed paste를 일찍 끝내고 뒤 글자를 실행시키는 경로를 막기 위해서다. 삭제된 줄만 고른 의견은 이전 파일 번호에 `(삭제된 줄)`을 붙인다. 행 선택에 새 파일 줄이 있으면 새 번호를 쓴다.
- **명령에서 더한 것:** `GIT_LITERAL_PATHSPECS=1`(`:(top)`, `*` 같은 이름이 패턴으로 해석되지 않게), `-c diff.relative=false`, `-c core.quotePath=false`, `--find-renames`. `core.quotePath`는 기본값이면 diff 머리말의 한글 경로가 `"ì…"` 8진 표기로 나온다. Docker 실측에서 이름 변경 머리말로 발견했다. 목록은 원격 실행 한 번에 `--name-status -z`, `--numstat -z`, `ls-files --others --exclude-standard -z`를 NUL 하나로 구분해 받는다. 작업 트리 기준은 `HEAD^{commit}`이고 첫 커밋 전에는 빈 트리(`hash-object -t tree /dev/null`)다. 브랜치는 `refs/heads/`, `refs/remotes/` 아래 이름만 받고 이름 규칙을 검사한 뒤, 스크립트가 `show-ref --verify --end-of-options`로 그 시점 서버의 ref와 대조하고 `merge-base --end-of-options HEAD <ref>`를 구한다. 백엔드는 목록을 기억하지 않는다.
- **`git_refs`는 폴더를 받는다.** `rev-parse --show-toplevel`로 루트를 함께 돌려주므로 셸이 하위 폴더에 있어도 된다. worktree 경로가 UTF-8이 아니면 목록에서 빼고, ref는 2,000개까지다.
- **크기:** 작업 트리 파일 크기를 `wc -c`로 먼저 보고 2MiB를 넘으면 diff를 실행하지 않고 크기를 돌려준다. diff 출력 상한은 양쪽을 담을 수 있게 4MiB+64KiB, 목록 출력은 8MiB다. 시간·출력 초과는 `remote_exec::Failure` 종류로 받아 `stopped`·`tooLarge`·`timedOut`으로 돌려준다. 오류 문구는 종료 코드(2 폴더, 3 브랜치)와 stderr 첫 줄로만 만들고 diff 내용은 넣지 않는다.
- **비UTF-8 경로:** `readable: false`로 목록에만 표시하고 diff 요청에서 뺀다(DX.5 메모의 후속).
- **표시:** 칸 너비 900px 이상은 좌우, 미만은 위아래다. 640px 미만에서는 파일 목록이 드롭다운이 된다. 행 높이 20px 고정 가상화(앞뒤 20행)다. 좌우 보기의 긴 줄은 칸 안에서 말줄임과 툴팁, 위아래 보기는 가로 스크롤이다. 4,000자를 넘는 줄은 잘린 글자 수를 표시한다. 조회는 탭을 열 때, 기준·작업 폴더·파일을 바꿀 때, 새로 고침 때만 하고, 파일 diff는 탭 안 메모리에 둔다.
- **공용화와 줄 수:** `git_status.rs`의 `check_folder`, `first_line`을 `pub(crate)`로 함께 쓴다(문구는 "Git 저장소 폴더가 올바르지 않습니다."로 일반화). `App.tsx`는 그룹 대화상자를 `app/GroupDialog.tsx`로 옮겨 945줄에서 872줄이 됐다. `workspaceLayout.ts`는 탭 타입과 키만 바뀌어 381줄에서 384줄이다. `FilePanel.tsx`, `ssh.rs`, `session.ts`는 수정하지 않았다.

### DX.7 — 에이전트 시작

**진입점:** 파일 트리 폴더 메뉴, 세션 메뉴, 도구 메뉴. 앱은 실행 전에 최종 명령을 보여준다.

**프리셋(`dachsterm.agentPresets`, 읽을 때 검증):** 사용자가 편집한다. 기본값은 다음과 같다.

| 이름 | 명령 |
|---|---|
| 에이전트 | `claude` |
| 이어서 | `claude --continue` |
| 세션 선택 | `claude --resume` |
| 새 worktree | `claude --worktree {name}` |

`{name}`은 `[A-Za-z0-9._-]`만 허용한다. worktree 생성, 위치, 종료 시 정리는 Claude Code 동작을 따른다.

**실행 경로:**

| 경우 | 동작 |
|---|---|
| tmux 켬 | 시작 명령을 아래 형식으로 만든다. 세션이 이미 있으면 붙기만 하고 명령을 실행하지 않는다 |
| tmux 끔 | 새 탭을 연다. `DirectoryHookInstaller`의 프롬프트 판단을 공개 메서드로 꺼내 재사용하고, 프롬프트에서만 `cd`와 명령을 입력한다. 10초 안에 프롬프트를 찾지 못하면 입력하지 않고 명령 복사를 안내한다 |

```sh
tmux has-session -t '=<이름>' 2>/dev/null || {
  tmux new-session -d -s '<이름>' -c <폴더> &&
  tmux send-keys -t '=<이름>:' -l -- <명령> &&
  tmux send-keys -t '=<이름>:' Enter
}
exec tmux attach -t '=<이름>'
```

`send-keys`를 쓰는 이유는 사용자의 대화형 셸에서 실행되어 `PATH`가 맞기 때문이다. `exec`이나 tmux의 명령 인자는 rc 파일을 읽지 않아 `~/.local/bin`의 `claude`를 찾지 못할 수 있다.

**한 번만 실행한다.** 시작 명령은 탭을 여는 순간의 일회성 값이며 세션 상태에 저장하지 않는다. 재접속은 입력하지 않는다.

**제한:** 탭마다 새 SSH 연결이다. 저장된 인증은 그대로 쓰이지만 OTP 서버는 다시 묻고, 동시 연결 32개 상한을 쓴다.

**TW 반영과 구현에서 정한 것(2026-11-08):**

- **진입점(설계 수정):** 연결 트리에서 SSH 연결을 우클릭한 **에이전트 시작…**(폴더를 입력, 비우면 로그인 폴더)과 사이드바 파일 트리에서 폴더를 우클릭한 같은 항목(그 폴더로 고정)이다. 도구 메뉴에는 넣지 않았다. TW.9에서 도구 메뉴는 게임 같은 도구용으로 정했다. 상시 버튼과 단축키는 더하지 않았다.
- **확인:** Dialog M(`features/agents/AgentLaunchDialog.tsx`). 폴더, 프리셋(선택 목록), `{name}`이 있으면 이름, 최종 텍스트를 보여 준다. tmux면 **실행할 명령**, 일반 셸이면 **입력할 줄**(`cd <폴더> && <명령>`)이다. 언제 실행되고 언제 실행되지 않는지를 한 문단으로 적는다. 이름이나 폴더가 틀리면 **시작**이 꺼진다.
- **프리셋 편집 위치:** 설정 창의 **새 분류 "에이전트"**(`AgentPresetSettings.tsx`). 터미널 분류는 표시·입력 설정 모음이고, 같은 패널이 독립 창의 터미널 설정에도 쓰이는데 독립 창에서는 에이전트를 시작할 수 없다. 또 터미널 패널(`features/terminal`)이 `features/agents`를 import하면 기능 간 import가 생긴다. DX.4 훅 예시는 터미널 분류의 "CLI 에이전트" 구역에 그대로 두었다.
- **프리셋 저장:** `dachsterm.agentPresets`. 최대 20개, 이름 40자, 명령 1000자, 제어 문자 금지. 읽을 때 항목마다 검사해 틀린 항목은 버리고, 남는 것이 없거나 읽을 수 없으면 기본값을 쓴다. 편집 중 틀린 행이 있으면 저장하지 않고 이유를 표시한다. 반쯤 입력한 행이 쓰던 목록을 덮지 않게 하기 위해서다.
- **`{name}`:** 설계의 문자 집합에 **첫 글자는 영문·숫자** 조건을 더했다. `-rf`가 옵션으로, `.`·`..`가 경로로 읽히는 것을 막는다. 64자까지.
- **tmux 켬:** `connect`의 일회성 `launch {folder, command}`를 `Connections.launches`에 연결 ID로 두고, 터미널 채널을 시작할 때 한 번 꺼낸다(`terminal_start::begin`). 연결이 끝나면 남은 값도 지운다. DX.3의 `tmux_command`를 확장했다. tmux 확인과 대체 셸은 그대로이고, `new-session -A` 대신 `has-session`으로 확인한 뒤 없을 때만 `new-session -d -s <이름> -c <폴더>`, `send-keys -l -- <명령>`, `send-keys Enter`를 보내고 `exec tmux attach-session -t =<이름>`으로 붙는다. UTF-8 세션의 `-u`도 같다.
- **세션 이름은 프로필의 tmux 세션 이름이다.** 그 세션이 이미 있으면 붙기만 하고 실행하지 않는다(확인 대화상자에 표시). 에이전트마다 다른 tmux 세션을 쓰려면 지금은 프로필을 나눠야 한다. 시작할 때 세션 이름을 따로 고르는 기능은 후속이다(재접속이 그 이름을 기억해야 해서 탭 상태가 늘어난다).
- **보내기 전 검사(`Launch::check`):** 프로필에 tmux 세션이 있어야 하고, 폴더는 비었거나 `/`로 시작, 폴더·명령 각 4096바이트, 줄바꿈 등 제어 문자 금지, 세션 인코딩으로 표현 가능해야 한다. 명령은 `quote`로 감싸 `send-keys`에 그대로 넘기므로 셸이 해석하는 것은 사용자가 확인한 텍스트뿐이다. 비UTF-8 세션은 시작 스크립트를 세션 인코딩으로 바꿔 보낸다.
- **tmux 끔:** `DirectoryHookInstaller.atPrompt()`를 공개했고 `features/terminal/launch.ts`의 `typeAtPrompt`가 쓴다. 연결된 뒤 세션 훅 입력이 끝나기를 기다리고(최대 40초), 그 뒤 10초 안에 프롬프트가 보이면 줄과 Enter를 한 번 입력한다. 훅과 같은 순간에 입력하면 둘이 섞이거나 한쪽이 다른 쪽이 시작한 프로그램에 들어가므로 순서를 정했다. 시간 안에 프롬프트를 찾지 못하면 입력하지 않고 **명령을 입력하지 않았습니다** 대화상자(S)에 줄을 보여 주며 복사를 제공한다. 탭이 닫히거나 재접속하면 그만둔다.
- **재접속:** `reconnect`가 `connect`를 `launch` 없이 부르므로 어느 경우에도 다시 입력하지 않는다. tmux는 같은 세션에 붙기만 한다.
- **tmux가 없는 서버:** DX.3의 대체 셸만 열리고 시작 명령은 실행하지 않는다(확인 대화상자에 표시).
- **연결 경로와 순증:** `App.tsx`의 새 탭 인자 `beside`를 `Opening { beside, launch }`(`app/useAgentLaunch.tsx`)로 바꿔 인증과 보관함 잠금 해제를 지나도 같은 값이 이어진다. 보관함 대기 상태를 재개 함수 하나로 줄여 `App.tsx`는 945→935줄이다. 파일 트리 폴더 메뉴는 앱이 `FileDecorations.folderActions`로 항목을 주고, `FilePanel.tsx`는 그 항목을 한 줄로 펼치며 경로 계산 중복을 합쳐 914줄 그대로다. `ssh.rs`는 `check_server_key`를 줄여 730→728줄, `session.ts`는 399→400줄(상한 안)이다.
- `posixQuote`를 `lib/shell.ts`로 내렸다. 일반 셸의 입력 줄과 AT.5의 첨부 경로가 같은 인용을 쓴다.

### DX.8 — 에이전트 현황판

사이드바에 **에이전트** 보기를 추가한다. 서버 도구 현황이 아니라 **탭별 프로그램 상태**를 모아 보여준다.

- 행: 세션 이름, 상태 글자, 경과 시간, 브랜치와 변경 수, 메시지(툴팁). 정렬은 `blocked > error > working > done`이다. 상태 보고가 없는 탭은 나오지 않는다.
- 클릭하면 해당 탭을 활성화한다. 독립 창이면 그 창에 포커스한다. **다음 입력 대기로 이동** 단축키를 둔다. 터미널 입력과 겹치지 않는 키를 구현 시 확인한다.
- **독립 창:** 해당 창이 Tauri 이벤트 `agent-status`로 상태를 메인 창에 보내고, 창이 닫히면 항목을 지운다. `storage` 이벤트는 쓰지 않는다(규칙 §7). 보내는 값은 이미 정리된 표시용 문자열뿐이다. 창 포커스 권한은 `capabilities/main.json`에서 확인한다.
- 토큰 사용량, 화면 글자 해석, 서버 원격 제어는 넣지 않는다.

**TW 반영과 구현에서 정한 것(2026-11-08):**

- **사이드바 보기를 만들지 않았다.** TW.9에서 사이드바를 연결·파일 두 탭으로 줄였기 때문이다. 대신 상태바 오른쪽에 상태가 있는 탭이 하나라도 있을 때만 `입력 대기 2 · 작업 중 1`처럼 상태별 개수를 표시한다(`app/AgentBoard.tsx`). 누르면 서버 모니터처럼 상태바 위에 목록이 열린다. 바깥 클릭과 `Esc`로 닫히고 `Esc`는 포커스를 버튼으로 돌린다. 상태바는 메인 창에서만 이 항목을 받는다.
- **행:** 상태 글자, 세션 이름, 독립 창 표시, 브랜치와 변경 수(`main ●3`, 좁은 창에서는 숨김), 경과 시간(`1분 미만`, `5분`, `1시간 5분`, 목록이 열려 있는 동안 30초마다 다시 그림). 메시지는 탭 툴팁과 같은 글(`programSummaryText`)을 행 툴팁에 넣는다. 정렬은 `blocked > error > working > done`이고 같은 상태에서는 오래된 것이 위다. 경과 시간은 그 상태가 시작된 때부터다.
- **탭과 같은 기준:** 연결된 탭만, 서명 대기(DX.2)를 프로그램 상태보다 먼저, 사용자가 이미 본 `done`·`error`(탭 활성화로 확인한 것)는 넣지 않는다. 탭 표시와 목록이 어긋나지 않게 탭과 같은 값(`signWaiting`, `ProgramStatus.snapshot`)을 쓴다. 브랜치는 그 탭의 마지막 `useGitStatus` 결과(`scheduler.view`)를 읽기만 하고 새로 조회하지 않는다.
- **모으는 코드는 `app/`에 둔다.** `agentRows.ts`(정렬, 개수, 경과 시간, 다음 대기, 이벤트 검증. 순수), `agentStatus.ts`(탭 하나의 보고와 변경 구독, 독립 창의 전송), `useAgentBoard.ts`(메인 창의 탭과 독립 창 행 합치기, 이동). `features/terminal`과 `features/git`을 서로 import하지 않는다.
- **독립 창:** `DetachedWindow`가 탭 보고가 바뀔 때마다 `emitTo('main', 'agent-status', { window, report })`를 보낸다. 보고는 이름, 상태 단어, 시작 시각(숫자), Git 표시 글, 툴팁 글뿐이다. 메인 창은 창 이름(`terminal-…`)과 길이·형식을 검사한 뒤 행으로 만들고, 그 창의 `tauri://destroyed`를 창 대상(`{ kind: 'Window', label }`)으로 구독해 창이 닫히면 행을 지운다. 구독 전에 닫힌 창은 `Window.getByLabel`로 한 번 확인한다. 보고할 것이 없어지면 `report: null`을 보낸다. `storage` 이벤트는 쓰지 않는다.
- **이동:** 행을 누르면 메인 창 탭은 `openTab`으로 그 칸과 탭을 활성화하고 터미널에 포커스한다. 독립 창은 `unminimize`와 `setFocus`를 부른다. 이를 위해 `capabilities/main.json`에 `core:window:allow-set-focus`, `core:window:allow-unminimize`를 추가했다(이 권한 파일은 `terminal-*` 창에도 적용된다). 이벤트 권한은 `core:default`의 `core:event:default`(`emit-to`, `listen` 포함)로 충분하다.
- **다음 입력 대기로 이동:** `Ctrl/Cmd+Shift+.`(`Period`). 목록 순서로 현재 탭 다음의 `입력 대기` 행으로 가고 끝에서 처음으로 돈다. Ctrl+Shift 조합의 빈 키 중 제어 문자가 없고 셸·편집기·터미널 프로그램이 흔히 쓰지 않는 키라 골랐다. `J`·`I`는 웹뷰 개발자 도구 키, `A`·`W`는 셸(`Ctrl+A`)과 창 닫기 관례와 겹쳐 뺐다. 메인 창에서만 동작한다. 독립 창은 `appShortcuts`를 쓰지 않고 F11과 터미널 검색만 직접 받는다.
- `App.tsx` 순증을 막으려고 좁은 창 판정을 `app/useNarrowViewport.ts`로 옮겼다(945줄 → 938줄).

### DX.9 — 명령 경계 (OSC 133)

- `directoryHook`에 프롬프트마다 `OSC 133;D;<종료 코드>`와 `OSC 133;A`를 추가한다. 기존 훅과 같이 세션 안에서만 적용하고 파일을 쓰지 않는다. `directoryHook.test.ts`의 입력 표시 숨김 검사를 함께 갱신한다.
- 명령 시작은 Bash에 표준 preexec이 없으므로 앱이 터미널에서 받은 Enter 시각으로 판단한다. 전체 화면 프로그램 안의 Enter는 세지 않는다.
- 기능: 프롬프트 간 이동(`Ctrl/Cmd+Shift+↑↓`, 충돌 확인), 실패한 명령의 줄 표시, 긴 명령 완료 알림(기본 30초 이상, 포커스 밖일 때만, AT.3 경로). AT.2의 프롬프트 감지 보완도 이 신호를 쓸 수 있다.
- 재생 중에는 표식만 복원하고 알림은 보내지 않는다. `registerMarker`와 `registerDecoration`이 `allowProposedApi: false`에서 쓸 수 있는지 구현 시 xterm 6.0.0 타입에서 확인한다. 이 세션에 `node_modules`가 없어 확인하지 못했다.

**구현(2026-11-07)과 설계에서 바꾼 것:**

- 훅은 TW.6에서 `shellHook.ts`로 합쳐졌으므로 거기에 넣었다. 프롬프트 함수가 `133;D;<코드>`, 경로, `133;A` 순으로 보낸다. Zsh는 각 precmd 함수에 `$?`를 복원하므로 함수 위치와 무관하게 코드가 맞다.
- **명령 시작:** TW.6의 Bash 래퍼는 vi·less 등 이름 있는 프로그램만 감싸 일반 명령에 쓸 수 없다. Zsh는 `preexec`에 `133;C`를 더했다. Bash는 4.4 이상에서 `PS0`에 `133;C`를 앞에 붙인다(빈 줄에서는 출력되지 않아 빈 Enter가 실패로 잡히지 않는다, 두 번 넣어도 한 번). Bash 3.2만 설계의 Enter 시각 방식을 쓰며, 셸이 `C`를 한 번이라도 보내면 Enter 방식은 끈다. Enter 방식은 프롬프트 뒤 입력이 비었으면 세지 않고, 대체 화면 안의 Enter는 세지 않는다. `C` 없이 온 `D`는 버린다.
- **xterm 6.0.0 확인:** `registerMarker`는 `allowProposedApi: false`에서 쓸 수 있다. `registerDecoration`은 `_checkProposedApi()`로 예외를 던진다. 실험 API를 켜지 않고 `FailedCommandMarks.tsx`가 표식 줄 위치로 왼쪽 막대를 직접 그린다(스크롤·크기 변경·버퍼 전환 때 다시 계산).
- **이동:** `Ctrl/Cmd+Shift+↑↓`는 터미널 키 처리기에서만 쓴다. 표식이 없으면 키를 셸로 넘긴다. 칸 이동 `Ctrl/Cmd+Alt+방향키`와 겹치지 않는다.
- **긴 명령 알림:** AT.3 `programNotifier`에 `command` 사유를 더했다. 이 알림기는 SSH 탭에만 있어 로컬·WSL 탭은 표시와 이동만 된다. 설정 `longCommandNotify`는 끔·10초·30초·1분·5분.
- **연결 위치:** `session.ts`(400줄, DX.2와 겹침)는 수정하지 않았다. `integrations.ts`가 `attachCommandMarks`를 부르고, 탭 쪽은 `commandMarksOf(terminal)`로 찾는다. `TerminalPane.tsx`에는 키 한 줄과 표시 컴포넌트만 넣었다. 훅은 경로 따라가기나 조작표가 켜져 있을 때만 들어가므로, 둘 다 끄면 명령 경계도 없다.

### DX.10 — 문서와 전체 회귀

사용 안내서, 전체 회귀, Mac 실기기 검증을 진행한다. README의 "지원하지 않는 것"에서 agent forwarding을 뺀다. 안내서에는 agent 서명 승인과 위험, 무인 실행용 배포 키, tmux 설정, 훅 예시, Git 조회가 실행하는 명령과 남는 위험, 프롬프트 전달 방법을 적는다.

**TW 반영과 구현에서 정한 것(2026-11-08):**

- **README:** "지원하지 않는 것"의 agent forwarding은 DX.2(`91f9b1c`)에서 이미 뺐다. 이번에는 기능 목록에 SSH 키 전달과 "서버에서 개발하기"(tmux, Git·변경 검토, 에이전트 시작·현황)를 더했다.
- **안내서 배치:** 키 전달은 "SSH 연결" 아래 새 절 **SSH 키 전달**로 옮기고 인증 방식 목록에는 링크만 남겼다. 배포 키와 tmux 재접속 뒤 `SSH_AUTH_SOCK`도 그 절에 둔다. 에이전트 시작과 현황은 "터미널"의 "CLI 에이전트와 함께 쓰기" 다음 절이다. 단축키 표에 `Ctrl/Cmd+Shift+.`, 설정 분류에 **에이전트**, 상태바 설명에 현황 항목을 더했다.
- **훅 예시:** 전체 JSON(약 80줄)을 안내서에 옮기지 않고 이벤트와 상태의 표, 이벤트 하나의 모양만 둔다. 전체는 설정 창의 **훅 예시 복사**가 정본이다(`agentHooks.ts`). 두 곳에 같은 JSON을 두면 한쪽만 고쳐질 수 있다.
- **배포 키 예시:** 서버 `~/.ssh/config`에 `IdentitiesOnly yes`와 `IdentityAgent none`을 둔다. 키 전달을 켠 연결에서도 그 저장소의 push가 전달된 agent를 쓰지 않아 승인 카드가 뜨지 않는다.
- **`SSH_AUTH_SOCK`(DX.3 표의 항목):** 안내서에만 넣었다. 기본 명령(`guideData.ts`)에 `eval "$(tmux show-environment -s SSH_AUTH_SOCK)"`를 넣는 것은 코드 변경이라 이번 문서 범위에서 빼고 후속으로 남긴다. 안내 내용은 Docker OpenSSH와 tmux 3.3a에서 확인했다. 재접속해 붙은 뒤 기존 패널은 끊긴 소켓을 가리켜 `ssh-add -l`이 종료 코드 2였고, `eval` 뒤 새 소켓으로 0이 됐다.
- **Git 조회 명령:** 안내서에 `git_status.rs`가 실제로 보내는 명령 전체와 clean 필터를 확인하는 명령(`git config --show-origin --get-regexp '^filter\.'`)을 적었다.

### DX.11 — 앱 내장 agent (2026-11-08 추가)

**필요한 이유:** DX.2는 서버의 요청을 이 PC의 `ssh-agent`로 넘기기만 한다. Windows는 이 서비스가 기본으로 꺼져 있고(이 PC도 Disabled, 키 없음), Finder로 실행한 Mac 앱은 `SSH_AUTH_SOCK`이 있는지 확인되지 않았다(DX.0 미실측). 그래서 대부분의 사용자는 처음에 키 전달이 동작하지 않는다. 앱은 이미 로그인에 쓰는 개인키를 다루므로, 앱이 직접 agent가 되어 설정 없이 동작하게 한다. SSH 키 서명은 표준이라 GitHub, GitLab(자체 설치형 포함), Bitbucket, Gitea 모두 같은 방식으로 동작한다.

**전달할 키:** 서버 로그인 키와 Git 호스팅에 등록한 키가 다른 경우가 흔하므로 로그인 키만 내보내지 않는다. 세션 고급 옵션 **SSH 키 전달** 아래에 다음을 둔다.

| 항목 | 기본값 | 설명 |
|---|---|---|
| 로그인 키 | 켬 | 인증 방식이 개인키일 때만 보인다 |
| 추가 키 | 없음 | 키 파일을 골라 최대 8개. 줄마다 파일 이름, 알고리즘, SHA-256 지문을 보여주고 ⋯ 메뉴로 뺀다 |
| 이 PC의 SSH agent 키도 사용 | 켬 | 시스템 agent가 있으면 그 키도 목록에 더한다. 없으면 조용히 건너뛴다 |

- 지문은 새 명령 `ssh_key_info`가 개인키 파일의 공개 부분에서 읽는다. 공개 부분을 읽을 수 없는 형식(암호화된 PEM)은 같은 이름의 `.pub`를 읽고, 그것도 없으면 "첫 서명 때 확인"으로 표시한다.
- 추가 키의 Passphrase는 DB에 참조만 두고 값은 OS 저장소나 금고에 둔다(기존 비밀 참조와 정리 journal 규칙). 저장하지 않은 키는 첫 서명 승인 때 카드에서 묻는다.

**동작(`agent_keys.rs` 새 파일, `agent_forward.rs`는 연결만 바꾼다):**

| 요청 | 처리 |
|---|---|
| `REQUEST_IDENTITIES` | 앱의 키(로그인 키, 추가 키)와 시스템 agent의 키를 합친다. 같은 공개키는 하나로 두고 앱의 키를 우선한다 |
| `SIGN_REQUEST` | 기존과 같이 승인을 받는다. 앱의 키면 앱이 서명하고, 시스템 agent의 키면 지금처럼 그쪽으로 넘긴다. 목록에 없는 키는 묻지 않고 `FAILURE` |
| `session-bind@openssh.com` | 지금처럼 기록해 카드에 대상 호스트키를 보여주고 `SUCCESS` |
| 그 밖의 모든 메시지 | 지금처럼 `FAILURE`. 필터(`agent_filter.rs`)는 바꾸지 않는다 |

- **서명 알고리즘:** Ed25519, ECDSA는 키 라이브러리로 서명한다. RSA는 기존 `rsa_auth`의 ring 경로로 `rsa-sha2-256`, `rsa-sha2-512`만 서명하고, 플래그가 없는 SHA-1 요청은 `FAILURE`와 연결당 한 번 안내로 거부한다(로그인 인증과 같은 정책). 서명 결과는 단위 테스트에서 공개키로 검증한다.
- **키 메모리:** 로그인 키는 접속할 때 이미 해독한다. 키 전달이 켜져 있고 로그인 키를 내보내는 연결만 그 키를 연결 수명 동안 보관하고, 연결이 끝나면 지운다(`ZeroizeOnDrop`). 시스템 `ssh-agent`가 키를 메모리에 두는 것과 같은 수준이다. 추가 키는 서명할 때 해독하고 바로 지운다. "이 연결에서 10분 허용"을 고른 경우에만 그 10분 동안 보관한다.
- **키 읽기 공용화:** `ssh.rs`의 개인키 읽기·해독(크기 확인, `decode_secret_key`, `rsa_auth::decode_pem`)을 `ssh_keys.rs`로 옮겨 로그인과 내장 agent가 함께 쓴다. `ssh.rs`가 줄어든다.
- **안내:** "이 PC의 agent에 연결할 수 없음" 안내는 앱의 키가 하나도 없을 때만 보낸다. 문구는 "전달할 키가 없습니다. 세션 고급 옵션에서 키를 고르거나 이 PC의 SSH agent에 키를 등록하세요."로 바꾼다.
- **카드:** 기존 `AgentSignCard`에 키 출처(이 앱의 키, 이 PC의 agent)를 더한다. Passphrase가 필요한 추가 키는 **허용**을 누른 뒤 같은 카드에 Passphrase 칸과 "이 PC에 저장"을 보여준다. 카드는 여전히 포커스를 먼저 가져가지 않는다.
- **제외:** FIDO(`sk-*`) 키는 하드웨어가 필요해 시스템 agent를 거칠 때만 쓴다. 사용자 인증서(`*-cert.pub`)는 1차에서 뺀다.

**합격:** 시스템 agent가 없는 상태(이 PC 그대로)에서 서버의 `ssh-add -l`이 로그인 키와 추가 키를 보여준다. 로그인 키와 다른 "Git 전용 키"로 승인한 뒤 push되고, 거부하면 실패한다. RSA 키는 SHA-2로 서명되고 SHA-1 요청은 거부된다. 서버의 `ssh-add -D`가 키를 지우지 못한다. 시스템 agent를 켜면 두 출처의 키가 합쳐지고 중복이 없다.

**구현에서 정한 것(2026-11-08):**

- **파일 배치:** 키 읽기·해독은 `ssh_keys.rs`, 키 목록·합치기·서명·카드 응답(`agent_sign_reply`, Passphrase 읽기와 저장)은 `agent_keys.rs`다. 카드 응답 명령을 `agent_forward.rs`에서 옮긴 이유는 그 파일이 Rust 상한(600줄)을 넘기 때문이다. `agent_forward.rs`는 채널 수락, 출처 선택(앱의 키 / 시스템 agent), 승인 대기만 맡는다. 개인키 로그인 순서(RSA SHA-2 재시도 포함)도 `ssh_auth::key`로 옮겨 `ssh.rs`가 728줄에서 669줄이 됐다. `agent_filter.rs`는 바꾸지 않았고, 서명 요청의 데이터와 플래그는 `agent_keys::sign_request`가 따로 읽는다.
- **키 파일 고르기:** 파일 선택 대화상자 대신 로그인 키 경로와 같은 **경로 입력 + 추가**다. 새 명령은 `ssh_key_info` 하나로 끝나고, 네이티브 검사가 조작할 수 있다. Enter는 세션 폼을 제출하지 않고 키를 추가한다. 줄의 ⋯ 버튼과 우클릭 메뉴에 **빼기**가 있다.
- **공개 부분이 없는 키:** 암호화된 PEM·PKCS#8 키에 `.pub`가 없으면 "첫 서명 때 확인" 대신 줄에 "공개키를 읽을 수 없음 · 같은 이름의 .pub 파일을 옆에 두세요"를 보이고 목록에서 뺀다. 서버는 목록에 없는 키로 서명을 요청할 수 없어서, 첫 서명이 오지 않기 때문이다.
- **카드 응답:** `agent_sign_reply`가 `{ kind: 'done', notice } | { kind: 'passphrase', reason: 'needed' | 'wrong' | 'stored' }`를 돌려준다. 틀린 Passphrase는 요청을 열어 둔 채 다시 묻는다. Passphrase가 필요한 요청은 120초를 기다린다(일반 요청 60초). 카드는 허용을 누르기 전에는 포커스를 가져가지 않고, 누른 뒤에 Passphrase 칸으로 옮긴다. 키 출처 문구는 "이 앱의 키 파일", "이 PC의 SSH agent"다. 키 이름은 코멘트, 없으면 파일 이름이다.
- **저장한 Passphrase:** 응답 시점에 DB에서 그 세션·파일의 참조를 읽는다. 연결할 때의 프로필 사본을 쓰면 같은 연결에서 방금 저장한 값을 쓰지 못한다(네이티브 첫 실행에서 발견). 저장은 OS 저장소에 먼저 쓰고(락 없음) `mutation` 락 아래 `Store::set_forward_secret`으로 참조를 단다. 그 사이 정리 작업이 값을 지웠으면 참조를 달지 않고 다시 journal에 넣는다. 참조는 백엔드만 정한다. `Store::save`는 폼이 보낸 `secretRef`를 무시하고 같은 파일의 저장 참조를 유지하며, 빠진 키의 참조는 journal로 보낸다. 복제와 가져오기는 참조를 비운다. 세션 삭제도 참조를 journal로 보낸다. 마스터 암호를 켜거나 바꿀 때(`Vault::configure`) 함께 재암호화한다. `cleanup_credentials`는 키 전달 참조를 지우지 않고, OS 저장소 삭제를 DB 락 밖에서 한다.
- **10분 허용:** 허용 중에도 잠긴 추가 키는 카드에서 Passphrase를 묻는다. 그렇게 연 키만 남은 허용 시간 동안 보관하고, 연결이 소유한 태스크가 허용이 끝나거나 연결이 멈출 때 지운다. **이번만 허용**으로 연 키와 암호화되지 않은 추가 키는 서명 직후 버린다.
- **시스템 agent:** 연결이 안 되면 조용히 건너뛰고, 중간에 끊기면 버린 뒤 앱의 키로 계속한다(DX.2는 채널을 닫았다). `session-bind`는 시스템 agent가 있으면 그쪽에도 보내고 답은 앱이 `SUCCESS`로 한다. 서버가 전달을 거부하면 보관한 로그인 키를 바로 지운다.
- **SHA-1 안내 문구:** "RSA 키의 SHA-1 서명 요청을 거부했습니다. 서버의 SSH 클라이언트가 rsa-sha2-256/512를 쓰도록 업데이트하세요." 시스템 agent의 키는 그 agent가 판단하므로 앱이 막지 않는다.
- **테스트 키:** 단위 테스트는 `ssh-keygen`을 고정 시스템 경로(Windows `C:\Windows\System32\OpenSSH`, Unix `/usr/bin`)로 실행해 임시 폴더에 만든다. 저장소에 키를 두지 않는다.
- **네이티브 검사:** `run-phase1.mjs`의 대역 agent를 파일(`DACHSTERM_AGENT_PAUSE`)로 끄고 켤 수 있게 했다. DX.11 단계는 대역을 끈 상태, 즉 이 PC의 꺼진 `ssh-agent`와 같은 조건에서 실행한다.

### DX.12 — HTTPS Git 자격 증명 전달 (2026-11-08 추가)

**필요한 이유:** `https://` 저장소는 SSH 키가 아니라 토큰이나 암호를 쓴다. 회사 GitLab처럼 SSH 포트가 막혀 HTTPS만 쓰는 곳도 많다. 서버의 git이 자격 증명을 물을 때 그 질문을 이 PC로 가져와, 이 PC의 Git 자격 증명 관리자(GitHub, GitLab, Bitbucket, Azure DevOps 로그인 지원)나 앱에 저장한 토큰으로 답한다.

**서버에 설치하지 않는다.** 서버의 git에 원래 들어 있는 `credential-cache` 클라이언트를 통로로 쓴다. 이 클라이언트는 지정한 Unix 소켓에 요청을 보내고 받은 답을 git에 돌려준다. 앱은 그 소켓을 SSH 원격 소켓 전달로 만들고, 소켓 반대편에서 캐시 데몬 대신 답한다. 파일을 쓰지 않고, 터미널에 자격 증명을 입력하지도 않는다.

```text
서버 git ──get──▶ git credential-cache --socket <경로> ──Unix 소켓──▶ sshd ──SSH 채널──▶ 앱
                                                                                        │ 승인 카드
서버 git ◀── username/password ◀──────────────────────────────────────────────────────── ┘ 이 PC의 자격 증명
```

**연결:**

- 세션 고급 옵션 **HTTPS Git 자격 증명 전달**. 기본은 꺼짐이고 SSH 키 전달과 따로 켠다. 세션 파일로 켜지지 않는다. 경유 호스트에는 요청하지 않는다.
- 최종 서버에 접속한 뒤 `streamlocal_forward`(russh 0.65.1에 있음)로 소켓을 연다. 경로는 연결마다 128비트 난수 이름이다.
  - 위치: 그 연결의 `remote_exec`로 `$XDG_RUNTIME_DIR`을 읽는다. 값이 있고 사용자 소유 0700이며 경로가 `[A-Za-z0-9/._-]`로만 되어 있으면 그 아래에 둔다. 아니면 `/tmp` 아래에 둔다.
  - 소켓 권한은 sshd의 `StreamLocalBindMask`(기본 0177)로 사용자 전용이 된다(실측 `srw-------`, OpenSSH 7.4~10.6).
  - 서버가 거부하면(`AllowStreamLocalForwarding no`, `DisableForwarding`) 연결당 한 번 안내한다. 실측에서 두 경우 모두 전달 요청만 실패하고 셸은 계속 쓸 수 있었다.
- `Handler::server_channel_open_forwarded_streamlocal`은 이 연결이 연 경로만 받고 나머지는 거부한다. 핸들러에는 위임 호출만 넣는다(`ssh.rs` 순증 금지, DX.11의 키 읽기 이동으로 상쇄).
- 정상 종료할 때는 전달을 취소하고 그 연결의 `remote_exec`로 자기 소켓 파일 하나만 지운다(`[ -S <경로> ] && rm -f -- <경로>`).
  - 실측에서 sshd는 연결이 끝나거나 전달을 취소해도 소켓 파일을 지우지 않았다. 그래서 직접 지운다.
  - 비정상 종료로 남은 파일은 `XDG_RUNTIME_DIR`이면 마지막 로그아웃 때 폴더째 사라진다. `/tmp`이면 남는다. 남은 파일에 대한 `get`은 조용히 끝나고, 경로가 매번 달라 다음 연결과 겹치지 않는다.

**git에 알리는 방법:** 셸의 환경 변수로 helper 하나를 **덧붙인다.** 사용자의 기존 helper 설정은 지우지 않는다.

- helper 값: `!f() { [ "$1" = get ] && [ -S <경로> ] && [ -O <경로> ] || return 0; exec git credential-cache --socket <경로> get; }; f`
  - **소유자 확인(`-S`, `-O`)을 넣는다(DX.12.0에서 추가).** 이전 경로는 오래 남는다. 소켓 파일은 연결이 끝나도 남고, tmux 서버의 전역 환경과 열린 패널은 이전 값을 계속 가진다. `/tmp`의 오래된 파일이 정리된 뒤 다른 사용자가 같은 이름으로 소켓을 만들면, 그 패널의 `get`(호스트, 사용자 이름)을 받고 임의의 값으로 답할 수 있다. 내 소유의 소켓이 아니면 helper는 아무것도 하지 않는다. bash, dash, busybox ash에서 확인했다.
  - 경로는 따옴표 없이 넣는다. 이 값은 `GIT_CONFIG_PARAMETERS`의 작은따옴표 항목 안에 들어가므로 작은따옴표를 쓰면 인용이 깨진다. 그래서 경로를 `[A-Za-z0-9/._-]`로 제한한다(위치 규칙).
- **`get`만 전달한다.** `store`와 `erase`는 helper가 아무것도 하지 않는다. `store`에는 암호가 실려 있다. 실측에서 원래 `credential-cache store`는 받는 쪽 없는 0700 폴더 경로(`XDG_RUNTIME_DIR`과 같은 조건)에서 서버에 캐시 데몬을 띄우고 암호를 서버 메모리에 남겼다(git 1.8~2.56). `/tmp`에서는 폴더 권한 검사로 데몬이 뜨지 않았다. `get`은 어느 경우에도 데몬을 띄우지 않는다.
- **서버의 기존 helper가 값을 저장할 수 있다(DX.12.0에서 추가).** git은 인증에 성공하면 설정된 **모든** helper에 `store`를 보낸다. 우리 helper가 무시해도, 서버 사용자가 `credential.helper=store`를 써 두었으면 전달한 토큰이 서버의 `~/.git-credentials`에 평문으로 저장되고, `cache`이면 서버 메모리에 남는다. 처리는 다음과 같다.
  - 연결 후 한 번 `remote_exec`로 홈 폴더에서 `git config --get-all credential.helper`를 읽는다. 값이 있으면 카드에 "서버의 helper(`<이름>`)가 이 값을 저장할 수 있습니다"를 표시한다.
  - 저장소별 설정은 미리 알 수 없으므로 안내서에도 적는다.
  - 사용자 helper를 끄는 방식(`credential.helper=` 초기화)은 쓰지 않는다. 사용자의 서버 설정을 바꾸는 것과 같기 때문이다.
- 전달 방식은 `GIT_CONFIG_PARAMETERS`에 덧붙이는 것으로 **확정한다(DX.12.0).**
  - 근거: git 1.8.3.1, 2.17.1, 2.25.1, 2.39.5, 2.56.0에서 인용과 실제 push까지 동작했다. 이전 형식의 기존 값(`'core.pager=less -R' 'user.name=a b'`) 뒤에 공백 하나로 붙여도 둘 다 해석됐다.
  - 순서: 사용자의 전역 helper가 먼저 불리고 우리 helper는 그 뒤다. 앞의 helper가 값을 주면 우리 helper는 불리지 않는다.
  - `GIT_CONFIG_COUNT`는 쓰지 않는다. git 2.31부터만 동작하고, 두 방식을 함께 넣으면 helper가 두 번 불린다.
- **일반 셸:** 기존 셸 훅(`shellHook.ts`, 파일을 쓰지 않음)에 `export` 한 줄을 더한다. 이 옵션이 켜져 있으면 경로 따라가기와 조작표가 모두 꺼져 있어도 이 부분은 넣는다.
  - 형식: `export GIT_CONFIG_PARAMETERS="${GIT_CONFIG_PARAMETERS:+$GIT_CONFIG_PARAMETERS }'credential.helper=<helper 값>'"`. Bash 3.2.57, Bash 4.2, Zsh 5.9가 같은 값을 만든다(실측).
  - 같은 셸에 두 번 붙이지 않는다. 두 번 붙으면 거부했을 때 helper가 다시 불려 카드가 두 번 뜬다.
  - fish와 csh는 훅이 없어 안내서의 수동 한 줄로만 지원한다.
- **tmux 세션(DX.12.0 실측으로 수정):** tmux 탭에는 아무것도 입력하지 않는다(DX.3). 그래서 `terminal_start.rs`의 시작 명령에서 세션 환경에 값을 넣어 **새 패널**에 적용한다.
  - **`new-session -e`를 그대로 쓰지 않는다.** tmux 1.8, 2.6, 3.0a에서는 `unknown option -- e`로 시작 명령 전체가 실패한다(3.3a, 3.8은 동작, 3.1·3.2는 미측정).
  - 시작 명령의 형태는 다음과 같다. `-e`가 실패해도 세션은 만들어지지 않으므로 대체 생성과 겹치지 않는다(실측).
    ```sh
    tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -qx -- <이름> ||
      tmux new-session -d -s <이름> -e "GIT_CONFIG_PARAMETERS=…" 2>/dev/null ||
      tmux new-session -d -s <이름>
    tmux set-environment -t <이름> GIT_CONFIG_PARAMETERS "…"
    exec tmux attach-session -t <이름>
    ```
  - `set-environment`는 1.8부터 모든 버전에서 이후 새 창과 분할 패널에 적용된다.
  - 있는지 확인할 때 `has-session -t <이름>`을 쓰지 않는다. `work`가 없고 `work2`만 있어도 접두사 일치로 성공한다(1.8, 3.0a, 3.8 실측). `=<이름>` 정확 일치는 tmux 1.8이 지원하지 않는다. 그래서 `list-sessions -F`와 `grep -x`로 확인한다.
  - `set-environment`와 `attach-session`의 대상은 `<이름>`으로 쓴다. 정확히 같은 이름의 세션이 있으면 접두사 일치보다 먼저 선택된다(실측).
  - **한계:**
    - `-e`가 없는 tmux에서 서버가 이미 다른 세션으로 떠 있으면, 새로 만든 세션의 첫 패널에는 값이 없다. 이후 창과 패널부터 적용된다.
    - tmux 서버가 새로 뜰 때는 시작 명령의 환경이 서버 전역 환경이 되어 첫 패널을 포함한 모든 패널이 받는다. 이 값은 연결이 끝난 뒤에도 그 서버의 다른 세션에 남는다. 소유자 확인과 조용한 실패 때문에 위험하지 않다.
  - 재접속하면 이미 열린 패널은 이전 경로를 가리킨다. `SSH_AUTH_SOCK`과 같은 문제이므로, DX.10 후속으로 남은 기본 명령의 갱신 줄 하나에 두 값을 함께 넣는다.
  - 경로가 사라진 경우 `get`이 조용히 끝나고(실측: 파일 없음, 남은 파일, 받는 쪽 없음 모두 종료 0·출력 없음) git이 다음 helper나 터미널 질문으로 넘어간다.

**요청 처리(`git_credential.rs` 새 파일, 프로토콜 파서는 순수 함수로 분리):**

- **형식(DX.12.0 실측, git 1.8~2.56 동일):** 요청은 `action=get`, `timeout=900`, 자격 증명 줄 순서이고 빈 줄 없이 끝난다. 클라이언트가 쓰기 쪽을 닫아 채널 EOF가 온다. 앱은 EOF까지 읽는다. 답은 `username=…`, `password=…` 줄을 쓰고 채널을 닫는다(클라이언트는 EOF까지 읽어 git에 넘긴다). 빈 답이나 바로 닫기는 "값 없음"으로 처리돼 git이 다음 단계로 넘어간다.
- 요청 하나는 64KiB 이하다. `action=get` 줄과 git 자격 증명 형식(`key=value`)만 받는다. `timeout`, `capability[]`(git 2.46 이후), `wwwauth[]`(git-lfs 3.x) 같은 모르는 키는 무시한다. 답에 `capability[]`는 넣지 않는다(git 2.56에서 push 성공). NUL이나 제어문자가 있으면 버린다. 연결당 동시 채널은 4개이고, 같은 호스트의 카드는 한 번에 하나만 띄운다.
- **반복 요청 차단(DX.12.0에서 추가):** 같은 연결·같은 호스트의 `get`이 10초 안에 5번을 넘으면 그 뒤 60초 동안 카드 없이 빈 답을 보내고 연결당 한 번 안내한다. 실측에서 서버가 계속 401을 주자 git-lfs 2.9.2는 `get`과 `erase`를 초당 약 40번 반복했다. 이를 막지 않으면 카드가 연달아 뜨거나, "10분 허용" 중에는 토큰이 반복 전송된다.
- `protocol=https`만 받는다. `http`는 토큰이 평문으로 나가므로 거부하고 연결당 한 번 안내한다.
- **승인 카드(`GitCredentialCard`, 서명 카드와 같은 자리):** 세션 이름, 호스트, 경로(git이 보낸 경우), 사용자 이름(있으면)을 보여주고 "이 PC의 자격 증명이 **서버로 전달됩니다**"라고 표시한다. 서명과 달리 값 자체가 서버로 가기 때문이다. 서버에 기존 helper가 있으면 위의 저장 경고를 함께 표시한다.
  - 선택지는 **거부**, **이번만 허용**, **이 연결에서 10분 허용**(같은 호스트), **직접 입력**이다. 60초 안에 답이 없으면 거부한다. 거부하면 빈 답을 보내 git이 원래대로 터미널에서 묻게 한다. 탭에는 `입력 대기`를 표시하고 포커스 밖이면 알림을 보낸다(DX.2와 같음).
  - **"이번만 허용"은 승인 뒤 30초 동안 같은 연결·같은 호스트·같은 사용자 이름의 요청에 다시 쓴다(DX.12.0에서 추가).** 실측에서 LFS push 한 번에 `get`이 3번(git 1, LFS 2), clone에 2번 왔다. 이 처리가 없으면 push 한 번에 카드가 세 번 뜬다.
  - 경로는 서버의 `credential.useHttpPath`가 켜진 경우에만 온다. 기본 설정에서는 호스트만 보인다(실측).
- **승인한 뒤에 값을 가져온다.** 먼저 가져오면 자격 증명 관리자의 로그인 창이 승인 전에 뜰 수 있기 때문이다. 가져오는 순서는 다음과 같다.
  1. 앱에 저장한 이 호스트의 토큰
  2. 이 PC의 `git credential fill`
     - 대상: 자격 증명 관리자, macOS 키체인, wincred 등 사용자가 설정한 helper
     - 실행: `spawn_blocking`, 콘솔 창 없음, `GIT_TERMINAL_PROMPT=0`, 120초 제한
     - 저장된 값이 없으면 관리자가 브라우저 로그인을 띄울 수 있다. 성공하면 같은 값으로 `git credential approve`를 불러 다음부터 묻지 않게 한다.
     - 실측(Windows, GCM 2.6.1):
       - 창 없는 프로세스에서도 GCM이 로그인 창을 띄우고, 입력값을 돌려준다(종료 0).
       - 취소하면 128로 바로 끝난다. 저장값이 없을 때 `GIT_TERMINAL_PROMPT=0`에서 멈추지 않는다.
       - 이름이 확인되지 않는 호스트는 GCM이 창을 띄우기 전에 실패한다(약 0.6초).
       - 앱이 `GCM_INTERACTIVE=never`를 물려받으면 창이 뜨지 않는다. 이 값은 사용자의 선택이므로 앱이 바꾸지 않는다.
       - macOS 키체인은 대기(Mac).
  3. 둘 다 없으면 카드가 입력 칸으로 바뀐다(사용자 이름, 토큰, "이 PC에 저장")
- **이 PC의 git 찾기(규칙 §11):** 이름만으로 실행하지 않는다.
  - Windows: `PATH`의 `git.exe`, 없으면 `%ProgramFiles%\Git\cmd\git.exe`
  - macOS: `login_path.rs`의 사용자 `PATH`, 그다음 `/opt/homebrew/bin`, `/usr/local/bin`
  - macOS의 `/usr/bin/git`은 Command Line Tools가 없으면 설치 창을 띄우므로 `xcode-select -p`가 성공할 때만 쓴다.
  - git이 없으면 1과 3만 쓴다.
- **저장:** 앱에 저장하는 토큰은 OS 저장소나 금고에 두고 DB에는 `프로토콜+호스트+사용자` 참조만 둔다. 설정 창 **에이전트** 분류에 목록(호스트, 사용자, 삭제)을 둔다. 서버가 보낸 값을 저장하는 경로는 없다.
- 응답을 보낸 뒤 값은 즉시 지운다(`Zeroizing`). 요청과 응답 내용은 로그, 진단 내보내기, 세션 기록에 남기지 않는다.

**합격 (Docker 검사):**

- HTTPS Git 서버(Basic 인증, `tests/git-https`)에 여러 git 버전의 서버에서 push한다. 대상: 1.8, 2.17, 2.25, 2.39, 최신. git-lfs가 있는 서버는 LFS 객체도 push한다.
- 이 PC 쪽 출처 세 가지(앱 저장, `git credential fill`, 직접 입력)가 모두 동작하고, 거부하면 git이 터미널에서 묻는다.
- `store`와 `erase`는 서버에 데몬을 남기지 않는다.
- 다음 경우에는 거부한다: `http`, 남의 소켓 경로, 64KiB를 넘는 요청, 채널 5개째, 10초 안 6번째 `get`.
- 다른 사용자 소유의 소켓이 helper 경로에 있으면 helper가 요청을 보내지 않는다.
- LFS push 한 번에 카드가 한 번만 뜬다("이번만 허용").
- tmux 1.8과 최신 tmux의 새 패널에 적용되고, 시작 명령이 실패하지 않는다.

**합격 (수동):** 실제 GitHub, GitLab.com, Bitbucket을 이 PC의 자격 증명 관리자로 확인하고, 자체 설치형 GitLab이 있으면 함께 확인한다.

**구현에서 정한 것(2026-11-08, [검증 기록](../verification/git-credential.md#dx12-구현-검증)):**

- **파일 배치:** `git_credential.rs`는 소켓 열기·닫기, 채널 수락, 요청 읽기만 맡는다. 승인 대기·허용 재사용·반복 차단은 `git_credential/approval.rs`, 카드 응답과 설정 창 명령은 `commands.rs`, 프로토콜 파서와 helper 문구(순수 함수)는 `protocol.rs`, 이 PC 쪽 출처(앱 저장 토큰, `git credential fill`·`approve`, git 찾기)는 `local.rs`다. 저장 목록은 `storage/git_credentials.rs`(설정 행 `git-credentials`, 참조와 정리 journal)에 두었다. Rust 상한(600줄)을 지키려고 나눴다.
- **`ssh.rs` 순증 없음:** `Event`를 `ssh/event.rs`로 옮겨 상쇄했다(669→649줄). `ssh.rs`에 더한 것은 핸들러의 위임 호출, 연결 후 `git_credential::start`, 종료 직전 `finish` 한 줄, 작업 종료 분기의 `stopping`이다.
- **정상 종료 때 소켓 삭제:** 탭을 닫으면 연결 작업이 `stop` 신호로 바로 취소되어 끝부분 코드가 돌지 않는다. 그래서 `stop` 분기를 `git_credential::stopping`으로 바꿔, 연결이 아직 살아 있는 동안 전달 취소와 자기 소켓 삭제(각 3초 제한)를 한 뒤 연결을 끊는다. 셸에서 `exit`로 끝난 경우는 `run` 끝의 `finish`가 같은 일을 한다.
- **프런트엔드가 helper 줄을 얻는 방법:** §5에 없던 명령 `git_credential_shell`(연결 ID → 셸에 넣을 한 줄 또는 없음)을 더했다. helper 문구와 인용을 Rust 한 곳(`protocol::shell_export`, `tmux_export`)에서 만들어 셸 훅과 tmux 시작 명령이 같은 값을 쓰게 하려는 것이다. 명령은 그 창이 터미널을 소유할 때만 답한다.
- **셸에 넣는 줄:** `case "$GIT_CONFIG_PARAMETERS" in *<경로>*) ;; *) export GIT_CONFIG_PARAMETERS="${GIT_CONFIG_PARAMETERS:+$GIT_CONFIG_PARAMETERS }"''\''credential.helper=…'\''';; esac`. 같은 셸에 두 번 넣어도 한 번만 붙는다. `!`를 작은따옴표 안에 두어 대화형 Bash·Zsh의 히스토리 확장을 피한다(설계안 형식은 큰따옴표 안에 `!`가 있어 대화형 셸에서 깨진다). 훅의 `eval` 작은따옴표 밖, 훅 앞에 둔다. 이 옵션이 켜져 있으면 경로 따라가기와 조작표가 꺼져 있어도 훅 전체를 넣는다. 폴더 보고가 함께 들어가지만 파일 패널은 여전히 경로 따라가기 설정을 따른다(조작표만 켠 경우와 같다).
- **tmux:** 설계대로 `list-sessions | grep -qxF`, `new-session -e` 실패 시 `-e` 없이 생성, `set-environment`, `attach-session`이다. 시작 명령 앞에서 값을 `export`해 새로 뜨는 tmux 서버의 첫 패널도 받는다. 기존 일회성 시작(DX.7, `has-session -t =이름`)에도 같은 값을 넣었다. DX.7의 tmux 1.8 문제는 이번 범위에서 고치지 않았다.
- **반복 요청 차단은 10초 안 10번 초과로 바꿨다(설계 5번).** LFS 저장소에서는 push 한 번에 `get`이 3번이라, 연달아 두 번 push하면 6번이 되어 정상 사용이 1분 동안 막혔다(Docker 검사에서 발견). 폭주한 git-lfs는 초당 약 40번이라 10번으로도 1초 안에 막힌다.
- **카드:** 서명 카드와 같은 자리, 같은 대기열이다. `AgentSignQueue`가 서명 요청과 자격 증명 요청(`PendingApproval`)을 함께 들고, 탭의 `입력 대기`와 알림 문구만 종류별로 다르다. 허용을 누르면 값을 찾는 동안 카드에 "가져오는 중"을 보이고, 이 PC의 로그인 창이 열려도 요청이 끝나지 않도록 백엔드가 대기 시간을 130초로 늘린다. 값이 없거나 **직접 입력**을 고르면 백엔드가 120초를 새로 주고 카드가 입력 칸(사용자 이름, 토큰 또는 암호, 이 PC에 저장)으로 바뀐다. 입력값 검사(한 줄, 사용자 이름 256바이트, 토큰 16KiB)는 카드와 백엔드가 같다. 좁은 칸에서는 "서버로 전달됩니다" 한 줄과 버튼은 남고 나머지 설명·상세만 스크롤된다.
- **승인 이벤트의 소유자:** DX.13의 일반화가 아직 머지되지 않아 DX.2처럼 연결 ID에 묶었다. `git_credential_reply(id, request, …)`의 `id`를 DX.13이 정한 "요청을 받을 탭" 식별자로 바꾸면 되도록 응답 로직을 `commands::answer(connections, …)`로 분리했다. DX.13 머지 때 맞춘다.
- **이 PC의 git:** Windows는 `PATH`의 `git.exe`, 없으면 `%ProgramFiles%\Git\cmd\git.exe`. macOS는 `PATH`(로그인 셸 값이 이미 들어 있다)에서 `/usr/bin`을 뺀 뒤, Homebrew 두 경로, 그다음 `/usr/bin/xcode-select -p`가 성공할 때만 `/usr/bin/git`. 실행은 콘솔 창 없음, `GIT_TERMINAL_PROMPT=0`, 120초 제한(넘으면 종료)이고 `approve`는 30초다.
- **저장:** "이 PC에 저장"은 카드에서 직접 입력한 값만 저장한다. OS 저장소에 먼저 쓰고(락 없음) `mutation` 아래 참조를 단다. 같은 호스트·사용자의 이전 값과 삭제한 값은 journal로 정리한다. 마스터 암호를 켜거나 바꿀 때 함께 재암호화하고, `cleanup_credentials`는 이 참조를 지우지 않는다. 손상된 목록은 빈 목록으로 삼키지 않고 오류로 올린다. 저장 목록은 설정 창 › 에이전트에 호스트·사용자와 **삭제** 버튼으로 보인다.
- **세션 파일:** `forwardGitCredentials`는 내보내기에서 빼고, 가져오기에서는 새 세션이면 꺼짐, 병합이면 저장된 값을 유지한다(DX.11 필드와 같은 규칙).

#### DX.12.0 — 실측 (게이트)

**완료(2026-11-08).** 구현 전에 확인했고, 상세는 [git-credential](../verification/git-credential.md)에 기록했다. Docker 서버 5종(git 1.8.3.1·2.17.1·2.25.1·2.39.5·2.56.0, OpenSSH 7.4~10.6, tmux 1.8~3.8)과 systemd 서버, OpenSSH 클라이언트의 `ssh -R`, 임시 응답 프로그램, HTTPS Git 서버(`tests/git-https`)를 썼다. 위 DX.12 본문에는 결과를 반영했다.

| 질문 | 결과 | 처리 |
|---|---|---|
| `credential-cache --socket`의 요청 형식과 응답 처리가 git 1.8~최신에서 같은가 | 같다. `action=get`, `timeout=900`, 자격 증명 줄, 빈 줄 없음, 쓰기 쪽 종료. 최신은 `capability[]`, LFS 3.x는 `wwwauth[]`를 더한다 | 파서 하나. 버전 분기 없음 |
| 연결 없는 소켓에서 `get`이 조용히 끝나고 다음으로 넘어가는가 | 그렇다. 파일 없음, 남은 파일, 받는 쪽 없음, 빈 답, 즉시 종료 모두 종료 0·출력 없음 | 별도 처리 없음 |
| `GIT_CONFIG_PARAMETERS`에 덧붙인 helper의 인용과 순서 | 1.8~2.56 모두 동작, 사용자 helper 뒤. **사용자 helper도 `store`로 값을 받는다** | 방식 확정. 서버 helper 경고 추가 |
| sshd 기본값, 소켓 권한, 남는 소켓, `StreamLocalBindUnlink` | 전달 허용·0177·`no`. 연결 종료와 취소 뒤에도 파일이 남는다 | 직접 삭제 유지. helper에 소유자 확인 추가 |
| exec 환경의 `$XDG_RUNTIME_DIR` | pam_systemd가 있으면 `/run/user/<uid>` 0700, 마지막 세션 종료 후 폴더째 삭제. 없으면 값 없음 | 설계대로 |
| tmux `new-session -e`와 `set-environment` | `-e`는 1.8·2.6·3.0a에서 명령 전체 실패, 3.3a·3.8 동작. `set-environment`는 1.8부터 동작. 1.8은 `=이름` 미지원, `has-session`은 접두사 일치 | 시작 명령 형태 수정 |
| 이 PC의 `git credential fill` | Windows: 격리 `store`와 GCM 2.6.1 모두 창 없는 프로세스에서 동작. GCM은 로그인 창을 띄우고 값을 돌려준다. 멈추지 않는다. macOS 키체인은 대기(Mac) | 설계대로 |
| Git LFS가 같은 helper를 쓰는가 | 쓴다(2.3.4~3.8.1). push 한 번에 `get` 3번. 계속 401이면 오래된 LFS가 반복 요청 | "이번만 허용" 30초, 반복 요청 차단 추가 |

### DX.13 — 로컬·WSL 탭의 SSH 키 제공 (2026-11-08 추가)

**필요한 이유:** 로컬 탭의 git과 `ssh`는 이 PC에서 돌기 때문에 원래 이 PC의 키를 쓴다. 그러나 Windows는 `ssh-agent` 서비스가 기본으로 꺼져 있어, 암호화된 키는 push할 때마다 Passphrase를 묻고 CLI 에이전트는 멈춘다. WSL 안의 git은 Windows의 키와 agent를 아예 보지 못한다. DX.11의 내장 agent를 로컬과 WSL 탭에도 제공해, 어느 탭에서 push해도 같은 키와 같은 승인을 쓰게 한다.

**설정(설정 창 › 에이전트, 앱 설정 `Store::setting`):**

| 키 | 기본값 | 설명 |
|---|---|---|
| `localAgent` | 꺼짐 | 로컬·WSL 탭에 앱 agent 제공. 바꾸면 새로 여는 탭부터 적용한다 |
| `localAgentKeys` | 빈 목록 | 제공할 키 파일. 최대 8개. Passphrase는 DX.11과 같이 참조만 저장한다 |

세션 프로필이 없는 탭이라 세션별이 아니라 앱 전체 설정이다.

**통로(탭마다 하나, 탭이 소유하고 탭을 닫으면 닫는다):**

| 탭 | 통로 | 셸에 넣는 값 |
|---|---|---|
| Windows 로컬 (PowerShell, 명령 프롬프트) | named pipe `\\.\pipe\dachsterm-agent-<난수>`. 현재 사용자만 접근하고 원격 클라이언트는 거부한다(`PIPE_REJECT_REMOTE_CLIENTS`) | `SSH_AUTH_SOCK`=그 pipe. Git for Windows의 기본 ssh는 pipe를 읽지 못하므로 `GIT_SSH`=`%SystemRoot%\System32\OpenSSH\ssh.exe`(존재할 때만) |
| WSL | 위와 같은 Windows pipe | wsl.exe의 Windows 환경에 `SSH_AUTH_SOCK`=그 pipe를 넣고 **`WSLENV`에는 넣지 않는다**. interop으로 실행된 Windows 프로그램은 그 wsl.exe의 환경을 상속하고, Linux 쪽 `SSH_AUTH_SOCK`은 그대로 둔다. `GIT_SSH`=`%SystemRoot%\System32\OpenSSH\ssh.exe`는 `WSLENV`에 `GIT_SSH/up`로 넣어 WSL 경로로 바꾼다. WSL의 git이 Windows `ssh.exe`를 실행하고, 그 `ssh.exe`가 pipe로 앱에 닿는다 |
| macOS 로컬 | 앱 전용 0700 폴더 안의 Unix 소켓. 경로는 104바이트 이하 | `SSH_AUTH_SOCK`=그 소켓 |

- **`GIT_SSH`를 고른 이유:** git의 우선순위는 `GIT_SSH_COMMAND` > `core.sshCommand` > `GIT_SSH`다. 가장 낮은 `GIT_SSH`를 써서 사용자가 직접 정한 ssh 설정을 덮지 않는다.
- **WSL의 한계:** git만 Windows `ssh.exe`를 거친다. WSL 안에서 직접 치는 `ssh`는 Linux `ssh`라 이 agent에 닿지 않는다. WSL2는 Windows pipe와 Unix 소켓을 바로 잇지 못하고, 중계에는 `socat` 같은 서버 쪽 도구가 필요하기 때문이다(§10 후속). 대신 사용자가 WSL 안에서 쓰던 Linux agent 설정도 건드리지 않는다. Windows `ssh.exe`는 Windows 쪽 `known_hosts`와 `~/.ssh/config`를 쓴다. 안내서에 적는다.
- **키 목록과 승인:** DX.11의 `agent_keys.rs`를 그대로 쓴다.
  - 앱의 키(`localAgentKeys`)와 이 PC의 시스템 agent 키를 합친다.
  - **앱의 키 서명은 그 탭에 카드를 띄워 승인받는다.** 로컬 셸 안에서 CLI 에이전트가 push할 수도 있기 때문이다.
  - **시스템 agent 키는 카드 없이 그대로 넘긴다.** 이 기능을 켜기 전에도 로컬 프로그램은 그 agent에 바로 닿을 수 있었으므로, 승인을 더해도 막는 것이 없고 로컬 `ssh` 로그인마다 카드가 떠 불편하기만 하다. 시스템 agent 자체의 확인(`ssh-add -c`)은 그대로 동작한다.
  - 필터(키 추가·삭제·잠금 거부)는 원격과 같다.
- **승인 이벤트의 소유자:** DX.2의 요청은 연결 ID에 묶여 있다. 로컬 탭은 로컬 세션 ID를 쓰므로 "요청을 받을 탭" 식별자로 일반화한다. `Broker` 상태에 저장하지 않는 규칙은 같다.
- **코드 위치:** `local_agent.rs` 새 파일이 pipe와 소켓 수신, 탭 수명을 맡는다. `local.rs`(490줄)에는 환경 변수를 넣는 호출만 더한다.

**DX.13.0 실측 반영(2026-11-08, [기록](../verification/local-agent.md)):**

- **WSL에서 `SSH_AUTH_SOCK`을 `WSLENV`로 넘기지 않는다.** 처음 설계는 `WSLENV`로 넘기는 것이었다.
  - 넘기면 Linux 쪽에도 `\\.\pipe\...` 값이 생긴다. Linux `ssh-add`가 `No such file or directory`로 실패하고, 사용자가 WSL 안에서 쓰던 agent 설정을 가릴 수 있다.
  - 넘기지 않아도 interop으로 실행된 Windows 프로그램은 자기를 띄운 wsl.exe의 Windows 환경을 받는다. 동시에 연 두 세션이 서로 다른 값을 받았다.
  - 이 상속은 Microsoft 문서에 적혀 있지 않다. 그래서 아래 합격 항목으로 매번 확인한다. 어느 WSL 버전에서 깨지면 플래그 없는 `WSLENV`로 바꾸고, Linux 쪽 부작용을 안내서에 적는다.
- **WSL SSH는 후속으로 미루지 않는다.**
  - WSL git 2.43.0이 interop으로 Windows `ssh.exe`를 실행했고, 사용자 정의 pipe의 agent로 서명해 push했다.
  - `GIT_SSH/up`는 `/mnt/c/WINDOWS/System32/OpenSSH/ssh.exe`로 바뀌고, git은 이를 ssh 변형(`-p`, `SendEnv`)으로 실행한다.
- **처음 보는 호스트의 질문.** Windows `ssh.exe`의 호스트키 질문은 Windows 콘솔로 나온다.
  - 앱 탭과 같은 ConPTY 안의 wsl.exe에서는 질문이 탭에 보이고 `yes`를 입력할 수 있었다.
  - 콘솔 없이 띄운 wsl.exe에서는 보이지 않고 멈춘다. 앱 탭은 항상 ConPTY이므로 해당하지 않는다.
- **`GIT_SSH/up` 변환 실패.** 자동 마운트를 끈 배포판처럼 `C:`가 마운트되지 않았으면 이렇게 된다.
  - wsl.exe가 탭을 열 때 `wsl: Failed to translate '<경로>'` 한 줄을 출력한다.
  - `GIT_SSH` 없이 시작하므로 git은 원래대로 Linux `ssh`를 쓴다. 안내서에 적는다.
- **확인한 버전과 우선순위.** Windows 11 기본 OpenSSH 9.5p2(`ssh.exe`·`ssh-add.exe` 9.5.6.4)는 `SSH_AUTH_SOCK`의 사용자 정의 pipe를 쓴다.
  - Git for Windows(2.51.2)에 동봉된 ssh는 pipe를 열기만 하고 실패한다(`Bad file descriptor`). 그래서 `GIT_SSH`가 필요하다.
  - 우선순위 `GIT_SSH_COMMAND` > `core.sshCommand` > `GIT_SSH`는 실측과 같다.
- **agent가 받는 메시지.** Windows `ssh.exe`는 서명 전에 type 27 확장(session-bind)을 보낸다. `ssh-add -D`는 type 19와 type 9를 보낸다. DX.11의 처리와 필터로 충분하다.

**합격:**

- `ssh-agent` 서비스가 꺼진 이 PC에서 PowerShell 탭의 `ssh-add -l`이 앱의 키를 보여준다.
- 같은 탭에서 Git for Windows로 SSH push가 승인 후 성공하고, 거부하면 실패한다.
- WSL 탭의 git push가 같은 방식으로 동작한다.
- WSL 탭의 Linux 쪽 `SSH_AUTH_SOCK`은 바뀌지 않는다. interop으로 실행한 `ssh-add.exe -l`은 그 탭의 키를 보여준다. 동시에 연 두 WSL 탭은 서로의 pipe를 쓰지 않는다.
- 처음 보는 호스트로 push하면 호스트키 질문이 PowerShell 탭과 WSL 탭에 보이고 답할 수 있다.
- 탭을 닫으면 pipe와 소켓이 사라진다. 다른 사용자 계정에서는 pipe에 닿지 못한다.
- Mac 로컬 탭은 실기기에서 확인한다.

**구현에서 정한 것(2026-11-08):**

- **승인 소유자 일반화(커밋 `8c3f946`, DX.12가 이어서 쓴다).** `approval.rs`의 `Owner::find(state, 창, ID)`가 ID를 원격 연결이나 로컬 탭으로 찾는다. 원격은 지금처럼 `Broker::check`로 창을 확인하고, 로컬 탭은 창을 옮길 수 없으므로 `main` 창만 답할 수 있다. 카드와 안내를 보내는 곳은 `Notify` trait이다(원격 `Broker`, 로컬 탭은 그 탭의 이벤트 채널 `Direct`). `agent_sign_reply`는 이름과 인자를 바꾸지 않고 두 경우를 받는다. `SignRequest.local`이 카드 문구를 바꾼다: 제목 "이 탭의 프로그램이 앱의 키로 서명하려고 합니다", 항목 "탭", 버튼 "이 탭에서 10분 허용". 프런트엔드의 `PendingSign.connectionId`는 `owner`로 바꿨다.
- **중계 공용화.** `agent_forward.rs`가 상한(600줄)에 가까워 요청 하나에 답하는 `Relay`를 `agent_relay.rs`로 옮겼다. 원격은 채널 루프, 로컬은 스트림 루프만 따로 둔다. `Unlock`의 세션 ID는 `KeyOwner::{Session, Local}`로 바꿔 저장된 Passphrase를 세션과 앱 설정 중 어디서 읽고 쓸지 정한다. 로컬 탭은 **시스템 agent 키 서명을 카드 없이** 그 agent에 넘긴다. 앱의 키 RSA SHA-1 거부 안내는 "이 PC의 SSH 클라이언트가 …"로 바꿨다.
- **Windows pipe.** 이름은 `\\.\pipe\dachsterm-agent-<UUID 32자리>`. 기본 pipe 보안은 Everyone 읽기를 허용하므로 모든 인스턴스에 DACL `D:P(A;;GA;;;<현재 사용자 SID>)`를 준다. 첫 인스턴스는 `first_pipe_instance`로 만들어 다른 프로그램이 먼저 만든 이름이면 실패한다. `reject_remote_clients`를 켠다. 연결이 오면 다음 인스턴스를 먼저 만들고 넘겨서 탭이 열려 있는 동안 이름이 유지된다. 탭당 동시 클라이언트는 원격 채널과 같은 8개다. SID와 DACL을 만들려고 `windows-sys 0.61.2`(이미 의존성 그래프에 있음)를 Windows 전용 직접 의존성으로 더했다. 새 크레이트는 없다.
- **macOS 소켓.** `$TMPDIR` 아래 `dachsterm-agent-*` 0700 폴더의 `agent.sock`. 경로가 104바이트를 넘으면 `/tmp` 아래에 같은 폴더를 만든다. 탭을 닫으면 소켓을 지우고, 폴더는 탭 객체가 사라질 때 지운다.
- **수명.** `local::Control`이 `local_agent::Tab`을 소유하고 `Control::stop`(탭 닫기, 셸 종료, 앱 종료)에서 닫는다. 셸 시작이 실패해도 drop으로 닫힌다. 통로를 연 뒤 셸을 시작하므로, 설정이 손상됐거나 통로를 만들지 못하면 탭이 열리지 않고 이유와 함께 "설정에서 끄면 열 수 있다"고 안내한다.
- **환경 변수.** `GIT_SSH`는 `%SystemRoot%\System32\OpenSSH\ssh.exe`가 있고 **앱 환경에 사용자의 `GIT_SSH`가 없을 때만** 넣는다. WSL은 `WSLENV`에 `GIT_SSH/up`을 기존 값(`PROMPT_COMMAND/u` 포함) 뒤에 더하고, 사용자의 `WSLENV`가 이미 `GIT_SSH`를 넘기면 `GIT_SSH`와 `WSLENV` 모두 건드리지 않는다. `SSH_AUTH_SOCK`은 `WSLENV`에 넣지 않는다(DX.13.0).
- **시스템 agent.** 로컬 탭의 클라이언트 연결마다 새로 연결한다. 설정 창에 "이 PC의 SSH agent 키도 사용" 선택지는 두지 않았다. 로컬 프로그램은 원래 그 agent에 닿을 수 있었으므로 끌 이유가 없다.
- **설정.** 앱 설정 키는 `localAgent`(bool)와 `localAgentKeys`(`ForwardKey` 목록) 두 개다. 손상된 값은 빈 값으로 삼키지 않고 오류다. **`local_agent_save`는 Passphrase를 받지 않는다**(§5 표와 다름). DX.11처럼 카드의 **이 PC에 저장**만 참조를 단다(`Store::set_local_agent_secret`). 빠진 키의 참조는 정리 journal로 보내고, `cleanup_credentials`는 로컬 키의 참조를 지우지 않으며, `Vault::configure`가 함께 재암호화한다. 세션 JSON과 설정 백업에는 들어가지 않는다(설정 표 밖).
- **설정 창.** 에이전트 분류에 시작 프리셋 아래 **로컬 탭의 SSH 키** 절(켜기 체크박스, 키 목록)을 두었다. 바꿀 때마다 순서대로 저장한다. 키 목록 편집은 DX.11 세션 폼의 것을 `components/KeyFileList.tsx`로 내려 함께 쓴다.
- **네이티브 합격 검사에서 정한 것.** 사용자 `~/.ssh/known_hosts`를 바꾸지 않으려고 `GIT_SSH`만 쓰는 push는 처음 보는 호스트 질문이 탭에 보이고 답할 수 있는지까지 확인하고 `no`로 답했다. 끝까지 가는 승인·거부 push는 같은 Windows `ssh.exe`를 `core.sshCommand`로 빈 설정·scratch `known_hosts`와 함께 실행했다. 그래서 **`GIT_SSH`만으로 끝까지 가는 push는 여전히 대기**다.

### DX.14 — WSL 탭의 HTTPS Git 자격 증명 (2026-11-08 추가)

**필요한 이유:** Windows·Mac 로컬 탭의 HTTPS는 이 PC의 Git 자격 증명 관리자가 이미 처리하므로 앱이 끼어들지 않는다. **WSL 안의 git만** Windows 자격 증명 관리자를 보지 못한다. DX.12의 요청 처리를 WSL 탭에 연결한다.

- **설정:** `wslGitCredentials`(설정 창 › 에이전트, 기본 꺼짐). 새로 여는 WSL 탭부터 적용한다.
- **helper:** 앱 실행 파일 자체를 helper로 쓴다. `dachsterm.exe git-credential get`으로 실행되면 앱 화면을 띄우지 않는다. `main.rs`에서 Tauri 초기화와 인스턴스 잠금보다 먼저 분기한다. 이 helper는 표준 입력의 요청을 탭의 pipe(`DACHSTERM_CREDENTIAL_PIPE`)로 보내고 답을 표준 출력으로 돌려준다. 이 값은 wsl.exe의 Windows 환경에 넣고 `WSLENV`에는 넣지 않는다. helper는 interop으로 실행된 Windows 프로그램이라 그 값을 상속한다(DX.13의 `SSH_AUTH_SOCK`과 같음). WSL에는 아무것도 설치하지 않는다.
- **git에 알리는 방법:** WSL 실행 환경(`wsl_follow_env`)에 helper 설정을 더한다. 방식(`GIT_CONFIG_PARAMETERS`에 덧붙이기)과 `get`만 전달하는 규칙은 DX.12와 같다.
  - helper 경로는 탭을 열 때 미리 바꾸지 않는다. helper 값 안에서 **실행할 때 `wslpath -u '<앱 실행 파일의 Windows 경로>'`로 구한다.**
    - 예: `!f() { [ "$1" = get ] || return 0; p=$(wslpath -u '<경로>') || return 0; exec "$p" git-credential get; }; f`
    - 경로 안의 작은따옴표는 이스케이프한다. `GIT_CONFIG_PARAMETERS` 안의 인용은 DX.12.0 결과를 따른다.
  - 자동 마운트 위치를 `/mnt`로 가정하지 않는다. 변환에 실패하면 `get`이 조용히 끝나고 git이 원래대로 묻는다.

**DX.13.0 실측 반영(2026-11-08, [기록](../verification/local-agent.md)):**

- **콘솔용 실행 파일을 따로 배포하지 않는다.** `windows_subsystem = "windows"`(PE 하위 시스템 2) 실행 파일을 WSL interop으로 실행한 결과다.
  - 표준 입력·출력·오류, 종료 코드, 1MiB 왕복, git `credential fill`의 값 소비가 모두 이어졌다.
  - ConPTY 탭 안에서도 같다.
  - 시작 시간은 20회 중앙값 18ms로, 콘솔(30ms)과 `cmd.exe /c exit`(35ms)보다 빨랐다.
  - 측정한 것은 150KB짜리 임시 실행 파일이다. 앱 실행 파일로 다시 재는 일은 구현 때 한다.
  - debug 빌드는 `cfg_attr` 때문에 콘솔 하위 시스템이지만 똑같이 동작한다.
- **helper 경로를 `WSLENV`의 `/p`로 넘기지 않는다.** 처음 설계는 "WSL 경로로 바꾼 값"을 미리 넣는 것이었다.
  - `/p`는 마운트되지 않은 경로(`Z:\...`, UNC)에서 탭을 열 때마다 `wsl: Failed to translate '<경로>'`를 화면에 출력하고 변수를 뺀다.
  - 실행 시점의 `wslpath`는 helper를 쓸 때만 실패하고, 실패해도 화면에 아무것도 남기지 않는다.
  - `wsl.conf`의 `root`를 바꾼 배포판에서 `wslpath`와 `/p`의 결과는 이 PC 설정을 바꾸지 않아 확인하지 않았다. 두 변환 모두 WSL 자신의 마운트 정보를 쓰므로 `root`를 따를 것으로 보지만, 사실로 취급하지 않는다.
- **처리:** 요청 파서, 승인 카드, 이 PC 쪽 출처(앱 저장 토큰, `git credential fill`, 직접 입력)는 DX.12의 `git_credential.rs`를 그대로 쓴다. 카드는 그 WSL 탭에 뜬다.
- **합격:** WSL 탭에서 HTTPS 저장소 push가 Windows 자격 증명 관리자의 값으로 승인 후 성공한다. 관리자가 없으면 직접 입력으로 성공한다. 설정을 끄면 WSL의 git이 원래대로 동작한다.

**구현에서 정한 것(2026-11-08, [검증 기록](../verification/local-agent.md#dx14-구현-검증)):**

- **파일 배치.** `credential_helper.rs`는 helper 실행 모드만 맡는다. `main.rs`가 `dachsterm git-credential <동작>`이면 Tauri와 인스턴스 잠금 전에 이 모드로 끝낸다. 탭 쪽은 `git_credential/wsl.rs`(pipe 수명, 셸 환경, 요청 하나 처리)다. pipe 생성과 수신 루프는 DX.13의 `local_agent/pipe.rs`에 `open`·`serve`로 모아 agent pipe와 함께 쓴다(두 번째 복사를 만들지 않음).
- **helper 경로는 실행 시 `wslpath -u`로 구한다.** 작업 지시의 "앱 실행 파일 경로를 WSL 경로로 바꾼 값"을 미리 넣는 방식은 DX.13.0 실측에서 버렸다(`/p`가 탭마다 경고를 출력). helper 값은 `!f() { [ "$1" = get ] || return 0; p=$(wslpath -u '<앱 경로>' 2>/dev/null) && [ -x "$p" ] || return 0; exec "$p" git-credential get; }; f`이다. 실행 파일이 없거나 변환에 실패하면 조용히 빠진다. 경로는 POSIX 작은따옴표로 인용하고, `GIT_CONFIG_PARAMETERS` 항목 전체를 다시 같은 방식으로 인용한다(git의 `sq_dequote`가 `'\''`를 읽는다).
- **환경 변수.** `DACHSTERM_CREDENTIAL_PIPE`는 wsl.exe의 Windows 환경에만 둔다. `GIT_CONFIG_PARAMETERS`는 `WSLENV`에 `GIT_CONFIG_PARAMETERS/u`로 넘긴다(Windows → WSL만). 사용자가 이미 `WSLENV`로 `GIT_CONFIG_PARAMETERS`를 넘기고 있으면 그 값 뒤에 덧붙이고 `WSLENV`는 건드리지 않는다. 넘기지 않던 Windows 쪽 값은 Linux에 새로 보내지 않는다. 탭의 기존 `WSLENV`(`PROMPT_COMMAND/u`, DX.13의 `GIT_SSH/up`)는 유지한다. 그래서 `local.rs`가 agent 환경을 먼저 합친 뒤 이 값을 계산한다.
- **pipe와 helper 사이 형식.** named pipe에는 반쪽 닫기가 없어 요청과 답 모두 `u32` 길이(빅엔디언)를 앞에 붙인다. helper는 git의 요청 앞에 `action=get`을 붙여 DX.12 파서를 그대로 쓴다. 요청은 64KiB, 답은 64KiB까지다. 탭은 답을 쓴 뒤 helper가 읽고 닫을 때까지(최대 5초) 기다렸다 닫는다. 이름은 `\\.\pipe\dachsterm-credential-<UUID 32자리>`이고 DACL·원격 거부는 DX.13과 같다. helper는 이 형식의 이름만 열고, 서버가 helper를 가장하지 못하게 `SECURITY_IDENTIFICATION`으로 연다. 모든 인스턴스가 바쁘면 5초까지 다시 시도한다. 동시 요청은 원격과 같은 4개, 요청 읽기 제한은 15초다.
- **승인 일반화(DX.12 메모의 남은 일).** `git_credential::approval::Forward`가 `Broker` 대신 `approval::Notify`로 카드를 보낸다. `git_credential_reply`는 `Owner::find`로 원격 연결이나 로컬 탭을 찾아 그 탭의 요청에 답한다(이름·인자 그대로). Docker probe는 창이 없으므로 원격 전용 진입점 `commands::answer(connections, …)`를 남겼다.
- **카드.** `CredentialRequest.local`로 문구를 바꾼다: 제목 "WSL의 git이 HTTPS 자격 증명을 요청합니다", "이 WSL 탭의 git으로 전달됩니다", 항목 "탭", 버튼 "이 탭에서 10분 허용". WSL 안의 git helper는 읽지 않으므로 서버 helper 경고 대신 "WSL에 설정한 Git helper가 있으면 그 helper도 이 값을 저장할 수 있습니다"를 늘 보인다.
- **설정.** 앱 설정 키 `wslGitCredentials`(bool, 손상되면 오류)를 `local_agent_settings`·`local_agent_save`가 함께 읽고 쓴다(§5대로. `local_agent_save`에 인자 `wslGitCredentials` 추가). 설정 창 › 에이전트에 **WSL 탭의 HTTPS Git 자격 증명** 절을 따로 두고 Windows에서만 보인다. macOS에는 WSL 탭이 없고, helper 모드는 pipe가 없으므로 아무것도 하지 않고 끝난다.
- **콘솔용 실행 파일은 두지 않는다.** DX.13.0 실측대로 GUI 하위 시스템 앱 실행 파일이 그대로 helper로 동작했다. NSIS·`.app` 패키지 구성은 바뀌지 않는다.

#### DX.13.0 — 실측 (게이트)

2026-11-08 Windows 11에서 실측했다. 상세는 [검증 기록](../verification/local-agent.md)에 있고, 설계에 반영한 내용은 DX.13·DX.14의 "DX.13.0 실측 반영"에 있다.

| 질문 | 결과에 따른 처리 | 결과 (2026-11-08) |
|---|---|---|
| Windows 11 기본 OpenSSH의 `ssh.exe`, `ssh-add.exe`가 `SSH_AUTH_SOCK`에 준 named pipe 경로를 쓰는가(버전 기록) | DX.13 Windows 방식 확정 | **쓴다.** OpenSSH_for_Windows 9.5p2(파일 9.5.6.4). 설계대로 |
| Git for Windows가 `GIT_SSH`로 Windows `ssh.exe`를 쓰고, `core.sshCommand`가 있으면 그것을 우선하는가 | 환경 변수 확정 | **그렇다.** Git 2.51.2. 동봉 ssh는 pipe를 쓰지 못한다. 설계대로 |
| WSL2 git이 interop으로 Windows `ssh.exe`를 실행해 push하는가. `WSLENV`로 넘긴 `SSH_AUTH_SOCK`을 그 `ssh.exe`가 받는가 | DX.13 WSL 방식 확정. 안 되면 WSL SSH는 후속 | **push한다. 받는다.** 그러나 `WSLENV` 없이 상속하는 쪽이 Linux를 건드리지 않아 그렇게 바꿨다 |
| `windows_subsystem = "windows"` 실행 파일을 WSL interop의 helper로 실행할 때 표준 입출력이 이어지는가. 시작 시간 | DX.14 helper 방식 확정. 안 되면 콘솔용 작은 실행 파일을 함께 배포 | **이어진다.** 중앙값 18ms(임시 실행 파일). 설계대로 |
| WSL 자동 마운트 위치(`wsl.conf`의 `root`)를 바꾼 경우의 경로 변환 | helper 경로 계산 확정 | 이 PC는 기본 `/mnt/`. 바꾼 경우는 미검증. 실행 시 `wslpath -u`로 바꿨다 |
| Finder로 실행한 Mac 앱이 띄운 로컬 셸에 시스템 `SSH_AUTH_SOCK`이 있는가(DX.0 미실측 항목과 같음) | DX.13 Mac에서 시스템 agent 합치기 확정 | **대기(Mac)** |

### DX.15 — 로컬·WSL 탭의 Git 상태 표시 (2026-11-08 추가)

**필요한 이유:** 저장소 폴더면 탭 종류와 상관없이 브랜치와 변경이 보여야 한다. 로컬·WSL 탭도 시작할 때 폴더 보고 훅을 받으므로(`local.rs`의 `POWERSHELL_FOLLOW`, cmd `PROMPT`, WSL `PROMPT_COMMAND`) 앱은 이미 셸의 폴더를 안다. DX.5는 조회를 SSH 연결에만 이어 두었을 뿐이다.

**구현:**

- 명령 `local_git_status(targetId, folder)`(`git_status/local.rs`). 결과 타입·상한(5초, 1MiB, 5000항목)·읽기 전용 설정은 DX.5와 같다.
  - 로컬 셸(Windows PowerShell·cmd, Mac 기본 셸): DX.12의 `git_program()`으로 찾은 이 PC의 git을 셸 없이 `git -C <폴더> -c core.fsmonitor=false`, 환경 `LC_ALL=C`·`GIT_OPTIONAL_LOCKS=0`으로 실행한다. 콘솔 창은 띄우지 않는다.
  - WSL: `wsl.exe --distribution <이름> --exec sh -c <DX.5 스크립트>`로 배포판 안의 git을 쓴다. Windows git으로 `\\wsl.localhost`를 읽으면 느리고 Linux 사용자 소유 저장소를 거부하기 때문이다.
  - 저장소 루트는 Git이 출력한 실제 경로가 아니라 **셸이 보고한 폴더 표기**로 돌려준다(`--show-prefix`만큼 폴더에서 잘라냄). Windows 짧은 이름(`ADMINI~1`), `subst` 드라이브, 심볼릭 링크를 거쳐 들어가도 파일 트리 행 경로와 맞는다.
- 프런트엔드: `gitStatusOf`가 로컬 탭도 받는다. Windows 경로는 `gitPath`로 `C:/...` 한 가지 표기로 맞춘다(셸은 `C:\repo`, 파일 패널은 `C:\repo/src`, Git은 `C:/repo`). POSIX 경로의 백슬래시는 파일 이름 글자이므로 바꾸지 않는다. 파일 트리는 Windows 드라이브 경로 목록도 Git에 알린다.
- 셸 훅 조건: Git 자동 조회가 켜져 있으면 경로 따라가기와 조작표가 모두 꺼져 있어도 폴더 보고 훅을 넣는다(SSH·Mac 로컬 탭). 전에는 이 둘을 끄면 Git 표시도 조용히 사라졌다.
- 설정 이름을 "SSH 폴더의 Git 상태 자동 조회"에서 "Git 상태 자동 조회"로 바꿨다.
- 범위 밖: 로컬 탭의 변경 검토(DX.6)는 SSH 전용 그대로다. 추적하지 않는 새 폴더는 Git이 폴더 한 항목으로 알리므로 그 안의 파일에는 표시가 없다(DX.5와 같음).

## 5. IPC

engineering-rules §5의 네 곳에 함께 등록한다. 모두 `async`이고 입력 검증과 위임만 한다. 터미널 소유권이 필요한 명령은 `broker.check(window.label())`로 확인한다.

| 명령 | 입력 | 동작 | 작업 |
|---|---|---|---|
| `agent_sign_reply` | 연결 ID, 요청 ID, 판단 | 대기 중인 서명 요청에 응답 | DX.2 |
| `tmux_current_path` | 연결 ID | 활성 패널의 폴더 | DX.3 |
| `git_status` | 연결 ID, 폴더 | 저장소 루트, 브랜치, 항목 | DX.5 |
| `git_refs` | 연결 ID, 루트 | 브랜치와 worktree 목록 | DX.6 |
| `git_diff_files` | 연결 ID, 루트, 기준 | 변경 파일 목록 | DX.6 |
| `git_diff_file` | 연결 ID, 루트, 기준, 경로 | 한 파일의 diff | DX.6 |
| `ssh_key_info` | 키 파일 경로 | 알고리즘, SHA-256 지문, 코멘트, 암호화 여부. 비밀은 읽지 않는다 | DX.11 |
| `agent_sign_reply` (인자 추가) | 위 + 선택적 Passphrase, 저장 여부 | 추가 키의 Passphrase를 받는다. 첫 줄에서 `Zeroizing` | DX.11 |
| `git_credential_reply` | 연결 ID, 요청 ID, 판단(거부, 이번만, 10분, 직접 입력과 값·저장 여부) | 대기 중인 자격 증명 요청에 응답. 값은 첫 줄에서 `Zeroizing` | DX.12 |
| `git_credentials_saved`, `git_credential_forget` | 없음 / 호스트·사용자 | 앱에 저장한 HTTPS 자격 증명 목록(값 제외)과 삭제 | DX.12 |
| `git_credential_shell` | 연결 ID | 셸 훅에 덧붙일 helper 줄(소켓이 열린 연결만). 구현에서 추가 | DX.12 |
| `local_agent_settings`, `local_agent_save` | 없음 / 설정, 키 목록, `wslGitCredentials` | 로컬·WSL 탭의 키 제공과 WSL 자격 증명 설정 읽기와 저장. Passphrase는 받지 않는다(DX.13 구현) | DX.13, DX.14 |

`agent_sign_reply`와 `git_credential_reply`의 요청 ID는 원격 연결과 로컬 탭을 모두 가리킬 수 있게 한다(DX.13). 새 명령을 따로 만들지 않는다.

`connect`에는 일회성 `launch`(폴더, 명령) 인자를 추가한다(DX.7 구현, tmux 세션에만 받는다). 새 크레이트는 없다. tokio의 named pipe 기능 활성화 여부는 구현 시 확인한다.

## 6. 설정

| 키 | 기본값 | 설명 |
|---|---|---|
| `gitStatus` | 켜짐 | Git 자동 조회. 끄면 수동 새로고침만 남는다 |
| `longCommandNotify` | 30초 | 0이면 끈다 |
| `agentPresets` | §DX.7 | 프리셋 목록. 저장 키 `dachsterm.agentPresets`, 설정 창의 "에이전트" 분류에서 편집 |

`forwardAgent`, `tmuxSession`은 세션별 설정이다. **서명 승인은 끌 수 없다.**

DX.11·DX.12의 세션별 설정(`serde(default)`, 세션 JSON v3 내보내기·가져오기에서 기본값으로 되돌림, §3.2와 같은 규칙):

| 필드 | 기본값 | 작업 |
|---|---|---|
| `forwardLoginKey: bool` | `true` | DX.11 |
| `forwardKeys: [{ path, secretRef? }]` | 빈 목록, 최대 8개 | DX.11 |
| `forwardSystemAgent: bool` | `true` | DX.11 |
| `forwardGitCredentials: bool` | `false` | DX.12 |

**자격 증명 전달 승인도 끌 수 없다.**

앱 전체 설정(DX.13·DX.14, 설정 창 › 에이전트): `localAgent`(꺼짐), `localAgentKeys`(빈 목록), `wslGitCredentials`(꺼짐). 로컬 탭에서도 앱의 키 서명과 자격 증명 전달은 승인을 받는다.

## 7. 보안 요약

- 서버는 신뢰할 수 없다. OSC, agent 프레임, Git 출력 모두 길이를 먼저 확인하고, 실패하면 버린다.
- Agent forwarding은 기본 꺼짐이고, 서버 요청만으로 시작되지 않으며, 가져온 파일로 켜지지 않는다. 경유 호스트에는 전달하지 않는다. 키 추가·삭제·잠금은 서버에서 할 수 없다.
- 서버 저장소는 공격 입력이 될 수 있다. 자동 조회와 diff는 저장소 설정으로 프로그램이 실행되는 경로를 끈다. clean 필터는 남는 위험으로 문서화한다.
- 모든 원격 명령은 고정 형식이고 사용자 값은 인용 함수를 거친다. 브랜치 이름은 서버가 준 목록과 대조한다.
- 앱은 사용자 동작 없이 터미널에 글자를 입력하지 않는다. 프롬프트 전달은 Enter를 보내지 않는다. 에이전트 시작만 사용자가 최종 명령을 확인한 뒤 실행한다.
- 서명 요청 내용, diff 내용, 의견을 로그와 진단 내보내기에 넣지 않는다.
- 내장 agent(DX.11)는 키를 서버로 보내지 않는다. 로그인 키는 키 전달을 켠 연결의 수명 동안만, 추가 키는 서명 순간이나 승인한 10분 동안만 메모리에 둔다. RSA SHA-1 서명은 하지 않는다.
- HTTPS 자격 증명 전달(DX.12)은 **값 자체가 서버로 간다.** 서버의 root는 그 순간 토큰을 볼 수 있다. 그래서 기본 꺼짐, 호스트별 승인, `https`만 허용, `get`만 전달(서버에 캐시 데몬을 남기지 않음), 서버가 보낸 값은 저장하지 않음을 지킨다. 서버 사용자의 기존 helper(`store`, `cache`)는 git이 보내는 `store`로 전달된 값을 저장할 수 있으므로 카드와 안내서에 알린다. helper는 자기 소유의 소켓에만 요청을 보낸다(DX.12.0). 무인 push에는 DX.2처럼 서버 전용 배포 토큰을 권한다.
- 원격 소켓은 연결마다 난수 경로이고 사용자 전용 권한이며, 앱은 자기가 연 경로의 채널만 받는다.
- 로컬 pipe와 소켓(DX.13·DX.14)은 탭마다 난수 이름이고 현재 사용자만 접근하며, 원격 클라이언트를 거부하고, 탭을 닫으면 사라진다. 같은 사용자의 다른 프로그램이 이름을 알아내 접근하더라도 앱의 키 서명과 자격 증명은 그 탭의 승인을 거친다.

## 8. 검증

| 범위 | 내용 | 수단 |
|---|---|---|
| 단위 | agent 프레임과 허용 판단, 인용, 표식, tmux 이름, 시작 명령 생성, porcelain v2 파서 | `cargo test` |
| 단위 | diff 파서(이름 변경, 바이너리, 인용 경로), 조회 일정, 현황판 정렬, 프리셋 검증, 재생 중 동작 | Vitest |
| UI | 서명 대화상자, 검토 패널 좁은 창, 트리 표시, 현황판, 접근성 이름 | Playwright 픽스처 |
| 실제 프로토콜 | Docker OpenSSH에서 agent 전달, 필터, 경유 거부, 실제 `git push`, tmux 재접속, 악성 Git 설정 저장소 | `probe:phase1` 확장. 호스트 OpenSSH 설정은 건드리지 않는다 |
| 네이티브 | 실제 앱에서 승인·거부, tmux 재접속, 트리 표시, 프롬프트 전달 | 기존 스크립트 수정 후 `verify-windows.ps1 -Native` 연결. T2 전까지 새 실행 헬퍼를 만들지 않는다 |
| 실제 Claude Code | 훅 상태, worktree, 검토 후 의견 전달 | 수동. Claude Code 버전과 함께 기록 |
| macOS 실기기 | Finder 앱의 `SSH_AUTH_SOCK`, agent 전달, tmux, 단축키, 검토 패널 | `mac-verify`. CI와 Windows 결과로 대체하지 않는다 |
| 단위 (DX.11·DX.12) | 알고리즘별 서명과 공개키 검증, RSA 플래그와 SHA-1 거부, 키 목록 합치기, 자격 증명 요청 파서(모르는 키, 제어문자, 상한), helper 값 인용 | `cargo test`, Vitest |
| 실제 프로토콜 (DX.11) | 시스템 agent 없이 로그인 키와 Git 전용 키로 push, 거부, `ssh-add -D` 차단, RSA SHA-2 | `probe:phase1` 확장 |
| 실제 프로토콜 (DX.12) | HTTPS Git 서버(Basic 인증, LFS, `tests/git-https`)와 git 1.8~최신 서버 이미지, 세 출처, 거부, 데몬 미생성, 남의 소유 소켓 무시, LFS 반복 요청, tmux 1.8~최신 새 패널. 이 PC 쪽은 격리한 `HOME`과 `store` helper로 사용자의 실제 자격 증명 관리자를 건드리지 않는다 | `probe:phase1` 확장 |
| 네이티브 (DX.11·DX.12) | 이 PC의 `ssh-agent`를 끈 그대로 승인·Passphrase 입력·push, 자격 증명 카드의 네 선택지 | `run-phase1 --native --agent-only` 확장 |
| 실제 호스팅 (DX.11·DX.12) | GitHub, GitLab.com, Bitbucket의 SSH·HTTPS push. 자격 증명 관리자와 버전을 함께 기록 | 수동 |
| macOS 실기기 (DX.11·DX.12) | Finder 앱에서 시스템 agent 없이 키 전달, 키체인 `git credential fill`, `/usr/bin/git` 설치 창이 뜨지 않음 | `mac-verify`, M.15에 추가 |
| 네이티브 (DX.13·DX.14) | `ssh-agent`가 꺼진 이 PC의 PowerShell·WSL 탭에서 `ssh-add -l`, SSH push(Docker의 Git 서버), WSL HTTPS push, 탭 종료 후 pipe 소멸, WSL Linux 쪽 `SSH_AUTH_SOCK` 불변과 두 WSL 탭의 pipe 분리(DX.13.0), 처음 보는 호스트의 질문 표시 | `test-local-native` 확장 |
| macOS 실기기 (DX.13) | 로컬 탭의 소켓, 시스템 agent 합치기, push | `mac-verify`, M.15에 추가 |

## 9. 구현 순서

| 순서 | ID | 범위 | 선행 | 완료 기준 |
|---|---|---|---|---|
| 1 | AT.0, DX.0 | 실측 | 없음 | 질문의 답이 기록됨 |
| 2 | AT.1~AT.3 | 줄바꿈, 상태, 알림 | AT.0 | AT 설계안 합격 |
| 3 | DX.1 | 공용 원격 실행 | 없음 | 기존 호출 이전, 회귀 통과 |
| 4 | DX.2 | Agent forwarding, 승인 | DX.0, AT.3 | 실제 push와 필터 |
| 5 | DX.3, DX.4 | tmux, 훅 상태 | DX.0, AT.2 | 재접속 후 에이전트 유지 |
| 6 | DX.5 | Git 상태 | DX.1 | 탭과 트리 표시 |
| 7 | DX.6 | diff 검토 | DX.5 | 악성 설정 차단, 의견 전달 |
| 8 | DX.7 | 에이전트 시작 | DX.3 | worktree에서 시작 |
| 9 | AT.4~AT.6 | 복사, 링크, 이미지, 포트 | AT.1 | AT 설계안 합격 |
| 10 | DX.8 | 현황판 | AT.2, DX.5 | 독립 창 포함 |
| 11 | DX.9 | 명령 경계 | AT.3 | 이동, 표시, 알림 |
| 12 | AT.7, DX.10 | 문서, 회귀, Mac | 전체 | 결과 기록 |
| 13 | DX.11 | 앱 내장 agent, 전달할 키 선택 | DX.2 | 시스템 agent 없이 Git 전용 키로 push |
| 14 | DX.12.0 | HTTPS 자격 증명 실측 | 없음. DX.11과 병렬 가능 | 질문의 답이 기록됨 |
| 15 | DX.12 | HTTPS 자격 증명 전달 | DX.11, DX.12.0 | 여러 git 버전에서 push, 데몬 미생성 |
| 16 | DX.13.0 | 로컬·WSL 실측 | 없음. DX.11, DX.12.0과 병렬 가능 | 질문의 답이 기록됨 |
| 17 | DX.13 | 로컬·WSL 탭의 SSH 키 제공 | DX.11, DX.13.0 | 시스템 agent 없이 PowerShell·WSL에서 push |
| 18 | DX.14 | WSL 탭의 HTTPS 자격 증명 | DX.12, DX.13 | WSL에서 HTTPS push |
| 19 | DX.15 | 로컬·WSL 탭의 Git 상태 표시 | DX.5 | PowerShell·WSL 저장소 폴더에서 상태바와 파일 트리 표시 |

- DX.11과 DX.12는 `ssh.rs` 핸들러, 세션 고급 옵션, 창 안 카드를 함께 고치므로 동시에 구현하지 않는다. DX.12.0과 DX.13.0은 코드를 바꾸지 않아 DX.11과 병렬로 진행할 수 있다.
- DX.13은 DX.11이 끝나면 DX.12와 병렬로 진행할 수 있다. 겹치는 곳은 승인 이벤트의 소유자 일반화(DX.13)와 카드(DX.12)이므로, DX.13이 일반화를 먼저 머지하는 순서를 권한다.
- 두 작업 모두 끝나면 안내서의 **SSH 키 전달** 절을 고치고 **HTTPS 자격 증명 전달** 절을 더한다. "이 PC의 agent" 준비 단계는 선택 사항으로 낮춘다.

- **중간 출시 지점:** 5번까지 하면 서버 에이전트의 기본 흐름이 완성되고, 7번까지 하면 차별점이 드러난다.
- **별도 진행:** 설치 파일과 서명(W.3, 5.3), 라이선스 지정은 코드 순서와 무관하다. 다른 사람이 써보려면 2번 전후로 먼저 끝내는 것이 좋다.

## 10. 이번 범위에서 제외

| 항목 | 판단 |
|---|---|
| 프로젝트 프리셋(서버, 폴더, 분할, 터널 묶음) | 후속. DX.7 사용 결과를 보고 판단한다 |
| 원격 Docker 컨테이너 탭 | 후속. DX.3의 PTY + `exec` 경로와 DX.1을 재사용할 수 있다 |
| 같은 SSH 연결의 탭 공유 | 후속. B1 터미널 통합 이후 |
| 로컬 탭의 변경 검토, 독립 창의 검토 패널, 서버 파일 편집기 열기 | 후속 (로컬 탭의 Git 표시는 DX.15에서 구현) |
| 구문 강조(diff, 터미널 키워드) | 후속 |
| Git 쓰기 동작, 그래프, 커밋 메시지 생성 | 제외. §1 경계 |
| Mosh | 제외. tmux가 같은 문제를 더 넓은 서버에서 푼다. UDP와 서버 설치가 필요하다 |
| 훅과 tmux 설정 자동 적용, 앱 안 AI 호출 | 제외. AT 원칙 |
| 내장 agent의 FIDO(`sk-*`) 키, 사용자 인증서 | 후속. FIDO는 시스템 agent를 거쳐 쓸 수 있다 |
| 자격 증명 `store`·`erase` 전달 | 제외. 서버가 보낸 암호를 받지 않고, 서버에 캐시 데몬을 띄우지 않기 위해서다 |
| Git 밖의 HTTPS 자격 증명(패키지 저장소 등), Windows 서버, fish·csh 자동 적용 | 후속. fish·csh는 안내서의 수동 한 줄로 쓴다 |
| 내장 agent를 고정 경로 소켓으로 제공해 tmux 재접속 문제를 없애는 것 | 후속 후보. DX.12의 원격 소켓 전달 경험을 보고 판단한다 |
| WSL 안에서 직접 치는 `ssh`의 agent | 후속. WSL2와 Windows pipe를 잇는 중계가 필요하다. DX.13은 git만 Windows `ssh.exe`를 거친다 |
| Windows·Mac 로컬 탭의 HTTPS 자격 증명 | 제외. 이 PC의 Git 자격 증명 관리자가 이미 처리한다 |
| WSL1 | 실측에서 동작하면 지원으로 기록하고, 따로 맞추지 않는다 |

## 11. 참고 자료

- [Claude Code 터미널 설정](https://code.claude.com/docs/en/terminal-config.md)
- [Claude Code 훅](https://code.claude.com/docs/en/hooks.md)
- [Claude Code CLI 참조](https://code.claude.com/docs/en/cli-reference.md)
- [Claude Code worktree](https://code.claude.com/docs/en/worktrees.md)
- [russh `client::Handler`](https://docs.rs/russh/0.65.1/russh/client/trait.Handler.html), [`Channel`](https://docs.rs/russh/0.65.1/russh/struct.Channel.html)
- [OpenSSH `ssh_config`](https://man.openbsd.org/ssh_config), [tmux](https://man.openbsd.org/tmux)
