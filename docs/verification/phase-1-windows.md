# Phase 1 Windows 구현·검증

- 날짜: 2026-11-04
- 대상: Windows / WebView2 / 실제 Debian OpenSSH Docker fixture.
- 범위: 1.1 인증·신뢰·PTY, 1.2 세션·SQLite·OS 저장소, 1.3 다중 탭·편의 기능·장애 처리.
- 결과: 아래 자동·네이티브 검증 통과. **물리 키보드의 Windows 한글 IME와 macOS는 검증 대기**.

## 구현 파일

- `src-tauri/src/{lib,commands,ssh,hostkeys,storage,credentials}.rs`: 앱 명령, 연결 소유권·취소, PTY·Channel ACK, known_hosts, SQLite, native keyring.
- `src-tauri/{build.rs,capabilities/main.json,Cargo.toml}`, `Cargo.lock`: main 창 명령 권한과 의존성.
- `src/features/sessions/SessionForm.tsx`, `src/lib/ipc.ts`, `src/components/Dialog.tsx`, `src/app/`: 세션 CRUD·그룹·필터·즐겨찾기·최근·인증 UI.
- `src/features/terminal/{session.ts,TerminalPane.tsx}`: 독립 탭, 연결 상태, 신뢰 카드, 검색·복사/붙여넣기·글꼴·스크롤백·resize·재접속.
- `src/themes/presets/light.ts`, `src/themes/theme.test.ts`: htop의 검정 ANSI 글자/초록·파랑·청록 배경 대비 보정. 일반 ANSI 글자/라이트 배경 대비와 함께 4.5:1 검사. 서버 truecolor는 변경하지 않음.
- `src-tauri/examples/phase1_probe.rs`, `scripts/{run-phase1,test-native}.mjs`, `tests/openssh/`, `tests/ui/layout.spec.ts`: 실제 엔진·네이티브 UI와 보안/레이아웃 검증.

## 실행 결과

| 명령 | 실제 결과 |
|---|---|
| `npm run typecheck` | 통과 |
| `npm run lint` | 통과 |
| `npm run format:check` | 통과 |
| `npm test` | 테마·토큰·대비 테스트 3개 통과 |
| `npm run build` | 통과. 메인 번들 약 613KB(압축 전) 크기 경고는 남음 |
| `npm run test:ui` | 6개 통과: 1280/800/560px, 키보드, 대체 테마, 세션 폼·초기 포커스·실패 시 비밀 입력 지움 |
| `cargo fmt --all --check` | 포맷 보정 후 통과 |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 통과 |
| `cargo test --workspace --locked` | 앱 6개 + 기존 실증기 1개 통과 |
| `cargo build --workspace --locked` | 앱 종료 후 재실행 통과. 실행 중 EXE 잠금과 구분 |
| `npm run tauri -- build --debug --no-bundle` | Cargo PATH 설정 후 최종 재빌드 통과, `target/debug/daxterm.exe` |
| `npm run test:native` | 종료 코드 0. 내장 자산 앱 빌드 + 제품 엔진 + 실제 Windows WebView2 통합 검증 통과 |
| `node scripts/run-phase1.mjs --native --reuse-build` | 실행 파일을 재사용하는 네이티브 진단 모드. 개발 중 사용, 최종 결과는 위 전체 명령 기준 |

`test:native` 내부에서 `cargo build --locked -p daxterm --example phase1_probe`와 `tauri build --debug --no-bundle`을 실행했다. 설치 패키지 검증은 아니다. 프런트엔드·Rust 검사 결과를 Mock SSH 성공으로 대신하지 않았다.

## 실제 제품 엔진

- 최초 키 거부 시 신뢰 파일 미생성, 승인 시 SHA-256 지문 대조·known_hosts 저장.
- 저장 키와 다른 키 및 알고리즘 변경 차단, revoked 키 거부, 잘못된 비밀번호·Passphrase 거부.
- 비밀번호, RSA SHA-2, 일반 Ed25519, Passphrase 암호화 Ed25519 인증.
- PTY UTF-8·한글 왕복, 실제 `stty size`의 37행×111열 확인, 성공 시 최근 접속 갱신.
- Windows Credential Manager의 생성·조회·삭제. SQLite를 다시 열어 복원하고 DB/WAL 등에 실제 테스트 비밀번호가 없는지 확인.
- 5개 동시 연결, 고유 마커 입출력으로 연결 격리, 개별 종료 후 다른 연결 유지.
- 1MiB 출력 중 ACK 전에는 최대 32KiB 한 프레임만 전달. 출력 대기 중 취소, 새 연결 재접속.
- SSH 응답이 없는 TCP 대상에서 설정된 handshake timeout, 전체 종료 시 연결 registry 비움.

## 실제 Windows 앱 UI

- 개발 서버 없이 내장 자산 앱 시작 → 그룹·세션 등록 → OS 비밀 저장 → 최초 지문 확인 → 실제 SSH 로그인.
- 저장된 프로필로 5개 탭 접속, 탭별 스크롤백·입출력, 개별 탭 닫기.
- 한글 composition 이벤트를 자동 재현해 xterm → IPC → SSH → 서버 파일까지 검증. **실제 OS IME 키 조합을 자동화한 결과는 아님**.
- 검색, 앞/뒤 탐색, 실제 시스템 클립보드 복사/붙여넣기(기존 클립보드 복원), 글꼴·스크롤백 변경.
- 창 viewport 축소 후 PTY 크기 변경, `top`, `htop`의 실제 갱신 화면과 `vim` 한글 입력·저장. 서버의 저장 파일도 별도로 확인.
- Docker pause로 실제 SSH 서버 응답을 중단 → KeepAlive 오류 감지 → unpause 후 저장 인증정보로 재접속.
- 일반 창 종료 요청에 정상 종료 코드 0, 원격의 살아 있는 bash 셸이 없어짐을 확인.
- 앱 재실행 후 그룹/세션/credential 참조 복원, 저장 프로필 더블클릭 접속.
- 수정·검색·복제·삭제. 복제에 credential이 붙지 않음. DB 비밀번호 평문 검사.
- 로컬 known_hosts를 충돌하는 공개키로 바꾸어 UI에서 연결 차단과 우회 버튼 부재 확인.

화면 증거는 재생성 가능한 `test-results-native/{connected,five-tabs,narrow-terminal,top,htop,vim}.png`. 테스트 프로필·키·credential은 일회성이며 정리했다. 마지막 fixture는 제거되었다.

## 검증 중 수정/구분한 사항

- known_hosts 공개키 comment까지 동일성 비교하던 검사 → key data 비교로 수정, revoked·hashed host 테스트 추가.
- OS 저장 후 DB 실패 시 비밀 참조 손실 위험 → 참조 정리 journal과 SQLite transaction, 실패 시 기존 참조 유지 검사 추가.
- UI의 select label/대화상자 초기 포커스 → 명시적 label과 dialog 열린 뒤 첫 입력 포커스.
- WebView2 환경변수만으로 CDP가 열리지 않는 환경 → 앱의 debug 전용 테스트 설정을 통해 명시적으로 열고 임시 profile 사용. 릴리스는 해당 설정 무시.
- fixture의 기본 ASCII 로케일이 한글 입력을 누락시킴 → fixture 셸을 C.UTF-8로 설정. 사용자 서버 로케일은 앱이 강제로 덮어쓰지 않음.
- htop의 이전 화면 텍스트와 실제 렌더 완료를 혼동하지 않도록 고유 footer·대기·스크린샷 검사. 실제 htop 배경의 ANSI 글자 대비 조정.
- 실행 중인 EXE와 별도 workspace build가 겹쳐 Windows 파일 잠금 오류 1회 발생. 네이티브 테스트와 실행 파일 빌드는 순차 실행해야 함.

## 남은 검증

1. **1.1/1.3 Windows 물리 한글 IME**: Microsoft IME에서 조합·확정·받침 이동·Backspace·Enter, vim 삽입 모드, 탭 변경·창 resize 중 조합을 실제 키보드로 확인. 이번 자동 테스트는 composition 파이프라인까지 확인했다.
2. **0.4 및 1.1~1.3 Mac**: 실제 Mac 빌드·접속·Keychain·Command 키 클립보드·IME는 [Mac 절차](phase-1-macos.md)에 따라 수행한다.
3. 장시간/절전/메모리 추적·설치 패키지·서명은 Phase 5 범위다. 이번 결과로 완료 처리하지 않는다.

브라우저 UI 테스트, 네이티브 실제 SSH 테스트, 물리 OS 입력, Mac 결과를 분리한다. Phase 1 전체 완료로 표시하지 않는다.
