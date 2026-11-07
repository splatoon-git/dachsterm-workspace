# 터미널 작업 공간 재설계(TW) 검증 기록

설계는 [terminal-workspace](../design/terminal-workspace.md), 상태는 [progress](../progress.md)가 정본이다. 모든 결과는 이 PC(Windows 11)에서 `feat/terminal-workspace` worktree로 실행했다. Mac 실기기 결과는 없다.

## 게이트

| 대상 | 명령 | 결과 |
|---|---|---|
| 변경 전 `55cc424` | `scripts/verify-windows.ps1` | 종료 0 |
| TW.1 미커밋 트리 | `scripts/verify-windows.ps1` | 종료 0. Vitest 455, Playwright 99, Rust 85+1 |
| TW.2 미커밋 트리 | `scripts/verify-windows.ps1` | 종료 0. Vitest 460, Playwright 115, Rust 85+1 |
| TW.1~TW.3 묶음 `5737fb6` | `scripts/verify-windows.ps1` | 실패. `workspace-drag.spec.ts`의 탭 바 재생성 경합으로 1건 실패해 테스트를 고쳤다(`e331f13`) |
| 같은 묶음 `e331f13` | `scripts/verify-windows.ps1` | 1회차 실패: `snack.spec.ts:93`의 픽스처가 5초 안에 그려지지 않았다. 단독 3회 반복은 18/18 통과했고, 의존하는 변경은 `styles.css`에서 지운 탭·그리드 규칙뿐이다. 2회차 종료 0. Vitest 460, Playwright 139, Rust 85+1 |

게이트의 `generate-notices.mjs`는 `licenses/THIRD_PARTY_NOTICES.txt`를 내용 차이 없이 CRLF로 다시 쓴다. 매번 복원했고 커밋하지 않았다.

## TW.2 네이티브 (실제 앱, WebView2)

| 항목 | 명령 | 결과 |
|---|---|---|
| 실제 OpenSSH 전체 회귀, 2×2 칸별 입력, 칸별 `stty size`와 그려진 행·열 일치, 분할선 드래그 뒤 양옆 두 칸만 열 수 변경, 배치 변경 뒤 같은 연결·같은 xterm 인스턴스 | `npm run test:native` | 종료 0 |
| 로컬 PTY 전체·일부·비대상 입력, 전체화면, 확대, 인스턴스 유지, `Ctrl+Alt+방향키`, 분할선 키보드, 앱 재시작 후 모양과 비율 복원, 빈 칸 채우기 | `node scripts/test-workspace-native.mjs` | 종료 0 |
| 로컬·WSL 분할, 닫기·재접속 | `node scripts/test-local-native.mjs` | 종료 0 |
| FTP 탭의 작은 칸 표시 | `node scripts/run-ftp.mjs --native-only`의 FTP 단계 | 통과. 스크린샷은 `test-results-native/ftp-small-group.png`로 남고 저장소에는 넣지 않는다 |
| FTPS 탭 | 같은 명령의 FTPS 단계 | **실패(기존)**, 아래 참조 |

## TW.3

TW.3부터는 사용자 결정에 따라 작업 ID마다 typecheck, lint, 바꾼 부분의 테스트만 실행하고, 전체 게이트는 TW.1~TW.3 묶음 끝에 한 번 실행한다.

| 항목 | 명령 | 결과 |
|---|---|---|
| 형식·타입·린트 | `npx prettier --check src scripts tests`, `npm run typecheck`, `npm run lint` | 통과 |
| 단위 | `npx vitest run src/app src/features/terminal/fitThrottle.test.ts` | 96/96 |
| 5개 영역(탭 바·상하좌우 가장자리·가운데), 탭 순서, Esc 취소, 5px 임계값, 닫기 버튼·우클릭 제외, 자기 칸 금지, 최소 크기, 창 밖 분리, 작업 영역 밖 취소, 좁은 창, 확대 중 드래그, 셀 재마운트 없음 | `npx playwright test tests/ui/workspace-drag.spec.ts` 외 바꾼 영역 5개 파일 | 54/54 |
| 실제 OpenSSH 탭을 다른 칸에 합치고 가장자리로 나눈 뒤 칸별 `stty size` 일치, 같은 연결·xterm 인스턴스 유지, 창 밖으로 끌어 새 창 분리 | `node scripts/run-phase1.mjs --native --skip-app-build` (현재 소스로 빌드한 앱) | 종료 0 |

창 밖 분리는 CDP가 창 밖 좌표로 보낸 마우스 이벤트로 확인했다. 실제 OS에서 창 밖으로 끄는 동작은 확인하지 않았다.

### TW.3에서 찾아 고친 결함

숨겨진 터미널의 크기가 바뀐 뒤 다시 보이면, 뷰포트가 옛 위치에 남아 새 출력이 보이는 행 아래로 쌓였다. xterm은 숨겨진 동안 렌더러 크기 갱신을 미루고 `IntersectionObserver`가 다시 켤 때 반영하는데, 그 전에 `fit`이 실행되면 스크롤 범위가 옛 높이로 고정된다. 탭을 칸 사이로 옮기면 바로 생기고, 이전 구조에서도 숨긴 탭이 있는 채로 창 크기를 바꾸면 생길 수 있었다. `fit`을 렌더러가 다시 켜진 뒤로 미뤄 고쳤다(`fitThrottle.ts`의 `afterRendererResumes`). 재현 테스트는 `tests/ui/terminal-visibility.spec.ts`이다.

## TW.4

작업 ID 단위 규칙에 따라 typecheck, lint, 바꾼 부분의 테스트만 실행했다. 대상은 `5bf3643` 위의 미커밋 TW.4 트리이며, 실제 앱은 이 트리로 만든 `target/debug/dachsterm.exe`다.

| 항목 | 명령 | 결과 |
|---|---|---|
| 형식·타입·린트 | `npm run format:check`, `npm run typecheck`, `npm run lint` | 통과 |
| 단위 | `npx vitest run src/app src/components src/features/terminal src/features/sftp src/features/sessions src/features/monitoring src/lib` | 24파일 263/263 |
| UI(게임 제외 15개 스펙) | `npx playwright test <게임 외 스펙>` | 94/94 |
| 실제 OpenSSH 전체 회귀: 터미널 안 우클릭 붙여넣기, 탭 메뉴의 연결 종료·검색·분리, 앱 설정의 터미널 설정, 연결 카드 우클릭 수정·복제·삭제, 상태바 모니터 상세, 2×2 칸별 `stty size`와 탭 드래그 | `node scripts/run-phase1.mjs --native --skip-app-build` | 종료 0, PASS 74줄 |
| FTP·FTPS 탭: 상태바 보안 표시, 터미널 항목 없는 탭 메뉴, 오른쪽 가장자리로 끌어 분할·가운데로 합치기·아래 분할(같은 연결 ID 유지), 분할 안 업로드, 창 밖으로 끌면 취소, 탭 메뉴 연결 종료 → 안내 카드 재접속 → 업로드 | `node scripts/run-ftp.mjs --native-only --reuse-build` | 종료 0 |
| 전체화면 중 상태바 표시, 보기 메뉴 전체화면, 칸 이동·재시작 복원 | `node scripts/test-workspace-native.mjs` | 종료 0 |
| 로컬 탭 메뉴(분리 항목 없음), 도구 줄 버튼 0개, 터미널 설정, `Ctrl+Shift+O` 세션 검색, `Ctrl+Shift+F` 터미널 검색 | `node scripts/test-local-native.mjs` | 종료 0 |

FTP 단계는 Python FTP 픽스처를 원래 작업 폴더의 `.tools/ftp-fixture`로 실행했다(`DACHSTERM_FTP_PYTHON`).

### TW.4에서 찾아 고친 결함

- **FTP 두 번째 탭 시간 초과(아래 "알려진 실패"의 원인):** 검사의 `.pane-cell:not([hidden]) .ftp-pane` 선택자가 새 탭이 열리기 전까지 앞 탭의 창을 가리켜, 모든 확인이 앞 탭에서 통과한 뒤 숨겨진 버튼을 누르려다 멈췄다. 제품 결함이 아니라 검사 경합이다. 파일 탭에 이름(`<이름> 파일`)을 붙이고 검사가 이름으로 찾게 했다.
- **상태바 넘침:** 입력 범위 선택 상자가 24px 상태바보다 높아 창 전체에 세로 스크롤이 생겼고, 이 상태에서 2×2 탭 드래그 검사가 가장자리 대신 가운데로 합쳐졌다. 상태바 안 조작 요소 높이를 20px로 맞춘 뒤 재현되지 않았다.
- **FTP 탭이 입력 범위 후보로 세어짐:** FTP 탭 두 개만 보여도 입력 범위 선택이 나타났다. 터미널이 있는 탭만 센다. FTP 검사에 확인을 넣었다.
- **로컬 검사의 크기 변경 경합:** 창을 줄인 직후 명령을 입력해, 간격을 두고 실행되는 `fit`보다 셸이 먼저 크기를 읽었다. 터미널이 줄어든 것을 확인한 뒤 입력하게 고쳤다.

### TW.4 미실행·미검증

- 실행하지 않은 네이티브 검사: `test-assistant-native`, `test-phase63-67-native`, `test-jump-native`, `test-session-transfer-native`, `test-transfer-queue-native`. 선택자는 새 UI에 맞게 고쳤다.
- 우클릭과 드래그는 CDP가 보낸 마우스 이벤트로 확인했다. 실제 마우스, `Shift+F10`과 메뉴 키로 탭 메뉴 열기는 실제 앱에서 확인하지 않았다.
- Mac 실기기 전체: 두 손가락 클릭과 Control+클릭의 `contextmenu`, 상태바 팝오버, WKWebView 포인터 캡처.

## TW.8

대상은 `4818754` 위의 미커밋 TW.8 트리이며, 실제 앱은 이 트리로 만든 `target/debug/dachsterm.exe`다.

| 항목 | 명령 | 결과 |
|---|---|---|
| 형식·타입·린트 | `npm run format:check`, `npm run typecheck`, `npm run lint` | 통과 |
| 단위 | `npx vitest run src/app src/components src/features/terminal src/features/sftp src/features/sessions src/features/monitoring src/lib` | 24파일 263/263 |
| UI(바꾼 영역) | `npx playwright test` workspace, navigation, layout, session-form, themes, terminal-font, workspace-drag, workspace-grid | 통과(수정 뒤 재실행 포함). 게임 스펙은 선택자만 고쳤고 실행하지 않았다 |
| Rust | `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test -p dachsterm --lib --locked windows` | 통과. 플랫폼 창 설정 일치 테스트 포함 3건 |
| 실제 OpenSSH 전체 회귀, 독립 창의 제목 줄(시스템 틀 없음, 최대화·복원, 그린 닫기 버튼으로 닫기) | `node scripts/run-phase1.mjs --native --skip-app-build` | 종료 0 |
| 주 창: 시스템 틀 없음, 36px 제목 줄, 최대화·복원 버튼, 빈 곳 더블클릭 최대화·복원, 닫기 버튼으로 정상 종료, 최소화 | `node scripts/test-workspace-native.mjs` | 종료 0 |
| 로컬 탭, ＋ 메뉴, 세로 아이콘 줄 | `node scripts/test-local-native.mjs` | 종료 0 |
| FTP·FTPS 탭 | `node scripts/run-ftp.mjs --native-only --reuse-build` | 종료 0 |

실제 OS 입력(사용자 마우스·키보드 이벤트, 임시 데이터 폴더의 별도 인스턴스)으로 확인한 것: 제목 줄 빈 곳과 앱 이름을 끌어 창 이동, 오른쪽·아래 가장자리를 끌어 크기 조절, 빈 곳 더블클릭 최대화·복원, `Win+←` 왼쪽 절반 스냅, `Win+↑`·`Win+↓` 크기 변경. 이 확인은 저장소에 넣지 않은 일회성 스크립트로 했다.

### TW.8에서 찾아 고친 것

- **사이드바 240px에서 파일 도구 줄이 두 줄로 넘침:** 파일 패널을 컨테이너로 두고 너비 300px 이하에서 버튼을 23px로 줄여 한 줄을 유지한다.
- **검사의 보기 전환:** 열린 보기의 아이콘을 다시 누르면 접히므로, 검사는 그 보기가 이미 열려 있으면 누르지 않는다(`showSidebarView`).
- **아이콘 줄을 누르면 다음 프레임에 포커스를 다시 옮김:** 첫 CI(`08b5cfd`)의 `dachs-games.spec` 560·360px에서 게임 중 키 입력을 아이콘이 가져갔다. 누르는 것만으로 포커스가 아이콘에 있으므로 보기만 바꾼다. 해당 테스트를 로컬에서 다시 실행해 통과했다.
- **`terminal-visibility.spec`의 경합(TW.3 테스트):** 첫 맞춤 전의 기본 24행을 기준으로 잡아, macOS 글꼴에서 400px도 24행이 되면 실패했다(macOS CI 2회). 첫 맞춤 뒤 크기를 기준으로 잡게 고쳤다. `workspace-drag.spec`의 탭 바 재생성 경합(TW.3 테스트)도 macOS CI에서 두 번 다른 모양으로 실패해, 탭이 멈춘 뒤 위치를 읽게 고쳤다.
- `taskkill`은 최소화된 창을 닫지 못한다. 앱 문제는 아니다: 작업 표시줄의 닫기(`SC_CLOSE`)는 최소화 상태에서도 바로 종료된다. 검사는 창 API로 닫는다.

### TW.8 미검증

- Windows 11 최대화 버튼 호버 스냅 레이아웃(직접 그린 버튼이라 나오지 않을 것으로 예상, 설계에서 수용), `Win+Z`, 창 끌기로 화면 가장자리 스냅, 다중 모니터·DPI 변경.
- 서바이버 정산 중 닫기 버튼 가드: 닫기 버튼은 시스템 닫기와 같은 `close()` 요청을 거치며 가드 코드는 바꾸지 않았다. 게임 검사는 실행하지 않았다.
- 전체화면 진입·복귀 뒤 제목 줄과 세로 아이콘 줄 표시는 Playwright로만 확인했다.
- Mac 실기기 전체(macos-readiness M.14): 신호등 겹침, 패키지 앱, 독립 창.

## TW.5~TW.7

작업 ID마다 typecheck, lint, 새로 만들거나 고친 테스트만 실행하고 커밋했다. 전체 게이트(`verify-windows.ps1`), 전체 Vitest·Playwright, 게임 테스트는 실행하지 않았다. Rust와 Tauri 설정은 바꾸지 않아 cargo 검사도 하지 않았다.

| ID·커밋 | 명령 | 결과 |
|---|---|---|
| TW.5 `f812b3d` | `npm run typecheck`, `npm run lint`, `npx vitest run` `inputScopeModel`·`poller`·`useInputScope`·`logStatus` 테스트 | 통과. 4파일 17/17 |
| TW.6 `c3bdfd2` | typecheck, lint, `npx vitest run` `shellHook`·`preferences`·`directoryHook` 테스트, `npx playwright test tests/ui/assistant.spec.ts` | 통과. 3파일 21/21, Playwright 6/6 |
| TW.7 `17af4de` | typecheck, lint, `npx vitest run src/app/appShortcuts.test.ts`, `npx playwright test tests/ui/navigation.spec.ts tests/ui/terminal-font.spec.ts` | 통과. 3/3, Playwright 7/7 |

### 셸 훅 (실제 셸, Docker 안의 pty)

`script -q -c "<셸> -i"`로 pty를 만들고 생성한 훅 한 줄(`shellHook({ guide: true })`)을 넣은 뒤 명령을 실행해 출력의 OSC 시퀀스를 확인했다. 앱을 거치지 않은 셸 단독 확인이다.

| 셸 | 이미지 | 결과 |
|---|---|---|
| Bash 5.2.15 | `dachsterm-openssh-probe` | `$?` 유지(`false` 뒤 1), 미리 만든 `alias vi`는 그대로 동작하고 래퍼가 붙지 않음, `tail` 진입·종료 알림, 파이프의 `less`는 알림 없음 |
| Bash 3.2.57 | `bash:3.2` | 위와 같음. 훅을 두 번 넣어도 `PROMPT_COMMAND`가 `__dachsterm_cwd` 하나 |
| Zsh 5.9 | `bash:3.2` + `zsh` | `tail` 진입·종료, `command tail`과 파이프의 `less`는 알림 없음, 두 번 넣어도 `preexec`·`precmd` 함수 하나 |

조작표를 끈 훅의 Bash 부분은 추가한 종료 함수를 빼면 이전 경로 알림 훅과 글자 단위로 같다(스크립트로 비교). 처음 Zsh 확인에서 파이프 줄도 알림이 나와 Bash와 맞게 고쳤고, 고친 줄의 JS 이스케이프 실수로 모든 줄이 건너뛰어지는 것을 같은 확인에서 잡아 고쳤다.

### 실제 앱 (WebView2)

실행 파일은 `17af4de`에서 `npm run tauri -- build --debug --no-bundle`로 한 번 만들었다(sha256 `d0cd75b2a2836b55878808b28c0529a6d81a7e56dee21c137c7e82c549e0598a`). 이후 바뀐 것은 검사 스크립트뿐이다(`a53d7b7`). 픽스처 이미지는 `zsh`를 넣어 다시 빌드했다.

| 항목 | 명령 | 결과 |
|---|---|---|
| TW.5 로컬: 2×2에서 전체(3개 창), 여러 줄 붙여넣기 확인창의 `동시 입력 중 · 3개 창`, 상태바 경고색과 대상 테두리 3개, 대상 변경 → 탭 바 체크 해제로 2개 창, 비대상 창 격리, 확대 시 해제와 상태바 이유, `하나로`에서 입력 범위 숨김, `Ctrl+Shift+M` 두 번(선택 열기 → 개별, 전달 없음), 대상 연결 종료 시 해제와 이유 | `node scripts/test-workspace-native.mjs` | 종료 0 |
| TW.5 SSH: 2×2에서 선택 모드로 SSH 두 창 체크 → 두 셸만 받음, 세 번째 창 격리, 연결 종료 시 해제, 재접속 뒤 자동 포함 없음, SSH·로컬 혼합 양방향, 로컬 탭 닫기 시 해제. 터미널 설정 저장값 비교(`verify-terminal-basics.mjs`) 포함 | `node scripts/run-phase1.mjs --native --reuse-build` | 종료 0, PASS 42줄 |
| TW.5 SSH 전체·붙여넣기: SSH와 PowerShell 좌우, 전체 → 여러 줄 붙여넣기 확인창 `2개 창` → 두 창 모두 실행, 중지 뒤 SSH 입력이 PowerShell에 가지 않음 | `node scripts/test-assistant-native.mjs` | 종료 0 (아래 같은 실행) |
| TW.6 Bash: 별도 연결 작업 없이 vim·less·tail 진입·종료 자동 표시(tail은 Ctrl+C), `.bashrc`의 `alias vi`와 `command vim`은 일반 안내, cat은 표시 없음, `cd /tmp`가 파일 패널 경로에 반영, 수동 고정 유지와 탭 사이 섞임 없음 | 같은 명령 | 종료 0 |
| TW.6 Zsh: 로그인 셸을 Zsh로 바꾼 새 SSH 탭에서 `cd /var` 반영, vim·less·tail 자동 표시, `command vim` 일반 안내 | 같은 명령 | 종료 0 |
| TW.6 미지원 환경: 실행 알림이 없는 WSL(`Ubuntu-24.04`)에서 `less`가 일반 안내 | 같은 명령 | 종료 0. 이 실행 전체 9개 확인, 페이지 오류 0 |
| TW.7 `Ctrl+Shift+\`로 같은 PowerShell을 오른쪽에 분할(칸 2개, 오른쪽 배치), 조작표 자동 표시·경로 따라가기를 끄고 앱 종료 → 재시작 후 꺼진 값 유지, 건드리지 않은 값 유지 | `node scripts/test-local-native.mjs` | 1회차 실패(검사 선택자가 숨은 WSL 탭까지 잡음) → 고친 뒤 종료 0 |

`test-assistant-native.mjs`는 성공 전까지 다섯 번 실패했다. 모두 검사 쪽 원인이며 제품 코드는 바꾸지 않았다.

1. 이 PC의 PowerShell 프로필이 프롬프트를 바꿔 `PS C:`를 기다리다 실패(변경 전 단계). 첫 출력만 기다리게 했다.
2. Bash는 bracketed paste로 받은 여러 줄을 입력줄에 두고 Enter를 기다린다. 붙여넣은 뒤 Enter를 누르게 했다. PowerShell은 바로 실행했다.
3. WSL 배포판 이름이 `Ubuntu`로 고정돼 있었다. 설치된 첫 배포판을 고르게 했다.
4. 독립 창의 스니펫 버튼이 TW.8에서 제목 줄 메뉴로 옮겨진 뒤 선택자가 고쳐지지 않았다.
5. Zsh 탭을 연 직후 바로 vim을 실행해, 프롬프트가 조용해진 뒤 들어가는 훅보다 먼저 시작했다. 일반 안내가 나온 것은 의도된 동작이다. 경로 반영으로 훅 설치를 확인한 뒤 실행하게 했다.

### 확인한 제약

- **접속 직후 바로 실행한 프로그램:** 훅은 첫 프롬프트 뒤 출력·입력이 잠시 없을 때 들어간다. 그 전에 전체 화면 프로그램을 띄우면 훅 설치를 포기하고(최대 10초 대기), 그 셸에서는 조작표 자동 표시와 경로 따라가기가 동작하지 않는다(F.1부터의 동작). 파일 패널의 **셸 경로 알림 연결**로 다시 넣을 수 있고, 이 입력에도 조작표 알림이 함께 들어간다.

### TW.5~TW.7 미실행·미검증

- 선택자만 고치고 실행하지 않은 검사: `test-ftp-native.mjs`(입력 범위가 FTP 탭 두 개에서 숨겨지는지).
- 우클릭·키 입력은 CDP 이벤트로 확인했다. 실제 마우스·키보드로 상태바 입력 범위와 탭 바 체크를 누르는 것은 확인하지 않았다.
- 실제 macOS의 `/bin/bash` 3.2와 로컬 Zsh(입력해 넣는 훅), Mac 실기기 전체는 대기다([macos-readiness](macos-readiness.md) M.14).
- 전체 게이트, 전체 Vitest·Playwright, 게임 테스트, `verify-windows.ps1 -Native`.

## 알려진 실패

`verify-windows.ps1 -Native`는 `run-ftp --native`에서 끝까지 가지 못했다. 변경 전에도 있던 실패이며, TW.4에서 원인(검사 경합)을 찾아 고쳤다. 아래는 당시 기록이다. 고친 뒤 `verify-windows.ps1 -Native` 전체는 아직 다시 실행하지 않았다.

- 두 번째로 연 파일 패널 탭의 `폴더` 버튼 클릭이 15초 뒤 시간 초과된다. Playwright 판정은 "element is not visible"이다.
- 프로토콜 문제가 아니다. 순서를 바꾸면 FTPS가 통과하고 FTP가 같은 단계에서 실패한다.
- 시간 초과 시점에 해당 버튼은 26×28px, `checkVisibility()` 참이고, 스크린샷에도 보인다. 숨겨진 것은 첫 탭의 버튼뿐이다.
- `setViewportSize`를 뒤로 옮겨도 재현되어 뷰포트 에뮬레이션은 원인이 아니다. 제품 결함인지 검사 문제인지는 아직 모른다.

이와 별개로 `ftp_probe`가 FTPS `legacy rename`에서 서버 응답 550으로 한 번 실패했고, 앞선 두 번의 실행은 통과했다. 이번 변경은 이 경로를 건드리지 않았으며 원인은 미확인이다.

## 미검증

- 실제 FTPS 탭을 분할 안에서 파일 전송까지 쓰는 경로. 위 실패로 자동 검사가 도달하지 못한다.
- 실제 마우스로 앱 창 밖까지 끌어 분리하는 동작, 탭 드래그와 Windows 파일 드롭의 공존.
- `test-jump-native.mjs`, `test-session-transfer-native.mjs`는 임시 WebView2 프로필 설정만 추가했고 실행하지 않았다.
- Mac 실기기 전체(WKWebView 포인터 캡처 포함).
