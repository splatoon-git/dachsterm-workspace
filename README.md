# DaxTerm

**0.5.1** · Windows 11 / macOS용 로컬 SSH 작업 공간. SSH·SFTP·FTP/FTPS·외부 편집, 분할 터미널·독립 창·멀티 입력, Local/Remote/SOCKS5 터널과 Linux 리소스 모니터링을 제공한다. 기존 크림색을 기본으로 하는 공통 토큰 기반 테마 12개와 장모 크림 닥스훈트 마스코트를 사용한다. **현재 릴리스 검증 중이며 Mac 실기기 결과는 없다.** 완료/미검증 범위는 [진행 기록](docs/progress.md)에서 구분한다.

## 개발 환경

세션 이관은 설정의 **세션 가져오기·내보내기**에서 지원한다. 자체 JSON v2/기존 v1, PuTTY `.reg`, MobaXterm SSH 북마크, OpenSSH `config`를 미리보고 선택해 추가한다. 제품별 기본 접속 정보만 변환하며 전체 설정 호환은 [지원표와 JSON 규약](docs/session-transfer.md)을 따른다. 첫 접속 인증창에서 암호 저장을 선택하면 로그인 성공 후 보안 저장소에 보관하고 다음 접속에 사용한다. OTP는 저장하지 않는다.

- Node 24 이상, npm. `package-lock.json`으로 프런트엔드 버전 고정.
- Rust 1.99.1 (`rust-toolchain.toml`), `Cargo.lock` 포함.
- Windows: Visual Studio C++ Build Tools, Windows SDK, WebView2.
- macOS: Xcode Command Line Tools. **이 저장소의 Mac 실행 결과는 아직 없음.**
- 실접속 검사: Docker의 Linux 컨테이너 엔진. 호스트 OpenSSH 서비스 설정을 변경하지 않는다.

현재 Windows 세션에서 Cargo PATH가 필요하면 PowerShell에서 다음을 실행한다.

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm ci
npm run tauri -- dev
```

Rust 설치 자체는 공식 rustup을 사용한다. 네이티브 요구 환경은 [Tauri 문서](https://v2.tauri.app/start/prerequisites/) 참고.

## 검사·빌드

```text
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npx playwright install chromium
npm run test:ui
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --workspace --locked
npm run tauri -- build --debug --no-bundle
npm run probe
npm run probe:phase1
npm run test:native
npm run probe:ftp
node scripts/run-ftp.mjs --reuse-build --native-only
```

`npm run dev`는 브라우저 UI만 실행한다. `tauri dev`는 Windows/macOS 네이티브 앱을 실행한다. `build --debug --no-bundle`은 프런트엔드를 내장한 검사 용 실행 파일을 생성한다. Windows 설치 패키지는 `npm run tauri -- build --bundles nsis`, Mac은 Mac에서 `npm run tauri -- build --bundles app,dmg`로 생성한다. 공개 배포 전 Windows 코드 서명과 macOS Developer ID 서명·공증은 별도 자격증명/실기기 검증이 필요하다. 개인 로컬 빌드와 서명된 공개 배포를 구분한다.

## OpenSSH 실증

`npm run probe`는 Rust 실증기를 빌드하고 전용 Debian OpenSSH 컨테이너를 생성한다. 호스트에서는 `127.0.0.1`의 임의 포트만 공개한다. 비밀번호·개인키·Passphrase는 실행마다 생성해 컨테이너 tmpfs와 검사 프로세스 메모리/환경에서만 전달한다. 빌드 스크립트나 프런트엔드에는 전달하지 않는다. 호스트키는 Docker 제어 경로로 얻은 공개키와 대조하며, 잘못된 키 거부를 별도로 확인한다. 이는 제품의 최초 신뢰 확인·`known_hosts` UI 구현이 아니다.

`npm run probe:phase1`은 이름을 호환성 때문에 유지하며 Phase 2~4 검사도 포함한다. SFTP 바이너리/한글/공백 왕복·권한·외부 편집 충돌/원자적 교체·CP949 변환, 실제 Local/Remote/SOCKS5 왕복, Linux 지표, 128MiB 업로드 중 취소를 검사한다. 앱이 사용하는 `src-tauri/src/ssh.rs`와 저장소를 직접 검증한다. 비밀번호·ring RSA SHA-2(일반/암호화 OpenSSH·PEM·암호화 PKCS8)·agent·키+PAM MFA·일반/암호화 Ed25519, 호스트키 거부·변경·폐기, 5개 연결, PTY·UTF-8·resize, 흐름 제어·취소·재접속, 실제 OS 저장소를 검사한다. 개인키 파일 읽기는 실행 중 생성한 임시 디렉터리에서 검증하고 종료 시 삭제한다.

`npm run test:native`는 **Windows 전용**이며, 내장 자산 앱을 빌드한 뒤 같은 실제 OpenSSH에 네이티브 WebView2 UI로 접속한다. 테스트 데이터와 WebView 프로필은 임시 디렉터리로 분리한다. 디버그 빌드에서만 `DAXTERM_TEST_DATA_DIR`와 `DAXTERM_TEST_CDP_PORT`를 지원하며, 릴리스 빌드는 무시한다. 한글은 xterm composition 이벤트를 자동 재현한다. 실제 Windows IME 키 조합 검증과는 구분한다. 네이티브 테스트의 스크린샷은 `test-results-native/`에 생성된다.

검사 종료 시 컨테이너와 테스트 파일·키를 삭제한다. 강제 프로세스 종료 등으로 남았는지 확인하려면 `docker ps -a --filter label=app.daxterm.purpose=phase0-probe` 또는 `phase1-probe`를 사용한다. 남은 전용 컨테이너만 개별 ID로 정리한다. 다른 컨테이너나 볼륨은 삭제하지 않는다. 테스트 이미지에는 사용자 인증정보가 들어 있지 않다.

## 로컬 터미널과 탐색 (U.1)

- 상단 **로컬 터미널** 또는 사이드바의 셸 이름을 누르면 등록 없이 새 로컬 탭이 열린다. Windows PowerShell·명령 프롬프트·표준 경로의 PowerShell 7, 설치된 WSL 배포판을 자동 탐색한다. WSL 목록 갱신은 배포판을 시작하거나 설치하지 않는다. 새 설치 후 사이드바의 ↻로 다시 찾는다.
- macOS는 `$SHELL` 또는 사용자 계정에 설정된 기본 셸을 로그인 셸로 연다. Mac 실기기 검증은 대기다. 기본 시작 폴더는 사용자 홈이며 WSL도 배포판 홈에서 시작한다.
- 로컬 PTY는 기존 검색·테마·복사/붙여넣기 확인·분할을 사용한다. 최대32개, 출력32KiB ACK/입력 큐 상한. 탭 종료/앱 종료에 셸을 정리하며 재접속은 새 셸이다. 로컬 셸이 자체적으로 기록하는 명령 이력은 해당 셸 설정을 따른다.
- 로컬 탭의 원격 SFTP·모니터링·SSH 터널·새 창 분리는 제공하지 않는다. 분할 입력 그룹에는 로컬 셸과 WSL도 포함할 수 있다. 로컬 파일 탐색기는 이번 범위에 포함하지 않는다.
- 왼쪽 **연결 / 원격 파일**에서 로컬 셸·저장된 서버와 활성 SSH의 SFTP를 전환한다. 검색·파일 경로는 보기 전환 시 유지한다. 경계선을 드래그하거나 방향키로 폭을 바꾸며, 좁은 창에서는 겹쳐 열고 바깥 클릭/Esc로 닫는다. FTP/FTPS는 중앙 파일 탭을 사용한다.
- **보기**: 왼쪽 원격 파일·색상 미리보기·단축키 안내. **도구**: SSH 터널. 입력 전달 범위는 터미널 분할 도구에서 설정한다. 상단 ☰로 사이드바를 접고 펼치며 상태를 저장한다.
- Ctrl+Shift+L: 로컬 열기, Ctrl+Shift+N: 새 연결, Ctrl+Shift+B: 사이드바, Ctrl+Shift+F: 세션 검색, Ctrl+Shift+E: 원격 파일. macOS는 Ctrl 대신 Command. 탭에 포커스가 있을 때 ←/→/Home/End로 이동한다. 대화상자에서는 전역 단축키를 보내지 않는다.
- 실제 Windows 로컬 검사: `npm run tauri -- build --debug --no-bundle` 후 `node scripts/test-local-native.mjs`. 일반 WSL 배포판이 없으면 실WSL 검사는 대기로 보고한다.

## SSH 사용

1. **새 연결**에서 이름·호스트·포트·사용자와 인증 방식을 입력한다. 개인키는 로컬 파일 경로를 입력한다.
2. 비밀번호/Passphrase는 이번 연결에만 사용하거나 OS 보안 저장소에 저장할 수 있다. 저장소 실패 시 ‘저장하지 않음’을 선택한다. 평문 파일로 대체 저장하지 않는다.
3. 최초 접속 시 서버 관리자가 제공한 SHA-256 지문과 대조한 뒤 신뢰한다. 변경되거나 폐기된 키는 연결을 차단하며, 앱에 우회 버튼이 없다.
4. 저장된 세션을 더블클릭하거나 **연결**을 누른다. 탭마다 독립된 연결을 사용한다. 종료된 탭의 **재접속**은 새 셸이며 이전 명령을 재실행하지 않는다.
5. 터미널 도구에서 복사·붙여넣기와 앞/뒤 검색을 사용한다. 검색 Enter/Shift+Enter로 다음/이전 결과, Esc로 검색 표시 해제 후 입력에 복귀한다. **터미널 설정**에서 글꼴 크기와 스크롤 기록을 조정한다. 여러 줄이나 ESC가 포함된 붙여넣기는 실행 전 확인한다.

세션·그룹은 Tauri 앱 데이터 디렉터리의 `sessions.sqlite3`, 최초 신뢰 키는 같은 위치의 `known_hosts`에 저장한다. 사용자 `~/.ssh/known_hosts`도 읽으며 수정하지 않는다. SQLite에는 비밀정보 대신 OS 저장소 참조 ID만 저장한다. 세션 복제는 비밀정보를 복제하지 않으며, 세션 삭제는 해당 OS 항목도 삭제한다. 저장 대상이 바뀌면 기존 인증정보의 명시적인 삭제/교체가 필요하다.

동시 연결은 최대 32개, 출력은 연결당 32KiB 한 프레임만 미확인 상태로 보낸다. 렌더링 응답이 30초 동안 없으면 연결을 종료한다. 분리 창에는 최근 2MiB 출력만 재생하며, 전체 세션의 영구 로그가 아니다. 한 창만 입력·resize·ACK를 소유한다. 독립 창을 닫으면 해당 SSH 연결과 종속 작업이 종료된다. KeepAlive는 5~300초, 접속·인증 타임아웃은 5~120초다. 호스트키 확인에는 별도 120초를 제공한다. UTF-8 입력·TUI를 쓰려면 서버 셸도 UTF-8 로케일이어야 한다. 호스트 CA 인증서 검증, GSSAPI/Kerberos, 점프 호스트와 agent forwarding은 제공하지 않는다. keyboard-interactive/키 인증 후 MFA와 OS SSH agent는 지원한다. 추가 인증 질문에는 응답당 120초를 제공하고 응답은 저장하지 않는다.

Windows 산출물: `target/release/bundle/nsis/DaxTerm_0.5.1_x64-setup.exe`. 설치·실행·정상 종료·제거 검사는 `scripts/test-installer.ps1`로 수행하며, 기존 DaxTerm 설치가 있으면 중단한다. 서명되지 않은 개인 검증 빌드다. Mac·물리 IME·실제 OS 드롭/GUI 편집기 조작·절전/장시간 검증은 남아 있다.

## 서버별 비밀번호와 마스터 패스워드

세션의 사용자 이름과 접속 설정은 SQLite에, 비밀번호/개인키 Passphrase는 OS 보안 저장소에 저장한다. 폼에서 **인증정보 보관 → 입력한 값을 암호화 보관**을 선택한다. 비밀번호는 세션 JSON 내보내기에 포함되지 않는다.

**설정 → 마스터 패스워드** 또는 세션 폼의 **마스터 패스워드 · 잠금 해제**에서 12자 이상의 암호를 설정할 수 있다. 기존 저장 인증정보도 새 암호화 형식으로 안전하게 이행한다. Argon2id(32MiB, 3회, 1 lane)로 유도한 키가 임의의 데이터 키를 감싸고, 각 인증정보는 AES-256-GCM/독립 난수 nonce/참조 ID 인증 데이터로 보호한다. OS 저장소에도 이 암호문만 기록하며 마스터 패스워드 자체는 저장하지 않는다.

- 앱 시작 시 잠금. 해제 후 5분에 자동 잠금, 즉시 수동 잠금 가능. 이미 연결된 SSH/FTP 작업은 유지된다.
- 세션 수정 → **저장된 암호 보기**는 매번 마스터 패스워드를 다시 확인한다. 30초·창 포커스 이탈·닫기에 숨기고 자동 클립보드 복사는 하지 않는다.
- 마스터 변경 시 데이터 키와 저장 암호문을 모두 교체한다. 새 참조를 먼저 준비하고 SQLite 트랜잭션이 성공한 뒤 이전 OS 항목을 정리한다. 실패 시 기존 참조를 보존한다.
- 마스터 암호를 잊으면 복구할 수 없다. 다른 기기로 복사할 수 있는 암호 백업/동기화 기능은 제공하지 않는다. 마스터를 설정하지 않아도 OS 보안 저장소의 암호화는 적용된다.

## 파일·편집·인코딩

- **터미널 인코딩**은 세션 폼에서 UTF-8(기본), CP949/EUC-KR, Shift_JIS, GBK, Big5, Windows-1252를 선택한다. 서버의 로케일/실제 출력 인코딩과 맞춰야 한다. 설정 변경은 새 연결부터 적용한다. 수신 패킷 사이의 불완전한 문자를 이어 해석하고, 송신 인코딩으로 표현할 수 없는 문자는 보내지 않는다. Unicode 정규화나 줄바꿈 변환을 수행하지 않는다.
- **SFTP 파일명**은 UTF-8이다. 라이브러리가 손실 변환한 이름을 감지하면 경고하고 작업을 막는다. 비 UTF-8 파일명 인코딩 변환은 현재 지원하지 않는다. 서버 파일명을 먼저 UTF-8로 변환해야 한다. 목록은 20,000개/20초 상한이며 하위 경로로 이동할 수 있다.
- **업로드·다운로드 내용은 항상 바이너리 그대로** 전송한다. 텍스트 인코딩·BOM·CRLF/LF를 자동 변환하지 않는다. 로컬 파일 선택 또는 파일 패널로 드롭하여 업로드하고, 파일 선택 후 다운로드한다. 디렉터리 재귀 전송은 제공하지 않는다.
- 전송은 최대4개 동시·64KiB 버퍼이며, 일시 중지 시 UUID 부분 파일과 SQLite 복구 계획을 보존한다(최대100개). 재시작 후 같은 프로필/서버에 연결해 **이어서 보내기/받기**를 누른다. 원본 크기·수정 시각과 부분 파일 전체 바이트를 검증한 뒤 재개하며, 기존 대상 파일에는 이어쓰지 않는다. 크기·시각을 유지한 원본의 미전송 구간 수정까지 검출하는 전체 원본 해시는 아니다. **부분 파일 삭제**는 명시적으로 선택해야 하며 원본을 지우지 않는다.
- 파일창은 Ctrl/Cmd·Shift 다중 선택, Ctrl/Cmd+C/X/V/A, F2/Delete/F5, 컨텍스트 메뉴, 이름 검색/정렬, 새 파일/폴더, 복사/이동/재귀 삭제, 권한 체크박스를 제공한다. 다른 SSH 연결 간 복사도 가능하며 FTP 복사는 같은 연결 내에서 제공한다. 기존 대상 거부, 동일 폴더 복사는 `복사 1` 이름을 사용한다. 링크/특수 파일 복사는 거부하고 삭제 시 링크를 따라가지 않는다.
- SSH 서버에서 ZIP/TAR/TAR.GZ 압축과 해제 지원. Python3와 Linux `renameat2`가 필요하다. ZIP 파일명 CP949/CP932/GBK/Big5 선택은 Python3.11 이상. 절대/상위 경로, 링크·장치, 중복 항목, 20,000항목/설정된 해제 크기 초과를 거부하며 새 대상에만 확정한다.
- **외부 편집**은 파일 선택 → 편집. VS Code(`code`), Cursor(`cursor`), Sublime(`subl`) 또는 실행 파일 절대 경로, JSON 인자 배열을 지정한다. 셸 문자열로 실행하지 않는다. Windows 별칭은 설치된 실제 EXE를 찾는다. macOS에서 CLI가 PATH에 없다면 앱 번들의 실행 파일 절대 경로를 지정한다.
- 파일 내용 인코딩은 별도 옵션이다. 기본 **원본 바이트 유지**는 편집기에서 인코딩을 선택한다. 명시적 인코딩 옵션은 로컬 UTF-8 작업 파일로 변환하고 저장 시 선택한 원래 인코딩으로 되돌린다. 잘못된 입력/표현 불가 문자는 업로드하지 않는다. 파일 자동 인코딩 추측은 하지 않는다. 외부 편집 파일은 32MiB까지다.
- 기본은 **저장 후 업로드 확인**, 선택적으로 **자동 업로드** 또는 **수동 업로드**를 지정한다. 확인 취소와 업로드 취소는 로컬 수정본을 보존한다. 편집기 자체의 자동 저장 기능과 DaxTerm의 자동 업로드 설정은 별개다. 2초 저장 감지 + 350ms 안정 구간을 사용한다. 원격 SHA-256이 편집 시작 시점과 다르면 덮어쓰기/다시 받기/다른 이름 저장을 선택한다. 다시 받기는 로컬 수정본 `.bak`를 남긴다. 서버가 `posix-rename@openssh.com`을 지원할 때만 기존 파일을 원자적으로 교체한다. 미지원 서버에는 다른 이름 저장을 사용한다. 파일 모드를 유지하지만 ACL/xattr/소유자 전체 복제는 보장하지 않는다. 검사~rename 사이 다른 쓰기 경쟁은 SFTP만으로 제거할 수 없다.
- 작업 파일은 앱 데이터 `edits/<UUID>/working.<확장자>`에 저장한다. Windows 사용자 전용 ACL/macOS 0700 디렉터리를 적용한다. 실패/충돌/종료 시 복구본을 자동 삭제하지 않는다. 같은 세션·접속 대상에 다시 연결한 후 재시도한다. **동기화된 파일 정리**는 업로드가 끝난 파일만 삭제하며, 미업로드 수정본/백업이 있으면 보존한다.

인코딩 매핑은 [WHATWG Encoding Standard](https://encoding.spec.whatwg.org/)와 [encoding_rs](https://docs.rs/encoding_rs/latest/encoding_rs/)를 따른다. CP949 선택은 WHATWG EUC-KR의 Unified Hangul Code 매핑을 사용한다.

## FTP/FTPS와 지원 범위

### SSH 인증과 기본 조작 (S.1)

- 인증 방식: 비밀번호, 개인키(Ed25519/ECDSA/RSA), 암호화 개인키의 Passphrase, OS SSH agent, 서버 질문 방식 keyboard-interactive. 개인키/agent 인증 후 서버가 요구하는 OTP·MFA 질문도 표시한다. 응답은 저장하지 않는다.
- Windows agent는 OpenSSH `ssh-agent` 서비스와 `ssh-add`에 등록한 키를 사용한다. macOS/Unix는 `SSH_AUTH_SOCK`을 사용한다(Mac 실기기 대기). agent에 많은 키가 있으면 사용할 키를 정리한다. 연결당 시도는 최대5회다. Pageant·FIDO2 직접 접근·GSSAPI·점프 호스트는 지원하지 않는다.
- RSA: OpenSSH 일반/암호화, PEM PKCS#1, PKCS#8 일반/암호화 키를 읽는다. 오래된 PEM 암호화 형식은 OpenSSH 또는 PKCS#8로 변환해야 한다. SHA-1 `ssh-rsa` 서명은 허용하지 않는다. RSA 키 파일 자체와 SHA-1 서명 알고리즘은 별개다.
- 드래그 선택 자동 복사와 우클릭 붙여넣기가 기본 켜짐이다. 터미널 설정에서 각각 끌 수 있다. Ctrl/Cmd+Shift+C/V, Shift+Insert도 지원한다. 마우스 입력을 사용하는 vim/tmux 등에서는 Shift+드래그/우클릭으로 터미널 선택·붙여넣기를 사용한다. 여러 줄·제어문자는 실행 전 확인한다.
- 방향키·Home/End·Delete·Tab·Ctrl+C는 xterm의 표준/애플리케이션 모드를 따른다. SSH는 `TERM=xterm-256color`, `VERASE=DEL`, `IUTF8`을 요청한다. 서버가 설정을 덮어쓰는 경우 터미널 설정의 **Backspace 전송 → Ctrl+H**를 선택할 수 있다. 잘못된 서버 terminfo/로케일/셸 설정까지 클라이언트만으로 자동 수정하지 않는다.
- SFTP **터미널 경로 따라가기**는 기본 켜짐이고 탐색기에서 연결별로 끌 수 있다. 터미널 설정에서 새 탐색기 기본값도 바꾼다. OSC 7/1337 경로 알림을 수신하며, 알림이 없는 Bash/Zsh는 셸이 명령을 기다릴 때 **셸 경로 알림 연결**을 한 번 누른다. 현재 세션의 프롬프트만 수정하고 서버 설정 파일은 변경하지 않는다. 지원하지 않는 셸은 수동 경로 이동을 사용한다. SFTP에서 폴더를 선택해도 터미널에 `cd`를 자동 실행하지 않는다.

세션 폼에서 **FTP** 또는 **FTPS · 명시적 TLS**를 선택한다(기본21번 포트). FTPS는 OS 신뢰 CA와 선택한 추가 PEM CA로 인증서/서버 이름을 검증하며 평문으로 전환하지 않는다. FTP는 네트워크의 인증정보/내용을 암호화하지 않음을 화면에 표시한다. 두 방식 모두 Binary/PASV로 파일 바이트를 유지하고 데이터 연결은 제어 연결의 서버로 제한한다. FTP 파일명·명령 인코딩은 UTF8/CP949/Shift_JIS/GBK/Big5/Windows-1252 중 선택한다.

| 기능 | SSH/SFTP | FTP·명시적 FTPS |
|---|---|---|
| 세션 저장·OS 비밀 저장소·마스터 암호 | 지원 | 지원 |
| 목록·파일 관리·권한 | 지원 | 지원(SITE CHMOD는 서버 지원 필요) |
| 업로드·다운로드·일시 중지·복구·재개 | 지원 | REST/SIZE/MDTM 지원 서버 |
| 원격 복사·폴더 복사·이동·삭제 | 지원 | 같은 연결 내 지원 |
| 외부 편집·저장 확인·자동 업로드 | 지원 | 미지원 |
| 압축·압축해제 | Linux/Python3 서버 | 미지원 |
| 터미널·멀티 입력·분리 창·터널·모니터 | 지원 | 미지원 |

FTP RFC에는 원자적 no-replace rename이 없으므로 확인~rename 사이에 다른 클라이언트가 대상 이름을 생성하는 경쟁을 완전히 막을 수 없다. 서버 간 FTP 복사, implicit FTPS, Active FTP, FXP는 제공하지 않는다. 갑작스러운 네트워크 단절 후 서버가 부분 파일을 아직 잡고 있으면 정리될 때까지 기다린 후 재개한다. 일반 파일 전송이며 폴더 재귀 업/다운로드·전송 예약 큐는 제공하지 않는다.

FTP 검증은 Python 가상환경에 `scripts/ftp-fixture-requirements.txt`를 설치한 후 실행한다. Windows 기본 경로는 `.tools/ftp-fixture/Scripts/python.exe`; `DAXTERM_FTP_PYTHON`으로 변경할 수 있다. 각 실행은 임시 자격 증명/CA와 loopback 서버를 만들고 종료 후 제거한다. native 검사는 먼저 디버그 앱 빌드가 필요하다.

[MobaXterm 공식 기능](https://mobaxterm.mobatek.net/features.html)·[설명서](https://mobaxterm.mobatek.net/documentation.html)의 파일 브라우저/외부 편집/멀티 실행 흐름을 참고했다. X 서버·RDP/VNC·매크로 등 전체 제품 복제가 목표는 아니다.

## 분할·터널·모니터링

- 좌우/상하/2×2 배치를 선택하고 분할 비율을 조절한다. 탭을 탭 표시줄로 끌어 첫 위치로 이동할 수 있다. 활성 패널과 SFTP/모니터링의 연결 ID가 같다. 패널 너비·분할 모드·창 크기를 저장하며 창 분리 시 연결을 다시 만들지 않는다.
- 분할 도구의 **입력 → 개별 입력 / 모든 창 / 선택한 창**으로 입력 범위를 정한다. 기본 창의 모든 창은 현재 분할에 표시된 연결이다. 선택한 창에서는 체크한 창끼리만 입력을 공유하며 비대상 창은 개별 입력이다. SSH·로컬 셸·WSL을 함께 선택할 수 있다. 서로 다른 셸에서 명령 의미는 다를 수 있다. 배치·분할 대상 변경이나 연결 종료 시 그룹을 해제하고 재접속은 자동 포함하지 않는다. 독립 창의 입력 도구에서도 열린 터미널 그룹을 지정하거나 즉시 중지할 수 있다.
- **F11**로 단일/분할 터미널을 전체화면으로 전환하고 다시 누르면 원래 사이드바 배치를 복원한다. **선택 창 확대 / Ctrl+Shift+Enter**로 분할 중 현재 터미널만 확대했다가 복귀한다. 입력 그룹과 xterm은 유지하며 현재 동시 입력 수·중지 버튼은 전체화면에서도 보인다. 좁은 작업 영역의 좌우/2×2 분할은 세로로 배열하며 하나만 남으면 빈 칸 없이 확장한다.
- 터널은 127.0.0.1 루프백에만 바인딩한다. Local과 Remote 목적지를 지정하거나 SOCKS5 TCP CONNECT를 사용한다. SOCKS5 UDP/BIND 및 공개 인터페이스 바인딩은 지원하지 않는다. 자동 시작은 해당 SSH 세션이 연결·재접속되었을 때 적용하며, 비밀정보 없는 새 SSH 인증을 임의로 우회하지 않는다. 터널당 동시 스트림은 64개, 실행 터널은 32개까지다.
- 설정의 JSON 입출력은 세션·그룹·터널만 포함한다. 비밀번호·Passphrase·개인키 내용·OS credential 참조를 포함하지 않는다. 가져오기는 전체 검증 후 트랜잭션으로 추가하며 새 ID를 부여한다. 가져온 터널의 자동 시작은 꺼진다.
- Linux `/proc`와 `df -Pk`를 별도 SSH 채널로 수집한다. 기본 5초, 2~60초 설정, 꺼짐 지원. CPU/NET 첫 샘플과 카운터 리셋은 측정 중이다. NET 기본은 loopback 제외 인터페이스 합계(브리지/가상 인터페이스 중복 집계 가능); 상세에서 인터페이스 하나를 선택할 수 있다. RAM은 MemAvailable 기준, DISK는 상태바 `/`와 상세 마운트별 사용량이다. 수집 출력 256KiB/10초, 기록 120개 상한으로 터미널과 취소 범위를 분리한다.

## 테마와 자산

상단 **설정 → 테마 선택**에서 미리보기 카드를 선택한다. 별도의 저장 버튼 없이 현재 창과 열린 터미널에 반영되고, 다음 실행에도 복원된다. 같은 origin의 다른 창에도 저장 변경을 전달한다.

- 기본: **DaxTerm Classic** — 현재 크림색 화면과 기존 저장 ID 유지.
- 화이트: **GitHub White**, **Solarized Light**.
- 다크: **GitHub Dark**, **Dracula**, **Nord**, **Catppuccin Mocha**.
- 레트로: **Gruvbox Light**, **Gruvbox Dark**.
- 터미널: **Solarized Dark**, **Terminal Green**, **Terminal Amber**. 초록/앰버 콘솔은 고정폭 UI와 작은 모서리를 사용한다.

공식 팔레트를 참고한 DaxTerm용 변형이며 작은 글자와 TUI 대비를 위해 일부 색상을 조정했다. 참고 출처·검증·제한은 [테마 검증 기록](docs/verification/themes.md)에 정리했다.

- `src/themes/contract.ts`: 타입 계약. 필수 토큰 누락은 TypeScript 오류.
- `presets/light.ts`: 기존 크림색 기본 테마. PMS에서는 색상만 참고. `presets/collection.ts`와 `create.ts`: 추가 11개 정의.
- `adapters/`: CSS 변수·xterm.js·차트 변환. 새 정의 파일과 registry 등록만으로 확장.
- `store.ts`, `useTheme.ts`: 현재 창/동일 origin 창 동기화, 저장·기본값 복귀. `ThemePicker.tsx`: 키보드로 선택 가능한 미리보기 카드.
- `src/assets/brand`: 기존 장모 크림 닥스훈트 투명 원본. `npm run icons`로 독립 재생성.
- 모든 테마의 일반 글자 4.5:1, 포커스·입력 경계 3:1 및 ANSI 대비를 테스트한다. 다크 ANSI black은 TUI 배경 위 검은 글자 용도로 유지한다. 서버의 임의 truecolor는 변경하지 않는다.
- `node scripts/test-themes-native.mjs`: 디버그 네이티브 빌드 후 Windows WebView2에서 테마 12개·열린 xterm·앱 재시작 복원 검사. 사용자 데이터와 격리되며 실제 SSH 검사는 아니다.

## 이어가기

### Windows 안정화 (2026-11-05)

- 설정의 **복구와 진단**에서 비밀정보 없는 설정 복구본 생성·가져오기와 진단 JSON 저장을 제공한다. 세션 수정/삭제·그룹 삭제·터널 변경·설정 가져오기 전에도 최근 10개 복구본을 보관한다. 가져오기는 기존 항목을 유지하고 새 ID로 추가한다. 저장 암호·호스트키·편집 파일은 별도이며 전체 PC 백업을 대신하지 않는다.
- DB 삭제 실패 시 인증정보가 먼저 사라지지 않도록 트랜잭션과 정리 journal을 사용한다. 중복 앱은 같은 데이터 폴더를 동시에 수정할 수 없다. DB 손상/미래 버전을 자동 초기화하지 않는다.
- **S.1 소스는 RSA 개인키 인증을 복구했다.** 취약한 `rsa` 크레이트를 제거하고 ring으로 RSA SHA-2 서명/호스트키 검증을 수행한다. RSA는 2048~8192비트, SHA-256/512만 허용한다. 기존 0.5.1 설치본은 RSA 차단 버전이므로 최신 산출물과 구분한다. 로컬 ssh-key 패치와 검증 범위는 [S.1 기록](docs/verification/security-terminal-basics.md)을 참조한다.
- 자동 검사: `scripts/verify-windows.ps1` (`-Native`, `-Package`, `-RequireSigned`). 미해결 Cargo 보안 감사는 공개 릴리스 게이트를 실패시킨다. 자동 업데이트 서비스는 아직 구성하지 않았다.
- [안정화·복구 절차](docs/verification/windows-hardening.md), [별도 수동 검증 목록과 합격 기준](docs/verification/windows-release-checklist.md). Mac은 후순위로 보류한다.

[로드맵](docs/roadmap.md)과 [진행 기록](docs/progress.md)이 범위와 현재 상태의 정본이다. [Phase 1 Windows 기록](docs/verification/phase-1-windows.md), [Phase 1 Mac 절차](docs/verification/phase-1-macos.md), [Phase 0 기록](docs/verification/phase-0-windows.md)을 참고한다.

## 로컬 게임

왼쪽 사이드바 아래의 **게임**을 펼쳐 블록 퍼즐·스네이크·2048·지뢰찾기·닥스의 간식 타임·닥스의 모험을 선택한다. 게임은 중앙 터미널 작업 영역의 일반 탭으로 열리며 별도 창이나 팝업을 띄우지 않는다. 터미널 테마를 따르는 화면과 기존 크림색 마스코트를 사용하며 SSH 서버에서 프로그램을 실행하지 않는다.

**닥스의 간식 타임**은 방향키/A·D 또는 드래그로 45초 동안 간식(+10)과 별(+30)을 받고 양파를 피한다. 목숨은 3개다. 모험의 스프라이트를 공유해 달리기·방향 전환·냠냠·별 점프·피격 동작이 나오며, 연속 받기와 결과 기록을 표시한다. 놓친 간식은 감점 없이 연속 횟수만 초기화한다. 모션 줄이기 설정을 따르고 일시정지하면 효과도 함께 멈춘다. **닥스의 모험**은 시드 기반 랜덤 횡스크롤 액션이다. ←/→·A/D 이동, ↑/W 점프, Space(J/X) 물기, 공중 ↓/S 빠른 밟기. 적 머리 위로 낙하하면 자동으로 밟고 튕겨 오른다. 숲·유적·동굴·설원이 순환하며 이동/붕괴 발판·통통 버섯·스위치 문·증기·얼음과 서로 다르게 움직이는 적이 등장한다. 간식25/물기50/밟기75/구간통과200점, 체력5·쉼터2곳. 다음 구간은 점수/거리 유지·체력+1, 다시 시작은 같은 시드의 현재 구간 재도전. 맵 선택에서 환경/시드/새 랜덤 맵을 고를 수 있다. 화면 버튼 조합과 P 일시정지를 지원한다.

탭 전환은 현재 판을 유지하고 실시간 게임을 일시정지한다. 돌아온 뒤 **계속하기**를 누른다. **Esc / 작업으로 돌아가기**는 이전 작업 화면으로 복귀하며, 게임 탭의 **×**를 눌러야 현재 판이 종료된다. 최고 기록은 로컬 저장되고 현재 판은 앱 재시작 후 복원되지 않는다.



