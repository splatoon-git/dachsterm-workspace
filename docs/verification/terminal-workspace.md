# 터미널 작업 공간 재설계(TW) 검증 기록

설계는 [terminal-workspace](../design/terminal-workspace.md), 상태는 [progress](../progress.md)가 정본이다. 모든 결과는 이 PC(Windows 11)에서 `feat/terminal-workspace` worktree로 실행했다. Mac 실기기 결과는 없다.

## 게이트

| 대상 | 명령 | 결과 |
|---|---|---|
| 변경 전 `55cc424` | `scripts/verify-windows.ps1` | 종료 0 |
| TW.1 미커밋 트리 | `scripts/verify-windows.ps1` | 종료 0. Vitest 455, Playwright 99, Rust 85+1 |
| TW.2 미커밋 트리 | `scripts/verify-windows.ps1` | 종료 0. Vitest 460, Playwright 115, Rust 85+1 |

게이트의 `generate-notices.mjs`는 `licenses/THIRD_PARTY_NOTICES.txt`를 내용 차이 없이 CRLF로 다시 쓴다. 매번 복원했고 커밋하지 않았다.

## TW.2 네이티브 (실제 앱, WebView2)

| 항목 | 명령 | 결과 |
|---|---|---|
| 실제 OpenSSH 전체 회귀, 2×2 칸별 입력, 칸별 `stty size`와 그려진 행·열 일치, 분할선 드래그 뒤 양옆 두 칸만 열 수 변경, 배치 변경 뒤 같은 연결·같은 xterm 인스턴스 | `npm run test:native` | 종료 0 |
| 로컬 PTY 전체·일부·비대상 입력, 전체화면, 확대, 인스턴스 유지, `Ctrl+Alt+방향키`, 분할선 키보드, 앱 재시작 후 모양과 비율 복원, 빈 칸 채우기 | `node scripts/test-workspace-native.mjs` | 종료 0 |
| 로컬·WSL 분할, 닫기·재접속 | `node scripts/test-local-native.mjs` | 종료 0 |
| FTP 탭의 작은 칸 표시 | `node scripts/run-ftp.mjs --native-only`의 FTP 단계 | 통과. 스크린샷은 `test-results-native/ftp-small-group.png`로 남고 저장소에는 넣지 않는다 |
| FTPS 탭 | 같은 명령의 FTPS 단계 | **실패(기존)**, 아래 참조 |

## 알려진 실패

`verify-windows.ps1 -Native`는 `run-ftp --native`에서 끝까지 가지 못한다. 변경 전에도 있던 실패다.

- 두 번째로 연 파일 패널 탭의 `폴더` 버튼 클릭이 15초 뒤 시간 초과된다. Playwright 판정은 "element is not visible"이다.
- 프로토콜 문제가 아니다. 순서를 바꾸면 FTPS가 통과하고 FTP가 같은 단계에서 실패한다.
- 시간 초과 시점에 해당 버튼은 26×28px, `checkVisibility()` 참이고, 스크린샷에도 보인다. 숨겨진 것은 첫 탭의 버튼뿐이다.
- `setViewportSize`를 뒤로 옮겨도 재현되어 뷰포트 에뮬레이션은 원인이 아니다. 제품 결함인지 검사 문제인지는 아직 모른다.

이와 별개로 `ftp_probe`가 FTPS `legacy rename`에서 서버 응답 550으로 한 번 실패했고, 앞선 두 번의 실행은 통과했다. 이번 변경은 이 경로를 건드리지 않았으며 원인은 미확인이다.

## 미검증

- 실제 FTPS 탭을 분할 안에서 파일 전송까지 쓰는 경로. 위 실패로 자동 검사가 도달하지 못한다.
- 실제 앱의 창 경계 드래그와 Windows 파일 드롭 공존은 TW.3 항목이다.
- Mac 실기기 전체.
