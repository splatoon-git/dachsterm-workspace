# 에이전트 터미널 지원 — 설계안

- 작업 ID: **AT.0~AT.7**, 설계일: **2026-11-06**.
- 현재 상태: **설계 완료, 구현 미착수.** 상태 정본은 [progress.md](../progress.md), 범위 정본은 [roadmap.md §18](../roadmap.md)이다.
- 기준 자료: Claude Code 공식 문서(2026-11-06 확인), OSC 7501 규격 revision 0.4(초안 성격, 2026-10-10), 저장소의 `@xterm/xterm` 6.0.0 소스.
- 문서로 확정되지 않은 동작은 **AT.0 실측**으로 표시했다. 실측 전에는 사실로 취급하지 않는다.
- 크기 상한, 시간, 개수 값은 구현 출발점인 제안값이다.

## 1. 목표와 원칙

SSH 서버와 로컬 탭에서 Claude Code 같은 CLI 에이전트를 쓸 때 필요한 터미널 기능을 제공한다.

- **전용 모드를 만들지 않는다.** 앱은 실행 중인 프로그램이 Claude인지 판단하지 않고 터미널 표준 신호만 처리한다. Codex 등 다른 CLI도 같은 기능을 쓴다.
- **화면 글자를 해석하지 않는다.** 상태는 프로그램이 보낸 신호로만 판단한다.
- **서버를 변경하지 않는다.** 서버 설정 파일과 훅을 자동으로 수정하지 않으며, 서버 에이전트를 설치하지 않는다. 사용자가 명시적으로 올린 프롬프트 첨부 파일만 예외다(AT.5).
- **앱 안에서 AI를 호출하지 않는다.** Claude Code 내장, API 호출, 모델 실행은 범위 밖이다.

## 2. 공식 문서 요구사항과 현재 코드 대조

| 항목 | 공식 문서 | 현재 코드 | 처리 |
|---|---|---|---|
| 세션 상태 | OSC 7501을 구현한 터미널은 작업 중·대기·완료를 표시할 수 있다. Claude Code v2.1.295 이상 | 미처리 | AT.2 |
| 완료·권한 대기 알림 | 목록 외 터미널은 기본 알림이 없다. `preferredNotifChannel`로 벨이나 터미널별 알림을 켠다 | BEL·OSC 9 미처리. OSC 777은 앱 자체 형식만 처리 | AT.3 |
| Shift+Enter 줄바꿈 | kitty 키보드 프로토콜 지원 터미널은 설정 없이 동작한다. v2.1.269 이상 | xterm이 Enter와 같은 CR을 보낸다(`Keyboard.ts`). kitty 프로토콜 없음 | AT.1 |
| Option 단축키 | macOS는 Option을 Meta로 설정해야 한다 | `macOptionIsMeta` 미설정([M.8](../verification/macos-readiness.md)) | AT.1 |
| 선택 복사 | 전체화면 모드는 SSH에서 OSC 52로 대체한다 | OSC 52 미처리 | AT.4 |
| 링크 열기 | xterm.js 계열에서는 터미널의 링크 처리에 맡긴다. Ctrl/Cmd+클릭 | `linkHandler` 미설정. 기본값은 `confirm`과 `window.open`이고, 앱에 외부 열기 수단이 없다 | AT.4 |
| 이미지 전달 | 드래그 앤 드롭, 붙여넣기, 파일 경로 입력을 지원한다. SSH 동작은 명시되지 않았다 | 터미널에 이미지 경로 없음. 파일 드롭은 파일 패널만 처리 | AT.5 |
| 동기화 출력 | 시작 시 터미널에 지원 여부를 묻는다 | xterm이 모드 2026과 DECRQM 응답을 구현한다 | AT.0 확인만 |
| 전체화면 마우스 | 터미널이 마우스 이벤트를 전달해야 한다 | xterm 마우스 보고, 우클릭 가드 있음 | AT.0 확인만 |
| 자리 비움 판단 | 사용자가 터미널을 떠난 것으로 보일 때 알림을 보낸다. 판단 방식은 명시되지 않았다 | xterm이 포커스 보고를 구현한다. 탭 전환 시 전송 여부는 미확인 | AT.0 확인 |
| 큰 붙여넣기 | 큰 내용은 파일로 전달할 것을 권장한다 | 64KiB 상한과 제어문자 확인창이 있다 | 변경 없음, 안내만 |

**문서 항목이 아니지만 사용자 요청으로 포함한다:** 이미지 업로드(AT.5), 서버 포트 터널(AT.6).

## 3. 공통 구조

### 3.1 파일 배치

`session.ts`(392줄)는 TS 상한 400줄에 가깝고, `App.tsx`와 `TunnelPanel.tsx`는 이미 상한을 넘어 순증이 금지되어 있다. 새 기능은 새 파일에 두고 기존 파일에는 연결만 추가한다.

| 파일 | 역할 |
|---|---|
| `features/terminal/integrations.ts` | OSC·CSI·ESC·벨 핸들러 등록과 해제. `session.ts`에는 생성과 해제만 추가한다(8줄 이내) |
| `features/terminal/programStatus.ts` | OSC 7501 파서와 레코드 저장소(`subscribe`, `snapshot` 제공). React 없음 |
| `features/terminal/kittyKeyboard.ts` | kitty 키보드 상태와 Enter 인코딩 순수 로직 |
| `features/terminal/terminalNotify.ts` | 알림 발송 판단과 빈도 제한 순수 로직 |
| `features/terminal/osc52.ts` | OSC 52 파서와 허용 판단 |
| `features/terminal/terminalLinks.ts` | 링크 분류, 링크 제공자, `linkHandler` |
| `features/terminal/StatusBadge.tsx`, `agent.css` | 탭과 독립 창의 상태 표시. 색상은 `status` 토큰만 사용 |
| `features/terminal/AgentPreferences.tsx` | 설정 UI. `TerminalPane`에는 삽입 한 줄만 추가 |
| `features/terminal/promptFiles.ts`, `PromptUploadConfirm.tsx` | 이미지 붙여넣기, 파일 드롭, 경로 입력 |
| `features/tunnels/ForwardPortDialog.tsx`, `remotePorts.ts` | 포트 목록, 임시 터널, 브라우저 열기 |
| `app/SessionTab.tsx` | `App.tsx`의 `SessionTab`을 옮긴다. 순증 금지를 지키면서 배지를 넣기 위한 이동이다 |
| `src-tauri/src/desktop_bridge.rs` | 클립보드 쓰기, URL 열기, OS 알림 |
| `src-tauri/src/prompt_files.rs` | 프롬프트 첨부 업로드와 7일 경과 파일 정리 |
| `src-tauri/src/remote_ports.rs` | 서버 수신 포트 조회 |

terminal 기능이 tunnels 기능을 직접 import하지 않는다(규칙 §7). 서버 내부 주소 링크는 `TerminalPane`의 새 콜백 `openServerLink`로 올리고, `App`과 `DetachedWindow`가 `ForwardPortDialog`를 연다.

### 3.2 적용 대상

| 탭 | 적용 |
|---|---|
| SSH | AT.1~AT.6 전체 |
| 로컬 셸, WSL | AT.1~AT.4. AT.5는 업로드 없이 경로만 입력한다. AT.6은 해당 없음 |
| PodTree, FTP | 등록하지 않는다 |

### 3.3 출력 재생 규칙

독립 창으로 옮기면 `Broker`가 최근 최대 2MiB를 다시 보낸다. 과거 신호가 실제 동작을 일으키면 안 된다. `session.ts`의 `replaying`을 `integrations.ts`에 함수로 전달한다.

| 신호 | 재생 중 동작 |
|---|---|
| OSC 7501 레코드, kitty 키보드 상태 | 반영한다. 새 창의 상태를 복원하기 위해서다 |
| OSC 7501 질의 응답, kitty 질의 응답 | 보내지 않는다. `send`가 재생 중 입력을 막는 기존 동작을 이용한다 |
| OS 알림, BEL, OSC 9, OSC 777 알림 | 무시한다 |
| OSC 52 | **반드시 무시한다.** 과거 복사가 현재 클립보드를 덮어쓰면 안 된다 |

재생 범위를 벗어난 과거 상태는 복원되지 않는다. 이 경우 다음 보고가 올 때까지 배지가 비어 있거나, Shift+Enter가 Enter로 동작할 수 있다.

### 3.4 환경별 기대 동작

| 환경 | 상태 표시 | OS 알림 | Shift+Enter |
|---|---|---|---|
| SSH 직접 | OSC 7501 | 상태 전환에서 앱이 발송. 서버 설정 불필요 | AT.1 |
| tmux | **불가.** tmux 안에서는 Claude Code가 tmux 지원 여부를 확인한다 | 사용자가 `allow-passthrough`와 `preferredNotifChannel`을 설정하면 OSC 경로로 동작 | 사용자의 `extended-keys` 설정 필요 |
| 로컬·WSL | OSC 7501 | SSH와 동일 | AT.1 |
| Claude Code 백그라운드 세션 | 불가(문서 명시) | 해당 설정에 따름 | AT.1 |

tmux 설정은 앱이 대신 쓰지 않고 사용 안내서에 적는다.

## 4. 작업별 설계

### AT.0 — 실제 Claude Code 실측 (게이트)

구현 전에 실제 앱의 SSH 탭에서 실제 Claude Code를 실행해 입출력을 기록한다. 대상은 Docker의 OpenSSH 컨테이너이며, 호스트 OpenSSH 설정은 건드리지 않는다.

```text
script -q -f --log-out /tmp/at-out.log --log-in /tmp/at-in.log -c claude
```

로그에는 대화 내용과 인증 정보가 들어갈 수 있으므로 저장소에 넣지 않는다. 시퀀스 종류와 결론만 `docs/verification/agent-terminal.md`에 기록한다.

| 질문 | 결과에 따른 처리 |
|---|---|
| Claude Code가 SSH에서 `OSC 7501 ; ?`를 보내는가 | 보내면 AT.2 그대로 진행. 안 보내면 원인을 찾을 때까지 AT.2 중단 |
| `CSI ? u` 질의를 보내고, 응답이 있으면 kitty 모드를 켜는가 | 켜면 AT.1 그대로. 터미널 이름으로 판단하면 AT.1의 대체안 사용 |
| `CSI 13;2u`를 줄바꿈으로 처리하는가 | AT.1 합격 기준 |
| `preferredNotifChannel`의 `terminal_bell`, `iterm2`, `ghostty`가 실제로 보내는 바이트 | AT.3 파서 확정 |
| DECRQM 2026을 질의하고 동기화 출력을 쓰는가 | 안 쓰면 `CLAUDE_CODE_FORCE_SYNC_OUTPUT=1` 안내 |
| `/tui fullscreen`의 휠, 클릭, 선택이 동작하는가 | 실패하면 원인 수정을 범위에 추가 |
| 탭 전환과 창 전환에서 포커스 해제 보고(`CSI O`)가 나가는가 | 안 나가면 비활성화 시 `textarea.blur()` 추가 |
| SSH 프롬프트에서 Ctrl+V가 PC 이미지를 읽지 못하는가 | 읽지 못함을 확인해야 AT.5의 전제가 성립 |
| 로컬 탭에서 Alt+V(Windows)가 Claude Code까지 도달하는가 | 안 되면 키 전달 수정 |
| 색상과 취소선이 정상인가 | 깨질 때만 `COLORTERM` 전달 검토 |

### AT.1 — 줄바꿈과 Option 키

**Shift+Enter는 프로그램이 요청했을 때만 다르게 보낸다.** 무조건 ESC+CR이나 LF로 바꾸면 Vim 입력 모드가 끝나거나 셸 명령이 실행될 수 있다. 프로그램이 kitty 키보드 모드를 켰을 때만 바꾸면 이 문제가 생기지 않는다.

kitty 프로토콜에서 다음 부분만 구현한다. 시퀀스는 구현 시 규격 원문과 대조한다.

| 입력 | 처리 |
|---|---|
| `CSI ? u` | `CSI ? <플래그> u`로 응답한다 |
| `CSI > <플래그> u` | 현재 화면의 스택에 넣는다(깊이 제안값 16) |
| `CSI < <개수> u` | 스택에서 뺀다 |
| `CSI = <플래그> ; <모드> u` | 현재 값을 바꾼다 |

- 지원 플래그는 1(disambiguate)만 보고한다. 일반 화면과 대체 화면의 상태를 분리한다.
- 플래그 1이 켜져 있으면 수식키가 있는 Enter를 `CSI 13 ; <수식값> u`로 보낸다(Shift는 `13;2u`). 그 밖의 키는 기존 인코딩을 유지한다. 전체 구현이 아니므로 이 사실을 코드 주석에 남긴다.
- 전체 재설정(RIS)과 재접속 시 상태를 지운다. 프로그램이 해제 없이 죽어도 영향은 Shift+Enter에 한정된다.
- `isComposing`을 먼저 확인하는 기존 순서를 유지해 한글 조합을 깨지 않는다.
- **대체안(AT.0 결과가 부정적일 때만):** OSC 7501 레코드에 `app=claude-code`가 살아 있을 때만 줄바꿈 시퀀스를 보낸다. 앱 이름에 의존하므로 차선이다.
- `Ctrl+J`와 `\`+Enter는 문서상 항상 동작하므로 안내서에 함께 적는다.

**macOS Option:** 설정 `macOptionAsMeta`(기본 꺼짐)를 추가한다. 켜면 xterm `macOptionIsMeta`를 적용한다. Option 특수문자 입력과 충돌하므로 macOS에서만 설정을 표시한다. M.8을 함께 닫는다.

**합격:** Claude Code에서 Shift+Enter가 줄바꿈이 된다. Bash와 Vim에서는 기존과 동일하다. tmux는 안내한 설정으로 동작한다.

### AT.2 — 프로그램 상태 표시 (OSC 7501)

**파서(규격 그대로):**

- `OSC 7501 ; ?`에는 `OSC 7501 ; ? ST`로 응답한다. 목록을 생략하면 규격의 기본 상태와 종류를 뜻한다. 응답에 보고 내용을 포함하지 않는다.
- 전체 시퀀스 4096바이트, `msg` 인코딩 2732·디코딩 2048바이트, `title` 인코딩 256·디코딩 192바이트, `app` 32바이트, `id` 128바이트·세그먼트 32바이트·8단계를 지킨다. 인코딩 길이를 디코딩 전에 검사한다.
- 잘못된 쌍은 건너뛰고, 알 수 없는 키는 무시하고, 반복 키는 마지막 값을 쓴다.
- `state`가 없거나 알 수 없으면 보고 전체를 무시한다. 잘못된 `id`도 전체를 무시한다(루트로 대체 금지).
- base64 복호화 실패, UTF-8 오류, 제어문자가 있으면 보고 전체를 버린다.
- `OSC 9;4` 진행률은 매핑하지 않는다. 진행률 표시 자체를 이번 범위에서 뺀다.

**레코드 수명:**

| 사건 | 처리 |
|---|---|
| 같은 `id` 보고 | 레코드 전체 교체 |
| `state=clear` | 해당 레코드와 하위 삭제. `id`가 없으면 전체 삭제 |
| 레코드 64개 초과 | 가장 오래 갱신되지 않은 것 삭제. 규격 최소값이며 앱 상한으로 쓴다 |
| 연결 종료 | `working`, `blocked` 삭제. `done`, `error`, `idle`은 유지 |
| OSC 133 `A` | 같은 처리 |
| 전체 재설정(RIS), 재접속 | 전체 삭제. `registerEscHandler({ final: 'c' })`로 감지하고 기본 처리를 막지 않는다 |
| 화면 전환 | 영향 없음 |

**프롬프트 감지 보완:** 현재 셸 훅은 OSC 133을 보내지 않고 프롬프트마다 `OSC 1337;CurrentDir`를 보낸다. 프로그램이 비정상 종료하면 `working`이 남을 수 있으므로 이 신호도 프롬프트로 취급한다. OSC 7은 프롬프트 외의 시점에도 나올 수 있어 사용하지 않는다. 훅을 쓰지 않는 서버에서는 남아 있을 수 있으며, 다음 보고나 연결 종료 때 해소된다.

**표시:**

- 여러 레코드는 `blocked > error > working > done > idle` 순으로 하나의 탭 상태로 합친다.
- 연결이 `connected`일 때 탭의 작은 글씨 자리에 상태를 표시한다(`작업 중`, `입력 대기`, `완료`, `오류`). `idle`은 `연결됨`을 유지한다.
- 색만으로 구분하지 않고 글자와 `aria-label`을 함께 쓴다.
- `done`, `error`는 사용자가 그 창에 포커스하거나 키를 입력하면 표시를 지운다. 레코드는 유지한다. `terminal.onKey`로 판단하며, 마우스 보고나 자동 응답까지 포함하는 `onData`는 쓰지 않는다.
- `blocked`는 자동으로 지우지 않는다.
- `msg`와 `title`은 툴팁에만 일반 텍스트로 넣고, 숨김·방향 제어 문자를 제거하고, 200자로 자른다.

### AT.3 — 알림

| 입력 | 내용 |
|---|---|
| OSC 7501 전환 | `working` 등에서 `blocked`, `done`, `error`로 바뀔 때 |
| BEL | `terminal.onBell`. Claude Code의 `terminal_bell` 경로 |
| OSC 9 | `9;<메시지>`. `4;`로 시작하면 진행률이므로 무시 |
| OSC 777 | `notify;<제목>;<본문>`. 기존 `DachsTerm;program` 핸들러와 분리하고, 해당하지 않으면 `false`를 반환해 다음 핸들러로 넘긴다 |

OSC 99는 청크 구조가 복잡하고 다른 경로로 대체할 수 있어 넣지 않는다.

**발송 규칙(`terminalNotify.ts`):**

1. 재생 중이면 보내지 않는다.
2. 해당 탭의 창이 포커스되어 있고 `.terminal-pane` 안에 포커스가 있으면 보내지 않는다.
3. 탭당 5초에 1건, 앱 전체 2초에 1건으로 제한한다. 제한되어도 탭 배지는 갱신한다.
4. 같은 탭에서 3초 안에 OSC 7501과 OSC 9가 함께 오면 1건으로 합친다.
5. 제목은 항상 앱이 만든 `<세션 이름> — 입력 대기` 형식을 쓴다. 서버 문자열은 본문에만 넣고 200자로 자른다. 어느 터미널의 알림인지 보여야 한다는 규격 권고와 위조 방지를 위해서다.

알림 클릭으로 탭을 여는 기능은 넣지 않는다. 데스크톱에서 클릭 이벤트를 안정적으로 받는다는 근거를 확인하지 못했다.

### AT.4 — OSC 52와 링크

**OSC 52:**

- `52;<대상>;<base64>`에서 대상이 비었거나 `c`를 포함할 때만 쓴다.
- 읽기(`?`)는 응답 없이 거부한다. **클립보드 내용을 서버로 보내는 경로를 만들지 않는다.**
- 디코딩 후 1MiB 상한, UTF-8 오류나 base64 오류는 무시한다.
- 재생 중이거나 포커스된 패널이 아니면 무시한다. 백그라운드 탭이 클립보드를 덮어쓰지 못하게 하기 위해서다.
- 설정 `clipboardWrite`(기본 켜짐)로 끌 수 있다.
- Rust `clipboard_write_text`로 쓴다. WKWebView의 `navigator.clipboard.writeText`는 사용자 동작 밖에서 실패할 수 있어 웹 API에 의존하지 않는다.

**링크:**

- `linkHandler`로 OSC 8을 처리하고, 일반 텍스트 URL은 `registerLinkProvider`로 찾는다. 대상은 `http`, `https`뿐이다.
- `ctrlKey || metaKey`가 있을 때만 연다. 일반 클릭은 아무 동작도 하지 않는다. 문서의 동작과 같다.
- 호버 시 실제 대상을 보여준다. OSC 8은 표시 글자와 대상이 다를 수 있기 때문이다.
- Rust `url_open`이 다시 검증한다: `http(s)`만, 사용자 정보 포함 금지, 2048자 이하, 제어문자 금지. UNC와 `file:`은 열지 않는다.
- SSH 탭의 `localhost`, `127.0.0.1`, `0.0.0.0`, `[::1]` 주소는 서버 내부 주소이므로 바로 열지 않고 AT.6으로 보낸다. 로컬과 WSL 탭은 바로 연다.
- 실측: 마우스 추적 중인 전체화면 모드에서 Ctrl/Cmd+클릭이 링크와 앱 양쪽에 전달되는지 확인한다.

**파일 경로 클릭은 이번 범위에서 뺀다.** 편집 시작에 필요한 편집기 선택이 파일 패널 소유여서 기능 간 구조를 먼저 정리해야 한다. 로컬 파일을 OS로 여는 동작은 실행 파일을 실행할 위험도 있다. 후속 후보로 둔다.

### AT.5 — 이미지 붙여넣기와 파일 드롭

SSH 서버의 Claude Code에 PC의 이미지와 파일을 전달한다. 앱은 SFTP로 올리고 경로를 프롬프트에 입력한다. 문서가 보장하는 경로 입력 방식을 쓰며, Enter는 보내지 않는다.

**이미지 붙여넣기 입력:**

| 경로 | 처리 |
|---|---|
| Ctrl/Cmd+Shift+V, Shift+Insert, 우클릭, 붙여넣기 버튼 | 기존 `readText`가 빈 값이면 `prompt_clipboard_image` 호출 |
| macOS Cmd+V, 브라우저 `paste` 이벤트 | 기존 `intercept`에서 텍스트 없이 이미지 파일만 있으면 같은 경로로 처리 |
| Ctrl+V | **가로채지 않는다.** Vim 등이 쓰는 터미널 입력이다. 안내서에 대체 키를 적는다 |

텍스트와 이미지가 함께 있으면 텍스트를 우선한다. 로컬 탭은 Claude Code가 OS 클립보드를 직접 읽으므로 업로드하지 않고 해당 단축키를 안내한다.

**파일 드롭:** `FilePanel`과 같은 방식으로 `getCurrentWebview().onDragDropEvent`와 `devicePixelRatio` 좌표 변환을 쓴다. 활성 패널 영역 안의 드롭만 처리한다. 숨겨진 패널은 크기가 0이어서 제외된다. 폴더와 심볼릭 링크는 거부한다. 로컬 탭은 경로만 입력하고, WSL은 드라이브 경로를 `/mnt/<드라이브>/…`로 변환한다. UNC는 거부한다.

**서버 저장:**

- 위치는 `$HOME/.cache/dachsterm/prompt/`, 디렉터리 0700, 파일 0600이다. 디렉터리가 심볼릭 링크이면 거부한다.
- 이름은 `YYYYMMDD-HHMMSS-<8hex>-<이름>`이다. 원래 이름은 `[A-Za-z0-9._-]` 외 문자를 `_`로 바꾼다. 이렇게 하면 macOS NFD 문제와 경로 인용 문제가 함께 사라진다.
- `.dachsterm-*` 접두사는 쓰지 않는다. 전송 복구 규약과 충돌한다.
- 새 파일 전용(create + exclusive)으로 만들고, 실패하면 부분 파일을 지운다.
- 상한은 파일당 20MiB, 드롭 1회 10개다. 넘으면 SFTP 패널 사용을 안내한다. 클립보드 이미지는 인코딩 전 픽셀 수도 제한한다.
- 업로드 시 이 폴더에서 이름 규칙에 정확히 맞고 7일이 지난 일반 파일만 지운다. 정리 실패는 업로드를 실패시키지 않는다.

**전송 큐를 쓰지 않는다.** 전송 큐의 영속 재개와 충돌 처리는 "지금 프롬프트에 첨부"라는 목적과 맞지 않다. 앱을 재시작한 뒤 경로를 입력할 대상도 없다. 정책이 다르므로 합치지 않고, 이유를 `prompt_files.rs` 주석에 남긴다.

**확인:** PC 데이터를 서버로 보내는 동작이므로 연결마다 첫 업로드에 확인창을 띄운다. 파일 이름, 크기, 대상 서버, 저장 위치를 표시한다. "이 연결에서는 다시 묻지 않음"은 메모리에만 유지한다. 드롭은 실수 가능성이 있어 매번 확인한다.

**입력:** 업로드가 끝나면 `connectionId`와 연결 상태를 다시 확인한 뒤 `terminal.paste(<경로> + ' ')`를 호출한다. 탭이 바뀌었으면 입력하지 않고 경로를 알린다.

### AT.6 — 서버 포트 터널

Claude Code가 서버에 띄운 개발 서버를 PC 브라우저로 여는 흐름이다. 진입점은 두 곳이다.

1. SSH 탭에서 `localhost` 링크를 Ctrl/Cmd+클릭한다(AT.4).
2. 터널 패널의 **서버 포트 보기**로 `ForwardPortDialog`를 연다.

**포트 조회:** `remote_ports`는 고정 명령 `cat /proc/net/tcp /proc/net/tcp6`를 exec 채널로 실행해 상태 `0A`만 파싱한다. 별도 도구가 필요 없고 사용자 입력이 명령에 들어가지 않는다. 출력 1MiB, 시간 5초로 제한한다. Linux 외 서버는 "이 서버에서는 포트 목록을 읽을 수 없습니다"를 표시한다. **자동 폴링하지 않고** 대화상자를 열 때와 새로고침 때만 조회한다. 기본 목록에서 1024 미만 포트는 숨긴다.

**임시 터널:**

- 기존 `tunnel_start`에 `kind: 'local'`, `id: temp-<uuid>`, `autoStart: false`인 설정을 넘기고 `tunnel_save`는 호출하지 않는다. 기존 코드는 127.0.0.1에만 바인딩하고 연결 종료 시 터널을 멈춘다.
- PC 포트는 서버와 같은 번호부터 시도하고 충돌하면 다음 번호를 최대 10개까지 시도한다. `tunnel_list`로 `running`을 확인한 뒤에만 다음 단계로 간다.
- 실행 중인 같은 대상이 있으면 재사용한다.
- 준비되면 URL의 주소와 포트만 바꿔 `url_open`으로 연다. 사용자의 확인 후에만 터널을 연다.
- **`TunnelPanel`은 저장된 설정만 나열하므로 임시 터널이 보이지 않는다.** `ForwardPortDialog`에서 실행 중인 `temp-` 터널을 표시하고 중지할 수 있어야 한다.
- `TunnelPanel`은 순증 금지이므로 진입 버튼을 넣을 때 같은 파일에서 그만큼 줄인다.

## 5. IPC와 의존성

새 명령은 engineering-rules §5의 네 곳에 함께 등록한다.

| 명령 | 입력 | 동작 | 작업 |
|---|---|---|---|
| `notification_show` | 제목, 본문 | OS 알림. 길이 제한 재검증 | AT.3 |
| `clipboard_write_text` | 문자열 | 1MiB 상한, 포커스된 창만 허용 | AT.4 |
| `url_open` | URL | §4 AT.4의 검증 후 열기 | AT.4 |
| `prompt_clipboard_image` | 연결 ID | 이미지 없으면 `null`, 있으면 업로드한 경로 | AT.5 |
| `prompt_files_upload` | 연결 ID, 로컬 경로 목록 | 업로드한 경로 목록 | AT.5 |
| `remote_ports` | 연결 ID | `{ host, port }` 목록 | AT.6 |

- 클립보드, 파일, 네트워크를 쓰므로 `async`로 만들고, 블로킹 호출에는 `spawn_blocking`을 쓴다. 터미널 소유권이 있는 명령은 `broker.check(window.label())`로 창을 확인한다.
- 웹뷰에 플러그인 권한을 직접 열지 않고, 검증한 Rust 명령으로만 노출한다.

| 추가 크레이트 | 용도 | 대안을 택하지 않은 이유 |
|---|---|---|
| `arboard` | 클립보드 이미지 읽기, 텍스트 쓰기 | 웹 클립보드 API는 WKWebView에서 사용자 동작 제약과 권한 표시 차이가 있다 |
| `png` (직접 의존으로 승격) | 클립보드 이미지 인코딩 | `Cargo.lock`에 이미 있다 |
| `tauri-plugin-opener` | URL 열기 | 현재 앱에 수단이 없다 |
| `tauri-plugin-notification` | OS 알림 | 웹 `Notification`은 WKWebView 지원을 기대할 수 없다 |

의존성 추가 시 macOS 빌드, `audit-windows.mjs`, `generate-notices.mjs`를 함께 확인한다. 버전은 기존 방식대로 `=`로 고정한다.

## 6. 설정

`features/terminal/preferences.ts`의 `dachsterm.*` 저장 방식을 따른다.

| 키 | 기본값 | 설명 |
|---|---|---|
| `programStatus` | 켜짐 | 끄면 OSC 7501에 응답하지 않고 배지를 표시하지 않는다 |
| `osNotifications` | 켜짐 | OS 알림. 배지는 별도로 유지 |
| `bellNotifications` | 켜짐 | BEL을 알림으로 취급. `terminal_bell` 경로에 필요 |
| `clipboardWrite` | 켜짐 | OSC 52 쓰기 |
| `macOptionAsMeta` | 꺼짐 | macOS에서만 표시 |

## 7. 보안 요약

- OSC 내용은 **서버가 보낸 신뢰할 수 없는 입력**이다. 모든 파서는 길이를 먼저 확인하고, 실패하면 버리고, 터미널 출력을 멈추지 않는다.
- 터미널이 서버로 되돌려 보내는 값은 고정된 지원 여부 응답뿐이다. 레코드, 클립보드, 로컬 경로를 응답에 넣지 않는다.
- 서버 문자열은 일반 텍스트로만 표시한다. 알림 제목에 넣지 않는다.
- 클립보드 읽기는 사용자의 붙여넣기 동작에서만 일어난다.
- `url_open`은 프론트엔드 검증과 별개로 Rust에서 재검증한다.
- 첨부 파일은 0600으로 만들되, 서버의 다른 관리자가 읽을 수 있음을 확인창과 안내서에 적는다.
- 로그에 클립보드 내용, 알림 본문, 첨부 내용을 남기지 않는다.

## 8. 검증

| 범위 | 내용 | 수단 |
|---|---|---|
| 단위 | 7501 문법·상한·수명·`clear`·LRU, kitty 스택·화면 분리, 알림 제한·병합, OSC 52, 링크 분류, 파일 이름 변환 | Vitest |
| 단위 | 재생 중 알림·OSC 52 차단. `session.ts` 재생 처리의 기존 미비 테스트(U7)를 이 범위만큼 보완 | Vitest |
| 단위 | `/proc/net/tcp` 파싱, 이름 규칙, 정리 대상 판별, URL 검증 | `cargo test` |
| UI | 탭 배지 상태, 접근성 이름, 설정, 확인창, 임시 터널 표시 | Playwright 픽스처 |
| 네이티브 | 실제 앱, 실제 OpenSSH에서 `printf`로 시퀀스 재현: 응답, 배지, OSC 52, 재생 차단, 업로드, 임시 터널 왕복 | `verify-terminal-basics.mjs`와 기존 스크립트 확장. T2 전까지 새 실행 헬퍼를 만들지 않는다 |
| 실제 Claude Code | 수동: Shift+Enter, 상태 전환, 권한 대기 알림, `/copy`, 전체화면, 이미지 경로 인식, 로그인 URL | `docs/verification/agent-terminal.md`에 Claude Code 버전과 함께 기록 |
| macOS 실기기 | Cmd+V 이미지, Cmd+클릭, Option Meta, 한글 IME와 Enter, OS 알림 권한, 미서명 앱 알림, Finder 실행 앱의 URL 열기 | `mac-verify`. CI와 Windows 결과로 대체하지 않는다 |

시퀀스 재현은 파서와 앱 동작 검증이다. 실제 Claude Code와의 호환성 결과로 기록하지 않는다.

## 9. 구현 순서

시작 전: `session.ts`, `App.tsx`, `FilePanel.tsx`, `local.rs`, `preferences.ts`에 다른 작업의 미커밋 변경이 있다. 해당 파일을 건드리는 단계는 그 변경이 정리된 뒤 시작한다.

| ID | 범위 | 선행 | 완료 기준 |
|---|---|---|---|
| AT.0 | 실측, 결론 기록 | 없음 | §4 AT.0 표의 답이 기록됨 |
| AT.1 | `integrations.ts` 골격, kitty 부분 구현, Option | AT.0 | AT.1 합격 |
| AT.2 | OSC 7501, `SessionTab` 이동, 배지 | AT.1 | 실제 Claude Code의 상태가 탭에 표시됨 |
| AT.3 | 알림 경로, 플러그인, 설정 | AT.2 | 백그라운드 탭만 알림. 빈도 제한 |
| AT.4 | OSC 52, 링크 | AT.1 | 전체화면 선택 복사, 로그인 URL 열기 |
| AT.5 | 이미지·드롭 업로드 | AT.1 | 서버의 Claude Code가 이미지를 인식 |
| AT.6 | 포트 조회, 임시 터널 | AT.4 | 서버 개발 서버를 PC 브라우저로 열기, 중지 |
| AT.7 | 사용 안내서, 전체 회귀, Mac 실기기 | 전체 | §8 결과 기록. 환경 부족 항목은 대기로 표시 |

AT.3, AT.4, AT.5는 서로 독립적이다. AT.1~AT.3만으로도 탭 여러 개에서 Claude Code를 돌리는 핵심 문제가 해결되므로, 일정이 부족하면 이 지점에서 중간 출시할 수 있다.

**사용 안내서에 넣을 내용:** Claude Code 최소 버전, 환경별 동작(§3.4), tmux 설정 네 줄, `preferredNotifChannel` 예시, 줄바꿈 키(Shift+Enter, Ctrl+J), 이미지 첨부 방법과 서버 저장 위치, 큰 붙여넣기는 파일로 전달할 것.

## 10. 이번 범위에서 제외

| 항목 | 판단 |
|---|---|
| 파일 경로 클릭 | 후속. AT.4 참고 |
| 모든 탭 현황판, 터미널 제목 표시 | 후속. 탭 배지로 핵심은 해결된다 |
| "Claude로 시작" 버튼, tmux 시작, `--continue` | 후속. 기존 스니펫으로 대체 가능 |
| WebGL 렌더러 | AT.0에서 성능 문제가 측정될 때만. `screenReaderMode: true`의 비용도 함께 본다 |
| 파일 읽기 미리보기, Git 브랜치·변경 수 표시, Git 스니펫, Git 색상 테마 | 후속 후보. 작은 범위로 가능 |
| Git 그래프, Git 전용 명령 UI | 제외. Git 클라이언트 영역이고 `lazygit`이나 `git log --graph`로 대체된다 |
| 로컬 모델 내장 | 제외. 리버스 터널과 환경 변수를 쓰는 연결 프리셋만 후속 후보 |
| 앱 안 AI 호출, 서버 훅 자동 설치, 화면 글자 해석, 토큰 사용량 표시, 내장 브라우저, 외부 제어 API | 제외. 제품 경계 또는 유지보수 부담 |
| OSC 9;4 진행률, OSC 99 | 제외. 필요가 확인되면 재검토 |

## 11. 참고 자료

- [Claude Code 터미널 설정](https://code.claude.com/docs/en/terminal-config.md)
- [Claude Code 전체화면 렌더링](https://code.claude.com/docs/en/fullscreen)
- [Claude Code 대화형 모드](https://code.claude.com/docs/en/interactive-mode)
- [Claude Code 일반 작업 흐름의 이미지 사용](https://code.claude.com/docs/en/common-workflows)
- [Claude Code 환경 변수](https://code.claude.com/docs/en/env-vars)
- [OSC 7501 Program Status Protocol](https://superlogical.com/rex/docs/build/program-status)
