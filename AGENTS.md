# DachsTerm

모든 코딩 에이전트의 공통 지침 정본이다. Claude Code는 `CLAUDE.md`를 통해 이 파일을 읽는다. 도구와 무관한 프로젝트 내용은 여기에만 쓴다.

## 제품과 목표

DachsTerm은 **Windows 11과 macOS**에서 쓰는 로컬 데스크톱 SSH 클라이언트다. MobaXterm의 작업 흐름을 참고해 SSH, SFTP·FTP/FTPS, 외부 파일 편집, 멀티 터미널, 터널, 서버 모니터링을 한 앱에 제공한다. 별도 서버, 서버 에이전트, 계정 없이 동작하는 무료 개인용 앱이다.

제품 경계:

- 제외: MobaXterm 전체 복제, X 서버, RDP/VNC, 클라우드 동기화, 팀 계정, 유료 외부 서비스 의존.
- 디자인: 독립적인 현대적 SSH 데스크톱 UI. PMS에서는 컬러셋만 참고하고, 기존 크림색 라이트를 기본값으로 하는 토큰 기반 여러 테마를 제공한다(roadmap §2). 장모 크림 닥스훈트 마스코트 `Dachs`를 사용한다.

## 지원 플랫폼

**Windows와 macOS는 모두 출시 대상이다.** Windows에서 주로 개발한다고 Mac이 선택 사항이 되지는 않는다. 어느 OS의 변경이든 다른 OS의 빌드와 동작을 깨면 안 된다. 코드 규칙은 [engineering-rules §11](docs/engineering-rules.md)에 있다.

| | Windows 11 | macOS |
|---|---|---|
| 아키텍처 | x64 | Apple Silicon만 (Intel 미지원) |
| 역할 | 주 개발·실행 환경 | MacBook에서 빌드·실기기 검증 |
| 웹뷰 | WebView2 (Chromium) | WKWebView (WebKit) |
| 인증정보 | Credential Manager | Keychain |
| 자동 게이트 | `scripts/verify-windows.ps1`, `windows.yml` | `scripts/verify-macos.sh`, `macos.yml` |
| 실제 앱 UI 자동 검사 | `*-native.mjs` (WebView2 CDP) | 없음. WKWebView에는 이 경로가 없어 실기기에서 직접 확인 |
| 패키지 | NSIS | `.app`, DMG |

Mac 실행 결과와 알려진 차이는 [macos-readiness](docs/verification/macos-readiness.md)가 정본이다. Mac에서 검증할 때는 `mac-verify` 스킬을 쓴다.

## 작업 절차

1. `git status`를 확인한다. 다른 에이전트가 같은 트리에서 작업할 수 있으므로 내가 만들지 않은 변경은 건드리지 않는다.
2. `docs/progress.md`의 상단과 상태 표, 해당 작업 ID의 섹션만 읽는다. `docs/roadmap.md`도 해당 절만 찾아 읽는다. 두 문서는 합쳐 300KB가 넘으니 전체를 읽지 않는다.
3. 작업 ID를 정하면 시작 전에 `git worktree list`로 다른 작업 트리를 보고, 각 트리의 브랜치 이름과 미커밋 변경(`git -C <경로> status --short`, `git -C <경로> diff docs/progress.md`)으로 같은 작업 ID가 진행 중인지 확인한다. 겹치면 시작하지 말고 사용자에게 알린다. progress는 커밋돼야 공유되므로 dev의 progress만 보고 판단하지 않는다.
4. 기능 작업은 `dev`에서 갈라진 작업 ID 브랜치(예: `feat/dx5-git-status`)에서 하고, 끝나면 `dev`에 병합한다. 다른 세션이 브랜치 이름으로 진행 중인 작업을 알 수 있게 하기 위해서다. 아래 브랜치 규칙을 따른다.
5. 코드를 쓰기 전에 [engineering-rules](docs/engineering-rules.md)를 따른다. 구조를 바꾸기 전에는 [architecture-review](docs/architecture-review.md)의 정리 목록을 확인한다.
6. 구현·검증 후와 세션 종료 전에 progress를 갱신한다. 파일, 검증 명령과 결과, 미검증 이유, 남은 작업 ID, 다음 첫 행동을 남겨 새 세션이 이전 대화 없이 이어갈 수 있게 한다.

브랜치 규칙:

- `dev`가 통합 브랜치다. 작업 브랜치와 worktree는 `dev`에서 만들고 `dev`에 병합한다.
- `dev`와 작업 브랜치는 언제든 푸시해도 된다. CI는 `main` 푸시와 `main` 대상 PR에서만 돈다.
- `main`은 사용자가 요청할 때만 `dev`로 fast-forward해 푸시한다(`git push origin dev:main`). 이때 Windows·macOS CI가 한 번 돈다. `main`에 직접 커밋하지 않는다.
- `dev`에서 CI가 필요하면 Actions의 `workflow_dispatch`로 `dev`를 지정해 수동 실행한다.

`Phase N 구현해` 요청:

- roadmap §4.0의 소번호 순서와 실제 코드를 확인해 첫 미완료 작업부터 진행한다. `Phase N.M`이면 그 소번호가 범위다.
- 소번호 하나의 완료를 Phase 완료로 보고하지 않는다. 허용된 남은 작업을 계속하고 작업마다 재승인을 요구하지 않는다.
- 선행 구현이 빠졌으면 범위와 이유를 알리고 처리한다. 요청하지 않은 후속 Phase로 확장하지 않는다.

## 어기면 안 되는 규칙

- 인증정보, 개인키, Passphrase를 코드·문서·로그에 기록하지 않는다.
- 미실행 검증을 성공으로 기록하지 않는다. 환경이 없어 남은 검증은 대기로 적고 독립적인 작업을 계속한다.
- Windows 결과나 macOS CI 결과를 Mac 실기기 결과로 대체하지 않는다. 실제 SSH 검증을 Mock으로 대체하지 않는다.
- 진행 상황과 결과는 한국어로 보고한다.

## 명령

```text
npm ci                                  의존성 설치
npm run dev                             브라우저 UI만 실행 (포트 1420, 백엔드 없음)
npm run tauri -- dev                    네이티브 앱 개발 실행

npm run typecheck | lint | format:check | build
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

Windows에서 `cargo`를 찾지 못하면 `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`를 먼저 실행한다. macOS에서 `--workspace` 명령을 쓰려면 OpenSSL이 필요하다(`brew install openssl@3`).

OS별 게이트와 패키지:

```text
./scripts/verify-windows.ps1                       CI와 같은 Windows 게이트 전체 (-Native, -Package로 확장)
bash scripts/verify-macos.sh                       CI와 같은 macOS 게이트 전체 (--package로 .app 빌드 포함)
npm run tauri -- build --debug --no-bundle         프런트엔드를 내장한 검사용 실행 파일
npm run tauri -- build --bundles nsis              Windows 설치 패키지
npm run tauri -- build --bundles app,dmg           macOS 앱과 DMG
```

단일 테스트:

```text
npx vitest run src/features/terminal/snippets.test.ts
npx vitest run src/features/games/survivor/engine.test.ts -t "테스트 이름 일부"
npx playwright test tests/ui/themes.spec.ts            최초 1회 npx playwright install chromium 필요
cargo test -p dachsterm --lib --locked hostkeys        모듈명·테스트명으로 필터
```

실환경 검사(Docker의 Linux 컨테이너 엔진 필요. 호스트 OpenSSH 설정은 건드리지 않는다):

```text
npm run probe                  Phase 0 실증
npm run probe:phase1           제품 엔진을 실제 OpenSSH로 검사. 이름과 달리 Phase 2~4 포함
npm run test:native            Windows 전용. 앱 빌드 후 WebView2 UI로 실제 SSH 접속
npm run probe:ftp              FTP/FTPS/CP949. 현재 Windows 전용
node scripts/test-<기능>-native.mjs    Windows 전용 개별 검사. target/debug/dachsterm.exe가 먼저 필요
```

같은 실행 파일을 빌드와 테스트가 동시에 쓰면 잠금 오류가 난다.

## 아키텍처

Tauri 2 앱이다. React는 화면과 터미널 렌더링만 맡고, SSH 연결·채널·전송·터널·모니터링·파일·인증정보·DB는 Rust가 소유한다. 창이나 탭을 옮겨도 연결은 끊기지 않는다.

### 프런트엔드와 백엔드의 경계

- 모든 호출은 [src/lib/ipc.ts](src/lib/ipc.ts)의 `call<T>('명령', args)`를 거친다. Tauri 밖(`desktop === false`)에서는 거부되므로, Playwright UI 테스트는 백엔드 없이 동작하고 필요한 경우 `tests/ui/fixtures/`의 페이지로 컴포넌트를 띄운다.
- 명령 이름은 타입으로 검사되지 않는다. 등록 위치는 engineering-rules §5의 체크리스트를 따른다.
- 백엔드 오류는 `Result<T, String>`의 한국어 문자열로 전달된다. `errorText`는 문자열과 `UserError`만 그대로 표시하고 다른 `Error`는 일반 문구로 바꾼다.

### 식별자와 터미널 데이터 흐름

- 저장된 프로필, 실행 중 연결, 탭(`tabId`), SFTP 작업, 터널은 서로 다른 ID를 쓴다. 재접속은 새 ID와 새 셸을 만들고 명령을 재실행하지 않는다.
- [session.ts](src/features/terminal/session.ts)의 `TerminalSession`이 xterm과 연결 수명을 함께 가지며, SSH·로컬·PodTree 명령을 분기해 호출한다. FTP 탭도 이 클래스를 쓴다.
- 백엔드는 [ssh.rs](src-tauri/src/ssh.rs), [local.rs](src-tauri/src/local.rs), [podtree.rs](src-tauri/src/podtree.rs)로 나뉘어 있다. 출력은 `Channel<Event>`로 32KiB 프레임을 보내고 xterm 렌더 완료 ACK를 받은 뒤 다음 프레임을 보낸다. 세 구현의 ACK 규칙과 상한이 다르므로 한쪽만 고치면 동작이 더 벌어진다.
- 창 분리는 [windows.rs](src-tauri/src/windows.rs)의 `Broker`가 처리한다. 최근 최대 2MiB를 새 창에 재생하고, 소유 창만 입력·resize·ACK를 보낼 수 있다.

### 저장과 인증정보

- 앱 데이터 폴더에 `sessions.sqlite3`, `known_hosts`, `edits/`, `recovery/`가 있다. 시작 시 인스턴스 잠금을 잡고 전송 큐와 편집 복구를 재개한다([lib.rs](src-tauri/src/lib.rs)).
- DB에는 비밀의 참조만 저장한다. 실제 값은 OS 저장소([credentials.rs](src-tauri/src/credentials.rs))나 마스터 암호 금고([vault.rs](src-tauri/src/vault.rs))에 둔다. 참조 정리는 journal로 재시도하므로 DB 실패 시 비밀이 먼저 사라지지 않는다.
- 저장 변경은 `AppState.mutation` 락으로 직렬화하고, 파괴적 변경 전에는 `maintenance::snapshot`으로 복구본을 남긴다.
- 세션 교환 형식은 [docs/session-transfer.md](docs/session-transfer.md)와 `docs/session-format*.schema.json`이 정본이다.

### 파일 전송

`transfer_queue.rs`가 SQLite에 영속되는 큐를 소유하고 SFTP·FTP를 모두 처리한다. 임시 파일 `.dachsterm-*` 이름 규약은 재시작 복구에 쓰이므로 임의로 바꾸지 않는다. FTP 관련 명령도 `workspace.rs`의 `sftp_*`, `transfer_*`로 들어온다.

### 테마

컴포넌트는 테마 ID로 분기하거나 색상을 직접 쓰지 않는다. `src/themes/`의 토큰 계약에서 CSS 변수, xterm, 차트 값이 파생된다. 새 테마는 정의 추가와 레지스트리 등록만으로 동작해야 한다(roadmap §2.3).

### 게임

`src/features/games/`는 lazy 로드되는 독립 영역으로 코드량이 가장 많다. 앱과의 접점은 카탈로그와 App의 서바이버 종료 정산 가드뿐이다. 단위 테스트 다수가 여기에 몰려 있으므로 테스트 수를 앱 핵심 기능의 커버리지로 해석하지 않는다.

### 이름과 실제가 다른 곳

| 이름 | 실제 |
|---|---|
| `windows.rs` | Windows OS가 아니라 터미널 창 분리 |
| `session_transfer.rs` | 파일 전송이 아니라 세션 설정 이관 |
| `sftp_list`, `features/sftp/` | FTP/FTPS도 처리 |
| `run-phase1.mjs`, `probe:phase1` | Phase 2~4 검사 포함 |
| `audit-windows.mjs`, `generate-notices.mjs` | Windows 의존성 그래프만 검사·고지 (macOS 미포함) |
| roadmap §6 모듈 구성 | 계획이며 실제 구조와 다름 (`commands/`, `ssh/` 폴더 없음) |

### 수정에 주의할 외부 유래 코드

- `vendor/ssh-key`: RSA 검증을 ring으로 바꾼 패치본이다. 이유와 절차는 `vendor/ssh-key/DACHSTERM-PATCH.md`를 본다.
- `src-tauri/assets/podtree/`: 내장 PodTree 변형이다. `podtree.rs`의 테스트가 스크립트 해시를 `provenance.json`의 `embeddedSha256`과 대조하므로 수정하면 함께 갱신한다. 줄바꿈이 바뀌어도 해시가 달라진다.
- `src-tauri/permissions/autogenerated/`: 빌드 생성물이므로 직접 수정하지 않는다.

## 문서 지도

| 문서 | 내용 |
|---|---|
| [docs/roadmap.md](docs/roadmap.md) | 범위·디자인·보안·완료 기준의 정본 |
| [docs/progress.md](docs/progress.md) | 현재 상태와 이어갈 위치의 정본 |
| [docs/engineering-rules.md](docs/engineering-rules.md) | 코드 작성과 검증 보고 규칙 |
| [docs/architecture-review.md](docs/architecture-review.md) | 구조 부채와 수정 순서 |
| [docs/verification/](docs/verification/) | 실행한 검증의 상세 기록 |
| `.agents/skills/` | 공용 스킬 정본. `.claude/skills/`는 이를 가리키는 포인터만 둔다 |
