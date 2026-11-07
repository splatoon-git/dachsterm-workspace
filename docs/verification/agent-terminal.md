# 에이전트 터미널 실측 (AT.0, DX.0)

- 실행일: 2026-11-07. 대상: 미커밋 트리의 Windows debug 앱(`target/debug/dachsterm.exe`), Docker OpenSSH 컨테이너, Claude Code **2.1.319**, tmux 3.3a.
- **범위:** 처음에는 로그인 전 화면까지 실행했고, 이후 사용자가 일회용 컨테이너에 로그인해 실제 프롬프트까지 실행했다. 아래 "로그인 후 실제 결과"가 최신이다. 이미지, 권한 승인 화면, 터미널 탭 전환, 알림 채널별 바이트는 대기다.
- 대화 내용과 인증 정보가 들어갈 수 있으므로 로그 원본은 저장소에 넣지 않고 시퀀스 종류만 기록한다. 컨테이너는 실행 후 제거했다.

## 결과

| 질문 | 결과 | 처리 |
|---|---|---|
| SSH에서 `OSC 7501 ; ?`를 보내는가 | **보낸다.** 실제 앱 SSH 탭에서 확인 | AT.2 설계대로 진행 |
| `CSI ? u` 질의를 보내는가 | **보낸다** | AT.1 설계대로 진행 |
| 응답하면 kitty 모드를 켜는가 | **켠다.** `CSI ?0u` 응답 후 `CSI >5u`와 `CSI >4;2m`을 보내고, 종료 시 `CSI <u`를 보낸다. 응답이 없으면 어느 것도 보내지 않는다 | AT.1은 대체안 불필요. 요청 플래그가 1이 아니라 5이므로 설계를 보정했다 |
| `CSI 13;2u`를 줄바꿈으로 처리하는가 | 대기(로그인 필요) | AT.1 합격 기준 |
| `preferredNotifChannel`별 실제 바이트 | 대기(로그인 필요) | AT.3 파서 확정 |
| DECRQM 2026 질의와 동기화 출력 | 로그인 화면에서는 질의하지 않았다. 이후 화면은 대기 | 대기 |
| `/tui fullscreen`의 휠, 클릭, 선택 | 대기(로그인 필요). 로그인 화면은 마우스 추적을 켜지 않는다 | 대기 |
| 포커스 해제 보고 | **나간다.** `CSI ?1004h`를 켜고, 터미널에서 사이드바로 포커스를 옮기면 `CSI O`, 돌아오면 `CSI I`가 나간다 | 터미널 탭 간 전환과 창 전환은 대기 |
| SSH에서 Ctrl+V 이미지, 로컬 Alt+V | 대기(로그인 필요) | AT.5 전제 |
| 색상 | 렌더링은 정상. 기본 라이트 테마에서 로그인 화면의 선택 항목(옅은 파랑)은 대비가 낮다. 서버 truecolor는 그대로 두는 기존 방침의 결과로 보인다 | 로그인 후 전체 화면에서 재확인 |

## 로그인 후 실제 결과

Windows debug 앱의 SSH 탭에서 로그인한 Claude Code 2.1.319를 실행했다. 이 계정은 전체화면 렌더러와 auto mode가 기본이었다.

| 확인 | 결과 |
|---|---|
| Shift+Enter | **전송 없이 줄바꿈이 된다** |
| 상태 전환 | `작업 중 → 완료`. 활성 탭이라 `완료`는 곧바로 지워지고 `연결됨`으로 돌아갔다 |
| 입력 대기 | 질문 도구에서 `state=blocked:app=claude-code:kind=question`을 보냈고, 탭에 `입력 대기 · 답변 필요`가 표시됐다. 닫으면 해제됐다 |
| `/copy` | `OSC 52 ; c ; ...`를 보냈다 |
| 시작 시 마우스 | `?1000h`, `?1002h`, `?1003h`, `?1006h`를 켠다. **그래서 일반 드래그는 앱 선택이 아니라 프로그램으로 전달된다** |
| 드래그 | 프로그램이 자체 선택 후 OSC 52를 보낸다(`sent 26 chars via OSC 52`). 측정 중 앱의 쓰기 설정을 꺼 두어 실제 복사까지는 확인하지 않았다 |
| 휠 | 프로그램으로 전달된다 |
| 렌더링 | 전체화면, 색상, 한글 없는 UI 모두 정상 |

사용자 보고: 수정 전 앱에서 드래그 복사가 동작하지 않았고, 링크 클릭은 확인창만 뜨고 이동하지 않았다. 원인은 OSC 52 미구현과 `linkHandler` 미설정이다. AT.4로 수정했다.

## tmux 실제 결과

`allow-passthrough on`, `focus-events on`, `extended-keys on`, `terminal-features 'xterm*:extkeys'`로 실행했다.

| 확인 | 결과 |
|---|---|
| 훅의 `terminalSequence`로 보낸 OSC 777 | **보이는 패널에서는 앱까지 온다.** `UserPromptSubmit`→`working`, `Stop`→`done`을 `jq` 없는 고정 JSON으로 확인했다. DX.4는 진행 가능하다 |
| 다른 tmux 창에 가려진 패널 | `allow-passthrough on`과 `all` 모두 신호가 오지 않았다. 문서의 `on` 설명과 일치한다. `all`은 이번 한 번의 결과라 더 확인이 필요하다 |
| `Notification` 훅 → `blocked` | 대기(이번 실행에서 발생하지 않음) |
| Shift+Enter | **처음에는 전송되어 버렸다.** tmux는 kitty 대신 `CSI >4;1m`을 요청하는데 앱이 처리하지 않았기 때문이다. `CSI 27;2;13~`을 보내도록 고친 뒤 **tmux 안에서도 전송 없이 줄바꿈이 된다** |

## AT.1 구현 후 실제 앱 결과

미커밋 트리를 다시 빌드한 Windows debug 앱에서 실행했다.

| 확인 | 결과 |
|---|---|
| 앱의 kitty 응답 | Claude Code의 `CSI ? u`에 앱이 `CSI ?0u`로 응답했고, Claude Code가 `CSI >5u`와 `CSI >4;2m`을 보냈다 |
| Claude Code 실행 중 Shift+Enter | 앱이 `CSI 13;2u`를 보냈다. **줄바꿈으로 처리되는지는 로그인 후 대기다** |
| 프로그램이 요청하지 않을 때 Shift+Enter | `\r` 그대로 |
| 요청한 뒤 Shift+Enter, Alt+Enter | `CSI 13;2u`, `CSI 13;3u` |
| 요청한 뒤 Ctrl+Shift+Enter(앱 단축키) | 프로그램으로 전달되지 않음 |
| 프로그램이 해제한 뒤 Shift+Enter | `\r` 그대로 |

대기: 물리 한글 IME 중 Enter, tmux의 `extended-keys`, 실제 Vim, macOS Option(`macOptionAsMeta`, M.8). macOS 코드는 추가했으나 실기기 실행은 없다.

## AT.2 구현 후 실제 앱 결과

미커밋 트리를 다시 빌드한 Windows debug 앱에서 SSH 탭으로 `printf`로 시퀀스를 재현했다. 파서와 앱 동작 검증이며, **실제 Claude Code의 상태 전환 결과가 아니다**(로그인 후 대기).

| 확인 | 결과 |
|---|---|
| Claude Code의 `OSC 7501 ; ?`에 응답 | 앱이 `OSC 7501 ; ? ST`로 응답했다. 로그인 화면에서는 상태 보고가 없었다 |
| `blocked`, `kind=permission`, 한글 `msg` | 탭에 `입력 대기`, 접근성 이름에 `입력 대기 · 승인 필요 · 배포 승인이 필요합니다` |
| 셸 프롬프트 복귀 | `입력 대기`가 지워지고 `연결됨`으로 돌아왔다 |
| `working` | 탭에 `작업 중` |
| 다른 탭을 보는 동안 `done` | 해당 탭에 `완료`. 탭을 열면 `연결됨`으로 돌아왔다 |

대기: 실제 Claude Code의 작업 중·입력 대기·완료 전환, 독립 창 표시와 재생, macOS 실기기.

## AT.3 알림 채널 실측

로그인한 Claude Code 2.1.319에 `preferredNotifChannel`을 바꿔 가며 질문 도구로 입력 대기를 만들었다. 어느 채널이든 `OSC 7501 state=blocked`가 함께 온다. 그래서 **앱은 서버 설정 없이 상태 전환만으로 알림을 띄울 수 있다.**

| 채널 | 실제 신호 | 처리 |
|---|---|---|
| `terminal_bell` | 단독 BEL | 벨 알림 |
| `iterm2` | `OSC 9 ; 메시지` | 알림 |
| `ghostty` | `OSC 777 ; notify ; 제목 ; 본문` | 알림 |
| `kitty` | `OSC 99` 3건 | 설계대로 처리하지 않음. 상태 전환으로 대체된다 |
| `notifications_disabled` | 없음 | 상태 전환만 |

실제 앱에서 `notification_show`는 `ok`를 반환했고, 사용자가 Windows 알림이 뜬 것 같다고 확인했다. 대기: 작업 전환으로 생기는 실제 Claude Code의 알림 흐름, 알림 클릭 동작, macOS 알림 권한.

## 회귀

미커밋 트리, Windows 로컬 결과(이 PC에 새로 설치한 Rust 1.99.1, VS 2022 Build Tools, cargo-audit 0.22.2). CI는 아직 실행하지 않았다.

| 명령 | 결과 |
|---|---|
| `npm run format:check`, `npm run lint`, `npm run typecheck` | 통과 |
| `npm test` | 337건 통과 |
| `npx playwright test` | 99건 통과(AT.3 포함 트리. 이후 변경은 Rust 포커스 검사 제거와 테스트뿐이다) |
| `cargo fmt`, `cargo clippy -D warnings`, `cargo test --workspace --locked` | 통과, 앱 70건 + 실증 1건 |
| `npm audit`, `node scripts/audit-windows.mjs` | 0건, Windows 그래프 0건(대상 외 5건은 보고서에 보존) |
| `node scripts/generate-notices.mjs --fetch-missing` | 432개, 검토 필요 0건 |
| `npm run test:native` | 종료 0. 탭 상태, Shift+Enter, OSC 52, OS 알림 검사를 추가했다 |
| `node scripts/test-maintenance-native.mjs` | 종료 0 |
| `node scripts/run-ftp.mjs --native` | **실패.** FTP 엔진 검사와 FTP 탭은 통과하고 FTPS 탭의 `mkdir open`에서 시간 초과. **변경 전 `a01efa6`을 별도 폴더에 빌드해도 같은 지점에서 실패**해 이번 변경의 결과가 아니다. 원인은 미확인 |

중간 실패와 처리:

- 네이티브의 설정 비교가 새 설정을 몰라 실패: 기대값을 고쳤다.
- 복사가 "앱 창이 활성화"로 거부됨: Rust의 창 포커스 검사가 자동화 창을 막았다. 사용자 복사에는 불필요하고 OSC 52는 프런트엔드에서 포커스된 패널로 제한하므로 제거했다.
- 알림 검사가 `invoke`를 가로채지 못함: 판단 로직을 `terminalNotify.test.ts`로 옮기고, 네이티브는 실제 호출이 오류 없이 끝나는지만 본다. 실행마다 OS 알림이 한 번 표시된다.

## AT.5, AT.6, DX.3, DX.4 구현 후 결과

- 실행일: 2026-11-07. 대상: 이 기록을 포함한 커밋의 소스, Windows debug 앱, Docker OpenSSH(Debian tmux 3.3a). CI와 Mac은 실행하지 않았다.
- 재현: `node scripts/run-phase1.mjs --native --reuse-build --agent-only`. 검사는 `scripts/verify-agent-terminal.mjs`이고 `test:native`에 연결했다. 서버 포트 단계에서 기본 브라우저 탭이 하나 열린다.

### 전체 게이트(`verify-windows.ps1 -Native`)

**종료 코드 1이다.** `run-ftp --native` 앞의 항목은 모두 통과했다.

| 항목 | 결과 |
|---|---|
| typecheck, eslint, prettier, build | 통과 |
| Vitest | 372/372 |
| Playwright | 99/99 |
| `cargo fmt`, `clippy -D warnings` | 통과 |
| `cargo test --workspace --locked` | dachsterm 85, ssh-probe 1 |
| `npm audit`, `audit-windows`, 고지 생성 | 취약점 0, 구성요소 446개 |
| `probe:phase1`, `test:native`, `test-maintenance-native` | 통과 |
| `run-ftp --native` | **실패.** FTP 탭은 통과, FTPS 탭 `enter directory`. 코드 변경 없이 재실행해도 같고, 모두 3회 재현됐다 |

표는 `SessionTab`과 훅 예시 수정 후의 마지막 실행 결과다.

### 실제 앱에서 확인한 것

| 작업 | 결과 |
|---|---|
| 파일 드롭 | 확인창의 이름·서버·위치, 취소 시 업로드 없음, 경로 입력 후 Enter 없음. 파일 0600, 폴더 0700. 드롭 이벤트는 `tauri://drag-drop`을 직접 보냈고 **실제 OS 드래그는 수동 확인 대기** |
| 정리 규칙 | 7일 지난 규칙 일치 파일만 삭제. 규칙이 다른 파일과 같은 이름의 폴더는 유지 |
| 거부 | 폴더 드롭, 첨부 폴더 자리의 심볼릭 링크 |
| 클립보드 이미지 | PNG 업로드, "이 연결에서는 다시 묻지 않음"이 연결 안에서 유지. 이미지는 웹 클립보드 API로 넣었다 |
| 로컬 탭 | 명령 프롬프트에 인용된 경로 입력, 네트워크 경로 거부. WSL 변환은 단위 테스트만 |
| 서버 포트 | 목록, 1024 미만 숨김, 실제 터널 연결, 중지, 설정에 저장되지 않음 |
| 서버 링크 | Ctrl+클릭은 터널 없이 확인창만 연다. 이 경로의 브라우저 열기는 실행하지 않았다 |
| tmux 시작 | PTY + exec으로 시작, 한글 유지, 폴더 조회, 패널에 훅 입력 없음 |
| tmux 재접속 | 끊긴 동안 서버 작업 계속, 같은 셸로 복귀, 세션 수 1개 유지, 크기 동기화 |
| 훅 상태 | `working`, `blocked`, `done`이 탭에 표시. 허용 외 단어 무시. 다른 탭을 보는 동안의 `done`은 표시되고 돌아오면 지워짐 |
| 숨은 tmux 창 | `allow-passthrough on`에서 신호가 오지 않는다. 안내서에 제한으로 적었다 |
| 탭 닫기, tmux 없음 | 첫 닫기에만 안내, 서버 세션 유지. tmux가 없으면 일반 셸과 안내 |

위 훅 상태 검사는 CLI 에이전트 대신 셸에서 패스스루 시퀀스를 보낸 것이다. 실제 훅은 아래에서 확인했다.

### 로그인한 실제 CLI 에이전트 결과

사용자가 일회용 컨테이너에 로그인한 Claude Code 2.1.319, Windows debug 앱, tmux 3.3a로 실행했다. 훅은 앱 안내의 예시 그대로다. 앱은 CDP로 조작했으며 사용자의 세션과 분리한 tmux 세션에서 실행했다.

| 확인 | 결과 |
|---|---|
| 클립보드 이미지·파일 드롭(사용자 조작, 직접 접속) | 서버에 저장됐고, 대화 기록에 이미지 블록 2개가 있다. 내용을 읽지 않고 개수만 셌다. 파일 드롭은 사용자의 실제 OS 드래그다 |
| 클립보드 이미지(tmux 안, `mouse on`) | **합격.** `DACHS 7294`를 그린 이미지를 Ctrl+Shift+V로 올리자 프롬프트에 `[Image #1]`이 입력됐고, 에이전트가 `DACHS 7294`로 답했다 |
| 우클릭(tmux `mouse on`) | 앱이 붙여넣지 않는다. 마우스를 프로그램이 쓰는 경우의 기존 규칙대로다. 안내서에 적었다. Shift+우클릭으로 이미지를 올리는 경로는 실행하지 않았다 |
| 승인 요청 | `작업 중 → 입력 대기 → 작업 중`. 승인 후 파일이 실제로 바뀌었다 |
| 다른 탭을 보는 동안 끝남 | 탭에 `완료`, 탭을 열면 `연결됨` |
| 질문 도구 | `작업 중 → 입력 대기`, 답한 뒤 `완료`. 보고 있는 탭에서 `완료`가 유지된다 |
| 완료 70초 뒤 | `완료` 유지. 수정 전에는 약 60초 뒤 `입력 대기`로 바뀌었다 |
| 재접속 | 끊긴 동안 `attached=0`, 같은 PID의 프로그램이 유지되고 화면이 복귀한다 |
| `StopFailure`, `Notification`의 `permission_prompt` | 발생시키지 않았다. 미확인 |

실제 실행에서 찾아 고친 문제:

- **활성 탭의 `완료`가 곧바로 사라짐:** 사용자 보고. `SessionTab`이 상태가 바뀔 때마다 확인 처리를 했다. 탭을 열 때만 처리하도록 고쳤다. 단위 테스트 `SessionTab.test.tsx`가 수정 전에 실패함을 확인했다.
- **완료 약 60초 뒤 `입력 대기`로 바뀜:** 훅 예시가 `Notification`의 `idle_prompt`까지 받았다. 실제 대기를 뜻하는 종류로 제한했다.
- 같은 tmux 이름을 쓰는 탭 두 개에서는 입력과 상태가 함께 나타난다. 안내서에 적은 동작대로다.

### 대기와 미실행

- **미확인:** `StopFailure`와 `Notification`의 실제 발생.
- **Mac 실기기:** M.13. Windows 결과로 대체하지 않는다.
- **`exec` 거부 서버의 오류 표시:** 재현 환경이 없어 미검증이다.
- **`test-local-native`, `test-assistant-native`:** 이 PC에서 실패한다. 둘 다 첫 단계에서 `PS C:` 프롬프트를 기다리는데 PowerShell 프롬프트 테마가 다르게 표시한다. 제품 동작 검사 전에 멈추므로 결과로 삼지 않는다. `test-workspace-native`는 통과했다.
- **PodTree:** `session.ts`의 명령 이름 공용화(`podtree_*`)를 실제 클러스터로 실행하지 않았다. 코드상 이름은 그대로다.

## DX.1 나머지, DX.5, DX.9 구현 후 결과

- 실행일: 2026-11-07. 대상: `eb2a16b` 위의 미커밋 트리. 실제 앱은 모든 제품 코드 변경 뒤 `npm run tauri -- build --debug --no-bundle`로 만든 `target/debug/dachsterm.exe`다. 이후 바뀐 것은 테스트와 검사 스크립트뿐이다.
- 픽스처 이미지(`tests/openssh/Dockerfile`)에 `git`(Debian bookworm 2.39)을 더해 다시 빌드했다.

| 범위 | 명령 | 결과 |
|---|---|---|
| Rust 단위 | `cargo test -p dachsterm --lib --locked -- git_status remote_exec monitoring` | 통과. `git_status` 7건(porcelain v2 헤더·모든 항목 종류·이름 변경 원본 건너뛰기·5,000개 상한·폴더 검증과 인용·실패 단계는 `notRepo`·오류 첫 줄 정리), `remote_exec` 2건, `monitoring` 2건 |
| Rust 정적 | `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings` | 통과 |
| 실제 OpenSSH | `npm run probe:phase1` | 종료 0. 기존 PASS 전부와 새 `PASS product Git status: repository read, fsmonitor not run, non-repository quiet`. `remote_exec`로 옮긴 모니터링도 `PASS product Linux metrics independent exec, initial sample, CPU/NET delta, memory and disk` |
| 셸 훅(실제 셸, Docker pty) | `script -q -c "<셸> -i"`에 훅 한 줄을 넣고 `false`, 빈 줄, `true`, `(exit 3)`, `sleep 0`, 훅 재입력 후 명령 실행 | Bash 5.2.15, Zsh 5.9: 명령마다 `C … D;<코드> A`, 빈 줄은 `C` 없이 `D;1 A`(앱이 버림), 코드 1·3 정확, 두 번 넣어도 `C` 하나. Bash 3.2.57(`bash:3.2` + util-linux): `D;<코드> A`만 나오고 `C`는 없음(앱의 Enter 방식) |
| Vitest | `npx vitest run` | 543건 중 542 통과, 1건 실패: 기본 명령 개수(26)를 세는 `snippets.test.ts`가 Git 7개 추가로 33을 받음. 테스트를 Git 분류 제외 26, Git 7로 고친 뒤 `npx vitest run src/features/terminal/snippets.test.ts` 4/4. 전체 재실행은 하지 않았다 |
| Vitest(새·변경) | `commandMarks`, `gitStatus`, `shellHook`, `commandItems`, `preferences` | 11, 10, 5, 6, 7건 통과 |
| Playwright | `npx playwright test` | 142/142. 새 검사: 명령 창 기본 명령에 Git 분류와 검색 |
| typecheck·lint·format | `npm run typecheck`, `npm run lint`, `npm run format:check` | 통과 |
| 실제 앱(WebView2) | `node scripts/run-phase1.mjs --native --reuse-build --agent-only` | 종료 0. 아래 네 줄이 새로 추가된 단계(`scripts/verify-developer-workflow.mjs`) |

실제 앱에서 확인한 것:

- `PASS native failed commands marked with their code, empty line and success not`: `false` 뒤 막대 1개(툴팁 `종료 코드 1`), 빈 Enter·`true` 뒤 그대로, `(exit 3)` 뒤 2개.
- `PASS native Ctrl+Shift+Up/Down moves between prompts`: `seq 1 200` 출력 아래에서 위로 이동하면 그 명령의 프롬프트가 보이고 아래로 이동하면 끝으로 간다.
- `PASS native Git status bar, tab name and tooltip, tree marks, fsmonitor not run`: 저장소로 `cd`하면 상태바 `main ●3`, 접근성 이름 `Git main, 변경 3개. 새로 고침`, 툴팁 `업스트림 없음`·`수정 2 · 추적 안 함 1`, 탭 접근성 이름과 툴팁. 셸에서 `git add` 뒤 5초가 지나 다음 프롬프트에서 툴팁이 `수정 2 · 추가 1`로 바뀜. 파일 트리 `a.txt` M, `new.txt` A, `src` 폴더 표시. 저장소에 설정한 `core.fsmonitor` 프로그램은 앱 조회 동안 실행되지 않음(사용자가 셸에서 실행한 `git add`는 실행하므로 그 흔적은 지우고 다음 앱 조회 뒤 다시 확인).
- `PASS native Git status stays hidden outside a repository and without Git`: `/tmp`에서 표시 없음, 서버의 `git`을 숨기고 저장소로 들어가도 표시와 오류 문구 없음.
- 첫 실행은 위 fsmonitor 단계에서 실패했다. 검사가 셸에서 실행한 `git add`가 fsmonitor를 실행한 것을 앱의 실행으로 잘못 판정한 검사 결함이어서 순서를 고쳐 다시 실행했다.

대기와 미실행:

- **긴 명령 OS 알림:** 실제 토스트는 확인하지 않았다. 판정(시간, 재생 중, 설정 0)은 단위 테스트, 알림 경로는 AT.3과 같다.
- **Bash 3.2 Enter 방식:** 단위 테스트와 셸 단독 확인뿐이다. 실제 앱에서 Bash 3.2 서버에 접속한 확인은 없다(macOS 원격·로컬 셸은 M 항목).
- **자동 조회 끔, 시간 초과로 멈춤, 수동 조회 오류 표시:** 단위 테스트뿐이다.
- **전체 게이트** `verify-windows.ps1 -Native`, 푸시 후 CI, Mac 실기기는 실행하지 않았다.

## tmux (DX.0)

`script ... -c "tmux new-session -s at0 'claude'"`로 확인했다.

- tmux 바깥으로 `OSC 7501`과 `CSI ? u`가 **나오지 않는다.** 문서 내용과 일치한다.
- tmux 자체가 `CSI >c`, `CSI >q`, `CSI ?7727h`, 마우스 해제 시퀀스를 보내고, xterm이 `CSI >0;276;0c`로 응답한다.
- `terminalSequence` 훅이 tmux를 통과하는지(DX.4)는 대기(로그인 필요).

## 재현

- 실제 앱: 앱에서 SSH 세션에 접속해 `script -q -f --log-out /tmp/at-out.log --log-in /tmp/at-in.log -c claude`를 실행하고 로그의 시퀀스 종류를 집계했다.
- 응답 동작: 컨테이너 안에서 PTY 래퍼로 `CSI c`, `CSI ? u`, `OSC 7501 ; ?`에 응답하며 Claude Code를 실행했다. 이 항목은 앱이 아직 응답을 구현하지 않아 앱 밖에서 확인했다. AT.1 구현 후 앱으로 다시 확인한다.
