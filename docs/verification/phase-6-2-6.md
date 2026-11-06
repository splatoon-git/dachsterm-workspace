# Phase 6.2·6.6 — 스니펫과 명령·조작표

2026-11-05. 두 항목의 구현과 Windows 자동/실제 통합 검증 완료. 물리 IME·Mac 결과는 대기다. 다른 Phase의 환경 검증이나 release/설치 패키지 완료를 뜻하지 않는다.

## 사용법과 계약

- 기본 창의 **도구 → 스니펫**에서 이름·설명·본문·그룹·태그를 저장/편집/복제/삭제/검색한다. 독립 SSH 창에도 스니펫 버튼이 있다. 현재 창의 연결된 SSH/로컬/WSL을 명시적으로 선택한다. FTP/게임/PodTree/앱 인증 입력창에는 전달하지 않는다.
- `{{경로}}`처럼 이름이 있는 자리표시자를 이번 입력 값으로 문자 그대로 치환한다. 값의 셸 인용/이스케이프는 사용자가 최종 본문에서 확인한다. 앱이 값을 셸 평가하거나 재귀 치환하지 않는다. 값은 DB나 스니펫 내보내기에 저장하지 않으며 전송 후 지운다. 스니펫 내보내기 기능은 제공하지 않는다.
- **입력만 넣기**와 **Enter 포함 실행**은 별도 확인 화면을 거친다. 최종 대상/본문을 표시하고 여러 줄/줄바꿈은 실행 가능성 확인을 추가로 요구한다. CRLF/LF는 터미널 CR로 정규화하며 대상 xterm의 bracketed paste 모드를 따른다. Tab/CR/LF 이외 제어문자는 거부한다. 현재 커서 위치에 넣으며 기존 입력을 지우지 않는다.
- 미리보기 뒤 연결 ID·상태·소유권·붙여넣기 모드가 바뀌면 재확인을 요구한다. 전송은 `snippet_send`의 별도 경로로 각 연결 큐에 한 번만 넣어 기존 멀티 입력 그룹을 우회한다. 대상별 오류/전달 여부를 표시한다. 전달은 원격 명령의 실행 성공을 보장하지 않으며, 응답을 잃었을 때 자동 재시도하지 않는다.
- SQLite `settings/snippets_v1`: revision 비교로 다른 창의 저장 충돌을 거부한다. 최대200개·본문16KiB·총1MiB·대상32개. 저장 오류/손상 시 원본을 보존한다. 인증정보 저장 기능이 아니며 저장 전 비밀정보가 없다는 확인을 요구한다. 개인키 헤더를 거부하지만 임의 문자열의 비밀 여부를 자동 판별한다고 보장하지 않는다. 서버 내부 sudo 등 PTY 암호 입력 상태도 자동 판별하지 않으므로 최종 터미널 상태를 확인한다.
- **도구 → 기본 명령·로그 필터**는 오프라인 기본 명령26개와 필터7개를 제공한다. 명령 텍스트만 복사하고 강조 마크업/설명/마지막 Enter를 포함하지 않는다. 복사 실패를 알린다. GNU/Linux 도구 범위·작은따옴표 인용·실시간 버퍼링·로그 회전·Ctrl+C를 안내한다.
- 터미널 아래 **조작표**는 vi/vim/less/tail/cat을 직접 선택·고정하거나 끌 수 있다. 터미널 위에 겹치지 않고 자체 스크롤을 사용한다. 키를 서버로 보내거나 가로채지 않으며 현재 vi 모드를 추정하지 않는다. 탭/연결마다 별도 상태다.
- 자동 조작표는 기본 꺼짐. **실행 알림 사용**을 켜고 명령 모음의 Bash 연동 코드를 직접 검토·실행한 세션만 지원한다. 현재 셸에 알려진 프로그램의 wrapper와 prompt 종료 알림을 추가하며 기존 별칭/함수가 있으면 적용을 취소한다. 설정 파일은 변경하지 않는다. 프로그램 식별자만 OSC777(`DachsTerm;program;vi` 등, `DachsTerm;end`)로 보내고 명령 인자·이력·키를 수집하지 않는다. 알려지지 않은 프로그램/임의 메타데이터는 무시한다. 수신 알림은 안내용이며 인증된 프로세스 식별 증명이 아니다.
- Bash wrapper는 터미널 표준 입출력에만 알림을 쓴다. 파이프/리다이렉션 결과에 제어문자를 넣지 않는다. `command vim`으로 wrapper를 우회하거나 파이프/백그라운드/중첩 실행에서는 수동 고정을 사용한다. shell 종료로 연동을 해제하며 UI의 끄기는 화면 알림을 끈다. zsh/fish/PowerShell 자동 감지는 제공하지 않고 수동 조작표를 사용한다.

## 실제 검증

| 검사 | 명령/방법 | 최종 결과 |
|---|---|---|
| Rust 저장·전송·기존 회귀 | `cargo test -p dachsterm --lib --locked` | 56개 통과 |
| 프런트 단위 | `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src --maxWorkers=1` | 42파일656개 통과 |
| 브라우저 UI | `node node_modules/@playwright/test/cli.js test --config tests/assistant.config.ts --workers=1` | 5개 통과 |
| 정적 검사 | TypeScript, src 전체 및 추가 검사 파일 ESLint, 관련 Prettier/rustfmt | 통과 |
| Rust lint | `cargo clippy -p dachsterm --all-targets --locked -- -D warnings` | 통과 |
| 내장 앱 빌드 | `node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle` | 통과, 기존 큰 번들 경고/Windows 하드링크 캐시 복사 경고 |
| 실제 Windows | 고정 EXE를 `DACHSTERM_TEST_BINARY`로 지정하고 `node scripts/test-assistant-native.mjs` | 7개 시나리오 묶음, 종료0, pageErrors0 |

실제 검사는 임시 앱 데이터/WebView2 프로필, 동적 루프백 포트의 일회용 OpenSSH 컨테이너와 실제 PowerShell/Ubuntu WSL을 사용했다. 테스트 인증정보는 결과·문서·프로필에 저장하지 않았으며 컨테이너를 종료/삭제했다.

1. Linux fixture: 파일명/대소문자 무시 검색, command/whereis/readlink 경로, 고정문자/포함/제외/OR/AND/앞뒤/작은따옴표, 실시간 AND 필터 지연·파일 교체·SIGINT. wrapper의 리다이렉션 출력 불변과 기존 함수 보존도 검사.
2. 실제 UI/PowerShell: 스니펫 저장, 자리표시자 한글, 입력만 넣은 뒤 별도 Enter로 실행.
3. 실제 SSH/로컬: 한글/여러 줄, 멀티 입력을 켠 상태에서 선택 SSH에 정확히1회 전달, SSH+로컬 대상, 종료된 대상의 실패 격리. 원격 파일에 1바이트가 한 번만 추가되는 것으로 중복 여부 확인.
4. 실제 SSH Bash: vi·vim.tiny(테스트용 vim 이름)·less·cat·tail의 프로세스 실행과 알림, 정상 종료·Ctrl+C 후 해제, 수동 고정 유지·다른 탭 격리.
5. 실제 Ubuntu WSL: 한글 스니펫과 Bash cat 진입/종료 알림.
6. 실제 독립 창: 스니펫 UI 전송·출력, 이전 기본 창의 소유권 거부. 과거 TUI 출력 재생 중 DSR/DA 응답이 서버에 섞이던 기존 문제를 발견해 `Replay` 시작/끝과 xterm 파싱 완료까지 입력 차단으로 수정했다.
7. 실제 앱 종료/재시작: SQLite 본문 복원, 실행 값 미보존, 자동 실행 없음. 560px 다크 명령 모음 화면 확인.

브라우저 검사는 CRUD/복제/삭제/검색/복원, 취소 시 미전송, 여러 줄 확인, 한글/리터럴 치환, 재접속 ID 변경 거부, 명시적 다중 대상과 키보드 확인, PodTree 제외, 클립보드 문자열/실패, 360/800px, 자동 조작표 열기/종료 시 닫기/고정 유지 등을 확인했다. `assistant-360.png`, `assistant-800.png`, `snippet-360.png`, `assistant-native-dark.png`를 시각 확인했다.

중간 검사에서 도구 메뉴 선택자, fixture의 없는 `/etc/services`/vim 실행명, textarea 이름의 접근성 문제가 드러나 보완했다. 이 중간 실패를 성공 근거로 쓰지 않는다. 최초 Rust 전체 검사는 샌드박스의 symlink 생성 권한 부족으로 기존 큐 테스트1개가 실패했으며 권한을 허용한 최종 전체 검사에서 통과했다.

## 산출물과 대기

- 보존 debug: `target/verification/phase62-66-artifacts/daxterm-debug.exe`
- SHA256: `0f6a92e588eee799267f2e4e62c563899274f7221c4f2f00b4953d737c466155`
- native 결과: `target/verification/assistant-native.json` 및 같은 보존 폴더의 결과 사본. Rust 마지막 서식 정리와 문서/검사 코드 정리 외 제품 동작은 고정 EXE와 같다.
- **6.2/6.6 대기**: 물리 Windows IME, Mac 실제 빌드/PTY/키보드/클립보드. 새 스니펫의 CP949 실서버 검사는 별도로 실행하지 않았다(기존 backend 인코딩 변환 단위 검사와 UTF-8 실제 전송을 구분한다). Bash 이외 자동 연동은 지원 범위가 아니다.
- **5.3 대기**: 이 변경을 포함한 release·설치본 생성/설치 검증. 이번에는 debug만 생성했다. 다른 소번호의 외부 파일·장시간·수동/환경 대기를 유지한다.
- 다음 첫 행동: 고정 EXE/결과 SHA 대조 후 Windows 물리 IME 및 Mac 환경 검사. 배포 요청 시 최신 소스로 release/설치본을 생성하고 실제 설치 검사.

## 구현 파일과 근거

- `src-tauri/src/snippets.rs`, `lib.rs`, `build.rs`, `capabilities/main.json`, 자동 권한3개.
- `src/features/terminal/{SnippetDialog.tsx,snippets.ts,CommandGuide.tsx,guideData.ts,assistant.css,session.ts,TerminalPane.tsx}`, `src/app/{App,DetachedWindow}.tsx`.
- 재생 경계: `src-tauri/src/{ssh,windows}.rs`. 기존 출력·창 소유권 모델을 유지하고 재생 구간만 구분한다.
- 검사: `snippets.test.ts`, `tests/ui/assistant.spec.ts`·fixture/config, `scripts/test-assistant-native.mjs`, `tests/assistant-linux.py`, OpenSSH fixture의 less 의존성.
- 명령 설명 검토 자료: [GNU grep 매뉴얼](https://www.gnu.org/software/grep/manual/grep.html), [GNU Bash 함수](https://www.gnu.org/software/bash/manual/html_node/Shell-Functions.html), [Bash command builtin](https://www.gnu.org/software/bash/manual/html_node/Bash-Builtins.html). 예제의 실제 결과는 위 fixture로 별도 검증했다.
