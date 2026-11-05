# DaxTerm 구현 진행 현황

- 마지막 갱신: 2026-11-05
- **G.8.1 닥스의 서바이버 전투/HP/XP 엔진 구현·규칙 검증 완료**: 고정 시간 이동·물기·슬라임·HP·XP/선택 대기를 구현했다. 타입 및 기본 규칙21개 통과. 카드·무기 확장은 G.8.2, 게임 화면은 G.8.5다. 하단 G.8.1 기록을 따른다.
- **G.6 랜덤 모험·환경/기믹·밟기 구현·Windows 검증·release 빌드 완료**: Space 물기·↑/W 점프·공중 ↓/S 빠른 밟기와 자동 머리 밟기, 시드 재현/4환경 순환/기믹·적 다양화. 최종 규칙53개·고유 게임 UI15개·실제 WebView2와 로컬 PTY 입력 격리 통과. 상세는 하단 G.6.
- **G.5 간식 타임 개선 구현·Windows 검증·release 빌드 완료**: G.4 모션 atlas 공유, 좌우 가감속/반전·씹기·별 점프·피격/점수 효과, 연속 기록·정원·결과 화면. 전체 규칙53개, 게임 UI17개, 실제 WebView2 6종·로컬 PTY 입력 격리 통과. 최신 `target/release/daxterm.exe` 반영. 상세·남은 환경 검증은 하단 G.5 기록.
- **G.4 닥스의 모험 횡스크롤 액션 구현·Windows 검증·release 빌드 완료**: 직접 좌우 이동·점프·물기, 6포즈 스프라이트, 적/발판/가시/협곡/쉼터/완주를 추가했다. 규칙44개·게임 UI11개·실제 WebView2 6종과 로컬 PTY 입력 격리 통과. 상세·남은 검증은 하단 G.4 기록.
- **G.3 닥스 미니게임 2종 구현·Windows 검증·release 빌드 완료**: 게임 목록에 간식 타임·닥스의 모험을 추가했다. 규칙38개/신규 UI4개/기존 게임 UI5개 및 실제 WebView2 6종·로컬 PowerShell 입력 격리 통과. 최신 `target/release/daxterm.exe`에 반영. 파일·결과·남은 항목은 하단 G.3 기록 참조.
- **I.1 구현·Windows 자동 검증·release 빌드 완료**: 자체 세션 JSON v2/Schema·v1 호환, PuTTY/MobaXterm/OpenSSH 기본 SSH 변환·미리보기·선택/계정 보정, 첫 접속 인증창의 로그인 성공 후 암호 저장을 추가했다. 실제 OpenSSH/OS 저장소·재시작·저장 실패 안내까지 검증했다. 최신 `target/release/daxterm.exe`에 반영. 지원/제외 계약은 `docs/session-transfer.md`, 상세/남은 검증은 하단 I.1 기록을 따른다.
- **U.3 구현·Windows 실제 검증 완료 / Mac·설치본 대기**: 대화상자 버튼 32px 정렬, 터널 목록/편집 분리, 유형별 연결 흐름 안의 입력과 설명, 저장 후 목록 복귀, 실행·중지/자동 시작 구분을 반영했다. UI 전체32개 및 최종 해당 영역12개, 실제 Local/Remote/SOCKS5 왕복과 전체 native 회귀 종료0. [설정 UI 검증](verification/settings-ui.md) 참조. 검증 실행 파일은 `src-tauri/target/windows-hardening/debug/daxterm.exe`; 기존 release/NSIS를 이 결과로 대체하지 않는다.
- **S.1 구현·Windows 실제 통합 검증 완료 / Mac 등 대기**: 취약한 `rsa` 패키지를 제거하고 `ring` RSA SHA-2 인증·호스트 검증으로 대체했다. RSA OpenSSH/PEM/PKCS8, SSH agent·keyboard-interactive/MFA, 선택 복사·우클릭·Backspace 설정, 기본 켜짐 SFTP 경로 따라가기 구현. Windows 감사0건, 실제 OpenSSH 엔진과 WebView2 전체 회귀 종료0. [S.1 검증 기록](verification/security-terminal-basics.md)과 문서 하단 S.1이 정본이며 이전 RSA 차단/잔여1건은 과거 설치본 이력이다. 기존 NSIS는 이번 변경을 포함하도록 재생성하지 않았다. 다음 첫 행동: 병행 U.2 완료 후 최신 소스의 설치본 생성·설치 검사, 이후 실제 OTP/하드웨어 agent·Mac 검증.
- **U.2 구현·Windows 자동 검증 완료 / Mac 대기**: 왼쪽 연결/원격 파일 통합, 공통 버튼 크기, 마우스 리사이즈·접기, 단일/분할 전체화면·선택 창 확대, 분할 입력 모드(개별/모든 창/선택한 창), 로컬·WSL·SSH 입력 그룹. 실제 Windows 로컬/SSH/SFTP/FTP·분리 창 회귀 통과. 최신 실행 파일은 `target/release/daxterm.exe`이며 기존 0.5.1 NSIS 설치본은 U.2를 포함하지 않는다. 아래 U.2 최종 기록 참조.
- **U.1 구현·Windows 실검증 완료 / Mac 대기**: 로컬 PTY·PowerShell/명령 프롬프트·WSL 자동 목록과 Ubuntu 실제 실행, 상단 메뉴/사이드바/단축키 개선. 최신 debug 앱 및 하단 U.1 기록 참조. 후속 W.3의 0.5.1 설치본에 포함했다. Mac 검증은 별도다.
- **W.1~W.4 Windows 구현·자동 회귀 보완 반영 / 공개 출시는 보류**: 2026-11-05 사용자 요청. 데이터 변경/복구, 진단, 보안·릴리스 검사, 분할 포커스 수정 완료. 당시 남은 RSA 의존성1건은 후속 S.1 소스에서 해소했다. 서명/배포 자원, 실제 OS 수동 검증은 남아 있다. Mac은 사용자 요청대로 후순위다. G.2/U.1 변경을 포함한다.
- **W.1~W.4의 기존 0.5.1 설치본 이력**: DB/journal 삭제·스키마 원자성·파일 잠금·설정 복구/진단, 보안 의존성 보완과 릴리스 검사 추가. 당시 RSA 개인키 인증을 차단했으며 현재 소스는 S.1의 안전한 RSA 대체 경로로 변경했다. 실제 수동 항목은 [Windows 체크리스트](verification/windows-release-checklist.md), 복구·검사 절차는 [안정화 기록](verification/windows-hardening.md). 아래 0.5.0 최종 결과도 이전 산출물 이력이다.
- **0.5.1 패키지 검증 완료**: 분할 포커스 수정·편집 복구 manifest 원자적 저장과 U.1/G.2를 포함한 NSIS 9.26MiB. `scripts/test-installer.ps1 -Version 0.5.1 -PreviousVersion 0.5.0 -Reinstall` 종료0: 이전 설치본 교체/버전/일반 파일 보존/동일 버전 재설치/라이선스 고지 포함/실행/종료/제거. 사용자 데이터 이행 전체 성공을 뜻하지 않는다. 설치 SHA256 `CAAE2072D5A89E0633FFF23C32B2792B17A0138792DE15C27198C11DDBA10EBC`, `NotSigned`, 공개 승인 false manifest 동봉. 최종 Windows native 전체 회귀 종료0. 5분 SSH stress와 수동 검증 범위는 마지막 W 기록 참조.
- **G.2 게임 작업 영역 통합 구현·Windows 기능 검증 완료**: 사이드바 목록→중앙 작업 탭, 단색 터미널 스타일, 현재 판 보존/자동 정지/Esc 복귀. 최신 게임 UI 5개·WebView2 4종·실제 SSH 연결 유지/입력 격리 단계 통과. 당시 전체 native 회귀는 split layout에서 실패했으나 후속 U.1의 실제 SSH 전체 회귀가 split 포함 통과했다. Mac은 대기, 후속 W.3의 0.5.1 설치본에 포함했다. 하단 G.2/U.1 기록 참조.
- 추가 테마 요청 **T.1**: 기존 크림색 기본값을 보존한 12개 테마·선택/저장 UI 구현 완료. Windows WebView2 전환/앱 재시작 복원 통과. 실제 SSH 분리 창의 연결 중 테마 동기화도 통과. Mac 테마 검증은 대기. 이 작업의 파일/검증/다음 행동은 아래 T.1과 [테마 검증 기록](verification/themes.md)을 우선 참조한다. 다른 Phase의 진행 상태는 유지한다.
- 범위 정본: [roadmap.md](roadmap.md), 작업 단위: roadmap §4.0.
- 별도 추가 작업 **G.1 기본 미니게임 4종**: 구현·규칙/UI·Windows WebView2 검사 완료. Mac 실기기 검증은 대기. 이 작업은 아래 기존 Phase 검증 상태와 별도로 관리하며 문서 하단 G.1 기록을 참조한다.
- 요청 범위: **남은 Phase 전체(2.1~5.3), 디자인/UI 개선 및 기존 검증 대기 항목**. 2026-11-04 요청으로 범위 확대.
- 현재 상태: **0.5.1 Windows 구현·자동 통합 검증·NSIS 설치/실행/제거 완료**. 데이터 복구/진단·로컬 PTY·게임 통합·테마·분할 포커스 수정을 포함한다. **보안 감사 잔여·서명·수동 OS 검사로 공개 안정판 승인은 보류한다. 전체 Phase5/v1.0 완료가 아니다.**
- 최종 실제 통과: OpenSSH 엔진/5분 반복 연결, Windows WebView2 전체 SSH 회귀·복구 UI, FTP/FTPS/CP949 엔진+WebView2, Rust 앱23개+실증1개·프런트엔드29개·UI20개, typecheck/lint/format/clippy, NSIS 설치본 교체/재설치/실행/제거. 상세 명령은 마지막 W 기록 참조.
- 산출물: `target/release/bundle/nsis/DaxTerm_0.5.1_x64-setup.exe` (9.26MiB, 서명 없는 개인 검증 빌드). 정확한 SHA256은 상단 패키지 기록과 동봉 manifest 참조.
- 남은 작업 ID: **W.3 서명/공개 배포 자원**, **S.1/5.3 최신 설치본 반영·검증**, **W.4/5.1 실제 Windows 수동 체크리스트 M1~M10**, **5.2 Mac 전체**, **5.3 Mac 앱/DMG·설치 및 서명/공증**. RSA Windows 의존성 게이트는 S.1에서 해소했으며 프로토콜별 제한은 README 표를 따른다.
- 다음 첫 행동: 병행 U.2 결과와 함께 최신 설치본을 생성·검증하고 [수동 체크리스트](verification/windows-release-checklist.md)의 M1→M2→M3, 별도 M6의24시간 검사를 진행한다. Mac은 사용자 요청 전 보류한다.

## 2026-11-05 상용 출시 준비도 점검

- 요청: 완료 여부 및 상용 품질 기준의 부족한 점 평가. 제품 코드 변경 없이 roadmap/README/검증 기록과 실제 설정·인증·저장 코드를 대조했다.
- 판단: 핵심 기능을 갖춘 Windows 베타 수준으로 평가하며 상용 안정판/전체 Phase 완료로 판단하지 않는다. 기존 실제 SSH/FTP/설치 성공은 2026-11-04 기록을 근거로 하며 이번 점검에서 재실행하지 않았다.
- 이번 검증: `npm test` 29개 통과, `npm run typecheck` 종료 0. `Get-FileHash -Algorithm SHA256 target/release/bundle/nsis/DaxTerm_0.5.0_x64-setup.exe` 결과가 문서 상단 최종 해시와 일치. `Get-AuthenticodeSignature` 결과 `NotSigned`.
- 확인 파일: `README.md`, `docs/verification/phase-2-5-windows.md`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `package.json`, `src-tauri/src/{ssh,storage,settings}.rs`. 암호/개인키 인증과 제한된 JSON 내보내기를 확인. MFA/SSH agent 미지원 및 폴더 재귀 업·다운로드/전송 예약 큐 미지원은 README에 명시되어 있다.
- 출시 보완 후보(새 구현 범위로 승인된 것은 아님): 서명된 배포·업데이트/이전 버전 복구 절차, 데이터 백업·복원 및 업그레이드 실패 검증, 민감정보를 제거한 진단 내보내기, 의존성 보안/라이선스 점검, 반복 가능한 CI·릴리스 관리. 이 작업 공간은 Git 저장소가 아니며 `.github` 및 프로젝트 배포용 LICENSE/NOTICE 파일은 확인되지 않았다. 기존 audit JSON은 현재 취약성 판정 근거로 사용하지 않았고 새 의존성 보안 감사도 실행하지 않았다.
- 업무 환경 확장 후보: MFA/keyboard-interactive, SSH agent, 점프 호스트, 폴더 전송/큐. 모든 사용자의 출시 필수 조건으로 단정하지 않고 대상 사용자에 따라 우선순위를 정한다.
- 남은 기존 ID: **5.1** 물리 IME·OS 파일 선택/드롭·GUI 편집기·절전/장시간, **5.2** Mac 실기기 전체, **5.3** Mac 배포/설치·공개 배포 서명/공증. 이번에는 실기기·장시간·보안 감사를 수행하지 않았으므로 상태를 변경하지 않는다.
- 다음 첫 행동: Windows 출시 검증을 목표로 5.1의 수동 OS 흐름과 장시간·네트워크 전환·절전 복귀에 대한 재현 조건/합격 기준을 정하고 실제 검증한다. Mac 지원을 출시 범위에 포함하면 5.2를 별도로 완료한다.

## Phase별 상태

| Phase | 상태 | 남은 작업 |
|---|---|---|
| 0 — 기반·기술 실증 | 검증 대기 | 0.4 Mac 기본 빌드·접속 |
| 1 — SSH 실사용 | 검증 대기 | 코드·Windows 자동 실증 완료. 물리 Windows IME와 Mac |
| 2 — SFTP·편집기 | 구현·자동 검증 완료 | OS 파일 선택/드롭·GUI 편집기 수동 조작·Mac 대기 |
| 3 — 멀티 터미널·터널링 | Windows 검증 완료 | Mac 실기기 대기 |
| 4 — 모니터링 | Windows 검증 완료 | Mac 실기기 대기 |
| 5 — 안정화·배포 | 일부 검증 대기 | Windows 자동 검사·설치 통과. 수동 OS·장시간·Mac·서명 대기 |

## 작업별 상태

| ID | 작업 | 상태 | 근거 또는 남은 사항 |
|---|---|---|---|
| 0.1 | 도구·Tauri 초기 구성 | 완료 | 기존 Windows 개발 앱·내장 자산 앱 실행/빌드 |
| 0.2 | 토큰·라이트 테마·마스코트·레이아웃 | 완료 | 1개 테마·토큰 계약, 좁은 창·포커스 검사. Phase 1에서 htop ANSI 배경 대비 보정 |
| 0.3 | OpenSSH·인증·호스트키·PTY 실증 | 완료 | 실제 Linux OpenSSH 비밀번호·일반/암호화 키·키 거부·PTY·resize |
| 0.4 | SFTP·포워딩 실증·엔진 결정 | 검증 대기 | Windows 결과와 ADR 유지. Mac만 미실행 |
| 1.1 | 안전한 SSH 터미널 | 검증 대기 | 실제 제품 엔진+Windows 앱 인증/신뢰/키 차단/PTY/TUI 통과. 물리 IME·Mac 대기 |
| 1.2 | 세션·DB·OS 보안 저장소 | 검증 대기 | Windows CRUD·그룹·검색·즐겨찾기·최근·재실행·Credential Manager 검증. Mac Keychain 대기 |
| 1.3 | 다중 탭·재접속·편의 기능 | 검증 대기 | Windows 5개 연결·클립보드·TUI·KeepAlive 단절·재접속·정상 종료/원격 셸 정리 통과. 물리 IME·Mac 대기 |
| 2.1 | SFTP 탐색·파일 관리 | Windows 검증 완료 | 실제 엔진 및 native CRUD·권한·복사/이동/삭제·압축 |
| 2.2 | 파일 전송·취소·오류 | 수동 검증 대기 | SFTP128MiB/FTP32MiB 재개·바이트 일치·복구 통과. OS 드롭/파일 선택·Mac 대기 |
| 2.3 | 외부 편집·충돌·복구 | 수동 검증 대기 | 외부 실행 파일 지정·저장 확인/취소/재시도/자동 업로드 native 통과. GUI 제품 수동 조작·Mac 대기 |
| 3.1 | 분할·탭 이동·레이아웃 저장 | Windows 검증 완료 | 분할/resize/독립 입력/배치 복원. Mac 대기 |
| 3.2 | 독립 창·구독·테마 동기화 | Windows 검증 완료 | 실제 창 분리·소유권·출력/종료 및 연결 중 테마 동기화 |
| 3.3 | Local/Remote 터널 | Windows 검증 완료 | Local/Remote 실제 왕복·포트 충돌·종료 해제 |
| 3.4 | SOCKS5·재연결·JSON | Windows 검증 완료 | SOCKS5 도메인 왕복·설정/JSON·스키마 검사 |
| 4.1 | 지표 수집·작업 관리 | Windows 검증 완료 | 실제 Linux 독립 채널 수집·차분·종료 |
| 4.2 | 상태바·패널·차트 | Windows 검증 완료 | WebView2 실차트·상태바·활성 연결, Mac 대기 |
| 5.1 | Windows 종합 검증 | 수동 검증 대기 | 최신 자동 회귀 통과. 물리 IME·OS 조작·장시간·절전 대기 |
| 5.2 | macOS 종합 검증 | 환경 대기 | Mac 실기기 부재. Windows/Mock으로 대체하지 않음 |
| 5.3 | 설치·릴리스 | Mac·공개 배포 대기 | Windows0.5.0 NSIS 설치/실행/종료/제거 통과. Mac/서명·공증 미실행 |

## 구현과 주요 계약

- `src-tauri/src/{lib,commands,ssh,hostkeys,storage,credentials}.rs`: 실제 제품 엔진. 프로필/연결/탭 ID 분리, russh PTY, cancellation, KeepAlive, 시간 제한, 최초 지문·known_hosts·변경/폐기 키 차단.
- `src-tauri/build.rs`, `src-tauri/capabilities/main.json`: 명령 allow 권한 자동 생성, main 및 terminal-* 창만 허용. file/shell/network plugin 권한 없음.
- 출력은 32KiB 한 프레임을 xterm 렌더 완료 ACK 후 다음 프레임으로 전달. 수신 window·입력 큐·프런트엔드 대기 입력 상한이 있다. 재접속은 새 ID/새 셸/터미널 초기화이며 명령을 재실행하지 않는다.
- SQLite schema 3, WAL, foreign keys. 비밀번호/Passphrase는 native keyring, DB에는 참조만 저장한다. credential 참조 정리 journal로 DB 실패 시 이전 비밀 참조를 보존하고 미참조 비밀은 재정리한다. 세션 복제는 credential을 복제하지 않는다.
- `src/app/`, `src/components/Dialog.tsx`, `src/features/sessions/`, `src/features/terminal/`, `src/lib/ipc.ts`: 폼·목록·그룹·필터, 독립 탭, 신뢰 확인, 연결 상태, 검색·복사/붙여넣기·글꼴·스크롤백.
- `src/themes/`: 공통 토큰과 기본 Classic을 유지하며12개 테마 제공. htop의 ANSI black-on-green/blue/cyan과 일반 ANSI-on-light 모두 4.5:1 테스트. 서버 truecolor는 그대로 둔다.
- `src-tauri/examples/phase1_probe.rs`, `scripts/{run-phase1,test-native}.mjs`: 실제 제품 엔진과 Windows WebView2 앱 통합 테스트. 디버그에서만 격리된 데이터 경로·CDP 포트를 설정한다. 릴리스는 테스트 환경변수를 무시한다.
- 상세 결정: [ADR 0002](adr/0002-phase1-client.md). Phase 0 실증/선택 근거는 [ADR 0001](adr/0001-ssh-engine.md)과 [기존 Windows 기록](verification/phase-0-windows.md)에 보존.
- 이 작업 공간은 Git 저장소가 아니므로 init/commit은 수행하지 않았다.

## 최종 검증

상세: [Phase 1 Windows](verification/phase-1-windows.md).

- `npm run typecheck`, `npm run lint`, `npm run format:check`: 통과.
- `npm test`: 테마 계약/폴백/대비 3개 통과.
- `npm run test:ui`: 6개 통과. 1280/800/560px, 포커스, 대체 테마, 폼 접근성·실패 시 비밀 입력 제거.
- `npm run build`: 통과. 메인 번들 크기 경고(압축 전 약 613KB)는 남는다.
- `cargo fmt --all --check`: 포맷 보정 후 통과.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: 통과.
- `cargo test --workspace --locked`: 앱 6개 + 기존 실증기 1개 통과.
- `cargo build --workspace --locked`: 실행 중 EXE 잠금 오류 후 앱 종료 상태에서 재실행 통과.
- `npm run tauri -- build --debug --no-bundle`: Cargo PATH 설정 후 최종 재빌드 통과. `target/debug/daxterm.exe`에 내장 자산 실행 파일 생성.
- `npm run test:native`: 종료 코드 0. 내장 자산 네이티브 빌드, 실제 제품 엔진, 실제 Windows UI·OpenSSH 모두 통과. 비밀번호/RSA SHA-2/일반·암호화 Ed25519/잘못된 인증/키 변경·폐기/5개 연결/UTF-8/resize/흐름 제어/OS 저장소/단절·재접속/클립보드/정상 종료와 원격 셸 정리 포함.
- 네이티브 `vim` 한글 저장 파일을 서버에서도 검사했고 `top`/`htop` 화면과 대비를 스크린샷으로 확인했다. 물리 IME가 아니라 composition 이벤트를 재현한 자동 테스트다.
- 일회성 테스트 컨테이너 제거 및 DaxTerm 테스트 프로세스 종료 확인. 테스트 인증정보를 문서/로그에 기록하지 않았다.

## 실패 해결·제한·다음 행동

- 해결: known_hosts comment 비교 오류 → 키 데이터만 비교. DB 실패 시 OS 비밀 손실 위험 → 참조 journal. select 접근성/초기 focus 보정. 접속 중 취소의 host prompt도 함께 취소. 재접속 시 TUI 상태 초기화.
- 환경/테스트 보정: WebView2 CDP는 debug 창 설정으로 전달. fixture는 C.UTF-8로 설정(ASCII 셸은 한글 입력을 해석하지 못함). htop 검사는 이전 top 텍스트와 구분되는 footer를 기다린다.
- Windows 빌드/테스트는 같은 EXE를 동시에 사용하지 않는다. Cargo는 현재 PowerShell PATH에 없을 수 있으므로 `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`를 먼저 설정한다. `probe:phase1`과 `test:native` wrapper는 자체 처리한다.
- **남은 1.1/1.3 Windows 물리 IME**: 실제 Microsoft IME 조합/확정/받침/삭제·vim·탭 전환·resize를 확인한다. 자동 composition 성공으로 대신 완료 처리하지 않는다.
- **남은 0.4/1.1~1.3 Mac**: Mac 실환경 부재. [Mac 절차](verification/phase-1-macos.md)를 실행하고 Keychain·접속·클립보드·IME 결과를 별도로 남긴다.
- 미지원: host certificate, keyboard-interactive/MFA, SSH agent. 저장소 실패 시 평문 fallback 없음. SFTP·분할·분리 창·터널·모니터링·설치 패키지는 후속 Phase 범위.
- 현재 요청한 Phase 1의 추가 코드 항목은 남아 있지 않다. 환경이 필요한 검증만 대기로 남겼으며, Phase 1 전체 완료로 보고하지 않는다.

## 변경 기록

- 2026-11-04: 단계별 로드맵·작업 ID·이어하기 규칙 작성.
- 2026-11-04: Phase 0 Windows 기반 구성·실제 OpenSSH/SFTP/포워딩 실증·비교 ADR 완료. Mac 0.4 대기.
- 2026-11-04: Phase 1.1~1.3 전체 구현·Windows 자동/네이티브 검증. 물리 Windows IME 및 Mac은 검증 대기. Phase 2는 미착수.

## 2026-11-04 후속 Phase 구현 상세 (진행 중)

- 추가 Rust: `sftp.rs`, `editor.rs`, `windows.rs`, `tunnels.rs`, `settings.rs`, `monitoring.rs`, `encoding.rs`. `ssh.rs`는 인증된 연결의 독립 채널과 창별 출력 Broker를 제공한다. `workspace.rs`와 IPC capability를 연결했다.
- 추가 React: SFTP FilePanel, TunnelPanel, MonitorBar, DetachedWindow, 공통 Icon/ResizeHandle. App은 토큰 기반 시작 화면·패널 조절·분할·설정 입출력으로 개편했다.
- 출력 Broker는 최근 최대 2MiB만 인계 재생하며, 단일 소유 창만 input/resize/ACK를 허용한다. 장시간 출력 전체 기록 저장을 의미하지 않는다.
- 파일 전송은 무변환 스트리밍, 새 파일 전용(no-clobber), 최대 4개 동시 전송. 취소는 원격 staging 삭제를 시도한다. 네트워크 단절로 삭제할 수 없는 staging은 서버에 남을 수 있다.
- 외부 편집은 사용자 전용 ACL/0700 폴더, SHA-256 변경 확인, posix-rename 확장 사용. 미지원 서버에는 다른 이름 저장 제공. 확인~교체 사이 원격 경쟁은 일반 SFTP로 제거할 수 없다. 실패/충돌 복구본을 자동 삭제하지 않는다.
- 터미널 인코딩은 세션별 UTF-8 기본, CP949/EUC-KR, Shift_JIS, GBK, Big5, Windows-1252. 입력 인코딩 불가 문자는 거부. 외부 편집 원본 유지/명시적 변환은 별도 옵션이다. SFTP 이름은 UTF-8만 지원하며 대체문자 감지 시 안전하게 실패한다.
- 마지막 완료 검사(이후 추가 수정은 최종 재검증 필요): `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked`(앱 9+실증 1), `npm run lint`, `npm test`(3), `npm run build`, `npm run test:ui`(6), `npm run probe:phase1` 통과. 인코딩 추가 후 테스트 개수는 증가하며 아직 최종 실행 전이다.

## 최신 사용자 범위 추가 (2026-11-04)

- 남은 Phase 전체 진행을 유지하면서 파일 기본기(복사/이동/붙여넣기/압축/해제/다중 선택), 외부 편집 업로드 확인·자동 업로드·취소, 멀티 입력, FTP와 FTP/SFTP 재개 전송까지 요청됨. roadmap §10에 체크리스트를 추가했다. 아직 이 추가 항목들은 구현 완료가 아니다.
- 현재 진행 중: 네이티브 최종 검사 세션(기존 UI/SSH/SFTP/모니터/분리창). Windows 0.4.0 NSIS 패키지 8.17MiB를 한 번 생성했으나 추가 범위 이후 재빌드 필요. 설치 검증은 아직 미실행. 기존 DaxTerm 설치 레지스트리 항목은 발견되지 않았다.
- 분리창 실제 인계·입출력은 확인됨. close 시 page.evaluate가 정상적으로 끊기는 테스트 harness를 수정했다. Native CP949 검사는 일부 키 타이밍이 흔들려 키 입력 간격과 shell echo/reader ready 동기화를 보강했다. 최종 성공은 실행 결과를 확인하고 기록할 것.
- 현재 SQLite schema2로 올려 인코딩·설정이 추가된 DB를 이전 앱이 쓰지 않게 했다. v1 자동 이행 확인 필요.

## G.1 — 기본 미니게임 4종 (2026-11-04)

- 사용자 요청: MobaXterm처럼 테트리스부터 여러 기본 게임을 앱에 탑재. 이 세션은 G.1만 구현하며 기존 Phase/추가 파일 기능의 완료 상태를 대체하지 않는다.
- 구현: `src/features/games/engines.ts`의 블록 퍼즐·스네이크·2048·지뢰찾기 규칙, `GamesDialog.tsx`와 `games.css`의 선택 화면·조작·점수/기록·도움말. `src/app/App.tsx` 상단 게임 버튼과 lazy import, 닫기 후 포커스 복귀. `Dialog.tsx` 선택적 className, `Icon.tsx` 게임 아이콘.
- 공통 테마 CSS 변수만 사용. 추가 패키지/원격 서비스/IPC/SSH 명령 없음. 게임 JS는 클릭 시 별도 로딩(빌드 기준 약 16KB, gzip 약 5.7KB). 지뢰찾기는 9×9/10개, 첫 칸과 주변 안전. 블록 퍼즐은 7종 묶음·회전·착지 미리보기·줄/레벨, 2048은 달성 후 계속하기 지원.
- 기록: `daxterm.games.v1.*`에 숫자만 저장. 지뢰찾기는 승리 시 최소 열기 횟수. 저장 실패 시 플레이 유지. 현재 판은 게임 전환/닫기에 종료됨을 화면에 안내한다.
- 타이머/입력: 게임판 포커스에서만 방향키/Space 처리. 모달 밖 터미널은 inert. 실시간 게임은 창 blur/문서 hidden 또는 게임 영역 이탈 시 일시정지, 수동 계속하기. 전환/닫기에 interval/listener 정리. 지뢰찾기는 방향키·Enter·F 및 우클릭, roving tabIndex 제공.
- 검증 완료: `npm run typecheck`, `npm test`(전체 18개, 게임 12개), `npm run lint`, 변경 파일 대상 ESLint/Prettier 검사, `npm run build` 통과. 기존 메인 번들 500KB 경고는 남음.
- UI: `npx playwright test tests/ui/games.spec.ts` 3개 통과(1280/560px, 4종 조작, 일시정지, blur, 저장/새로고침, Esc/포커스 복귀, 터미널 미리보기 격리). `npm run test:ui` 최종 전체 시도는 8개 통과/기존 대체 테마 검사 1개 실패; 해당 검사를 단독 재실행하여 통과. 검사 중 다른 작업의 테마 store 파일 변경이 관찰되어 전체 9개 동시 통과로 기록하지 않는다.
- 수정한 실패: 지뢰찾기 테스트 locator가 바뀐 접근성 이름을 찾지 못하던 오류는 고정 위치 locator로 보정. lazy 모달 종료 후 실행 버튼 포커스 소실은 App의 명시적 복귀로 수정하고 재검증.
- Windows: `npm run tauri -- build --debug --no-bundle` 최종 빌드 통과, `target/debug/daxterm.exe` 생성. 중간에 다른 작업의 `vault.rs` 컴파일 오류로 1회 실패했으나 해당 파일 수정 후 재시도 성공. 이 게임 작업에서 Rust 소스는 수정하지 않았다.
- 실제 WebView2: `node scripts/test-games-native.mjs` 종료 코드 0. 격리된 로컬 데이터로 내장 자산 앱에서 4종 게임·키 조작·일시정지·닫기 포커스 복귀·새로고침 후 기록 유지 통과. 스크린샷 `test-results-native/games.png`의 실제 배치 확인. 테스트 소유 앱은 종료하고 임시 데이터는 실패 진단용으로 유지한다.
- 미검증: Mac 실기기 부재로 macOS 게임 UI 검증 대기. SSH/SFTP 실접속 회귀와 설치 패키지 재생성은 이 게임 작업에서 수행하지 않았으며 기존 Phase 2~5 대기 기록을 유지한다.
- 남은 G.1 항목: Mac 실기기 UI 검증만 대기. 다음 첫 행동은 Mac에서 G.1 키 조작/일시정지/기록/닫기 동작을 실제 앱에서 확인하는 것. 설치 패키지를 만들 때 최종 게임 자산을 포함해 다시 빌드한다(기존 5.3 작업). 기존 Phase 2~5/roadmap §10의 다른 요청은 해당 작업 기록을 따라 계속한다.

## 최신 검증 및 마스터 패스워드/멀티 입력 (2026-11-04)

- 이전 실행 `npm run test:native` 전체 종료 코드 0: 제품 엔진, CP949 실제 송수신, SFTP, 모니터, 2×2 분할, 분리 창 인계/종료까지 모두 통과. 첫 실행의 WebView2 환경 불일치·tokio 런타임 문제와 CP949 입력 타이밍을 수정했다.
- 추가 구현: `vault.rs`, `VaultDialog.tsx`, SessionForm/App 연결. 선택적 마스터 패스워드 Argon2id(32MiB/3회/1lane) + AES-256-GCM, OS credential ciphertext, SQLite에는 감싼 키와 salt만 저장. 마스터 초기 설정 시 copy-on-write OS 항목 + DB 원자적 참조 전환 + 이전 항목 GC. 5분 해제/수동 잠금, 재시작 잠김, 매번 재인증하는 암호 보기/30초·창 포커스 상실 시 숨김. SQLite schema3.
- `cargo test --workspace --locked`: 앱 13개 + 실증기 1개 통과(마스터 암호/nonce/변조/AAD/만료 테스트 포함). `npm run typecheck`, `npm run lint` 통과. 이후 멀티 입력 추가 및 최신 테스트는 다시 확인 필요.
- `broadcast.rs`, `BroadcastControl.tsx`: 연결 ID를 명시적으로 선택한 그룹, 분리 창 공통 적용, 대상 종료 시 전체 그룹 해제, 새 연결 ID 자동 포함 금지, 모든 대상 encoding/queue reservation 선검사. 실제 두 대상만 입력 및 종료 시 해제 검사를 native harness에 추가.
- 현재 `npm run test:native` 재실행 중. 마스터 이행 DB rollback/OS 잔여 항목 정리와 UI 설정/보기/잠금/변경/재시작 연결 검증을 추가했다. 아직 이 추가 검사 성공으로 기록하지 않는다.
- 남은 확장: 외부 편집 ask/auto/manual 업로드 및 active cancel, 파일창 기본기/압축, FTP/FTPS와 FTP/SFTP 재개. 기존 Mac/물리 IME/설치 검증 대기는 유지.

## T.1 — 기본 화면 보존 및 테마 12종 (2026-11-04)

- 요청: 처음부터 테마 적용이 가능하게 되었는지 점검하고 현재 모습을 기본으로 화이트/다크/레트로/터미널 등 유명 테마를 참고해 추가. 기존 단일 테마 방침은 roadmap §2.6으로 확장하고 AGENTS/README에 반영했다.
- 점검 결과: 공통 계약/레지스트리/CSS·xterm·차트 어댑터/터미널 테마 갱신은 있었지만 테마가 하나뿐이고 설정의 선택/쓰기 경로가 없었다.
- 구현: `src/themes/{contract,registry,store,useTheme,ThemePicker}.ts(x)`, `picker.css`, `presets/{light,create,collection}.ts`, `adapters/css.ts`, `src/main.tsx`, `src/app/App.tsx`, `src/components/Dialog.tsx`. Classic(기존 ID 유지), GitHub White/Dark, Dracula, Nord, Catppuccin Mocha, Gruvbox Light/Dark, Solarized Light/Dark, Terminal Green/Amber. 미리보기 카드·즉시 반영·자동 저장·창 간 storage 동기화·시작 전 적용·ID 폴백·저장 실패 표시·기본 컨트롤 color-scheme 제공. 열린 xterm은 재생성하지 않는다.
- 기존 크림색 표면/마스코트/배치는 유지. 보조 텍스트만 선택 배경 대비 4.5:1을 위해 #606970 → #5F686F 미세 조정. 추가 테마는 공식 팔레트를 참고한 DaxTerm 변형이며 대비 보정과 출처는 `docs/verification/themes.md`에 기록. 서버 truecolor는 바꾸지 않는다.
- 테스트 파일: `src/themes/theme.test.ts`, `tests/ui/{themes,layout}.spec.ts`, `scripts/test-themes-native.mjs`. Dialog는 선택한 radio 우선 포커스/닫기 후 실행 버튼 복귀 보정.
- 검증 완료: `npm test` 29개(테마 14개), `npm run typecheck`, `npm run lint`, 변경 파일 Prettier 검사, `npm run build` 통과. 기존 500KB 번들 경고 유지. `npm run test:ui` 전체 15개 통과(테마/레이아웃/게임). 기존 G.1 기록의 단독 성공/전체 실행 중 변동과 별개로 이 시점의 전체 결과다.
- Windows: `npm run tauri -- build --debug --no-bundle` 통과. `target/debug/daxterm.exe` 내장 자산 갱신. `node scripts/test-themes-native.mjs` 종료 코드 0: 실제 WebView2에서 12개 전환/기존 xterm 유지·배경 반영/Escape 포커스/전체 앱 종료 후 테마 복원 통과. `test-results-native/themes.png`, `theme-<id>.png` 생성, 선택창과 초록 터미널 시각 확인. 테스트 소유 앱 종료, 격리된 데이터만 진단용 유지.
- 브라우저 여러 페이지 동기화/새 창/재로드/삭제·알 수 없는 ID/저장 실패, 1280·560·360px 키보드·넘침 검증 통과. 실제 네이티브 SSH 분리 창 검증으로 대체하지 않는다.
- 미검증: 실제 SSH 연결을 유지한 테마 전환/분리 창/실수집 차트(3.2/5.1), macOS 테마·글꼴·동기화(5.2), 최종 설치 패키지 재생성/설치(5.3). 이 테마 작업에서 Rust 코드는 수정하지 않았고 SSH/파일 엔진 회귀를 새로 실행하지 않았다. 기존 미완료 Phase/추가 사용자 요청 상태를 완료로 바꾸지 않는다.
- 남은 ID: **T.1 네이티브 SSH 분리 창·Mac 검증**, 기존 **3.2/5.1/5.2/5.3** 및 다른 작업 기록의 미완료 항목. 다음 첫 행동: Windows 실제 SSH를 열고 분리 창을 만든 뒤 설정에서 테마를 전환하면서 양 창의 입력·출력 유지와 차트 색상 반영 확인 → Mac에서 동일 검증 → 최종 패키지에 새 자산 포함.

## 파일 기본기 및 재개 전송 확대 (2026-11-04, 계속 진행 중)

- 마스터 보관함 및 멀티 입력 native 재검증 종료 코드 0. 설정/이행/잘못된 암호 거부/보기와 숨김/변경/재시작 후 해제 및 실제 SSH 접속, 선택된 2개 연결에만 입력/대상 종료 시 그룹 해제 통과. 새 master 변경은 데이터 키도 교체하고 이전 OS 참조를 GC한다.
- `editor.rs`/FilePanel: ask 기본·auto·manual, 저장 확인/취소·보존, 진행 중 업로드 취소, 편집기 실행 파일 picker. 확인/수동 모드에서 원격 불변 및 승인/자동 전송 실제 엔진 통과. Python helper를 이용한 실제 GUI 외부 편집기는 별도 검증 필요.
- `file_ops.rs`: 다중 파일/폴더 복사, 잘라내기·붙여넣기, 이동, 재귀 삭제, 새 파일, 다중 chmod. 메모리 클립보드(창 공유), Ctrl/Cmd+C/X/V/A, F2/Delete/F5, 컨텍스트 메뉴, 이름 검색/정렬. 심볼릭 링크 복사는 지원하지 않고 따라가지 않는다.
- `archive.rs`/`archive_helper.py`: Linux SSH/Python 3 기반 ZIP/TAR/TAR.GZ 압축·해제, 새 대상만, renameat2 NOREPLACE, 링크/장치/상위경로/절대경로/중복 거부, 항목·해제 크기 제한, ZIP CP949/CP932/GBK/Big5 파일명 옵션(Python3.11+). `npm run probe:phase1` 실제 서버 복사/폴더 복사/기존 대상 거부/하위 경로 거부/3형식 왕복/위험 ZIP 거부 통과.
- SFTP 전송을 일시 중지+부분 파일 보존으로 변경. 재개 시 원본 size/mtime 및 부분 파일 전체 바이트 비교. SQLite에 복구 계획 저장, 재시작·동일 프로필/대상 재연결, 부분 파일 명시적 폐기. 128MiB 업로드/다운로드 중지·재개/부분 내용 불일치 거부/바이트 일치/최종 staging 정리 실제 probe 통과. 전송 계획 재시작 복구 검증은 아직 추가 필요.
- 현재 FTP/명시적 FTPS 통합 진행 중: suppaftp12.2.1(로그 비활성), OS TLS/추가 CA·호스트명 검증, UTF8 및 레거시 파일명 인코딩, Binary/PASV peer 고정. 세션 protocol/TLS CA 필드, FTP 전용 파일 화면, 공유 전송 계획에 REST 재개 연결 중. FTP 실제 fixture는 아직 미실행이며 완료 아님.
- 최신 FTP/재개 변경 이후 전체 native/build/clippy/UI 회귀 및 최종 설치 패키지 재생성 필요. Mac 실기기/물리 Windows IME 대기 유지. 이전0.4.0 패키지는 최신 변경을 포함하지 않는다.

## FTP/FTPS 실제 검증 및 종료 처리 (2026-11-04)

- `npm run probe:ftp` 종료 코드 0: FTP UTF8/명시적 FTPS UTF8/FTP CP949 각각 32MiB 업로드·다운로드 중지와 REST 재개, SQLite 복구 계획 로딩, 최종 바이트 일치, 한글/공백 이름 및 복사·이동·삭제. 임시 서버/자격 증명/키는 테스트 후 제거.
- FTPS를 Rustls+OS CA로 구현. 추가 PEM CA를 합치며 hostname/인증서 검증을 유지하고 평문 fallback 없음. 미신뢰 CA 거부 검증. native TLS의 Windows 종료 지연 문제 해결.
- FTP 취소 시 TLS close_notify와 완료 응답을 기다려 서버 파일 핸들을 닫은 뒤 paused 상태로 전환. 종료 응답은 최대20초, 부분 파일 보존. 갑작스러운 단절은 별도 재접속/검증 필요.
- 목록·존재 확인은 4MiB/20,000개 상한과 선택 인코딩의 엄격한 경로 검증. 파일 패널 영역에만 OS 드롭을 적용하도록 ref 연결 수정.
- 0.5.0으로 버전을 정렬했으며 `npm run test:native` 최신 빌드/통합 검사 진행 중. 아직 이 새 실행의 성공으로 기록하지 않는다.

## 최종 0.5.0 Windows 결과 (2026-11-04)

- 최종 명령: `npm run test:native` 종료0, `node scripts/run-ftp.mjs --native` 종료0, `cargo test --workspace --locked` 앱14+실증1 통과, `cargo clippy --workspace --all-targets --locked -- -D warnings`/`cargo fmt --all --check` 종료0. 프런트엔드29개·UI15개 통과, 최종 typecheck는 Tauri beforeBuild `tsc -b` 포함. `npm run lint`, `npm run format:check` 통과.
- `npm run tauri -- build --bundles nsis` 종료0. 최신 installer에 `./scripts/test-installer.ps1` 종료0: UUID 경로 설치, registry/PE version0.5.0, 실제 창 초기화·정상 종료·제거. 기존 설치가 있으면 테스트를 거부한다. 설치 EXE SHA256 `C60162F5BA7E4B9F375455626AEE124A1963B8BF4B8599505F79D0EE3AE32FFF`.
- 주요 파일: `src-tauri/src/{vault,broadcast,ftp,sftp,file_ops,archive,editor,workspace,storage,ssh,windows,tunnels,monitoring,settings}.rs`, `archive_helper.py`, `src/features/{sessions,sftp,terminal,monitoring,tunnels}`, `src/app/{App.tsx,styles.css}`, IPC·capability·Cargo/package lock. 게임/12개 테마의 다른 작업 변경을 보존했다.
- 추가 보완: 비밀번호 검증 중 blur가 발생하면 늦게 도착한 복호화 결과를 표시하지 않는 epoch guard(native 검증). 재개 계획 저장 실패 시 running 대신 paused 복원. FTP 파일명 인코딩까지 대상 서명에 포함해 잘못된 경로 재개 방지.
- 최종 native: 권한640 반영, ZIP 압축/해제, 외부 Node 실행 파일 저장→확인·취소·보존→재시도·자동 업로드, CP949 정확한 바이트, 멀티 입력·분할·분리 창, 테마 동기화·연결 유지, 마스터 이행/보기/변경/잠금/재시작. FTP/FTPS 폼·파일창·컨텍스트 복사·다중 삭제·바이너리 업로드·800px 통과.
- 시각 확인: `test-results-native/files-editor.png`, `ftps-files.png`, `detached-window.png`, `workspace-monitoring.png`. 파일 선택 영역 높이 고정으로 더블클릭 위치 유지, FTP 전체 너비 반영. 암호 표시 화면은 캡처하지 않는다.
- 패키지 경고: 메인 JS 약693KB/193.8KB gzip으로 Vite500KB 경고가 남지만 빌드 실패는 아니다. 공개 코드 서명 없음.
- 남은 작업 및 다음 행동은 문서 맨 위가 정본이다. 이전 기록의 진행 중·미실행은 해당 시점 이력이다. Mac·물리 IME·OS 드롭/파일 선택·GUI 편집기 수동·절전/장시간 결과는 없고 자동 검사로 대신 완료 처리하지 않았다.

## G.2 — 게임 작업 영역 통합 (2026-11-05)

- 사용자 요청: 별도 팝업을 없애고 사이드바에서 게임을 선택해 터미널 내부 작업 영역에서 실행. 게임 전용 장식을 줄인다. 기존 G.1의 상단 버튼/모달/게임 전환 시 판 초기화 계약은 이 기록과 roadmap §11로 대체한다.
- 구현 파일: `src/app/App.tsx`, `src/app/styles.css`, `src/features/games/{catalog.ts,GamePane.tsx,games.css}`. `GamesDialog.tsx`는 `GamePane.tsx`로 교체. 규칙 엔진 변경 없음. 사이드바 기본 접힌 목록, 게임별 중복 없는 작업 탭, 단색 터미널 토큰/고정폭 글꼴, 게임 탭 간 현재 판 보존, 숨김/포커스 이탈 시 일시정지, Esc 작업 복귀, 탭 닫기 시 판 종료. 숨긴 SSH/xterm은 마운트를 유지하고 inert/active로 입력을 격리한다.
- 검증 파일: `tests/ui/games.spec.ts`, `scripts/test-games-native.mjs`, `scripts/test-native.mjs`의 `embedded games preserve SSH` 단계. 실제 SSH가 게임 중 출력한 텍스트·동일 연결 ID·게임 키가 원격 read 입력으로 전달되지 않음을 검사한다. `README.md`와 roadmap §11 사용법 갱신.
- 현재 통과: `npm run build`(tsc 포함), `npm test` 29개, `npm run lint`, 초기 `npm run format:check`, `npm run test:ui` 16개. 이후 선택한 게임 탭 자동 스크롤 변경으로 게임 UI 4개 재실행 통과, 다크 테마/판 보존 추가 1개 통과. 360/560/1280px 넘침·키 조작·최고 기록·현재 판 보존·숨긴 타이머 정지·닫기·기존 xterm 인스턴스 유지 포함. `cargo fmt --all --check` 통과. 500KB 번들 경고는 기존 제한.
- 병행 U.1/W 작업이 동일 워크스페이스를 수정 중. 이후 전체 format 검사는 당시 `App.tsx`, `ToolbarMenu.tsx`, `session.ts` 형식 경고로 실패. 게임 파일/게임 검증 스크립트 대상 Prettier 검사는 통과. 병행 작업의 코드/문서 변경을 유지한다. 최신 보기 메뉴에 게임 UI 테스트의 미리보기 진입 경로도 맞췄다. 이후 `npx playwright test tests/ui/games.spec.ts` 최신 게임 UI 5개 모두 통과했다.
- Windows: 첫 내장 자산 디버그 빌드 통과. 최신 병행 변경 재빌드에서 `maintenance.rs`의 SQLite COUNT를 usize로 읽는 FromSql 오류 2건을 발견해 Diagnostics profiles/groups 필드만 i64로 보정했다(직렬화 숫자 계약 유지). 이후 `npm run tauri -- build --debug --no-bundle` 종료 0, `node scripts/test-games-native.mjs` 종료 0: 실제 WebView2 4종 플레이·키보드·일시정지·Esc 작업 복귀/포커스·판 유지·탭 닫기·기록 재로드 통과. `test-results-native/games.png` 실제 화면 확인. 테스트 소유 앱 종료. 실제 SSH 결과는 다음 항목 참조.
- 실제 SSH: `node scripts/run-phase1.mjs --native --reuse-build` 첫 실행은 Docker exec 오류로 fixture 준비 중 종료 1(검사 미실행), 재실행은 실제 OpenSSH 인증 후 `embedded games preserve SSH` 통과. 게임 중 백그라운드 서버 출력, 동일 연결 ID, 방향키/Space가 원격 read 입력에 섞이지 않음, 복귀 후 명령 실행을 확인. `test-results-native/games-with-ssh.png` 확인. 5개 연결/개별 종료·멀티 입력·SFTP/모니터링·파일/편집기·CP949도 통과했으나 **뒤의 split layout 단계에서 기대 출력 불일치로 전체 명령 종료 1**. `failure.png`에서 첫 pane에 `sprintf: command not found`가 보임. 분할 실패 원인은 이번 G.2에서 확정하지 않으며 전체 native 성공으로 보고하지 않는다. 테스트 앱·격리된 자격 증명/데이터 및 전용 fixture 정리 완료.
- 최종 산출물: `target/debug/daxterm.exe` 내장 자산 개발 빌드. 기존 release/NSIS는 이번 G.2를 포함하도록 재생성하지 않았다. 게임 소스의 규칙 엔진·추가 IPC/의존성 변화 없음. 빌드를 막았던 진단 COUNT 타입만 선행 보정했다.
- 미검증/남은 ID: **G.2 Mac 실기기 UI 검증**, **W/U.1/5.1 전체 native split layout 실패 재현**, **5.3 최신 설치 패키지 재생성**. Mac 환경 부재 및 요청 범위에 따른 미실행으로 기록한다. 다음 첫 행동: Windows 회귀 담당은 다른 네이티브 자동화와 실행 앱을 겹치지 않게 한 뒤 split layout의 셸 입력/포커스와 기대 출력을 재현·해결한다. G.2 자체 후속은 Mac에서 탭/포커스/키 조작을 검증하고 최종 패키지에 새 자산을 포함하는 것이다.


## U.1 — 로컬 터미널·자동 탐색·상단 메뉴/사이드바 (2026-11-05)

- 요청: 서버 등록 없이 로컬 터미널 열기, WSL 자동 목록, Mac 기본 터미널, 상단 메뉴·사이드바의 편의/접근성 개선. roadmap §12에 별도 범위로 반영. G.2 및 병행 W.1~W.4 변경을 보존했다.
- 구현 파일: `src-tauri/src/local.rs`, `lib.rs`, `build.rs`, capability/자동 생성 권한, `Cargo.toml`/`Cargo.lock`(portable-pty0.9.0). Windows ConPTY·Unix PTY. Windows PowerShell/명령 프롬프트/표준 Program Files 경로의 PowerShell7, `wsl --list --quiet` UTF16/UTF8 목록(5초 제한). WSL 실행 인자는 배열로 전달하고 선택한 배포판 홈에서 기본 사용자로 실행. macOS는 portable-pty의 SHELL/계정 DB 조회로 기본 로그인 셸을 선택한다. 탐색만 자동, 실행/설치/WSL 기본값 변경은 하지 않는다.
- 자원 계약: 네이티브에서 발견한 ID만 열기, UUID/크기/32개 상한 검증, 입력16개 큐/메시지16KiB, 출력32KiB 한 프레임 ACK. reader/writer/child wait 분리, ConPTY 닫기 중 남은 출력을 비우고 ACK 대기를 깨움. 탭/앱 종료 및 자연 exit 정리. 임의 실행 파일·인자 입력 IPC와 인증정보 저장 없음. 사용자 셸 자체의 이력 정책은 변경하지 않는다.
- 프런트: `src/features/terminal/session.ts`의 로컬 transport 분기와 기존 xterm/검색/클립보드/테마 재사용. `App.tsx`, `styles.css`, `ToolbarMenu.tsx`, `BroadcastControl.tsx`: 상단 로컬 선택기·보기/도구 메뉴, 사이드바 로컬 목록·새로고침·저장된 연결 분리, 사이드바 접기 저장, Ctrl/Cmd+Shift+L/N/B/F, 메뉴 Escape/바깥 클릭·단축키 도움말, 탭 방향키/Home/End. 메뉴를 접어도 멀티 입력 활성 표시 유지. 분할 상태 새 연결을 보이는 첫 슬롯에 배치. 로컬 탭에서 SFTP/모니터/SSH 분리 창을 배제하고 멀티 입력 대상은 기존 SSH만 유지.
- 새 검증: `tests/ui/navigation.spec.ts`, `scripts/test-local-native.mjs`. 기존 `tests/ui/{layout,themes,games}.spec.ts`, `scripts/{test-native,test-themes-native}.mjs`의 미리보기/멀티 입력 진입을 보기/도구 메뉴로 갱신. `README.md`에 사용법/제한/검사 명령 추가.
- 확인한 결과: `npm run typecheck`, `npm run lint`, `npm test`29개, `npm run test:ui`20개, `npm run tauri -- build --debug --no-bundle`(tsc/Vite 포함), `cargo clippy -p daxterm --all-targets --locked -- -D warnings`, `cargo fmt --all --check`, 최종 `cargo test -p daxterm --lib --locked`23개(병행 W 추가 검사 포함) 통과. 변경 파일 대상 Prettier 통과. 전체 `npm run format:check`는 병행 작업의 `scripts/generate-notices.mjs` 형식 경고로 1회 실패했으며 U.1 파일의 오류는 아니었다. 기존 메인 번들500KB 경고 유지.
- 실제 Windows: `node scripts/test-local-native.mjs` 첫 성공에서 Windows PowerShell/명령 프롬프트/Ubuntu/docker-desktop 자동 목록, PowerShell 한글 출력·입출력, 실제 PTY 폭123→82, 분할·개별 종료/재접속·다른 탭 유지·PID 종료, Ubuntu WSL 명령 실행/자연 exit, 사이드바 단축키 통과. `test-results-native/local-terminal.png` 시각 확인. 최종 재빌드 후 동일 명령 종료0: 추가500줄 연속 출력 후 완료 마커, 살아 있는 PowerShell을 둔 앱 정상 종료(exit0) 및 PID 소멸도 통과. `test-results-native/local-wsl.png`는 실제 Ubuntu 결과. 테스트 소유 앱과 셸은 종료됐다.
- 실제 SSH 회귀: `node scripts/run-phase1.mjs --reuse-build --native` 종료0. 최종 U.1 빌드(메뉴 활성 표시·분할 새 탭 배치·셸 종료 보강 포함)로 다시 실행한 마지막 검사도 전체 종료0. 현재 내장 자산 앱으로 실제 OpenSSH 인증/호스트키·5개 탭·게임 입력 격리·멀티 입력·SFTP/편집/압축·CP949·2×2·TUI/복사·독립 창·테마 동기화·KeepAlive 재접속·마스터/재시작/DB·변경 키 차단 전체 통과. 이 명령은 Rust probe 실행을 생략하므로 별도 엔진 probe 재실행 성공으로 기록하지 않는다. G.2 기록의 과거 split 입력 실패는 이번 전체 실행에서는 재현되지 않았다. fixture와 테스트 앱은 정리됐다.
- 중간 실패/보정: 병행 capability 갱신 중 `allow-recovery-list` 미생성으로 build1회 실패→최신 파일 재시도 성공. Clippy의 고정크기 chunks 검사→as_chunks로 수정. Rust 테스트 링크 PDB 손상→해당 테스트 PDB만 제거 후 재실행22개 통과. UI worker1회 비정상 종료→해당 검사 및 최종 전체20개 통과. 로컬 harness의 CDP 긴 키입력 timeout/insertText 미전달은 실제 paste 이벤트+Enter·셸 prompt 대기로 보정, resize의 이전 응답 재사용은 구별되는 결과 마커로 수정. 실패를 제품 성공으로 기록하지 않는다.
- 남은 ID: **U.1 Mac 기본 셸/PTY/IME/종료 실기기 검증**, 표준 경로 PowerShell7 실실행(현재 머신 미설치), **5.3 최신 NSIS 재생성/설치**. 물리 Windows IME, 장시간/절전, 기존 W/5.1~5.3 대기는 유지. 로컬 파일 탐색기·로컬 독립 창은 이번 초기 범위에 없음. 기존 release installer는 U.1을 포함한다고 보장하지 않는다.
- 다음 첫 행동: 최신 `target/debug/daxterm.exe`로 로컬/WSL 동작 사용 가능. 배포 담당은 병행 변경이 끝난 뒤 NSIS를 다시 생성·설치 검증하고, Mac이 제공되면 계정 기본 셸/한글/resize/exit/앱 종료를 실기기에서 검증한다.

## W.1~W.4 — Windows 출시 품질 보완 (2026-11-05 최종)

- 요청: Mac을 후순위로 두고 Windows에서 가능한 보완·검증을 계속 수행하며 실제 수동 항목을 분리. W.1/W.2 구현 및 W.3/W.4의 실행 가능한 자동 검사를 마쳤다. 공개 안정판/Phase5 전체 완료는 아니다.
- 데이터 보호: `src-tauri/src/{storage,commands,settings,maintenance,editor,lib}.rs`, `build.rs`, capabilities/permissions. DB quick_check·스키마 트랜잭션·삭제와 credential journal 원자성, OS 파일 잠금, 변경 전 최대10개 설정 복구본, 원자적 파일 교체·읽기 크기 제한, 편집 복구 manifest 보호. 손상 DB/미래 스키마를 자동 초기화하지 않는다. 복구는 새 ID·터널 자동 시작 해제·암호 재입력 원칙이다.
- 사용자 화면: `src/features/settings/MaintenancePanel.tsx`, `src/app/App.tsx`, IPC. 복구 목록/생성/가져오기와 허용 필드만 담는 진단 JSON 저장 추가. `src/features/terminal/TerminalPane.tsx`의 보임/입력 대상 상태를 분리해 2×2 화면의 포커스 경쟁과 검색 컨트롤 포커스 탈취를 수정했다.
- 보안/배포: `src-tauri/src/{ssh,ftp}.rs`, `Cargo.toml`/`Cargo.lock`, `package.json`/lock, `tauri.conf.json`, `scripts/{audit-windows,generate-notices,run-phase1,run-ftp,test-native,test-maintenance-native}.mjs`, `scripts/{verify-windows,test-installer}.ps1`, `.github/workflows/windows.yml`, `licenses/`. minimatch 수정, rustls-pemfile 제거, RSA 개인키 인증 차단. Windows 426개 구성요소 라이선스 원문 누락0 및 설치본 포함. 버전0.5.1 정렬. CI 정의는 추가했으나 Git 원격이 없어 원격 실행은 미검증이다.
- 정적/단위/UI: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`29개, `npm run build`, `npm run test:ui -- --workers=2`20개 통과. `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked` 앱23개+실증1개 통과. 마지막 보고서 경로 수정 후 format 검사도 통과. 기존 메인 번들 크기 경고는 남는다.
- 실제 통합: `CARGO_TARGET_DIR=target/windows-hardening` 및 동일 앱의 `DAXTERM_TEST_BINARY`로 격리. `node scripts/test-maintenance-native.mjs` 종료0(복구 생성/삭제/새 ID 복원/경로 거부/재시작/560px), `node scripts/run-ftp.mjs --reuse-build --native` 종료0(FTP/FTPS/CP949 실제 엔진+WebView2), `node scripts/run-phase1.mjs --native --reuse-build` 최종 종료0(인증/호스트키·5연결·게임 입력 격리·멀티 입력·파일/편집/압축·2×2·TUI/클립보드·분리 창/테마·재접속·보관함/재시작/변경 키 거부). 복구 화면 PNG도 시각 확인했다. 이 native 명령은 엔진 probe를 생략하므로 엔진 결과는 별도 stress 기록을 따른다.
- SSH 반복: `node scripts/run-phase1.mjs --stress-minutes 5` 실제 엔진 300초/322회 통과 기록이 있다. 각 회1MiB 출력/정상 종료 및 자원 상한을 검사했다. Playwright가 `test-results/`를 정리하므로 지속 보존 보고서를 `target/verification/`으로 이동하고 5분 검사를 다시 실행했다. 최종 보고서 수치는 아래 추가 기록을 따른다. 24시간 WebView2 실사용·절전 검사를 대체하지 않는다.
- 실패와 보정: 대기 연결의 미처리 ACK/종료 후 남은 이벤트 ACK는 probe 하네스 정리 순서 수정. 다섯 탭 검사는 새 활성 연결을 기다리도록 보정. split 실패는 제품 포커스 경쟁을 수정한 뒤 전체 회귀 통과. 초기 UI4-worker timeout은 2-worker 전체 실행 통과. 실행 중 기본 debug EXE 잠금은 별도 target으로 분리했다. 실패를 성공으로 집계하지 않았다.
- 최종 설치본: `target/release/bundle/nsis/DaxTerm_0.5.1_x64-setup.exe`, 9,709,714바이트, SHA256 `CAAE2072D5A89E0633FFF23C32B2792B17A0138792DE15C27198C11DDBA10EBC`. 최신 `npm run tauri -- build --bundles nsis` 산출물에 `./scripts/test-installer.ps1 -Version 0.5.1 -PreviousVersion 0.5.0 -Reinstall` 종료0. 설치본 교체/일반 파일 보존/재설치/고지 포함/실제 창 초기화/정상 종료/제거 확인. 사용자 데이터·보관함 전체 이행은 별도 대기. `NotSigned`, 동봉 manifest `publicReleaseApproved:false`.
- 사용자 기동 콘솔 질문: `src-tauri/src/main.rs`는 debug에 콘솔을 허용하고 release는 GUI subsystem을 사용한다. 실제 EXE PE 헤더도 debug3(Console)/release2(GUI)로 확인. debug EXE 직접 실행의 검은 창은 이 설정 때문이다. 배포 설치본은 release 바이너리다.
- 보안 게이트: `npm audit --audit-level=low`0건. `cargo audit --deny warnings` 취약점1/경고5로 실패. `node scripts/audit-windows.mjs` Windows RSA 취약점1건으로 종료1, 경고5개는 Windows 그래프 밖이며 전체 보고서에 보존. RSA 개인키 경로 차단은 완화이며 라이브러리 수정이 아니다. `verify-windows.ps1` 전체 게이트는 이 문제로 실패 상태다. 무시 설정으로 우회하지 않았다.
- 남은 작업 ID/미검증 이유: **W.3** RSA 의존성 수정/대체 검증, 인증서·배포 주체·주소/업데이트/앱 라이선스 결정 미제공. **W.4/5.1 M1~M10** 실제 물리 IME/OS 드롭·대화상자/GUI 편집기/절전·네트워크 변경/24시간/강제 종료/혼합 DPI·Narrator/실서버 호환성. **5.3** 깨끗한 PC 및 실제 사용자 데이터 업그레이드. **5.2/Mac** 사용자 요청으로 보류. 모든 절차/합격 기준은 `docs/verification/windows-release-checklist.md`, 상세 구현·복구 절차는 `docs/verification/windows-hardening.md`.
- 다음 첫 행동: 0.5.1 설치본으로 M1→M2→M3 결과를 기록하고 별도 테스트 PC에서 M6을 시작한다. 의존성 보안 게이트는 수정된 업스트림/검증된 대체 경로 확보 후 다시 실행한다. 코드 수정 없이 기존 통과 검사를 반복하지 않는다.
- 최종 stress 재실행 결과: `node scripts/run-phase1.mjs --stress-minutes 5` wrapper 종료0을 프로세스 종료 코드로 확인. `target/verification/ssh-stress.json`: completed=true, 300초/329회/회당1MiB. 첫 샘플 private6,164,480바이트/핸들194, 마지막10,473,472바이트/193, 최대10,473,472바이트/197. 설정한 메모리/핸들 상한 통과. 최종 installer manifest SHA256 일치 확인, 테스트 DaxTerm 프로세스 없음. 지속 보고서는 UI 테스트 정리와 분리한 `target/verification/`에 보존한다.

## U.2 — 통합 UI와 터미널 중심 작업 공간 (2026-11-05, 구현·Windows 자동 검증 완료)

- 요청: 좌우 사이드바를 왼쪽으로 통합, 버튼 크기·정렬·스크롤 개선. 추가 지시로 터미널을 주인공으로 더 컴팩트한 도구, 마우스 리사이즈/접기, 단일·분할 전체화면·선택 터미널 확대, 분할과 멀티 입력 통합(개별/모든 창/선택한 창).
- 구현: `src/app/{App.tsx,DetachedWindow.tsx,workspace.css,useFullscreen.ts}`, `src/main.tsx`, `src/features/terminal/{TerminalPane,BroadcastControl}.tsx`, `src/features/sftp/FilePanel.tsx`, `src-tauri/src/{local,broadcast,commands}.rs`, `src-tauri/capabilities/main.json`. 기존 테마·마스코트/사용자 데이터 유지. 새로운 권한은 네이티브 전체화면 제어. 메인 사이드바는 연결/파일 탭, 한 스크롤의 연결 목록과 고정 검색, 280~420px 마우스/키보드 너비 조절, 좁은 창 오버레이와 배경 inert. 독립 SSH 창의 파일 패널도 왼쪽. FTP/FTPS 중앙 파일 탭 유지.
- 터미널: 검색/복사/붙여넣기 32px 정렬, 글꼴/기록은 설정으로 이동. 상단 52px, 탭36px, 분할 도구28px. F11 전체화면, Ctrl/Cmd+Shift+Enter 선택 창 확대/복원. xterm을 재마운트하지 않으며 종료/위험 붙여넣기 확인 유지. 분할 영역720px 이하에서는 세로로 배열, 하나 남으면 빈 분할 칸을 없앤다.
- 입력 그룹: 기본 창에서는 현재 분할에 포함된 연결만 후보. 입력 옵션을 분할 도구에 배치하고 상단 도구 메뉴의 별도 멀티 입력 제거. 개별/모든 창/선택한 창, 대상별 표시/즉시 중지. 로컬 셸·WSL·SSH를 함께 선택 가능하도록 공통 bounded Tokio 입력 큐로 전환하고 모든 대상 queue reserve 후 전송한다. 대상 종료/재접속 및 배치 변경 때 그룹 해제, 새 연결 자동 추가 없음. 로컬 입력 source는 main 창으로 제한한다.
- 현재 확인: 초기 U.2(전체화면/입력 통합 추가 전) `npm run test:ui`25개, `npm test`29개, lint/format/build 및 Tauri debug 빌드 통과. 이후 컨테이너 기준 분할 보완 뒤 `node scripts/test-local-native.mjs` 종료0: PowerShell/명령 프롬프트/Ubuntu 실실행·한글·resize·분할/재접속·PID종료·500줄 출력·앱 종료, 32px 도구 정렬·파일보기 전환 시 xterm/연결 유지·설정 포커스 복귀. 해당 시점 스크린샷 `test-results-native/unified-local.png`.
- 중간 실패와 보정: 800px 예전 오른쪽 패널 CSS가 resize handle을 숨겨 중앙을4px로 좁힘 → 오래된 규칙 제거. 900px 좌우 분할 PowerShell 입력 응답 실패3회 → 작업영역720px 이하 세로 배치와 단일 잔여칸 확장 후 전체 로컬 검사 통과. 초기 external editor 폼 실패 → 선택 패널 높이 변화로 더블클릭 위치가 이동할 수 있어 고정112px로 보정. 이후 파일 작업 버튼4열·경로 따라가기·전송 트레이를 더 컴팩트하게 정렬. 3개 분할의 마지막 창은 아래 행 전체를 사용한다.
- 출력/하네스 보정: `TerminalPane.tsx`의 fit 시 하단을 보던 뷰포트는 하단을 유지하고, `session.ts`는 값이 달라질 때만 글꼴/기록 설정을 적용한다. Native 검사에서 xterm 접근성 트리는 현재 화면만 나타내므로 실제 검색 UI로 버퍼의 결과를 찾아 검증한다. ASCII 명령은 실제 paste 이벤트와 Enter를 사용하며 입력 대상 dialog가 닫힌 뒤 진행한다. 새 사이드바 tab과 터미널 tab을 구분하고 독립 창의 pane 선택자도 맞췄다. 초기 CP949/분할/독립 창 검사 실패를 최종 성공으로 덮어 쓰지 않으며, 아래 최종 재실행에서 해당 단계까지 모두 통과했다.
- 검증 파일: `tests/ui/{workspace,navigation,games}.spec.ts`, `scripts/{test-workspace-native,test-local-native,test-native}.mjs`, `broadcast.rs`의 역압 시 부분 전송 방지 단위 검사. 최종 `npm run test:ui -- --workers=2`26개, `npm test`32개, `npm run lint`, `npm run format:check`, `npm run tauri -- build --debug --no-bundle`, `npm run tauri -- build --no-bundle` 통과. TypeScript 검사는 빌드에 포함. Rust lib24개, `cargo check`, `cargo clippy -p daxterm --lib --bin daxterm --locked -- -D warnings` 통과 기록이 있다. 최종 U.2 Rust 3개 파일 rustfmt 검사 통과. 전체 `cargo fmt --all --check`는 병행 S.1 `ssh_auth.rs` 형식 변경으로 실패했으며 U.2 성공으로 기록하지 않는다. 기존500KB 번들 경고 유지.
- 최신 Windows 실제 검사: `node scripts/test-workspace-native.mjs` 종료0 — cmd3개 전체 입력/2개 선택/비대상 격리, 대상 종료·배치 변경 시 그룹 해제, 마우스304→344px, 네이티브 단일/분할 F11 및 선택 창 확대, 기존 연결/렌더러 보존. `node scripts/test-local-native.mjs` 최종 종료0 — PowerShell·cmd·Ubuntu WSL, 한글·PTY resize·분할·종료/재접속·500줄 출력·앱 정상 종료/PID 정리, 사이드바 전환/설정 포커스.
- 실제 SSH UI 회귀: `DAXTERM_UI_REGRESSION_ONLY=1 node scripts/run-phase1.mjs --native --reuse-build` 최종 종료0. 인증/호스트키·게임 격리·5탭·선택2개 입력·로컬↔SSH 양방향 입력·SFTP/편집/권한/압축·CP949·2×2·클립보드·top/htop/vim·분리 창 왼쪽 파일 패널/F11/테마·네트워크 재접속·정상 종료·보관함/재시작·변경 키 거부 통과. 이 명시적 옵션은 병행 S.1의 새 인증/터미널 기본기 확장 검사를 생략한다. **S.1 전체 성공 또는 SSH 엔진 probe 재실행으로 해석하지 않는다.** 테스트 소유 앱과 SSH fixture 정리 완료.
- 실제 FTP: `node scripts/run-ftp.mjs --reuse-build --native` 최종 종료0. 실제 FTP/FTPS/CP949 엔진의32MiB 전송·REST 재개·바이너리 일치·인증서 거부 및 WebView2 FTP/FTPS 세션·파일 작업·좁은 창 회귀 통과.
- 산출물: `target/release/daxterm.exe`(2026-11-05 10:57 KST, 26,310,656바이트), `target/debug/daxterm.exe`. release는 GUI subsystem 실행 파일이며 이번 변경을 포함한다. 기존 `target/release/bundle/nsis/DaxTerm_0.5.1_x64-setup.exe`는 재생성하지 않았다. 시각 확인: `test-results-native/unified-fullscreen-multi.png`, `unified-local.png`, `files-editor.png`, `detached-window.png`.
- 남은 ID/이유: **U.2 Mac**(실기기 환경 없음), **5.3 최신 NSIS 재생성/설치 검증**, 기존 W/5.1~5.3 수동·배포 항목 및 병행 S.1 검증은 해당 기록 유지. 다음 첫 행동: 최신 release EXE로 개편 화면 사용 가능. 배포 담당은 병행 S.1 완료 후 설치 패키지를 다시 생성·검증한다. Mac이 제공되면 사이드바/전체화면/분할 입력/PTY를 실기기에서 확인한다.

## S.1 — RSA 보안·일반 인증·터미널 기본기 (2026-11-05)

- 범위: roadmap §5 S.1, 이번 사용자의 RSA 경고 해소/키 인증 유지·SFTP 기본 팔로우·마우스 복사/붙여넣기·기본 키 및 누락 기능 점검 요청. 다른 U.2 작업의 UI/로컬 입력·검사 변경을 보존했다. 세부 계약과 지원/미지원 표는 `docs/verification/security-terminal-basics.md`가 정본이다.
- 보안 파일: 루트/앱/probe Cargo manifest와 lock, `src-tauri/src/{rsa_auth,ssh_auth,ssh,commands,storage,lib}.rs`, build/capability/생성 권한, `vendor/ssh-key`, `scripts/generate-notices.mjs` 및 생성 고지. RustCrypto rsa 패키지 제거, ring SHA256/512 RSA2048~8192 서명·호스트 검증, OpenSSH/PEM/암호화 PKCS8 인증. SHA1/약한 RSA 거부. vendored 원본 대비 runtime 소스 변경은 signature.rs 하나이며 출처·범위·업데이트 절차는 DAXTERM-PATCH.md에 기록했다. 감사 무시로 경고를 숨기지 않았다.
- 인증: Windows OpenSSH agent/Unix SSH_AUTH_SOCK와 keyboard-interactive, 기존 password/key/agent 성공 일부 뒤 MFA. 키 최대5회, 질문/회수/시간/응답 큐 상한, 연결 소유 창 검사, 비밀 응답 미저장. `src/features/sessions/{SessionForm,AuthenticationPrompt}.tsx`, `src/features/terminal/session.ts`, `src/lib/ipc.ts`, App 연결 흐름을 추가했다. 사용자 인증서 agent 경로는 있으나 실제 CA/하드웨어 조합을 검증했다고 주장하지 않는다.
- 터미널/파일: `src/features/terminal/{preferences.ts,preferences.test.ts,TerminalPane.tsx,session.ts}`, `src/features/sftp/FilePanel.tsx`, 공통 스타일/도움말. 기본 켜짐 선택 복사·우클릭 붙여넣기·SFTP 팔로우, 새 연결 기본값 및 연결별 팔로우 해제, Ctrl/Cmd+Shift+C/V·Shift+Insert, 위험 붙여넣기 확인, DEL/Ctrl+H 선택과 VERASE/IUTF8 PTY. xterm 기본 키와 TUI 마우스 모드 유지. OSC7/1337 원격 경로만 허용하고 Bash/Zsh에는 명시적 버튼으로 현재 셸 hook 연결(설정 파일 변경 없음). 오래된 비동기 붙여넣기가 새 연결로 전달되지 않게 연결 ID도 확인한다.
- 실제 검사 파일: `tests/openssh/{Dockerfile,entrypoint.sh}`, `scripts/{run-phase1,test-native,verify-terminal-basics}.mjs`, `src-tauri/examples/phase1_probe.rs`. 테스트마다 새 키/자격 증명과 localhost 포트/격리 named pipe를 사용한다. 암호·키 원문은 문서/로그에 기록하지 않는다.
- 감사: `node scripts/audit-windows.mjs` 종료0/Windows0건, `npm audit --audit-level=low`0건. 전체 Rust 보고서의 Windows 대상 밖 경고5개는 유지한다(전역 cargo audit 무경고를 뜻하지 않는다). `cargo tree -i rsa --locked`는 해당 패키지 없음. 고지424개/라이선스 원문 누락0. 결과 `target/verification/windows-audit.json` 및 전체 보고서.
- 코드 검사: `npm test`32개, `npm run test:ui -- --workers=2`26개, lint/typecheck/build 통과. 최종 `npm run format:check`와 절대 경로 cargo의 `fmt --all -- --check` 종료0. `cargo clippy --workspace --all-targets --locked -- -D warnings` 종료0. `cargo test --workspace --locked` 앱24+probe1 통과(마지막 작은 agent 크기 제한/0질문 처리 뒤 clippy와 실제 native 전체 검사를 수행). 초기 병렬 Rust 빌드는 Windows paging1455로 실패했으나 CARGO_BUILD_JOBS=1 재실행 통과. PATH에 cargo가 없는 최종 포맷 명령은 실패 후 `C:/Users/Administrator/.cargo/bin/cargo.exe`로 재실행 통과했다.
- 실제 OpenSSH 엔진: `node scripts/run-phase1.mjs` 종료0. 일반/암호화 RSA OpenSSH·PEM·암호화 PKCS8, 잘못된 passphrase 거부, 실제 agent, RSA-only 호스트·SHA256-only 사용자 인증, 키+PAM 추가 인증·취소, 위조 SHA2/SHA1 서명 거부 및 기존 전송/편집/포워딩 등 전체 통과. 실제 OTP 제공자를 시험한 것은 아니다.
- 최종 Windows 앱: `$env:CARGO_TARGET_DIR='D:/Work/daxterm-workspace/src-tauri/target/windows-hardening'; node scripts/run-phase1.mjs --native --reuse-build` 종료0, S.1 검사 생략 환경변수 미사용. 실제 Bash cd 팔로우/끄기/재마운트, 캔버스 드래그 복사, 우클릭/단축키/위험 붙여넣기 취소, 방향키/Home/End/Backspace/Ctrl+H·설정 유지, agent/서버 질문/암호화 RSA+추가 인증·비밀 참조 미저장 통과. 기존 게임/5탭/혼합 로컬·SSH 선택 입력/SFTP·편집/CP949/분할/top·htop·vim/분리창/KeepAlive/재시작·보관함/변경 호스트 키 차단까지 전체 통과. fixture 제거 메시지와 종료0 확인.
- 중간 실패/보정: 클립보드 비동기 읽기 전에 Enter를 보낸 테스트는 붙여넣기 결과를 기다리게 수정. 질문0개 keyboard-interactive 정보 요청은 RFC4256에 맞게 자동 응답하도록 제품 수정. S.1 테스트 프로필 삭제창이 닫히기 전 다음 게임 단계로 넘어가던 검사에는 삭제 완료/모달 닫힘을 기다리게 추가. 앞선 실패를 성공으로 집계하지 않았고 수정 후 위 전체 실행으로 확인했다.
- 산출물: 검증한 내장 자산 debug 앱은 `src-tauri/target/windows-hardening/debug/daxterm.exe`. 이번 S.1에서는 버전 변경/NSIS 재생성·설치 검사를 하지 않았다. 기존 `target/release/bundle/nsis/DaxTerm_0.5.1_x64-setup.exe`는 10:07:55의 이전 산출물이다. 병행 U.2의 release 변경은 해당 작업의 검증 기록을 따른다.
- 미검증/남은 ID: **S.1 Mac·Unix agent·Zsh·실제 OTP/하드웨어 agent/사용자 CA 인증서**, **S.1/5.3 최신 설치본 생성·설치**, 기존 **W.4/5.1 수동 OS·IME·절전·24시간**, **W.3 서명/배포**, **5.2 Mac**. 환경/실제 공급자/장시간 결과가 없어 대기다. GSSAPI/Kerberos·직접 FIDO2·Pageant·agent forwarding·호스트 CA·점프 호스트·로컬 폴더 재귀 전송/큐·세션 로그는 미지원으로 명시했고 이번에 모두 구현했다고 보고하지 않는다.
- 다음 첫 행동: 병행 U.2 변경이 확정되면 최신 소스를 설치 패키지에 포함해 설치/실행 검사. 실제 서버 환경에서 M10 인증/키 호환성과 OTP·하드웨어 agent를 검증하고, Mac 환경 확보 시 SSH_AUTH_SOCK·Zsh/키보드/클립보드/팔로우를 검증한다. 검증된 현재 Windows 소스를 전체 Phase/공개 안정판 완료로 해석하지 않는다.

## G.3 — 닥스의 간식 타임·닥스의 모험 메뉴 통합 (2026-11-05)

- 요청: 앞서 채팅에서 만든 두 게임을 실제 DaxTerm 게임 메뉴에도 추가. 기존 G.2의 사이드바→중앙 작업 탭을 재사용하며 별도 창/페이지/IPC/의존성은 추가하지 않았다. 기존 4종과 함께 6종 선택 가능. 병행 I.1/U.3 등의 코드와 진행 기록은 유지한다.
- 구현 파일: `src/features/games/{catalog.ts,GamePane.tsx,shared.tsx,DaxGames.tsx,daxEngines.ts,games.css}`. 기존 시작/일시정지/최고 기록/상태 UI를 shared로 추출하고 두 게임에서 재사용. 원본 `src/assets/brand/dachshund-full.png`, 터미널 색상 토큰으로 SVG 보드를 표시한다. 채팅의 HTML/외부 워크스페이스/네트워크에 런타임 의존하지 않는다.
- 간식 타임: 45초, 간식10점/별30점/양파 목숨1 감소, 목숨3개, 1.1초 연속 피해 방지. 방향키/A·D·드래그·누르는 이동 버튼. 모험: Space/↑/W/터치·점프 버튼, 자동 달리기/거리 기록, 두 장애물/중력/공중 재점프 방지/속도 상한. 숫자 최고 기록만 `daxterm.games.v1.snack` 및 `.adventure`에 저장하고 저장 실패에도 플레이한다.
- 입력/수명: 게임판 포커스에서만 키 처리, 수정키 단축키는 가로채지 않음. 보드/버튼을 떠날 때 이동 입력 정리, 탭 비활성/창 blur/문서 hidden/게임 영역 이탈 시 정지. 비활성·완료·탭 닫기 시 RAF 정리. 현재 판은 탭 전환에 유지, 명시적 계속하기, Esc는 기존 작업 복귀. 기존 터미널 마운트/inert 계약은 그대로 사용한다.
- 검증 파일: `src/features/games/daxEngines.test.ts`, `tests/ui/dax-games.spec.ts`, 확장한 `scripts/test-games-native.mjs`. 문서는 roadmap §11 G.3 및 README 로컬 게임 사용법에 반영했다.
- 통과: `npm test`38개(새 규칙6개), `npm run typecheck`, `npm run lint` 및 `npm run format:check` 종료0. `npx playwright test tests/ui/games.spec.ts tests/ui/dax-games.spec.ts --workers=2`의 기존 게임5개와 테마/터치1개는 통과했으나 새 폭별3개는 가상시계를 lazy import 전에 멈춰 Suspense 준비 중에 timeout. 제품 실패로 숨기지 않고 하네스가 보드 로딩을 확인한 뒤 시계를 제어하도록 수정했다. 이후 `npx playwright test tests/ui/dax-games.spec.ts --workers=2` 새4개 전체 종료0. 360/560/1280px, 좌우 이동·점프 장애물 회피·충돌/종료·45초 종료·정지·재시작·탭별 판/기록·닫기·Esc·테마·기존 xterm 인스턴스 유지 확인. 시각 확인: `test-results/dax-adventure-360.png`, `dax-snack-1280.png`, `dax-dark.png`.
- 실제 Windows: `npm run tauri -- build --debug --no-bundle` 종료0 → `node scripts/test-games-native.mjs` 종료0. WebView2 6종, 새 게임 방향키·점프/정지·탭 복원, 기존 게임 키/기록/닫기 포커스 통과. 실제 로컬 PowerShell `Read-Host` 대기 중 두 게임의 방향키/Space/A/D 입력 후 복귀하여 빈 문자열만 수신함을 검사했고 동일 연결 ID 유지. Mock SSH 검사가 아니며 **실제 SSH 재검증을 수행한 것으로 대체하지 않는다**. 테스트 소유 앱 정상 정리. 실제 화면 `test-results-native/games.png` 확인.
- 빌드: `npm run tauri -- build --debug --no-bundle` 및 `npm run tauri -- build --no-bundle` 모두 종료0. 각각 `target/debug/daxterm.exe`, `target/release/daxterm.exe`에 새 게임 내장 자산 반영. release 최적화 빌드는 5분49초 소요. PATH에 cargo를 추가하고 `CARGO_BUILD_JOBS=1`로 실행했다. 기존 메인 번들500KB 경고 유지. 이번 변경은 Rust/IPC/권한 수정 없음. NSIS 설치본은 재생성하지 않았다.
- 미검증/남은 ID: **G.3 Mac**(실기기 없음), **G.3 실제 SSH 회귀**(이 작업은 실제 로컬 PTY 격리 검사 수행), **5.3 최신 NSIS 생성/설치**(요청은 게임 메뉴 통합이며 설치본 재생성 미실행). 기존 I.1/U.3/S.1/W/Phase의 미완료 항목은 각각의 기록을 따른다. 다음 첫 행동: 최신 release EXE로 실행하여 사이드바 게임의 두 항목 사용 가능. 배포 담당은 병행 작업 확정 후 최신 NSIS를 재생성·검증한다. Mac/실제 SSH가 필요한 별도 검증은 해당 환경에서 수행한다.

## U.3 — 버튼 일관성과 이해하기 쉬운 터널 설정 (2026-11-05)

- 범위: 사용자 첨부 화면의 버튼 레벨 불일치 점검 및 복잡한 설정을 흐름/목록 UI로 설명하는 개선. roadmap §14, 상세 결과는 `docs/verification/settings-ui.md`.
- 파일: `src/features/tunnels/{TunnelPanel.tsx,tunnels.css}`, `src/app/{App.tsx,styles.css,workspace.css}`. `.primary` 별도 padding 제거·공통 액션/입력 32px, 목적 중심 유형 선택·방향별 입력/설명, 목록/편집 분리, 저장 후 목록, 실제 상태/시작·중지/자동 시작/수정/삭제. 현재 탭 외 열린 SSH 연결 선택, 다른 연결 실행 보호, 실패 입력 보존·중복 요청 방지.
- 검사 파일: `tests/ui/tunnels.spec.ts`, `tests/ui/fixtures/tunnels.{html,tsx}`, 세션 폼 높이 검사를 추가한 `tests/ui/layout.spec.ts`, 실제 왕복 `scripts/verify-tunnels.mjs`와 `scripts/test-native.mjs` U.3 단계.
- 프런트엔드: `npm test` 실행 당시32개, `npm run test:ui -- --workers=2`32개, 최종 터널/레이아웃12개 통과. `npm run typecheck`, 최종 전체 lint 및 변경 파일 ESLint/Prettier 통과. 360/560/800/1280px·크림/다크/터미널 테마·키보드·버튼 정렬·실패/보호 흐름 검사. 테스트 fixture는 실제 SSH로 집계하지 않는다.
- Windows: PATH에 cargo 경로를 추가하고 CARGO_BUILD_JOBS=1, CARGO_TARGET_DIR=`D:/Work/daxterm-workspace/src-tauri/target/windows-hardening`로 `npm run tauri -- build --debug --no-bundle` 통과. 같은 target로 `node scripts/run-phase1.mjs --native --reuse-build` 최종 종료0. 실제 Local/Remote/SOCKS5 도메인 CONNECT 왕복, 설정 목록/자동 시작 값 저장·해제/창 닫기 유지/중지·삭제 및 기존 전체 native 회귀 통과. 테스트 fixture 정리 완료. `--reuse-build` 실행이므로 독립 engine probe 재실행으로 집계하지 않는다.
- 실패 이력: 병행 게임 파일 생성 도중 DaxGames import 누락 빌드 실패 후 재실행 성공; 병행 세션 전송 검사 미사용 변수로 전체 lint 실패 후 해당 작업 수정 뒤 재실행 성공. Native 검사 자체의 비동기 체크박스 대기와 동기 docker 호출의 로컬 echo 이벤트루프 차단을 수정한 뒤 최종 실제 왕복 통과. 제품 보안/엔진을 우회하지 않았다.
- 시각 결과: `test-results/tunnel-local-1280.png`, `tunnel-list-360.png`, `test-results-native/tunnel-editor-local.png`, `tunnel-saved-list.png` 직접 확인. 테스트 서버/일회용 포트만 사용, 비밀정보 기록 없음.
- 산출물: `src-tauri/target/windows-hardening/debug/daxterm.exe`에 새 UI 포함. release EXE 및 NSIS 설치본은 이번 작업에서 재생성하지 않았다. Rust 소스/IPC/DB 변경 없음. Rust fmt 및 `cargo clippy --workspace --all-targets --locked -- -D warnings` 종료0(같은 target, CARGO_BUILD_JOBS=1, 8분07초).
- 남은 ID: **U.3 Mac 실기기**, **U.3/5.3 최신 release·설치본 반영**, 기존 **W.3/W.4/5.1~5.3** 수동 OS/장시간/서명/Mac 대기 유지. 다음 첫 행동: 검증한 debug 앱의 도구 → 터널에서 변경 UI 확인; 병행 소스 확정 후 release/설치본 생성·검증. Mac 제공 시 유형별 흐름/키보드/테마/실제 SSH 왕복 확인.

## I.1 — 세션 JSON 규약·외부 가져오기·로그인 후 암호 저장 (2026-11-05)

- 요청: 자체 JSON 교환 규약과 PuTTY/MobaXterm 같은 SSH 도구의 설정 변환 가져오기. 추가 요청으로 첫 로그인 시 저장 여부를 선택하고 다음 접속에 암호를 재사용하는 흐름을 포함했다. 병행 U.3/G.3 코드·기록을 보존했다.
- 계약/문서: `docs/session-transfer.md`, `docs/session-format.schema.json`, roadmap §15, README. format=daxterm.sessions/version2, 기존 format 없는 v1 계속 수용. 세션·그룹·터널·즐겨찾기·인코딩·인증 방식/키 경로, 비밀/신뢰/최근 접속 제외. 자체 포맷이지 업계가 합의한 공통 표준이라는 주장은 하지 않는다.
- 백엔드: `src-tauri/src/{session_transfer,settings,commands,lib}.rs`, `build.rs`, capabilities 및 자동 생성 config_preview/config_apply 권한. 파일 선택은 네이티브, raw 외부 파일/암호 필드는 프런트로 돌려주지 않는다. 2MiB/20,000줄·세션500/그룹100/터널128 제한, UTF-8/UTF-16 BOM/CP949/Windows-1252, 선택 전 미리보기, ID/참조 검증·트랜잭션·복구본·새 ID/터널 자동 시작 해제. 레지스트리/명령/Include 실행 없음.
- 어댑터: PuTTY .reg SSH/이름 percent decoding·호스트/포트/사용자/키 경로, 프록시·비SSH 제외/PPK 별도 변환 안내. MobaXterm Bookmarks SSH 기본 접두부/폴더 경로(평탄화), 추가 설정 제외 경고. OpenSSH 명시적 별칭·패턴/부정·첫 값 우선·기본 필드/첫 키 경로, Match/Include 거부·ProxyJump/ProxyCommand 제외·경로 토큰 미확장. 지원표 밖 SecureCRT/Xshell/Termius/WinSCP 어댑터와 외부 형식 내보내기는 구현하지 않았으며 모든 제품/버전 호환이라고 보고하지 않는다.
- 화면: `src/features/sessions/{SessionTransfer.tsx,transfer.css}`, `src/app/App.tsx`, `src/features/terminal/session.ts`. 설정에서 파일 형식/인코딩 → 미리보기 → 선택/빠진 계정 입력 → 추가, 취소·오류/재시도·성공 건수. 같은 파일 재적용은 사본 추가라고 명시한다. 기존 DB 데이터 덮어쓰기 없음. 기존 12개 테마 토큰을 사용한다.
- 암호: 첫 접속 인증창의 기본 미선택 ‘로그인 성공 후 이 세션의 암호 저장’. 입력한 password/key Passphrase만 성공 connected 이벤트에서 기존 Vault/OS 저장소에 저장, 실패/호스트키 거부·OTP 응답 미저장. Zeroizing 임시 값은 성공/실패에서 제거. 접속 중 대상/계정/인증 방식/키/기존 credential 참조 변경 시 저장하지 않으며 잠긴 보관함/저장 실패는 연결을 유지하고 상태줄에 안내한다.
- 정적/단위 검사: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` 종료0. `npm test`38개(병행 G.3 포함) 통과. 절대 cargo 경로로 `cargo fmt --all -- --check` 종료0, `cargo clippy -p daxterm --lib --bin daxterm --locked -- -D warnings` 종료0, `cargo test -p daxterm --lib --locked`32개 통과(변환7개/새 v2 참조 검사1개 포함). 초기 clippy의 인자8개/extend-with-drain 지적은 AppHandle에서 State 조회 및 append로 수정 후 통과했다. 마지막 수정은 MobaXterm 경고 문구의 ‘지원하지 않는 게이트웨이 세션 선택 해제’ 명확화이며 포맷 검사 통과.
- JSON Schema: 검증용 `target/schema-validation`에만 설치한 Python jsonschema4.26.0의 Draft202012Validator로 schema 자체·문서 예제 통과, 비밀 추가 필드·미래 버전 거부 확인. 제품 의존성은 추가하지 않았다. 초기 시스템 Python에는 jsonschema가 없어 격리 경로에 설치했다.
- UI: `npm run test:ui -- tests/ui/session-transfer.spec.ts --workers=2`4개 종료0. Mock 미리보기의 빈 계정 저장 차단·부분 선택 시 그룹/터널 필터·실패 후 값 유지·재시도/취소, 1280/560/360px 넘침 검증. `tests/ui/fixtures/transfer.{html,tsx}`는 제품 번들 밖 테스트 fixture. 화면 확인에서 체크박스의 전역 width 영향 발견 후 scoped width 수정·재검사. 최종 화면 `target/verification/transfer-{1280,560,360}.png` (병행 Playwright 정리와 분리).
- 실제 Windows: `npm run tauri -- build --debug --no-bundle` 종료0. `node scripts/run-phase1.mjs --native --reuse-build --session-transfer` 최종 종료0: 새 `scripts/test-session-transfer-native.mjs`에서 실제 WebView2+격리 OpenSSH+Windows 저장소 사용. v2 추가/알 수 없는 필드 거부/기존 건수 유지, 신뢰 거부/잘못된 암호 미저장, 성공 이번만 미저장, 성공 동의 저장, 재시작 후 암호 입력 없이 접속, 잠긴 보관함 저장 실패 안내와 연결 유지, 복구 JSON의 비밀 부재, credential 정리 확인. 두 번 통과했으며 최종은 잠긴 보관함 검사까지 포함. fixture/일회용 키·암호 제거 종료0. 전체 SSH 엔진/Phase 회귀 재실행을 뜻하지 않는다.
- 산출물: `target/debug/daxterm.exe`, 실제 설정 화면 `test-results-native/session-transfer.png`. 최종 `npm run tauri -- build --no-bundle` 종료0(병행 Cargo 잠금 대기 포함5분13초). `target/release/daxterm.exe`: 2026-11-05 11:37 KST, 26,520,064바이트, SHA256 `8F34ADFD9E066F9BDD318736F1B99DBD19B4321DD779AC4EB7710E08DEAE8E6C`. 최신 I.1/U.3/G.3 소스를 포함한다. 실제 자동 기능 검증은 내장 자산 debug 앱 기준이며 release 자체 실행 검사를 추가 수행한 것은 아니다. 기존 NSIS는 재생성하지 않았다. 기존 메인 번들500KB 경고 유지.
- 미검증/남은 ID: **I.1 외부 제품 실제 버전별 내보내기 파일·OS 파일 선택/저장 대화상자 수동 조작**, **I.1 Mac 실기기**, **I.1 키 Passphrase/FTP·FTPS의 새 저장 선택 경로 별도 실검증**, **I.1/5.3 최신 설치 패키지**. 파서는 합성 fixture로 검증했고 실제 사용자 외부 파일/제품 실행 환경은 제공되지 않았다. 이번 Windows 실접속 검사는 password SSH이며 Mock으로 다른 프로토콜/Mac 결과를 대체하지 않는다. 기존 U.3/G.3/S.1/W/Phase 상태는 각 기록 유지.
- 다음 첫 행동: 최신 release EXE로 설정 → 세션 가져오기·내보내기에서 파일을 확인·선택하고, 새 세션 연결의 인증창에서 암호 저장을 선택한다. 후속 검증은 익명화한 실제 PuTTY/MobaXterm 내보내기와 OS 대화상자 왕복부터 수행하고 배포 시 최신 NSIS를 생성·검증한다.


## G.4 — 닥스의 모험 횡스크롤 액션 (2026-11-05)

- 요청: 기존 모험을 앞뒤 이동·모션·물기·점프가 있는 횡스크롤 액션 게임으로 확장. G.3의 자동 러너만 대체했다. 기존 5종 게임·터미널 기능·마스코트 원본은 보존한다. 범위는 roadmap §11 G.4로 반영했다.
- 구현 파일: `src/features/games/{AdventureGame.tsx,adventureEngine.ts,DaxGames.tsx,daxEngines.ts,shared.tsx,games.css}`. 모험 엔진/화면을 분리하고 기존 RAF·보드 크기 hook을 shared로 이동. 좌우 가속·감속과 반전, 양방향 카메라, 고정 상한 substep 물리, 코요테 타임/착지 직전 점프 예약, 공중 재점프 방지, 물기 방향/높이/거리/쿨다운, 순찰 적과 넉백/무적을 구현했다.
- 월드: 4,200단위 1개 스테이지·3개 구간명, 발판8/적8/가시4/협곡2/쉼터2, 간식14, 집 도착 클리어. 체력5, 간식25/처치50/완주200점, 쉼터 최초 도착 체력+1, 낙하 체력−1/쉼터 복귀. 기존 최고 거리 저장 키는 유지하고 후진으로 최고 거리를 중복 가산하지 않는다. 점수/진행/체력/위치 안내, 준비/정지/완주/실패 화면을 제공한다.
- 모션: 기존 크림 장모 닥스의 외형·화풍을 참조해 내장 image_gen으로 `src/assets/brand/dachshund-adventure-atlas.png` 생성. 1536×1024 RGBA/512셀/6포즈(서기, 달리기2, 점프, 물기, 피격). alpha와 실제 밝은/어두운 게임 배경을 확인했다. 원본 `dachshund-full.png`/face는 수정하지 않았다. 정확한 프롬프트·셀 순서는 `src/assets/brand/README.md`에 기록. SVG viewBox 프레임 전환, 보행 진동/점프 자세/물기 돌진/피격 점멸, 타격/착지/간식 효과, 원근 배경을 상태 시간으로 렌더링해 정지 시 함께 멈춘다. UI·월드 색은 기존 터미널 토큰만 사용.
- 입력: ←/→ 또는 A/D, Space/↑/W 점프, J/X 물기, P 정지. 화면 이동 버튼 포인터 캡처와 다중 포인터별 방향을 유지해 점프/공격 조합 가능. 키 repeat 공격/점프 방지. 정지/보드 blur/탭 이탈/재시작/포인터 취소 시 입력 정리. 기존 G.2의 판 보존·명시적 재개·Esc 복귀·터미널 inert 계약 유지. 추가 IPC/SSH 명령/네트워크/패키지 없음.
- 규칙 검증: `npm test` **44개 통과**(모험9개). 무입력 정지/좌우·관성·경계, 발판 착지·점프 예약 만료, 방향/높이/거리별 물기·쿨다운·중복 보상 방지, 피격 무적/사망 동결, 쉼터1회 회복/낙하 복귀, 카메라/후진 최고 거리, 30/120Hz, **기본 월드를 조작 입력만으로 시작→집까지 완주** 확인. 테스트 파일 `adventureEngine.test.ts`, 기존 `daxEngines.test.ts`는 간식 규칙 유지.
- UI 검증: `npx playwright test tests/ui/dax-games.spec.ts tests/ui/games.spec.ts --workers=2` 최종 **11개 통과**. 모험/간식6개 + 기존게임5개, 360/560/1280px, 좌우/점프/공격, 몬스터 처치와 점수, 양방향 카메라, 포인터 이동+점프/공격, 해제/정지·재개/재시작, 테마/탭 보존/Esc/기존 xterm 인스턴스 유지·기록 저장 확인. 이미지 `test-results/dax-adventure-{1280,560,360}.png`, `dax-adventure-stage.png`, `dax-dark.png`를 저장했고 큰/어두운 화면을 시각 확인했다.
- 코드·빌드: 최종 `npm run lint`, `npm test`, 게임/변경 테스트·스크립트 `npx prettier --check` 통과. `npm run build`(tsc 포함), `npm run tauri -- build --debug --no-bundle` 최종 종료0. 기본 PATH에 cargo가 없어 최초 native build는 실패했으며 해당 명령의 PATH에 `C:/Users/Administrator/.cargo/bin`을 추가해 해결. 기존 메인 번들500KB 경고는 유지. 스프라이트 추가 후 첫 UI 통합 실행은 nested SVG 때문에 기존 테마 검사 locator가 중복되어 1개 실패했으며 보드 직계 SVG로 선택자를 보정해 위11개 전체 재실행 통과.
- 실제 Windows: `node scripts/test-games-native.mjs` **종료0**. 최종 내장 자산 debug 앱 `target/debug/daxterm.exe`의 실제 WebView2에서 6종게임, 모험 좌우·점프·물기/정지/복귀/기록을 검사. 실제 로컬 PowerShell `Read-Host`를 열어 뒤의 PTY 연결을 유지한 채 방향키/Space/A/D/**J/X**가 입력되지 않음을 확인. `test-results-native/games.png` 저장. 테스트 소유 앱은 스크립트 finally에서 종료. 실제 SSH 연결 검사를 이번 로컬 PTY 검사로 대체하지 않는다.
- 산출물: 최종 `npm run tauri -- build --no-bundle` 종료0(3분30초). 최신 `target/release/daxterm.exe`에 G.4를 포함했다. 실제 WebView2 기능 검증은 같은 최종 프런트엔드 자산의 debug 앱 기준이며 release 자체 실행 검사를 추가 수행한 것은 아니다. NSIS 설치 패키지는 이번 범위에서 재생성하지 않았다.
- 미검증/남은 ID: **G.4 Mac 실기기**, **G.4 물리 멀티터치 장치**, **G.4 실제 SSH 배경 입력 격리 재검증**, **G.4/5.3 최신 NSIS 설치본**. Mac/터치 장치 부재, 요청 범위 내 Windows 로컬 PTY 우선 검증으로 미실행. G.2/U.1 등 과거 SSH 성공과 이번 결과는 구분한다. 기존 Phase/다른 작업 상태는 바꾸지 않는다.
- 다음 첫 행동: 최신 `target/release/daxterm.exe` 실행 → 왼쪽 게임 → 닥스의 모험 → 게임 시작. 후속 검증은 물리 터치 동시 입력과 Mac, 배포 시 최신 NSIS 생성·설치부터 진행한다.

- 최종 release 식별: 2026-11-05 12:44:50 KST, 28650496바이트, SHA256: BD057AB8C89D9215C029F2FDBE3F47D8164F0BDA9327C11767EFC66917964D97. 위 파일을 직접 실행하면 G.4를 사용할 수 있으며 기존 설치본을 실행하면 이전 모험이 표시될 수 있다.


## G.5 — 간식 타임 모션·플레이 완성도 개선 (2026-11-05, 구현·Windows 검증·release 빌드 완료)

- 요청/범위: G.4 횡스크롤 모험의 기존 모션을 재사용한 간식 타임 완성도 개선. 45초/간식10·별30점/목숨3/1.1초 피해 보호/최고 기록 키를 유지한다. 모험 확장은 병행 G.6이며 해당 작업을 덮어쓰지 않았다.
- 구현: `src/features/games/{DaxGames.tsx,SnackScene.tsx,DaxSprite.tsx,snack.css,daxEngines.ts,GamePane.tsx}`. 기존 atlas를 공유하고 `AdventureGame.tsx`의 중복 SVG atlas 렌더링도 DaxSprite로 대체했다. 좌우 가감속·관성·반전/두 달리기 포즈, 씹기/부스러기·별 점프·피격/보호 반응, 그림자·점수/입자 효과, 정원/시간 바/범례/구간 안내·준비/정지/결과 화면. 연속/최대 연속·간식/별 개수는 판 상태만 저장하며 연속 보너스 점수는 없다. 놓치면 연속만 초기화한다.
- 동작: 1/120초 물리 substep, 가로 이동을 보간한 낙하 충돌, 30/120Hz 일치, 게임 시간 기반 효과(정지/완료/탭 이탈 시 함께 동결). StrictMode updater 밖에서 RNG를 샘플링해 이중 실행에도 같은 결과. 실제 SVG 배율로 포인터 좌표 변환, resize 시 닥스/간식 위치 비례 보존, 다중 이동 포인터·취소·키 해제·재개 입력 정리. 모션 줄이기 환경은 회전/진동/입자 생략. 추가 이미지 생성/네트워크/IPC/패키지는 없다.
- 검증 파일: `src/features/games/daxEngines.test.ts` 8개, `tests/ui/snack.spec.ts` 6개와 실제 컴포넌트 fixture `tests/ui/fixtures/snack.{html,tsx}`. 기존 `tests/ui/dax-games.spec.ts`, `scripts/test-games-native.mjs`는 이동 좌표를 data-x로 검사하도록 변경했고 native에 씹기/점수/공유 스프라이트 검사를 추가했다.
- 통과: `npx vitest run src/features/games/daxEngines.test.ts --maxWorkers=1` 8개; `npm test -- --maxWorkers=1` 전체53개; `npm run typecheck`, `npm run build`, 변경 파일 ESLint/Prettier 종료0. UI `npx playwright test tests/ui/snack.spec.ts --workers=1 --output=target/snack-test-results` 최초5개 통과, 이후 추가한 앱 통합 테스트는 `--grep 'integrates with dark' --output=target/snack-integration-results` 1개 통과. 360/560/1280px·씹기/별/피격·보호/목숨 소진/45초·모션 줄이기·resize·드래그·정지/재개/재시작 및 실제 앱 UI의 다크/기존 xterm/판 보존 확인. fixture는 실제 SSH 검사로 집계하지 않는다.
- 실패/수정: 최초 전체 테스트에서 병행 G.6 엔진 교체 중 기존 모험 export 불일치와 Node worker 메모리 부족이 발생했다. 모험 파일을 되돌리지 않고 간식 독립 검사 후 G.6 소스 정합성이 맞춰진 상태에서 전체53개/빌드를 통과했다. 첫 별/양파 UI 검사는 React 초기화가 소비한 전역 RNG 순번 때문에 실패해 준비 완료 후 RNG를 주입하도록 수정했다. 화면 검사에서 공통 game CSS 우선순위로 900px 너비/보드 padding이 덮이던 문제를 scoped specificity로 수정했다.
- 시각 결과: `target/verification/snack-{ready,eat}-{360,560,1280}.png`, `snack-result-360.png`, `snack-app-{light,dark}.png` 중 좁은/넓은/결과/다크를 직접 확인했다. Windows debug 빌드와 기존 게임 UI 회귀도 통과했으며 최종 결과는 아래와 같다.
- 미검증/남은 ID: **G.5 Mac·물리 터치·실제 SSH 재검증**, **G.5/5.3 NSIS 설치본**. Mac/물리 장치 미제공, 실제 SSH·설치본은 이번 범위에서 별도 수행 전이다. 기존 Phase 미완료 상태 유지. 다음 첫 행동: 최신 `target/release/daxterm.exe` 실행 → 게임 → 닥스의 간식 타임. 배포 시 최신 NSIS 생성·설치 검사, 환경 제공 시 Mac/물리 터치/실제 SSH 격리 재검증.


- 최종 통합 회귀: `npx playwright test tests/ui/dax-games.spec.ts tests/ui/games.spec.ts --workers=1 --output=target/snack-regression-results` **11개 전체 통과**. 새 간식 UI 6개와 별개이며 총 게임 UI17개 결과다.
- Windows: PATH에 `C:/Users/Administrator/.cargo/bin`, `CARGO_BUILD_JOBS=1`로 `npm run tauri -- build --debug --no-bundle` 종료0. `node scripts/test-games-native.mjs` **종료0**: 실제 WebView2의 간식 씹기 포즈/획득 점수/공유 atlas, 이동/정지/탭 복원 및 6종 게임. 실제 로컬 PowerShell `Read-Host`를 유지하며 게임 키가 입력되지 않음을 확인했다. `target/verification/snack-native.png` 직접 시각 확인. 테스트 소유 앱 정리 완료. 실제 SSH 검사로 대체하지 않는다.
- 최종 정적 검사: `npm run lint`, `npm run format:check`, `cargo fmt --all -- --check` 모두 종료0.
- 최종 release: `npm run tauri -- build --no-bundle` 종료0(4분36초). `target/release/daxterm.exe`에 G.5 내장 자산 반영. 식별: 2026-11-05 13:14:53 KST, 28,658,176바이트, SHA256 `49B8CD7E341B1B889B28146B38C712A79B6F50CD081A17A2791959F633086676`. 실제 앱 검증은 debug WebView2 기준이며 release 자체 실행 검사는 별도로 수행하지 않았다. NSIS는 재생성하지 않았다. 기존 메인 번들500KB 경고 유지. Rust/IPC/권한 변경 없음; 별도 Rust 단위/clippy는 이번 게임 변경으로 재실행하지 않았으며 과거 결과를 이번 성공으로 집계하지 않는다.

## G.6 — 닥스의 모험 랜덤 맵·환경/적/기믹·밟기 (2026-11-05)

- 현재 요청: Space 물기, ↑/W 점프, 공중 ↓/S 빠른 밟기 및 적 머리 위로 낙하할 때 자동 밟기. 사용자 추가 지시로 고정 스테이지 추가를 시드 기반 랜덤 생성으로 변경했고, 바닥 충격파는 제외했다.
- 구현 파일: `src/features/games/{adventureLevels.ts,adventureEngine.ts,AdventureWorld.tsx,AdventureGame.tsx,adventureEngine.test.ts,games.css}`, `tests/ui/adventure-random.spec.ts` 및 기존 모험 키 검사. 시드+구간 결정적 생성, 4환경 순환·다음 구간/같은 맵 재시작/직접 시드/새 맵, 4적 행동, 이동/붕괴 발판·버섯·스위치 문·증기·얼음. 적 밟기75점/반동, Space 물기50점. 규칙13개(800맵 생성 제약·20맵 입력 완주 포함) 및 프런트엔드 build/해당 코드 eslint 통과, 최종 UI/native/release 결과는 아래 기록을 따른다.
- 병행 G.5 간식 타임 변경과 공유 `DaxSprite.tsx`를 확인·보존했다. G.5를 덮어쓰지 않고 모험만 확장한다. 최종 문서/검증 결과는 G.6 아래에 추가한다.
- UI·코드 검증: 최종 프런트엔드 `npm test`53개·lint·build·변경 파일 Prettier 통과. 전용 포트1446/출력`target/adventure-ui`로 실행한 게임 UI14개 전부 통과, 이후 구간 완주/명시적 다음 구간/점수 유지/시작 전 정지를 추가한 랜덤 UI4개도 전부 통과(총 고유15개). 이미지 `target/verification/adventure-{forest,ruins,cave,snow}-{1280,360}.png`, `adventure-stomp.png`, `adventure-next-stage.png`. 수정 동굴/밟기 화면 시각 확인. 초기 공유1420 서버 종료로 일부 UI 연결이 실패해 전용 포트로 분리했고, 새 details의 group 역할로 중복된 검사 선택자는 게임판의 접근성 이름으로 좁혀 해결했다.
- 빌드 격리: 병행 G.5 빌드와 자산이 섞이지 않게 최종 dist를 `target/adventure-web`에 복사하고 `target/adventure-tauri.json`의 frontendDist로 지정했다. 수정 후 내장 자산 debug 빌드 종료0. 모험 전용 native 확인은 `scripts/verify-adventure-native.mjs`, 기존 게임 native 스크립트에서 호출하며 Space/Up/Down/S의 실제 로컬 PTY 입력 격리도 검사한다.


- 생성/물리 상세: `adventureLevels.ts`의 결정적 PRNG·환경별 대표2개/무작위4개 지형 조각, 각3,880단위 월드. 맵 시드는0~4294967295. 적의 순찰 범위가 쉼터에 겹치지 않도록 멧돼지 배치/범위를 제한했다. 머리 밟기는 낙하 전/후 발 좌표가 적 머리를 통과하는지 검사해 고속 낙하에서도 놓치지 않으며, 옆/상승 충돌은 기존 피해/무적 처리다. 밟기 반동 후 공중 재점프는 허용하지 않는다. 이동 발판은 서 있는 플레이어를 운반하고 금 간 발판은0.65초 후 붕괴/3.65초 후 복원. 증기는 대기→0.6초 예고→1.1초 분출. 게임 시간은 정지/비활성 시 함께 멈춘다.
- Windows 실제 검증: 최종 `node scripts/test-games-native.mjs`에 `DAXTERM_TEST_BINARY=target/verification/daxterm-adventure-debug.exe`를 지정해 **종료0**. `verify-adventure-native.mjs`에서 실제 WebView2의 시드42·4환경 선택, Space는 물기/높이0, ↑ 점프, ↓ 빠른 밟기/착지, 정지 시 장면 동결 확인. 기존6종 게임·기록/탭/동일 로컬 PowerShell PTY 유지 및 ArrowDown/S를 포함한 게임 키가 `Read-Host`로 섞이지 않음 확인. 화면 `target/verification/adventure-native.png`. 테스트 소유 앱은 finally 정리. 실제 SSH/Mac 결과로 대체하지 않는다.
- 빌드/검사 중 문제와 해결: 최초 frontendDist를 Windows 절대 경로로 지정하니 file URL로 처리되어 내장 앱 페이지 검사2회 실패했다. `../target/adventure-web` 상대 경로로 수정하고 debug 재빌드(38.95초)·별도 EXE 복사 후 통과. 잘못된 config로 대기 중이던 **이 작업 소유 release 프로세스만 종료**한 뒤 올바른 config로 재시작했다. 이후 native의 간식 이동 기대 좌표 변화가 없어1회 실패했으며, 캡처 뒤 테스트 앱 재활성·필요 시 명시적 재개·게임판 포커스를 확보하게 검사 코드를 보강한 전체 재실행이 종료0. 제품의 자동 정지 계약은 유지했다.
- 최종 코드 검증: 변경 뒤 `npm test`53개 통과, lint·Prettier 최종 확인. `npm run build`의 tsc+Vite 통과, 기존500KB 메인 번들 경고 유지. Rust/IPC/권한 변경은 없으므로 Rust 단위/clippy·SSH 엔진 회귀를 이번에 재실행하지 않았다.
- 미검증/남은 ID: **G.6 Mac 실기기**, **G.6 물리 멀티터치**, **G.6 실제 SSH 배경 입력 격리 재검증**, **G.6/5.3 최신 설치 패키지**. 환경 부재/요청 범위 내 로컬 PTY 검증으로 대기한다. 모든 가능한 시드를 전수 플레이했다고 주장하지 않으며 자동 검증 범위는800맵 제약·20맵 입력 완주다. 기존 Phase 상태는 유지한다.
- 다음 첫 행동: 최신 `target/release/daxterm.exe` 실행 → 게임 → 닥스의 모험. Space 물기·↑ 점프·공중 ↓ 밟기로 플레이하고, 정지 후 맵 선택에서 시드42/4환경을 재현한다. 후속은 물리 터치/Mac/실제 SSH, 배포 시 최신 설치 패키지 검사다.
- 안전거리 최종 보정: 쉼터와 순찰 적의 중심 거리에서 순찰 범위를 빼도 충돌 반경43보다 크도록 일반 적 위치를 조각 시작+80, 멧돼지+100/범위40으로 제한했다. 800맵 모두 해당 조건을 검사하도록 추가하고 규칙13개·20맵 입력 완주 재통과. 최종 랜덤 UI4개(시드/4환경/Space·밟기/완주→다음 구간)도 다시 전부 통과. 같은 자산으로 debug 재빌드 종료0(45.78초), 마지막 release에 이 보정도 포함한다.

- 최종 산출물: 안전거리 보정판의 native 전체 검사 재실행도 종료0. 최종 release `npm run tauri -- build --no-bundle --config target/adventure-tauri.json` 종료0(5분00초). `target/release/daxterm.exe`와 동일 해시 보관본 `target/verification/daxterm-adventure.exe`: 2026-11-05 13:25:27 KST, 28859392바이트, SHA256 0A52B3621104C5508801E155CDB287D4FF72D9DB53F23ECC603391504AF88920. G.5 간식 개선도 함께 포함한다. 실제 동작 검사는 같은 최종 자산의 별도 debug EXE 기준이며 release 자체 실행 검사를 추가한 것은 아니다. 기존 NSIS 설치본은 재생성하지 않았다.

## GitHub 원격 연결 (2026-11-05)

- `git init -b main`으로 로컬 저장소를 만들고 `origin`을 `https://github.com/splatoon-git/daxterm-workspace.git`으로 설정했다. 설정 파일은 `.git/config`다.
- `git remote -v`와 `git status -sb --untracked-files=no`로 fetch/push URL과 초기 브랜치를 확인했다. `git -c credential.helper='!gh auth git-credential' ls-remote --symref origin`은 종료 0이며 원격 ref는 없었다. `gh repo view`에서 공개 저장소임을 확인했다.
- 커밋과 푸시는 연결 요청 범위 밖으로 미실행했다. 제품 작업 ID와 다음 행동은 각 Phase 기록을 따른다. 소스 게시를 요청받으면 먼저 공개 대상 파일과 제외 규칙을 확인한다.

## 초기 Git 커밋 (2026-11-05)

- 초기 스냅샷을 네이티브 코어·의존성(`56ac994`), 데스크톱 UI·테마·게임(`6c42960`), 회귀 검사·Windows CI(`88e1069`), 문서로 나눴다. 문서 커밋에 `AGENTS.md`, `README.md`, `docs/`를 포함했다.
- `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=1`(53개), `cargo metadata --locked --no-deps --format-version 1` 통과. `git check-ignore`로 빌드·테스트 산출물, 로컬 도구, 환경 파일 제외를 확인했다. `git diff --cached --check`는 기존 라이선스 고지, Cargo 매니페스트와 일부 Markdown 문서의 공백을 보고했으며 원본을 보존했다.
- 이번 작업에서는 제품 빌드, Windows 네이티브, Mac, 실제 SSH 검증을 재실행하지 않았다. 기존 작업 ID와 다음 행동은 각 Phase 기록을 따른다. 커밋은 로컬 `main`에 있으며 공개 원격 푸시는 게시 요청 시 별도로 진행한다.




## G.7 — 보스전·타격감·맵 표현·키보드 진행 (2026-11-05, 구현·Windows 검증·release 빌드 완료)

- 요청: 보스전, 물기/밟기 타격감, 맵 표현 향상, Space 시작/다음 스테이지를 포함한 키보드 전용 진행. G.6 생성기/물리와 G.5 공유 마스코트·간식 구현을 유지해 확장했다.
- 파일: `src/features/games/{adventureLevels.ts,adventureEngine.ts,AdventureGame.tsx,AdventureWorld.tsx,adventureAudio.ts,games.css,adventureEngine.test.ts}`, `tests/ui/adventure-random.spec.ts`, `scripts/verify-adventure-native.mjs`, `docs/roadmap.md` G.7.
- 보스: 월드4,780·출구4,640, 전장3,650~4,460와 직전쉼터3,550. 네 환경 수호자 외형/이름·체력8, 예고→돌진/도약→회복, 절반 체력 시 빨라지는 돌진. 물기1/머리 밟기2·짧은 무적·공격별 중복 피해 제한, 처치500점/체력2 회복, 전장 양쪽 잠금과 처치 후 출구 개방. 사망 Space는 마지막 쉼터·체력5·미처치 보스 초기화, 기존 점수/획득/스위치 유지. 같은 맵 처음부터 재시작 버튼은 별도 유지.
- 타격/입력: 물기45ms·밟기75ms 물리 정지, 예약 입력 보존·정지/blur 시 예약 제거, 반동/불꽃/명중 문구/화면 진동. 사용자 동작 후 Web Audio 합성 단발 효과음, M 음소거, 정지/비활성 시 suspend·unmount close. 모션 줄이기는 진동/충격 광선 생략. Space 준비→시작/정지→재개/클리어→다음 즉시 시작/사망→쉼터 재도전, P 정지/재개. repeat는 전환/공격 중복 방지. 기존 게임판 포커스 및 터미널 입력 격리 유지, 새 IPC/네트워크/의존성 없음.
- 맵 표현: 토큰 기반 그라데이션 하늘/광원·다중 원근, 큰 나무/유적 아치·물길/수정/눈 덮인 전나무, 지면 덮개·돌 질감/발판 두께/보스 기둥·문양/체력 HUD. 기존 닥스 atlas 유지. `target/verification/adventure-{forest,ruins,cave,snow}-{1280,360}.png`, `adventure-boss.png`, `adventure-stomp.png`, `adventure-next-stage.png` 생성. 숲·보스·360px 동굴 화면 직접 확인.
- 현재 통과: `npm test -- --maxWorkers=1` 전체56개(모험16개), 800맵 생성 제약과20맵 보스 포함 일반 조작 완주. `npm run typecheck`, 전체lint, frontend build 통과(기존500KB 메인 번들 경고 유지). `npx playwright test --config target/playwright-adventure.config.ts tests/ui/adventure-random.spec.ts tests/ui/dax-games.spec.ts tests/ui/games.spec.ts --workers=2` 16개 통과: 키보드 시작/보스 처치/다음 즉시 시작·반복 억제·정지/재개·음소거/모션 줄이기 및 기존 게임/테마/포인터/탭 회귀.
- 검증 중 발견: 추가 사망/Space 재도전 UI 검사는 lazy 게임판 준비 전 키를 전송해 시작하지 못했고1회 실패했다. 게임판 자동 포커스 확인을 기다린 후 입력하게 수정해 재실행 중이다. 정지 중 타격 예약 입력까지 지우도록 최종 보강 후 frontend+native debug를 다시 빌드 중이다.
- 남은 ID: **G.7 Windows native/최종 release** 실행 중, **G.7 Mac·물리 멀티터치·실제 SSH·NSIS 설치본** 미실행 대기. 이번 로컬/브라우저 결과를 실제 SSH/Mac 결과로 대체하지 않는다. 다음 첫 행동: 진행 중 UI/빌드 결과 확인 → 같은 자산 debug EXE 실제 WebView2·로컬 PTY 검사 → 최종 release와 결과/해시 기록.
- 후속 확인: 사망/Space 쉼터 재도전 UI 통과(총 고유 UI17개). 최종 입력 정리를 Effect 안 setState에서 재개 첫 tick의 예약 제거로 변경해 React set-state-in-effect 린트 오류를 해결했다. 최종 변경 파일 ESLint 종료0, 밟기/키보드 시작·정지·재개/사망 재도전 UI3개 재통과. 최신 frontend build 종료0 후 같은 자산으로 debug 재빌드 중이다.
- Windows 실제 검증: 최종 debug 재빌드 종료0(51.07초), `DAXTERM_TEST_BINARY=target/verification/daxterm-adventure-debug.exe`로 `node scripts/test-games-native.mjs` **종료0**. 실제 WebView2에서4환경/시드42·Space 시작(공격 오발 없음)/물기·↑점프·↓밟기·P 정지/Space 재개, 기존6종게임·기록·탭 복귀, 실제 로컬 PowerShell PTY 유지와 게임 키 입력 격리를 확인했다. 보스 완주는 엔진20맵·브라우저 실조작 결과이며 native에서 보스까지 완주했다고 주장하지 않는다. 테스트 앱은 finally에서 종료했다. `target/verification/adventure-native.png` 저장.
- 사용 설명: `README.md`의 쉼터 수를3곳으로 갱신하고 보스/Space 전체 흐름·P/M·쉼터 재도전과 맵 처음부터 재시작의 차이를 기록했다. Rust/IPC/권한 변경 없음. 같은 최종 자산을 사용하는 release 빌드 진행 중이며 Mac/물리 터치/실제 SSH/설치 패키지는 위 대기 상태다.


- 최종 산출물: `npm run tauri -- build --no-bundle --config target/adventure-tauri.json` **종료0**, 최적화 빌드12분12초. `target/release/daxterm.exe`와 보관본 `target/verification/daxterm-adventure.exe` 해시 일치: 2026-11-05 14:16:06 KST, 29,264,896바이트, SHA256 **975FD934394673713C9FC120ECD5AF01C7A8718F4E17447D0C6054CE80C18C3E**. 최종 입력 정리 수정까지 포함한 내장 자산이다. Windows 동작 검증은 동일 최종 자산의 debug EXE 기준이며 release 자체 실행 검사는 별도로 하지 않았다. G.5 간식 개선도 포함한다.
- 최종 검증 상태: 규칙56개·고유 게임 UI17개·실제 Windows WebView2/로컬 PTY 검사 통과. 마지막 입력 정리 수정 후 관련 UI3개 및 해당 파일 ESLint, frontend build를 재통과했다. 변경 파일 Prettier 및 `git diff --check` 종료0. 실패한 사망 UI의 초기 포커스 대기와 Effect setState 린트 문제는 위와 같이 수정·재검증했다. 문서의 기존 초기 Git 기록과 다른 Phase 상태는 보존했다.
- 남은 ID/미검증: **G.7 Mac 실기기**, **G.7 물리 멀티터치**, **G.7 실제 SSH 배경 입력 격리 재검증**, **G.7/5.3 최신 NSIS 설치본**. 해당 환경 부재 및 이번 Windows 로컬 검증 범위로 대기한다. Rust/IPC/권한 코드는 바꾸지 않아 Rust 단위/clippy/SSH 엔진 회귀는 재실행하지 않았다.
- 다음 첫 행동: 최신 `target/release/daxterm.exe` 실행 → 게임 → 닥스의 모험 → Space. ←/→ 이동·↑ 점프·Space 물기·공중 ↓ 밟기, P 정지/재개·M 효과음. 보스를 처치하고 출구에 도착하면 Space로 다음 스테이지가 즉시 시작되며 사망하면 Space로 마지막 쉼터에서 재도전한다. 후속 환경 검증/배포를 진행할 때 Mac·물리 터치·실제 SSH·최신 설치 패키지부터 확인한다.

## GitHub main 푸시 (2026-11-05)

- 사용자 요청에 따라 초기 커밋 4개를 그대로 `origin/main`에 푸시했다. 최종 커밋은 `e9410ddb45c1d14a7b18b4431be0496e8157dbcb`다.
- `git ls-remote --heads origin refs/heads/main`에서 원격 SHA 일치를 확인했고 `git rev-list --count origin/main`은 4다. 로컬 `main`의 upstream을 `origin/main`으로 설정했다.
- 이후 G.7 작업의 수정/미추적 파일은 작업 트리에 있으며 이번 푸시 대상은 기존 4개 커밋이다. 이 진행 기록은 로컬 변경으로 남겼다. 제품 검증은 이번 Git 전송 작업에서 재실행하지 않았으며 남은 작업 ID와 다음 첫 행동은 G.7 기록을 따른다.

## G.7 변경 분리 커밋·푸시 (2026-11-05)

- 사용자 요청에 따라 남은 변경을 보스전/쉼터 엔진·규칙 검사(`b800773`), 화면·효과음·키보드 조작(`05cacb1`), 브라우저/native 회귀 검사(`b692582`), README·roadmap·progress 문서로 나눠 커밋했다. 원격 대상은 `origin/main`이다.
- 최초 `npm run typecheck`가 Node Zone Allocation 메모리 오류로 종료134였다. `node --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit`, 같은 옵션의 `node_modules/eslint/bin/eslint.js .`, `node_modules/vitest/vitest.mjs run src --maxWorkers=1`로 순차 재실행해 모두 종료0, 테스트56개 통과했다. 변경 파일 인증정보 패턴 일치0건, `git diff --check` 통과.
- 이번 커밋 작업에서 Windows native/UI·release 빌드·Mac·실제 SSH 검사를 재실행하지 않았다. G.7의 기존 실제 검증 결과와 미검증 이유는 위 기록을 따른다. 남은 작업 ID는 G.7 Mac·물리 멀티터치·실제 SSH, G.7/5.3 최신 NSIS다.
- Git 전송 확인은 `git ls-remote --heads origin refs/heads/main`과 로컬 `git rev-parse HEAD` 비교, `git status -sb`로 수행한다. 제품 작업의 다음 첫 행동은 G.7 기록의 최신 실행 파일 확인이다.

## G.8.0 — 닥스의 서바이버 설계 (2026-11-05, 설계안 작성 완료)

- 사용자 요청: 먼저 설계. 서바이버류 로그라이크에 HP·경험치·골드·레벨업 랜덤 능력 카드를 포함한다. 후속 답변으로 **5분 생존 + 최종 보스**, **골드 영구 강화·해금**을 확정했다. 제품 구현은 이번 요청 범위에 포함하지 않는다.
- 파일: `docs/design/dax-survivor.md` 신규 설계안, `docs/roadmap.md` §11 G.8 범위/순서/완료 기준, 이 진행 기록. `catalog.ts`, `GamePane.tsx`, `shared.tsx`, `AdventureGame.tsx`, `DaxSprite.tsx`, `src/app/App.tsx`의 게임 연결 지점을 읽어 기존 6종·탭 보존·포커스·마스코트 계약을 확인했다.
- 설계 내용: 이동·자동 공격, HP/피격/무적, XP 곡선·연속 레벨업, 랜덤 3장 중 1장·무기/능력 각 4슬롯·다시 뽑기·진화, 5분 구간별 적/정예/최종 보스, 사망 시 수집 골드 보존, 영구 구매·환불·해금, 5초 체크포인트·중복 정산 방지·여러 창 소유권, 화면/키보드/테마/Canvas 성능 설계. 무기 6·능력 8·진화 3 등 콘텐츠 수와 상세 수치는 설계 제안이며 밸런스 실증값이 아니다.
- 실제 문서 검증: `git diff --check` 종료 0. PowerShell로 변경 3문서의 로컬 링크 **25개**를 확인하고 신규 설계 문서 후행 공백 **0개**를 확인했다. JavaScript로 XP 식의 누적 값을 검산해 레벨 16/20/22에 각각 **657/1152/1471 XP**, 5분 기본 생성 예산 **600마리**(상한·스킵 전), 영구 HP/공격/수집/골드 강화 전체 비용 **460/575/190/290**을 확인했다. 수치 산술 검산이며 실제 플레이 성공이나 밸런스 검증이 아니다.
- 검토 보완: 단일 숫자용 기존 `useBest`를 재화 저장에 사용하지 않도록 분리했다. 앱 재시작 시 전투 복원과 체크포인트 골드 회수를 구분했고, 오래된 종료 이벤트의 재지급을 막는 runId 조건·실제 지불액 기준 강화 환불을 명시했다. 현재 atlas가 8방향 이미지라고 가정하지 않는다.
- 미실행/이유: 소스·빌드 설정을 바꾸지 않은 설계 작업이므로 제품 타입/린트/테스트/빌드·브라우저/Windows native·실제 SSH·Mac·물리 터치·설치본 검증을 새로 실행하지 않았다. Web Locks 지원·60fps 목표·첫 판 난이도·골드 수익은 구현 단계의 확인 항목이며 성공으로 기록하지 않는다. 기존 Phase 및 G.7 검증 상태를 변경하지 않는다.
- 남은 ID: **G.8.1~G.8.6 전부 미착수**. 다음 첫 행동: 설계 수정 요청은 이 설계안과 roadmap을 함께 갱신한다. 구현 요청을 받으면 G.8.1의 `survivor/types.ts`, `content.ts`, `engine.ts`부터 고정 시간 이동·물기·슬라임·HP·XP를 만들고 후속 작업을 순서대로 이어간다.

## G.8.1 — 닥스의 서바이버 전투/HP/XP (2026-11-05, 엔진 구현·규칙 검증 완료)

- 요청 범위: G.8.1만 구현. 위 G.8.0의 미착수 상태를 이번 기록으로 갱신한다. G.8 전체 완료가 아니며 실제 게임 메뉴/화면 연결은 G.8.5다. 기존 설계 문서 변경과 다른 게임/터미널 코드는 보존했다.
- 파일: `src/features/games/survivor/{types.ts,content.ts,random.ts,spatial.ts,engine.ts,engine.test.ts}` 신규. `docs/roadmap.md` G.8, `docs/design/dax-survivor.md`의 현재 범위/좌표/피격/엔진 연결 계약, 이 진행 기록 갱신. 추가 패키지·IPC·네트워크·Rust·게임 카탈로그 변경 없음.
- 전투: 변경 가능한 런을 ref로 소유하는 구조, 60Hz 고정 틱과 부분 틱 누적/한 프레임 최대 5틱/초과 지연 폐기. 축/대각 이동 210, 월드 3200×3200·논리 전장 960×540, 원형 충돌/월드·카메라 경계. 기본 물기 피해 18·반경 90·120도·51틱 주기, 가까운 적/동률 작은 ID 표적·한 공격당 단발 명중. 슬라임 HP24/속도70/피해10/XP3 추적, 75틱마다 안전한 화면 밖 초기 스폰. 5분 구간 확장은 후속이다.
- HP/XP: HP100·방어 최소 피해1·45틱 공통 접촉 무적·감쇠 반동/이동 유지·HP0 종료. 같은 틱에서 사망을 XP 수집/선택보다 먼저 확정한다. XP는 수집 반경64·소수 잔여·설계 비용 곡선·레벨40 상한. 연속 레벨업은 `pendingChoices`에 쌓아 `choosing`에서 정지한다. 정지/재개는 선택 상태도 보존하며 카드 적용 자체는 G.8.2다.
- 자원/재현: 스폰/드롭/카드별 시드 난수 분리(현재는 스폰만 소비), 공간 격자로 충돌 후보 제한, 일반 적180/XP 드롭250 상한·근접 결정 병합으로 XP 총량 보존·제거 객체 재사용. 렌더링/저장 형식과 런 데이터를 분리한다. 이 구현은 실제 메모리/프레임 성능 통과 기록이 아니다.
- 실제 검증: `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src/features/games/survivor --maxWorkers=1` **21개 통과**. 정상/8방향/부분 입력/월드 경계·비정상 시간, 30/60/120Hz 전체 상태 일치·최대5틱/정지, 추적/겹침, 물기 표적/부채꼴 경계/중복/주기, 무적/방어/사망 우선, XP 이월/연속 레벨/상한/병합, 100시드×중앙/4모서리 **500개 스폰 경계 조합**, 적 상한과 난수 스트림 격리 확인. 시드0/42/4294967295의 초기 런에서 상태 보정 없이 일반 이동·자동 공격으로 첫 레벨업에 도달했다. 자동 입력 검증이며 재미/첫 판 클리어/5분 밸런스의 수동 플레이 결과가 아니다.
- 전체 검증: `node --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit`, `node --max-old-space-size=1024 node_modules/eslint/bin/eslint.js .` **종료0**. `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src --maxWorkers=1` **7파일/77개 통과**(기존56+신규21). `NODE_OPTIONS=--max-old-space-size=1024`로 `npm run build` **종료0**, 기존 메인 번들 500KB 경고 유지. 신규 소스 Prettier와 `git diff --check` 통과. PowerShell로 변경 3문서의 로컬 Markdown 링크 **26개**가 실제 파일을 가리키는 것도 확인했다.
- 미실행/이유: UI와 카탈로그에 연결하지 않은 순수 엔진 단계라 브라우저/Windows WebView2/실제 로컬 PTY·SSH 입력 격리·Mac·물리 터치 검증 및 native debug/release/NSIS 빌드는 실행하지 않았다. 기존 실행 파일은 이번 엔진을 포함한 플레이용 빌드가 아니다. Rust/IPC 변경이 없어 Rust 단위/clippy·SSH 엔진 검사를 재실행하지 않았다. 실환경 결과는 G.8.5/G.8.6 및 기존 대기 ID로 남긴다.
- 남은 ID: **G.8.2 카드·6무기·8능력·3진화·다시 뽑기**, **G.8.3 5분·적·보스·골드/회복 드롭**, **G.8.4 영구 성장·저장/복구**, **G.8.5 화면/탭/입력**, **G.8.6 밸런스/성능/실환경/산출물**. 기존 Phase·G.7의 환경 대기 상태는 변경하지 않는다.
- 다음 첫 행동: G.8.2 요청 시 `survivor/types.ts`, `content.ts`, `engine.ts`와 설계안 §5~6을 읽고 `progression.ts`에 슬롯/랭크/해금 조건에 맞는 카드 후보·독립 cards 스트림 추첨을 구현한다. 실제 카드 적용 → `pendingChoices` 1 감소 → 잔여 선택 후보 재생성 → 모두 선택 후 `playing` 복귀를 연결하고 6무기·능력·진화를 순서대로 확장한다. 임시 선택 건너뛰기나 `useBest` 골드 저장을 추가하지 않는다.
