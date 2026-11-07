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
