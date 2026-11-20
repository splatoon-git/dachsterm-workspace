# macOS 준비 상태

Mac 빌드와 동작의 현재 상태, 남은 작업 ID, Windows와의 알려진 차이의 정본이다. 확인 절차는 [macos-checklist](macos-checklist.md)에 있다.

- **실기기 결과와 CI 결과를 구분한다.** macOS CI(`macos.yml`)는 빌드와 자동 테스트만 확인한다. 앱을 띄우지 않으므로 Keychain, IME, 파일 대화상자, 실제 SSH 접속, 권한 창은 CI 통과로 기록하지 않는다.
- Mac 실기기 결과는 대부분 에이전트의 **자동 조작**(System Events·CGEvent 입력, 창 캡처·디스크 내용·서버 기록으로 판정)이다. 사람이 직접 확인한 항목은 따로 표시한다.
- 실행 환경: macOS 26.5, Apple Silicon. 다른 macOS 버전에서는 실행하지 않았다.

## 자동 게이트와 실제 SSH 엔진

| 범위 | 마지막 기록 |
|---|---|
| macOS CI | 실행 `44676990208`(`d21781c`) 성공. 빌드와 자동 테스트만 |
| Mac에서 `bash scripts/verify-macos.sh --package` | `17cc876` + 미커밋 수정 트리에서 종료 0. CG.10(`201b5e1` 위 미커밋 트리)에서는 게임 Vitest 1건이 부하로 시간 초과해, 그 파일을 `--testTimeout=60000`으로 다시 돌린 뒤 나머지 단계 종료 0 |
| Mac에서 `npm run probe`, `probe:phase1`, `probe:ftp` | `17cc876`에서 모두 종료 0. `probe:phase1`은 큐·NFD·SFTP·터널·모니터링·Git·tmux·Keychain·금고·agent 전달·HTTPS 자격 증명·LFS 단계 포함 |
| Mac에서 `probe:connect`, `probe:telnet`, `probe:serial`, `probe:inband` | CG 각 브랜치 병합 전 통과. 이후 바뀐 `connect_probe.rs`·`proxy_command.rs`의 Mac 컴파일과 `probe:connect`는 대기 |

Playwright는 Mac에서도 대부분 Chromium으로 실행된다. WebKit은 `*.webkit.spec.ts`만 macOS에서 실행하며 WKWebView 앱 결과를 대신하지 않는다.

## 작업 ID 상태

상태 표기: **대기** = Mac 앱에서 미실행 / **일부 확인** = Mac에서 일부만 실행 / **확인** = Mac에서 실행해 통과. 항목별 확인 방법은 [macos-checklist](macos-checklist.md)의 같은 ID를 본다.

### 빌드와 검증 도구

| ID | 영향 | 상태 | 내용 | 남은 것 |
|---|---|---|---|---|
| M.1 | 높음 | 알려진 제약 | `crates/ssh-probe`의 `ssh2`가 Unix에서 `openssl-sys`를 끌어와, OpenSSL이 없는 Mac에서는 `--workspace` 명령이 실패한다. 앱 빌드는 이 크레이트를 포함하지 않는다. CI 러너에는 OpenSSL이 있어 드러나지 않는다 | `brew install openssl@3`를 전제로 한다. `ssh2` 비교 실증을 유지할지 결정 |
| M.9 | 중간 | `probe:ftp` 확인 / UI 수동 | `*-native.mjs`는 WebView2 CDP에 의존해 Mac에서 실행할 수 없다. `run-ftp.mjs`의 `--native` 계열은 Mac에서 이유를 밝히고 멈춘다 | 앱 UI는 체크리스트로 수동 확인 |
| M.10 | 중간 | 확인(CI) | `audit-dependencies.mjs`와 `generate-notices.mjs`가 Windows·macOS 의존성 그래프를 합쳐 본다. `verify-macos.sh`와 `macos.yml`에 연결됨. Mac에서 감사 0건 | 없음 |
| M.11 | 낮음 | 일부 도입 | `playwright.config.ts`에 macOS 전용 WebKit 프로젝트가 있고 `*.webkit.spec.ts`만 실행한다 | 필요한 화면에 WebKit 시험 추가. WKWebView 결과를 대신하지 않는다 |

### 동작

| ID | 영향 | 상태 | 내용 | Mac에서 확인한 것 | 남은 것 |
|---|---|---|---|---|---|
| M.2 | 높음 | 일부 확인 | `/tmp`, `/var`, `/etc`가 시스템 심볼릭 링크라 전송 경로 검사가 막히던 문제. 이 세 링크만 허용하고 사용자 링크는 거부한다(`local_links.rs`) | `probe:phase1` 전송 | 앱 화면의 전송 |
| M.3 | 높음 | 대기 | Finder로 실행한 앱의 `PATH`에 Homebrew가 없다. 시작 시 로그인 셸의 `PATH`를 적용한다(`login_path.rs`, 3초 제한, 실패하면 Homebrew 경로) | 없음(M.3 항목으로는). M.24·CG.10에서 최소 `PATH` 앱이 `kubectl`·exec 플러그인 대역·`socat`을 찾은 기록이 있다 | Finder 실행 앱의 `kubectl` 탐지와 편집기 실행, 앱 시작 지연 |
| M.4 | 높음 | 대기 | 외부 편집기를 `.app` 번들 안의 CLI 경로로 찾는다(`editor_location.rs`) | 없음 | Finder 실행 앱에서 VS Code·Cursor·Sublime 열기. GE.1 저장 확인 카드와 OS 알림 |
| M.5 | 중간 | 일부 확인 | 업로드할 때 서버 쪽 이름만 NFC로 만든다(`remote_name.rs`) | `probe:ftp`의 `NFD local name arrives as NFC`, 실제 FTP/FTPS·OpenSSH 큐 | 파일 대화상자·Finder 드롭으로 받은 한글 이름 |
| M.6 | 중간 | 일부 확인 | `NSLocalNetworkUsageDescription`, 최소 macOS 13.1, ad hoc 서명 | `plutil`, `codesign --verify --deep --strict`(`Signature=adhoc`) | 로컬 네트워크 권한 창과 LAN 접속, Developer ID 서명(Apple 등록 뒤) |
| M.7 | 낮음 | 대기 | 터미널 글꼴 스택에 `ui-monospace`, `Menlo`, 한글 대체 글꼴 추가 | Playwright WebKit에서 표시(앱 아님) | 실제 앱 글꼴 |
| M.8 | 낮음 | 대기 | **Option 키를 Meta로 사용**(기본 꺼짐), 파일 메뉴의 `⌘C` 표기 | 없음 | Option 조합, Command 복사·붙여넣기 |
| M.12 | 중간 | 일부 확인 | 로컬 탭의 파일 트리와 경로 따라가기 | Zsh 로컬 탭의 `cd` 따라가기, 파일 트리, 입력 잔상 없음 | 복사·삭제, `/bin/bash` 3.2 |
| M.13 | 중간 | 대기 | AT.5·AT.6·DX.3: `arboard` 이미지 클립보드, `Cmd+V` 붙여넣기, 드롭 좌표, 첨부, 임시 터널 뒤 브라우저 열기 | 없음 | 전부 |
| M.14 | 중간 | 일부 확인 | `titleBarStyle: Overlay`, 왼쪽 78px 비움. TW.4~TW.8의 Mac 조작 | 신호등 세로 위치, 앱 이름과 겹치지 않음, Control+클릭·우클릭 메뉴 | 빈 곳 끌기·더블클릭 확대, 전체화면, 독립 창, `Cmd+Option+방향키`, 탭 드래그, 상태바 입력 범위·단축키, 조작표 훅(Zsh, Bash 3.2) |
| M.15 | 높음 | 대기 | DX.2~DX.13: Finder 실행 앱의 `SSH_AUTH_SOCK`, agent 중계(Unix 소켓), tmux, 단축키, 검토 탭, Bash 3.2 명령 경계, 앱 내장 agent, 로컬 탭 키 제공 | 없음(`probe:phase1`의 agent 전달은 엔진 결과) | 전부 |
| M.16 | 높음 | 일부 확인 | GE.4 편집기(Monaco) 한글 입력. 조합에서 글자를 잃거나 중복하면 CodeMirror 6로 바꾼다 | 시험 앱에서 실제 한글 입력기를 거친 자동 키 이벤트 통과. Monaco 유지 | 사람의 직접 타이핑, 일본어·중국어 입력기, 10만 줄 스크롤, 테마, diff, 웹 워커·CSP, 아이콘 글꼴 |
| M.17 | 중간 | 대기 | GE.2·GE.3 Finder와의 끌어 놓기, **Finder에서 보기**. `drag` 크레이트가 폴더도 파일 URL로 넘긴다 | 없음 | 전부 |
| M.18 | 높음 | 일부 확인 | GE.5·GE.6·GE.8 실제 앱의 파일 탭 한글 입력과 저장 | 파일 탭 한글 2벌식(2회 중 1회 온전, 1회는 다른 사람의 입력이 섞여 판정 제외), 조합 중 `Cmd+S`가 조합 글자까지 저장, diff 좌우 표시 | 커밋 메시지 한글, Markdown·이미지 미리보기, 2MiB 초과 크게 열기, 다른 이름 저장, SFTP·FTP 저장과 충돌 카드, NFD 이름, `Cmd+Q` |
| M.19 | 중간 | 일부 확인 | GE.7~GE.15 Git 화면. Finder 실행 앱의 git 탐색, 명령줄 도구 없는 Mac의 `/usr/bin/git` 설치 창 | 로컬 Git 보기, 변경 목록, 그래프, diff 탭, Control+클릭 메뉴, 스테이지, `Cmd+Enter` 커밋 | 브랜치·stash, 변경 버리기, 커밋 훅, fetch·pull·push, 명령줄 도구 없는 환경, **설정 → Git**, GE.15 화면 |
| M.20 | 중간 | 대기 | GE.11 터미널 안 브랜치 배지. Docker의 Bash·Zsh 훅과 Windows 앱에서만 확인 | 없음 | Mac 로컬 탭의 `/bin/bash` 3.2·Zsh 전부 |
| M.21 | 중간 | 대기 | TL.3 SSH 키 만들기의 Mac 분기(`0600`, `~/.ssh` `0700`, `/bin/hostname`) | 없음 | 전부 |
| M.22 | 중간 | 대기 | TL.6~TL.9 네트워크 도구의 Mac 분기(`/usr/sbin/lsof`, `/usr/sbin/traceroute` TCP 뒤 UDP, Keychain 인증서) | 없음 | 전부 |
| M.23 | 중간 | 일부 확인 | KV.13 실시간 로그·요청 흐름·서버 `kubectl` 정리, KV.9 런타임 탭 | 패키지 앱(`e56215c`, 검사 스크립트를 주입한 임시 빌드)과 실제 OpenSSH·kind. 합성 이벤트, 화면 모양은 보지 않음. 이때 찾은 스트림 재개 중복 표시는 수정 후 앱 재실행 안 함 | 대시보드 판정, 권한 없는 계정, 프로브 단독 감시, 중복 표시 수정 확인 |
| M.24 | 중간 | 일부 확인 | KV.11 로컬 클러스터 | 패키지 앱(`c2198f5` 위 미커밋, 임시 빌드)과 kind. 탐지한 절대 경로의 `kubectl`, 로그인 셸 `PATH`로 찾는 exec 인증 플러그인(대역) | 실제 인증 플러그인, 사람의 직접 조작 |
| M.25 | 중간 | 일부 확인 | KV.12 파드 터미널(`kube/terminal.rs`)과 보이는 트리 복사 | 패키지 앱(`ed799a4` 위 미커밋, 임시 빌드)과 실제 OpenSSH·kind·로컬 클러스터. 합성 이벤트, 화면 모양은 보지 않음 | 사람의 직접 조작 |
| M.26 | 높음 | 확인(사람) | macOS 입력 예측이 xterm 보조 입력칸 전체를 조합 영역으로 잡아 글자가 사라지고 줄이 다시 입력되던 문제. `TerminalPane.tsx`의 `writingsuggestions="false"`로 수정 | 사람이 패키지 앱 터미널에 영어 문장을 직접 쳐서 그대로 출력됨 | 없음. 회귀 시험은 속성만 본다(`terminal-visibility.spec.ts`) |
| M.27 | 높음 | 일부 확인(사람) | `Cmd+W`가 앱 전체를 확인 없이 종료하던 문제. macOS 메뉴에서 창 닫기만 뺐다(`macos_menu.rs`). `Cmd+W`는 포커스된 탭을 닫고, 탭이 없으면 창 닫기 확인을 거친다. `Ctrl+W`는 셸로 간다 | 사람이 탭 닫기와 탭이 없을 때의 창 닫기 확인 | 분리 창의 `Cmd+W` |
| M.28 | 낮음 | 미수정 | 연결 트리의 로컬 셸 항목을 더블클릭하면 탭이 2개 열린다. SSH 세션은 1개 | 재현 | 수정 |
| M.29 | 중간 | 알려진 제약 | ad hoc 서명 앱은 다시 빌드·업데이트하면 이전 빌드가 만든 Keychain 항목에 접근할 때 로그인 암호 창을 띄운다 | 세션 삭제에서 창 발생 | Developer ID 서명(M.6) 뒤 재확인 |

### Phase 기본 기능

| 범위 | 상태 | Mac에서 확인한 것 | 남은 것 |
|---|---|---|---|
| Phase 0 | 일부 확인 | 자동 게이트, `npm run probe` | 마스코트·포커스·좁은 창·한글 표시 |
| Phase 1 | 일부 확인 | 최초 지문 카드(서버 `ssh-keygen -lf`와 일치), `known_hosts` 저장, 변경된 호스트키 차단, 비밀번호 연결, 인증 거부 안내와 재접속 카드, Keychain 저장과 교체, 앱 데이터 폴더 평문 0건, SSH 연결 5개 동시, `stty size`, UTF-8 한글 출력, 세션 삭제 확인 창과 `credential_gc` 기록 | 지문 거부, 키 인증(RSA·Ed25519·암호화 키), 세션 삭제의 Keychain 정리(M.29 창에서 멈춤), 저장소 실패, 그룹·검색·즐겨찾기, 터미널 한글 IME, vim·htop 화면, KeepAlive, 종료 뒤 정리 |
| Phase 2~5 | 대기(앱) | 엔진은 `probe:phase1`, `probe:ftp` | 분할 배치, 파일 작업, 전송, 외부 편집, 터널, 모니터링, 금고, DMG 설치, 장시간·절전 |

### 기능별 Mac 확인

| 기능 | 상태 | Mac에서 확인한 것 | 남은 것 |
|---|---|---|---|
| CG.6 앱 업데이트 | 일부 확인(설치는 사람) | ad hoc 시험 앱 0.5.1 → 0.5.2 번들 교체, 자동 재시작, 격리 속성 없음, 서명 불일치 거부, 자동 확인 끄기. [기록](app-updates.md) | 열린 세션 정리와 세션 로그, DMG 첫 실행, 이전 Keychain 항목 접근, 관리자 권한 위치 |
| CG.1~CG.9 연결 확장 | 일부 확인 | 최소 `PATH`로 띄운 패키지 앱에서 ProxyCommand(Homebrew `socat` 이름만), 가져오기 명령 승인, HTTP 프록시 암호 카드, 하이라이트 색, Telnet 로그인·종료, 터미널 안 `sz`·`rz` 왕복(SHA-256 일치), 시리얼 포트 목록(`/dev/cu.*`) | 우클릭 붙여넣기(자동 조작에서 실패, 원인 미확인), XQuartz, 실제 USB 시리얼, 업데이트 뒤 Keychain, 앱 안 하이라이트 성능 |
| FV 그림·문서 미리보기 | 대기(앱) | macOS CI 컴파일과 자동 테스트만 | WKWebView에서 PDF·hwp·hwpx·docx·xlsx·pptx·bmp 열기, 기본 프로그램으로 열기, 서버 파일 복사본의 `com.apple.quarantine` |

### 알려졌지만 고치지 않은 문제

- `Welcome.tsx`의 로컬 터미널 카드가 Mac에서도 `이 컴퓨터의 셸 · WSL`로 표시한다.
- 세션을 우클릭하면 이름 글자가 선택돼 파랗게 표시된다.
- `GitCommitBox.tsx`의 `Cmd+Enter`는 `isComposing`을 확인하지 않는다(코드 확인, 실제 조합 동작은 미판정).
- `generate-notices.mjs`가 Mac에서 고지 파일을 CRLF로 써서 게이트 뒤 작업 트리가 수정 상태가 된다(내용 차이 없음).

## Windows와의 알려진 차이

- **실행 환경**: Finder로 실행한 앱의 `PATH`는 `/usr/bin:/bin:/usr/sbin:/sbin`뿐이다. 앱은 시작할 때 로그인 셸의 `PATH`를 얻어 적용한다. 터미널에서 그냥 `open`이나 `tauri dev`로 띄우면 셸 `PATH`를 물려받아 이 차이가 드러나지 않는다.
- **셸**: `/bin/bash`는 3.2다. 로컬 기본 셸은 Zsh다.
- **경로**: `/tmp`, `/var`, `/etc`는 시스템 심볼릭 링크다. 전송 경로 검사는 이 세 링크만 허용한다.
- **파일 이름**: 로컬 이름은 NFD 한글일 수 있다. 업로드할 때 서버 쪽 이름만 NFC로 만들며 두 OS에 똑같이 적용한다. 다운로드 이름은 바꾸지 않는다. 서버는 이름을 바이트로 비교하므로 NFD 충돌 비교는 하지 않고, 한 폴더의 두 항목이 같은 NFC 이름이 되면 업로드를 거부한다.
- **인증정보와 서명**: Keychain을 쓴다. ad hoc 서명은 빌드마다 달라 다시 빌드하거나 업데이트하면 Keychain 암호 창이 뜬다(M.29). Developer ID 서명과 공증은 Apple Developer 등록 뒤 구성한다.
- **권한**: LAN 대상 접속에 로컬 네트워크 권한이 필요하다(`NSLocalNetworkUsageDescription`).
- **지원 범위**: Apple Silicon만 지원한다. 최소 macOS는 13.1이다(`color-mix`에 Safari 16.2 필요).
- **웹뷰**: WKWebView다. 실제 앱 UI를 자동으로 검사하는 경로(`*-native.mjs`)가 없어 사람이 확인한다.
- **창과 키**: 제목 줄은 `titleBarStyle: Overlay`이고 왼쪽 78px를 신호등 버튼에 비워 둔다. `Cmd+W`는 앱 메뉴 대신 탭 닫기로 처리한다. 터미널의 `xterm`은 Mac에서 `Shift+드래그`로 강제 선택하지 않는다. Option을 Meta로 쓰는 설정은 기본 꺼짐이다.
- **입력**: macOS 입력 예측은 터미널 입력칸에서 끈다(`writingsuggestions="false"`).
- **OS 도구**: 포트 사용 여부는 `/usr/sbin/lsof`, 경로 추적은 `/usr/sbin/traceroute`(TCP 시도 후 UDP), 인증서 신뢰는 Keychain, Finder에서 보기는 `/usr/bin/open -R`, 받은 파일의 격리 표시는 `/usr/bin/xattr`을 쓴다. 시리얼 포트는 `/dev/cu.*`만 보인다.
- **빌드**: `--workspace` 명령에는 OpenSSL이 필요하다(M.1). OS 전용 Rust 시험이 있어 시험 수가 OS마다 다르다.

## 참고

- [TN3179: Understanding local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
