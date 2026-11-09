---
name: mac-verify
description: MacBook에서 DachsTerm을 빌드·실행·검증하고 결과를 기록하는 절차. Mac 빌드 확인, Mac 실기기 검증, Mac 대기 항목 처리, macOS 앱·DMG 생성을 요청받았을 때 사용한다. macOS에서 실행 중일 때만 쓴다.
---

# Mac 검증

실제 Mac에서 실행한 결과만 기록한다. `uname -s`가 `Darwin`이 아니면 중단하고 사용자에게 알린다. Windows나 CI 결과를 Mac 실기기 결과로 옮겨 적지 않는다.

## 1. 준비

1. `git status`와 현재 커밋을 확인한다. 결과에 커밋 또는 미커밋 여부를 함께 적는다.
2. 환경을 기록한다: `sw_vers`, `uname -m`, `node -v`, `rustc -V`, `xcode-select -p`, `docker version`.
3. 도구가 없으면 사용자에게 알린다. 필요한 것은 Xcode Command Line Tools, Node 24 이상, rustup, OpenSSL(`brew install openssl@3`, `--workspace` 명령에 필요, M.1), Docker Linux 엔진이다. 동의 없이 시스템 설정을 바꾸지 않는다.
4. `npm ci`를 실행한다. Windows에서 복사한 `node_modules`, `target`, `dist`는 쓰지 않는다.

## 2. 자동 게이트

`bash scripts/verify-macos.sh --package`를 실행한다. 실패하면 항목과 출력 요약을 기록하고 원인을 고친다. Mac만의 실패인지 먼저 구분한다. 고친 뒤 Windows를 깨지 않는지 engineering-rules §11을 확인한다.

## 3. 실제 SSH 엔진

Docker가 있으면 `npm run probe`와 `npm run probe:phase1`을 실행한다. Docker가 없으면 대기로 기록한다. `npm run probe:ftp`는 `.tools/ftp-fixture` Python 환경이 있으면 실행한다. `npm run test:native`, `test-*-native.mjs`, `probe:ftp --native`는 Windows 전용이므로 실행하지 않는다.

## 4. 앱 실기기 확인

`.app`을 **Finder 또는 `open`으로** 실행한다. 터미널에서 실행하면 `PATH`가 달라 일부 문제가 드러나지 않는다.

[macos-readiness](../../../docs/verification/macos-readiness.md)의 작업 ID를 먼저 확인한 뒤, 아래 체크리스트를 순서대로 진행한다. 사람의 조작이 필요한 항목(Keychain 승인, 한글 IME, 파일 대화상자, 로컬 네트워크 권한)은 절차를 안내하고 사용자의 관찰 결과를 받아 기록한다.

1. [Phase 0 Mac](../../../docs/verification/phase-0-macos.md)
2. [Phase 1 Mac](../../../docs/verification/phase-1-macos.md)
3. [Phase 2~5 Mac](../../../docs/verification/phase-2-5-macos.md)

사용자가 범위를 지정했으면 그 범위만 진행한다.

## 5. 기록

- 인증정보, 개인키, Passphrase는 로그와 스크린샷에도 남기지 않는다.
- 항목별 결과는 해당 Phase의 Mac 문서에, 전체 요약과 작업 ID 상태는 `macos-readiness.md`에 적는다. 명령, 범위, 대상 커밋을 함께 적는다.
- `docs/progress.md`의 해당 ID 상태와 다음 첫 행동을 갱신한다.
- 실행하지 않은 항목은 이유와 함께 대기로 남긴다.
