# macOS 준비 상태

Mac 빌드와 동작의 현재 상태, 남은 작업 ID의 정본이다. 항목별 실기기 체크리스트는 [Phase 0](phase-0-macos.md), [Phase 1](phase-1-macos.md), [Phase 2~5](phase-2-5-macos.md)에 있다.

- 기록일: 2026-11-06 / 대상: `0fcf569`
- **macOS CI 통과**(실행 `42170815875`, `macos-26-arm64`). 빌드와 자동 테스트만 확인한 것이다.
- **실기기에서 앱을 실행한 결과는 아직 없다.** CI는 앱을 띄우지 않으며, Keychain·IME·파일 대화상자·실제 SSH 접속은 실행되지 않았다.

## CI에서 확인한 것

같은 커밋의 Windows 실행(`42170815900`)도 통과했다.

| 항목 | macOS | Windows |
|---|---|---|
| Vitest | 18파일 231개 통과 | 231개 통과 |
| Playwright (Chromium) | 87개 통과 | 87개 통과 |
| `cargo test --workspace` (앱 / ssh-probe) | 66개 / 1개 통과 | 61개 / 1개 통과 |
| `cargo clippy --workspace --all-targets -D warnings` | 통과 | 통과 |
| C 컴파일과 링크 (`ring`, SQLite, `libssh2`) | 통과 | 통과 |
| 앱 번들 | debug `DachsTerm.app` 81.96MiB 생성 | 이 실행에서는 생성하지 않음 |

Rust 테스트 수 차이는 Mac 전용 6개(`login_path` 5개, `local_links` 1개)와 Windows 전용 1개(`wsl_unicode_names`) 때문이다. Playwright는 Mac에서도 Chromium으로 실행된다. WKWebView 동작을 검증한 것이 아니다.

이 통과가 M.1, M.5~M.11의 해결을 뜻하지는 않는다. 이 게이트는 해당 경로를 실행하지 않는다. M.1은 러너에 OpenSSL이 있어 CI에서 드러나지 않는다.

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

M.2~M.4는 수정했고(`0fcf569`), 나머지는 미착수다. Mac 실기기에서 확인해야 완료로 기록한다. roadmap의 5.2, 5.3에 속한다.

표시: **확인** = 코드 또는 명령 출력으로 확인(Mac 실행은 아님) / **추정** = Mac에서 재현 필요

### 빌드

| ID | 영향 | 상태 | 내용 | 조치 |
|---|---|---|---|---|
| M.1 | 높음 | 확인 | `crates/ssh-probe`의 `ssh2`가 Unix에서만 `libssh2-sys`→`openssl-sys`를 끌어온다. OpenSSL이 없는 Mac에서는 `cargo clippy --workspace`, `cargo test --workspace`가 실패한다. 앱 빌드(`tauri build`)는 이 크레이트를 포함하지 않는다. CI 러너에 OpenSSL이 있으면 CI에서는 드러나지 않는다. | 당장은 `brew install openssl@3`를 전제로 한다. 장기적으로는 `ssh2` 비교 실증을 유지할지 결정한다 |

### 동작

| ID | 영향 | 상태 | 내용 | 조치 |
|---|---|---|---|---|
| M.2 | 높음 | 수정, 실기기 대기 | `transfer_queue.rs`의 `local_guard`는 모든 상위 경로의 심볼릭 링크를 거부한다. macOS의 `/tmp`, `/var`는 심볼릭 링크라서 이 아래 경로의 전송이 "링크 또는 junction" 오류로 실패한다. `tempfile`의 기본 위치(`/var/folders/…`)도 해당되어 `examples/queue/checks.rs` 같은 실증이 막힌다. `refuses_link_ancestor` 테스트는 링크가 없어도 통과하게 되어 검증력을 잃는다. | OS가 소유한 최상위 링크를 허용하고 사용자 링크 거부는 유지한다. 테스트는 정상 경로 통과도 함께 단언한다 |
| M.3 | 높음 | 수정, 실기기 대기 | Finder로 실행한 앱의 `PATH`에는 Homebrew가 없다. 로컬 PodTree는 `--noprofile --norc`로 실행되어 `command -v kubectl`이 실패한다. `bash_target`이 Homebrew Bash를 골라도 `podtree.rs`의 `exec bash`는 `PATH`의 Bash 3.2를 실행하는데, `podtree.sh`는 `declare -A`, `mapfile`을 쓴다. `tauri dev`는 터미널의 `PATH`를 물려받아 재현되지 않는다. | 시작 시 로그인 셸의 `PATH`를 얻어 적용하고, `exec`에는 선택한 Bash의 절대 경로를 쓴다 |
| M.4 | 높음 | 수정, 실기기 대기 | `editor.rs`의 `editor_program`은 Windows에서만 설치 경로를 찾는다. Mac에서는 `code`, `cursor`, `subl`을 이름으로 실행하므로 Finder 실행 앱에서 M.3과 같은 이유로 실패한다. | `.app` 내부 CLI 경로 탐색을 추가한다 |
| M.15 | 높음 | 구현, 실기기 대기 | DX.2~DX.9를 Windows와 Docker에서만 실행했다. macOS CI는 빌드와 자동 테스트만 확인한다. 실기기에서 확인할 것: ① **Finder로 실행한 앱의 `SSH_AUTH_SOCK`**(launchd가 GUI 앱에 주는 값이 있는지, 없으면 SSH agent 인증과 키 전달이 모두 안 된다)과 `agent_forward.rs`의 **Unix 소켓 중계**(`cfg(unix)` 경로, 서버의 `ssh-add -l`·서명 카드·거부·`ssh-add -D` 차단), ② **tmux**(DX.3 재접속, DX.7 tmux 시작과 붙기만, 재접속 뒤 `SSH_AUTH_SOCK` 안내), ③ **단축키** `Cmd+Shift+G`(변경 검토), `Cmd+Shift+.`(다음 입력 대기), 터미널 안 `Cmd+Shift+↑↓`(프롬프트 이동)와 IME·시스템 단축키 충돌, ④ **검토 탭**(WKWebView에서 diff 가상화 스크롤, `color-mix` 색, 좁은 칸 위아래 배치, 의견을 Enter 없이 프롬프트에 넣기), ⑤ **실제 앱의 Bash 3.2**(`/bin/bash` 3.2.57에서 DX.9 명령 경계의 Enter 방식, 실패 표시, 프롬프트 이동. 지금은 Docker `bash:3.2`에서 훅 단독으로만 확인), ⑥ 연결 트리·파일 트리의 **에이전트 시작…** 우클릭(두 손가락 클릭·Control+클릭)과 Zsh 프롬프트 입력, 현황판에서 독립 창 포커스(`setFocus`·`unminimize`) | 패키지된 앱(`.app`)을 Finder로 실행해 `mac-verify`로 확인. Windows·CI 결과로 대체하지 않는다 |
| M.5 | 중간 | 확인 | macOS의 로컬 파일 이름은 NFD 한글일 수 있는데, 업로드 이름을 NFC로 정규화하는 코드가 없다. 서버에 자모가 분리된 이름으로 저장될 수 있다. | 업로드 시 이름 정규화. 기존 원격 이름과의 충돌 비교도 함께 정한다 |
| M.6 | 중간 | 확인(구성) / 추정(영향) | `tauri.conf.json`에 `bundle.macOS`가 없고 `NSLocalNetworkUsageDescription`도 없다. macOS의 로컬 네트워크 개인정보 보호는 사내망 SSH 접속에 적용되며, 코드 서명으로 앱을 식별하므로 ad hoc 서명에서는 불안정할 수 있다. 재빌드 시 서명이 바뀌면 Keychain 승인을 다시 요청할 수도 있다. | `Info.plist` 문구, `signingIdentity`, `minimumSystemVersion` 지정. LAN 서버 접속으로 확인한다 |
| M.12 | 중간 | 구현, 실기기 대기 | F.1의 로컬 파일 트리와 경로 따라가기는 Mac에서 실행한 적이 없다. 기본 셸이 Bash·Zsh이면 첫 프롬프트에 경로 알림을 입력하고 에코를 숨기는 경로를 쓴다. 코드는 실제 OpenSSH로 검증한 SSH 경로와 같지만 macOS PTY와 Zsh 프롬프트(`PROMPT_SP`, 오른쪽 프롬프트)는 확인되지 않았다. | 패키지된 앱에서 로컬 탭을 열어 입력 잔상 없이 `cd`를 따라가는지, 파일 트리와 복사·삭제가 동작하는지 확인한다 |
| M.13 | 중간 | 구현, 실기기 대기 | AT.5·AT.6·DX.3을 Windows에서만 실행했다. Mac에서는 `arboard`의 `image-data` 기능(새 macOS 의존성), Cmd+V의 `paste` 이벤트, WKWebView 드롭 좌표, Finder 실행 앱의 첨부, 임시 터널 뒤 브라우저 열기를 확인하지 않았다 | `mac-verify`로 확인 |
| M.14 | 중간 | 구현, 실기기 대기 | TW.4·TW.8을 Windows에서만 실행했다. `tauri.macos.conf.json`과 독립 창 빌더에 `titleBarStyle: Overlay`, `hiddenTitle`을 넣고 왼쪽 78px를 비웠다. 신호등 버튼이 36px 제목 줄의 세로 가운데에 오는지와 앱 이름·보기 메뉴와 겹치지 않는지, 빈 곳 끌기·더블클릭 확대, 전체화면 전환 후 복귀, 독립 창도 같은지 확인하지 않았다. 신호등 위치(`trafficLightPosition`)는 정하지 않았다. 탭·연결 카드의 두 손가락 클릭과 Control+클릭 메뉴, `Cmd+Option+방향키`, WKWebView 포인터 캡처(탭 드래그), 상태바 팝오버도 미확인이다. TW.5~TW.7(Windows에서만 실행): 상태바 입력 범위 라디오와 탭 바 체크, `Cmd+Shift+M`·`Cmd+Shift+\`, IME 조합 중 상태바 변경, macOS 로컬 기본 셸(Zsh)과 `/bin/bash` 3.2에 입력해 넣는 조작표 훅(Bash 3.2는 Docker `bash:3.2`에서만 확인), 전체 화면 프로그램 일반 안내. 일반 안내는 Mac에서 선택 키를 표시하지 않는다. xterm은 Mac에서 `Shift+드래그`로 강제 선택하지 않으므로 터미널 설정의 `Shift+드래그` 안내 문구도 실기기에서 확인한다 | 패키지된 앱(`.app`)에서 `mac-verify`로 확인. 신호등이 어긋나면 `trafficLightPosition`을 정한다 |
| M.7 | 낮음 | 추정 | 터미널 글꼴이 `'Cascadia Code', 'SFMono-Regular', Consolas, monospace`다. Mac에서 일반 `monospace`로 떨어져 글꼴과 폭이 나빠질 수 있다. | `ui-monospace`, `Menlo`를 추가한다 |
| M.8 | 낮음 | 추정 | xterm에 `macOptionIsMeta`를 지정하지 않아 Option 조합이 Meta로 전달되지 않는다. Command 복사·붙여넣기와 파일 패널의 `Ctrl+C` 표기도 Mac 관례와 맞는지 확인이 필요하다. | 실기기에서 확인 후 설정 추가 |

### 검증 도구

| ID | 영향 | 상태 | 내용 | 조치 |
|---|---|---|---|---|
| M.9 | 중간 | 확인 | `*-native.mjs`는 WebView2 CDP에 의존한다. WKWebView에는 이 경로가 없어 실제 앱 UI는 Mac에서 수동으로 검증해야 한다. `run-ftp.mjs`는 `python.exe`, `ftp_probe.exe`를 하드코딩해 `probe:ftp`도 Mac에서 실행되지 않는다. | `run-ftp.mjs`의 플랫폼 분기. UI는 수동 체크리스트 유지 |
| M.10 | 중간 | 확인 | `audit-windows.mjs`와 `generate-notices.mjs`는 `x86_64-pc-windows-msvc` 의존성만 본다. Mac 전용 크레이트의 보안 권고는 게이트를 막지 않고, 번들의 제3자 고지에서도 빠진다. | 대상 플랫폼을 인자로 받거나 두 플랫폼을 합쳐 처리한다 |
| M.11 | 낮음 | 제안 | Playwright는 Chromium만 실행한다. WebKit 프로젝트를 추가하면 Windows에서도 WKWebView 차이를 일부 미리 잡을 수 있다. WKWebView 결과를 대신하지는 않는다. | 첫 CI 결과 후 판단 |

## M.2~M.4 수정 범위 (`0fcf569`)

| ID | 변경 | CI가 확인한 것 | 실기기에서 확인할 것 |
|---|---|---|---|
| M.2 | `/etc`, `/tmp`, `/var`의 정확한 시스템 링크만 허용(`local_links.rs`) | 수정 전 macOS에서 `refuses_link_ancestor` 실패(실행 `42169858010`), 수정 후 통과. 사용자 링크는 계속 거부 | 실제 파일 전송(`npm run probe:phase1`) |
| M.3 | 시작 시 로그인 셸의 `PATH` 적용. 3초 제한, 실패 시 Homebrew 경로 사용(`login_path.rs`). 로컬 PodTree는 선택한 Bash 유지(`podtree/launch.rs`) | zsh에서 `PATH` 읽기, 프로필 출력·시간 초과 처리, 명령 문자열. `exec "$BASH"`는 WSL Ubuntu에서 직접 확인 | Finder로 실행한 앱의 PodTree 실행, 앱 시작 지연 |
| M.4 | 앱 번들 안의 CLI 탐색(`editor_location.rs`) | 탐색 로직만. 번들 내부 경로가 실제 설치본과 맞는지는 미확인 | Finder로 실행한 앱에서 VS Code, Cursor, Sublime 열기 |

로컬 PodTree는 Bash 4 이상이 필요하므로 Mac에서는 `brew install bash`가 전제다. 없으면 기존처럼 의존성 오류로 안내한다.

## 결정 사항 (2026-11-06 사용자 확인)

- **Apple Silicon만 지원한다.** Intel Mac 빌드와 검증은 하지 않는다.
- **배포**: 지금은 본인만 사용하므로 로컬 빌드로 충분하다. 이후 Apple Developer 프로그램에 등록할 예정이며, 그때 Developer ID 서명과 공증을 구성한다. 등록 전까지 M.6의 서명 항목은 ad hoc 기준으로 확인한다.

## 다음 첫 행동

1. MacBook에서 `mac-verify` 스킬로 실기기 검증을 시작한다. M.2~M.4의 위 표부터 확인한다.
2. 남은 항목 중 영향이 큰 M.5(NFD 한글 파일명), M.6(로컬 네트워크 권한·서명 설정)을 처리한다.

## 참고

- [TN3179: Understanding local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
- [How local network privacy could affect you](https://eclecticlight.co/2026/01/14/how-local-network-privacy-could-affect-you/)
