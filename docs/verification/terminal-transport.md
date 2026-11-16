# U4 터미널 transport 분리

- 실행일: 2026-11-16 / 대상: `52cb524` + `refactor/u4-terminal-transport` 미커밋 변경 / 환경: macOS(Apple Silicon), Docker Linux 엔진
- 작업 ID: [architecture-review U4](../architecture-review.md)

## 변경

- `src/features/terminal/transport.ts`(신규): `TerminalTransport`가 백엔드 명령(open·input·ack·resize·close)과 종류별 지원 기능(폴더 보고 방식, 손으로 넣는 훅, Git 자격 증명 도우미, 프로그램 안내, Windows 경로 링크, 에이전트 보조, 주소 링크)을 가진다. 구현은 `remoteTransport`(SSH·FTP/FTPS, `connect`·`terminal_*`·`disconnect`), `localTransport`(`local_*`), `podTransport`(`kube_terminal_*`) 세 개다.
- `session.ts`: `podTerminal`·`localTarget`·`profile.protocol`로 고르던 분기 9곳(`backend`, `closeCommand`, 연결 명령, 폴더 보고 방식, Git 도우미, 손 훅 가능 여부, Windows 경로, 프로그램 안내, 에이전트·링크, resize 2곳)을 transport 호출로 바꿨다. 생성자는 `(profile, theme, onConnected, transport?)`이고, 없으면 `remoteTransport(profile)`이다. `kind`, `localTarget`, `podTerminal`은 transport에서 읽는 getter다.
- 파드 탭의 새 파드 지정은 필드 대입 대신 `retargetPod(launch)`를 쓴다. 재접속은 `transport.reopen(profile)`을 거쳐, 저장된 연결의 프로토콜이 바뀌었으면 SSH↔FTP transport도 바뀐다(이전에는 매번 `profile.protocol`을 읽었다).
- `sessionKind.ts`: `sessionKind()`의 추론을 없애고 `session.kind`를 쓴다. `capabilities`와 `sessionSource`는 `kind`로 판단한다. 호출부 8곳(`StatusBar`, `useFileTabs`, `useToolTabs`, `useChatTabs`, `useReviewTabs`, `editSave`, `useGitView`, `useGitStatus`)을 `session.kind`로 바꿨다.
- `App.tsx`는 `localTransport`, `useKubeTabs.ts`는 `podTransport`로 탭을 만든다. `App.tsx`는 재접속 분기를 `kind`로 줄여 9줄 추가·9줄 삭제로 순증이 없다.
- 백엔드(Rust)와 IPC 명령 이름은 바꾸지 않았다.

새 터미널 종류(Telnet, 시리얼)를 붙이는 방법: `transport.ts`에 transport를 추가하고, `SessionKind`에 종류 하나와 `sessionKind.ts`의 `capabilities` 표 한 줄을 추가한다(표가 `Record<SessionKind, …>`라 빠뜨리면 타입 오류). `TerminalSession`은 고치지 않는다. 화면 문구(`StatusBar`의 종류별 설명 등)는 종류별로 따로 정해야 한다.

## 동작 보존

변경 전 코드에서 종류별 값을 옮겨 `transport.test.ts`의 표로 고정했다. 로컬·파드 탭의 profile은 `blankProfile()`이라 `protocol`이 `ssh`였다는 점을 반영했다(로컬·파드도 resize를 보냈고, 로컬은 에이전트·링크를 붙였다).

| 항목 | SSH | FTP/FTPS | 로컬 셸 | 로컬 WSL | 파드 |
|---|---|---|---|---|---|
| 열기 | `connect` | `connect` | `local_open` | `local_open` | `kube_terminal_open` |
| 입력·ACK·크기 | `terminal_*` | `terminal_*`, 크기 없음 | `local_*` | `local_*` | `kube_terminal_*` |
| 닫기 | `disconnect` | `disconnect` | `local_close` | `local_close` | `kube_terminal_close` |
| 폴더 보고(tmux·쿠버네티스 작업 화면이면 `none`) | `remote` | `none` | 대상의 `follow` | 대상의 `follow` | `none` |
| 손으로 넣는 훅 | 가능 | 가능 | 불가 | 가능 | 불가 |
| Git 자격 증명 도우미 | 요청 | 요청 | 안 함 | 안 함 | 안 함 |
| 프로그램 안내 갱신 | 함 | 함 | 함 | 함 | 안 함 |
| Windows 경로 링크 | 아님 | 아님 | 함 | 아님 | 아님 |
| 에이전트 보조 | 붙임 | 안 붙임 | 붙임 | 붙임 | 안 붙임 |
| 주소 링크 | 서버 | 없음 | 이 PC | 이 PC | 없음 |

FTP의 "손 훅 가능"과 "Git 도우미 요청"은 이전 코드의 값을 그대로 옮긴 것이다. 의미상 FTP에는 셸이 없으므로 바꿀지는 별도로 정한다.

## 결과

부하 평균 20~100(다른 작업의 kind 클러스터·빌드와 겹침)에서 실행했다. `verify-macos.sh`는 아래 이유로 한 번에 끝까지 돌지 못해, 멈춘 단계부터 같은 순서로 이어 실행했다.

| 명령 | 범위 | 결과 |
|---|---|---|
| `npx vitest run` 새 테스트 | `transport.test.ts` 7개, `session.test.ts` 7개 | 통과 |
| `npm run typecheck`, `lint`, `format:check` | 전체 | 종료 0 |
| `npm test`(`verify-macos.sh` 안) | 114파일 1377개 | **1개 실패**: `survivor/stages.test.ts`의 30/60/120Hz 시뮬레이션이 5초 제한 초과. 단독 실행도 15초로 실패, `--testTimeout=60000`으로 17/17 통과. 게임 코드는 이 변경에서 바뀌지 않았고, progress에 같은 테스트가 CPU 포화 때 실패한 기록이 있다 |
| `npx vitest run --testTimeout=60000` | 114파일 | 1377개 통과 |
| `npm run build` | 프런트엔드 | 종료 0 |
| `npm run test:ui -- --workers=2` | Playwright 535개 | **11개 실패**, 524개 통과. `file-tab` 7개·`git-diff` 3개(Monaco 편집기 표시 5초 대기), `kube-tree` 1개 |
| 위 세 스펙을 `--workers=1`로 재실행 | `file-tab`, `git-diff`, `kube-tree` | 110개 통과, `file-tab.spec.ts:59` 1개 실패 |
| `file-tab.spec.ts:59`, 변경을 stash한 기준 코드 | `52cb524` | 같은 단언에서 **실패** → 이번 변경의 회귀가 아니다 |
| `cargo fmt --all --check`, `cargo clippy ... -D warnings` | 워크스페이스 | 종료 0 |
| `cargo test --workspace --locked` | 워크스페이스 | 앱 680개 통과(4개 ignore) + 실증 1개 |
| `npm audit`, `audit-dependencies.mjs`, `generate-notices.mjs` | 의존성 | 종료 0, 취약점 0건 |
| `npm run probe:phase1` 1회 | 실제 OpenSSH | **실행 못 함**: 준비 단계 `HTTPS Git server startup timeout` |
| `run-phase1.mjs --reuse-build` 2회 | 실제 OpenSSH | **실행 못 함**: `Docker operation failed: run`. 이어서 `docker run --rm debian:bookworm-slim true`가 8분 23초 걸렸다(Docker VM 10 CPU, 실행 중 컨테이너 10개). 프로브의 `docker` 호출 제한은 30초다 |

`probe:phase1`은 Rust 엔진을 직접 호출하므로 이 변경(프런트엔드만)이 지나는 경로를 검사하지 않는다. 그래도 요청 범위라 Docker가 정상일 때 다시 실행해야 한다.

환경 메모:

- 이 Mac의 cargo는 Homebrew `rustup`(`/opt/homebrew/opt/rustup/bin`)에 있고 `~/.cargo/bin`에는 `cargo-audit`만 있다. `verify-macos.sh`는 `~/.cargo/bin`만 PATH에 넣으므로 이 PC에서는 PATH를 따로 잡아야 cargo 단계가 돈다.
- `generate-notices.mjs`가 `licenses/`를 다시 썼다(rusqlite 0.41 등 상향분). `1f08a01`이 고지를 갱신하지 않아 생긴 차이이고 U4와 무관해 이 브랜치에서는 되돌렸다.

## 남은 사항

- U4의 "FTP 탭도 xterm을 생성한다"는 이번에 다루지 않았다. `session.terminal`을 필수로 읽는 곳이 많아 별도 작업으로 남긴다.
- `session.ts` 밖에서 `podTerminal`·`localTarget`·`profile.protocol` 유무로 종류를 추론하는 곳이 남아 있다: `SnippetRun.tsx`, `usePromptAttachments.ts`, `features/sftp/SidebarFiles.tsx`, `app/SidebarFiles.tsx`, `TunnelPanel.tsx`, `App.tsx`의 `TunnelPanel`·`splitTab`. 동작을 바꾸지 않기 위해 두었다. 특히 `TunnelPanel.tsx`의 `!s.localTarget && s.profile.protocol === 'ssh'`는 파드 탭도 통과시키므로 `kind === 'ssh'`로 바꾸면 동작이 달라진다.
- 실제 앱 화면에서 SSH·로컬·WSL·파드·FTP 탭을 직접 여는 확인은 하지 않았다. Mac에는 WKWebView 자동 검사 경로가 없고, Windows `test:native`는 이 Mac에서 실행할 수 없다.
