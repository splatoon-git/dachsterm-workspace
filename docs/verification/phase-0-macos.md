# Phase 0 macOS 검증 — 대기

2026-11-04 현재 Mac 실기기 또는 원격 Mac 실행 환경을 제공받지 않아 **전 항목 미실행**. Windows·Linux 컨테이너 결과는 Mac 결과를 대신하지 않는다.

## 첫 실행

1. 프로젝트를 Mac 로컬 디렉터리로 복사/체크아웃한다. `node_modules`, `target`, `dist`는 복사하지 않는다.
2. Xcode Command Line Tools, Node 24+, Rustup, OpenSSL(`brew install openssl@3`, [M.1](macos-readiness.md)), Docker의 Linux 엔진을 준비한다.
3. `npm ci`, `npm run icons`, `npm run build`.
4. `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked`.
5. `npm run tauri -- dev`: 창·마스코트·키보드 포커스·최소 창 너비·한글 미리보기를 확인한다.
6. `npm run tauri -- build --debug --no-bundle`: 네이티브 빌드 및 산출 앱 실행.
7. `npm run probe`: 실제 OpenSSH 인증·키 거부·PTY·resize·SFTP·포워딩·취소 결과를 기록한다.
8. OS/칩·도구 버전·실행 명령·실제 결과·미실행 사유를 이 문서에 추가하고 progress의 0.4를 갱신한다.

체크리스트:

- [ ] Mac 네이티브 개발 실행 및 기본 빌드
- [ ] 마스코트·포커스·좁은 창·한글 표시
- [ ] 실제 기본 SSH 연결·PTY 입력/출력 및 resize
- [ ] 호스트키 불일치 거부
- [ ] SFTP 및 포워딩·취소 검사

제품의 Keychain·IME 조합 입력·vim/top/htop·분리 창 등은 해당 후속 Phase에서 별도 검증한다.
