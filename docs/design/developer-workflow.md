# 개발자 작업 흐름 — 설계안

- 작업 ID: **DX.0~DX.10**, 설계일: **2026-11-07**.
- 현재 상태: **DX.1·DX.2·DX.3·DX.4·DX.5·DX.6·DX.7·DX.9 구현, 나머지 미착수.** 상태 정본은 [progress.md](../progress.md), 범위 정본은 [roadmap.md §19](../roadmap.md)이다.
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
| `features/agents/AgentBoard.tsx`, `board.ts` | 현황판과 합치기 로직 | DX.8 |
| `features/terminal/commandMarks.ts` | OSC 133 표식, 이동, 긴 명령 판단 | DX.9 |
| `components/fileDecorations.ts` | 파일 트리 행 표시용 컨텍스트 | DX.5 |
| `app/SessionTab.tsx`, `app/ReviewDock.tsx` | `Tab` 이동과 검토 패널 연결 | AT.2, DX.6 |

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
- 대상은 SSH 탭이다. FTP, PodTree, 로컬 탭에는 등록하지 않는다. 로컬 탭은 실행 경로 규칙(§11)과 WSL 경로 변환이 달라 후속으로 둔다.

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

`connect`에는 일회성 `launch`(폴더, 명령) 인자를 추가한다(DX.7 구현, tmux 세션에만 받는다). 새 크레이트는 없다. tokio의 named pipe 기능 활성화 여부는 구현 시 확인한다.

## 6. 설정

| 키 | 기본값 | 설명 |
|---|---|---|
| `gitStatus` | 켜짐 | Git 자동 조회. 끄면 수동 새로고침만 남는다 |
| `longCommandNotify` | 30초 | 0이면 끈다 |
| `agentPresets` | §DX.7 | 프리셋 목록. 저장 키 `dachsterm.agentPresets`, 설정 창의 "에이전트" 분류에서 편집 |

`forwardAgent`, `tmuxSession`은 세션별 설정이다. **서명 승인은 끌 수 없다.**

## 7. 보안 요약

- 서버는 신뢰할 수 없다. OSC, agent 프레임, Git 출력 모두 길이를 먼저 확인하고, 실패하면 버린다.
- Agent forwarding은 기본 꺼짐이고, 서버 요청만으로 시작되지 않으며, 가져온 파일로 켜지지 않는다. 경유 호스트에는 전달하지 않는다. 키 추가·삭제·잠금은 서버에서 할 수 없다.
- 서버 저장소는 공격 입력이 될 수 있다. 자동 조회와 diff는 저장소 설정으로 프로그램이 실행되는 경로를 끈다. clean 필터는 남는 위험으로 문서화한다.
- 모든 원격 명령은 고정 형식이고 사용자 값은 인용 함수를 거친다. 브랜치 이름은 서버가 준 목록과 대조한다.
- 앱은 사용자 동작 없이 터미널에 글자를 입력하지 않는다. 프롬프트 전달은 Enter를 보내지 않는다. 에이전트 시작만 사용자가 최종 명령을 확인한 뒤 실행한다.
- 서명 요청 내용, diff 내용, 의견을 로그와 진단 내보내기에 넣지 않는다.

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

- **중간 출시 지점:** 5번까지 하면 서버 에이전트의 기본 흐름이 완성되고, 7번까지 하면 차별점이 드러난다.
- **별도 진행:** 설치 파일과 서명(W.3, 5.3), 라이선스 지정은 코드 순서와 무관하다. 다른 사람이 써보려면 2번 전후로 먼저 끝내는 것이 좋다.

## 10. 이번 범위에서 제외

| 항목 | 판단 |
|---|---|
| 프로젝트 프리셋(서버, 폴더, 분할, 터널 묶음) | 후속. DX.7 사용 결과를 보고 판단한다 |
| 원격 Docker 컨테이너 탭 | 후속. DX.3의 PTY + `exec` 경로와 DX.1을 재사용할 수 있다 |
| 같은 SSH 연결의 탭 공유 | 후속. B1 터미널 통합 이후 |
| 로컬 탭의 Git 표시, 독립 창의 검토 패널, 서버 파일 편집기 열기 | 후속 |
| 구문 강조(diff, 터미널 키워드) | 후속 |
| Git 쓰기 동작, 그래프, 커밋 메시지 생성 | 제외. §1 경계 |
| Mosh | 제외. tmux가 같은 문제를 더 넓은 서버에서 푼다. UDP와 서버 설치가 필요하다 |
| 훅과 tmux 설정 자동 적용, 앱 안 AI 호출 | 제외. AT 원칙 |

## 11. 참고 자료

- [Claude Code 터미널 설정](https://code.claude.com/docs/en/terminal-config.md)
- [Claude Code 훅](https://code.claude.com/docs/en/hooks.md)
- [Claude Code CLI 참조](https://code.claude.com/docs/en/cli-reference.md)
- [Claude Code worktree](https://code.claude.com/docs/en/worktrees.md)
- [russh `client::Handler`](https://docs.rs/russh/0.65.1/russh/client/trait.Handler.html), [`Channel`](https://docs.rs/russh/0.65.1/russh/struct.Channel.html)
- [OpenSSH `ssh_config`](https://man.openbsd.org/ssh_config), [tmux](https://man.openbsd.org/tmux)
