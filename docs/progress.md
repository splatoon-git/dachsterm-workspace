# DachsTerm 진행 현황

- 마지막 갱신: 2026-11-20

현재 상태와 남은 작업만 둔다. 지난 작업 경과는 git 이력에서 찾는다. Mac 항목의 정본은 [macos-readiness](verification/macos-readiness.md)와 [Mac 체크리스트](verification/macos-checklist.md)다.

## 현재 상태

- **베타 단계.** 계획한 기능 ID는 AC 일부, KV.4 일부, U4 후반을 빼고 모두 구현돼 `dev`에 병합됐다. 상용 안정판 승인은 하지 않았다.
- **Windows**: 기능별 자동 게이트, 실제 앱(WebView2) 검사, 실제 OpenSSH·FTP/FTPS·kind 환경 검사로 검증했다. 물리 IME, OS 파일 창·드롭, 절전·장시간, 일부 장비·외부 프로그램 확인이 남았다. 최근 Windows 산출물은 UI.1 release ZIP이다.
- **macOS**: 자동 게이트(`verify-macos.sh --package`)는 통과 기록이 있다. 실기기 결과는 일부뿐이다(CG 패키지 앱, CG.6 업데이트 설치, KV.9·KV.11~KV.13 패키지 앱, AC.3 Codex 채팅, `Cmd+W`, M.16 자동 키 이벤트, 실제 앱 조작 2차). 나머지는 M.* 대기다.
- **배포**: Apache-2.0. 앱 업데이트(CG.6)는 구현돼 있고 제품 서명 공개 키를 반영했다(2026-11-20). 서명 개인 키는 저장소 시크릿으로 등록됐다. `v0.5.1` 태그로 `release.yml`이 성공해(run 44684044582) NSIS·DMG·Mac 업데이트 파일·`latest.json`(두 플랫폼, 서명 버전 0.5.1)을 올린 릴리스를 2026-11-20에 공개했다. `releases/latest/download/latest.json`이 응답한다. 포터블 ZIP은 앱 안 업데이트가 설치 폴더에만 설치하므로 넣지 않는다(사용자 결정). OS 코드 서명은 하지 않는다(사용자 결정). Windows 무료 서명(SignPath)은 포트 확인 도구가 "포트 스캐너 금지" 조건에 걸릴 수 있어 보류했다.
- **게이트**: `probe:phase1`이 Git 자격 증명 단계에서 실패한 상태로 남아 있다(아래 표). `main` CI는 `bc61988`에서 Windows(44684033000)·macOS(44684032994) 모두 통과했다. 그 직전 `d21781c`의 macOS는 `file-tab.spec.ts` 미리보기 테스트가 편집기 표시 5초 제한을 넘겨 한 번 실패했고 재실행에서 통과했다(불안정 테스트로 남음).

## 남은 작업

| ID | 내용 | 필요한 것 / 막힌 이유 |
|---|---|---|
| CG.6 | Windows NSIS 0.5.1 → 0.5.2 실제 업데이트와 `cfg(windows)` 설치 경로(설치 전 세션 정리). Mac 설치 경로의 세션 정리, 브라우저로 받은 DMG 첫 실행, 이전 Keychain 항목 접근, 관리자 권한 위치 설치 | Windows PC, Mac 실기기. [app-updates](verification/app-updates.md)의 "남은 확인" |
| 5.3 | Mac Developer ID 서명·공증 | Apple 개발자 등록(예정). 그 전에는 ad hoc 서명이라 M.29가 남는다 |
| 5.2 (M.*) | Mac 실기기 전체 | MacBook에서 `mac-verify`. 항목은 macos-readiness의 M.1~M.29 |
| 5.1 | 장애·장시간 측정: `blip`·`blackhole`·`suspend-drop`·`quit-graceful`·`quit-kill`, 연결 반복 150회, 2GiB 다운로드, 60분 장시간, 실제 OS 절전·네트워크 전환, 실제 앱 대량 출력 | Docker 데몬 정상 응답(지난 실행에서 무응답) |
| 5.1 | 사람 조작: Windows 물리 IME(조합·받침·vim·탭 전환·resize), OS 파일 선택·드롭, GUI 편집기 왕복, Windows 수동 체크리스트 M1~M10 | 사람 확인. [Windows 체크리스트](verification/windows-release-checklist.md) |
| 게이트 | `probe:phase1`의 제품 엔진 프로브가 `credential_checks/mod.rs`의 `one card for an LFS push`에서 종료 1. 변경 전 커밋에서도 재현됐고 원인은 조사하지 않았다. 이 지점 뒤 항목은 실행되지 않는다 | 원인 조사, Docker |
| T5 | `test:native` 분할 단계 실패 1건 원인 미확인. FTPS `enter directory` 실패는 이후 재현되지 않았으나 고친 것은 아니다 | [native-test-flakiness](verification/native-test-flakiness.md) |
| U4 후반 | FTP 탭의 xterm 생성 제거, `session.ts` 밖 세션 종류 추론 7곳 정리, `probe:phase1`·실제 앱 확인 | 미구현 |
| S.7 | 서명 승인 카드의 "로그인할 서버의 호스트키"가 검증되지 않은 서버 주장값이다(Low, 승인 우회는 아님). 서명과 session ID 검증 뒤에만 표시해야 한다 | 미수정 |
| S.1~S.12 | 보안 점검 수정분의 Windows 게이트·실제 앱 확인 | Windows 실행 |
| AC.3·AC.4·AC.9 나머지 | AC.3: SSH 서버 Codex, 샌드박스 실패 안내, Windows `codex.cmd` 실행·종료 정리. AC.4: 독립 창, OS 알림. AC.9: 재시작 후 목록·이어가기·터미널로 열기·로그 상한·서버에 남은 실행기 정리 | 미구현 |
| AC.6~AC.8, AC.10, AC.11 | 전역 설정·모델 목록, 실행 그래프, 터미널 탭 서브 표시, 문서·회귀, SSH 키·Git 자격 증명 | 미구현. [설계안](design/agent-chat.md) |
| AC | 구현분의 실제 앱 왕복·승인·재접속, Windows 네이티브 검사(`test-chat-native.mjs` 없음) | Mac 실기기, 검사 작성. [검증 기록](verification/agent-chat.md) |
| KV.4 | 워크로드·노드 행의 상세 패널(지금은 파드만) | 미구현 |
| KV.10 | 실제 vLLM·DCGM exporter 메트릭과 처리 정지 판정(지금은 대역 메트릭으로 파서만 검증) | GPU·vLLM 클러스터 |
| KV.6·KV.7·KV.11~KV.13 | Windows 실제 앱(`npm run test:session-log`, 로컬 클러스터 탭, 로그 보드), 앱 화면의 kind 조작(운영 모드·파드 삭제), KV.7 OS 알림 | Windows 실행, 사람 확인 |
| GE.3 | 실제 탐색기로 끌어내기 `npm run test:drag-out` | 실제 마우스를 쓰므로 화면을 비울 수 있을 때 |
| GE.4 | 편집기 부품 최종 확정: Windows 실제 IME(한글·일본어·중국어, `test-editor-native.mjs --manual`), Mac 사람 타이핑(M.16) | 사람 입력 |
| GE.8 | SSH 탭 diff의 실제 앱 확인 | Docker 네이티브 단계 추가 |
| DX | 로그인된 CLI 에이전트로 훅 상태·worktree 시작·검토 의견 전달, DX.16 모드별 에이전트 시작, Windows `ssh-agent` 서비스와 외부 Git 호스팅 push, tmux 1.8에서 DX.7 `=이름` 대상 동작(동작하지 않을 것으로 의심) | 에이전트가 로그인된 서버, `ssh-agent` 활성화 |
| TW | 선택자만 고치고 실행하지 않은 네이티브 검사: `test-native`, `test-ftp-native`, `test-transfer-queue-native`, `test-jump-native`, `test-session-transfer-native`, `test-assistant-native`, `verify-tunnels` | Docker |
| TL | 표준 사용자 계정의 Windows 결과, `tracepath`만 있는 서버, 만료·이름 불일치 실제 인증서 | 환경 |
| CG | Pageant, VcXsrv·XQuartz, COM 포트·실제 USB 시리얼, `verify-windows.ps1 -Native` 전체, `connect_probe.rs`·`proxy_command.rs` 변경의 Mac 컴파일과 `probe:connect`, Mac 우클릭 붙여넣기 사람 확인, Telnet·시리얼 위 ZMODEM 실서버, tmux 안 전송 | 프로그램 설치, 장비, 메모리 |
| FV.6 | 실제 문서 표본(hwp·docx·pdf), 오피스·한글 프로그램 왕복(편집 → 저장 → 업로드 카드), 구형 WebView2, Mac | 사람 확인 |
| W.1 | 구형 WebView2(100) PC에서 새 빌드의 화면 배치·경고 창·북마크 미리보기, 전체 `cargo test`, `test:import-detect` | 해당 PC |
| W.2 | 사용자명을 비운 세션으로 실제 OpenSSH 접속(암호·키·경유지·ProxyCommand `%r`), 앱 빌드 뒤 카드와 암호 대화상자 순서 | Docker |
| UI.1 | 실제 앱에서 설정·팝업을 Windows 배율별로 확인, Mac | 사람 확인. [기준](design/ui-consistency.md) |
| I.2·6.5 | 실제 PuTTY 설치본, SSH 북마크가 있는 실제 ini, 외부 프로그램의 실제 설정 파일 | 환경 |
| T.5~T.7 | 패키지 앱에서 크림·Classic 테마와 agnoster 프롬프트, Powerline 화살표 확인 | 사람 확인 |
| T.4 | `action.accent` 사용처(배지 등) | 사용자 결정 |
| G.8.6 | 사람의 무강화 다중 시드 난이도·재미 평가, 10판 장시간 메모리, 실제 OS 종료·절전 전후 저장 | 사람, 별도 Windows 환경 |
| 감사 예외 | `chrono` 관리 중단 알림(`russh-sftp`·`suppaftp` 경유) 예외를 2026-12-18에 재검토 | 날짜 |
| 문서 | 터미널 `Ctrl/Cmd`+스크롤 글꼴 크기를 사용 안내서 단축키 표에 추가 | — |
| 라이선스 | 마스코트 이미지의 상업 이용 약관 확인, 가격 결정(정하면 "무료 개인용 앱" 문구 수정) | 사용자 결정 |
| 구조 | [architecture-review](architecture-review.md)의 열린 ID(F4, F5, B1~B8, B10, U*, T*) | ID 단위 별도 작업 |

## 다음 첫 행동

1. `gh run list`로 최신 `main` CI 결과를 확인한다. 실패하면 다른 작업보다 먼저 고친다.
2. 첫 릴리스: 사용자가 서명 개인 키를 저장소 시크릿에 등록하면 `v0.5.1` 주석 태그를 푸시해 초안 릴리스를 확인한다. 이어서 Windows에서 0.5.1 → 0.5.2 NSIS 업데이트를 [app-updates](verification/app-updates.md)의 방식으로 실행한다.
3. `timeout 30 docker ps`가 바로 응답하면 `probe:phase1`(LFS 단계 실패 원인 조사), W.2 실제 SSH 접속, 5.1 장애 시나리오, TW의 미실행 네이티브 검사를 차례로 실행한다.
4. MacBook에서 `mac-verify`로 [Mac 체크리스트](verification/macos-checklist.md)와 M.* 항목을 확인한다. 우선순위: 패키지 앱의 LAN 접속과 Finder 한글 파일 업로드, CG ProxyCommand 변경의 clippy·`probe:connect`, 우클릭 붙여넣기, 분리 창 `Cmd+W`.
5. 사람 확인을 모아 한 번에 한다: UI.1 배율, FV.6 실제 문서, W.1 구형 WebView2 PC, GE.3 `test:drag-out`, Windows 물리 IME.

## 기능 영역별 상태

| 영역 | 작업 ID | 상태 | 남은 ID |
|---|---|---|---|
| 기반·기술 실증 | 0.1~0.4 | Windows 완료, SSH 엔진 결정은 [ADR](adr/) | 0.4 Mac |
| SSH 터미널·세션·OS 저장소 | 1.1~1.3 | 실제 OpenSSH와 Windows 앱으로 인증·호스트 키·PTY·재접속·Credential Manager 검증 | 물리 IME, Mac(Keychain 등) |
| SFTP·외부 편집 | 2.1~2.3 | Windows 검증. 전송 재개·바이트 일치·복구 통과 | OS 파일 창·드롭, GUI 편집기 수동, Mac |
| 멀티 터미널·터널 | 3.1~3.4 | Windows 검증 완료 | Mac |
| 모니터링 | 4.1~4.2 | Windows 검증 완료 | Mac |
| 안정화·배포 | 5.1~5.3 | Windows 자동 검사·NSIS 설치 검사 통과. 5.1 측정에서 결함 2건 수정(출력 펌프, 시간 제한) | 5.1, 5.2, 5.3 |
| SSH 작업 확장 | 6.1~6.7 | 폴더 전송·큐, 스니펫, 세션 로그, 점프 호스트, 세션 관리·이관, 명령 도우미 구현·Windows 실제 검증. 6.7 PodTree는 KV로 대체돼 제거 | 물리 IME, 외부 실파일, Mac |
| 게임 | G.1~G.8 (G.8.Q1·Q2 포함) | 미니게임·모험·서바이버 구현·Windows 검증 | G.8.6 사람 평가·환경, Mac |
| 테마 | T.1~T.7 | 16종, 토큰 게이트(`tokens.test.mjs`). T.5~T.7은 브라우저 UI까지 | T.4 결정, T.5~T.7 패키지 앱, Mac |
| 작업 공간 UI | U.1~U.3 | 로컬 PTY·WSL, 통합 UI, 버튼·터널 설정 정리. Windows 검증 | Mac |
| 터미널 구조 | U4 | transport 분리 완료(`transport.ts`, `session.kind`) | U4 후반 |
| 보안 | S.1(RSA·인증·터미널 기본기), S.1~S.12(보안 점검) | `ring` RSA 대체, 점검 수정분 `dev` 병합, Mac 게이트 통과 | S.7, Windows 확인 |
| 가져오기 | I.1, I.2 | 세션 JSON·외부 가져오기, 이 PC 설정 찾기. Windows 실제 앱 검증 | 실제 외부 설정 파일, Mac |
| Windows 품질 | W.1~W.4(출시 품질, 2026-11-05) | 데이터 복구·진단·릴리스 검사 구현 | 수동 체크리스트, 서명 |
| Windows 호환·연결 | W.1(구형 WebView2), W.2(사용자명 묻기) | 구현·대상 테스트 통과·`dev` 병합 | W.1, W.2 |
| 이름 | N.1, N.2 | DachsTerm 전환 완료 | — |
| 파일 트리 | F.1 | 자동 팔로우·로컬 파일 트리. Windows 게이트 통과 | M.12 |
| 에이전트 터미널 | AT.0~AT.7 | 구현. 로그인된 CLI 에이전트로 AT.5 합격 | AT.7 Mac(M.13) |
| 개발자 작업 흐름 | DX.0~DX.16 | SSH 키 전달·승인, tmux, Git 상태·검토, 에이전트 시작·현황, HTTPS Git 자격 증명, 로컬·WSL agent 구현 | 수동 확인, M.15 |
| 쿠버네티스 | KV.0~KV.13 | 구현·kind 실측. Windows 실제 앱(KV.1~KV.5, KV.8, KV.9), Mac 패키지 앱(KV.9 런타임 탭, KV.11~KV.13) | KV.4 일부, KV.10 실환경, Windows 실제 앱(KV.11~KV.13), Mac(M.23) |
| 터미널 작업 공간 | TW.1~TW.10 | 구현. 동시 입력·조작표·설정·대화상자 정리 | Docker 네이티브, M.14 |
| Git·편집 | GE.1~GE.15 | 구현·문서. Windows GE 범위 회귀 통과 | GE.3, GE.4, GE.8, M.16~M.20 |
| 도구 메뉴 | TL.0~TL.10 | 터널·SSH 키·문서 편집기·네트워크 도구 구현, Windows 실제 앱 검증 | M.21, M.22, 표준 사용자 계정 |
| 에이전트 채팅 | AC.0~AC.11 | AC.0 실측, AC.1·AC.2·AC.3·AC.5 구현, AC.4·AC.9 일부. Mac 자동 게이트 통과 | AC.3·AC.4·AC.9 나머지, AC.6~AC.8, AC.10, AC.11 |
| 상용 대비 보완 | CG.0~CG.10 | 프록시·ProxyCommand·인증서·Telnet·시리얼·업데이트·하이라이트·ZMODEM·X11 구현. Mac 실환경·패키지 앱, Windows `test:connect`·`probe:connect` 통과 | 장비·외부 프로그램 확인, CG.6 릴리스 |
| 파일 미리보기 | FV.1~FV.6 | 구현. Windows 실제 앱·실제 SSH 검사 통과 | FV.6 |
| UI 일관성 | UI.1 | `dev` 병합, Windows release ZIP | 실제 앱 배율, Mac |
| macOS | M.1~M.29 | M.2~M.10 코드 수정·구현, M.26·M.27 수정 | 실기기 확인(macos-readiness) |

## 알려진 제한

- OS 코드 서명이 없다. Windows는 설치 때 경고가 뜨고, Mac은 ad hoc 서명이라 새 빌드가 이전 Keychain 항목을 읽을 때 로그인 암호 창이 뜬다(M.29).
- 지원하지 않는 것: 내장 X 서버(X11 포워딩은 외부 X 서버 사용), RDP/VNC, FIDO2 키 직접 접근, GSSAPI/Kerberos, 호스트 CA 인증서, SOCKS4, implicit FTPS, Active FTP.
- FTP 파일은 **기본 프로그램으로 열기**를 지원하지 않는다. 한글 문서 미리보기 엔진(WebAssembly 약 27MB)으로 설치 패키지가 커졌다.
- WebView2 111 미만에서는 시작할 때 경고하고 일부 화면이 어긋날 수 있다.
- 사용자명 없이 저장한 SSH 세션: 암호를 저장하지 않은 비밀번호 세션은 암호 대화상자가 사용자명 카드보다 먼저 뜨고, 연결된 탭 상태 줄에는 호스트만 나온다. 입력한 사용자명은 저장하지 않는다.
- 내장 편집기에서 IME 조합 중 `Ctrl+S`는 저장하지 않는다(글자 손실은 없음).
- 인그레스 트래픽 지표는 ingress-nginx만 지원한다. 기본 접근 로그에 호스트가 없어 호스트로 로그를 검색하면 결과가 없다.
- Windows 경로 추적은 IPv4만 지원한다.
- 에이전트 채팅: 탭을 끊긴 채 닫거나 앱을 끝내면 서버에 남은 실행기가 정리되지 않는다(AC.9).
- Powerline 글꼴이 없는 PC에서는 프롬프트 화살표가 빈칸이다.
- `Ctrl/Cmd`+스크롤 글꼴 크기는 제스처당 한 단계라, 쉬지 않고 빠르게 돌려도 한 단계만 바뀐다.
- 서바이버 게임: 프로세스를 즉시 강제 종료하면 디스크에 쓰기 전 진행이 사라질 수 있다. 실제 UI 프레임 간격은 안정적인 60FPS 기준을 통과하지 못했다.
