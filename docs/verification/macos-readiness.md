# macOS 준비 상태

Mac 빌드와 동작의 현재 상태, 남은 작업 ID의 정본이다. 항목별 실기기 체크리스트는 [Phase 0](phase-0-macos.md), [Phase 1](phase-1-macos.md), [Phase 2~5](phase-2-5-macos.md)에 있다.

- 기록일: 2026-11-06 / 대상: `0b3dc2b`
- **macOS CI 첫 실행 통과**(실행 `42162935907`, `macos-26-arm64`). 빌드와 자동 테스트만 확인한 것이다.
- **실기기에서 앱을 실행한 결과는 아직 없다.** CI는 앱을 띄우지 않으며, Keychain·IME·파일 대화상자·실제 SSH 접속은 실행되지 않았다.

## CI에서 확인한 것

같은 커밋의 Windows 실행(`42162935824`)도 통과했다.

| 항목 | macOS | Windows |
|---|---|---|
| Vitest | 18파일 231개 통과 | 231개 통과 |
| Playwright (Chromium) | 87개 통과 | 87개 통과 |
| `cargo test --workspace` (앱 / ssh-probe) | 55개 / 1개 통과 | 56개 / 1개 통과 |
| `cargo clippy --workspace --all-targets -D warnings` | 통과 | 통과 |
| C 컴파일과 링크 (`ring`, SQLite, `libssh2`) | 통과 | 통과 |
| 앱 번들 | debug `DachsTerm.app` 81.85MiB 생성 | 이 실행에서는 생성하지 않음 |

Rust 테스트 차이 1개는 Windows 전용 `local::tests::wsl_unicode_names`다. Playwright는 Mac에서도 Chromium으로 실행된다. WKWebView 동작을 검증한 것이 아니다.

통과해도 M.1~M.11은 그대로 남는다. 이 게이트는 해당 경로를 실행하지 않는다. M.1은 러너에 OpenSSL이 있어 CI에서 드러나지 않고, M.2의 `refuses_link_ancestor`는 예상대로 통과했으며, M.3·M.4는 Finder로 실행한 앱에서만 나타난다.

## 교차 검사와 코드 읽기로 확인한 것

| 항목 | 결과 | 근거 |
|---|---|---|
| 앱 크레이트 Rust 코드 | 통과 | `cargo clippy -p dachsterm --all-targets --locked --target aarch64-apple-darwin -- -D warnings` 종료 0. 라이브러리, 바이너리, 테스트, 예제 3개 포함 |
| npm lockfile | Mac 바이너리 포함 | `sharp`, `rolldown`, `lightningcss`, `@tauri-apps/cli`의 `darwin-arm64`, `darwin-x64` 항목 존재 |
| Cargo.lock | Mac 의존성 포함 | 위 검사가 `--locked`로 해석됨 |
| 번들 입력 | 존재 | `icon.icns`, `targets: all`, `keyring`의 `apple-native` |
| UI 테스트 기준 이미지 | 없음 | `toHaveScreenshot` 미사용. OS별 이미지 차이로 실패할 일이 없다 |

위 Rust 검사는 Windows에서 C 컴파일러를 빈 파일만 만드는 스텁으로 바꿔 실행했다. C 컴파일, 링크, 번들 생성, 테스트 실행은 이후 CI 실행으로 확인했다.

## 작업 목록

상태는 모두 미착수다. 수정 후 Mac에서 확인해야 완료로 기록한다. roadmap의 5.2, 5.3에 속한다.

표시: **확인** = 코드 또는 명령 출력으로 확인(Mac 실행은 아님) / **추정** = Mac에서 재현 필요

### 빌드

| ID | 영향 | 상태 | 내용 | 조치 |
|---|---|---|---|---|
| M.1 | 높음 | 확인 | `crates/ssh-probe`의 `ssh2`가 Unix에서만 `libssh2-sys`→`openssl-sys`를 끌어온다. OpenSSL이 없는 Mac에서는 `cargo clippy --workspace`, `cargo test --workspace`가 실패한다. 앱 빌드(`tauri build`)는 이 크레이트를 포함하지 않는다. CI 러너에 OpenSSL이 있으면 CI에서는 드러나지 않는다. | 당장은 `brew install openssl@3`를 전제로 한다. 장기적으로는 `ssh2` 비교 실증을 유지할지 결정한다 |

### 동작

| ID | 영향 | 상태 | 내용 | 조치 |
|---|---|---|---|---|
| M.2 | 높음 | 확인 | `transfer_queue.rs`의 `local_guard`는 모든 상위 경로의 심볼릭 링크를 거부한다. macOS의 `/tmp`, `/var`는 심볼릭 링크라서 이 아래 경로의 전송이 "링크 또는 junction" 오류로 실패한다. `tempfile`의 기본 위치(`/var/folders/…`)도 해당되어 `examples/queue/checks.rs` 같은 실증이 막힌다. `refuses_link_ancestor` 테스트는 링크가 없어도 통과하게 되어 검증력을 잃는다. | OS가 소유한 최상위 링크를 허용하고 사용자 링크 거부는 유지한다. 테스트는 정상 경로 통과도 함께 단언한다 |
| M.3 | 높음 | 확인 | Finder로 실행한 앱의 `PATH`에는 Homebrew가 없다. 로컬 PodTree는 `--noprofile --norc`로 실행되어 `command -v kubectl`이 실패한다. `bash_target`이 Homebrew Bash를 골라도 `podtree.rs`의 `exec bash`는 `PATH`의 Bash 3.2를 실행하는데, `podtree.sh`는 `declare -A`, `mapfile`을 쓴다. `tauri dev`는 터미널의 `PATH`를 물려받아 재현되지 않는다. | 시작 시 로그인 셸의 `PATH`를 얻어 적용하고, `exec`에는 선택한 Bash의 절대 경로를 쓴다 |
| M.4 | 높음 | 확인 | `editor.rs`의 `editor_program`은 Windows에서만 설치 경로를 찾는다. Mac에서는 `code`, `cursor`, `subl`을 이름으로 실행하므로 Finder 실행 앱에서 M.3과 같은 이유로 실패한다. | `.app` 내부 CLI 경로 탐색을 추가한다 |
| M.5 | 중간 | 확인 | macOS의 로컬 파일 이름은 NFD 한글일 수 있는데, 업로드 이름을 NFC로 정규화하는 코드가 없다. 서버에 자모가 분리된 이름으로 저장될 수 있다. | 업로드 시 이름 정규화. 기존 원격 이름과의 충돌 비교도 함께 정한다 |
| M.6 | 중간 | 확인(구성) / 추정(영향) | `tauri.conf.json`에 `bundle.macOS`가 없고 `NSLocalNetworkUsageDescription`도 없다. macOS의 로컬 네트워크 개인정보 보호는 사내망 SSH 접속에 적용되며, 코드 서명으로 앱을 식별하므로 ad hoc 서명에서는 불안정할 수 있다. 재빌드 시 서명이 바뀌면 Keychain 승인을 다시 요청할 수도 있다. | `Info.plist` 문구, `signingIdentity`, `minimumSystemVersion` 지정. LAN 서버 접속으로 확인한다 |
| M.7 | 낮음 | 추정 | 터미널 글꼴이 `'Cascadia Code', 'SFMono-Regular', Consolas, monospace`다. Mac에서 일반 `monospace`로 떨어져 글꼴과 폭이 나빠질 수 있다. | `ui-monospace`, `Menlo`를 추가한다 |
| M.8 | 낮음 | 추정 | xterm에 `macOptionIsMeta`를 지정하지 않아 Option 조합이 Meta로 전달되지 않는다. Command 복사·붙여넣기와 파일 패널의 `Ctrl+C` 표기도 Mac 관례와 맞는지 확인이 필요하다. | 실기기에서 확인 후 설정 추가 |

### 검증 도구

| ID | 영향 | 상태 | 내용 | 조치 |
|---|---|---|---|---|
| M.9 | 중간 | 확인 | `*-native.mjs`는 WebView2 CDP에 의존한다. WKWebView에는 이 경로가 없어 실제 앱 UI는 Mac에서 수동으로 검증해야 한다. `run-ftp.mjs`는 `python.exe`, `ftp_probe.exe`를 하드코딩해 `probe:ftp`도 Mac에서 실행되지 않는다. | `run-ftp.mjs`의 플랫폼 분기. UI는 수동 체크리스트 유지 |
| M.10 | 중간 | 확인 | `audit-windows.mjs`와 `generate-notices.mjs`는 `x86_64-pc-windows-msvc` 의존성만 본다. Mac 전용 크레이트의 보안 권고는 게이트를 막지 않고, 번들의 제3자 고지에서도 빠진다. | 대상 플랫폼을 인자로 받거나 두 플랫폼을 합쳐 처리한다 |
| M.11 | 낮음 | 제안 | Playwright는 Chromium만 실행한다. WebKit 프로젝트를 추가하면 Windows에서도 WKWebView 차이를 일부 미리 잡을 수 있다. WKWebView 결과를 대신하지는 않는다. | 첫 CI 결과 후 판단 |

## 결정 사항 (2026-11-06 사용자 확인)

- **Apple Silicon만 지원한다.** Intel Mac 빌드와 검증은 하지 않는다.
- **배포**: 지금은 본인만 사용하므로 로컬 빌드로 충분하다. 이후 Apple Developer 프로그램에 등록할 예정이며, 그때 Developer ID 서명과 공증을 구성한다. 등록 전까지 M.6의 서명 항목은 ad hoc 기준으로 확인한다.

## 다음 첫 행동

1. M.2~M.4를 수정한다. M.3, M.4는 터미널에서 실행하면 재현되지 않으므로 패키지된 앱으로 확인한다.
2. MacBook에서 `mac-verify` 스킬로 실기기 검증을 시작한다.

## 참고

- [TN3179: Understanding local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
- [How local network privacy could affect you](https://eclecticlight.co/2026/01/14/how-local-network-privacy-could-affect-you/)
