# ADR 0002 — 제품 SSH 클라이언트의 신뢰·저장·수명

- 날짜: 2026-11-04
- 범위: Phase 1.1~1.3
- 상태: 구현, Windows 실환경 검증. macOS는 검증 대기.

## 결정

`russh 0.65.1`을 제품 엔진에 적용한다. 저장 프로필 UUID, 실행 연결 UUID, 화면 탭 UUID를 분리하고 PTY는 russh ChannelId로 관리한다. Phase 1은 연결당 PTY 하나다. Rust가 연결을 소유하고 탭 종료/취소·앱 종료 시 종료 신호를 전달한다. 접속 중 취소는 호스트키 확인도 취소하며, 인증 이후 오류·취소에는 SessionGuard가 disconnect를 보장한다. 재접속은 새 연결 ID와 새 셸을 사용하고 터미널 상태를 초기화한다.

호스트키는 인증 전에 검증한다. 앱 `known_hosts`와 사용자의 `~/.ssh/known_hosts`에서 exact/wildcard/negated/hashed host와 포트를 구분한다. `@revoked`가 일치하면 다른 파일에 정상 키가 있어도 거부한다. 호스트 인증서와 지원하지 않는 marker는 거부한다. 저장 키가 있고 제시된 키가 어느 것과도 맞지 않으면 알고리즘이 바뀐 경우도 차단한다. 공개키 comment는 키 동일성 비교에서 제외한다. 최초 지문 확인은 동일 handshake에서 이루어지며, 신뢰를 기록할 때 lock 안에서 재검증한다.

터미널 출력은 Tauri Channel로 전달한다. 32KiB 단위 바이트 배열을 xterm에 전달하고, `terminal.write` 완료 콜백의 sequence ACK 후 다음 프레임을 보낸다. xterm이 UTF-8의 분할 바이트를 조립한다. russh 수신 window 256KiB, channel buffer 8, 입력 큐 64, IPC 입력 32KiB, 프런트엔드 대기 입력 64K UTF-16 code unit 상한을 둔다. 출력 ACK는 30초, 입력 전송은 10초 제한이다. 출력과 입력 future를 분리하여 출력 ACK 대기 중에도 입력·종료가 가능하다.

SQLite(WAL, schema version 1, foreign keys)는 비밀이 없는 프로필·그룹·최근 접속과 OS credential 참조만 저장한다. Windows Credential Manager / macOS Keychain은 keyring native backend를 사용한다. 비밀번호·Passphrase 입력은 React 상태에 보관하지 않고 제출 직후 DOM에서 지운다. Rust에서는 Zeroizing을 사용하고 오류는 정해진 설명으로 반환한다. JS 문자열의 완전한 메모리 소거를 보장하지는 않는다. 개인키 내용은 Rust에서만 읽는다.

OS 저장소와 SQLite는 공동 트랜잭션을 지원하지 않는다. 새 OS 항목을 쓰기 전에 참조 ID만 `credential_gc`에 기록한다. 프로필 저장 트랜잭션에서 새 참조를 연결하고 이전 참조를 정리 대상으로 바꾼다. DB 실패 시 이전 참조를 유지하며, 미참조 OS 항목은 세션 조회 시에도 재정리한다. 정리 실패는 UI에 표시하고 참조를 남겨 재시도한다. 복제에는 비밀을 복제하지 않는다. 접속 대상·사용자·인증 방식·키 경로 변경 시 기존 credential을 조용히 재사용하지 않는다. 연결 명령도 UI가 요청한 대상과 현재 저장된 대상을 비교한다.

앱 IPC 명령 목록에서 allow 권한을 자동 생성하고 main 창에만 부여한다. 파일·shell·network 플러그인 권한을 추가하지 않는다. 키 파일 경로는 인증 명령 내부에서만 사용한다. 테스트 데이터/디버그 포트 환경변수는 `debug_assertions` 안에서만 처리하며 릴리스 빌드는 무시한다.

## 제약과 후속 검증

- Mac 기본 SSH·Keychain 결과가 없다. Windows 결과를 Mac 결과로 대체하지 않는다.
- Windows 자동 UI 검증은 실제 WebView2·실제 SSH를 사용한다. 한글 composition 이벤트 자동 재현과 물리 OS IME 입력은 별개다.
- UTF-8 로케일이 없는 서버 셸의 입력 해석을 클라이언트가 강제로 변경하지 않는다.
- 서버가 지정하는 truecolor는 테마로 강제 덮어쓰지 않는다. 자의적인 원격 출력 내용을 애플리케이션 로그에 저장하지 않는다.
- 분리 창·복수 PTY·SFTP는 해당 후속 Phase에서 이 소유권 위에 구현한다.

## 참고

- [Tauri Channel](https://v2.tauri.app/develop/calling-frontend/)
- [Playwright WebView2](https://playwright.dev/docs/webview2)
- [keyring 3.6](https://docs.rs/keyring/3.6.3/keyring/)
- 구현 검증: `npm run probe:phase1`, `npm run test:native`, [Windows 기록](../verification/phase-1-windows.md).
