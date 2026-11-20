# macOS 실기기 확인 절차

Mac에서 빌드하고 패키지된 앱을 직접 확인하는 절차다. 결과와 작업 ID 상태는 [macos-readiness](macos-readiness.md)에만 적는다. 실행 방법과 기록 규칙은 `mac-verify` 스킬(`.agents/skills/mac-verify/SKILL.md`)을 따른다.

Windows 결과, Linux 컨테이너 결과, macOS CI 결과를 Mac 실기기 결과로 옮겨 적지 않는다. 인증정보·개인키·Passphrase는 로그와 스크린샷에도 남기지 않는다.

## 1. 준비

1. 저장소를 Mac 로컬 디렉터리에 체크아웃한다. Windows에서 복사한 `node_modules`, `target`, `dist`는 쓰지 않는다.
2. Xcode Command Line Tools, Node 24 이상, rustup, OpenSSL(`brew install openssl@3`, M.1), Docker의 Linux 엔진을 준비한다.
3. 환경을 기록한다: `sw_vers`, `uname -m`, `node -v`, `rustc -V`, `xcode-select -p`, `docker version`.
4. `npm ci`.

## 2. 자동 게이트와 실제 SSH 엔진

```text
bash scripts/verify-macos.sh --package    CI와 같은 게이트와 debug .app
npm run probe                             실제 OpenSSH 인증·키 거부·PTY·resize·SFTP·포워딩·취소
npm run probe:phase1                      제품 엔진(전송 큐, NFD, 터널, 모니터링, Git, tmux, Keychain, 금고, agent 전달)
npm run probe:ftp                         FTP/FTPS/EUC-KR, 큐, NFD → NFC. .tools/ftp-fixture 필요
npm run probe:connect                     프록시, ProxyCommand, 경유지 등 연결 확장
```

`npm run test:native`, `test-*-native.mjs`, `probe:ftp --native`는 WebView2 CDP를 쓰는 Windows 전용이라 Mac에서 실행하지 않는다.

## 3. 앱 실행

- 패키지된 `.app`을 Finder로, 또는 빈 환경의 `open`으로 실행한다. 터미널에서 그냥 `open`이나 `npm run tauri -- dev`로 띄우면 셸의 `PATH`를 물려받아 Finder 실행의 `PATH` 문제(M.3)가 드러나지 않는다. 명령은 `mac-verify` 스킬에 있다.
- 사용자 데이터와 섞이지 않게 `DACHSTERM_TEST_DATA_DIR`로 앱 데이터 폴더를 격리한다.
- 자동 조작은 사람이 Mac을 쓰지 않을 때(입력 장치 유휴 시간 확인) 한다. 사람이 쓰는 동안에는 맨 앞 앱이 바뀌고 보내지 않은 글자가 섞인다.
- 자동 조작과 사람의 직접 조작을 구분해 기록한다. 한글 IME, Keychain 승인, 파일 대화상자, 로컬 네트워크 권한 창은 사람이 확인한다.
- Keychain 암호 창(M.29)이 뜨면 자동 조작이 멈춘다. 시험 항목은 `security`로 정리할 수 있다.

## 4. 기본 기능

### 창과 표시

- [ ] 창, 마스코트, 키보드 포커스, 최소 창 너비, 한글 표시
- [ ] 터미널 글꼴이 Courier로 떨어지지 않음(M.7)

### 연결과 인증

- [ ] 최초 지문 확인·거부, 저장 후 신뢰 재사용, 변경되거나 폐기된 키 차단
- [ ] 비밀번호, RSA·Ed25519 키, 암호화 키와 잘못된 Passphrase
- [ ] Keychain 저장·조회·교체·삭제, 저장소 실패 시 비저장 연결, 세션 복제 시 비밀 복제 없음
- [ ] 세션·그룹 추가·수정·삭제, 검색·즐겨찾기·최근 접속, 재실행 뒤 복원
- [ ] SQLite, 일반 설정, 오류 로그에 인증정보 평문 없음

### 터미널

- [ ] 연결 5개, 개별 종료, 탭 전환
- [ ] Command 키 복사·붙여넣기와 여러 줄 붙여넣기 확인, Option 조합(M.8)
- [ ] 한글 IME 조합·확정·삭제, 영어 문장이 입력 예측으로 망가지지 않음(M.26)
- [ ] UTF-8 서버 셸의 vim·top·htop, 창 resize와 `stty size`
- [ ] KeepAlive 단절 감지, 재접속 시 새 셸, 앱 종료 뒤 원격 셸과 소켓 정리
- [ ] `Cmd+W`: 탭 닫기, 탭이 없을 때 창 닫기 확인, 분리 창, 대화상자가 열렸을 때 무시, `Ctrl+W`는 셸로(M.27)

### 작업 화면

- [ ] 단일·좌우·상하·2×2 배치와 패널 비율 변경. 각 칸의 `stty size`, 한글, vim
- [ ] 탭 이동, 독립 창 분리 중 연속 출력의 누락·중복, 종료 뒤 자원 정리
- [ ] Retina 배율 변경, 모니터 이동, 창 크기 재실행 복원
- [ ] 다중 선택, 멀티 입력의 대상 종료·재접속 해제
- [ ] 테마 전환(연결 중, 독립 창 동기화)

### 파일과 전송

- [ ] UTF-8 한글·공백·NFC·NFD 파일 이름의 목록과 이동, 숨김, chmod·rename·delete·mkdir. 비 UTF-8 이름은 안전한 오류
- [ ] 바이너리·CP949·UTF-8 BOM·CRLF 파일 업로드·다운로드의 SHA-256 일치
- [ ] 네이티브 파일 선택과 Finder 드롭, 한글 이름이 서버에 NFC로 저장됨(M.5)
- [ ] 전송 중 취소·네트워크 단절·앱 종료, 재시작 뒤 같은 프로필·대상으로만 재개, 원본 변경·부분 내용 불일치 거부
- [ ] 클립보드·재귀 복사·이동·삭제, 권한, 압축·해제
- [ ] FTP/FTPS: OS 신뢰 CA, 사용자 CA, 잘못된 인증서 거부, UTF-8·CP949 파일 이름, Binary 보존

### 외부 편집

- [ ] Finder 실행 앱에서 VS Code·Cursor·Sublime 또는 절대 실행 경로로 열기(M.4)
- [ ] 원본 바이트 모드, CP949 → UTF-8 작업본 → CP949 저장, 표현할 수 없는 문자일 때 원격 보존
- [ ] 로컬 `edits` 폴더 권한 0700, 충돌·다시 받기 백업·다른 이름·재실행 복구·정리
- [ ] 저장 확인 카드와 OS 알림

### 터널과 모니터링

- [ ] Local·Remote·SOCKS5 실제 왕복, TCP CONNECT의 도메인·IPv4·IPv6
- [ ] 포트 충돌, 서버 거부, 루프백, 재접속 시 선택한 터널만 재시작, 종료 뒤 포트·소켓 정리
- [ ] Linux CPU·RAM·NET·DISK·Load를 실제 도구 값과 비교, 2·5·60초 주기, 켜기·끄기, 인터페이스 선택, 첫 샘플·오래된 값, 수집 실패 중 터미널 유지

### 금고

- [ ] 마스터 보관함 설정, 기존 Keychain 비밀 이행, 재인증 보기, 창 blur, 30초 숨김, 5분 잠금, 암호 변경, 재시작, DB rollback

### 설치와 장시간

- [ ] `npm run tauri -- build --bundles app,dmg` 뒤 설치 → 실행 → 전체 작업 → 종료 → 재실행
- [ ] 장시간 연결, 대량 출력, 대용량 파일, 반복 연결, 절전·복귀, 네트워크 변경
- [ ] 산출물 SHA-256 기록. 공개 배포 자격 증명은 코드와 로그에 남기지 않는다

## 5. 작업 ID별 확인

### M.2 전송 경로

- [ ] `/tmp`, `/var/folders/…` 아래 로컬 경로를 앱 화면에서 전송. 사용자 심볼릭 링크는 계속 거부

### M.3 Finder 실행 앱의 `PATH`

- [ ] 쿠버네티스 작업 화면의 `kubectl` 탐지, 외부 편집기 실행
- [ ] 로그인 셸 `PATH` 읽기로 인한 앱 시작 지연(3초 제한)

### M.6 서명과 권한

- [ ] `plutil`로 `NSLocalNetworkUsageDescription`, `LSMinimumSystemVersion`, `codesign --verify --deep --strict`
- [ ] LAN 서버 접속에서 로컬 네트워크 권한 창과 연결

### M.12 로컬 탭 파일 트리

- [ ] Zsh와 `/bin/bash` 3.2에서 입력 잔상 없이 `cd` 따라가기(`PROMPT_SP`, 오른쪽 프롬프트 포함)
- [ ] 파일 트리의 복사·삭제

### M.13 첨부와 클립보드

- [ ] `Cmd+V` 이미지 붙여넣기(`arboard` `image-data`), 드롭 좌표, Finder 실행 앱의 첨부
- [ ] 임시 터널 뒤 브라우저 열기

### M.14 창과 제목 줄

- [ ] 신호등 버튼이 36px 제목 줄 세로 가운데, 앱 이름·보기 메뉴와 겹치지 않음. 어긋나면 `trafficLightPosition`을 정한다
- [ ] 빈 곳 끌기, 더블클릭 확대, 전체화면 전환과 복귀, 독립 창도 같은지
- [ ] 탭·연결 카드의 두 손가락 클릭과 Control+클릭 메뉴, `Cmd+Option+방향키`, 탭 드래그(포인터 캡처), 상태바 팝오버
- [ ] 상태바 입력 범위 라디오와 탭 바 체크, `Cmd+Shift+M`, `Cmd+Shift+\`, IME 조합 중 상태바 변경
- [ ] Zsh와 `/bin/bash` 3.2에 입력해 넣는 조작표 훅, 전체 화면 프로그램 일반 안내(Mac에서는 선택 키 표시 없음), 터미널 설정의 `Shift+드래그` 안내 문구

### M.15 SSH agent와 개발 도구

- [ ] Finder 실행 앱의 `SSH_AUTH_SOCK`. 없으면 agent 인증과 키 전달이 모두 안 된다
- [ ] `agent_forward.rs` Unix 소켓 중계: 서버의 `ssh-add -l`, 서명 카드, 거부, `ssh-add -D` 차단
- [ ] tmux 재접속, tmux 시작과 붙기, 재접속 뒤 `SSH_AUTH_SOCK` 안내
- [ ] `Cmd+Shift+G`(변경 검토), `Cmd+Shift+.`(다음 입력 대기), 터미널 안 `Cmd+Shift+↑↓`(프롬프트 이동)와 IME·시스템 단축키 충돌
- [ ] 검토 탭: diff 가상화 스크롤, `color-mix` 색, 좁은 칸 위아래 배치, 의견을 Enter 없이 프롬프트에 넣기
- [ ] `/bin/bash` 3.2.57에서 명령 경계의 Enter 방식, 실패 표시, 프롬프트 이동
- [ ] 연결 트리·파일 트리의 **에이전트 시작…** 우클릭과 Zsh 프롬프트 입력, 현황판에서 독립 창 포커스(`setFocus`, `unminimize`)
- [ ] 앱 내장 agent: 시스템 agent 없이 로그인 키와 추가 키 전달, 승인 카드의 Passphrase와 **이 PC에 저장**이 Keychain에 들어가는지, `~/.ssh` 경로 입력과 NFD 한글 파일 이름, 시스템 agent 키와 중복 없이 합치기
- [ ] 로컬 탭의 키 제공: `SSH_AUTH_SOCK`이 `$TMPDIR` 아래 `dachsterm-agent-*` 0700 폴더의 `agent.sock`인지(104바이트를 넘으면 `/tmp`), `ssh-add -l`에 앱 키와 시스템 키가 중복 없이 보이는지, 앱 키 서명은 카드로 승인·거부되고 시스템 키는 카드 없이 서명되는지, `git push`, 탭을 닫으면 소켓과 폴더가 사라지는지, rc 파일이 `SSH_AUTH_SOCK`을 덮어쓸 때의 안내

### M.16 편집기 시험 앱

일반 앱을 닫고 시험 앱을 만든다.

```sh
CARGO_TARGET_DIR="$PWD/target/editor-trial" npm run tauri -- build --debug --bundles app --config tests/editor-trial/tauri.trial.json
```

`target/editor-trial/debug/bundle/macos/DachsTerm.app`을 Finder로 실행하고 화면 위쪽에서 화면과 테마를 고른다.

- [ ] 한글 2벌식 받침, 받침 넘어가기(`안녕`, `값이`), 조합 중 화살표 이동, 조합 중 `Cmd+S`에서 글자 손실·중복·자모 잔류(사람이 직접 타이핑)
- [ ] 일본어·중국어 입력기 변환과 확정
- [ ] 10만 줄 스크롤과 마지막 줄 도달, 테마 전환, diff 좌우·한 줄
- [ ] `tauri://` 아래 웹 워커 시작(TypeScript 화면의 빨간 밑줄), Web Inspector의 CSP 오류, 아이콘 글꼴

Monaco가 Mac 한글 조합에서 글자를 잃거나 중복하면 CodeMirror 6로 바꾸고 M.18을 다시 확인한다.

### M.17 Finder와 끌어 놓기

- [ ] 로컬 파일·폴더를 Finder로 끌어내기(폴더가 파일 URL로 넘어가는 문제 확인)
- [ ] 서버 파일 끌어내기(버튼을 누른 채 받기, 10MiB 초과·폴더 거부), 앱 위에 놓으면 무시
- [ ] **Finder에서 보기**(`/usr/bin/open -R`)
- [ ] Finder → 로컬 파일 패널 끌어 놓기(점선 테두리, 지금 폴더로 복사, NFD 한글 파일 이름)

### M.18 파일 탭 한글 입력과 저장

- [ ] 한글 입력: 파일 탭, diff 탭 오른쪽, Git 커밋 메시지에서 받침·받침 넘어가기·조합 중 화살표 이동, 조합 중 `Cmd+S`, 커밋 메시지의 조합 중 `Cmd+Enter`
- [ ] 표시: 구문 강조, Markdown 미리보기, data URI 이미지, 2MiB 초과 **크게 열기**, diff 좌우·한 줄
- [ ] 저장: `Cmd+S`, `Cmd+Shift+S`(파일 탭 포커스일 때만 다른 이름, 그 밖에는 명령 창), 다른 이름 저장, 저장 후 권한 유지, SFTP·FTP·로컬 저장과 충돌 카드
- [ ] NFD 한글 파일 이름의 열기·저장·다른 이름 저장
- [ ] `Cmd+Q`가 저장 안 함 확인을 거치는지(창 닫기 경로와 다를 수 있다. 서바이버 정산 가드도 같은 경로)

### M.19 Git 화면

- [ ] Finder 실행 앱의 git 찾기, 명령줄 도구가 없을 때 `/usr/bin/git`을 실행하지 않고 설치 안내, **설정 → Git**의 파일 선택
- [ ] 스테이지·커밋·변경 버리기·브랜치·stash, 커밋 훅 실행
- [ ] fetch·pull·push가 탭 터미널에 입력되고 키·자격 증명 카드로 응답(M.15와 함께)
- [ ] 그래프 SVG와 펼치기, 상태바 Git 항목과 파일 정보, 표시 방식 미리보기
- [ ] 우클릭(두 손가락 클릭·Control+클릭) 메뉴
- [ ] 변경 목록과 그래프 사이 끌기, 커밋 호버 카드 위치(`ResizeObserver`), 커밋 파일 diff 탭, 브랜치 빠른 선택의 한글 입력(조합 중 Enter로 고르지 않는지)

### M.20 터미널 안 브랜치

- [ ] 로컬 탭의 `/bin/bash` 3.2와 Zsh에서 배지 표시, `git checkout` 뒤 첫 프롬프트 갱신, 한글 브랜치 이름, Zsh 오른쪽 프롬프트와의 겹침, `Ctrl+L`·창 크기 변경 뒤 위치

### M.21 SSH 키 만들기

- [ ] 도구 → SSH 키 만들기로 Passphrase 있음·없음 키 생성, `ls -l`로 `0600`, `~/.ssh`가 없을 때 `0700`으로 생성
- [ ] 기본 주석(Finder 실행), 폴더 창, `ssh -i`로 실제 로그인, 세션 폼의 **새 키…**

### M.22 네트워크 도구

- [ ] 포트 사용 여부의 로컬 목록과 프로세스 이름, 다른 계정 소켓 표시
- [ ] 서비스 연결의 HTTPS 공인 인증서 `신뢰 OK`와 자체 서명 표시
- [ ] 경로 추적이 일반 권한에서 TCP로 되는지, 안 되면 UDP(참고용)로 넘어가는지, 안내 문구, 취소 뒤 `traceroute` 프로세스가 남지 않는지
- [ ] 로컬 네트워크 권한(M.6) 프롬프트와 사내망 대상
- [ ] 결과 행 우클릭과 `서비스 연결로 보기`

### M.23~M.25 쿠버네티스

- [ ] 대시보드 판정, 권한 없는 계정, 프로브 단독 감시, 스트림 재개 뒤 중복 표시 없음
- [ ] 실제 exec 인증 플러그인
- [ ] 파드 터미널과 트리 복사를 사람이 직접 조작

## 6. 기능별 확인

### 앱 업데이트(CG.6)

- [ ] 업데이트 설치 중 열린 SSH·로컬 탭이 닫히고 세션 로그가 저장되는지
- [ ] DMG 첫 실행, 이전 빌드의 Keychain 항목 접근, 관리자 권한이 필요한 설치 위치

상세 절차는 [app-updates](app-updates.md)에 있다.

### 연결 확장(CG.1~CG.9)

- [ ] 터미널 우클릭 붙여넣기(사람)
- [ ] XQuartz로 X11 포워딩, 실제 USB 시리얼
- [ ] 업데이트 뒤 Keychain, 하이라이트 규칙이 많을 때의 성능

### 그림·문서 미리보기(FV)

- [ ] PDF·hwp·hwpx·docx·xlsx·pptx·bmp 열기: WebAssembly 엔진과 PDF 워커가 내용 정책 아래 뜨는지, Word 보기의 확대(`zoom` CSS), 한글 글꼴 대체(Apple SD Gothic Neo)
- [ ] **기본 프로그램으로 열기**: 연결된 앱으로 열리는지, NFD 한글 이름, 실행될 수 있는 종류의 확인 창
- [ ] 서버 파일을 받아 연 복사본의 `com.apple.quarantine`(`xattr -l`), 그 표시가 미리보기·Pages 등에서 여는 것을 막지 않는지, 저장 뒤 업로드 확인
