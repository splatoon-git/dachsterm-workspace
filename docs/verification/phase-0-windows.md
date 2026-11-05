# Phase 0 Windows 실증 기록

- 날짜: 2026-11-04
- Windows 호스트의 Rust 실행 파일 → Docker Linux의 실제 Debian OpenSSH. Mock 사용 없음.
- Node 24.22.1, npm 11.19.1, Rust 1.99.1 MSVC, Visual Studio 18 BuildTools의 C++ 도구 확인.
- WebView2 156.0.4314.58, Docker Engine 28.5.1. OpenSSH 9.2p1 Debian 패키지.

## 실행된 검사

| 검사 | 결과 |
|---|---|
| `npm run icons` | PNG/ICO/ICNS 생성 성공, 크기별 얼굴/전신 규칙 적용 |
| `npm run typecheck` / `npm run lint` | 통과 |
| `npm run format:check` | 최종 소스 정리 후 통과 |
| `npm test` | 테마 계약·폴백·미등록 대체 정의·색상 대비 3개 통과 |
| `npm run build` | 통과. xterm lazy import 후 큰 chunk 경고 제거 |
| `npm run test:ui` | 4개 통과. 1280/800/560px 넘침·키보드·미리보기 및 등록하지 않은 테스트 테마의 UI/열린 xterm 동시 변경 |
| `cargo build --workspace --locked` | Windows 네이티브 앱과 실증기 debug 빌드 통과 |
| `cargo fmt --all --check` | 통과 |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 통과 |
| `cargo test --workspace --locked` | SOCKS5 미지원 인증·UDP 요청 거부 테스트 1개 통과. 앱 단위 테스트는 0개 |
| Tauri 개발 앱 실제 실행 | `npm run tauri -- dev --no-watch` 후 실제 WebView2 시작 화면·미리보기 전환·한글/ANSI 표시 확인 |
| 프런트엔드 내장 Tauri 빌드 | `npm run tauri -- build --debug --no-bundle` 통과. `target/debug/daxterm.exe` 실행, 1420 개발 서버가 없는 상태에서 시작 화면·lazy-loaded 터미널 확인 |

브라우저 캡처 `test-results/welcome-1280.png`, `terminal-560.png`를 직접 확인했다. 기본 화면의 색상·마스코트·패널 배치와 좁은 창 터미널 표시를 확인했다. 테스트 산출물은 Git 대상에서 제외하며 명령으로 재생성한다.

## 실제 SSH 성공 결과

`npm run probe` 첫 실행에서 다음 russh 검증이 모두 통과했다.

- 기대한 호스트 공개키 비교, 불일치 키 연결 거부. 인증 전에 검증한다.
- 잘못된 비밀번호 거부, 비밀번호 인증.
- Ed25519 개인키 인증, 암호화 개인키 인증, 잘못된 Passphrase 거부.
- 실제 interactive shell PTY 입력·출력, UTF-8 한글, 80×24 → 111×37 resize를 `stty size`로 확인.
- 같은 SSH 연결의 독립 채널에서 PTY 출력과 두 개의 2MiB SFTP 왕복. 파일 내용 바이트 일치 및 한글·공백 경로 확인.
- 전송 도중 취소 → 파일 handle 종료·부분 파일 삭제·worker join. PTY와 다른 명령 계속 실행.
- Local 포워딩 왕복, 로컬 listener 해제 및 같은 포트 재바인드.
- Remote 포워딩 왕복, cancel 요청 후 원격 포트 접속 실패 확인.
- SOCKS5 TCP CONNECT의 domain target을 SSH 서버에서 해석해 실제 echo 왕복.
- 전송 도중 disconnect → worker join·연결 종료·새 채널 거부·새 연결에서 부분 파일 삭제.
- 실행 뒤 전용 컨테이너 제거 확인.

`ssh2` 비교의 첫 두 실행은 Ed25519 전용 호스트에서 handshake `Session(-5)`로 실패했다. 런타임 `supported_algs(HostKey)`는 RSA 계열만 반환했다. fixture에 RSA 3072 host key를 추가하고 SHA-2 RSA 협상·해당 공개키 핀 검증을 적용한 최종 `npm run probe`는 종료 코드 **0**이다. ssh2 비밀번호·잘못된 비밀번호·PTY resize·64KiB SFTP·direct-tcpip 왕복도 통과했다. 기존 실패와 최종 성공을 분리 기록하며, 알고리즘 제한은 [ADR](../adr/0001-ssh-engine.md)에 남겼다.

## 수정 및 제약

- 대비 검사에서 원래 성공색 및 보조 텍스트가 일부 배경에서 4.5:1 미달. 테마 정의에서 성공 `#376F45`, 보조 텍스트 `#606970`, 입력 경계 `#8B8271` 등으로 조정한 후 통과.
- 첫 UI 검사에서 두 미리보기 버튼의 같은 이름 때문에 locator 충돌. header로 범위를 좁혀 해결. Vite가 Rust target의 잠긴 파일을 감시하는 문제도 ignore로 수정.
- `npm audit --omit=dev`: 취약점 0. 전체 npm audit: 개발용 ESLint 의존 경로의 minimatch glob 증폭 취약점으로 moderate 11개(전이 의존 집계). 자동 제안은 ESLint 과거 major로 다운그레이드여서 적용하지 않음. 제품 runtime 의존성과 구분하며 배포 전 재점검.
- Mac 실행은 미실행. 실제 서버의 vim/top/htop 상호작용 및 IME 입력은 앱 SSH 연결을 구현하는 Phase 1에서 검증한다.
- 현재 실증은 정상 disconnect와 전송 취소를 확인한다. OS 강제 종료·패킷 단절·장시간 성능·모든 암호 알고리즘 조합은 검증했다고 주장하지 않는다.

