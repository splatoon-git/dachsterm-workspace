# Phase 1 macOS 검증 — 대기

- 기록일: 2026-11-04
- 상태: **미실행**. 이번 환경에 Mac 실기기/원격 Mac이 없다.
- Windows 빌드나 Linux 컨테이너 결과를 Mac 결과로 간주하지 않는다.
- 남은 ID: 0.4, 1.1, 1.2, 1.3의 macOS 항목.

## 첫 행동

Mac에서 저장소와 Node/Rust/Xcode Command Line Tools 및 Docker Linux 엔진을 준비한다. 기존 [Phase 0 Mac 절차](phase-0-macos.md)부터 확인한 후 아래 명령을 실행한다.

```text
npm ci
npm run typecheck
npm run lint
npm test
npm run build
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
npm run probe:phase1
npm run tauri -- dev
```

`test:native`는 WebView2 CDP 기반 Windows 전용이므로 Mac 실행 성공을 기대하지 않는다. Mac에서는 네이티브 WKWebView 앱에서 아래 작업을 실제로 수행한다.

- [ ] 최초 지문 확인/거부, 저장 후 신뢰 재사용, 변경/폐기된 키 차단.
- [ ] 비밀번호·RSA/Ed25519 키·암호화 키와 잘못된 Passphrase.
- [ ] Keychain 저장/조회/교체/삭제, 저장소 실패 시 비저장 연결, 복제 시 비밀 복제 없음.
- [ ] 세션·그룹 CRUD, 검색·즐겨찾기·최근 접속, 재실행 복원.
- [ ] 5개 연결, 개별 종료·탭 전환, Command 키 복사/붙여넣기와 여러 줄 확인.
- [ ] 한글 IME 조합·확정·삭제, UTF-8 서버 셸에서 vim/top/htop, 창 resize.
- [ ] KeepAlive 단절 감지, 재접속 시 새 셸, 앱 종료 후 원격 셸·소켓 정리.
- [ ] SQLite와 일반 설정·오류 로그에 인증정보 평문이 없음.

OS 버전, 실행 명령/결과, 실제 앱 동작, 실패 재현을 이 파일에 추가한 뒤 `docs/progress.md`를 갱신한다. 인증정보·개인키·Passphrase를 기록하지 않는다.
