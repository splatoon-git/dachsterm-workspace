# DachsTerm 구현 진행 현황

- 마지막 갱신: 2026-11-07
- **라이선스 미적용, 권리 확인 진행** — 사용자가 회사 권리 문제 없음과 PodTree 직접 저작을 확인했다(2026-11-07). 마스코트는 GPT 이미지 생성물로 기록했고 상업 이용 약관은 미확인이다. 판매 방향은 사용자 의견에 따라 스토어에 올려 가볍게 파는 쪽으로 잡고 복제 방지와 회사·개인 구분을 두지 않는다. 사용자 결정: 판매는 Mac 우선이고 Apple 개발자 등록 예정이다. Windows는 차별화된 유료 기능이 생기기 전까지 무료로 두며 Windows 스토어는 우선하지 않는다. Mac 실기기 결과는 아직 없고 사용자의 MacBook 검증은 2026-11-09(월)부터 가능하지만 확정된 일정은 아니다. 가격은 미정이고 **`LICENSE`는 넣지 않았다.** `AGENTS.md`와 roadmap의 "무료 개인용 앱" 문구는 가격을 정할 때 고친다. 공개 문구에서 외부 제품명을 제거하고 규칙(engineering-rules §3)으로 남겼다. PodTree 주석의 이메일을 지우고 `embeddedSha256`을 갱신했으며, git 이력에는 이메일이 남아 있다. 미커밋 트리 기준 로컬 결과: typecheck, `npm run format:check`, 변경 TSX eslint, `vitest run src/features/sessions` 4건, `cargo fmt --all --check`, `cargo test -p dachsterm --lib --locked podtree` 4건, `session_transfer` 10건 통과. 전체 Rust·Playwright·실제 앱은 미실행이다. 이 PC에 Rust 1.99.1, VS 2022 Build Tools(C++, Windows SDK)를 설치했다. git 이력의 이메일과 공개 문구의 PuTTY·OpenSSH 표기는 사용자 결정으로 유지한다. 다음 첫 행동: 이 변경을 커밋·푸시한다면 CI를 확인한다. 라이선스 적용 여부는 사용자 결정 대기이며, 늦어도 첫 공개 배포 전에 정한다.
- **TW 터미널 작업 공간 재설계 TW.1~TW.10 구현 / Docker 네이티브 일부·Mac 실기기 대기** — [설계안](design/terminal-workspace.md), [시안](https://claude.ai/artifact/DMatupZC4WKWRcgmjCpmxS), [roadmap §22](roadmap.md), [검증 기록](verification/terminal-workspace.md). 설계와 다르게 정한 세부는 설계안 §11. TW.5(`f812b3d`): 상태바 `개별 | 전체 | 선택`, 칸 탭 바의 "입력 받기", 대상 테두리·경고색 상태바, 해제 이유 표시, `Ctrl/Cmd+Shift+M`, 붙여넣기 확인의 대상 창 수. 대상은 화면에 보이는 칸뿐이라 확대도 해제한다. TW.6(`c3bdfd2`): 조작표 실행 알림을 경로 알림 훅에 합쳐 기본 켜짐(설정에서 끔), Bash 별칭·함수는 그 이름만 건너뜀, Zsh `preexec`, Bash 3.2 호환, 이름 모를 전체 화면 프로그램은 일반 안내, 수동 Bash 코드와 창별 "실행 알림 사용" 제거. TW.7(`17af4de`): 터미널 설정을 표시·마우스·키보드·프로그램 연동·알림으로 재배치, `Ctrl/Cmd+Shift+\` 오른쪽 분할, 전역 단축키를 `appShortcuts.ts`로 분리, 단축키 목록·사용 안내서 갱신. 작업 ID마다 typecheck·lint·바꾼 테스트만 통과(미커밋 없음). `17af4de`로 만든 실제 앱(검사 스크립트만 `a53d7b7`까지 수정)에서 `test-workspace-native`, `test-local-native`, `run-phase1 --native --reuse-build`, `test-assistant-native`가 종료 0: 로컬·SSH 동시 입력(전체·선택·격리·해제·붙여넣기), 실제 Bash·Zsh 조작표 자동 표시와 경로 추적, WSL 일반 안내, 새 단축키, 재시작 후 설정 유지. 실패는 모두 검사 쪽 원인으로 고쳤다. Bash 3.2.57·5.2·Zsh 5.9 훅 단독 확인은 Docker pty에서 했다. **대기:** Mac 실기기(M.14, macOS `/bin/bash` 3.2 포함), 선택자만 고친 `test-ftp-native`, 실제 마우스·키보드, 전체 게이트·게임 테스트, 푸시 후 CI. TW.9(설계안 §12, 사용자 요청 2026-11-07): 세로 아이콘 줄·보기 메뉴·`＋ 새 연결` 제거, 사이드바 맨 위 `연결 | 파일` 탭, 로컬·즐겨찾기·최근·그룹 폴더를 접는 한 트리(`ConnectionTree`), 제목 줄 아이콘(명령 `Ctrl+Shift+S`, 터널 `U`, 단축키 `/`, 설정 `Ctrl+,`)과 도구 메뉴(게임), 모든 탭 배치는 탭 우클릭, 스니펫·기본 명령을 합친 명령 창, OS별 단축키 표기, 대화상자 안 우클릭 메뉴 결함 수정, PodTree 진입점 숨김(KV.12에서 제거), 외부 편집기 대화상자를 설치 편집기 카드 선택(`editor_list`)으로 교체. TW.10(설계안 §13): 공통 대화상자 틀(크기 S·M·L, 고정 머리·바닥 버튼줄, 오류 띠, 빈 상태), 왼쪽 분류가 있는 설정 창(중첩 대화상자 제거), 파일 작업 대화상자 제목·버튼을 동작 이름으로, 파일 패널 아래 버튼 줄을 우클릭 메뉴로, 전송 대기열·터널 목록은 줄마다 주 동작 하나와 ⋯ 메뉴, 세션 기록·세션 일괄 수정 재구성, 상태바 로컬 이름 중복 제거. 결과: TW.9는 Vitest 517/517·Playwright 141/141·네이티브 5종 종료 0, `run-phase1 --native`는 마스터 암호 단계 실패(원인 미확인, 재실행 안 함). TW.10은 typecheck·lint·format, 새 Vitest 3/3, 바꾼 Playwright 10개 스펙 46/46, 네이티브 `test-local`·`test-maintenance` 종료 0. Docker가 필요한 `test-native`·`test-ftp`·`test-transfer-queue`·`test-jump`·`test-session-transfer`·`verify-tunnels`는 선택자만 고치고 미실행([검증 기록](verification/terminal-workspace.md#tw10-대화상자-공통-규격설정-창목록-버튼)). `test-phase63-67-native`는 PodTree 단계 때문에 실행할 수 없다. TW.9·TW.10의 Windows·macOS CI 결과는 아직 확인하지 않았다. 다음 첫 행동: CI 결과를 확인하고, Docker 환경에서 선택자만 고친 SSH·FTP 네이티브 검사(`test-native`, `test-ftp-native`, `test-transfer-queue-native`, `test-jump-native`, `test-session-transfer-native`, `test-assistant-native`, `verify-tunnels`)를 한 번씩 돌린다.
- **KV 쿠버네티스 작업 화면 설계 완료, 구현 미착수** — [설계안](design/kubernetes-workspace.md), [roadmap §20](roadmap.md). 코드와 스크립트를 대조했으며 실제 클러스터 실행과 코드 변경은 없다. 남은 ID: KV.0~KV.12. 사용자 결정에 따라 AT·DX 뒤로 미룬다. 다음 첫 행동: AT·DX를 마친 뒤 KV.0을 실측한다.
- **DX 개발자 작업 흐름: DX.1·DX.2·DX.3·DX.4·DX.5·DX.9 구현, 나머지 미착수 / 전체 게이트·CI·Mac 대기** — [설계안](design/developer-workflow.md), [roadmap §19](roadmap.md), [검증 기록](verification/agent-terminal.md). DX.1 나머지: `monitoring.rs` 수집을 `remote_exec`로 옮겼고 `archive.rs`는 표준 입력·시간 초과 정책이 달라 남겼다(근거는 설계안 DX.1의 B10 판단). DX.2: 세션 고급 옵션의 "SSH 키 전달"(기본 꺼짐, 세션 파일로 켜지지 않음), 최종 서버 터미널 채널에만 전달 요청, `agent_filter.rs`(목록·서명·`session-bind`만 통과, 256KiB), `agent_forward.rs`(Windows named pipe·Unix `SSH_AUTH_SOCK`, 연결당 채널 8개, 경유·옵션 끔·거부 서버 채널 거부), 창 안 승인 카드(거부·이번만·이 연결 10분, 60초 무응답 거부), 탭 `입력 대기`, 포커스 밖 알림, IPC `agent_sign_reply`, `Host::verify`를 `ssh/host_key.rs`로 이동. DX.5: `git_status` 명령(`git_status.rs`), 상태바 브랜치·변경 수, 탭 접근성 이름·툴팁, 사이드바 파일 트리 표시, 설정 `gitStatus`, 기본 명령 Git 분류. DX.9: `shellHook.ts`에 OSC 133 `D`·`A`·`C`(Zsh `preexec`, Bash 4.4+ `PS0`, Bash 3.2는 Enter), 프롬프트 이동 `Ctrl/Cmd+Shift+↑↓`, 실패한 명령 막대(`registerDecoration`이 실험 API라 직접 그림), 긴 명령 알림(`longCommandNotify`, SSH 탭). DX.1·DX.5·DX.9(`53ba4eb`)와 DX.2(`91f9b1c`)는 각각 `eb2a16b` 위에서 따로 만들어 검증한 뒤 main에 병합했다. 같은 DX.5를 따로 구현한 `feat/dx-git-status` 워크트리의 미커밋 변경은 사용자 결정으로 병합하지 않았다. 병합 트리 결과([기록](verification/agent-terminal.md#dx2와-dx5dx9-병합-트리)): `probe:phase1` 종료 0(Git·agent 단계 포함), 새로 빌드한 앱의 `run-phase1 --native --reuse-build --agent-only` 종료 0(서명 카드·Git·명령 표시 단계 포함), Vitest 550/550, Playwright 149/149, `cargo test -p dachsterm --lib` 104/104, fmt·clippy·typecheck·lint·format 통과. **대기:** 전체 게이트 `verify-windows.ps1 -Native`, 푸시 후 Windows·macOS CI(macOS CI가 DX.2 `cfg(unix)` 경로의 첫 컴파일), Mac 실기기(Finder 앱의 `SSH_AUTH_SOCK`, Unix 소켓 중계), 이 PC의 실제 Windows `ssh-agent` 서비스, 외부 Git 호스팅과 CLI 에이전트 push 수동 확인, `ssh-add -h` 제한 키, 긴 명령·서명 요청의 실제 OS 알림, 실제 앱의 Bash 3.2. `StopFailure`와 `Notification`의 실제 발생, `exec` 거부 서버 오류 표시도 여전히 미확인이다. 남은 ID: DX.6~DX.8, DX.10(tmux 재접속 후 `SSH_AUTH_SOCK` 안내와 무인 push용 배포 키 안내 포함). 다음 첫 행동: 푸시할 때 Windows·macOS CI를 확인한다. 그다음 설계안 §9 순서대로 DX.6을 시작한다(`git_status.rs`의 `SAFE_GIT`를 쓴다).
- **F.1 파일 트리·자동 팔로우·로컬 파일 구현, Windows 게이트 통과 / Mac·일부 네이티브 대기** — SSH 연결 시 파일 패널 자동 표시, Bash·Zsh 경로 알림 자동 연결(끄기 가능), 로컬 탭 파일 트리, 트리 중심 패널 재구성. `verify-windows.ps1 -Native`와 전송 큐 네이티브 종료 0. [검증 기록](verification/file-tree-follow.md). 남은 ID: F.1 `test-assistant-native`·`test-phase63-67-native` 미실행, macOS M.12. 다음 첫 행동: 푸시 후 Windows·macOS CI 확인.
- **AT 에이전트 터미널: AT.0~AT.6 구현, AT.7은 Windows 범위까지 / 로그인 확인·Mac 대기** — [설계안](design/agent-terminal.md), [검증 기록](verification/agent-terminal.md). AT.1~AT.4는 커밋 `c5d26b5`이고 CI는 Windows `42341348982`, macOS `42341348968` 통과이나, CI는 네이티브 검사와 Mac 실기기를 대신하지 않는다. AT.5·AT.6·DX.3·DX.4를 넣은 `b3d1062`도 CI `42348519717`, `42348519718` 통과다. CI 캐시를 넣은 `12bd6e8`은 main에서 `42350804624`, `42350804626` 통과이며 캐시 저장까지 됐다. 캐시를 복원한 실행의 시간은 아직 없다. AT.5(이미지 붙여넣기, 파일 드롭), AT.6(서버 포트 임시 터널), 사용 안내서를 추가했다. **게이트는 실패로 끝난다:** `verify-windows.ps1 -Native`가 앞 단계와 `test:native` 전체, 유지보수 검사를 통과한 뒤 `run-ftp --native`의 FTPS 단계에서 멈춘다. 이 실패는 변경 전에도 있었고(`a01efa6`, `c5d26b5`의 `mkdir open`) 지금은 같은 FTPS 탭의 `enter directory`에서 3회 재현된다. 원인은 미확인이다. `arboard`의 `image-data`로 macOS 의존성이 늘었다. 로그인한 실제 CLI 에이전트로 파일 드롭, 상태 표시, 재접속을 확인했고, tmux 안에서 올린 이미지의 글자를 에이전트가 읽어 AT.5 합격 기준을 충족했다. 남은 ID: AT.7 Mac 실기기(M.13), FTPS 네이티브 실패 원인. 다음 첫 행동: Mac에서 `mac-verify`로 M.13을 확인한다.
- **새 연결 폼 단순화** — 기본 항목(이름·프로토콜·호스트·포트·사용자·인증·비밀번호·보관)만 펼치고 나머지는 접힌 **고급 옵션**으로 옮겼다(`features/sessions/SessionForm.tsx`, `sessionForm.css`). 경유·인코딩·CA가 설정된 세션과 그런 값을 넣는 템플릿은 자동으로 펼치고, 접힌 칸의 입력 오류는 칸을 열어 포커스한다. 미커밋 트리(다른 작업 변경 포함) 기준 로컬 결과: typecheck·eslint·prettier 통과, Vitest 247/247, Playwright 99건 중 91건 통과, 8건은 재사용하던 외부 dev 서버 중단으로 `ERR_CONNECTION_REFUSED` 후 재실행 8/8 통과. 접힘에 맞춰 고친 네이티브 스크립트(`test-native`, `test-phase63-67-native`, `test-ftp-native`, `test-transfer-queue-native`)와 수정 없이 자동 펼침에 의존하는 `test-jump-native`는 **미실행**이며, 실제 앱 WebView2·Mac 실기기도 대기. 다음 첫 행동: 앱 빌드가 가능할 때 `npm run test:native`로 확인한다.
- **터미널 붙여넣기 확인창 미리보기** — 확인창에 붙여넣을 내용을 보여주고 줄바꿈(`↵`)·제어문자(`ESC`, `^C`)·숨김 문자(`U+202E`)를 표시한다. 표시는 2만 자까지이고 나머지는 글자 수를 안내한다(`features/terminal/PasteConfirm.tsx`, `pastePreview.ts`). 미커밋 트리(병행 세션 폼 변경 포함) 로컬 결과: typecheck·eslint 통과, 변경 파일 prettier 통과, Vitest 247/247, Playwright 99/99. 첫 Playwright 전체 실행의 게임·세션 폼 실패는 병행 빌드로 CPU가 포화된 시간대에 나왔고, 재실행에서 재현되지 않았다. `verify-terminal-basics.mjs`에 미리보기 검사를 추가했으나 병행 작업과의 실행 파일 잠금을 피하려고 **실제 앱 `test:native`와 Mac 실기기는 대기**다. 다음 첫 행동: `npm run test:native`로 추가한 검사를 확인한다.
- **터미널 Ctrl/Cmd+스크롤 글꼴 크기 구현** — 터미널 위에서만 동작하고 8~32 범위로 전체 터미널에 저장된다(`features/terminal/fontWheel.ts`). `22fc0f0` 기준 로컬 결과: typecheck·eslint·prettier 통과, Vitest 240/240, Playwright 91/91. 첫 실행의 실패 3건(`survivor/stages.test.ts`, `adventure-random.spec.ts:101`, `survivor-profile.spec.ts:44`)은 CPU 포화 실험과 겹친 시간대에 나왔고 부하가 없을 때 재현되지 않았다. 실제 앱 WebView2와 Mac 실기기(트랙패드 속도 포함)는 대기. `docs/user-guide.md` 단축키 표에는 아직 없다. 다음 첫 행동: 실제 앱에서 동작을 확인하고 사용 안내서 단축키 표에 추가한다.
- **P3·B9 완료, T5 대부분 처리** — `tests/` 타입 검사를 게이트에 연결하고 미사용 명령 4개를 제거했다. `7562f92`(P3·B9 포함) CI는 Windows `42172611266`, macOS `42172611191` 통과이나 CI는 네이티브 검사를 실행하지 않는다. `test:native` 불안정은 주로 스크립트의 경합과 짧은 대기가 원인이었고 제품 결함은 확인되지 않았다. 수정한 스크립트는 `64e1579` 빌드의 사본으로 평상시 5회 통과했다(로컬). 남은 ID: T5의 분할 단계 실패 1건(원인 미확인)과 부하 상태 재검증. 다음 첫 행동: `test:native`가 다시 실패하면 남긴 진단으로 분할 단계 원인을 확인한다. [P3·B9 기록](verification/tests-typecheck-and-unused-commands.md), [T5 기록](verification/native-test-flakiness.md) 참조.
- **macOS 준비 점검(5.2 선행)** — M.2~M.4 수정(`0fcf569`). macOS CI `42170815875`와 Windows CI `42170815900` 통과: Vitest 231, Playwright 87, Rust 66+1(Mac)·61+1(Windows), clippy, debug `.app` 생성. 빌드와 자동 테스트만 확인했으며 **실기기 실행 결과는 아직 없다.** 남은 ID: M.1, M.5~M.11, M.2~M.4 실기기 확인. 다음 첫 행동: MacBook에서 `mac-verify`로 검증한다. [macOS 준비 상태](verification/macos-readiness.md) 참조.
- **N.2 이름 변경** — 작업 폴더와 GitHub 저장소는 `dachsterm-workspace`, 제품은 `DachsTerm`, 마스코트는 `Dachs`로 통일했다. 게임 화면·코드·CSS·테스트와 설계 문서 파일명을 갱신했다. 현재 상태는 이 문서 하단 N.2 기록을 따른다. README는 소개·설치·지원 범위로 줄이고 사용법은 [사용 안내서](user-guide.md), 개발·검사는 [개발 가이드](development.md)로 분리했다.
- **N.1 제품명·내부 식별자 DachsTerm 전환 구현·Windows·실제 SSH 검증 완료(불안정 T5 있음) / PodTree·Mac 재검증 대기**: 데이터 이전 없이 npm/Rust/실행 파일·앱 ID·저장 키·JSON 규약·보안 저장소·암호화 AAD·셸 알림·테스트/문서를 통일했다. 단위656(사본 포함 추정, 실측 226은 하단 구조 검토 참조)+57개/UI86개, 실제 로컬PTY/WSL·테마·OS 암호보관/재시작·복구·FTP/FTPS/CP949·새 NSIS 설치/재설치/실행/제거 통과. [개명 검증](verification/rename.md) 및 하단 N.1이 최신 상태다. 과거 산출물 경로/해시와 실제 폴더/GitHub 주소는 보존한다.
- **6.2 스니펫·6.6 기본 명령/로그 필터/조작표 구현·Windows 실제 통합 검증 완료**: SQLite 스니펫·최종 대상/본문 확인·브로드캐스트 격리, 기본 명령26/필터7·복사·수동/Bash 실행 알림 조작표. 실제 SSH/PowerShell/WSL·독립 창·재시작7개 시나리오 묶음 통과, pageErrors0. [검증 기록](verification/phase-6-2-6.md)과 하단 최종 기록 참조. 물리IME/Mac 및 최신 release/설치본 대기이며 Phase6 전체 환경 검증 완료는 아니다.
- **6.3 세션 로그·6.7 PodTree 구현 및 Windows 실제 통합 검증 완료 / Mac·선택 환경 대기**: UTF-8 로그/마스킹/회전/자동 기록, 독립 PodTree PTY·고정 context/namespace·조회/운영 모드·종료 정리. 실제 PowerShell/OpenSSH/WSL·Kubernetes 13개 시나리오와 앱 재시작 통과. [검증 기록](verification/phase63-67.md), 하단 최종 기록과 보존 debug를 따른다. 전체 Phase 6 완료는 아니다.
- **6.4/6.5 구현·Windows 자동 검증 완료 / 외부 실파일·Mac 대기**: 최대4홉 SSH·각 홉 인증/신뢰, 계층/태그/일괄 수정/템플릿, JSON v3·외부 이관 확장. 실제 OpenSSH 1/2홉·혼합 인증·SFTP/편집/모니터링/터널·중간 단절 격리 및 최종 WebView2의 경유 인증/신뢰·PTY·템플릿·일괄 수정·재시작 통과. Rust54개·세션 규칙3개·관련 브라우저8개 통과. debug 산출물과 별도 대기는 [검증 기록](verification/phase-6-jump-sessions.md), 상세는 하단 6.4/6.5를 따른다. 전체 Phase 6 완료는 아니다.
- **6.1 폴더 전송·영속 큐 구현 / Windows 자동·실제 프로토콜 검증 완료**: SFTP/FTP/FTPS 재귀 업·다운로드, 다중 선택·드롭 확인, 충돌3종, 영속 큐/순서/묶음 제어/상한을 추가했다. 실제 폴더·64MiB 재개/자원·권한·ENOSPC·기존 프로토콜 회귀와 Windows 앱256MiB 강제종료→재인증→UI재개/해시 일치를 확인했다. OS 선택창/물리 드롭·네트워크/절전·Mac은 대기. [6.1 검증](verification/phase-6-1.md)과 하단 최종 기록을 따른다.
- **Phase 6 구현 진행**: 6.1 폴더 전송·큐 → 6.2 스니펫 → 6.3 세션 로그 → 6.4 점프 호스트 → 6.5 고급 세션 관리·이관 → 6.6 기본 명령·로그 필터·초심자 조작표 → 6.7 PodTree 내장. 범위·검증 기준은 roadmap §16 및 §4.0, 각 작업의 최신 상태는 상단/하단 해당 기록을 따른다. 이전 계획 등록 시점의 미착수 기록은 이력이다.
- **G.8.6 중단 대응·Windows 자동 검증·배포 산출물 반영 / 수동·환경 검증 대기**: 긴 프레임/pagehide/freeze 정지·입력 해제·저장을 추가했다. 단위215개·브라우저30개, 실제 내장 앱의 무강화2시드 일반 키보드3/6 보스→4/7, 실제 PowerShell/OpenSSH 입력 격리, 저장 실패 종료/재시작 회귀·새 release/NSIS 설치/재설치/제거를 검증했다. 부하/메모리·스냅샷/해시·남은 사람 평가/OS 절전·종료/Mac은 [8.6 검증](verification/survivor-validation.md)과 하단 G.8.6을 따른다. 공유 트리의 병행 콘텐츠/시각 변경은8.6 고정 검증 범위와 구분한다. **G.8 전체 검증 완료는 아니다.**
- **G.8.5 닥스의 서바이버 게임탭·전투 UI·입력/음향·종료 정산 연결 완료**: 게임 목록에서 쉼터/Canvas/HUD/카드/통과/결과를 사용할 수 있다. 단위209개·브라우저 고유28개(최종 서바이버UI9+기존19)·타입/전체린트/빌드, 최신 Windows debug의 자연 첫 카드·저장 실패 창닫기 차단·재시도·정상 종료/재실행 검증 통과. [UI 검증 기록](verification/survivor-ui.md)과 하단 G.8.5가 최신 상태다. **G.8.6 밸런스·성능·실제PTY/SSH·OS/배포 검증은 남음**, G.8 전체 완료는 아니다.
- **G.8.4 닥스의 서바이버 영구 성장·저장·쉼터 구현/해당 범위 검증 완료**: 강화4종·무기2종/다시뽑기 해금·실제 지불액 환불, 스키마1·단일 소유권·체크포인트/중단 복구·종료 정산/중복 보상 방지와 독립 쉼터를 추가했다. 전체209개/브라우저8개·타입/린트/빌드, Windows WebView2 저장 API/6초 대기 후 강제 종료 복구 실증 통과. 즉시 전체 프로세스 강제 종료의 디스크 반영 전 손실은 확인된 한계다. [검증 기록](verification/survivor-profile.md) 및 하단 G.8.4가 최신 상태다. 게임 카탈로그/전투/탭 종료 연결은 G.8.5, 밸런스/실환경/산출물은 G.8.6이다.
- **G.8.3 닥스의 서바이버 연속 스테이지·적/보스·드롭 엔진 구현·규칙 검증 완료**: 60초 일반 구간·3의 배수 보스·성장/누적 시간 유지·통과/다음/종료, 일반적5/정예2/보스1·골드/회복 드롭을 연결했다. 서바이버94개/전체150개·타입·전체린트·프런트엔드 빌드 통과. [상세 설계](design/dachs-survivor.md)와 하단 G.8.3 기록이 최신 상태다. 영구 저장/정산은 G.8.4, 실제 화면 연결은 G.8.5, 실플레이/성능/실환경은 G.8.6이며 전체 G.8 완료가 아니다.
- **G.8.2 닥스의 서바이버 카드·무기·진화 구현·규칙 검증 완료**: G.8.1 엔진에 카드3장 추첨/연속 선택·6무기·8능력·3진화·다시 뽑기를 연결했다. 전체 규칙109개(서바이버53개)·타입·전체 린트·프런트엔드 빌드 통과. 이 수치는 G.8.2 당시 검증 기록이며 보스/드롭의 현재 상태는 위 G.8.3을 따른다. 영구 성장/화면/실환경은 G.8.4~G.8.6이며 게임 목록에는 아직 노출하지 않는다. [설계안](design/dachs-survivor.md)의 엔진 연결 계약과 하단 구현 기록을 따른다.
- **G.6 랜덤 모험·환경/기믹·밟기 구현·Windows 검증·release 빌드 완료**: Space 물기·↑/W 점프·공중 ↓/S 빠른 밟기와 자동 머리 밟기, 시드 재현/4환경 순환/기믹·적 다양화. 최종 규칙53개·고유 게임 UI15개·실제 WebView2와 로컬 PTY 입력 격리 통과. 상세는 하단 G.6.
- **G.5 간식 타임 개선 구현·Windows 검증·release 빌드 완료**: G.4 모션 atlas 공유, 좌우 가감속/반전·씹기·별 점프·피격/점수 효과, 연속 기록·정원·결과 화면. 전체 규칙53개, 게임 UI17개, 실제 WebView2 6종·로컬 PTY 입력 격리 통과. 최신 `target/release/daxterm.exe` 반영. 상세·남은 환경 검증은 하단 G.5 기록.
- **G.4 닥스의 모험 횡스크롤 액션 구현·Windows 검증·release 빌드 완료**: 직접 좌우 이동·점프·물기, 6포즈 스프라이트, 적/발판/가시/협곡/쉼터/완주를 추가했다. 규칙44개·게임 UI11개·실제 WebView2 6종과 로컬 PTY 입력 격리 통과. 상세·남은 검증은 하단 G.4 기록.
- **G.3 닥스 미니게임 2종 구현·Windows 검증·release 빌드 완료**: 게임 목록에 간식 타임·닥스의 모험을 추가했다. 규칙38개/신규 UI4개/기존 게임 UI5개 및 실제 WebView2 6종·로컬 PowerShell 입력 격리 통과. 최신 `target/release/daxterm.exe`에 반영. 파일·결과·남은 항목은 하단 G.3 기록 참조.
- **I.1 구현·Windows 자동 검증·release 빌드 완료**: 자체 세션 JSON v2/Schema·v1 호환, PuTTY/MobaXterm/OpenSSH 기본 SSH 변환·미리보기·선택/계정 보정, 첫 접속 인증창의 로그인 성공 후 암호 저장을 추가했다. 실제 OpenSSH/OS 저장소·재시작·저장 실패 안내까지 검증했다. 최신 `target/release/daxterm.exe`에 반영. 지원/제외 계약은 `docs/session-transfer.md`, 상세/남은 검증은 하단 I.1 기록을 따른다.
- **U.3 구현·Windows 실제 검증 완료 / Mac·설치본 대기**: 대화상자 버튼 32px 정렬, 터널 목록/편집 분리, 유형별 연결 흐름 안의 입력과 설명, 저장 후 목록 복귀, 실행·중지/자동 시작 구분을 반영했다. UI 전체32개 및 최종 해당 영역12개, 실제 Local/Remote/SOCKS5 왕복과 전체 native 회귀 종료0. [설정 UI 검증](verification/settings-ui.md) 참조. 검증 실행 파일은 `src-tauri/target/windows-hardening/debug/daxterm.exe`; 기존 release/NSIS를 이 결과로 대체하지 않는다.
- **S.1 구현·Windows 실제 통합 검증 완료 / Mac 등 대기**: 취약한 `rsa` 패키지를 제거하고 `ring` RSA SHA-2 인증·호스트 검증으로 대체했다. RSA OpenSSH/PEM/PKCS8, SSH agent·keyboard-interactive/MFA, 선택 복사·우클릭·Backspace 설정, 기본 켜짐 SFTP 경로 따라가기 구현. Windows 감사0건, 실제 OpenSSH 엔진과 WebView2 전체 회귀 종료0. [S.1 검증 기록](verification/security-terminal-basics.md)과 문서 하단 S.1이 정본이며 이전 RSA 차단/잔여1건은 과거 설치본 이력이다. 기존 NSIS는 이번 변경을 포함하도록 재생성하지 않았다. 다음 첫 행동: 병행 U.2 완료 후 최신 소스의 설치본 생성·설치 검사, 이후 실제 OTP/하드웨어 agent·Mac 검증.
- **U.2 구현·Windows 자동 검증 완료 / Mac 대기**: 왼쪽 연결/원격 파일 통합, 공통 버튼 크기, 마우스 리사이즈·접기, 단일/분할 전체화면·선택 창 확대, 분할 입력 모드(개별/모든 창/선택한 창), 로컬·WSL·SSH 입력 그룹. 실제 Windows 로컬/SSH/SFTP/FTP·분리 창 회귀 통과. 최신 실행 파일은 `target/release/daxterm.exe`이며 기존 0.5.1 NSIS 설치본은 U.2를 포함하지 않는다. 아래 U.2 최종 기록 참조.
- **U.1 구현·Windows 실검증 완료 / Mac 대기**: 로컬 PTY·PowerShell/명령 프롬프트·WSL 자동 목록과 Ubuntu 실제 실행, 상단 메뉴/사이드바/단축키 개선. 최신 debug 앱 및 하단 U.1 기록 참조. 후속 W.3의 0.5.1 설치본에 포함했다. Mac 검증은 별도다.
- **W.1~W.4 Windows 구현·자동 회귀 보완 반영 / 공개 출시는 보류**: 2026-11-05 사용자 요청. 데이터 변경/복구, 진단, 보안·릴리스 검사, 분할 포커스 수정 완료. 당시 남은 RSA 의존성1건은 후속 S.1 소스에서 해소했다. 서명/배포 자원, 실제 OS 수동 검증은 남아 있다. Mac은 사용자 요청대로 후순위다. G.2/U.1 변경을 포함한다.
- **W.1~W.4의 기존 0.5.1 설치본 이력**: DB/journal 삭제·스키마 원자성·파일 잠금·설정 복구/진단, 보안 의존성 보완과 릴리스 검사 추가. 당시 RSA 개인키 인증을 차단했으며 현재 소스는 S.1의 안전한 RSA 대체 경로로 변경했다. 실제 수동 항목은 [Windows 체크리스트](verification/windows-release-checklist.md), 복구·검사 절차는 [안정화 기록](verification/windows-hardening.md). 아래 0.5.0 최종 결과도 이전 산출물 이력이다.
- **0.5.1 패키지 검증 완료**: 분할 포커스 수정·편집 복구 manifest 원자적 저장과 U.1/G.2를 포함한 NSIS 9.26MiB. `scripts/test-installer.ps1 -Version 0.5.1 -PreviousVersion 0.5.0 -Reinstall` 종료0: 이전 설치본 교체/버전/일반 파일 보존/동일 버전 재설치/라이선스 고지 포함/실행/종료/제거. 사용자 데이터 이행 전체 성공을 뜻하지 않는다. 설치 SHA256 `CAAE2072D5A89E0633FFF23C32B2792B17A0138792DE15C27198C11DDBA10EBC`, `NotSigned`, 공개 승인 false manifest 동봉. 최종 Windows native 전체 회귀 종료0. 5분 SSH stress와 수동 검증 범위는 마지막 W 기록 참조.
- **G.2 게임 작업 영역 통합 구현·Windows 기능 검증 완료**: 사이드바 목록→중앙 작업 탭, 단색 터미널 스타일, 현재 판 보존/자동 정지/Esc 복귀. 최신 게임 UI 5개·WebView2 4종·실제 SSH 연결 유지/입력 격리 단계 통과. 당시 전체 native 회귀는 split layout에서 실패했으나 후속 U.1의 실제 SSH 전체 회귀가 split 포함 통과했다. Mac은 대기, 후속 W.3의 0.5.1 설치본에 포함했다. 하단 G.2/U.1 기록 참조.
- 추가 테마 요청 **T.1**: 기존 크림색 기본값을 보존한 12개 테마·선택/저장 UI 구현 완료. Windows WebView2 전환/앱 재시작 복원 통과. 실제 SSH 분리 창의 연결 중 테마 동기화도 통과. Mac 테마 검증은 대기. 이 작업의 파일/검증/다음 행동은 아래 T.1과 [테마 검증 기록](verification/themes.md)을 우선 참조한다. 다른 Phase의 진행 상태는 유지한다.
- 범위 정본: [roadmap.md](roadmap.md), 작업 단위: roadmap §4.0.
- 별도 추가 작업 **G.1 기본 미니게임 4종**: 구현·규칙/UI·Windows WebView2 검사 완료. Mac 실기기 검증은 대기. 이 작업은 아래 기존 Phase 검증 상태와 별도로 관리하며 문서 하단 G.1 기록을 참조한다.
- 요청 범위: **남은 Phase 전체(2.1~5.3), 디자인/UI 개선 및 기존 검증 대기 항목**. 2026-11-04 요청으로 범위 확대.
- 현재 상태: **0.5.1 Windows 구현·자동 통합 검증·NSIS 설치/실행/제거 완료**. 데이터 복구/진단·로컬 PTY·게임 통합·테마·분할 포커스 수정을 포함한다. **보안 감사 잔여·서명·수동 OS 검사로 공개 안정판 승인은 보류한다. 전체 Phase5/v1.0 완료가 아니다.**
- 최종 실제 통과: OpenSSH 엔진/5분 반복 연결, Windows WebView2 전체 SSH 회귀·복구 UI, FTP/FTPS/CP949 엔진+WebView2, Rust 앱23개+실증1개·프런트엔드29개·UI20개, typecheck/lint/format/clippy, NSIS 설치본 교체/재설치/실행/제거. 상세 명령은 마지막 W 기록 참조.
- 산출물: `target/release/bundle/nsis/DaxTerm_0.5.1_x64-setup.exe` (9.26MiB, 서명 없는 개인 검증 빌드). 정확한 SHA256은 상단 패키지 기록과 동봉 manifest 참조.
- 남은 작업 ID: **W.3 서명/공개 배포 자원**, **S.1/5.3 최신 설치본 반영·검증**, **W.4/5.1 실제 Windows 수동 체크리스트 M1~M10**, **5.2 Mac 전체**, **5.3 Mac 앱/DMG·설치 및 서명/공증**. RSA Windows 의존성 게이트는 S.1에서 해소했으며 프로토콜별 제한은 README 표를 따른다.
- 다음 첫 행동: 병행 U.2 결과와 함께 최신 설치본을 생성·검증하고 [수동 체크리스트](verification/windows-release-checklist.md)의 M1→M2→M3, 별도 M6의24시간 검사를 진행한다. Mac은 사용자 요청 전 보류한다.

## 2026-11-05 상용 출시 준비도 점검

- 요청: 완료 여부 및 상용 품질 기준의 부족한 점 평가. 제품 코드 변경 없이 roadmap/README/검증 기록과 실제 설정·인증·저장 코드를 대조했다.
- 판단: 핵심 기능을 갖춘 Windows 베타 수준으로 평가하며 상용 안정판/전체 Phase 완료로 판단하지 않는다. 기존 실제 SSH/FTP/설치 성공은 2026-11-04 기록을 근거로 하며 이번 점검에서 재실행하지 않았다.
- 이번 검증: `npm test` 29개 통과, `npm run typecheck` 종료 0. `Get-FileHash -Algorithm SHA256 target/release/bundle/nsis/DaxTerm_0.5.0_x64-setup.exe` 결과가 문서 상단 최종 해시와 일치. `Get-AuthenticodeSignature` 결과 `NotSigned`.
- 확인 파일: `README.md`, `docs/verification/phase-2-5-windows.md`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `package.json`, `src-tauri/src/{ssh,storage,settings}.rs`. 암호/개인키 인증과 제한된 JSON 내보내기를 확인. MFA/SSH agent 미지원 및 폴더 재귀 업·다운로드/전송 예약 큐 미지원은 README에 명시되어 있다.
- 출시 보완 후보(새 구현 범위로 승인된 것은 아님): 서명된 배포·업데이트/이전 버전 복구 절차, 데이터 백업·복원 및 업그레이드 실패 검증, 민감정보를 제거한 진단 내보내기, 의존성 보안/라이선스 점검, 반복 가능한 CI·릴리스 관리. 이 작업 공간은 Git 저장소가 아니며 `.github` 및 프로젝트 배포용 LICENSE/NOTICE 파일은 확인되지 않았다. 기존 audit JSON은 현재 취약성 판정 근거로 사용하지 않았고 새 의존성 보안 감사도 실행하지 않았다.
- 업무 환경 확장 후보: MFA/keyboard-interactive, SSH agent, 점프 호스트, 폴더 전송/큐. 모든 사용자의 출시 필수 조건으로 단정하지 않고 대상 사용자에 따라 우선순위를 정한다.
- 남은 기존 ID: **5.1** 물리 IME·OS 파일 선택/드롭·GUI 편집기·절전/장시간, **5.2** Mac 실기기 전체, **5.3** Mac 배포/설치·공개 배포 서명/공증. 이번에는 실기기·장시간·보안 감사를 수행하지 않았으므로 상태를 변경하지 않는다.
- 다음 첫 행동: Windows 출시 검증을 목표로 5.1의 수동 OS 흐름과 장시간·네트워크 전환·절전 복귀에 대한 재현 조건/합격 기준을 정하고 실제 검증한다. Mac도 출시 대상이므로 5.2와 [macOS 준비 상태](verification/macos-readiness.md)의 M.*를 완료해야 한다.

## Phase별 상태

| Phase | 상태 | 남은 작업 |
|---|---|---|
| 0 — 기반·기술 실증 | 검증 대기 | 0.4 Mac 기본 빌드·접속 |
| 1 — SSH 실사용 | 검증 대기 | 코드·Windows 자동 실증 완료. 물리 Windows IME와 Mac |
| 2 — SFTP·편집기 | 구현·자동 검증 완료 | OS 파일 선택/드롭·GUI 편집기 수동 조작·Mac 대기 |
| 3 — 멀티 터미널·터널링 | Windows 검증 완료 | Mac 실기기 대기 |
| 4 — 모니터링 | Windows 검증 완료 | Mac 실기기 대기 |
| 5 — 안정화·배포 | 일부 검증 대기 | Windows 자동 검사·설치 통과. 수동 OS·장시간·Mac·서명 대기 |
| 6 — SSH 작업 기능 확장 | 구현·Windows 자동 검증 반영, 환경 검증 대기 | 6.1~6.7 구현 기록 있음. 외부 실파일·물리IME/OS·장시간·Mac·선택 환경 및 최신 설치본은 각 최종 기록 참조 |

## 작업별 상태

| ID | 작업 | 상태 | 근거 또는 남은 사항 |
|---|---|---|---|
| 0.1 | 도구·Tauri 초기 구성 | 완료 | 기존 Windows 개발 앱·내장 자산 앱 실행/빌드 |
| 0.2 | 토큰·라이트 테마·마스코트·레이아웃 | 완료 | 1개 테마·토큰 계약, 좁은 창·포커스 검사. Phase 1에서 htop ANSI 배경 대비 보정 |
| 0.3 | OpenSSH·인증·호스트키·PTY 실증 | 완료 | 실제 Linux OpenSSH 비밀번호·일반/암호화 키·키 거부·PTY·resize |
| 0.4 | SFTP·포워딩 실증·엔진 결정 | 검증 대기 | Windows 결과와 ADR 유지. Mac만 미실행 |
| 1.1 | 안전한 SSH 터미널 | 검증 대기 | 실제 제품 엔진+Windows 앱 인증/신뢰/키 차단/PTY/TUI 통과. 물리 IME·Mac 대기 |
| 1.2 | 세션·DB·OS 보안 저장소 | 검증 대기 | Windows CRUD·그룹·검색·즐겨찾기·최근·재실행·Credential Manager 검증. Mac Keychain 대기 |
| 1.3 | 다중 탭·재접속·편의 기능 | 검증 대기 | Windows 5개 연결·클립보드·TUI·KeepAlive 단절·재접속·정상 종료/원격 셸 정리 통과. 물리 IME·Mac 대기 |
| 2.1 | SFTP 탐색·파일 관리 | Windows 검증 완료 | 실제 엔진 및 native CRUD·권한·복사/이동/삭제·압축 |
| 2.2 | 파일 전송·취소·오류 | 수동 검증 대기 | SFTP128MiB/FTP32MiB 재개·바이트 일치·복구 통과. OS 드롭/파일 선택·Mac 대기 |
| 2.3 | 외부 편집·충돌·복구 | 수동 검증 대기 | 외부 실행 파일 지정·저장 확인/취소/재시도/자동 업로드 native 통과. GUI 제품 수동 조작·Mac 대기 |
| 3.1 | 분할·탭 이동·레이아웃 저장 | Windows 검증 완료 | 분할/resize/독립 입력/배치 복원. Mac 대기 |
| 3.2 | 독립 창·구독·테마 동기화 | Windows 검증 완료 | 실제 창 분리·소유권·출력/종료 및 연결 중 테마 동기화 |
| 3.3 | Local/Remote 터널 | Windows 검증 완료 | Local/Remote 실제 왕복·포트 충돌·종료 해제 |
| 3.4 | SOCKS5·재연결·JSON | Windows 검증 완료 | SOCKS5 도메인 왕복·설정/JSON·스키마 검사 |
| 4.1 | 지표 수집·작업 관리 | Windows 검증 완료 | 실제 Linux 독립 채널 수집·차분·종료 |
| 4.2 | 상태바·패널·차트 | Windows 검증 완료 | WebView2 실차트·상태바·활성 연결, Mac 대기 |
| 5.1 | Windows 종합 검증 | 수동 검증 대기 | 최신 자동 회귀 통과. 물리 IME·OS 조작·장시간·절전 대기 |
| 5.2 | macOS 종합 검증 | 환경 대기 | Mac 실기기 부재. Windows/Mock으로 대체하지 않음 |
| 5.3 | 설치·릴리스 | Mac·공개 배포 대기 | Windows0.5.0 NSIS 설치/실행/종료/제거 통과. Mac/서명·공증 미실행 |
| 6.2 | 스니펫 | 구현·Windows 검증 완료 | 실제 SSH/PowerShell/WSL·명시대상·독립 창·재시작, 물리IME/Mac 대기 |
| 6.6 | 기본 명령·로그 필터·조작표 | 구현·Windows 검증 완료 | Linux 실제 필터와 SSH/WSL Bash 알림·수동 고정·좁은 창, 물리IME/Mac 대기 |

## 구현과 주요 계약

- `src-tauri/src/{lib,commands,ssh,hostkeys,storage,credentials}.rs`: 실제 제품 엔진. 프로필/연결/탭 ID 분리, russh PTY, cancellation, KeepAlive, 시간 제한, 최초 지문·known_hosts·변경/폐기 키 차단.
- `src-tauri/build.rs`, `src-tauri/capabilities/main.json`: 명령 allow 권한 자동 생성, main 및 terminal-* 창만 허용. file/shell/network plugin 권한 없음.
- 출력은 32KiB 한 프레임을 xterm 렌더 완료 ACK 후 다음 프레임으로 전달. 수신 window·입력 큐·프런트엔드 대기 입력 상한이 있다. 재접속은 새 ID/새 셸/터미널 초기화이며 명령을 재실행하지 않는다.
- SQLite schema 3, WAL, foreign keys. 비밀번호/Passphrase는 native keyring, DB에는 참조만 저장한다. credential 참조 정리 journal로 DB 실패 시 이전 비밀 참조를 보존하고 미참조 비밀은 재정리한다. 세션 복제는 credential을 복제하지 않는다.
- `src/app/`, `src/components/Dialog.tsx`, `src/features/sessions/`, `src/features/terminal/`, `src/lib/ipc.ts`: 폼·목록·그룹·필터, 독립 탭, 신뢰 확인, 연결 상태, 검색·복사/붙여넣기·글꼴·스크롤백.
- `src/themes/`: 공통 토큰과 기본 Classic을 유지하며12개 테마 제공. htop의 ANSI black-on-green/blue/cyan과 일반 ANSI-on-light 모두 4.5:1 테스트. 서버 truecolor는 그대로 둔다.
- `src-tauri/examples/phase1_probe.rs`, `scripts/{run-phase1,test-native}.mjs`: 실제 제품 엔진과 Windows WebView2 앱 통합 테스트. 디버그에서만 격리된 데이터 경로·CDP 포트를 설정한다. 릴리스는 테스트 환경변수를 무시한다.
- 상세 결정: [ADR 0002](adr/0002-phase1-client.md). Phase 0 실증/선택 근거는 [ADR 0001](adr/0001-ssh-engine.md)과 [기존 Windows 기록](verification/phase-0-windows.md)에 보존.
- 이 작업 공간은 Git 저장소가 아니므로 init/commit은 수행하지 않았다.

## 최종 검증

상세: [Phase 1 Windows](verification/phase-1-windows.md).

- `npm run typecheck`, `npm run lint`, `npm run format:check`: 통과.
- `npm test`: 테마 계약/폴백/대비 3개 통과.
- `npm run test:ui`: 6개 통과. 1280/800/560px, 포커스, 대체 테마, 폼 접근성·실패 시 비밀 입력 제거.
- `npm run build`: 통과. 메인 번들 크기 경고(압축 전 약 613KB)는 남는다.
- `cargo fmt --all --check`: 포맷 보정 후 통과.
- `cargo clippy --workspace --all-targets --locked -- -D warnings`: 통과.
- `cargo test --workspace --locked`: 앱 6개 + 기존 실증기 1개 통과.
- `cargo build --workspace --locked`: 실행 중 EXE 잠금 오류 후 앱 종료 상태에서 재실행 통과.
- `npm run tauri -- build --debug --no-bundle`: Cargo PATH 설정 후 최종 재빌드 통과. `target/debug/daxterm.exe`에 내장 자산 실행 파일 생성.
- `npm run test:native`: 종료 코드 0. 내장 자산 네이티브 빌드, 실제 제품 엔진, 실제 Windows UI·OpenSSH 모두 통과. 비밀번호/RSA SHA-2/일반·암호화 Ed25519/잘못된 인증/키 변경·폐기/5개 연결/UTF-8/resize/흐름 제어/OS 저장소/단절·재접속/클립보드/정상 종료와 원격 셸 정리 포함.
- 네이티브 `vim` 한글 저장 파일을 서버에서도 검사했고 `top`/`htop` 화면과 대비를 스크린샷으로 확인했다. 물리 IME가 아니라 composition 이벤트를 재현한 자동 테스트다.
- 일회성 테스트 컨테이너 제거 및 DachsTerm 테스트 프로세스 종료 확인. 테스트 인증정보를 문서/로그에 기록하지 않았다.

## 실패 해결·제한·다음 행동

- 해결: known_hosts comment 비교 오류 → 키 데이터만 비교. DB 실패 시 OS 비밀 손실 위험 → 참조 journal. select 접근성/초기 focus 보정. 접속 중 취소의 host prompt도 함께 취소. 재접속 시 TUI 상태 초기화.
- 환경/테스트 보정: WebView2 CDP는 debug 창 설정으로 전달. fixture는 C.UTF-8로 설정(ASCII 셸은 한글 입력을 해석하지 못함). htop 검사는 이전 top 텍스트와 구분되는 footer를 기다린다.
- Windows 빌드/테스트는 같은 EXE를 동시에 사용하지 않는다. Cargo는 현재 PowerShell PATH에 없을 수 있으므로 `$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"`를 먼저 설정한다. `probe:phase1`과 `test:native` wrapper는 자체 처리한다.
- **남은 1.1/1.3 Windows 물리 IME**: 실제 Microsoft IME 조합/확정/받침/삭제·vim·탭 전환·resize를 확인한다. 자동 composition 성공으로 대신 완료 처리하지 않는다.
- **남은 0.4/1.1~1.3 Mac**: Mac 실환경 부재. [Mac 절차](verification/phase-1-macos.md)를 실행하고 Keychain·접속·클립보드·IME 결과를 별도로 남긴다.
- 미지원: host certificate, keyboard-interactive/MFA, SSH agent. 저장소 실패 시 평문 fallback 없음. SFTP·분할·분리 창·터널·모니터링·설치 패키지는 후속 Phase 범위.
- 현재 요청한 Phase 1의 추가 코드 항목은 남아 있지 않다. 환경이 필요한 검증만 대기로 남겼으며, Phase 1 전체 완료로 보고하지 않는다.

## 변경 기록

- 2026-11-04: 단계별 로드맵·작업 ID·이어하기 규칙 작성.
- 2026-11-04: Phase 0 Windows 기반 구성·실제 OpenSSH/SFTP/포워딩 실증·비교 ADR 완료. Mac 0.4 대기.
- 2026-11-04: Phase 1.1~1.3 전체 구현·Windows 자동/네이티브 검증. 물리 Windows IME 및 Mac은 검증 대기. Phase 2는 미착수.

## 2026-11-04 후속 Phase 구현 상세 (진행 중)

- 추가 Rust: `sftp.rs`, `editor.rs`, `windows.rs`, `tunnels.rs`, `settings.rs`, `monitoring.rs`, `encoding.rs`. `ssh.rs`는 인증된 연결의 독립 채널과 창별 출력 Broker를 제공한다. `workspace.rs`와 IPC capability를 연결했다.
- 추가 React: SFTP FilePanel, TunnelPanel, MonitorBar, DetachedWindow, 공통 Icon/ResizeHandle. App은 토큰 기반 시작 화면·패널 조절·분할·설정 입출력으로 개편했다.
- 출력 Broker는 최근 최대 2MiB만 인계 재생하며, 단일 소유 창만 input/resize/ACK를 허용한다. 장시간 출력 전체 기록 저장을 의미하지 않는다.
- 파일 전송은 무변환 스트리밍, 새 파일 전용(no-clobber), 최대 4개 동시 전송. 취소는 원격 staging 삭제를 시도한다. 네트워크 단절로 삭제할 수 없는 staging은 서버에 남을 수 있다.
- 외부 편집은 사용자 전용 ACL/0700 폴더, SHA-256 변경 확인, posix-rename 확장 사용. 미지원 서버에는 다른 이름 저장 제공. 확인~교체 사이 원격 경쟁은 일반 SFTP로 제거할 수 없다. 실패/충돌 복구본을 자동 삭제하지 않는다.
- 터미널 인코딩은 세션별 UTF-8 기본, CP949/EUC-KR, Shift_JIS, GBK, Big5, Windows-1252. 입력 인코딩 불가 문자는 거부. 외부 편집 원본 유지/명시적 변환은 별도 옵션이다. SFTP 이름은 UTF-8만 지원하며 대체문자 감지 시 안전하게 실패한다.
- 마지막 완료 검사(이후 추가 수정은 최종 재검증 필요): `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked`(앱 9+실증 1), `npm run lint`, `npm test`(3), `npm run build`, `npm run test:ui`(6), `npm run probe:phase1` 통과. 인코딩 추가 후 테스트 개수는 증가하며 아직 최종 실행 전이다.

## 최신 사용자 범위 추가 (2026-11-04)

- 남은 Phase 전체 진행을 유지하면서 파일 기본기(복사/이동/붙여넣기/압축/해제/다중 선택), 외부 편집 업로드 확인·자동 업로드·취소, 멀티 입력, FTP와 FTP/SFTP 재개 전송까지 요청됨. roadmap §10에 체크리스트를 추가했다. 아직 이 추가 항목들은 구현 완료가 아니다.
- 현재 진행 중: 네이티브 최종 검사 세션(기존 UI/SSH/SFTP/모니터/분리창). Windows 0.4.0 NSIS 패키지 8.17MiB를 한 번 생성했으나 추가 범위 이후 재빌드 필요. 설치 검증은 아직 미실행. 기존 DachsTerm 설치 레지스트리 항목은 발견되지 않았다.
- 분리창 실제 인계·입출력은 확인됨. close 시 page.evaluate가 정상적으로 끊기는 테스트 harness를 수정했다. Native CP949 검사는 일부 키 타이밍이 흔들려 키 입력 간격과 shell echo/reader ready 동기화를 보강했다. 최종 성공은 실행 결과를 확인하고 기록할 것.
- 현재 SQLite schema2로 올려 인코딩·설정이 추가된 DB를 이전 앱이 쓰지 않게 했다. v1 자동 이행 확인 필요.

## G.1 — 기본 미니게임 4종 (2026-11-04)

- 사용자 요청: MobaXterm처럼 테트리스부터 여러 기본 게임을 앱에 탑재. 이 세션은 G.1만 구현하며 기존 Phase/추가 파일 기능의 완료 상태를 대체하지 않는다.
- 구현: `src/features/games/engines.ts`의 블록 퍼즐·스네이크·2048·지뢰찾기 규칙, `GamesDialog.tsx`와 `games.css`의 선택 화면·조작·점수/기록·도움말. `src/app/App.tsx` 상단 게임 버튼과 lazy import, 닫기 후 포커스 복귀. `Dialog.tsx` 선택적 className, `Icon.tsx` 게임 아이콘.
- 공통 테마 CSS 변수만 사용. 추가 패키지/원격 서비스/IPC/SSH 명령 없음. 게임 JS는 클릭 시 별도 로딩(빌드 기준 약 16KB, gzip 약 5.7KB). 지뢰찾기는 9×9/10개, 첫 칸과 주변 안전. 블록 퍼즐은 7종 묶음·회전·착지 미리보기·줄/레벨, 2048은 달성 후 계속하기 지원.
- 기록: `dachsterm.games.v1.*`에 숫자만 저장. 지뢰찾기는 승리 시 최소 열기 횟수. 저장 실패 시 플레이 유지. 현재 판은 게임 전환/닫기에 종료됨을 화면에 안내한다.
- 타이머/입력: 게임판 포커스에서만 방향키/Space 처리. 모달 밖 터미널은 inert. 실시간 게임은 창 blur/문서 hidden 또는 게임 영역 이탈 시 일시정지, 수동 계속하기. 전환/닫기에 interval/listener 정리. 지뢰찾기는 방향키·Enter·F 및 우클릭, roving tabIndex 제공.
- 검증 완료: `npm run typecheck`, `npm test`(전체 18개, 게임 12개), `npm run lint`, 변경 파일 대상 ESLint/Prettier 검사, `npm run build` 통과. 기존 메인 번들 500KB 경고는 남음.
- UI: `npx playwright test tests/ui/games.spec.ts` 3개 통과(1280/560px, 4종 조작, 일시정지, blur, 저장/새로고침, Esc/포커스 복귀, 터미널 미리보기 격리). `npm run test:ui` 최종 전체 시도는 8개 통과/기존 대체 테마 검사 1개 실패; 해당 검사를 단독 재실행하여 통과. 검사 중 다른 작업의 테마 store 파일 변경이 관찰되어 전체 9개 동시 통과로 기록하지 않는다.
- 수정한 실패: 지뢰찾기 테스트 locator가 바뀐 접근성 이름을 찾지 못하던 오류는 고정 위치 locator로 보정. lazy 모달 종료 후 실행 버튼 포커스 소실은 App의 명시적 복귀로 수정하고 재검증.
- Windows: `npm run tauri -- build --debug --no-bundle` 최종 빌드 통과, `target/debug/daxterm.exe` 생성. 중간에 다른 작업의 `vault.rs` 컴파일 오류로 1회 실패했으나 해당 파일 수정 후 재시도 성공. 이 게임 작업에서 Rust 소스는 수정하지 않았다.
- 실제 WebView2: `node scripts/test-games-native.mjs` 종료 코드 0. 격리된 로컬 데이터로 내장 자산 앱에서 4종 게임·키 조작·일시정지·닫기 포커스 복귀·새로고침 후 기록 유지 통과. 스크린샷 `test-results-native/games.png`의 실제 배치 확인. 테스트 소유 앱은 종료하고 임시 데이터는 실패 진단용으로 유지한다.
- 미검증: Mac 실기기 부재로 macOS 게임 UI 검증 대기. SSH/SFTP 실접속 회귀와 설치 패키지 재생성은 이 게임 작업에서 수행하지 않았으며 기존 Phase 2~5 대기 기록을 유지한다.
- 남은 G.1 항목: Mac 실기기 UI 검증만 대기. 다음 첫 행동은 Mac에서 G.1 키 조작/일시정지/기록/닫기 동작을 실제 앱에서 확인하는 것. 설치 패키지를 만들 때 최종 게임 자산을 포함해 다시 빌드한다(기존 5.3 작업). 기존 Phase 2~5/roadmap §10의 다른 요청은 해당 작업 기록을 따라 계속한다.

## 최신 검증 및 마스터 패스워드/멀티 입력 (2026-11-04)

- 이전 실행 `npm run test:native` 전체 종료 코드 0: 제품 엔진, CP949 실제 송수신, SFTP, 모니터, 2×2 분할, 분리 창 인계/종료까지 모두 통과. 첫 실행의 WebView2 환경 불일치·tokio 런타임 문제와 CP949 입력 타이밍을 수정했다.
- 추가 구현: `vault.rs`, `VaultDialog.tsx`, SessionForm/App 연결. 선택적 마스터 패스워드 Argon2id(32MiB/3회/1lane) + AES-256-GCM, OS credential ciphertext, SQLite에는 감싼 키와 salt만 저장. 마스터 초기 설정 시 copy-on-write OS 항목 + DB 원자적 참조 전환 + 이전 항목 GC. 5분 해제/수동 잠금, 재시작 잠김, 매번 재인증하는 암호 보기/30초·창 포커스 상실 시 숨김. SQLite schema3.
- `cargo test --workspace --locked`: 앱 13개 + 실증기 1개 통과(마스터 암호/nonce/변조/AAD/만료 테스트 포함). `npm run typecheck`, `npm run lint` 통과. 이후 멀티 입력 추가 및 최신 테스트는 다시 확인 필요.
- `broadcast.rs`, `BroadcastControl.tsx`: 연결 ID를 명시적으로 선택한 그룹, 분리 창 공통 적용, 대상 종료 시 전체 그룹 해제, 새 연결 ID 자동 포함 금지, 모든 대상 encoding/queue reservation 선검사. 실제 두 대상만 입력 및 종료 시 해제 검사를 native harness에 추가.
- 현재 `npm run test:native` 재실행 중. 마스터 이행 DB rollback/OS 잔여 항목 정리와 UI 설정/보기/잠금/변경/재시작 연결 검증을 추가했다. 아직 이 추가 검사 성공으로 기록하지 않는다.
- 남은 확장: 외부 편집 ask/auto/manual 업로드 및 active cancel, 파일창 기본기/압축, FTP/FTPS와 FTP/SFTP 재개. 기존 Mac/물리 IME/설치 검증 대기는 유지.

## T.1 — 기본 화면 보존 및 테마 12종 (2026-11-04)

- 요청: 처음부터 테마 적용이 가능하게 되었는지 점검하고 현재 모습을 기본으로 화이트/다크/레트로/터미널 등 유명 테마를 참고해 추가. 기존 단일 테마 방침은 roadmap §2.6으로 확장하고 AGENTS/README에 반영했다.
- 점검 결과: 공통 계약/레지스트리/CSS·xterm·차트 어댑터/터미널 테마 갱신은 있었지만 테마가 하나뿐이고 설정의 선택/쓰기 경로가 없었다.
- 구현: `src/themes/{contract,registry,store,useTheme,ThemePicker}.ts(x)`, `picker.css`, `presets/{light,create,collection}.ts`, `adapters/css.ts`, `src/main.tsx`, `src/app/App.tsx`, `src/components/Dialog.tsx`. Classic(기존 ID 유지), GitHub White/Dark, Dracula, Nord, Catppuccin Mocha, Gruvbox Light/Dark, Solarized Light/Dark, Terminal Green/Amber. 미리보기 카드·즉시 반영·자동 저장·창 간 storage 동기화·시작 전 적용·ID 폴백·저장 실패 표시·기본 컨트롤 color-scheme 제공. 열린 xterm은 재생성하지 않는다.
- 기존 크림색 표면/마스코트/배치는 유지. 보조 텍스트만 선택 배경 대비 4.5:1을 위해 #606970 → #5F686F 미세 조정. 추가 테마는 공식 팔레트를 참고한 DachsTerm 변형이며 대비 보정과 출처는 `docs/verification/themes.md`에 기록. 서버 truecolor는 바꾸지 않는다.
- 테스트 파일: `src/themes/theme.test.ts`, `tests/ui/{themes,layout}.spec.ts`, `scripts/test-themes-native.mjs`. Dialog는 선택한 radio 우선 포커스/닫기 후 실행 버튼 복귀 보정.
- 검증 완료: `npm test` 29개(테마 14개), `npm run typecheck`, `npm run lint`, 변경 파일 Prettier 검사, `npm run build` 통과. 기존 500KB 번들 경고 유지. `npm run test:ui` 전체 15개 통과(테마/레이아웃/게임). 기존 G.1 기록의 단독 성공/전체 실행 중 변동과 별개로 이 시점의 전체 결과다.
- Windows: `npm run tauri -- build --debug --no-bundle` 통과. `target/debug/daxterm.exe` 내장 자산 갱신. `node scripts/test-themes-native.mjs` 종료 코드 0: 실제 WebView2에서 12개 전환/기존 xterm 유지·배경 반영/Escape 포커스/전체 앱 종료 후 테마 복원 통과. `test-results-native/themes.png`, `theme-<id>.png` 생성, 선택창과 초록 터미널 시각 확인. 테스트 소유 앱 종료, 격리된 데이터만 진단용 유지.
- 브라우저 여러 페이지 동기화/새 창/재로드/삭제·알 수 없는 ID/저장 실패, 1280·560·360px 키보드·넘침 검증 통과. 실제 네이티브 SSH 분리 창 검증으로 대체하지 않는다.
- 미검증: 실제 SSH 연결을 유지한 테마 전환/분리 창/실수집 차트(3.2/5.1), macOS 테마·글꼴·동기화(5.2), 최종 설치 패키지 재생성/설치(5.3). 이 테마 작업에서 Rust 코드는 수정하지 않았고 SSH/파일 엔진 회귀를 새로 실행하지 않았다. 기존 미완료 Phase/추가 사용자 요청 상태를 완료로 바꾸지 않는다.
- 남은 ID: **T.1 네이티브 SSH 분리 창·Mac 검증**, 기존 **3.2/5.1/5.2/5.3** 및 다른 작업 기록의 미완료 항목. 다음 첫 행동: Windows 실제 SSH를 열고 분리 창을 만든 뒤 설정에서 테마를 전환하면서 양 창의 입력·출력 유지와 차트 색상 반영 확인 → Mac에서 동일 검증 → 최종 패키지에 새 자산 포함.

## 파일 기본기 및 재개 전송 확대 (2026-11-04, 계속 진행 중)

- 마스터 보관함 및 멀티 입력 native 재검증 종료 코드 0. 설정/이행/잘못된 암호 거부/보기와 숨김/변경/재시작 후 해제 및 실제 SSH 접속, 선택된 2개 연결에만 입력/대상 종료 시 그룹 해제 통과. 새 master 변경은 데이터 키도 교체하고 이전 OS 참조를 GC한다.
- `editor.rs`/FilePanel: ask 기본·auto·manual, 저장 확인/취소·보존, 진행 중 업로드 취소, 편집기 실행 파일 picker. 확인/수동 모드에서 원격 불변 및 승인/자동 전송 실제 엔진 통과. Python helper를 이용한 실제 GUI 외부 편집기는 별도 검증 필요.
- `file_ops.rs`: 다중 파일/폴더 복사, 잘라내기·붙여넣기, 이동, 재귀 삭제, 새 파일, 다중 chmod. 메모리 클립보드(창 공유), Ctrl/Cmd+C/X/V/A, F2/Delete/F5, 컨텍스트 메뉴, 이름 검색/정렬. 심볼릭 링크 복사는 지원하지 않고 따라가지 않는다.
- `archive.rs`/`archive_helper.py`: Linux SSH/Python 3 기반 ZIP/TAR/TAR.GZ 압축·해제, 새 대상만, renameat2 NOREPLACE, 링크/장치/상위경로/절대경로/중복 거부, 항목·해제 크기 제한, ZIP CP949/CP932/GBK/Big5 파일명 옵션(Python3.11+). `npm run probe:phase1` 실제 서버 복사/폴더 복사/기존 대상 거부/하위 경로 거부/3형식 왕복/위험 ZIP 거부 통과.
- SFTP 전송을 일시 중지+부분 파일 보존으로 변경. 재개 시 원본 size/mtime 및 부분 파일 전체 바이트 비교. SQLite에 복구 계획 저장, 재시작·동일 프로필/대상 재연결, 부분 파일 명시적 폐기. 128MiB 업로드/다운로드 중지·재개/부분 내용 불일치 거부/바이트 일치/최종 staging 정리 실제 probe 통과. 전송 계획 재시작 복구 검증은 아직 추가 필요.
- 현재 FTP/명시적 FTPS 통합 진행 중: suppaftp12.2.1(로그 비활성), OS TLS/추가 CA·호스트명 검증, UTF8 및 레거시 파일명 인코딩, Binary/PASV peer 고정. 세션 protocol/TLS CA 필드, FTP 전용 파일 화면, 공유 전송 계획에 REST 재개 연결 중. FTP 실제 fixture는 아직 미실행이며 완료 아님.
- 최신 FTP/재개 변경 이후 전체 native/build/clippy/UI 회귀 및 최종 설치 패키지 재생성 필요. Mac 실기기/물리 Windows IME 대기 유지. 이전0.4.0 패키지는 최신 변경을 포함하지 않는다.

## FTP/FTPS 실제 검증 및 종료 처리 (2026-11-04)

- `npm run probe:ftp` 종료 코드 0: FTP UTF8/명시적 FTPS UTF8/FTP CP949 각각 32MiB 업로드·다운로드 중지와 REST 재개, SQLite 복구 계획 로딩, 최종 바이트 일치, 한글/공백 이름 및 복사·이동·삭제. 임시 서버/자격 증명/키는 테스트 후 제거.
- FTPS를 Rustls+OS CA로 구현. 추가 PEM CA를 합치며 hostname/인증서 검증을 유지하고 평문 fallback 없음. 미신뢰 CA 거부 검증. native TLS의 Windows 종료 지연 문제 해결.
- FTP 취소 시 TLS close_notify와 완료 응답을 기다려 서버 파일 핸들을 닫은 뒤 paused 상태로 전환. 종료 응답은 최대20초, 부분 파일 보존. 갑작스러운 단절은 별도 재접속/검증 필요.
- 목록·존재 확인은 4MiB/20,000개 상한과 선택 인코딩의 엄격한 경로 검증. 파일 패널 영역에만 OS 드롭을 적용하도록 ref 연결 수정.
- 0.5.0으로 버전을 정렬했으며 `npm run test:native` 최신 빌드/통합 검사 진행 중. 아직 이 새 실행의 성공으로 기록하지 않는다.

## 최종 0.5.0 Windows 결과 (2026-11-04)

- 최종 명령: `npm run test:native` 종료0, `node scripts/run-ftp.mjs --native` 종료0, `cargo test --workspace --locked` 앱14+실증1 통과, `cargo clippy --workspace --all-targets --locked -- -D warnings`/`cargo fmt --all --check` 종료0. 프런트엔드29개·UI15개 통과, 최종 typecheck는 Tauri beforeBuild `tsc -b` 포함. `npm run lint`, `npm run format:check` 통과.
- `npm run tauri -- build --bundles nsis` 종료0. 최신 installer에 `./scripts/test-installer.ps1` 종료0: UUID 경로 설치, registry/PE version0.5.0, 실제 창 초기화·정상 종료·제거. 기존 설치가 있으면 테스트를 거부한다. 설치 EXE SHA256 `C60162F5BA7E4B9F375455626AEE124A1963B8BF4B8599505F79D0EE3AE32FFF`.
- 주요 파일: `src-tauri/src/{vault,broadcast,ftp,sftp,file_ops,archive,editor,workspace,storage,ssh,windows,tunnels,monitoring,settings}.rs`, `archive_helper.py`, `src/features/{sessions,sftp,terminal,monitoring,tunnels}`, `src/app/{App.tsx,styles.css}`, IPC·capability·Cargo/package lock. 게임/12개 테마의 다른 작업 변경을 보존했다.
- 추가 보완: 비밀번호 검증 중 blur가 발생하면 늦게 도착한 복호화 결과를 표시하지 않는 epoch guard(native 검증). 재개 계획 저장 실패 시 running 대신 paused 복원. FTP 파일명 인코딩까지 대상 서명에 포함해 잘못된 경로 재개 방지.
- 최종 native: 권한640 반영, ZIP 압축/해제, 외부 Node 실행 파일 저장→확인·취소·보존→재시도·자동 업로드, CP949 정확한 바이트, 멀티 입력·분할·분리 창, 테마 동기화·연결 유지, 마스터 이행/보기/변경/잠금/재시작. FTP/FTPS 폼·파일창·컨텍스트 복사·다중 삭제·바이너리 업로드·800px 통과.
- 시각 확인: `test-results-native/files-editor.png`, `ftps-files.png`, `detached-window.png`, `workspace-monitoring.png`. 파일 선택 영역 높이 고정으로 더블클릭 위치 유지, FTP 전체 너비 반영. 암호 표시 화면은 캡처하지 않는다.
- 패키지 경고: 메인 JS 약693KB/193.8KB gzip으로 Vite500KB 경고가 남지만 빌드 실패는 아니다. 공개 코드 서명 없음.
- 남은 작업 및 다음 행동은 문서 맨 위가 정본이다. 이전 기록의 진행 중·미실행은 해당 시점 이력이다. Mac·물리 IME·OS 드롭/파일 선택·GUI 편집기 수동·절전/장시간 결과는 없고 자동 검사로 대신 완료 처리하지 않았다.

## G.2 — 게임 작업 영역 통합 (2026-11-05)

- 사용자 요청: 별도 팝업을 없애고 사이드바에서 게임을 선택해 터미널 내부 작업 영역에서 실행. 게임 전용 장식을 줄인다. 기존 G.1의 상단 버튼/모달/게임 전환 시 판 초기화 계약은 이 기록과 roadmap §11로 대체한다.
- 구현 파일: `src/app/App.tsx`, `src/app/styles.css`, `src/features/games/{catalog.ts,GamePane.tsx,games.css}`. `GamesDialog.tsx`는 `GamePane.tsx`로 교체. 규칙 엔진 변경 없음. 사이드바 기본 접힌 목록, 게임별 중복 없는 작업 탭, 단색 터미널 토큰/고정폭 글꼴, 게임 탭 간 현재 판 보존, 숨김/포커스 이탈 시 일시정지, Esc 작업 복귀, 탭 닫기 시 판 종료. 숨긴 SSH/xterm은 마운트를 유지하고 inert/active로 입력을 격리한다.
- 검증 파일: `tests/ui/games.spec.ts`, `scripts/test-games-native.mjs`, `scripts/test-native.mjs`의 `embedded games preserve SSH` 단계. 실제 SSH가 게임 중 출력한 텍스트·동일 연결 ID·게임 키가 원격 read 입력으로 전달되지 않음을 검사한다. `README.md`와 roadmap §11 사용법 갱신.
- 현재 통과: `npm run build`(tsc 포함), `npm test` 29개, `npm run lint`, 초기 `npm run format:check`, `npm run test:ui` 16개. 이후 선택한 게임 탭 자동 스크롤 변경으로 게임 UI 4개 재실행 통과, 다크 테마/판 보존 추가 1개 통과. 360/560/1280px 넘침·키 조작·최고 기록·현재 판 보존·숨긴 타이머 정지·닫기·기존 xterm 인스턴스 유지 포함. `cargo fmt --all --check` 통과. 500KB 번들 경고는 기존 제한.
- 병행 U.1/W 작업이 동일 워크스페이스를 수정 중. 이후 전체 format 검사는 당시 `App.tsx`, `ToolbarMenu.tsx`, `session.ts` 형식 경고로 실패. 게임 파일/게임 검증 스크립트 대상 Prettier 검사는 통과. 병행 작업의 코드/문서 변경을 유지한다. 최신 보기 메뉴에 게임 UI 테스트의 미리보기 진입 경로도 맞췄다. 이후 `npx playwright test tests/ui/games.spec.ts` 최신 게임 UI 5개 모두 통과했다.
- Windows: 첫 내장 자산 디버그 빌드 통과. 최신 병행 변경 재빌드에서 `maintenance.rs`의 SQLite COUNT를 usize로 읽는 FromSql 오류 2건을 발견해 Diagnostics profiles/groups 필드만 i64로 보정했다(직렬화 숫자 계약 유지). 이후 `npm run tauri -- build --debug --no-bundle` 종료 0, `node scripts/test-games-native.mjs` 종료 0: 실제 WebView2 4종 플레이·키보드·일시정지·Esc 작업 복귀/포커스·판 유지·탭 닫기·기록 재로드 통과. `test-results-native/games.png` 실제 화면 확인. 테스트 소유 앱 종료. 실제 SSH 결과는 다음 항목 참조.
- 실제 SSH: `node scripts/run-phase1.mjs --native --skip-app-build` 첫 실행은 Docker exec 오류로 fixture 준비 중 종료 1(검사 미실행), 재실행은 실제 OpenSSH 인증 후 `embedded games preserve SSH` 통과. 게임 중 백그라운드 서버 출력, 동일 연결 ID, 방향키/Space가 원격 read 입력에 섞이지 않음, 복귀 후 명령 실행을 확인. `test-results-native/games-with-ssh.png` 확인. 5개 연결/개별 종료·멀티 입력·SFTP/모니터링·파일/편집기·CP949도 통과했으나 **뒤의 split layout 단계에서 기대 출력 불일치로 전체 명령 종료 1**. `failure.png`에서 첫 pane에 `sprintf: command not found`가 보임. 분할 실패 원인은 이번 G.2에서 확정하지 않으며 전체 native 성공으로 보고하지 않는다. 테스트 앱·격리된 자격 증명/데이터 및 전용 fixture 정리 완료.
- 최종 산출물: `target/debug/daxterm.exe` 내장 자산 개발 빌드. 기존 release/NSIS는 이번 G.2를 포함하도록 재생성하지 않았다. 게임 소스의 규칙 엔진·추가 IPC/의존성 변화 없음. 빌드를 막았던 진단 COUNT 타입만 선행 보정했다.
- 미검증/남은 ID: **G.2 Mac 실기기 UI 검증**, **W/U.1/5.1 전체 native split layout 실패 재현**, **5.3 최신 설치 패키지 재생성**. Mac 환경 부재 및 요청 범위에 따른 미실행으로 기록한다. 다음 첫 행동: Windows 회귀 담당은 다른 네이티브 자동화와 실행 앱을 겹치지 않게 한 뒤 split layout의 셸 입력/포커스와 기대 출력을 재현·해결한다. G.2 자체 후속은 Mac에서 탭/포커스/키 조작을 검증하고 최종 패키지에 새 자산을 포함하는 것이다.


## U.1 — 로컬 터미널·자동 탐색·상단 메뉴/사이드바 (2026-11-05)

- 요청: 서버 등록 없이 로컬 터미널 열기, WSL 자동 목록, Mac 기본 터미널, 상단 메뉴·사이드바의 편의/접근성 개선. roadmap §12에 별도 범위로 반영. G.2 및 병행 W.1~W.4 변경을 보존했다.
- 구현 파일: `src-tauri/src/local.rs`, `lib.rs`, `build.rs`, capability/자동 생성 권한, `Cargo.toml`/`Cargo.lock`(portable-pty0.9.0). Windows ConPTY·Unix PTY. Windows PowerShell/명령 프롬프트/표준 Program Files 경로의 PowerShell7, `wsl --list --quiet` UTF16/UTF8 목록(5초 제한). WSL 실행 인자는 배열로 전달하고 선택한 배포판 홈에서 기본 사용자로 실행. macOS는 portable-pty의 SHELL/계정 DB 조회로 기본 로그인 셸을 선택한다. 탐색만 자동, 실행/설치/WSL 기본값 변경은 하지 않는다.
- 자원 계약: 네이티브에서 발견한 ID만 열기, UUID/크기/32개 상한 검증, 입력16개 큐/메시지16KiB, 출력32KiB 한 프레임 ACK. reader/writer/child wait 분리, ConPTY 닫기 중 남은 출력을 비우고 ACK 대기를 깨움. 탭/앱 종료 및 자연 exit 정리. 임의 실행 파일·인자 입력 IPC와 인증정보 저장 없음. 사용자 셸 자체의 이력 정책은 변경하지 않는다.
- 프런트: `src/features/terminal/session.ts`의 로컬 transport 분기와 기존 xterm/검색/클립보드/테마 재사용. `App.tsx`, `styles.css`, `ToolbarMenu.tsx`, `BroadcastControl.tsx`: 상단 로컬 선택기·보기/도구 메뉴, 사이드바 로컬 목록·새로고침·저장된 연결 분리, 사이드바 접기 저장, Ctrl/Cmd+Shift+L/N/B/F, 메뉴 Escape/바깥 클릭·단축키 도움말, 탭 방향키/Home/End. 메뉴를 접어도 멀티 입력 활성 표시 유지. 분할 상태 새 연결을 보이는 첫 슬롯에 배치. 로컬 탭에서 SFTP/모니터/SSH 분리 창을 배제하고 멀티 입력 대상은 기존 SSH만 유지.
- 새 검증: `tests/ui/navigation.spec.ts`, `scripts/test-local-native.mjs`. 기존 `tests/ui/{layout,themes,games}.spec.ts`, `scripts/{test-native,test-themes-native}.mjs`의 미리보기/멀티 입력 진입을 보기/도구 메뉴로 갱신. `README.md`에 사용법/제한/검사 명령 추가.
- 확인한 결과: `npm run typecheck`, `npm run lint`, `npm test`29개, `npm run test:ui`20개, `npm run tauri -- build --debug --no-bundle`(tsc/Vite 포함), `cargo clippy -p dachsterm --all-targets --locked -- -D warnings`, `cargo fmt --all --check`, 최종 `cargo test -p dachsterm --lib --locked`23개(병행 W 추가 검사 포함) 통과. 변경 파일 대상 Prettier 통과. 전체 `npm run format:check`는 병행 작업의 `scripts/generate-notices.mjs` 형식 경고로 1회 실패했으며 U.1 파일의 오류는 아니었다. 기존 메인 번들500KB 경고 유지.
- 실제 Windows: `node scripts/test-local-native.mjs` 첫 성공에서 Windows PowerShell/명령 프롬프트/Ubuntu/docker-desktop 자동 목록, PowerShell 한글 출력·입출력, 실제 PTY 폭123→82, 분할·개별 종료/재접속·다른 탭 유지·PID 종료, Ubuntu WSL 명령 실행/자연 exit, 사이드바 단축키 통과. `test-results-native/local-terminal.png` 시각 확인. 최종 재빌드 후 동일 명령 종료0: 추가500줄 연속 출력 후 완료 마커, 살아 있는 PowerShell을 둔 앱 정상 종료(exit0) 및 PID 소멸도 통과. `test-results-native/local-wsl.png`는 실제 Ubuntu 결과. 테스트 소유 앱과 셸은 종료됐다.
- 실제 SSH 회귀: `node scripts/run-phase1.mjs --reuse-build --native` 종료0. 최종 U.1 빌드(메뉴 활성 표시·분할 새 탭 배치·셸 종료 보강 포함)로 다시 실행한 마지막 검사도 전체 종료0. 현재 내장 자산 앱으로 실제 OpenSSH 인증/호스트키·5개 탭·게임 입력 격리·멀티 입력·SFTP/편집/압축·CP949·2×2·TUI/복사·독립 창·테마 동기화·KeepAlive 재접속·마스터/재시작/DB·변경 키 차단 전체 통과. 이 명령은 Rust probe 실행을 생략하므로 별도 엔진 probe 재실행 성공으로 기록하지 않는다. G.2 기록의 과거 split 입력 실패는 이번 전체 실행에서는 재현되지 않았다. fixture와 테스트 앱은 정리됐다.
- 중간 실패/보정: 병행 capability 갱신 중 `allow-recovery-list` 미생성으로 build1회 실패→최신 파일 재시도 성공. Clippy의 고정크기 chunks 검사→as_chunks로 수정. Rust 테스트 링크 PDB 손상→해당 테스트 PDB만 제거 후 재실행22개 통과. UI worker1회 비정상 종료→해당 검사 및 최종 전체20개 통과. 로컬 harness의 CDP 긴 키입력 timeout/insertText 미전달은 실제 paste 이벤트+Enter·셸 prompt 대기로 보정, resize의 이전 응답 재사용은 구별되는 결과 마커로 수정. 실패를 제품 성공으로 기록하지 않는다.
- 남은 ID: **U.1 Mac 기본 셸/PTY/IME/종료 실기기 검증**, 표준 경로 PowerShell7 실실행(현재 머신 미설치), **5.3 최신 NSIS 재생성/설치**. 물리 Windows IME, 장시간/절전, 기존 W/5.1~5.3 대기는 유지. 로컬 파일 탐색기·로컬 독립 창은 이번 초기 범위에 없음. 기존 release installer는 U.1을 포함한다고 보장하지 않는다.
- 다음 첫 행동: 최신 `target/debug/daxterm.exe`로 로컬/WSL 동작 사용 가능. 배포 담당은 병행 변경이 끝난 뒤 NSIS를 다시 생성·설치 검증하고, Mac이 제공되면 계정 기본 셸/한글/resize/exit/앱 종료를 실기기에서 검증한다.

## W.1~W.4 — Windows 출시 품질 보완 (2026-11-05 최종)

- 요청: Mac을 후순위로 두고 Windows에서 가능한 보완·검증을 계속 수행하며 실제 수동 항목을 분리. W.1/W.2 구현 및 W.3/W.4의 실행 가능한 자동 검사를 마쳤다. 공개 안정판/Phase5 전체 완료는 아니다.
- 데이터 보호: `src-tauri/src/{storage,commands,settings,maintenance,editor,lib}.rs`, `build.rs`, capabilities/permissions. DB quick_check·스키마 트랜잭션·삭제와 credential journal 원자성, OS 파일 잠금, 변경 전 최대10개 설정 복구본, 원자적 파일 교체·읽기 크기 제한, 편집 복구 manifest 보호. 손상 DB/미래 스키마를 자동 초기화하지 않는다. 복구는 새 ID·터널 자동 시작 해제·암호 재입력 원칙이다.
- 사용자 화면: `src/features/settings/MaintenancePanel.tsx`, `src/app/App.tsx`, IPC. 복구 목록/생성/가져오기와 허용 필드만 담는 진단 JSON 저장 추가. `src/features/terminal/TerminalPane.tsx`의 보임/입력 대상 상태를 분리해 2×2 화면의 포커스 경쟁과 검색 컨트롤 포커스 탈취를 수정했다.
- 보안/배포: `src-tauri/src/{ssh,ftp}.rs`, `Cargo.toml`/`Cargo.lock`, `package.json`/lock, `tauri.conf.json`, `scripts/{audit-windows,generate-notices,run-phase1,run-ftp,test-native,test-maintenance-native}.mjs`, `scripts/{verify-windows,test-installer}.ps1`, `.github/workflows/windows.yml`, `licenses/`. minimatch 수정, rustls-pemfile 제거, RSA 개인키 인증 차단. Windows 426개 구성요소 라이선스 원문 누락0 및 설치본 포함. 버전0.5.1 정렬. CI 정의는 추가했으나 Git 원격이 없어 원격 실행은 미검증이다.
- 정적/단위/UI: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`29개, `npm run build`, `npm run test:ui -- --workers=2`20개 통과. `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked` 앱23개+실증1개 통과. 마지막 보고서 경로 수정 후 format 검사도 통과. 기존 메인 번들 크기 경고는 남는다.
- 실제 통합: `CARGO_TARGET_DIR=target/windows-hardening` 및 동일 앱의 `DACHSTERM_TEST_BINARY`로 격리. `node scripts/test-maintenance-native.mjs` 종료0(복구 생성/삭제/새 ID 복원/경로 거부/재시작/560px), `node scripts/run-ftp.mjs --reuse-build --native` 종료0(FTP/FTPS/CP949 실제 엔진+WebView2), `node scripts/run-phase1.mjs --native --skip-app-build` 최종 종료0(인증/호스트키·5연결·게임 입력 격리·멀티 입력·파일/편집/압축·2×2·TUI/클립보드·분리 창/테마·재접속·보관함/재시작/변경 키 거부). 복구 화면 PNG도 시각 확인했다. 이 native 명령은 엔진 probe를 생략하므로 엔진 결과는 별도 stress 기록을 따른다.
- SSH 반복: `node scripts/run-phase1.mjs --stress-minutes 5` 실제 엔진 300초/322회 통과 기록이 있다. 각 회1MiB 출력/정상 종료 및 자원 상한을 검사했다. Playwright가 `test-results/`를 정리하므로 지속 보존 보고서를 `target/verification/`으로 이동하고 5분 검사를 다시 실행했다. 최종 보고서 수치는 아래 추가 기록을 따른다. 24시간 WebView2 실사용·절전 검사를 대체하지 않는다.
- 실패와 보정: 대기 연결의 미처리 ACK/종료 후 남은 이벤트 ACK는 probe 하네스 정리 순서 수정. 다섯 탭 검사는 새 활성 연결을 기다리도록 보정. split 실패는 제품 포커스 경쟁을 수정한 뒤 전체 회귀 통과. 초기 UI4-worker timeout은 2-worker 전체 실행 통과. 실행 중 기본 debug EXE 잠금은 별도 target으로 분리했다. 실패를 성공으로 집계하지 않았다.
- 최종 설치본: `target/release/bundle/nsis/DaxTerm_0.5.1_x64-setup.exe`, 9,709,714바이트, SHA256 `CAAE2072D5A89E0633FFF23C32B2792B17A0138792DE15C27198C11DDBA10EBC`. 최신 `npm run tauri -- build --bundles nsis` 산출물에 `./scripts/test-installer.ps1 -Version 0.5.1 -PreviousVersion 0.5.0 -Reinstall` 종료0. 설치본 교체/일반 파일 보존/재설치/고지 포함/실제 창 초기화/정상 종료/제거 확인. 사용자 데이터·보관함 전체 이행은 별도 대기. `NotSigned`, 동봉 manifest `publicReleaseApproved:false`.
- 사용자 기동 콘솔 질문: `src-tauri/src/main.rs`는 debug에 콘솔을 허용하고 release는 GUI subsystem을 사용한다. 실제 EXE PE 헤더도 debug3(Console)/release2(GUI)로 확인. debug EXE 직접 실행의 검은 창은 이 설정 때문이다. 배포 설치본은 release 바이너리다.
- 보안 게이트: `npm audit --audit-level=low`0건. `cargo audit --deny warnings` 취약점1/경고5로 실패. `node scripts/audit-windows.mjs` Windows RSA 취약점1건으로 종료1, 경고5개는 Windows 그래프 밖이며 전체 보고서에 보존. RSA 개인키 경로 차단은 완화이며 라이브러리 수정이 아니다. `verify-windows.ps1` 전체 게이트는 이 문제로 실패 상태다. 무시 설정으로 우회하지 않았다.
- 남은 작업 ID/미검증 이유: **W.3** RSA 의존성 수정/대체 검증, 인증서·배포 주체·주소/업데이트/앱 라이선스 결정 미제공. **W.4/5.1 M1~M10** 실제 물리 IME/OS 드롭·대화상자/GUI 편집기/절전·네트워크 변경/24시간/강제 종료/혼합 DPI·Narrator/실서버 호환성. **5.3** 깨끗한 PC 및 실제 사용자 데이터 업그레이드. **5.2/Mac** 사용자 요청으로 보류. 모든 절차/합격 기준은 `docs/verification/windows-release-checklist.md`, 상세 구현·복구 절차는 `docs/verification/windows-hardening.md`.
- 다음 첫 행동: 0.5.1 설치본으로 M1→M2→M3 결과를 기록하고 별도 테스트 PC에서 M6을 시작한다. 의존성 보안 게이트는 수정된 업스트림/검증된 대체 경로 확보 후 다시 실행한다. 코드 수정 없이 기존 통과 검사를 반복하지 않는다.
- 최종 stress 재실행 결과: `node scripts/run-phase1.mjs --stress-minutes 5` wrapper 종료0을 프로세스 종료 코드로 확인. `target/verification/ssh-stress.json`: completed=true, 300초/329회/회당1MiB. 첫 샘플 private6,164,480바이트/핸들194, 마지막10,473,472바이트/193, 최대10,473,472바이트/197. 설정한 메모리/핸들 상한 통과. 최종 installer manifest SHA256 일치 확인, 테스트 DachsTerm 프로세스 없음. 지속 보고서는 UI 테스트 정리와 분리한 `target/verification/`에 보존한다.

## U.2 — 통합 UI와 터미널 중심 작업 공간 (2026-11-05, 구현·Windows 자동 검증 완료)

- 요청: 좌우 사이드바를 왼쪽으로 통합, 버튼 크기·정렬·스크롤 개선. 추가 지시로 터미널을 주인공으로 더 컴팩트한 도구, 마우스 리사이즈/접기, 단일·분할 전체화면·선택 터미널 확대, 분할과 멀티 입력 통합(개별/모든 창/선택한 창).
- 구현: `src/app/{App.tsx,DetachedWindow.tsx,workspace.css,useFullscreen.ts}`, `src/main.tsx`, `src/features/terminal/{TerminalPane,BroadcastControl}.tsx`, `src/features/sftp/FilePanel.tsx`, `src-tauri/src/{local,broadcast,commands}.rs`, `src-tauri/capabilities/main.json`. 기존 테마·마스코트/사용자 데이터 유지. 새로운 권한은 네이티브 전체화면 제어. 메인 사이드바는 연결/파일 탭, 한 스크롤의 연결 목록과 고정 검색, 280~420px 마우스/키보드 너비 조절, 좁은 창 오버레이와 배경 inert. 독립 SSH 창의 파일 패널도 왼쪽. FTP/FTPS 중앙 파일 탭 유지.
- 터미널: 검색/복사/붙여넣기 32px 정렬, 글꼴/기록은 설정으로 이동. 상단 52px, 탭36px, 분할 도구28px. F11 전체화면, Ctrl/Cmd+Shift+Enter 선택 창 확대/복원. xterm을 재마운트하지 않으며 종료/위험 붙여넣기 확인 유지. 분할 영역720px 이하에서는 세로로 배열, 하나 남으면 빈 분할 칸을 없앤다.
- 입력 그룹: 기본 창에서는 현재 분할에 포함된 연결만 후보. 입력 옵션을 분할 도구에 배치하고 상단 도구 메뉴의 별도 멀티 입력 제거. 개별/모든 창/선택한 창, 대상별 표시/즉시 중지. 로컬 셸·WSL·SSH를 함께 선택 가능하도록 공통 bounded Tokio 입력 큐로 전환하고 모든 대상 queue reserve 후 전송한다. 대상 종료/재접속 및 배치 변경 때 그룹 해제, 새 연결 자동 추가 없음. 로컬 입력 source는 main 창으로 제한한다.
- 현재 확인: 초기 U.2(전체화면/입력 통합 추가 전) `npm run test:ui`25개, `npm test`29개, lint/format/build 및 Tauri debug 빌드 통과. 이후 컨테이너 기준 분할 보완 뒤 `node scripts/test-local-native.mjs` 종료0: PowerShell/명령 프롬프트/Ubuntu 실실행·한글·resize·분할/재접속·PID종료·500줄 출력·앱 종료, 32px 도구 정렬·파일보기 전환 시 xterm/연결 유지·설정 포커스 복귀. 해당 시점 스크린샷 `test-results-native/unified-local.png`.
- 중간 실패와 보정: 800px 예전 오른쪽 패널 CSS가 resize handle을 숨겨 중앙을4px로 좁힘 → 오래된 규칙 제거. 900px 좌우 분할 PowerShell 입력 응답 실패3회 → 작업영역720px 이하 세로 배치와 단일 잔여칸 확장 후 전체 로컬 검사 통과. 초기 external editor 폼 실패 → 선택 패널 높이 변화로 더블클릭 위치가 이동할 수 있어 고정112px로 보정. 이후 파일 작업 버튼4열·경로 따라가기·전송 트레이를 더 컴팩트하게 정렬. 3개 분할의 마지막 창은 아래 행 전체를 사용한다.
- 출력/하네스 보정: `TerminalPane.tsx`의 fit 시 하단을 보던 뷰포트는 하단을 유지하고, `session.ts`는 값이 달라질 때만 글꼴/기록 설정을 적용한다. Native 검사에서 xterm 접근성 트리는 현재 화면만 나타내므로 실제 검색 UI로 버퍼의 결과를 찾아 검증한다. ASCII 명령은 실제 paste 이벤트와 Enter를 사용하며 입력 대상 dialog가 닫힌 뒤 진행한다. 새 사이드바 tab과 터미널 tab을 구분하고 독립 창의 pane 선택자도 맞췄다. 초기 CP949/분할/독립 창 검사 실패를 최종 성공으로 덮어 쓰지 않으며, 아래 최종 재실행에서 해당 단계까지 모두 통과했다.
- 검증 파일: `tests/ui/{workspace,navigation,games}.spec.ts`, `scripts/{test-workspace-native,test-local-native,test-native}.mjs`, `broadcast.rs`의 역압 시 부분 전송 방지 단위 검사. 최종 `npm run test:ui -- --workers=2`26개, `npm test`32개, `npm run lint`, `npm run format:check`, `npm run tauri -- build --debug --no-bundle`, `npm run tauri -- build --no-bundle` 통과. TypeScript 검사는 빌드에 포함. Rust lib24개, `cargo check`, `cargo clippy -p dachsterm --lib --bin dachsterm --locked -- -D warnings` 통과 기록이 있다. 최종 U.2 Rust 3개 파일 rustfmt 검사 통과. 전체 `cargo fmt --all --check`는 병행 S.1 `ssh_auth.rs` 형식 변경으로 실패했으며 U.2 성공으로 기록하지 않는다. 기존500KB 번들 경고 유지.
- 최신 Windows 실제 검사: `node scripts/test-workspace-native.mjs` 종료0 — cmd3개 전체 입력/2개 선택/비대상 격리, 대상 종료·배치 변경 시 그룹 해제, 마우스304→344px, 네이티브 단일/분할 F11 및 선택 창 확대, 기존 연결/렌더러 보존. `node scripts/test-local-native.mjs` 최종 종료0 — PowerShell·cmd·Ubuntu WSL, 한글·PTY resize·분할·종료/재접속·500줄 출력·앱 정상 종료/PID 정리, 사이드바 전환/설정 포커스.
- 실제 SSH UI 회귀: `DACHSTERM_UI_REGRESSION_ONLY=1 node scripts/run-phase1.mjs --native --skip-app-build` 최종 종료0. 인증/호스트키·게임 격리·5탭·선택2개 입력·로컬↔SSH 양방향 입력·SFTP/편집/권한/압축·CP949·2×2·클립보드·top/htop/vim·분리 창 왼쪽 파일 패널/F11/테마·네트워크 재접속·정상 종료·보관함/재시작·변경 키 거부 통과. 이 명시적 옵션은 병행 S.1의 새 인증/터미널 기본기 확장 검사를 생략한다. **S.1 전체 성공 또는 SSH 엔진 probe 재실행으로 해석하지 않는다.** 테스트 소유 앱과 SSH fixture 정리 완료.
- 실제 FTP: `node scripts/run-ftp.mjs --reuse-build --native` 최종 종료0. 실제 FTP/FTPS/CP949 엔진의32MiB 전송·REST 재개·바이너리 일치·인증서 거부 및 WebView2 FTP/FTPS 세션·파일 작업·좁은 창 회귀 통과.
- 산출물: `target/release/daxterm.exe`(2026-11-05 10:57 KST, 26,310,656바이트), `target/debug/daxterm.exe`. release는 GUI subsystem 실행 파일이며 이번 변경을 포함한다. 기존 `target/release/bundle/nsis/DaxTerm_0.5.1_x64-setup.exe`는 재생성하지 않았다. 시각 확인: `test-results-native/unified-fullscreen-multi.png`, `unified-local.png`, `files-editor.png`, `detached-window.png`.
- 남은 ID/이유: **U.2 Mac**(실기기 환경 없음), **5.3 최신 NSIS 재생성/설치 검증**, 기존 W/5.1~5.3 수동·배포 항목 및 병행 S.1 검증은 해당 기록 유지. 다음 첫 행동: 최신 release EXE로 개편 화면 사용 가능. 배포 담당은 병행 S.1 완료 후 설치 패키지를 다시 생성·검증한다. Mac이 제공되면 사이드바/전체화면/분할 입력/PTY를 실기기에서 확인한다.

## S.1 — RSA 보안·일반 인증·터미널 기본기 (2026-11-05)

- 범위: roadmap §5 S.1, 이번 사용자의 RSA 경고 해소/키 인증 유지·SFTP 기본 팔로우·마우스 복사/붙여넣기·기본 키 및 누락 기능 점검 요청. 다른 U.2 작업의 UI/로컬 입력·검사 변경을 보존했다. 세부 계약과 지원/미지원 표는 `docs/verification/security-terminal-basics.md`가 정본이다.
- 보안 파일: 루트/앱/probe Cargo manifest와 lock, `src-tauri/src/{rsa_auth,ssh_auth,ssh,commands,storage,lib}.rs`, build/capability/생성 권한, `vendor/ssh-key`, `scripts/generate-notices.mjs` 및 생성 고지. RustCrypto rsa 패키지 제거, ring SHA256/512 RSA2048~8192 서명·호스트 검증, OpenSSH/PEM/암호화 PKCS8 인증. SHA1/약한 RSA 거부. vendored 원본 대비 runtime 소스 변경은 signature.rs 하나이며 출처·범위·업데이트 절차는 DACHSTERM-PATCH.md에 기록했다. 감사 무시로 경고를 숨기지 않았다.
- 인증: Windows OpenSSH agent/Unix SSH_AUTH_SOCK와 keyboard-interactive, 기존 password/key/agent 성공 일부 뒤 MFA. 키 최대5회, 질문/회수/시간/응답 큐 상한, 연결 소유 창 검사, 비밀 응답 미저장. `src/features/sessions/{SessionForm,AuthenticationPrompt}.tsx`, `src/features/terminal/session.ts`, `src/lib/ipc.ts`, App 연결 흐름을 추가했다. 사용자 인증서 agent 경로는 있으나 실제 CA/하드웨어 조합을 검증했다고 주장하지 않는다.
- 터미널/파일: `src/features/terminal/{preferences.ts,preferences.test.ts,TerminalPane.tsx,session.ts}`, `src/features/sftp/FilePanel.tsx`, 공통 스타일/도움말. 기본 켜짐 선택 복사·우클릭 붙여넣기·SFTP 팔로우, 새 연결 기본값 및 연결별 팔로우 해제, Ctrl/Cmd+Shift+C/V·Shift+Insert, 위험 붙여넣기 확인, DEL/Ctrl+H 선택과 VERASE/IUTF8 PTY. xterm 기본 키와 TUI 마우스 모드 유지. OSC7/1337 원격 경로만 허용하고 Bash/Zsh에는 명시적 버튼으로 현재 셸 hook 연결(설정 파일 변경 없음). 오래된 비동기 붙여넣기가 새 연결로 전달되지 않게 연결 ID도 확인한다.
- 실제 검사 파일: `tests/openssh/{Dockerfile,entrypoint.sh}`, `scripts/{run-phase1,test-native,verify-terminal-basics}.mjs`, `src-tauri/examples/phase1_probe.rs`. 테스트마다 새 키/자격 증명과 localhost 포트/격리 named pipe를 사용한다. 암호·키 원문은 문서/로그에 기록하지 않는다.
- 감사: `node scripts/audit-windows.mjs` 종료0/Windows0건, `npm audit --audit-level=low`0건. 전체 Rust 보고서의 Windows 대상 밖 경고5개는 유지한다(전역 cargo audit 무경고를 뜻하지 않는다). `cargo tree -i rsa --locked`는 해당 패키지 없음. 고지424개/라이선스 원문 누락0. 결과 `target/verification/windows-audit.json` 및 전체 보고서.
- 코드 검사: `npm test`32개, `npm run test:ui -- --workers=2`26개, lint/typecheck/build 통과. 최종 `npm run format:check`와 절대 경로 cargo의 `fmt --all -- --check` 종료0. `cargo clippy --workspace --all-targets --locked -- -D warnings` 종료0. `cargo test --workspace --locked` 앱24+probe1 통과(마지막 작은 agent 크기 제한/0질문 처리 뒤 clippy와 실제 native 전체 검사를 수행). 초기 병렬 Rust 빌드는 Windows paging1455로 실패했으나 CARGO_BUILD_JOBS=1 재실행 통과. PATH에 cargo가 없는 최종 포맷 명령은 실패 후 `C:/Users/Administrator/.cargo/bin/cargo.exe`로 재실행 통과했다.
- 실제 OpenSSH 엔진: `node scripts/run-phase1.mjs` 종료0. 일반/암호화 RSA OpenSSH·PEM·암호화 PKCS8, 잘못된 passphrase 거부, 실제 agent, RSA-only 호스트·SHA256-only 사용자 인증, 키+PAM 추가 인증·취소, 위조 SHA2/SHA1 서명 거부 및 기존 전송/편집/포워딩 등 전체 통과. 실제 OTP 제공자를 시험한 것은 아니다.
- 최종 Windows 앱: `$env:CARGO_TARGET_DIR='D:/Work/daxterm-workspace/src-tauri/target/windows-hardening'; node scripts/run-phase1.mjs --native --skip-app-build` 종료0, S.1 검사 생략 환경변수 미사용. 실제 Bash cd 팔로우/끄기/재마운트, 캔버스 드래그 복사, 우클릭/단축키/위험 붙여넣기 취소, 방향키/Home/End/Backspace/Ctrl+H·설정 유지, agent/서버 질문/암호화 RSA+추가 인증·비밀 참조 미저장 통과. 기존 게임/5탭/혼합 로컬·SSH 선택 입력/SFTP·편집/CP949/분할/top·htop·vim/분리창/KeepAlive/재시작·보관함/변경 호스트 키 차단까지 전체 통과. fixture 제거 메시지와 종료0 확인.
- 중간 실패/보정: 클립보드 비동기 읽기 전에 Enter를 보낸 테스트는 붙여넣기 결과를 기다리게 수정. 질문0개 keyboard-interactive 정보 요청은 RFC4256에 맞게 자동 응답하도록 제품 수정. S.1 테스트 프로필 삭제창이 닫히기 전 다음 게임 단계로 넘어가던 검사에는 삭제 완료/모달 닫힘을 기다리게 추가. 앞선 실패를 성공으로 집계하지 않았고 수정 후 위 전체 실행으로 확인했다.
- 산출물: 검증한 내장 자산 debug 앱은 `src-tauri/target/windows-hardening/debug/daxterm.exe`. 이번 S.1에서는 버전 변경/NSIS 재생성·설치 검사를 하지 않았다. 기존 `target/release/bundle/nsis/DaxTerm_0.5.1_x64-setup.exe`는 10:07:55의 이전 산출물이다. 병행 U.2의 release 변경은 해당 작업의 검증 기록을 따른다.
- 미검증/남은 ID: **S.1 Mac·Unix agent·Zsh·실제 OTP/하드웨어 agent/사용자 CA 인증서**, **S.1/5.3 최신 설치본 생성·설치**, 기존 **W.4/5.1 수동 OS·IME·절전·24시간**, **W.3 서명/배포**, **5.2 Mac**. 환경/실제 공급자/장시간 결과가 없어 대기다. GSSAPI/Kerberos·직접 FIDO2·Pageant·agent forwarding·호스트 CA·점프 호스트·로컬 폴더 재귀 전송/큐·세션 로그는 미지원으로 명시했고 이번에 모두 구현했다고 보고하지 않는다.
- 다음 첫 행동: 병행 U.2 변경이 확정되면 최신 소스를 설치 패키지에 포함해 설치/실행 검사. 실제 서버 환경에서 M10 인증/키 호환성과 OTP·하드웨어 agent를 검증하고, Mac 환경 확보 시 SSH_AUTH_SOCK·Zsh/키보드/클립보드/팔로우를 검증한다. 검증된 현재 Windows 소스를 전체 Phase/공개 안정판 완료로 해석하지 않는다.

## G.3 — 닥스의 간식 타임·닥스의 모험 메뉴 통합 (2026-11-05)

- 요청: 앞서 채팅에서 만든 두 게임을 실제 DachsTerm 게임 메뉴에도 추가. 기존 G.2의 사이드바→중앙 작업 탭을 재사용하며 별도 창/페이지/IPC/의존성은 추가하지 않았다. 기존 4종과 함께 6종 선택 가능. 병행 I.1/U.3 등의 코드와 진행 기록은 유지한다.
- 구현 파일: `src/features/games/{catalog.ts,GamePane.tsx,shared.tsx,DachsGames.tsx,dachsEngines.ts,games.css}`. 기존 시작/일시정지/최고 기록/상태 UI를 shared로 추출하고 두 게임에서 재사용. 원본 `src/assets/brand/dachshund-full.png`, 터미널 색상 토큰으로 SVG 보드를 표시한다. 채팅의 HTML/외부 워크스페이스/네트워크에 런타임 의존하지 않는다.
- 간식 타임: 45초, 간식10점/별30점/양파 목숨1 감소, 목숨3개, 1.1초 연속 피해 방지. 방향키/A·D·드래그·누르는 이동 버튼. 모험: Space/↑/W/터치·점프 버튼, 자동 달리기/거리 기록, 두 장애물/중력/공중 재점프 방지/속도 상한. 숫자 최고 기록만 `dachsterm.games.v1.snack` 및 `.adventure`에 저장하고 저장 실패에도 플레이한다.
- 입력/수명: 게임판 포커스에서만 키 처리, 수정키 단축키는 가로채지 않음. 보드/버튼을 떠날 때 이동 입력 정리, 탭 비활성/창 blur/문서 hidden/게임 영역 이탈 시 정지. 비활성·완료·탭 닫기 시 RAF 정리. 현재 판은 탭 전환에 유지, 명시적 계속하기, Esc는 기존 작업 복귀. 기존 터미널 마운트/inert 계약은 그대로 사용한다.
- 검증 파일: `src/features/games/dachsEngines.test.ts`, `tests/ui/dachs-games.spec.ts`, 확장한 `scripts/test-games-native.mjs`. 문서는 roadmap §11 G.3 및 README 로컬 게임 사용법에 반영했다.
- 통과: `npm test`38개(새 규칙6개), `npm run typecheck`, `npm run lint` 및 `npm run format:check` 종료0. `npx playwright test tests/ui/games.spec.ts tests/ui/dachs-games.spec.ts --workers=2`의 기존 게임5개와 테마/터치1개는 통과했으나 새 폭별3개는 가상시계를 lazy import 전에 멈춰 Suspense 준비 중에 timeout. 제품 실패로 숨기지 않고 하네스가 보드 로딩을 확인한 뒤 시계를 제어하도록 수정했다. 이후 `npx playwright test tests/ui/dachs-games.spec.ts --workers=2` 새4개 전체 종료0. 360/560/1280px, 좌우 이동·점프 장애물 회피·충돌/종료·45초 종료·정지·재시작·탭별 판/기록·닫기·Esc·테마·기존 xterm 인스턴스 유지 확인. 시각 확인: `test-results/dax-adventure-360.png`, `dax-snack-1280.png`, `dax-dark.png`.
- 실제 Windows: `npm run tauri -- build --debug --no-bundle` 종료0 → `node scripts/test-games-native.mjs` 종료0. WebView2 6종, 새 게임 방향키·점프/정지·탭 복원, 기존 게임 키/기록/닫기 포커스 통과. 실제 로컬 PowerShell `Read-Host` 대기 중 두 게임의 방향키/Space/A/D 입력 후 복귀하여 빈 문자열만 수신함을 검사했고 동일 연결 ID 유지. Mock SSH 검사가 아니며 **실제 SSH 재검증을 수행한 것으로 대체하지 않는다**. 테스트 소유 앱 정상 정리. 실제 화면 `test-results-native/games.png` 확인.
- 빌드: `npm run tauri -- build --debug --no-bundle` 및 `npm run tauri -- build --no-bundle` 모두 종료0. 각각 `target/debug/daxterm.exe`, `target/release/daxterm.exe`에 새 게임 내장 자산 반영. release 최적화 빌드는 5분49초 소요. PATH에 cargo를 추가하고 `CARGO_BUILD_JOBS=1`로 실행했다. 기존 메인 번들500KB 경고 유지. 이번 변경은 Rust/IPC/권한 수정 없음. NSIS 설치본은 재생성하지 않았다.
- 미검증/남은 ID: **G.3 Mac**(실기기 없음), **G.3 실제 SSH 회귀**(이 작업은 실제 로컬 PTY 격리 검사 수행), **5.3 최신 NSIS 생성/설치**(요청은 게임 메뉴 통합이며 설치본 재생성 미실행). 기존 I.1/U.3/S.1/W/Phase의 미완료 항목은 각각의 기록을 따른다. 다음 첫 행동: 최신 release EXE로 실행하여 사이드바 게임의 두 항목 사용 가능. 배포 담당은 병행 작업 확정 후 최신 NSIS를 재생성·검증한다. Mac/실제 SSH가 필요한 별도 검증은 해당 환경에서 수행한다.

## U.3 — 버튼 일관성과 이해하기 쉬운 터널 설정 (2026-11-05)

- 범위: 사용자 첨부 화면의 버튼 레벨 불일치 점검 및 복잡한 설정을 흐름/목록 UI로 설명하는 개선. roadmap §14, 상세 결과는 `docs/verification/settings-ui.md`.
- 파일: `src/features/tunnels/{TunnelPanel.tsx,tunnels.css}`, `src/app/{App.tsx,styles.css,workspace.css}`. `.primary` 별도 padding 제거·공통 액션/입력 32px, 목적 중심 유형 선택·방향별 입력/설명, 목록/편집 분리, 저장 후 목록, 실제 상태/시작·중지/자동 시작/수정/삭제. 현재 탭 외 열린 SSH 연결 선택, 다른 연결 실행 보호, 실패 입력 보존·중복 요청 방지.
- 검사 파일: `tests/ui/tunnels.spec.ts`, `tests/ui/fixtures/tunnels.{html,tsx}`, 세션 폼 높이 검사를 추가한 `tests/ui/layout.spec.ts`, 실제 왕복 `scripts/verify-tunnels.mjs`와 `scripts/test-native.mjs` U.3 단계.
- 프런트엔드: `npm test` 실행 당시32개, `npm run test:ui -- --workers=2`32개, 최종 터널/레이아웃12개 통과. `npm run typecheck`, 최종 전체 lint 및 변경 파일 ESLint/Prettier 통과. 360/560/800/1280px·크림/다크/터미널 테마·키보드·버튼 정렬·실패/보호 흐름 검사. 테스트 fixture는 실제 SSH로 집계하지 않는다.
- Windows: PATH에 cargo 경로를 추가하고 CARGO_BUILD_JOBS=1, CARGO_TARGET_DIR=`D:/Work/daxterm-workspace/src-tauri/target/windows-hardening`로 `npm run tauri -- build --debug --no-bundle` 통과. 같은 target로 `node scripts/run-phase1.mjs --native --skip-app-build` 최종 종료0. 실제 Local/Remote/SOCKS5 도메인 CONNECT 왕복, 설정 목록/자동 시작 값 저장·해제/창 닫기 유지/중지·삭제 및 기존 전체 native 회귀 통과. 테스트 fixture 정리 완료. `--reuse-build` 실행이므로 독립 engine probe 재실행으로 집계하지 않는다.
- 실패 이력: 병행 게임 파일 생성 도중 DachsGames import 누락 빌드 실패 후 재실행 성공; 병행 세션 전송 검사 미사용 변수로 전체 lint 실패 후 해당 작업 수정 뒤 재실행 성공. Native 검사 자체의 비동기 체크박스 대기와 동기 docker 호출의 로컬 echo 이벤트루프 차단을 수정한 뒤 최종 실제 왕복 통과. 제품 보안/엔진을 우회하지 않았다.
- 시각 결과: `test-results/tunnel-local-1280.png`, `tunnel-list-360.png`, `test-results-native/tunnel-editor-local.png`, `tunnel-saved-list.png` 직접 확인. 테스트 서버/일회용 포트만 사용, 비밀정보 기록 없음.
- 산출물: `src-tauri/target/windows-hardening/debug/daxterm.exe`에 새 UI 포함. release EXE 및 NSIS 설치본은 이번 작업에서 재생성하지 않았다. Rust 소스/IPC/DB 변경 없음. Rust fmt 및 `cargo clippy --workspace --all-targets --locked -- -D warnings` 종료0(같은 target, CARGO_BUILD_JOBS=1, 8분07초).
- 남은 ID: **U.3 Mac 실기기**, **U.3/5.3 최신 release·설치본 반영**, 기존 **W.3/W.4/5.1~5.3** 수동 OS/장시간/서명/Mac 대기 유지. 다음 첫 행동: 검증한 debug 앱의 도구 → 터널에서 변경 UI 확인; 병행 소스 확정 후 release/설치본 생성·검증. Mac 제공 시 유형별 흐름/키보드/테마/실제 SSH 왕복 확인.

## I.1 — 세션 JSON 규약·외부 가져오기·로그인 후 암호 저장 (2026-11-05)

- 요청: 자체 JSON 교환 규약과 PuTTY/MobaXterm 같은 SSH 도구의 설정 변환 가져오기. 추가 요청으로 첫 로그인 시 저장 여부를 선택하고 다음 접속에 암호를 재사용하는 흐름을 포함했다. 병행 U.3/G.3 코드·기록을 보존했다.
- 계약/문서: `docs/session-transfer.md`, `docs/session-format.schema.json`, roadmap §15, README. format=dachsterm.sessions/version2, 기존 format 없는 v1 계속 수용. 세션·그룹·터널·즐겨찾기·인코딩·인증 방식/키 경로, 비밀/신뢰/최근 접속 제외. 자체 포맷이지 업계가 합의한 공통 표준이라는 주장은 하지 않는다.
- 백엔드: `src-tauri/src/{session_transfer,settings,commands,lib}.rs`, `build.rs`, capabilities 및 자동 생성 config_preview/config_apply 권한. 파일 선택은 네이티브, raw 외부 파일/암호 필드는 프런트로 돌려주지 않는다. 2MiB/20,000줄·세션500/그룹100/터널128 제한, UTF-8/UTF-16 BOM/CP949/Windows-1252, 선택 전 미리보기, ID/참조 검증·트랜잭션·복구본·새 ID/터널 자동 시작 해제. 레지스트리/명령/Include 실행 없음.
- 어댑터: PuTTY .reg SSH/이름 percent decoding·호스트/포트/사용자/키 경로, 프록시·비SSH 제외/PPK 별도 변환 안내. MobaXterm Bookmarks SSH 기본 접두부/폴더 경로(평탄화), 추가 설정 제외 경고. OpenSSH 명시적 별칭·패턴/부정·첫 값 우선·기본 필드/첫 키 경로, Match/Include 거부·ProxyJump/ProxyCommand 제외·경로 토큰 미확장. 지원표 밖 SecureCRT/Xshell/Termius/WinSCP 어댑터와 외부 형식 내보내기는 구현하지 않았으며 모든 제품/버전 호환이라고 보고하지 않는다.
- 화면: `src/features/sessions/{SessionTransfer.tsx,transfer.css}`, `src/app/App.tsx`, `src/features/terminal/session.ts`. 설정에서 파일 형식/인코딩 → 미리보기 → 선택/빠진 계정 입력 → 추가, 취소·오류/재시도·성공 건수. 같은 파일 재적용은 사본 추가라고 명시한다. 기존 DB 데이터 덮어쓰기 없음. 기존 12개 테마 토큰을 사용한다.
- 암호: 첫 접속 인증창의 기본 미선택 ‘로그인 성공 후 이 세션의 암호 저장’. 입력한 password/key Passphrase만 성공 connected 이벤트에서 기존 Vault/OS 저장소에 저장, 실패/호스트키 거부·OTP 응답 미저장. Zeroizing 임시 값은 성공/실패에서 제거. 접속 중 대상/계정/인증 방식/키/기존 credential 참조 변경 시 저장하지 않으며 잠긴 보관함/저장 실패는 연결을 유지하고 상태줄에 안내한다.
- 정적/단위 검사: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` 종료0. `npm test`38개(병행 G.3 포함) 통과. 절대 cargo 경로로 `cargo fmt --all -- --check` 종료0, `cargo clippy -p dachsterm --lib --bin dachsterm --locked -- -D warnings` 종료0, `cargo test -p dachsterm --lib --locked`32개 통과(변환7개/새 v2 참조 검사1개 포함). 초기 clippy의 인자8개/extend-with-drain 지적은 AppHandle에서 State 조회 및 append로 수정 후 통과했다. 마지막 수정은 MobaXterm 경고 문구의 ‘지원하지 않는 게이트웨이 세션 선택 해제’ 명확화이며 포맷 검사 통과.
- JSON Schema: 검증용 `target/schema-validation`에만 설치한 Python jsonschema4.26.0의 Draft202012Validator로 schema 자체·문서 예제 통과, 비밀 추가 필드·미래 버전 거부 확인. 제품 의존성은 추가하지 않았다. 초기 시스템 Python에는 jsonschema가 없어 격리 경로에 설치했다.
- UI: `npm run test:ui -- tests/ui/session-transfer.spec.ts --workers=2`4개 종료0. Mock 미리보기의 빈 계정 저장 차단·부분 선택 시 그룹/터널 필터·실패 후 값 유지·재시도/취소, 1280/560/360px 넘침 검증. `tests/ui/fixtures/transfer.{html,tsx}`는 제품 번들 밖 테스트 fixture. 화면 확인에서 체크박스의 전역 width 영향 발견 후 scoped width 수정·재검사. 최종 화면 `target/verification/transfer-{1280,560,360}.png` (병행 Playwright 정리와 분리).
- 실제 Windows: `npm run tauri -- build --debug --no-bundle` 종료0. `node scripts/run-phase1.mjs --native --skip-app-build --session-transfer` 최종 종료0: 새 `scripts/test-session-transfer-native.mjs`에서 실제 WebView2+격리 OpenSSH+Windows 저장소 사용. v2 추가/알 수 없는 필드 거부/기존 건수 유지, 신뢰 거부/잘못된 암호 미저장, 성공 이번만 미저장, 성공 동의 저장, 재시작 후 암호 입력 없이 접속, 잠긴 보관함 저장 실패 안내와 연결 유지, 복구 JSON의 비밀 부재, credential 정리 확인. 두 번 통과했으며 최종은 잠긴 보관함 검사까지 포함. fixture/일회용 키·암호 제거 종료0. 전체 SSH 엔진/Phase 회귀 재실행을 뜻하지 않는다.
- 산출물: `target/debug/daxterm.exe`, 실제 설정 화면 `test-results-native/session-transfer.png`. 최종 `npm run tauri -- build --no-bundle` 종료0(병행 Cargo 잠금 대기 포함5분13초). `target/release/daxterm.exe`: 2026-11-05 11:37 KST, 26,520,064바이트, SHA256 `8F34ADFD9E066F9BDD318736F1B99DBD19B4321DD779AC4EB7710E08DEAE8E6C`. 최신 I.1/U.3/G.3 소스를 포함한다. 실제 자동 기능 검증은 내장 자산 debug 앱 기준이며 release 자체 실행 검사를 추가 수행한 것은 아니다. 기존 NSIS는 재생성하지 않았다. 기존 메인 번들500KB 경고 유지.
- 미검증/남은 ID: **I.1 외부 제품 실제 버전별 내보내기 파일·OS 파일 선택/저장 대화상자 수동 조작**, **I.1 Mac 실기기**, **I.1 키 Passphrase/FTP·FTPS의 새 저장 선택 경로 별도 실검증**, **I.1/5.3 최신 설치 패키지**. 파서는 합성 fixture로 검증했고 실제 사용자 외부 파일/제품 실행 환경은 제공되지 않았다. 이번 Windows 실접속 검사는 password SSH이며 Mock으로 다른 프로토콜/Mac 결과를 대체하지 않는다. 기존 U.3/G.3/S.1/W/Phase 상태는 각 기록 유지.
- 다음 첫 행동: 최신 release EXE로 설정 → 세션 가져오기·내보내기에서 파일을 확인·선택하고, 새 세션 연결의 인증창에서 암호 저장을 선택한다. 후속 검증은 익명화한 실제 PuTTY/MobaXterm 내보내기와 OS 대화상자 왕복부터 수행하고 배포 시 최신 NSIS를 생성·검증한다.


## G.4 — 닥스의 모험 횡스크롤 액션 (2026-11-05)

- 요청: 기존 모험을 앞뒤 이동·모션·물기·점프가 있는 횡스크롤 액션 게임으로 확장. G.3의 자동 러너만 대체했다. 기존 5종 게임·터미널 기능·마스코트 원본은 보존한다. 범위는 roadmap §11 G.4로 반영했다.
- 구현 파일: `src/features/games/{AdventureGame.tsx,adventureEngine.ts,DachsGames.tsx,dachsEngines.ts,shared.tsx,games.css}`. 모험 엔진/화면을 분리하고 기존 RAF·보드 크기 hook을 shared로 이동. 좌우 가속·감속과 반전, 양방향 카메라, 고정 상한 substep 물리, 코요테 타임/착지 직전 점프 예약, 공중 재점프 방지, 물기 방향/높이/거리/쿨다운, 순찰 적과 넉백/무적을 구현했다.
- 월드: 4,200단위 1개 스테이지·3개 구간명, 발판8/적8/가시4/협곡2/쉼터2, 간식14, 집 도착 클리어. 체력5, 간식25/처치50/완주200점, 쉼터 최초 도착 체력+1, 낙하 체력−1/쉼터 복귀. 기존 최고 거리 저장 키는 유지하고 후진으로 최고 거리를 중복 가산하지 않는다. 점수/진행/체력/위치 안내, 준비/정지/완주/실패 화면을 제공한다.
- 모션: 기존 크림 장모 닥스의 외형·화풍을 참조해 내장 image_gen으로 `src/assets/brand/dachshund-adventure-atlas.png` 생성. 1536×1024 RGBA/512셀/6포즈(서기, 달리기2, 점프, 물기, 피격). alpha와 실제 밝은/어두운 게임 배경을 확인했다. 원본 `dachshund-full.png`/face는 수정하지 않았다. 정확한 프롬프트·셀 순서는 `src/assets/brand/README.md`에 기록. SVG viewBox 프레임 전환, 보행 진동/점프 자세/물기 돌진/피격 점멸, 타격/착지/간식 효과, 원근 배경을 상태 시간으로 렌더링해 정지 시 함께 멈춘다. UI·월드 색은 기존 터미널 토큰만 사용.
- 입력: ←/→ 또는 A/D, Space/↑/W 점프, J/X 물기, P 정지. 화면 이동 버튼 포인터 캡처와 다중 포인터별 방향을 유지해 점프/공격 조합 가능. 키 repeat 공격/점프 방지. 정지/보드 blur/탭 이탈/재시작/포인터 취소 시 입력 정리. 기존 G.2의 판 보존·명시적 재개·Esc 복귀·터미널 inert 계약 유지. 추가 IPC/SSH 명령/네트워크/패키지 없음.
- 규칙 검증: `npm test` **44개 통과**(모험9개). 무입력 정지/좌우·관성·경계, 발판 착지·점프 예약 만료, 방향/높이/거리별 물기·쿨다운·중복 보상 방지, 피격 무적/사망 동결, 쉼터1회 회복/낙하 복귀, 카메라/후진 최고 거리, 30/120Hz, **기본 월드를 조작 입력만으로 시작→집까지 완주** 확인. 테스트 파일 `adventureEngine.test.ts`, 기존 `dachsEngines.test.ts`는 간식 규칙 유지.
- UI 검증: `npx playwright test tests/ui/dachs-games.spec.ts tests/ui/games.spec.ts --workers=2` 최종 **11개 통과**. 모험/간식6개 + 기존게임5개, 360/560/1280px, 좌우/점프/공격, 몬스터 처치와 점수, 양방향 카메라, 포인터 이동+점프/공격, 해제/정지·재개/재시작, 테마/탭 보존/Esc/기존 xterm 인스턴스 유지·기록 저장 확인. 이미지 `test-results/dax-adventure-{1280,560,360}.png`, `dax-adventure-stage.png`, `dax-dark.png`를 저장했고 큰/어두운 화면을 시각 확인했다.
- 코드·빌드: 최종 `npm run lint`, `npm test`, 게임/변경 테스트·스크립트 `npx prettier --check` 통과. `npm run build`(tsc 포함), `npm run tauri -- build --debug --no-bundle` 최종 종료0. 기본 PATH에 cargo가 없어 최초 native build는 실패했으며 해당 명령의 PATH에 `C:/Users/Administrator/.cargo/bin`을 추가해 해결. 기존 메인 번들500KB 경고는 유지. 스프라이트 추가 후 첫 UI 통합 실행은 nested SVG 때문에 기존 테마 검사 locator가 중복되어 1개 실패했으며 보드 직계 SVG로 선택자를 보정해 위11개 전체 재실행 통과.
- 실제 Windows: `node scripts/test-games-native.mjs` **종료0**. 최종 내장 자산 debug 앱 `target/debug/daxterm.exe`의 실제 WebView2에서 6종게임, 모험 좌우·점프·물기/정지/복귀/기록을 검사. 실제 로컬 PowerShell `Read-Host`를 열어 뒤의 PTY 연결을 유지한 채 방향키/Space/A/D/**J/X**가 입력되지 않음을 확인. `test-results-native/games.png` 저장. 테스트 소유 앱은 스크립트 finally에서 종료. 실제 SSH 연결 검사를 이번 로컬 PTY 검사로 대체하지 않는다.
- 산출물: 최종 `npm run tauri -- build --no-bundle` 종료0(3분30초). 최신 `target/release/daxterm.exe`에 G.4를 포함했다. 실제 WebView2 기능 검증은 같은 최종 프런트엔드 자산의 debug 앱 기준이며 release 자체 실행 검사를 추가 수행한 것은 아니다. NSIS 설치 패키지는 이번 범위에서 재생성하지 않았다.
- 미검증/남은 ID: **G.4 Mac 실기기**, **G.4 물리 멀티터치 장치**, **G.4 실제 SSH 배경 입력 격리 재검증**, **G.4/5.3 최신 NSIS 설치본**. Mac/터치 장치 부재, 요청 범위 내 Windows 로컬 PTY 우선 검증으로 미실행. G.2/U.1 등 과거 SSH 성공과 이번 결과는 구분한다. 기존 Phase/다른 작업 상태는 바꾸지 않는다.
- 다음 첫 행동: 최신 `target/release/daxterm.exe` 실행 → 왼쪽 게임 → 닥스의 모험 → 게임 시작. 후속 검증은 물리 터치 동시 입력과 Mac, 배포 시 최신 NSIS 생성·설치부터 진행한다.

- 최종 release 식별: 2026-11-05 12:44:50 KST, 28650496바이트, SHA256: BD057AB8C89D9215C029F2FDBE3F47D8164F0BDA9327C11767EFC66917964D97. 위 파일을 직접 실행하면 G.4를 사용할 수 있으며 기존 설치본을 실행하면 이전 모험이 표시될 수 있다.


## G.5 — 간식 타임 모션·플레이 완성도 개선 (2026-11-05, 구현·Windows 검증·release 빌드 완료)

- 요청/범위: G.4 횡스크롤 모험의 기존 모션을 재사용한 간식 타임 완성도 개선. 45초/간식10·별30점/목숨3/1.1초 피해 보호/최고 기록 키를 유지한다. 모험 확장은 병행 G.6이며 해당 작업을 덮어쓰지 않았다.
- 구현: `src/features/games/{DachsGames.tsx,SnackScene.tsx,DachsSprite.tsx,snack.css,dachsEngines.ts,GamePane.tsx}`. 기존 atlas를 공유하고 `AdventureGame.tsx`의 중복 SVG atlas 렌더링도 DachsSprite로 대체했다. 좌우 가감속·관성·반전/두 달리기 포즈, 씹기/부스러기·별 점프·피격/보호 반응, 그림자·점수/입자 효과, 정원/시간 바/범례/구간 안내·준비/정지/결과 화면. 연속/최대 연속·간식/별 개수는 판 상태만 저장하며 연속 보너스 점수는 없다. 놓치면 연속만 초기화한다.
- 동작: 1/120초 물리 substep, 가로 이동을 보간한 낙하 충돌, 30/120Hz 일치, 게임 시간 기반 효과(정지/완료/탭 이탈 시 함께 동결). StrictMode updater 밖에서 RNG를 샘플링해 이중 실행에도 같은 결과. 실제 SVG 배율로 포인터 좌표 변환, resize 시 닥스/간식 위치 비례 보존, 다중 이동 포인터·취소·키 해제·재개 입력 정리. 모션 줄이기 환경은 회전/진동/입자 생략. 추가 이미지 생성/네트워크/IPC/패키지는 없다.
- 검증 파일: `src/features/games/dachsEngines.test.ts` 8개, `tests/ui/snack.spec.ts` 6개와 실제 컴포넌트 fixture `tests/ui/fixtures/snack.{html,tsx}`. 기존 `tests/ui/dachs-games.spec.ts`, `scripts/test-games-native.mjs`는 이동 좌표를 data-x로 검사하도록 변경했고 native에 씹기/점수/공유 스프라이트 검사를 추가했다.
- 통과: `npx vitest run src/features/games/dachsEngines.test.ts --maxWorkers=1` 8개; `npm test -- --maxWorkers=1` 전체53개; `npm run typecheck`, `npm run build`, 변경 파일 ESLint/Prettier 종료0. UI `npx playwright test tests/ui/snack.spec.ts --workers=1 --output=target/snack-test-results` 최초5개 통과, 이후 추가한 앱 통합 테스트는 `--grep 'integrates with dark' --output=target/snack-integration-results` 1개 통과. 360/560/1280px·씹기/별/피격·보호/목숨 소진/45초·모션 줄이기·resize·드래그·정지/재개/재시작 및 실제 앱 UI의 다크/기존 xterm/판 보존 확인. fixture는 실제 SSH 검사로 집계하지 않는다.
- 실패/수정: 최초 전체 테스트에서 병행 G.6 엔진 교체 중 기존 모험 export 불일치와 Node worker 메모리 부족이 발생했다. 모험 파일을 되돌리지 않고 간식 독립 검사 후 G.6 소스 정합성이 맞춰진 상태에서 전체53개/빌드를 통과했다. 첫 별/양파 UI 검사는 React 초기화가 소비한 전역 RNG 순번 때문에 실패해 준비 완료 후 RNG를 주입하도록 수정했다. 화면 검사에서 공통 game CSS 우선순위로 900px 너비/보드 padding이 덮이던 문제를 scoped specificity로 수정했다.
- 시각 결과: `target/verification/snack-{ready,eat}-{360,560,1280}.png`, `snack-result-360.png`, `snack-app-{light,dark}.png` 중 좁은/넓은/결과/다크를 직접 확인했다. Windows debug 빌드와 기존 게임 UI 회귀도 통과했으며 최종 결과는 아래와 같다.
- 미검증/남은 ID: **G.5 Mac·물리 터치·실제 SSH 재검증**, **G.5/5.3 NSIS 설치본**. Mac/물리 장치 미제공, 실제 SSH·설치본은 이번 범위에서 별도 수행 전이다. 기존 Phase 미완료 상태 유지. 다음 첫 행동: 최신 `target/release/daxterm.exe` 실행 → 게임 → 닥스의 간식 타임. 배포 시 최신 NSIS 생성·설치 검사, 환경 제공 시 Mac/물리 터치/실제 SSH 격리 재검증.


- 최종 통합 회귀: `npx playwright test tests/ui/dachs-games.spec.ts tests/ui/games.spec.ts --workers=1 --output=target/snack-regression-results` **11개 전체 통과**. 새 간식 UI 6개와 별개이며 총 게임 UI17개 결과다.
- Windows: PATH에 `C:/Users/Administrator/.cargo/bin`, `CARGO_BUILD_JOBS=1`로 `npm run tauri -- build --debug --no-bundle` 종료0. `node scripts/test-games-native.mjs` **종료0**: 실제 WebView2의 간식 씹기 포즈/획득 점수/공유 atlas, 이동/정지/탭 복원 및 6종 게임. 실제 로컬 PowerShell `Read-Host`를 유지하며 게임 키가 입력되지 않음을 확인했다. `target/verification/snack-native.png` 직접 시각 확인. 테스트 소유 앱 정리 완료. 실제 SSH 검사로 대체하지 않는다.
- 최종 정적 검사: `npm run lint`, `npm run format:check`, `cargo fmt --all -- --check` 모두 종료0.
- 최종 release: `npm run tauri -- build --no-bundle` 종료0(4분36초). `target/release/daxterm.exe`에 G.5 내장 자산 반영. 식별: 2026-11-05 13:14:53 KST, 28,658,176바이트, SHA256 `49B8CD7E341B1B889B28146B38C712A79B6F50CD081A17A2791959F633086676`. 실제 앱 검증은 debug WebView2 기준이며 release 자체 실행 검사는 별도로 수행하지 않았다. NSIS는 재생성하지 않았다. 기존 메인 번들500KB 경고 유지. Rust/IPC/권한 변경 없음; 별도 Rust 단위/clippy는 이번 게임 변경으로 재실행하지 않았으며 과거 결과를 이번 성공으로 집계하지 않는다.

## G.6 — 닥스의 모험 랜덤 맵·환경/적/기믹·밟기 (2026-11-05)

- 현재 요청: Space 물기, ↑/W 점프, 공중 ↓/S 빠른 밟기 및 적 머리 위로 낙하할 때 자동 밟기. 사용자 추가 지시로 고정 스테이지 추가를 시드 기반 랜덤 생성으로 변경했고, 바닥 충격파는 제외했다.
- 구현 파일: `src/features/games/{adventureLevels.ts,adventureEngine.ts,AdventureWorld.tsx,AdventureGame.tsx,adventureEngine.test.ts,games.css}`, `tests/ui/adventure-random.spec.ts` 및 기존 모험 키 검사. 시드+구간 결정적 생성, 4환경 순환·다음 구간/같은 맵 재시작/직접 시드/새 맵, 4적 행동, 이동/붕괴 발판·버섯·스위치 문·증기·얼음. 적 밟기75점/반동, Space 물기50점. 규칙13개(800맵 생성 제약·20맵 입력 완주 포함) 및 프런트엔드 build/해당 코드 eslint 통과, 최종 UI/native/release 결과는 아래 기록을 따른다.
- 병행 G.5 간식 타임 변경과 공유 `DachsSprite.tsx`를 확인·보존했다. G.5를 덮어쓰지 않고 모험만 확장한다. 최종 문서/검증 결과는 G.6 아래에 추가한다.
- UI·코드 검증: 최종 프런트엔드 `npm test`53개·lint·build·변경 파일 Prettier 통과. 전용 포트1446/출력`target/adventure-ui`로 실행한 게임 UI14개 전부 통과, 이후 구간 완주/명시적 다음 구간/점수 유지/시작 전 정지를 추가한 랜덤 UI4개도 전부 통과(총 고유15개). 이미지 `target/verification/adventure-{forest,ruins,cave,snow}-{1280,360}.png`, `adventure-stomp.png`, `adventure-next-stage.png`. 수정 동굴/밟기 화면 시각 확인. 초기 공유1420 서버 종료로 일부 UI 연결이 실패해 전용 포트로 분리했고, 새 details의 group 역할로 중복된 검사 선택자는 게임판의 접근성 이름으로 좁혀 해결했다.
- 빌드 격리: 병행 G.5 빌드와 자산이 섞이지 않게 최종 dist를 `target/adventure-web`에 복사하고 `target/adventure-tauri.json`의 frontendDist로 지정했다. 수정 후 내장 자산 debug 빌드 종료0. 모험 전용 native 확인은 `scripts/verify-adventure-native.mjs`, 기존 게임 native 스크립트에서 호출하며 Space/Up/Down/S의 실제 로컬 PTY 입력 격리도 검사한다.


- 생성/물리 상세: `adventureLevels.ts`의 결정적 PRNG·환경별 대표2개/무작위4개 지형 조각, 각3,880단위 월드. 맵 시드는0~4294967295. 적의 순찰 범위가 쉼터에 겹치지 않도록 멧돼지 배치/범위를 제한했다. 머리 밟기는 낙하 전/후 발 좌표가 적 머리를 통과하는지 검사해 고속 낙하에서도 놓치지 않으며, 옆/상승 충돌은 기존 피해/무적 처리다. 밟기 반동 후 공중 재점프는 허용하지 않는다. 이동 발판은 서 있는 플레이어를 운반하고 금 간 발판은0.65초 후 붕괴/3.65초 후 복원. 증기는 대기→0.6초 예고→1.1초 분출. 게임 시간은 정지/비활성 시 함께 멈춘다.
- Windows 실제 검증: 최종 `node scripts/test-games-native.mjs`에 `DACHSTERM_TEST_BINARY=target/verification/daxterm-adventure-debug.exe`를 지정해 **종료0**. `verify-adventure-native.mjs`에서 실제 WebView2의 시드42·4환경 선택, Space는 물기/높이0, ↑ 점프, ↓ 빠른 밟기/착지, 정지 시 장면 동결 확인. 기존6종 게임·기록/탭/동일 로컬 PowerShell PTY 유지 및 ArrowDown/S를 포함한 게임 키가 `Read-Host`로 섞이지 않음 확인. 화면 `target/verification/adventure-native.png`. 테스트 소유 앱은 finally 정리. 실제 SSH/Mac 결과로 대체하지 않는다.
- 빌드/검사 중 문제와 해결: 최초 frontendDist를 Windows 절대 경로로 지정하니 file URL로 처리되어 내장 앱 페이지 검사2회 실패했다. `../target/adventure-web` 상대 경로로 수정하고 debug 재빌드(38.95초)·별도 EXE 복사 후 통과. 잘못된 config로 대기 중이던 **이 작업 소유 release 프로세스만 종료**한 뒤 올바른 config로 재시작했다. 이후 native의 간식 이동 기대 좌표 변화가 없어1회 실패했으며, 캡처 뒤 테스트 앱 재활성·필요 시 명시적 재개·게임판 포커스를 확보하게 검사 코드를 보강한 전체 재실행이 종료0. 제품의 자동 정지 계약은 유지했다.
- 최종 코드 검증: 변경 뒤 `npm test`53개 통과, lint·Prettier 최종 확인. `npm run build`의 tsc+Vite 통과, 기존500KB 메인 번들 경고 유지. Rust/IPC/권한 변경은 없으므로 Rust 단위/clippy·SSH 엔진 회귀를 이번에 재실행하지 않았다.
- 미검증/남은 ID: **G.6 Mac 실기기**, **G.6 물리 멀티터치**, **G.6 실제 SSH 배경 입력 격리 재검증**, **G.6/5.3 최신 설치 패키지**. 환경 부재/요청 범위 내 로컬 PTY 검증으로 대기한다. 모든 가능한 시드를 전수 플레이했다고 주장하지 않으며 자동 검증 범위는800맵 제약·20맵 입력 완주다. 기존 Phase 상태는 유지한다.
- 다음 첫 행동: 최신 `target/release/daxterm.exe` 실행 → 게임 → 닥스의 모험. Space 물기·↑ 점프·공중 ↓ 밟기로 플레이하고, 정지 후 맵 선택에서 시드42/4환경을 재현한다. 후속은 물리 터치/Mac/실제 SSH, 배포 시 최신 설치 패키지 검사다.
- 안전거리 최종 보정: 쉼터와 순찰 적의 중심 거리에서 순찰 범위를 빼도 충돌 반경43보다 크도록 일반 적 위치를 조각 시작+80, 멧돼지+100/범위40으로 제한했다. 800맵 모두 해당 조건을 검사하도록 추가하고 규칙13개·20맵 입력 완주 재통과. 최종 랜덤 UI4개(시드/4환경/Space·밟기/완주→다음 구간)도 다시 전부 통과. 같은 자산으로 debug 재빌드 종료0(45.78초), 마지막 release에 이 보정도 포함한다.

- 최종 산출물: 안전거리 보정판의 native 전체 검사 재실행도 종료0. 최종 release `npm run tauri -- build --no-bundle --config target/adventure-tauri.json` 종료0(5분00초). `target/release/daxterm.exe`와 동일 해시 보관본 `target/verification/daxterm-adventure.exe`: 2026-11-05 13:25:27 KST, 28859392바이트, SHA256 0A52B3621104C5508801E155CDB287D4FF72D9DB53F23ECC603391504AF88920. G.5 간식 개선도 함께 포함한다. 실제 동작 검사는 같은 최종 자산의 별도 debug EXE 기준이며 release 자체 실행 검사를 추가한 것은 아니다. 기존 NSIS 설치본은 재생성하지 않았다.

## GitHub 원격 연결 (2026-11-05)

- `git init -b main`으로 로컬 저장소를 만들고 `origin`을 `https://github.com/splatoon-git/daxterm-workspace.git`으로 설정했다. 설정 파일은 `.git/config`다.
- `git remote -v`와 `git status -sb --untracked-files=no`로 fetch/push URL과 초기 브랜치를 확인했다. `git -c credential.helper='!gh auth git-credential' ls-remote --symref origin`은 종료 0이며 원격 ref는 없었다. `gh repo view`에서 공개 저장소임을 확인했다.
- 커밋과 푸시는 연결 요청 범위 밖으로 미실행했다. 제품 작업 ID와 다음 행동은 각 Phase 기록을 따른다. 소스 게시를 요청받으면 먼저 공개 대상 파일과 제외 규칙을 확인한다.

## 초기 Git 커밋 (2026-11-05)

- 초기 스냅샷을 네이티브 코어·의존성(`56ac994`), 데스크톱 UI·테마·게임(`6c42960`), 회귀 검사·Windows CI(`88e1069`), 문서로 나눴다. 문서 커밋에 `AGENTS.md`, `README.md`, `docs/`를 포함했다.
- `npm run typecheck`, `npm run lint`, `npm test -- --maxWorkers=1`(53개), `cargo metadata --locked --no-deps --format-version 1` 통과. `git check-ignore`로 빌드·테스트 산출물, 로컬 도구, 환경 파일 제외를 확인했다. `git diff --cached --check`는 기존 라이선스 고지, Cargo 매니페스트와 일부 Markdown 문서의 공백을 보고했으며 원본을 보존했다.
- 이번 작업에서는 제품 빌드, Windows 네이티브, Mac, 실제 SSH 검증을 재실행하지 않았다. 기존 작업 ID와 다음 행동은 각 Phase 기록을 따른다. 커밋은 로컬 `main`에 있으며 공개 원격 푸시는 게시 요청 시 별도로 진행한다.




## G.7 — 보스전·타격감·맵 표현·키보드 진행 (2026-11-05, 구현·Windows 검증·release 빌드 완료)

- 요청: 보스전, 물기/밟기 타격감, 맵 표현 향상, Space 시작/다음 스테이지를 포함한 키보드 전용 진행. G.6 생성기/물리와 G.5 공유 마스코트·간식 구현을 유지해 확장했다.
- 파일: `src/features/games/{adventureLevels.ts,adventureEngine.ts,AdventureGame.tsx,AdventureWorld.tsx,adventureAudio.ts,games.css,adventureEngine.test.ts}`, `tests/ui/adventure-random.spec.ts`, `scripts/verify-adventure-native.mjs`, `docs/roadmap.md` G.7.
- 보스: 월드4,780·출구4,640, 전장3,650~4,460와 직전쉼터3,550. 네 환경 수호자 외형/이름·체력8, 예고→돌진/도약→회복, 절반 체력 시 빨라지는 돌진. 물기1/머리 밟기2·짧은 무적·공격별 중복 피해 제한, 처치500점/체력2 회복, 전장 양쪽 잠금과 처치 후 출구 개방. 사망 Space는 마지막 쉼터·체력5·미처치 보스 초기화, 기존 점수/획득/스위치 유지. 같은 맵 처음부터 재시작 버튼은 별도 유지.
- 타격/입력: 물기45ms·밟기75ms 물리 정지, 예약 입력 보존·정지/blur 시 예약 제거, 반동/불꽃/명중 문구/화면 진동. 사용자 동작 후 Web Audio 합성 단발 효과음, M 음소거, 정지/비활성 시 suspend·unmount close. 모션 줄이기는 진동/충격 광선 생략. Space 준비→시작/정지→재개/클리어→다음 즉시 시작/사망→쉼터 재도전, P 정지/재개. repeat는 전환/공격 중복 방지. 기존 게임판 포커스 및 터미널 입력 격리 유지, 새 IPC/네트워크/의존성 없음.
- 맵 표현: 토큰 기반 그라데이션 하늘/광원·다중 원근, 큰 나무/유적 아치·물길/수정/눈 덮인 전나무, 지면 덮개·돌 질감/발판 두께/보스 기둥·문양/체력 HUD. 기존 닥스 atlas 유지. `target/verification/adventure-{forest,ruins,cave,snow}-{1280,360}.png`, `adventure-boss.png`, `adventure-stomp.png`, `adventure-next-stage.png` 생성. 숲·보스·360px 동굴 화면 직접 확인.
- 현재 통과: `npm test -- --maxWorkers=1` 전체56개(모험16개), 800맵 생성 제약과20맵 보스 포함 일반 조작 완주. `npm run typecheck`, 전체lint, frontend build 통과(기존500KB 메인 번들 경고 유지). `npx playwright test --config target/playwright-adventure.config.ts tests/ui/adventure-random.spec.ts tests/ui/dachs-games.spec.ts tests/ui/games.spec.ts --workers=2` 16개 통과: 키보드 시작/보스 처치/다음 즉시 시작·반복 억제·정지/재개·음소거/모션 줄이기 및 기존 게임/테마/포인터/탭 회귀.
- 검증 중 발견: 추가 사망/Space 재도전 UI 검사는 lazy 게임판 준비 전 키를 전송해 시작하지 못했고1회 실패했다. 게임판 자동 포커스 확인을 기다린 후 입력하게 수정해 재실행 중이다. 정지 중 타격 예약 입력까지 지우도록 최종 보강 후 frontend+native debug를 다시 빌드 중이다.
- 남은 ID: **G.7 Windows native/최종 release** 실행 중, **G.7 Mac·물리 멀티터치·실제 SSH·NSIS 설치본** 미실행 대기. 이번 로컬/브라우저 결과를 실제 SSH/Mac 결과로 대체하지 않는다. 다음 첫 행동: 진행 중 UI/빌드 결과 확인 → 같은 자산 debug EXE 실제 WebView2·로컬 PTY 검사 → 최종 release와 결과/해시 기록.
- 후속 확인: 사망/Space 쉼터 재도전 UI 통과(총 고유 UI17개). 최종 입력 정리를 Effect 안 setState에서 재개 첫 tick의 예약 제거로 변경해 React set-state-in-effect 린트 오류를 해결했다. 최종 변경 파일 ESLint 종료0, 밟기/키보드 시작·정지·재개/사망 재도전 UI3개 재통과. 최신 frontend build 종료0 후 같은 자산으로 debug 재빌드 중이다.
- Windows 실제 검증: 최종 debug 재빌드 종료0(51.07초), `DACHSTERM_TEST_BINARY=target/verification/daxterm-adventure-debug.exe`로 `node scripts/test-games-native.mjs` **종료0**. 실제 WebView2에서4환경/시드42·Space 시작(공격 오발 없음)/물기·↑점프·↓밟기·P 정지/Space 재개, 기존6종게임·기록·탭 복귀, 실제 로컬 PowerShell PTY 유지와 게임 키 입력 격리를 확인했다. 보스 완주는 엔진20맵·브라우저 실조작 결과이며 native에서 보스까지 완주했다고 주장하지 않는다. 테스트 앱은 finally에서 종료했다. `target/verification/adventure-native.png` 저장.
- 사용 설명: `README.md`의 쉼터 수를3곳으로 갱신하고 보스/Space 전체 흐름·P/M·쉼터 재도전과 맵 처음부터 재시작의 차이를 기록했다. Rust/IPC/권한 변경 없음. 같은 최종 자산을 사용하는 release 빌드 진행 중이며 Mac/물리 터치/실제 SSH/설치 패키지는 위 대기 상태다.


- 최종 산출물: `npm run tauri -- build --no-bundle --config target/adventure-tauri.json` **종료0**, 최적화 빌드12분12초. `target/release/daxterm.exe`와 보관본 `target/verification/daxterm-adventure.exe` 해시 일치: 2026-11-05 14:16:06 KST, 29,264,896바이트, SHA256 **975FD934394673713C9FC120ECD5AF01C7A8718F4E17447D0C6054CE80C18C3E**. 최종 입력 정리 수정까지 포함한 내장 자산이다. Windows 동작 검증은 동일 최종 자산의 debug EXE 기준이며 release 자체 실행 검사는 별도로 하지 않았다. G.5 간식 개선도 포함한다.
- 최종 검증 상태: 규칙56개·고유 게임 UI17개·실제 Windows WebView2/로컬 PTY 검사 통과. 마지막 입력 정리 수정 후 관련 UI3개 및 해당 파일 ESLint, frontend build를 재통과했다. 변경 파일 Prettier 및 `git diff --check` 종료0. 실패한 사망 UI의 초기 포커스 대기와 Effect setState 린트 문제는 위와 같이 수정·재검증했다. 문서의 기존 초기 Git 기록과 다른 Phase 상태는 보존했다.
- 남은 ID/미검증: **G.7 Mac 실기기**, **G.7 물리 멀티터치**, **G.7 실제 SSH 배경 입력 격리 재검증**, **G.7/5.3 최신 NSIS 설치본**. 해당 환경 부재 및 이번 Windows 로컬 검증 범위로 대기한다. Rust/IPC/권한 코드는 바꾸지 않아 Rust 단위/clippy/SSH 엔진 회귀는 재실행하지 않았다.
- 다음 첫 행동: 최신 `target/release/daxterm.exe` 실행 → 게임 → 닥스의 모험 → Space. ←/→ 이동·↑ 점프·Space 물기·공중 ↓ 밟기, P 정지/재개·M 효과음. 보스를 처치하고 출구에 도착하면 Space로 다음 스테이지가 즉시 시작되며 사망하면 Space로 마지막 쉼터에서 재도전한다. 후속 환경 검증/배포를 진행할 때 Mac·물리 터치·실제 SSH·최신 설치 패키지부터 확인한다.

## GitHub main 푸시 (2026-11-05)

- 사용자 요청에 따라 초기 커밋 4개를 그대로 `origin/main`에 푸시했다. 최종 커밋은 `e9410ddb45c1d14a7b18b4431be0496e8157dbcb`다.
- `git ls-remote --heads origin refs/heads/main`에서 원격 SHA 일치를 확인했고 `git rev-list --count origin/main`은 4다. 로컬 `main`의 upstream을 `origin/main`으로 설정했다.
- 이후 G.7 작업의 수정/미추적 파일은 작업 트리에 있으며 이번 푸시 대상은 기존 4개 커밋이다. 이 진행 기록은 로컬 변경으로 남겼다. 제품 검증은 이번 Git 전송 작업에서 재실행하지 않았으며 남은 작업 ID와 다음 첫 행동은 G.7 기록을 따른다.

## G.7 변경 분리 커밋·푸시 (2026-11-05)

- 사용자 요청에 따라 남은 변경을 보스전/쉼터 엔진·규칙 검사(`b800773`), 화면·효과음·키보드 조작(`05cacb1`), 브라우저/native 회귀 검사(`b692582`), README·roadmap·progress 문서로 나눠 커밋했다. 원격 대상은 `origin/main`이다.
- 최초 `npm run typecheck`가 Node Zone Allocation 메모리 오류로 종료134였다. `node --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit`, 같은 옵션의 `node_modules/eslint/bin/eslint.js .`, `node_modules/vitest/vitest.mjs run src --maxWorkers=1`로 순차 재실행해 모두 종료0, 테스트56개 통과했다. 변경 파일 인증정보 패턴 일치0건, `git diff --check` 통과.
- 이번 커밋 작업에서 Windows native/UI·release 빌드·Mac·실제 SSH 검사를 재실행하지 않았다. G.7의 기존 실제 검증 결과와 미검증 이유는 위 기록을 따른다. 남은 작업 ID는 G.7 Mac·물리 멀티터치·실제 SSH, G.7/5.3 최신 NSIS다.
- Git 전송 확인은 `git ls-remote --heads origin refs/heads/main`과 로컬 `git rev-parse HEAD` 비교, `git status -sb`로 수행한다. 제품 작업의 다음 첫 행동은 G.7 기록의 최신 실행 파일 확인이다.

## G.8.0 — 닥스의 서바이버 설계 (2026-11-05, 설계안 작성 완료)

- 사용자 요청: 먼저 설계. 서바이버류 로그라이크에 HP·경험치·골드·레벨업 랜덤 능력 카드를 포함한다. 후속 답변으로 **5분 생존 + 최종 보스**, **골드 영구 강화·해금**을 확정했다. 제품 구현은 이번 요청 범위에 포함하지 않는다.
- 파일: `docs/design/dachs-survivor.md` 신규 설계안, `docs/roadmap.md` §11 G.8 범위/순서/완료 기준, 이 진행 기록. `catalog.ts`, `GamePane.tsx`, `shared.tsx`, `AdventureGame.tsx`, `DachsSprite.tsx`, `src/app/App.tsx`의 게임 연결 지점을 읽어 기존 6종·탭 보존·포커스·마스코트 계약을 확인했다.
- 설계 내용: 이동·자동 공격, HP/피격/무적, XP 곡선·연속 레벨업, 랜덤 3장 중 1장·무기/능력 각 4슬롯·다시 뽑기·진화, 5분 구간별 적/정예/최종 보스, 사망 시 수집 골드 보존, 영구 구매·환불·해금, 5초 체크포인트·중복 정산 방지·여러 창 소유권, 화면/키보드/테마/Canvas 성능 설계. 무기 6·능력 8·진화 3 등 콘텐츠 수와 상세 수치는 설계 제안이며 밸런스 실증값이 아니다.
- 실제 문서 검증: `git diff --check` 종료 0. PowerShell로 변경 3문서의 로컬 링크 **25개**를 확인하고 신규 설계 문서 후행 공백 **0개**를 확인했다. JavaScript로 XP 식의 누적 값을 검산해 레벨 16/20/22에 각각 **657/1152/1471 XP**, 5분 기본 생성 예산 **600마리**(상한·스킵 전), 영구 HP/공격/수집/골드 강화 전체 비용 **460/575/190/290**을 확인했다. 수치 산술 검산이며 실제 플레이 성공이나 밸런스 검증이 아니다.
- 검토 보완: 단일 숫자용 기존 `useBest`를 재화 저장에 사용하지 않도록 분리했다. 앱 재시작 시 전투 복원과 체크포인트 골드 회수를 구분했고, 오래된 종료 이벤트의 재지급을 막는 runId 조건·실제 지불액 기준 강화 환불을 명시했다. 현재 atlas가 8방향 이미지라고 가정하지 않는다.
- 미실행/이유: 소스·빌드 설정을 바꾸지 않은 설계 작업이므로 제품 타입/린트/테스트/빌드·브라우저/Windows native·실제 SSH·Mac·물리 터치·설치본 검증을 새로 실행하지 않았다. Web Locks 지원·60fps 목표·첫 판 난이도·골드 수익은 구현 단계의 확인 항목이며 성공으로 기록하지 않는다. 기존 Phase 및 G.7 검증 상태를 변경하지 않는다.
- 남은 ID: **G.8.1~G.8.6 전부 미착수**. 다음 첫 행동: 설계 수정 요청은 이 설계안과 roadmap을 함께 갱신한다. 구현 요청을 받으면 G.8.1의 `survivor/types.ts`, `content.ts`, `engine.ts`부터 고정 시간 이동·물기·슬라임·HP·XP를 만들고 후속 작업을 순서대로 이어간다.

## G.8.1 — 닥스의 서바이버 전투/HP/XP (2026-11-05, 엔진 구현·규칙 검증 완료)

- 요청 범위: G.8.1만 구현. 위 G.8.0의 미착수 상태를 이번 기록으로 갱신한다. G.8 전체 완료가 아니며 실제 게임 메뉴/화면 연결은 G.8.5다. 기존 설계 문서 변경과 다른 게임/터미널 코드는 보존했다.
- 파일: `src/features/games/survivor/{types.ts,content.ts,random.ts,spatial.ts,engine.ts,engine.test.ts}` 신규. `docs/roadmap.md` G.8, `docs/design/dachs-survivor.md`의 현재 범위/좌표/피격/엔진 연결 계약, 이 진행 기록 갱신. 추가 패키지·IPC·네트워크·Rust·게임 카탈로그 변경 없음.
- 전투: 변경 가능한 런을 ref로 소유하는 구조, 60Hz 고정 틱과 부분 틱 누적/한 프레임 최대 5틱/초과 지연 폐기. 축/대각 이동 210, 월드 3200×3200·논리 전장 960×540, 원형 충돌/월드·카메라 경계. 기본 물기 피해 18·반경 90·120도·51틱 주기, 가까운 적/동률 작은 ID 표적·한 공격당 단발 명중. 슬라임 HP24/속도70/피해10/XP3 추적, 75틱마다 안전한 화면 밖 초기 스폰. 5분 구간 확장은 후속이다.
- HP/XP: HP100·방어 최소 피해1·45틱 공통 접촉 무적·감쇠 반동/이동 유지·HP0 종료. 같은 틱에서 사망을 XP 수집/선택보다 먼저 확정한다. XP는 수집 반경64·소수 잔여·설계 비용 곡선·레벨40 상한. 연속 레벨업은 `pendingChoices`에 쌓아 `choosing`에서 정지한다. 정지/재개는 선택 상태도 보존하며 카드 적용 자체는 G.8.2다.
- 자원/재현: 스폰/드롭/카드별 시드 난수 분리(현재는 스폰만 소비), 공간 격자로 충돌 후보 제한, 일반 적180/XP 드롭250 상한·근접 결정 병합으로 XP 총량 보존·제거 객체 재사용. 렌더링/저장 형식과 런 데이터를 분리한다. 이 구현은 실제 메모리/프레임 성능 통과 기록이 아니다.
- 실제 검증: `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src/features/games/survivor --maxWorkers=1` **21개 통과**. 정상/8방향/부분 입력/월드 경계·비정상 시간, 30/60/120Hz 전체 상태 일치·최대5틱/정지, 추적/겹침, 물기 표적/부채꼴 경계/중복/주기, 무적/방어/사망 우선, XP 이월/연속 레벨/상한/병합, 100시드×중앙/4모서리 **500개 스폰 경계 조합**, 적 상한과 난수 스트림 격리 확인. 시드0/42/4294967295의 초기 런에서 상태 보정 없이 일반 이동·자동 공격으로 첫 레벨업에 도달했다. 자동 입력 검증이며 재미/첫 판 클리어/5분 밸런스의 수동 플레이 결과가 아니다.
- 전체 검증: `node --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit`, `node --max-old-space-size=1024 node_modules/eslint/bin/eslint.js .` **종료0**. `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src --maxWorkers=1` **7파일/77개 통과**(기존56+신규21). `NODE_OPTIONS=--max-old-space-size=1024`로 `npm run build` **종료0**, 기존 메인 번들 500KB 경고 유지. 신규 소스 Prettier와 `git diff --check` 통과. PowerShell로 변경 3문서의 로컬 Markdown 링크 **26개**가 실제 파일을 가리키는 것도 확인했다.
- 미실행/이유: UI와 카탈로그에 연결하지 않은 순수 엔진 단계라 브라우저/Windows WebView2/실제 로컬 PTY·SSH 입력 격리·Mac·물리 터치 검증 및 native debug/release/NSIS 빌드는 실행하지 않았다. 기존 실행 파일은 이번 엔진을 포함한 플레이용 빌드가 아니다. Rust/IPC 변경이 없어 Rust 단위/clippy·SSH 엔진 검사를 재실행하지 않았다. 실환경 결과는 G.8.5/G.8.6 및 기존 대기 ID로 남긴다.
- 남은 ID: **G.8.2 카드·6무기·8능력·3진화·다시 뽑기**, **G.8.3 5분·적·보스·골드/회복 드롭**, **G.8.4 영구 성장·저장/복구**, **G.8.5 화면/탭/입력**, **G.8.6 밸런스/성능/실환경/산출물**. 기존 Phase·G.7의 환경 대기 상태는 변경하지 않는다.
- 다음 첫 행동: G.8.2 요청 시 `survivor/types.ts`, `content.ts`, `engine.ts`와 설계안 §5~6을 읽고 `progression.ts`에 슬롯/랭크/해금 조건에 맞는 카드 후보·독립 cards 스트림 추첨을 구현한다. 실제 카드 적용 → `pendingChoices` 1 감소 → 잔여 선택 후보 재생성 → 모두 선택 후 `playing` 복귀를 연결하고 6무기·능력·진화를 순서대로 확장한다. 임시 선택 건너뛰기나 `useBest` 골드 저장을 추가하지 않는다.

## G.8.2 — 닥스의 서바이버 카드·무기·진화 (2026-11-05, 엔진 구현·규칙 검증 완료)

- 요청 범위: **G.8.2만 구현**. 이전 G.8.1 기록의 카드 대기를 이번 기록으로 갱신한다. G.8 전체 완료가 아니며 화면/게임 목록 연결은 G.8.5다. 기존 미커밋 G.8.0/G.8.1 문서·엔진을 이어 수정했고 다른 게임·터미널·Rust/IPC·의존성은 변경하지 않았다.
- 파일: `src/features/games/survivor/{progression.ts,weapons.ts,progression.test.ts,weapons.test.ts}` 신규. 기존 `{types.ts,content.ts,engine.ts,spatial.ts}` 확장. `docs/roadmap.md` G.8.2 범위, `docs/design/dachs-survivor.md` §6 전투 계산/§10 연결 계약과 이 진행 기록 갱신. 설계 §9의 이전 월드/시야 제안도 실제 §3 엔진과 같은3200×3200/960×540으로 맞췄다.
- 카드: 독립 cards 난수로 중복 없는 최대3장·보유 강화/진화1장 및 초반 새무기1장 보장, 무기/능력 각각4슬롯·일반랭크5·기본4무기/옵션해금2무기 제한. 유효 후보 부족 시 최대HP25% 회복/골드8 보상, 만피·완전 소진이면 골드만으로도 진행. 선택지에 이전/이후 랭크와 실제 수치 변화를 제공한다. `chooseSurvivorCard(run, choiceId, cardId)`가 실제 적용 후 대기1개 차감·후속 후보 재생성·최종playing 복귀를 처리한다. 정지 중/존재하지 않는 카드/과거 화면/중복 선택은 무변경 거부. 다시 뽑기는 기본1회·옵션해금2회, 새화면 ID로 이전 입력 무효화. 키보드 repeat/keyup 처리는 G.8.5에 남아 있다.
- 능력/골드: 이빨·꼬리·심장·털·발·코·경험치·행운8종을 초기 보너스와 가산해 재계산한다. 이동/주기감소50% 상한, 심장만 늘어난HP만큼 즉시 회복. `newSurvivor(seed, options)`가 해금·다시 뽑기·시작 보너스를 받아 G.8.4 연결 준비. `run.gold`는 소수 잔여를 보존하며 골드카드와 `collectSurvivorGold`는 현재 보너스만 적용한다. 구매·잔액 저장·영구 정산은 구현하지 않았고 `useBest`도 사용하지 않는다.
- 무기/진화: 물기 부채꼴·왕와앙180도/반경150, 부메랑 다중발사/편도별단발·황금뼈 귀환30틱 후 추가왕복, 확장파동/넉백·사자후24틱 후 추가파동, 반경95 수호공1~3개·공 전체 공통30틱 재피격, 장판180/240틱·겹친영역 중 큰 피해를 공통30틱마다, 도토리 서로 다른 표적위치1~3곳 고정/30틱 예고/단발폭발. 모든 무기 랭크1~5 피해 배율과 추가 효과 적용. 진화는 전투10800틱·무기5/대응능력3·최대2개이며 카드 선택으로만 발동한다. 반복 진화는 새 공격ID를 받는다.
- 자원/정지: 공격 객체240상한(수호공·예고·추가발동 대기 포함), 상한 발사는 생략하고 밀린 공격을 예약하지 않는다. 종류별 공격 객체 풀과 적 공간 격자를 사용하며 최대 적 반경도 검색에 반영한다. 부메랑은 이동 선분 충돌, 수호공의 랭크 상승 재배치에는 순간 경로 피해를 주지 않는다. 무기 공격/예고/추가발동/피해간격은 모두 고정 틱이라 카드 선택과 정지에서 멈춘다. 원래 엔진의 사망 우선·처치/XP1회·적 재사용 시 필드 초기화를 유지했다. 콘텐츠 버전은2이며 영구 저장 스키마와 별개다.
- 실제 검증: `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src/features/games/survivor --maxWorkers=1` **53개 통과**(G.8.1 21개+신규32개). 초기/다시뽑기500시드·슬롯/랭크/해금·후보0/1/2개·만피/회복·진화 경계와2개상한·과거/중복 입력·정지 보존·39회 연속 실제카드선택·8능력/실제변화량·골드소수/비소급·각무기/반복공격/넉백면역/공통피해간격/상한/재사용·두4무기 조합30/60/120Hz 전체 상태 일치를 확인했다. 시드0/42/4294967295에서 상태 보정 없이 이동·자동공격·실제추첨카드 선택으로 각각 최소3회 선택/10처치를 달성했다(최대90초 또는 사망까지 자동 입력). 재미·5분완주·수동플레이 검증이 아니다.
- 최종 전체 검증: `node --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit`, `node --max-old-space-size=1024 node_modules/eslint/bin/eslint.js .` **종료0**. `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src --maxWorkers=1` **9파일/109개 통과**. PowerShell에서 `$env:NODE_OPTIONS='--max-old-space-size=1024'` 후 `npm run build` **종료0**, 기존 메인번들500KB 경고 유지. 변경 소스 Prettier와 문서/공백 검사는 아래 최종 확인을 따른다.
- 미실행/이유: 순수 엔진 범위이고 화면/카탈로그에 아직 연결하지 않아 브라우저·Windows WebView2·로컬PTY/실제SSH 입력격리·Mac·물리터치, native debug/release/NSIS 빌드를 실행하지 않았다. 이번 frontend build는 타입/기존 앱 번들 빌드 성공이며 서바이버 플레이용 실행 파일을 만든 것이 아니다. Rust/IPC 미변경으로 Rust 단위/clippy/SSH 회귀도 재실행하지 않았다. 프레임p95/반복10판 메모리/재미·밸런스 실증은 G.8.6에 남는다.
- 남은 ID: **G.8.3 5분·일반적5/정예2/최종보스·골드/회복드롭·승패**, **G.8.4 영구강화/해금/구매환불·소유권/저장복구/정산**, **G.8.5 게임탭·Canvas/HUD/카드UI·입력/음향**, **G.8.6 밸런스/성능/실환경/산출물**. 기존 Phase와 G.7 환경 대기 상태는 유지한다.
- 다음 첫 행동: G.8.3 요청 시 설계 §7~8과 `types.ts`/`content.ts`/`engine.ts`를 읽고 적 종류/행동 및 분단위 생성 흐름부터 확장한다. 생성 시 구간 배율 고정·정예별도상한·5분 전환에서 적/적탄만 제거·보스넉백면역·사망우선/보상1회·카드선택 후 구간전환을 지킨다. 골드/회복 드롭 추가 시 종류별 가치보존 병합과 재사용 필드 초기화를 확장하고 카드/무기 회귀53개를 유지한다.
- 최종 문서/형식 확인: `node --max-old-space-size=1024 node_modules/prettier/bin/prettier.cjs --check src/features/games/survivor/*.ts`와 `git diff --check` **종료0**. Python으로 변경3문서의 로컬 Markdown 링크 **26개** 실파일 확인, 서바이버소스10개+설계안의 후행공백 **0개** 확인. 소스/설계안은 기존 작업부터 미추적 상태이며 이번 요청에서 커밋·푸시하지 않았다.

## G.8.3 범위 확인 — 연속 스테이지 전환 (2026-11-05)

- 사용자 확인: 현재 G.8.2까지 완료했고, 앞서 논의한 연속 스테이지 구조가 G.8.3 수정 범위인지 질문했다. 기존 G.8.2 완료 기록과 실제 `survivor/{types.ts,content.ts,engine.ts,progression.ts}`를 읽어 대조했다. 이번에는 제품 코드를 수정하거나 G.8.3 구현을 시작하지 않았다.
- 범위 판단: 스테이지별 시간·생성 흐름·적/정예/보스·보스 처치 후 다음 스테이지·난이도 상승은 **G.8.3**이다. G.8.1/G.8.2의 이동·HP·XP·카드·무기·진화 구현은 재사용한다. 새 스테이지에서 `newSurvivor`로 런을 초기화하지 않고 레벨/XP/HP/무기/카드/골드/남은 다시 뽑기를 유지해야 한다.
- 연결 주의: 현재 진화 조건은 `EVOLUTION_TICK = 180 * 60`과 `run.tick`의 누적 전투 시간이다. G.8.3에서 누적 tick을 보존하고 별도 스테이지 시간을 두면 이 조건과 기존 공격 타이머를 유지할 수 있다. 레벨40/랭크5/진화2개 상한은 현재 구현이며 연속 진행에서의 성장 지속성과 난이도는 G.8.6 밸런스 확인 대상이다.
- 후속 영향: **G.8.4**는 보스/스테이지 보상과 판 종료 영구 정산을 분리하고 중복 지급을 막아야 한다. **G.8.5**는 스테이지 번호/남은 시간/구간 통과 화면을 연결한다. 보스 처치를 곧바로 전체 런의 `result`로 처리하지 않는다.
- 최신 방향은 스테이지 연속 진행이다. **일반 스테이지60초·3스테이지마다 보스30~60초**는 이 대화에서 제안한 초기안이며 사용자 수치 확정 또는 플레이 검증으로 기록하지 않는다. roadmap/상세 설계의 기존 **5분→최종 보스→판 종료** 내용은 후속 정정 대상이다. 기존 G.8.2 기록은 당시 구현 근거로 보존한다.
- 실제 검증: 문서/코드 검색과 읽기, `git diff --check`만 수행했다. 제품 테스트·빌드·UI/native·실제 SSH/Mac 검사는 범위 확인 및 진행 기록만 변경했으므로 재실행하지 않았다. 남은 ID는 **G.8.3~G.8.6**. 다음 첫 행동: G.8.3 구현 요청 시 roadmap/설계의 시간·종료·보상 규칙을 연속 스테이지 기준으로 먼저 정합화하고 누적 시간과 스테이지 시간을 분리한다. 기존 카드/무기 회귀를 유지한다.

## 서바이버 변경 분리 커밋 (2026-11-05)

- 사용자 요청으로 미커밋 변경을 설계/로드맵(`5e56aaf`), G.8.1 기본 전투·HP·XP와 규칙 검사(`921fe15`), G.8.2 카드·무기·진화와 규칙 검사(`828aefa`), G.8.3 연속 스테이지 범위/인계 기록으로 분리했다. 로컬 `main`에 커밋하며 이번 요청에서는 원격 푸시하지 않는다.
- 파일: `docs/{roadmap.md,progress.md,design/dachs-survivor.md}`, `src/features/games/survivor/`의10개 TypeScript 파일. G.8.1 분리본은 무시되는 `target/survivor-split/g81`에서 준비해 인덱스에만 반영했다. 최종 작업 파일은 유지했으며 SHA256 비교로 설계/로드맵·제품 소스가 분리 시작 전과 동일함을 확인했다. 진행 기록에 이번 Git 작업만 추가했다.
- 이번 검증: `node --max-old-space-size=1024 node_modules/typescript/bin/tsc --project target/survivor-split/g81/tsconfig.json --noEmit` 종료0, `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run target/survivor-split/g81/engine.test.ts --maxWorkers=1` **21개 통과**. 각 커밋의 `git diff --cached --check` 통과. 최종 G.8.2 소스는 위 구현 세션에서 전체109개·타입·전체린트·frontend build를 통과한 내용과 같아 다시 실행하지 않았다.
- 미실행/남은 항목: native/release/NSIS·브라우저·실제SSH/Mac/물리터치 검사를 이번 Git 작업에서 추가 실행하지 않았다. 남은 ID는 **G.8.3~G.8.6**, 다음 첫 행동은 바로 위 연속 스테이지 범위 기록에 따라 roadmap/설계를 정합화한 뒤 G.8.3을 구현하는 것이다.

## G.8 연속 스테이지 설계 정정 완료 (2026-11-05)

- 요청: 설계 수정이 모두 끝났는지 확인. 직전에는 범위 확인만 기록되어 있었으므로 이번에 **상세 설계와 roadmap의 실제 내용을 전부 정합화**했다. 위 G.8.0/G.8.1/G.8.2 및 범위 확인 기록에 남은 기존 시간·전체 클리어 설계와 후속 정정 예정 문구는 당시 이력이다. 최신 설계와 다음 행동은 이 기록을 따른다.
- 변경 파일: `docs/design/dachs-survivor.md`, `docs/roadmap.md`, `docs/progress.md`만 수정했다. 완료된 G.8.1~G.8.2 소스10개는 작업 전후 SHA256 목록이 모두 일치한다. G.8.3 제품 코드를 구현하거나 기존 구현 완료 상태를 되돌리지 않았다.
- 진행 구조: 매 스테이지 일반 전투60초, 3/6/9… 구간에서 추가 보스전, 생존 또는 보스 처치 후 통과 화면에서 다음 구간/마무리 선택. 도전은 사망·마무리·포기 때만 종료한다. 60초/보스 목표30~60초·난이도·수익 수치는 초기 설계값이며 사용자 수치 확정이나 실플레이 통과를 의미하지 않는다.
- 상태/성장: HP·레벨/잔여XP·무기/카드/진화·골드·다시뽑기·드롭·공격 타이머·난수/ID·누적tick 유지, 스테이지 전투 시간/이벤트만 분리. 누적3분 진화 조건과 레벨40/랭크5/진화2개 상한 유지. 구간 경계+연속 카드 선택 시 추가 전투 틱 없이 전환하고 과거 다음 구간 입력을 거부하도록 명시했다. 목표 충족 시 통과 기록을 확정해 카드 선택 중 체크포인트와 보스 보상이 불일치하지 않게 했다.
- 보상/저장: 보스당40·프로필 첫 보스30, 수집 골드의 소수 합계와 고정 보상을 분리한다. 구간 통과는 체크포인트만 저장하고 도전 종료 때 잔액/기록/첫 보스 플래그를 함께 정산한다. 보스 보상은 런/스테이지당1회, 종료 정산은runId당1회이며 중단 복구도 같은 규칙이다. 스테이지·보스·마무리 UI와 G.8.3~G.8.6 검증 기준까지 수정했다.
- 실제 문서 검증: `git diff --check` 통과. PowerShell로 문서3개의 로컬 Markdown 링크 **27개** 실파일 확인, 상세 설계 후행공백0개, 상세 설계와 roadmap G.8의 폐기된 시간/최종 종료 표현 검색0개를 확인했다. 다른 README/문서에 별도 서바이버 설계 참조는 검색되지 않았다. JavaScript로60초=3600틱/경고1.5초=90틱/누적3분=10800틱, 스테이지1~10의 보스3/6/9·정예2/4/8/10, 보상 예시 `floor(25.75) + 2×40 + 30 = 135`를 검산했다. 이는 설계 산술 확인이며 제품 동작 검증이 아니다.
- 미실행/이유: 제품 코드를 변경하지 않아 타입/린트/단위/브라우저/native/SSH/Mac/빌드/설치본 검증을 재실행하지 않았다. G.8.2의 기존 테스트109개 기록은 이전 실제 결과로 보존하며 이번 성공으로 집계하지 않는다. 시간·보스HP·스폰·장기 상한/수익은 후속 플레이 검증이 필요하다.
- 남은 ID: **G.8.3~G.8.6 구현/검증 미착수**. 다음 첫 행동: G.8.3 요청 시 수정 설계 §7~8/§10을 읽고 `types.ts`에 스테이지 상태/예약 전환/보상 합계를, `content.ts`에 구간/적/보스 데이터를, `engine.ts`에 누적tick을 보존하는 구간 전환을 추가한다. 기존 카드/무기 회귀를 유지하고3/6 보스 처치 후4/7 진입까지 검사한다. 기존 Phase·G.7의 환경 대기는 유지한다.

## G.8.3 — 닥스의 서바이버 연속 스테이지·적/보스·드롭 (2026-11-05, 엔진 구현·규칙 검증 완료)

- 요청 범위: **G.8.3만 구현**. 작업 시작 시 이미 수정되어 있던 roadmap/설계/progress의 연속 스테이지 설계를 보존하고 그 내용을 구현했다. 이전 기록의 G.8.3 미착수와 기존 단일 구간 설계는 당시 이력이며 이번 기록이 최신 상태다. G.8 전체 완료나 플레이용 실행 파일 완성을 뜻하지 않는다. 커밋·푸시는 하지 않았다.
- 파일: `src/features/games/survivor/{stages.ts,enemies.ts,drops.ts,geometry.ts,stages.test.ts,enemies.test.ts}` 신규. 기존 `{types.ts,content.ts,engine.ts,progression.ts,engine.test.ts,weapons.test.ts}` 변경. `docs/{roadmap.md,design/dachs-survivor.md,progress.md}` 갱신. 다른 게임·카탈로그·터미널·Rust/IPC·패키지 의존성은 변경하지 않았다.
- 스테이지: 누적 `tick`과 `stage.waveTicks/bossTicks/warningTicks` 분리, 일반3600틱·3/6/9… 보스·90틱 경고, 지정 짝수 구간1800틱 정예1회. 생성 시 HP/피해/XP 배율을 고정하고 생성률/수치 상한을 적용한다. `stage.pendingTransition`으로 연속 카드 뒤 추가 전투 틱 없이 전환한다. 통과 자격·보스 보상을 카드 선택 전에 확정하므로 후속 체크포인트의 기록과 보상이 일치한다.
- 다음/종료: `continueSurvivorStage(run, expectedStageIndex)`와 `finishSurvivor(run, 'retired', expectedStageIndex)`는 현재 통과 화면 번호를 확인해 과거/중복 입력을 거부한다. 다음 구간은 HP·위치·레벨/XP·무기/능력/진화·공격/무적 타이머·드롭·골드·다시뽑기·ID/난수/누적시간을 유지한다. 일반 전투 종료는 적/적탄만 무보상 퇴장시킨다. 사망/마무리/포기는 `defeat/retired/abandoned`로 구분해 미수집 드롭·미처리 카드·적/적탄을 정리하고 이미 획득한 합계와 기록을 보존한다.
- 적/보스: 슬라임·박쥐·버섯·골렘·멧돼지, 거대슬라임·갑옷멧돼지, 숲의 폭군을 추가했다. 버섯 고정 조준/단발·멧돼지 예고/직선 돌진/회복·정예 도약/돌진·보스 돌진→부채꼴 씨앗→도약, 반피 회복단축/7발·90초 후1회 속도증가를 구현했다. 보스 넉백면역·생성 시 별도 보스 배율·투사체/돌진 선분 판정·도약 경로 비피격을 검사했다. 예고 상태/방향/위치는 G.8.5 렌더러 연결 데이터이며 현재 시각/음향 UI는 없다.
- 피해/보상: 접촉·적탄·착지 중 최대피해1개/동률 작은ID에 방어·45틱 공통무적을 적용한다. 같은 틱의 적 공격을 무기 처치 전 확정해 보스와 동시 사망 시 통과/보상을 주지 않는다. 적탄 재사용 전에 피격 값을 복사한다. 살아서 처치한 보스당40은 `bossRewardGold/bossesDefeated/lastRewardedBossStage`로 런 안에서1회 누적하며 골드 배율을 적용하지 않는다. 프로필 첫 보스30·영구 runId 정산/잔액은 G.8.4에 남긴다.
- 드롭/상한: 일반 적 독립10% 골드/2% 간식, 정예 XP40·골드15·간식1 확정, 보스는 바닥 보상 없음. XP·골드·간식 종류별 합계와 골드 소수 잔여를 보존하고 수집 당시 능력치로 배율/최대HP20% 회복을 계산한다. 일반180/정예2/보스1/적탄100/전체드롭250, 풀 재사용 필드 초기화. 드롭 상한에서 같은 종류 근접 병합, 없는 종류는 기존 동종 한 쌍을 합쳐 자리를 확보한다. 안전거리 탐색 실패는 생성 생략, 필수 보스만 경고0틱에서 재탐색한다. 콘텐츠 버전3으로 올렸으며 현재 구현의 상한/재현 검사는 실제 메모리·프레임 성능 통과와 별개다.
- 실제 규칙 검증: `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src/features/games/survivor --maxWorkers=1` **5파일/94개 통과**(기존53+신규41). 기존 XP 전용 검사는 종류를 구분하도록 바꾸고, 사망 시 바닥 드롭 폐기는 새 종료 규칙에 맞췄다. 3600틱 경계·연속 선택·90틱 경고·3/6보스→4/7·성장/누적3분 진화·동시 사망·보상1회·과거 입력·120구간 반복·종류별 상한/병합·풀 재사용·적 예고/회복/패턴·1000시드 드롭 추첨·8종×40시드×중앙/4모서리 **1600개 스폰 조합**을 검사했다. 유효 위치를 못 찾은 생성은 정상 생략으로 검증했다. 혼합전투와 일반6구간 전체시간/보스2회 처치의30/60/120Hz 전체 상태도 일치한다.
- 검증의 범위: 신규 장기/보스 검사는 테스트용 무적·시간 경계·보스HP/위치 등의 상태를 설정했다. 기존3시드의 상태 보정 없는 초반 자동 이동/공격/카드 검사도 유지한다. 이는 엔진 규칙 검사이며 첫 두 보스의 일반 입력 클리어·수동 재미·골드 수익·60fps 실증은 아니다.
- 최종 전체 검증: `node --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit`, `node --max-old-space-size=1024 node_modules/eslint/bin/eslint.js .` **각 종료0**. `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src --maxWorkers=1` **11파일/150개 통과**. PowerShell에서 `$env:NODE_OPTIONS='--max-old-space-size=1024'` 후 `npm run build` **종료0**. 기존 메인 번들500KB 경고 유지. 이 frontend build는 기존 앱 번들/타입 확인이며 아직 카탈로그에 연결되지 않은 서바이버의 플레이용 산출물이 아니다.
- 미실행/이유: 화면/카탈로그 연결은 G.8.5이므로 브라우저·Windows WebView2·실제 로컬PTY/SSH 입력격리·Mac·물리터치·native debug/release/NSIS 빌드/설치 검증을 이번 범위에서 실행하지 않았다. Rust/IPC 미변경으로 Rust 단위/clippy/SSH 회귀도 재실행하지 않았다. 실제 일반 입력 플레이·난이도/수익·p95프레임/반복10판 메모리 검증은 G.8.6이다. 기존 Phase·G.7 환경 대기 상태는 변경하지 않는다.
- 남은 ID: **G.8.4 영구 강화/환불/해금·소유권/저장복구/정산**, **G.8.5 게임탭·Canvas/HUD/카드/통과/결과UI·입력/음향**, **G.8.6 밸런스/성능/실환경/산출물**. 다음 첫 행동: G.8.4 요청 시 설계 §7/§10과 `types.ts`/`stages.ts`의 합계·통과 기록을 읽고 `profile.ts`의 저장 스키마/검증부터 구현한다. 수집 골드 소수·보스 고정 합계·프로필 첫 보스 자격을 분리하고, 구간은 체크포인트만 저장하며 종료/중단 복구에서 현재 runId에 대해서만 원자 정산한다. 실제 지불액 환불·여러 창 소유권·저장 실패 경로와 구매 연타/중복 정산 검증을 이어간다.
- 최종 문서/형식 확인: `node --max-old-space-size=1024 node_modules/prettier/bin/prettier.cjs --check src/features/games/survivor/*.ts`와 `git diff --check` 종료0. Python으로 변경3문서의 로컬 Markdown 링크27개 실파일 확인, 문서3개/서바이버소스16개의 후행공백0개 확인. 설계/roadmap의 현행 G.8.3 미착수·콘텐츠버전2 표현도 정리했다.

## G.8.3 로컬 커밋 요청 (2026-11-05)

- 사용자 요청에 따라 G.8.3 엔진/규칙 검사12개 파일과 관련 설계/roadmap/progress3개 문서를 함께 로컬 커밋 대상으로 묶었다. 앞선 G.8.3 기록의 미커밋 상태는 구현 완료 당시 이력이다. 커밋 제목은 `feat(survivor): add continuous stages, enemies and boss rewards`이며 원격 푸시는 요청 범위에 없다.
- 제품 코드는 직전 전체150개·타입·린트·빌드 통과 상태에서 변경하지 않았으므로 검사를 반복 실행하지 않는다. 이번 Git 작업에서는 변경 목록과 스테이징된 diff의 공백 오류를 확인한다. 남은 ID는 G.8.4~G.8.6이며 다음 첫 행동은 위 G.8.3 인계의 `profile.ts` 저장 스키마/검증 구현이다.

## G.8.4 — 영구 성장·저장·정산·쉼터 (2026-11-05, 구현/해당 범위 검증 완료)

- 요청 범위: **8.4만 구현**. roadmap/설계 §7/§10과 기존8.3 엔진을 대조했다. 기존8.3 소스는 수정하지 않았고 진행 중 반영된 별도8.3 커밋 `4cfdb2a` 및 그 진행 기록도 보존했다. 이번 작업은 커밋·푸시하지 않았다. G.8 전체 완료나 카탈로그에서 실행 가능한 게임 완성을 뜻하지 않는다.
- 신규 제품 파일: `src/features/games/survivor/{profile.ts,profileStore.ts,session.ts,SurvivorHub.tsx,hub.css}`. 신규 검사: 같은 폴더 `profile.test.ts`, `tests/ui/survivor-profile.spec.ts`, `tests/ui/fixtures/survivor-profile.{html,tsx}`, `tests/native/survivor-profile.ts`, `scripts/test-survivor-profile-native.mjs`. 문서: roadmap/설계/progress 갱신 및 [영구 성장 검증](verification/survivor-profile.md) 추가. 기존 게임·App/카탈로그·터미널·Rust/IPC·패키지 의존성은 변경하지 않았다.
- 영구 성장: HP/공격/수집/골드4강화, 발자국100/도토리150/다시뽑기150 해금. rank별 실제 지불액을 저장해 현재 가격표와 무관하게 환불한다. 무기·다시뽑기 해금은 환불 제외, 판 중 구매/환불 거부, 잔액0~9,999,999 상한. 구매/환불/설정은 화면 리비전을 요구하고 쓰기 성공 후에만 반영한다. 엔진 시작옵션으로 최대HP125/공격15%/수집30%/골드15%/다시뽑기2회·해금 후보를 전달하며 시작 무기는 물기1개다.
- 스키마/정산: `dachsterm.games.survivor.v1`의 단일 레코드에 schemaVersion1/revision/잔액/강화/해금/설정/기록/진행판/최근정산20개. 수집 소수 합계, 보스 고정40, 첫 보스30을 구분한다. 현재 체크포인트의 runId/seed/비감소 합계와 보스수·마지막보상구간·통과/도달·tick의 일관성을 검증한다. 도전 종료/중단복구 때만 수집 합계를1회 내림하여 잔액·첫 보스 플래그·기록·정산ID·체크포인트 제거를 한 번에 저장한다. 오래되어20개에서 빠진 종료 이벤트도 현재 runId 불일치로 지급하지 않는다. 손상/미래 스키마는 원문을 보존하고 쓰기 금지한다.
- 소유권/수명: 탭당 `SurvivorProfileStore`가 Web Locks 배타 잠금을 유지한다. 다른 창은 읽기 전용과 storage 이벤트 갱신, 소유 창 종료 후 명시적 재확인으로 인계한다. `SurvivorSession`은 시작 저장 후 엔진 생성 공개,5초 및 카드/정지/보스/구간/종료 변경 저장, 실패 시 정지/결과 보존·명시적 재시도·닫기 실패를 제공한다. 소유권 상실도 sync에서 정지한다. `dispose()`는 정산하지 않아 React 재렌더/정리로 중복 지급되지 않는다. 잠금 미지원/접근·쓰기 불가/손상 데이터에서는 명시적인 기본 능력 임시 플레이를 제공하고 영구 저장을 바꾸지 않는다.
- 쉼터: 강화/해금의 비용·실제 효과·구매후잔액, 환불 확인/제외/상한, 기록, 음소거/모션 설정, 읽기 전용·저장 재시도·임시 플레이 UI. 더블클릭·반복키를 억제한다. 360/560/1280에서 가로 넘침 없이 검증했고560은 GitHub Dark, 나머지는 기본 크림 테마다. 캡처에서 전역 checkbox 너비로 문구가 세로로 나뉘는 문제를 발견해 수정했다. 실제 카탈로그 등록/Canvas 전투 UI는8.5에 남는다.
- 실제 단위 검증: `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src --maxWorkers=1` **12파일/209개 통과**, 서바이버153개(기존94+신규59). 유효성/단계/실제효과·과거지불환불·구매연타/잔액/상한·단일쓰기 실패/재시도·사망/마무리/포기135골드 수식·첫보스1회·중단전후/선택중 복구·20개초과옛이벤트·다중소유권·실패정지/닫기/5초저장을 검사했다. 처음의 스케줄링 검사1실패는 시험용 stageClear에 pendingChoices가 남은 fixture 오류였으며 실제 구간전환 거부가 정상임을 확인하고 fixture를 정리했다.
- 실제 브라우저: `$env:NODE_OPTIONS='--max-old-space-size=1024'` 후 `node node_modules/@playwright/test/cli.js test tests/ui/survivor-profile.spec.ts --workers=1` **8개 통과**. 실제 Chromium 두 페이지의 Web Locks·읽기전용·storage 동기화·소유페이지종료/재획득·중단정산/리로드, 독립 쉼터 구매/환불/설정·저장오류/임시경로 확인. 캡처 `target/verification/survivor-hub-{360,560,1280}.png`.
- 실제 Windows: 같은 Node 메모리 설정으로 `node scripts/test-survivor-profile-native.mjs` **종료0**. 기존 `target/debug/daxterm.exe`를 격리 데이터로 띄워 현재 저장소/세션 소스를 주입했다. `http://tauri.localhost` secure context/Web Locks/UUID 지원, peer iframe 문서 경쟁/이벤트,135정산→30구매→2.75체크포인트→6초대기→프로세스트리강제종료/재실행→잔액107·HP1·중단정산1회 확인. 결과 `target/verification/survivor-profile-native.json`. 기존 debug 실행 파일이8.4를 포함한 새 빌드라는 뜻이나 네이티브 두 창/전투 UI 통과가 아니다.
- **확인된 저장 한계**: 첫 즉시 프로세스트리 강제 종료 시 성공 응답한 localStorage가 디스크에 남기 전에 사라져 신규프로필로 읽혔다.6초대기 후 실증은 통과했지만 flush 시간 보장이 아니다. 원자적 레코드 교체와 디스크 내구성을 구분하고 **5초 저장주기가 손실상한은 아님**을 설계/검증 문서에 반영했다. G.8.6에서 정상 앱종료·OS 종료/절전 실제 동작을 추가 확인한다.
- 최종 정적/빌드: 초기 `node --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit` 종료0, 최종 `node --max-old-space-size=1024 node_modules/eslint/bin/eslint.js .` 종료0, Node 메모리 설정 후 `npm run build`(`tsc -b && vite build`) 종료0. 기존 메인 번들500KB 경고 유지. 이 build는 기존 앱 번들/모든 src 타입 확인이며 아직 미등록인 서바이버 플레이 산출물이 아니다.
- 미실행/이유: native debug/release/NSIS 새빌드·설치, 제품 전체 전투/앱 정상종료 UI·실제PTY/SSH 입력격리·Mac WKWebView/실기기·물리터치·실플레이밸런스/p95/메모리는 화면 연결 또는 후속 범위/환경이 필요해 미실행. Rust/IPC 미변경으로 Rust단위/clippy/SSH엔진 회귀도 반복하지 않았다. 기존 Phase·G.7 환경 대기는 유지한다.
- 남은 ID: **G.8.5 게임탭/Canvas/HUD/카드/통과/결과/입력/음향·실제 탭/앱 종료 연결**, **G.8.6 밸런스/성능/실환경/산출물**. 다음 첫 행동: 설계 §10의8.4 연결계약과 `session.ts`/`SurvivorHub.tsx`, `App.tsx` 게임탭 수명을 읽고 탭당1개 store/session을 유지하도록 연결한다. 엔진명령/프레임 뒤 sync, 비활성 pause, 명시적 종료 finish, **close false이면 탭을 제거하지 않고 저장 재시도**를 연결한 뒤 Canvas/HUD를 구현한다. 기존6종 게임/터미널 입력격리 회귀를 유지한다.
- 최종 문서/형식: 새 제품/검사 스크립트와 서바이버 기존 `.ts`를 포함한 `prettier --check` 종료0, `git diff --check` 종료0. Python으로 변경4문서의 로컬 Markdown 링크35개 실파일 및 문서/소스/검사31파일 후행공백0개 확인. 수정한360px·다크560px 캡처를 다시 직접 확인했다. 검증용 앱 프로세스는 종료했고 테스트 산출물은 무시되는 target/verification 및 격리 임시폴더에 남겼다.

## G.8.4 로컬 커밋 요청 (2026-11-05)

- 사용자 요청으로 G.8.4 제품/검사11개 파일과 설계/roadmap/progress/검증4개 문서를 로컬 커밋 대상으로 묶었다. 제목은 `feat(survivor): add persistent upgrades and run settlement`이며 원격 푸시는 하지 않는다. 위 미커밋 표기는 구현 완료 당시 이력이다.
- 이번 작업은 제품 코드 변경 없이 Git 변경 목록·`git diff --check` 및 스테이징된 diff를 확인한다. 직전 단위209개·브라우저8개·WebView2 저장 실증·타입/린트/빌드 통과 후 제품 코드가 바뀌지 않아 검사를 반복하지 않는다. 남은 ID는 G.8.5~G.8.6이며 다음 첫 행동은 위 G.8.4 인계의 store/session과 실제 게임 탭 수명 연결이다. 강제 종료 저장 한계와 Mac/실제SSH/설치본 등 미실행 범위는 그대로 유지한다.

## 제품명 변경 범위 검토 (2026-11-05, 이름 미확정)

- 사용자 문의: 이전 제품명 대신 DachsTerm 명칭의 인상과 수정 범위 검토. 당시에는 개명 구현 요청이 아니므로 제품 코드·설정·저장 규약을 변경하지 않았다. 2026-11-06 개명 구현 요청과 데이터 호환 불필요 지시는 후속 N.1을 따른다.
- 당시 확인: 이전 이름의 대소문자 무시 Git 검색 기준 추적85파일/344줄. 표시명 후보는 src/index.html/Tauri 설정/안내문/고지 생성 범위17파일이며 테스트·문서는 추가다. 이는 수정 확정 파일 수가 아니라 당시 검색 결과다.
- 주의 위치: `src-tauri/tauri.conf.json`의 identifier, `src-tauri/src/credentials.rs`의 OS 저장소 서비스명, `src-tauri/src/vault.rs`의 WRAP_AAD, `settings.rs`의 JSON format, 프런트 localStorage 키. 전체 치환하면 기존 저장 데이터·인증정보·암호문·내보내기 호환성을 잃을 수 있어 보존 또는 명시적 이전이 필요하다.
- 검증: 문서/코드 검색과 설정 읽기만 실행했다. 이름 변경·빌드·설치·데이터 이전 검사는 미실행(이름 미확정 및 구현 미요청). 기존 진행 중 변경은 보존했다.
- 남은 ID: 개명 작업 ID는 미부여, 기존 G.8.5/G.8.6 및 환경 검증 대기는 그대로다. 다음 첫 행동: 개명 구현 요청 시 표시명 변경과 내부 식별자 변경 범위를 정하고 기존 데이터 호환 정책부터 확정한다.


## G.8.5 — 닥스의 서바이버 게임탭·Canvas·입력·종료 저장 (2026-11-05, 구현/해당 범위 검증 완료)

- 요청 범위: **8.5만 구현**. roadmap/설계/진행 기록과 실제8.4 session/store 계약을 읽고 연결했다. 작업 중 반영된8.4 커밋 `d62c5bc` 및 별도 제품명 검토 기록은 보존했다. 이번8.5는 커밋·푸시하지 않았다. 기존 release/NSIS를 최신 서바이버 산출물로 표시하지 않는다.
- 신규 제품 파일: `src/features/games/survivor/{controller.ts,renderer.ts,SurvivorGame.tsx,survivor.css,audio.ts}`, `src-tauri/capabilities/survivor-window.json`. 연결 변경: `src/app/App.tsx`, `src/features/games/{catalog.ts,GamePane.tsx}`. 신규 검사: `tests/ui/survivor.spec.ts`, `tests/ui/fixtures/survivor.{html,tsx}`, `scripts/test-survivor-ui-native.mjs`. 문서: README의 실행 안내, roadmap/설계/progress 및 [UI 검증](verification/survivor-ui.md). 기존 순수 엔진·profile/store/session·Rust 제품 코드는 변경하지 않았다.
- 화면: 게임 목록 등록, 기존 쉼터 연결, 고정960×540 논리 Canvas/3200×3200 경계·기존 atlas·8종 적/공격 예고·3종 드롭·6무기/진화 공격·보스 체력/방향. 테마 토큰과 시드 기반 장식을 사용하며 렌더러는 전투 난수/상태를 바꾸지 않는다. HUD는 구간/보스 시간·HP/XP·이번 수집/보스/영구 골드를 분리하고, 각4슬롯과 최종 조합을 제공한다. 카드·정지·통과·결과는 전장 위 스크롤 가능한 DOM 패널이다.
- 입력/음향: WASD/방향키·숫자선택·R/P/M/Space/Enter, 키 반복/keyup 경계·오래된 choiceId/구간 입력 거부·포커스한 마무리 버튼의 Enter를 연결했다. 카드·blur·비활성 전환은 이동키/포인터/RAF를 멈추며 수동 재개한다. 외부 텍스트/조합키/IME 조합은 가로채지 않고 외부 포커스를 빼앗지 않는다.8방향 패드의 pointer capture/up/cancel/lost capture와44px 크기, 모션 줄이기·합성 효과음 최대3음/80ms·음소거 저장을 추가했다. 실제 스피커 청취 품질은 미검증이다.
- 탭/저장: controller/store/session은 탭마다1개, StrictMode cleanup은 정산하지 않는다. 프레임/명령 뒤 sync,5초/상태 변화 저장과 실패 정지, 명시적 포기/마무리/닫기의 정산을 연결했다. 탭 닫기 false는 제거를 취소하고 결과/재시도를 유지한다. main 창의 onCloseRequested도 실패 시 취소하며 성공 후 기존 Rust 종료 정리를 사용한다. Tauri 기본 close handler의 destroy 권한을 main 창에만 추가했으며 새 Rust IPC/프레임별 업무 IPC는 없다.
- 단위/정적: `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src --maxWorkers=1` **12파일/209개 통과**. `node --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit` 종료0. 최종 `node --max-old-space-size=1024 node_modules/eslint/bin/eslint.js .` 종료0. 변경13개 소스/검사/설정 `prettier --check` 종료0.
- 브라우저: Node 메모리 설정 후 `node node_modules/@playwright/test/cli.js test tests/ui/survivor.spec.ts tests/ui/survivor-profile.spec.ts tests/ui/games.spec.ts tests/ui/dachs-games.spec.ts --workers=1` **26개 통과**(당시 신규7+기존19). 최종 `... test tests/ui/survivor.spec.ts --workers=1` **9개 통과**, 중복을 제외한 고유28개다.360/560/1280·기본/다크·내부스크롤/3열·95/135정산·연속 카드/다음/다시뽑기·Esc/탭·pointercancel·StrictMode잠금·실패닫기/재시도·외부포커스/조합키·resize/테마 후 전체 엔진 상태 일치와 기존6종/xterm 인스턴스 회귀를 확인했다. 복잡한 카드/통과/보스 보상은 fixture 상태 설정 검사이며 일반 입력 보스 클리어 근거가 아니다.
- 초기 브라우저 실패: 실행 중 포맷 변경에 따른 Vite reload1건, 가상 시계 설치 시점/화면 밖 포인터 좌표/choosing 전 카드 요청 fixture 설정을 바로잡은 뒤 통과했다. 제품 시간·전투 규칙을 실패 검사에 맞춰 바꾸지 않았다. 캡처 `target/verification/survivor-{battle,cards,result}-{360,560,1280}.png`와 native 화면을 직접 확인해 카드 상단 정렬을 보완했다. 가상 패드에서 Canvas 포커스로 이동할 때 화면이 튀지 않도록 preventScroll을 적용하고 스크롤 유지 검사를 추가했다.
- 빌드/실제Windows: `$env:NODE_OPTIONS='--max-old-space-size=1024'` 및 Cargo PATH 설정 후 `node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle` **종료0**(tsc-b/Vite 포함). 최종 `node scripts/test-survivor-ui-native.mjs` **종료0**. 새 내장 제품/격리 데이터로 일반 이동→자연 첫 레벨업2/카드3장→Esc/동일카드재개/선택→정지, 실제 창닫기 저장실패차단→재시도1회정산→정상exit0→재실행 전체프로필일치를 확인했다. 엔진 상태·시드 주입 없이 실행했고 저장 실패만 주입했다. pageerror0, 실행 프로세스 종료. 캡처/JSON은 `target/verification/survivor-ui-native.{png,json}`.
- 최신 debug: `D:/Work/daxterm-workspace/target/debug/daxterm.exe`, SHA256 `79c004c5095a779e5ac06579c9058d6bb2ed31ddca9d1b7c413bc272818bd8aa`. 게임 목록에서 서바이버를 실행할 수 있다. 기존 main 번들500KB 경고 유지. release/NSIS 새빌드·설치는 미실행이다.
- 미실행/이유: **G.8.6** 첫 두 보스3/6→4/7 일반 입력 클리어·장기 상한/수익/재미·60초p95/반복10판메모리·실제 로컬PTY/SSH 입력격리·OS종료/절전·release/설치본은 후속 범위다. Mac 실기기·물리 멀티터치·스피커청취는 해당 환경/수동 검증이 필요하다. Rust 제품 코드 미변경으로 Rust단위/clippy/SSH엔진 전체 회귀를 반복하지 않았다. 기존Phase/G.7 대기를 유지한다. G.8.4의 강제 종료 디스크 손실 가능성/5초 주기가 손실상한이 아니라는 한계도 유지한다.
- 남은 ID와 다음 첫 행동: **G.8.6**. 이 기록·UI 검증·설계§11~12를 읽고 위 debug SHA를 확인한 뒤 무강화/서로 다른 시드로 첫 두 보스와4/7 진입을 일반 입력으로 플레이해 시간·사망·카드 빈도·수익을 기록한다. 그 근거로 content 수치를 조정하고 부하/메모리·실제PTY/SSH·OS종료·release 식별/설치를 검증한다. G.8.5 재구현이나8.4 저장소 재생성부터 시작하지 않는다.
- 최종 문서 확인: 변경5문서의 로컬 Markdown 링크51개 실파일·후행공백0개, debug 파일의 실제 SHA256과 native 결과JSON 일치를 확인했다. `git diff --check` 종료0.

## G.8.5 로컬 커밋 요청 (2026-11-05)

- 사용자 요청으로 G.8.5 제품/검사/설정13개와 README/설계/roadmap/progress/검증5개, 총18개 파일을 로컬 커밋 대상으로 묶었다. 제목은 `feat(survivor): integrate gameplay UI and safe session lifecycle`이며 원격 푸시는 하지 않는다. 별도 제품명 검토 기록은 이번 커밋에서 제외하고 작업 트리에 보존한다. 위 미커밋 표기는 구현 완료 당시 이력이다.
- 제품 코드는 직전 단위209개·브라우저 고유28개·타입/린트·최신 debug/WebView2 검증 이후 바뀌지 않아 검사를 반복하지 않았다. 이번에는 변경 목록과 `git diff --cached --check`를 확인한다. 남은 ID는 G.8.6 및 기존 환경 대기이며, 다음 첫 행동은 위8.5 인계의 무강화/서로 다른 시드 일반 입력 플레이 검증이다.

## 2026-11-05 주요 터미널 대비 기능 격차 점검

- 요청: MobaXterm 및 유명 터미널 대비 부족한 기능 평가. 구현 요청으로 확대하지 않았으며 제품 코드/로드맵 범위는 변경하지 않았다.
- 확인: roadmap/progress/README/session-transfer와 실제 storage.rs, session_transfer.rs, workspace.rs, sftp.rs, ssh.rs/ssh_auth.rs, terminal/session.ts·preferences.ts·TerminalPane.tsx, lib.rs를 대조했다. 외부 비교 근거는 MobaXterm 공식 features/documentation, SecureCRT 공식 features, Termius 공식 제품 페이지다.
- 현재 강점: SSH/SFTP/FTP·FTPS, 외부 편집·충돌 복구, 분할/SSH 독립 창/멀티 입력, 로컬 PowerShell·WSL, 터널 3종, 모니터링, 12개 테마, 마스터 암호, SSH agent·keyboard-interactive/MFA, 기본 외부 세션 가져오기는 이미 구현되어 있다. 과거 기록의 agent/MFA 미지원은 현재 상태가 아니다.
- 주요 격차: 점프 호스트/접속 프록시, 폴더 재귀 업·다운로드와 전송 대기열, 스니펫/매크로/스크립팅, 터미널 영구 로그, 고급 세션 이관과 계층형 그룹, 내장 텍스트 편집기. 호스트 CA/GSSAPI·agent forwarding, Serial/Telnet/Zmodem 등은 사용 환경에 따라 필요성을 판단한다. X11/RDP/VNC·클라우드/팀 기능은 기존 의도적 제외 범위다.
- 추천 후보(새 작업 승인/ID 부여 아님): 폴더 전송·큐 → 스니펫 → 로그 → 점프 호스트. 사내망/경유 접속이 주 사용처라면 점프 호스트를 첫 순위로 올린다. 장시간·절전/네트워크 전환·물리 IME/OS 조작 검증과 서명/업데이트 배포도 기능 추가와 별도로 남는다.
- 수행 검증: Get-Content/rg로 문서·소스 대조, git status --short로 병행 변경 확인. 기능 테스트·실제 SSH·Mac·장시간 검사는 이번 평가에서 재실행하지 않았으므로 기존 성공/대기 상태를 변경하지 않는다. 기존 병행 게임 변경을 유지했다.
- 남은 기존 ID: W.3, W.4/5.1, 5.2, 5.3 및 S.1 실환경 대기. 최신 설치본 반영 여부는 병행 G.8.6 산출물 기록을 우선 확인한다. 다음 첫 행동: 사용자 선택 범위에 맞춰 후보의 계약/완료 기준을 정하거나 기존 Windows 수동 체크리스트를 이어간다.
- 공식 비교 자료: https://mobaxterm.mobatek.net/features.html , https://mobaxterm.mobatek.net/documentation.html , https://www.vandyke.com/products/securecrt/features.html , https://termius.com/ .

## G.8.6 — 중단 대응·밸런스/성능/실환경·산출물 (2026-11-05, 구현/Windows 자동 검증 반영·수동/환경 검증 대기)

- 요청 범위: **8.6**. roadmap/설계§11~12/8.5 인계와 실제 코드를 확인했다. 커밋·푸시는 하지 않았다. 시작 때 남아 있던 제품명 검토 및8.5 커밋 기록은 보존했다. 다른 Phase로 확장하지 않았다.
- 제품 변경: `src/features/games/survivor/SurvivorGame.tsx`의 pagehide/freeze와1초 이상 RAF 공백에서 전투 틱 처리 전 정지·키/포인터 해제·체크포인트 저장. 명시적 재개, 기존 종료 실패 차단을 유지한다. 새로운 Rust 제품 코드/IPC/의존성은 없다.
- 검사/도구: `src/features/games/survivor/endurance.test.ts`, `tests/native/survivor-{balance,performance}.ts`, `tests/ui/survivor.spec.ts`; `scripts/{measure-survivor-balance,measure-survivor-native,measure-survivor-lifecycle-native,play-survivor-native,test-survivor-integration-native,verify-survivor-artifacts}.mjs`. 기존 `test-installer.ps1`에 선택 InstallerPath/ExpectedBinarySha256 검사를 추가했다. 문서: README/roadmap/설계/progress 및 [통합 검증 기록](verification/survivor-validation.md).
- **병행 변경 분리**: 작업 중 별도 content/enemies/renderer/scenery/enemyRenderer 및 관련 검사가 생성·수정되고 debug EXE도 여러 번 교체됐다. 이 파일들은 이번 작업에서 수정/복원/스테이징하지 않았다. HEAD `da01f5c`에 이번8.6 소유 파일만 복사한 `target/verification/g86-source` detached worktree로 콘텐츠 버전3 검증을 고정했다. node_modules/target은 원래 폴더의 junction이며 제품 소스는 독립 복사다. 재현 시 추가 파일의 최신 사본과 실행 파일을 확인한다. 공유 트리의 이후 콘텐츠 버전/수치/시각 변경이 검증됐다는 뜻은 아니다.
- 단위: Node 메모리1024MB 설정 뒤 `node node_modules/vitest/vitest.mjs run src --maxWorkers=1` **13파일/215개 통과**. 신규6개는 무강화5시드 공개 명령으로 첫 두 보스/7진입, 자연 레벨40 이후 XP0/추가카드 없음·슬롯4/랭크5/진화2·객체/스케일 상한/반복 보상이다. 자동 정책 결과를 사람의 재미/난이도 판정으로 사용하지 않았다.
- 브라우저: `node node_modules/@playwright/test/cli.js test tests/ui/survivor.spec.ts --workers=1` **11개 통과**, 별도 `... test tests/ui/survivor-profile.spec.ts tests/ui/games.spec.ts tests/ui/dachs-games.spec.ts --workers=1` **19개 통과**, 고유30개. 기존6종 회귀 유지. 신규2개는60초 프레임 점프에서 tick 증가 전 정지/저장/이동키 해제, 카드 중 freeze/pagehide 후 동일 choice/tick/미정산을 실제 UI에서 확인한다. 실제 OS 절전을 실행한 결과는 아니다.
- 밸런스: `node scripts/measure-survivor-balance.mjs` 종료0. 버전3 기본 프로필5시드 모두7구간, 첫 보스12.45~52.88초/두 번째6.80~13.48초·31~33회 카드·수집94~109/보스80. 초반/첫보스 수익은 초기 제안 범위에 들었다. 장기2시드는 약30~31분/28구간 사망, 레벨40 약8~8.5분·39카드 이후 증가 없음·보스9회/360·시간당 약2004~2034골드. 드롭250 상한 유지. 콘텐츠 수치를 자동 결과만으로 임의 조정하지 않았다.
- **실제 내장 앱 일반 입력**: `node scripts/play-survivor-native.mjs` 종료0. 엔진/시드/HP/시간 주입 없이 픽셀/HUD를 읽고 WASD·숫자키·버튼을 조작했다. 자연시드2105255200/3108173795, 각각409.840/409.787초, 카드30/31회, 3·6보스 처치 후4·7진입. 7진입 tick24276/24273·HP100/83·수집85/87/보스80. 첫 판195지급, 두 번째는 강화 구매 없이 시작. 첫 판6통과 화면의4무기/2진화·보스80/다음7/HP100을 직접 캡처 확인했다. 자동 키보드 검사이며 사람 플레이 평가 대기는 유지한다.
- 성능/메모리: `measure-survivor-native.mjs`는 엔진+Canvas와 실제 UI/controller/session/store/audio/HUD 소스를 각각60초 인공 상한(일반180+정예2+보스1/공격240/드롭250/적탄100)으로 측정한다. 공유 debug가 바뀐 중간 결과를 발견해 **보존8.6 debug 경로와 별도 evidence 폴더를 명시한 최종 측정을 진행**했다. 최종 수치는 아래 추가 기록과 통합 검증 문서가 정본이다. 실제 내장 제품의 짧은 UI 판70회 반복은 DOM334/리스너214 고정·backing storage 약865KB 고정,10→70회 JS힙4,821,228→5,075,064바이트. 타입별 heap 집계 증가 대부분 code235,188바이트, Object9개/288바이트·array1개/76바이트였다. 원시 snapshot은 파일에 쓰지 않았다. 게임 엔티티/DOM/리스너 누적 증거는 없지만 전체 힙 완전 평탄/장시간10판 메모리 통과로 표시하지 않는다.
- **실제 로컬PTY/SSH**: `node scripts/test-survivor-integration-native.mjs` 종료0. 별도 tmpfs OpenSSH·호스트키 공개 지문 대조·저장하지 않은 임시 비밀번호로 실제 연결. PowerShell Read-Host/SSH read 대기 중 WASD/방향키/1·2·3/R/M/Space/Enter/P와 자연 카드/다시 뽑기/선택을 실행했다. 두 셸 모두 `SURVIVOR_INPUT<>`, 같은 연결ID와 복귀 후 출력 유지. 정지tick 고정·pageerror0·정상exit0. 인증정보를 문서/소스/로그에 쓰지 않았고 컨테이너를 제거했다.
- 빌드/네이티브 회귀: Node 메모리 및 Cargo PATH 설정 뒤 `node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle`, `... build --bundles nsis` 모두 종료0(tsc-b/Vite 포함). 마지막 보존 debug를 DACHSTERM_TEST_BINARY로 지정해 기존 `node scripts/test-survivor-ui-native.mjs`도 종료0. 자연 첫 카드·정지/재개/입력·실제 창닫기 저장실패차단/재시도1정산·정상exit0/재실행 전체프로필 일치·pageerror0을 다시 확인했다. Rust 제품 변경이 없어 Rust 단위/clippy/SSH 전체 회귀는 반복하지 않았다.
- 산출물 보존: `target/verification/survivor-g86-artifacts/`의 debug SHA256 `5bce56589788e9f6be1197a96ca178dfd5662933e5f7d965623ce03c46fb2c66`, 단독 release `baaa170867457c00159f94d1b316b0a6d0849930cb779bea2f13e3def39acbc0`, NSIS payload `c2cbfe04065df67236fa3a11bb227fb9b00ff486f31e6111e4c532cedd7d0b23`, 설치 파일 `fbc6bb6c92945048f8e8c9195fe968bce6357fc12b37b30b2be66bec37eb7c18`. 경로/크기/결과 일치 검사는 manifest.json과 verify-survivor-artifacts.mjs로 관리한다. 공유 target/debug 및 release가 나중에 갱신돼도 이8.6 결과의 식별자는 바뀌지 않는다.
- 설치: 단독release 해시와 설치EXE 비교는 처음 실패했다. 실제28,689,408바이트 중3바이트만 Tauri bundle-type `UNK`→`NSS`로 달랐다. marker만 메모리 치환한 전체 일치 검사와 설치 payload C2CB… 해시로 최종 `scripts/test-installer.ps1 -Reinstall -InstallerPath <보존설치파일> -ExpectedBinarySha256 <payload해시>` **종료0**. 버전0.5.1/등록위치/고지파일/해시·동일버전 재설치 표식 유지·release창 초기화/정상종료·설치제거/등록정리를 확인했다. 설치된release로 두보스 전투를 재실행한 것은 아니다.
- 정적:8.6 고정 스냅샷의 `tsc --noEmit`, 전체eslint 및 변경소스/검사prettier --check 종료0. 성능프로브는 `tsc --ignoreConfig --noEmit --strict --skipLibCheck --target ES2022 --module ESNext --moduleResolution Bundler --jsx react-jsx --lib ES2022,DOM,DOM.Iterable --types vite/client tests/native/survivor-performance.ts`도 종료0. 공유 트리 중간 tsc는 별도scenery의 Vec2 import 오류를 보고했으며, 이후 병행 작업에서 Point로 바뀐 것을 확인했다. 공유 트리 전체 검증과 이8.6 고정 결과를 혼합하지 않는다.
- **남은 ID: G.8.6 수동/환경 검증** — 사람의 무강화 다중시드 난이도·재미/장기 성장 평가,10개 장시간 판 메모리, 실제 OS 종료/절전, Mac WKWebView/실기기·물리 멀티터치·스피커 청취. 현재 환경에서는 수행하지 않았으며 OS 종료/절전은 사용자의 실행 환경을 중단하므로 실제 실행하지 않았다. 기존 Phase/G.7 Mac·물리검증 대기도 유지한다. localStorage 강제 종료 디스크 손실/5초가 손실상한이 아니라는 한계는 그대로다.
- 다음 첫 행동: 보존8.6 manifest와 debug SHA를 확인하고 사람이 무강화 프로필로 시드별 카드 간격/피격/보스시간/수익/재미를 기록한다. 실제 OS 절전/종료 전후 저장을 별도 Windows 검증 환경에서 확인하고 Mac 결과를 추가한다. 현재 공유 트리의 별도콘텐츠/시각 변경을 테스트하려면 그 최신 버전으로 다시 빌드·해시·실플레이/성능을 검증하며8.6 버전3 결과를 재사용하지 않는다.
- 최종 보존 EXE 재측정: `DACHSTERM_TEST_BINARY=.../survivor-g86-artifacts/dachsterm-debug.exe`, `DACHSTERM_VERIFICATION_DIR=.../survivor-g86-artifacts/evidence`를 명시하고8.6 고정 소스에서 measure-survivor-native 종료0. 엔진+Canvas60.016초/3587프레임 p95 2.3ms/최대8.2ms, 실제 UI소스60초/2870프레임 RAF CPU p95 **5.4ms**/최대14.3ms로 처리 목표16.7ms 이내. 최종 UI RAF 간격 p95는33.4ms여서 안정적60FPS 표시를 통과로 표시하지 않는다. 공유 환경의 다른 부하/창 전경을 통제한 장시간 재측정을 대기에 추가한다. 객체183/240/250/100 유지, 정지/복귀 추가틱1·스폰예약 유지. 앞선2.3ms UI 결과는 병행 변경 debug 호스트의 중간 측정으로 구분했다.
- 최종 산출물 무결성: `node scripts/verify-survivor-artifacts.mjs` 종료0. 설치payload가 단독release와 정확히bundle-type marker3바이트만 다름, 보존5개 native 결과 모두5bce… debug 해시 일치를 확인했다. `.../survivor-g86-artifacts/{manifest.json,evidence/}`가 이번8.6 산출물·검증의 고정본이다. 공유 target의 debug/성능JSON은 병행 작업이 갱신할 수 있어 보존본과 구분한다. InstallerPath/ExpectedBinarySha256로 최종 설치/재설치/창초기화/정상종료/제거를 모두 통과했다.

- 종료 전 확인: 변경5문서의 로컬 Markdown 링크61개 실파일 확인·문서/이번 소유 소스/검사17파일 후행공백0개. 이번 소유 추적 파일 `git diff --check` 종료0. 최종 새JS/TS 검사 도구 eslint/prettier 종료0. 보존debug/release/NSIS SHA를 다시 확인했으며 이번 보존debug 검사 프로세스 잔여0개다. 별도 작업의 소스/프로세스/산출물은 종료하거나 되돌리지 않았다.

## Phase 6 로드맵 등록 (2026-11-05)

- 사용자 요청: 폴더 전송·큐, 스니펫, 세션 로그, 점프 호스트, 고급 세션 관리·이관을 로드맵에 추가.
- 변경 파일: docs/roadmap.md §4.0 작업표 및 §16에 6.1~6.5의 순서·범위·보안/호환 계약·완료 기준 추가. docs/progress.md 상단과 Phase 상태표에 미착수 등록. 기존 Phase 번호·검증 대기와 병행 게임 변경은 유지했다.
- 검증: git diff --check -- docs/roadmap.md docs/progress.md 통과(줄끝 LF→CRLF 안내만 존재). rg로 §16 및 6.1~6.5 상세 제목/작업표, progress 상태 등록을 확인했다. 문서 변경만 수행해 빌드·기능 테스트·실제 SSH/Mac 검증은 실행하지 않았다.
- 남은 ID: 6.1~6.5 모두 구현 미착수. 기존 W/Phase 5 및 다른 추가 작업의 남은 상태는 해당 최신 기록을 유지한다.
- 다음 첫 행동: Phase 6 구현 요청 시 실제 workspace.rs/sftp.rs/ftp.rs의 전송·재개 구조와 큐 저장 방식을 확인하고 6.1의 작업 상태/경로·충돌 계약부터 구현한다. 6.5의 점프 호스트 이관은 6.4 완료 모델을 사용한다.


## G.8.Q1 — 서바이버 지역·적·밀도 품질 개선 (2026-11-05)

- 사용자 요청: 메이저 스테이지 단위 맵 다양성/장식, 적 외형/종류/숫자 개선. 별도 진행 중인 G.8.6의 `SurvivorGame.tsx`, UI/성능/수명/설치 검증 변경과 문서의 Phase6 추가 등은 보존했다. 커밋·푸시하지 않았다.
- 신규 제품: `src/features/games/survivor/scenery.ts`, `enemyRenderer.ts`. 수정: `renderer.ts`, `content.ts`, `enemies.ts`. 검사: 새 `scenery.test.ts`, `tests/ui/survivor-quality.spec.ts`, `tests/ui/fixtures/survivor-quality.{html,ts}`, 기존 `engine.test.ts`/`enemies.test.ts`/`stages.test.ts`의 변경된 출현 계약 기대값. 문서: roadmap/설계 및 [품질 검증](verification/survivor-quality.md).
- 3구간 단위 숲/유적/수정 골짜기/설원4종, 지역별 기본 길/광장 구도 + 시드/회차별400소품/6랜드마크. 같은 지역3구간은 배치 유지, 재방문은 새 배치. 유한3200×3200 전장·기존 위치/드롭 보존. 지형 장식은 통과 가능, 전투 난수와 분리했다. 배경은512px 타일 최대12장/런, 적 외형은4Mi픽셀 LRU 예산으로 제한하며 테마/지역 전환 시 갱신한다.
- 기존8종 적에 개별 실루엣·눈/표정·그림자·날갯짓/탄성/보행·왕관/갑옷/뿔·공격 느낌표를 적용했다. 새 AI 종류를 추가한 것은 아니다. 모션 줄이기에서 정적 포즈, 밝은/어두운 테마와 실제 HP바 지원. 초기 혼합 적, 이후 지역별5종 가중치, 출현1.4~5.8/s 및 일반/정예 시야 경계+반경+64~144 스폰. 보스 기존 반경/행동,240안전거리,180/2/1상한,HP/피해/보상 수식은 유지한다. 콘텐츠버전4/프로필스키마1.
- 실행 검증: `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src --maxWorkers=1` **40파일649개 통과**. `tsc --noEmit`, 변경 소스/검사 ESLint 및 Prettier 통과. Node 메모리 설정 후 `playwright test tests/ui/survivor-quality.spec.ts tests/ui/survivor.spec.ts --workers=1` **13개 통과**, 최종 눈동자 색 변경 후 quality2개 재실행 통과. 지역4×테마2·360/560·180적·정적/애니메이션·렌더링 상태 불변·반복 픽셀 일치와 기존 입력/저장 회귀. 캡처 `target/verification/survivor-region-*.png` 직접 확인.
- 밀도 비교: 기존 검증 정책을 그대로 사용한 시드5개 모두3/6보스→7진입, 첫 카드11.50~13.95→4.60~9.45초, 평균처치732.4→955,7진입레벨32~34→34~38. HEAD content/enemies는 비교용 메모리 번들에서만 로드했다. `target/measure-survivor-quality{,-baseline}.mjs`, 결과 `survivor-quality-{balance,baseline}.json`. 사람의 플레이/재미/보스 난이도 검증이 아니다. 두 번째 보스6~13초 경향·레벨40 도달 시점은 추가 검토 필요.
- 성능: RAF 없이 연속 렌더한 초기 headless 수치는 작업 적체를 포함해 프레임 성능 판정에서 제외하고 RAF에 맞춰 검사했다. 최종 Chromium180적360프레임 Canvas제출 CPU p95 정적1.7/2.0ms·애니메이션9.3ms. 실제 WebView2 소스 주입 상한부하10초에서 엔진+Canvas8.0ms/전체UI콜백5.8ms, RAF간격p95는50/33.3ms로60fps 보장이 아니다. `target/measure-survivor-quality-native.mjs`, `survivor-quality-performance-native.json`. 해당 native 부하측정은 캐시 구현 후·타일64px여유/눈동자색 보완 전 소스다. 60초/GPU/장시간 실제10판 메모리 검증으로 표시하지 않는다.
- 최종 빌드: `$env:NODE_OPTIONS='--max-old-space-size=1024'` 및 Cargo PATH 설정 후 `node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle` 종료0(tsc-b/Vite/Rust). `target/debug/daxterm.exe` SHA256 **4e8d88da49233039077b2b19b0375e84334273901aac01488f3bae94a1e5d091**. 기존 main번들500KB 경고 유지.
- 최종 실제 Windows: `node scripts/test-survivor-ui-native.mjs` 종료0, 위 SHA와 일치. 상태/시드 주입 없이 일반 이동·자연첫카드·정지재개·실제창닫기 저장실패차단·재시도1회정산·정상exit0/재실행정확일치·pageerror0. JSON/캡처 `target/verification/survivor-ui-native.{json,png}`. 테스트 프로세스 종료.
- 사용자가 첨부한 적체력1조/격자탄환/장판가득 화면은 기존 `tests/native/survivor-performance.ts`의 테스트 전용 상한 부하 주입임을 설명했다. 제품이 이 fixture를 import하거나 일반 판에서 이 체력/배치를 생성하는 것은 아니다.
- 미실행: 이 콘텐츠버전4의 release/NSIS/설치, Mac/실제OS종료절전/물리터치청취, 사람의 다중시드 난이도, 최종캐시60초/장시간전투메모리. Rust 제품·SSH/PTY 미변경으로 해당 실접속 회귀는 이번에 반복하지 않았다. 병행 G.8.6의 이전 소스/패키지 결과를 이번 버전 결과로 대체하지 않는다.
- 남은 ID: **G.8.Q1 구현 완료**, **G.8.6의 해당 소스 실플레이/장기성능/배포 재검증과 기존 환경 대기**. 다음 첫 행동: 위 SHA debug로 새지역/밀도의 무강화 일반 입력 플레이를 기록하고, 두 번째 보스시간·레벨40도달속도를 평가한다. release 작업자는 콘텐츠버전4/최종소스 포함 여부를 확인한 뒤 새 패키지의 SHA/실행 결과를 별도로 기록한다. 다른 Phase6/기존 업무 기능 진행은 그 최신 기록을 유지한다.

## G.8.Q1 로컬 커밋 요청 (2026-11-05)

- 사용자 요청으로 지역·적 외형·출현 밀도 개선의 제품/검사12개와 관련 문서4개를 로컬 커밋 대상으로 묶는다. 제목은 `feat(survivor): enrich regions, enemy visuals and encounter density`이며 원격 푸시는 하지 않는다. 공유 문서의 별도 Phase6 계획·제품명/기능 검토는 작업 트리에 보존하고 제외한다.
- 코드 변경 없이 기존 단위649개·브라우저13개/최종quality2개·타입/린트·Windows debug/실행 검증 결과를 유지한다. 이번에는 변경 목록·스테이징 범위·`git diff --cached --check`를 확인한다. 설계에 남은 콘텐츠버전3 표기는 현행4로 바로잡았다.
- 남은 ID와 다음 첫 행동은 위 G.8.Q1 인계와 같다. G.8.6의 사람 평가·최종 소스 장기부하/배포 및 환경 대기는 그대로이며, 이 커밋으로 검증 완료로 바꾸지 않는다.

## Phase 6.6/6.7 명령 도우미·PodTree 계획 추가 (2026-11-05)

- 요청: 주요 명령을 외우지 않고 찾고 완성하는 기능, 제공한 podtree.sh의 내장 가능성 검토. 기존 로드맵 작업을 이어 6.6/6.7 계획을 추가했으며 제품 구현·스크립트 실행은 하지 않았다.
- 변경: docs/roadmap.md §4.0/§16의 작업표·범위·순서·전체 완료 조건을 6.1~6.7로 확장. 6.6은 오프라인 목적 검색/인자 입력/지원 셸의 인라인 완성 및 6.2 스니펫 연결, 6.7은 버전 고정한 PodTree를 SSH/WSL 전용 PTY에서 여는 방식이다. 네이티브 GUI 재작성은 후속 후보다. docs/progress.md 상단/상태표도 갱신했다.
- 근거: 제공 경로의 podtree.sh(214596바이트, 소스 버전2.4.0)와 README 및 실행 경로를 정적 확인. Bash4+/kubectl/PTY 의존, context 인자, delete/rollout/cordon 외 exec/debug 등이 read-only 제한 밖임을 확인해 조회 모드 보완을 완료 기준에 포함했다. 폴더/README에서 별도 LICENSE/라이선스 표기를 찾지 못했으며 배포 반입 시 조건 확인을 남겼다. 사용자 원본은 변경하지 않았다. kubectl 공식 completion 문서도 확인했다.
- 검증: 문서 작업표/상세 제목/상태표의 6.1~6.7 일치와 git diff --check -- docs/roadmap.md docs/progress.md를 확인한다. 기능 테스트·SSH·실제 Kubernetes·스크립트 실행은 계획만 변경하여 미실행이며 실증 완료를 주장하지 않는다.
- 남은 ID: 6.1~6.7 구현 미착수. 다음 첫 행동: 전체 요청이면 6.1 전송 구조부터, 6.6 지정이면 6.2 입력 계약과 셸 통합 지원 범위부터, 6.7 지정이면 원본 반입 조건·독립 PTY/의존성·조회 모드 경계를 확인한다. 기존 Phase 5 및 병행 작업의 환경 대기는 유지한다.


## Phase 6.6 범위 정정 — 기본 명령어 복사 (2026-11-05)

- 사용자 정정에 따라 이전 6.6 목적 검색·명령 생성·자동 완성 계획을 폐기하고 일반 Linux 서버 사용자의 기본 명령 약20~30개를 설명/명령/복사 버튼으로 제공하는 범위로 대체했다. 사용자 직접 붙여넣기 방식이며 입력 폼·AI·셸 통합·자동 실행이 없다. 6.2 사용자 스니펫과 6.7 PodTree는 유지한다.
- 변경 파일: docs/roadmap.md §4.0/§16/6.6 및 progress 상단. 6.6의 6.2 선행 의존을 제거했다. 과거 계획 추가 기록은 이력으로 보존하며 현재 범위는 이 정정과 roadmap 6.6을 따른다.
- 검증: git diff --check -- docs/roadmap.md docs/progress.md 및 rg로 작업표/상세 범위/상단 명칭 일치를 확인. 문서만 변경했으므로 제품 테스트·Linux 명령 실행은 하지 않았다.
- 남은 ID: 6.1~6.7 구현 미착수. 다음 첫 행동: 6.6 구현 요청 시 기본 명령 목록과 간단한 복사 UI를 작성한다. 기존 Phase 전체 요청은 6.1부터 진행한다.

## G.8.6 로컬 커밋 요청 (2026-11-05)

- 사용자 요청으로8.6의 중단 대응·장기/실환경 검증 도구와 관련 문서만 로컬 커밋 대상으로 묶는다. 제목은 `fix(survivor): pause safely after suspension and verify release`이며 원격 푸시는 하지 않는다. 별도 G.8.Q1 콘텐츠/시각 개선·Phase6 계획·기존 제품명 검토 변경은 작업 트리에 보존하고 이번 커밋에서 제외한다.
- 공유 문서의8.6 부분만 스테이징하고 diff/공백 검사와 파일 목록을 확인한다. 제품 코드는 직전8.6의 단위215개·브라우저30개·실제 PTY/SSH·일반 입력 두보스·산출물/설치 검증 후 이 커밋 작업에서 바꾸지 않아 기능 검사를 반복 실행하지 않는다. 이번 커밋이 콘텐츠버전4/병행 작업의 검증을 뜻하지 않는다.
- 남은 ID는 G.8.6의 사람 평가·실제 OS 절전/종료·Mac·장시간 전투 메모리/전경 프레임 간격 및 기존 환경 대기다. 다음 첫 행동은 위8.6 인계의 보존 EXE/manifest 확인 후 남은 수동/환경 검증이다.


## Phase 6.6 파일 찾기·로그 필터·조작표 확장 (2026-11-05)

- 사용자 추가 요청: 파일명/설치 경로 찾기, tail/vi 등의 이동·검색·페이지·종료 범례, tail/cat에서 원하는 내용만 쉽게 필터해서 보기. 세 요청을 roadmap 6.6에 함께 반영했다.
- 변경 파일: docs/roadmap.md §4.0/§16/6.6, docs/progress.md 상단/이번 기록. 기본 복사 UI를 유지하고 포함/제외/OR/AND/앞뒤/실시간 필터 예제와 교체할 부분 강조, vi/vim/less/tail/cat별 조작표를 추가했다. cat/tail에 없는 자체 검색·페이지 기능을 표시하지 않으며 스크롤백/less와 구분한다.
- 자동 조작표는 지원 셸의 실행 메타데이터 확인 시에만 표시하고 불가 환경은 수동 선택·고정한다. 과거의 “셸 통합 없음”은 자동 완성 관련 범위 제외였으며 이번 제한적 실행 상태 연동은 별도 추가 요청이다. 명령/인증 입력 수집·자동 실행은 하지 않는다.
- 검증: git diff --check -- docs/roadmap.md docs/progress.md 및 작업표/상세 제목 대조. 이번에는 계획 문서만 변경해 명령 실행·필터/SSH/UI 검사는 하지 않았다. 구현 시 Linux fixture와 실제 PTY로 검증한다.
- 남은 ID: 6.1~6.7 미착수. 다음 첫 행동: 6.6 지정 시 기본 명령/필터 목록·짧은 키 범례 데이터를 정하고 기존 터미널의 실행 메타데이터 지원 여부를 확인한다. 전체 Phase 6 요청은 6.1부터 진행한다.


## Phase 6.3·6.7 구현 진행 (2026-11-05)

- 요청 범위: 세션 로그와 PodTree. 6.1/6.2/6.4/6.5/6.6의 병행 변경을 보존한다.
- 사용자에게 PodTree 원본의 포함·수정·배포 권한을 확인받았다. 원본은 변경하지 않고 2.4.0-daxterm.1 앱 자산과 출처/해시를 추가했다. 별도 공개 라이선스를 추정하지 않는다.
- 진행 파일: src-tauri/src/session_log.rs, podtree.rs, ssh/local/lib의 출력·수명 연결, assets/podtree, build/capability 명령 등록, SessionLog/PodTreeDialog/session/TerminalPane/App UI.
- 현재 검증: TypeScript 통과, 초기 로그 Rust 단위 3개 통과, WSL Bash 구문 검사 통과. 전체 빌드·추가 단위·실제 Windows/SSH/Kubernetes 검증 진행 중으로 완료 아님.
- 남은 ID: 6.3·6.7 통합 검증/보완 및 Mac 환경 대기. 다음 첫 행동: 최신 빌드로 로그 출력/회전/정지와 PodTree 독립 PTY/조회 차단/종료 정리를 실증한다. 아래 최종 기록이 추가되면 그 결과를 우선한다.

## 6.1 폴더 전송·영속 전송 큐 — 구현/검증 진행 (2026-11-05)

- 요청 범위는 6.1만이다. 공유 트리의 6.3/6.4/6.5/6.7 등 병행 변경은 되돌리거나 이 작업의 구현으로 보고하지 않는다.
- 제품 파일: `src-tauri/src/transfer_queue.rs`, `sftp.rs`, `ftp.rs`, `workspace.rs`, 명령 등록 `lib.rs`/`build.rs`/`capabilities/main.json`; `src/features/sftp/{FilePanel,TransferQueue}.tsx`, `src/app/workspace.css`. 기존 단일 파일 엔진의 부분 파일 전체 prefix/원본 크기·시각 검증을 재사용한다.
- 폴더 사전 탐색/빈 폴더/상대 경로, 100개 큐·동시2·묶음10,000항목·전체20,000·깊이64·탐색 경로4MiB·기록16MiB/전체64MiB 상한. 큐 상태/순서/결과를 SQLite settings의 version1 queue 레코드로 저장하고 이전 transfer 레코드를 이행한다. 재시작은 자동 실행하지 않고 같은 프로필/목적지 재인증 후 확인 재개한다. 인증 비밀은 저장하지 않는다.
- 충돌은 기본 건너뛰기/UUID 접미사 이름 변경/선택 전체에 명시적 덮어쓰기. 같은 폴더는 병합한다. 링크·junction·특수파일/Windows 위험 이름·경로 이탈/중복 목적지를 거부한다. 취소는 부분 파일·빈 폴더 보존, 별도 정리도 기존 파일/완료 파일/빈 폴더는 삭제하지 않는다.
- SFTP 덮어쓰기는 posix-rename 확장, 로컬은 rename, FTP는 기존 파일 백업→교체→백업 정리와 재시작 복구를 사용한다. 확장 미지원 SFTP는 기존 파일을 보존하며 실패한다. 완료 직전 중단은 저장된 intent와 전체 바이트 비교로 복구한다.
- 검증 도구: `src-tauri/examples/queue/checks.rs`를 기존 `phase1_probe.rs`/`ftp_probe.rs`에서 실행. `tests/ui/transfer-queue.spec.ts`, `tests/ui/fixtures/queue.{html,tsx}`, 별도 포트의 `tests/queue.config.ts`.
- 현재 통과: Rust queue 단위5개, `node scripts/run-phase1.mjs` 종료0(신규 폴더·빈 폴더·한글/공백·동명·24작은파일 왕복/충돌3종/64MiB중지·영속복구·재개/동시2·순서·묶음취소·링크거부 + 기존128MiB재개·SSH전체), `playwright test --config tests/queue.config.ts --workers=1` 2개(360/800px·키보드·상태·묶음·새연결ID·결과). 캡처 `target/verification/transfer-queue-{360,800}.png` 확인.
- 중간 실패/보완: FTP Windows 서버의 기존 파일 위 RNTO 거부→백업 교체 구현. 기존 download prefix 검사 후 ABOR의226/225응답 경합→부분 RETR 검사 세션을 버리고 새 세션에서 REST. FTP/FTPS 신규 큐는 이후 통과했으나 기존 FTPS 파일작업 중550이 한 번 발생해 전체 회귀를 다시 확인한다. 첫 UI fixture는 좁은창의 `.files` 숨김 CSS로 실패했고 독립 fixture 표시를 수정해 통과했다.
- 전체 clippy/typecheck 중간 실행은 병행 파일의 `TerminalSession.podtree` 타입 및 `session_transfer.rs`/`settings.rs` lint 오류를 보고했다. 이 상태를 전체 통과로 기록하지 않는다.
- 남은 ID: **6.1 검증 진행** — 최종 소스 Rust/TS/lint/빌드, 실제 권한·ENOSPC·탐색 취소·원본 변경/단절·Windows 실제 앱 재시작/UI·FTP/FTPS 전체 회귀. OS 폴더 선택/물리 드롭과 Mac은 아직 미실행. 다음 첫 행동은 현재 실행 중인 FTP/컴파일 결과 확인 후 `queue/checks.rs`의 실제 SFTP 제한 tmpfs/권한 검사를 실행하고 native 큐 검증을 완료하는 것이다.


## Phase 6.4/6.5 구현·Windows 자동 검증 완료 (2026-11-05)

- 요청 범위: 6.4 점프 호스트 → 6.5 세션 관리·이관. 병행 중인 6.1~6.3/6.6~6.7 및 기존 작업 파일을 보존했다. 커밋·푸시·배포하지 않았다.
- 제품: `src-tauri/src/{routes,ssh,ssh_auth,storage,commands,settings,session_management,session_transfer,config_includes}.rs`, IPC 등록/권한, `src/features/sessions/{SessionForm,JumpEditor,SessionManager,SessionTransfer,model}`, `src/lib/ipc.ts`, App 그룹/검색, terminal/session.ts의 홉별 host-key challenge. SQLite4/JSON3, v1/v2 읽기 유지.
- 검사: `examples/jump_checks/mod.rs`, phase1_probe와 run-phase1의 `--jumps`, `scripts/test-jump-native.mjs`, model 단위와 session-manager 브라우저 fixture/spec. Schema v3와 기존 v2 파일을 분리 보존했다.
- 실제 엔진: 최종 `node scripts/run-phase1.mjs --jumps` 종료0. 1/2홉·암호/RSA SHA-2/MFA/OS agent, PTY·SFTP/편집·모니터링·Local/Remote/SOCKS5, 중간 실제 단절/종속 터널 종료·직접 연결 격리·새 셸 재접속, 첫/중간/최종 변경 호스트키 차단·포워딩 handshake timeout·인증 취소·맵 정리 통과. 임시 fixture 제거 확인.
- 실제 Windows 앱: `DACHSTERM_TEST_BINARY`를 보존 EXE로 지정한 `node scripts/run-phase1.mjs --native --jumps --reuse-build` 종료0. 두 host:port의 승인·경유 암호 입력·실제 PTY, v3 참조 재매핑/그룹·일괄 미리보기/적용·템플릿·비밀 제외 복구 내보내기/재시작 통과, pageErrors0. `target/verification/session-management-native.{json,png}`, `session-v3-export.json`에 근거 보존. 직전 빌드의 `--native --session-transfer --reuse-build`도 종료0: 기존 v2/직접 접속·암호 일회용/저장 동의·OS 보관함 재사용/잠금 실패 회귀 통과.
- 자동 검사: `cargo test -p dachsterm --lib -- --test-threads=1` 최종54개, `cargo clippy -p dachsterm --all-targets -- -D warnings` 통과. `npx vitest run src/features/sessions --maxWorkers=1` 3개, `npx playwright test tests/ui/session-manager.spec.ts tests/ui/session-transfer.spec.ts --workers=1` 8개, 앞선 navigation 포함 실행11개 통과. `tsc --noEmit`, 관련 프런트 소스 ESLint, 최종 `tauri build --debug --no-bundle` 통과. 기존 번들 크기 경고 유지.
- 검증 실행 파일: `target/verification/phase64-65/daxterm-debug.exe`, SHA256 `74E4B3566DF94481B8B87117C194A704BAB741552DFF6A51A1979327806C3304`. 병행 빌드가 공유 `target/debug`를 덮어쓸 수 있어 별도로 보존했다. 이후 변경은 Rust 서식/문서 정리이며 release/설치 패키지를 갱신하지 않았다.
- 최종 정리: 해당 Rust 파일/예제의 `rustfmt --edition 2024 --config skip_children=true --check`와 `git diff --check` 종료0. 보존 EXE 해시를 다시 확인해 native 결과 JSON과 일치했다.
- 발견/수정: 기존 단일 trust 응답 상태 때문에 두 번째 홉 UI 승인 실패. 상태를 홉마다 재설정하고 일회용 challenge를 검증하도록 변경했다. 빠른 다음 이벤트를 이전 IPC 응답으로 지우지 않게 TS trust 처리도 수정했다.
- 검사 도구 보완: 단절 후 없어진 control에 ACK를 보내던 probe와 최종 호스트키 검사 중 MFA에 응답하지 않던 probe를 수정해 재실행했다. 이전 도구 실패를 제품의 단절/호스트키 성공 근거로 사용하지 않는다.
- 남은 ID: **6.5 외부 실파일·제품 버전별 대조 및 OS 파일 선택/저장**, **6.4/6.5 Mac 실기기**, **6.4 실제 OTP/하드웨어 agent·절전/장시간**. 환경/익명화 원본 부재로 미실행이며 합성 어댑터·Windows 검사로 대체하지 않는다. 최신 release/설치 패키지는 별도 5.3 범위다.
- 다음 첫 행동: 실제 PuTTY/MobaXterm에서 생성한 익명화 설정과 제품 버전을 확보해 `docs/verification/phase-6-jump-sessions.md`의 지원표대로 비교하고 Windows OS 대화상자 가져오기/저장을 확인한다. Mac 환경이 준비되면 동일 경유 시나리오를 실제 실행한다. 요청하지 않은 후속 소번호로 확장하지 않는다.

## 6.1 최종 구현·Windows 자동 검증 (2026-11-05)

- 구현: 재귀 업·다운로드/다중 선택·드롭 확인/빈 폴더, 충돌 건너뛰기·이름 변경·명시적 묶음 덮어쓰기, SQLite 영속 큐·7상태·대기순서·개별/묶음 제어·동시2, 탐색/깊이/기록/결과 IPC 상한, symlink/junction·위험경로·중복 목적지 거부, 파일별 오류/결과, 같은 대상 재인증·완료 항목 보존. 기존 부분 prefix 전체 검증을 재사용한다. 백업/준비 파일을 사용한 교체와 완료 직전 중단 복구를 포함한다.
- 파일: 위 진행 기록의 제품 파일 및 새 `docs/verification/phase-6-1.md`, README 전송 안내/제약, roadmap 6.1 체크리스트. 검사 `examples/queue/checks.rs`, 기존 OpenSSH/FTP probe 연결, `scripts/test-transfer-queue-native.mjs`/`run-ftp.mjs --queue-native-only`, UI fixture/spec/별도포트 config. 다른 Phase 병행 파일은 보존한다.
- 정적/단위: `cargo test -p dachsterm --lib --locked` **54개 통과**(큐5 포함), `cargo clippy -p dachsterm --lib --locked -- -D warnings` 종료0. `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src --maxWorkers=1` **41파일652개 통과**. TypeScript·이번 TS/JS ESLint·이번 파일 Prettier·Rust 변경 소스 rustfmt 통과. 공유 트리의 중간 타입/lint 오류는 이후 해소된 상태에서 다시 검사했다. 게임/다른 기능의 최종 실환경 검증으로 대신하지 않는다.
- 실제 SFTP: `node scripts/run-phase1.mjs` 최종 종료0. 중첩/빈 폴더/한글/공백/동명·24작은파일 왕복, 충돌3종,64MiB재개/저장복구/잘못된프로필 거부,동시2·순서·묶음취소·재시도,링크,탐색중지/10,001개상한/원본변경 거부. chmod권한거부와 컨테이너 전용 제한 tmpfs의 실제 ENOSPC·정리 통과. 기존128MiB부분변조·업다운재개, SSH 인증/호스트키/5연결/터널/편집/모니터링/정리도 통과했다. 확대 검사 중 한 번 전체 실행 실패가 있었고(큐 검사는 통과), 테스트 전체 상한을300→600초로 늘리고 최종 전체를 다시 통과했다. 이전 실패 원인을 시간 초과로 확정해 기록하지 않는다.
- 실제 FTP/FTPS: `node scripts/run-ftp.mjs` 최종 종료0. 위 공통 큐 시나리오를 FTP/FTPS/CP949 각각 통과했고 기존32MiB 재개/복사·이름 변경·삭제도 통과했다. FTP Windows RNTO 덮어쓰기거부→백업교체, 부분RETR 종료의226/225응답경합/파일핸들잔류→ABOR응답처리 후 새세션REST로 보완했다.
- UI: `node node_modules/@playwright/test/cli.js test --config tests/queue.config.ts --workers=1` **360/800px 2개 통과**, 키보드/7상태/묶음ID/새연결ID/순서/결과/가로넘침, 스크린샷 확인. 좁은 창 fixture 숨김은 fixture에서 보정했다. 제품의 새 폴더 업로드 버튼 행과 큐 표시 높이도 보완했다.
- 실제 Windows: debug Tauri 빌드(tsc-b/Vite 포함) 종료0. WebView2+실제FTPS의256MiB전송중 프로세스트리 강제종료→재시작paused/비자동실행→다시암호인증/새연결ID→제품UI재개→6항목완료·전체SHA256일치·기완료파일mtime유지·pageerror0 통과. 처음 발견한 동기 `transfer_control`의 Tokio reactor 부재 panic은 async IPC로 수정하고 재실행해 통과했다. 인증 암호는 세션에 저장하지 않았다. 테스트 앱/fixture 종료·정리.
- 실행: `DACHSTERM_TEST_BINARY=<보존 debug> node scripts/run-ftp.mjs --reuse-build --queue-native-only`. 보존 EXE `target/verification/transfer-queue-artifacts/daxterm-debug.exe`, 증거 `target/verification/transfer-queue-native/{result.json,queue.png}`. 최종 해시는 아래 종료 기록에 남긴다. 공유 target/debug와 release/NSIS는 이 고정본과 구분한다. 이번 작업은 release/설치본을 만들지 않았다.
- 남은 ID: **6.1 수동/환경 검증** — Windows OS 폴더 다중선택/실제 탐색기 드롭, 실제 네트워크 단절/절전, Mac 빌드·UI·파일 권한·링크·선택/드롭. 원격SFTP tmpfs ENOSPC 외 로컬Windows/FTP 실디스크소진 검사는 미실행. 현재 구현으로6.2~6.7 또는Phase6전체 완료를 선언하지 않는다. 기존 W/Phase5 및 병행 기능의 대기를 유지한다.
- 다음 첫 행동: 보존EXE와 result.json SHA를 대조하고 OS 폴더선택/물리드롭을 검증한다. 별도 테스트환경에서 네트워크단절/절전 및Mac 항목을 이어 기록한다. 이후 사용자가 지정한 다음 Phase를 확인한다.

- 6.1 종료 확인: 최종 보존 debug SHA256 `7b8ee9f9d52ad698aa6cdc9528365b13d2685cf42076406800e8c35181d665ab`. 최신 큐/오류 결과/복구 정리/버튼 배치/큐 높이를 포함한 Tauri debug 빌드 후 위 EXE를 명시하여 native256MiB 강제종료/재인증/UI재개 검사를 다시 실행해 종료0, pageerror0, 기존완료파일mtime유지/전체해시일치. `result.json`과 EXE SHA 일치를 재확인했다. 최종 OpenSSH 전체 및 FTP/FTPS/CP949 전체 회귀도 종료0. 이번 파일의 diff 공백/포맷/링크 검사와 테스트 프로세스 정리를 수행했으며 남은 수동/환경 ID와 다음 첫 행동은 위 기록과 같다.


## 6.3 세션 로그·6.7 PodTree 최종 구현·Windows 검증 (2026-11-05)

- 범위: 요청한6.3/6.7 구현. 병행6.1·6.4/6.5 변경을 유지했으며6.2/6.6으로 확장하지 않았다. PodTree 포함·수정·배포 권한은 사용자가 확인했다. 원본 파일은 변경하지 않고 버전2.4.0/내장2.4.0-daxterm.1·양쪽SHA·저작 고지를 고정했다.
- 제품 파일: `src-tauri/src/session_log.rs`, `podtree.rs`, `ssh.rs`·`local.rs` PTY 연결, `lib.rs` 앱 종료/IPC, `build.rs`·capabilities·12개 자동 권한 파일, tauri 자산 고지 등록. `src-tauri/assets/podtree/{podtree.sh,provenance.json}`, `licenses/PODTREE_NOTICE.txt`. UI는 `SessionLog.tsx`·`PodTreeDialog.tsx`, `TerminalPane.tsx`·`session.ts`·`App.tsx` 연결. README/roadmap 및 `docs/verification/phase63-67.md`에 계약·사용법·제약을 기록했다.
- 로그: 출력 생산자에서1회 기록, UTF-8/CP949·ANSI 상태 유지, 유한 비동기 큐, 마스킹·pause 경계·flush, 크기/UTC 날짜 회전·기록별 보관 상한. 이전 기록 폴더의 총 용량은 사용자 관리. 인증 이벤트/입력은 연결하지 않으며 원격 출력의 비밀 자동 제거를 보장하지 않는다. 자동 설정은 명시적으로만 저장하고 마스크는 저장하지 않는다.
- PodTree: 기존 SSH 또는 WSL/Bash의 별도 PTY, 준비 검사·고정 scope·사용자 전용 임시 배치, 기본 조회·명시적 운영. 조회 모드 exec/debug/capture/forward/raw 경로까지 차단, 운영 부작용/대상 확인, 자식 작업·포워딩·임시 파일 정리. 브로드캐스트/스니펫/세션 로그에서 제외한다.
- 검사 파일: `scripts/setup-phase63-67.sh`, `tests/podtree-rbac.sh`, `scripts/test-phase63-67-native.mjs`. 실제 독립 kind클러스터/제한RBAC와 일회용 OpenSSH fixture를 사용했다. 테스트 인증정보는 앱 프로필/문서/결과에 저장하지 않았다.
- 자동 검사: `cargo test -p dachsterm --lib`54개, 최종 해당 로그6개/PodTree2개, `cargo clippy -p dachsterm --lib -- -D warnings` 통과. `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src --maxWorkers=1`41파일652개, TypeScript/관련 ESLint·Prettier, Bash3파일 구문 통과. 최종 Tauri debug 빌드 성공, 기존 Vite 청크 크기 경고 유지.
- 실제 Windows: 보존 EXE를 지정한 `node scripts/test-phase63-67-native.mjs` 최종13시나리오/종료0/pageErrors0. PowerShell·SSH·WSL 로그, 합성 마스크/ANSI 경계, CP949 분할,3MiB 이상 출력/1MiB 회전/2파일 보관, 창 분리30줄 순서/정확히1회, 자동 기록 재시작/flush. 실제 SSH/WSL Kubernetes 트리·로그·RBAC·빈 목록·이벤트·도구 부재·조회 키 차단·운영 포워딩·resize·탭/부모 연결 종료 정리·current-context 불변. 560px 다크 로그 UI와 크림 PodTree 화면을 확인했다.
- 보존 산출물: `target/verification/phase63-67-artifacts/daxterm-debug.exe`, SHA256 `4cd220a16efe4d8e54151a98a04391f2f611320c19cb20e89f9546f5aa78b8e4`. 결과 JSON/화면/소스 해시 manifest를 같은 폴더에 보존한다. 공유 target/debug 및 기존 release/NSIS와 구분한다. 테스트 과정의 selector/합성 키·뷰포트 보정 전 실패를 성공 근거로 쓰지 않고 최종 전체 통과 결과만 사용했다.
- 남은 ID: **6.3 환경 검증** — 실제 디스크 소진/OS 강제 종료·24시간 기록·Mac; **6.7 환경 검증** — 물리 키보드/IME·Mac, GPU/vLLM/DCGM·디버그 이미지/패킷 캡처, 물리 네트워크 단절. 필요한 장비/장시간/선택 환경이 없어 미실행이며 단위 오류 주입이나 기본 트리 성공으로 대신하지 않는다. **5.3** 최신 release/설치본 생성·검증은 이번에 수행하지 않았다.
- 다음 첫 행동: 보존 EXE/결과 SHA를 대조하고 Windows 물리 키보드·IME와 로그 OS 폴더 선택을 검증한다. 격리 디스크/장시간 및 GPU·Mac 환경이 준비되면 위 대기 항목을 실제 실행하고 기록한다. 기본 Phase6 잔여6.2/6.6은 별도 요청 범위다.

- 6.3/6.7 종료 확인: 보존 EXE와 결과 JSON SHA 일치·증거/소스 해시 manifest 복사 완료. 테스트 전용 kind클러스터·임시 kubeconfig·OpenSSH fixture 정리 완료. 마지막 `git diff --check`와 관련 Prettier·TypeScript·ESLint·Bash 구문 검사 통과. 사용자 기본 kubeconfig/다른 컨테이너는 변경하지 않았다.

## 2026-11-05 다른 세션 구현 완료 여부 확인

- 요청: 다른 세션의 구현 완료 여부 확인. `docs/roadmap.md`·이 문서의 최신 최종 기록, 제품 파일 존재 및 `git -c safe.directory=D:/Work/daxterm-workspace status --short`를 대조했다. 제품 코드는 변경하지 않았다.
- 확인: 6.1·6.3·6.4·6.5·6.7은 구현과 Windows 검증 완료 기록이 있다. 6.2 스니펫·6.6 기본 명령/로그 필터/조작표는 roadmap 미체크이며 현재 파일 목록에서 구현을 확인하지 못했다. 전체 Phase 6 완료가 아니다.
- 이번에는 테스트/빌드/실제 SSH를 재실행하지 않았다. 기존 검증 결과는 각 세션 기록을 인용하며, 다른 세션의 실시간 실행 상태는 확인하지 않았다. 현재 Phase 6 변경은 작업 트리에 있고 미커밋 파일이 남아 있다. 최신 Phase 6 release/설치본 반영은 완료 기록이 없다.
- 남은 ID: 6.2·6.6 구현, 각 기능의 수동/환경 검증, 5.3 최신 release/설치본. 다음 첫 행동: 전체 Phase 6 구현 요청 시 6.2부터 현재 코드를 재확인하고 진행한다.

## 6.2·6.6 구현 및 검증 진행 (2026-11-05)

- 요청 범위: 스니펫과 기본 명령·로그 필터·프로그램 조작표. `snippets.rs`/IPC 등록, `SnippetDialog`/`snippets`, `CommandGuide`/`guideData`/공통 CSS, App/독립 창/TerminalSession 연결을 구현했다.
- 현재 통과: Rust56개(샌드박스의 기존 symlink 권한 실패 후 권한 허용 재검사), 프런트42파일656개, 브라우저 최초3개, TypeScript·관련 ESLint, all-targets clippy. 실제 Linux 파일/경로·필터·실시간 버퍼링·로그 회전·SIGINT 검사는 통과했다. 최종 UI 확대/현재 소스 빌드·native 재검사 중이다.
- 실제 Windows 중간 결과: PowerShell 입력만/Enter, 실제 SSH 한글·여러줄·명시대상·브로드캐스트 중복 방지·실패 격리, SSH vi/vim.tiny/less/cat/tail와 WSL cat의 실행 알림/종료·수동 고정·탭 격리를 확인했다. 최종 전체 통과로 기록하지 않는다.
- 발견한 선행 수정: 독립 창에서 과거 TUI 상태질의 출력 재생 시 xterm 자동 응답이 서버 입력에 섞였다. Broker의 재생 시작/끝 이벤트와 xterm 파싱 완료까지 입력 차단을 추가했으며 정확한 스니펫 전달을 위해 현재 재검증한다. Bash 연동은 파이프/리다이렉션에 알림을 넣지 않고 현재 셸의 prompt 알림으로 Ctrl+C 종료를 처리한다.
- 검사 파일: `tests/ui/assistant.spec.ts`/fixture/config, `scripts/test-assistant-native.mjs`, `tests/assistant-linux.py`, 기존 OpenSSH 이미지에 less 추가. 인증정보는 기록하지 않는다. 후속 최종 기록을 우선한다.
- 남은 ID: 6.2/6.6 최종 native·확대UI·최종빌드 검증, 물리IME/Mac 환경 검증. 다음 첫 행동: 수정한 재생 경계가 포함된 앱을 빌드하고 독립 창·재시작까지 native 전체를 재실행한다.


## 6.2·6.6 최종 구현·Windows 실제 검증 (2026-11-05)

- 요청한 두 소번호를 구현했다. 다른 세션의6.1·6.3~6.5·6.7 변경은 보존했으며 커밋/푸시/배포하지 않았다. 앞선 “6.2/6.6 미구현” 및 중간 검증 기록은 당시 이력이며 이 최종 기록을 우선한다.
- 제품: `src-tauri/src/snippets.rs`/IPC·권한3개, `src/features/terminal/{SnippetDialog,snippets,CommandGuide,guideData,assistant.css,session,TerminalPane}`, `src/app/{App,DetachedWindow}.tsx`. SQLite revision 충돌/필드·용량 상한, CRUD·검색·복제·삭제, 자리표시자 임시 값, 정확한 연결ID/소유권·최종본문 확인, 입력만/Enter 실행, 여러줄 확인, 대상별 오류·브로드캐스트 우회. 비밀정보 저장 확인을 요구하며 인증 UI/PodTree는 제외한다.
- 명령 모음: GNU/Linux 기본26개·필터7개, 강조 부분 교체/순수명령 복사·실패 안내, 인용·실시간/회전 설명. 조작표는 탭별 수동고정/끄기 및 명시적 Bash 실행 알림만 사용한다. 파이프/리다이렉션에 메타데이터를 넣지 않으며 prompt 종료 알림으로 Ctrl+C 후 해제한다. 설정 파일·명령 인자·이력은 앱에서 수집/저장하지 않는다.
- 선행 수정: 실제 독립 창 검사에서 과거 TUI DSR/DA 질의 출력 재생이 서버에 응답을 다시 보내 스니펫 입력에 섞이는 문제를 발견했다. `ssh::Event::Replay`·`windows::Broker::attach` 시작/끝과 `TerminalSession` xterm 파싱 완료 경계까지 입력/스니펫 준비를 막도록 보완해 최종 실제 검사에서 전달/출력을 통과했다.
- 최종 자동 검사: `cargo test -p dachsterm --lib --locked`56개, `cargo clippy -p dachsterm --all-targets --locked -- -D warnings`, 프런트42파일656개, TypeScript·src전체/추가검사 ESLint·해당파일 Prettier/rustfmt 통과. 초기 전체Rust의 기존 큐symlink 검사는 sandbox 권한부족으로 실패했고 권한허용 최종 전체에서 통과했다. Vite 큰청크·Windows 캐시하드링크복사 경고는 유지한다.
- 브라우저: `node node_modules/@playwright/test/cli.js test --config tests/assistant.config.ts --workers=1` 최종5개 통과. CRUD/복제/삭제/검색/복원·리터럴/한글·여러줄 확인/취소·재접속 거부·명시다중대상/키보드·PodTree제외·복사문자열/실패·360/800px·자동조작표열기/해제/고정유지. 화면4종을 시각 확인했다.
- 실제: 고정 debug를 `DACHSTERM_TEST_BINARY`로 지정한 `node scripts/test-assistant-native.mjs` 최종7개 시나리오 묶음/종료0/pageErrors0. Linux fixture의 파일/경로/고정문자/포함/제외/OR/AND/앞뒤/인용·실시간버퍼링/교체/SIGINT, PowerShell입력만/Enter·실제SSH한글/여러줄·멀티입력중복방지/명시대상/실패격리, SSH vi/vim.tiny/less/cat/tail와 WSLcat 메타데이터·Ctrl+C/고정/탭격리, 독립창스니펫/이전창소유권거부, 실제재시작SQLite복원/임시값미보존/비자동실행을 확인했다.
- 산출물: `target/verification/phase62-66-artifacts/daxterm-debug.exe`, SHA256 `0f6a92e588eee799267f2e4e62c563899274f7221c4f2f00b4953d737c466155`. `target/verification/assistant-native.json`과 결과/화면 사본을 보존한다. 최종 제품 동작과 동일하며 이후 Rust 서식/문서·검사만 정리했다. 기존release/NSIS를 이번 결과로 대체하지 않는다.
- 상세/명령/중간실패: `docs/verification/phase-6-2-6.md`. README·roadmap6.2/6.6 구현체크를 갱신했다. 테스트용OpenSSH컨테이너와 앱은 정상/정리 경로로 종료했다. 사용자SSH/WSL설정파일은 변경하지 않았다.
- 남은 ID: **6.2/6.6 물리WindowsIME·Mac**. 스니펫CP949 실서버는 별도 미실행(기존변환단위/실제UTF-8과 구분). **5.3** 최신release/설치본 생성·설치검증. 나머지 소번호의 외부실파일·장시간·수동/선택환경 대기는 유지한다. **전체Phase6 환경검증 완료를 선언하지 않는다.**
- 다음 첫 행동: 고정EXE와 결과JSON의SHA를 대조하고 물리IME/Mac검사를 진행한다. 배포 요청 시 최신소스release/설치본을 생성해 실제 설치 검증한다.

## Phase 6 전체 변경 커밋·푸시 요청 (2026-11-06)

- 사용자 요청: 작업 트리 변경 전체를 커밋하고 원격에 푸시한다. 범위는 병행 구현한6.1~6.7 제품/IPC/권한·PodTree자산/고지·테스트·README/roadmap/검증기록과 독립창재생입력 수정이다.
- 대상: `main` → `origin/main` (`splatoon-git/daxterm-workspace`). 원격 fetch 후 로컬이9커밋 앞서고 원격 단독 변경은0개임을 확인했다. 사용자 전체 푸시 요청에 따라 기존9개 로컬커밋과 이번Phase6커밋을 함께 일반 push한다. 빌드EXE/설치본/target/dist 등 기존 무시 파일은 추가하지 않는다.
- 이번 확인: `git diff --check` 통과, 신규 자산/고지와 .gitignore 제외 확인. 제품 코드를 추가 변경하지 않아 테스트를 재실행하지 않았으며 직전 최종56개Rust/656개프런트/5개UI/실제Windows7개시나리오 결과는 위 구현 기록을 따른다. Mac·수동·최신설치본 대기를 해소했다고 기록하지 않는다.
- 이 기록을 포함한 커밋/원격 반영 결과는 Git 이력과 `git status`/`origin/main` 대조로 확인한다. 남은ID는 위6.2/6.6 환경검증 및 기존 각 소번호·5.3과 같다. 다음 구현 행동은 요청 범위에 따라 물리IME/Mac검증 또는 최신release/설치본 생성·검증이다.

## N.1 — DachsTerm 제품명·내부 식별자 전환 (2026-11-06)

- 사용자 요청: 안 보이는 내부 이름까지 전부 변경, 기존 개발 데이터 호환 불필요. 제품명 `DachsTerm`, npm/Rust/기본 실행 `dachsterm`, 앱/OS 저장소 ID `app.dachsterm.desktop`, 환경변수 `DACHSTERM_*`, localStorage·게임 저장·JSON `dachsterm.*`, 마스터 키 AAD·셸 알림/함수·전송/압축/편집 임시 이름을 변경했다. 이전 데이터 읽기/이전·삭제는 추가하지 않았다.
- 파일: package/Cargo manifests와 locks, Tauri 설정·main/lib/credentials/vault/settings/session_transfer/monitoring/podtree/파일·전송 계열, App/테마/터미널/게임 저장, 테스트/fixture/검증 스크립트·JSON Schema·README/roadmap/고지·문서. RSA 설명은 `vendor/ssh-key/DACHSTERM-PATCH.md`로 개명. PodTree 변형2.4.0-dachsterm.1과 새 SHA/고지 동기화. 실제 폴더·GitHub 주소, 과거 증거 파일명/경로·SHA는 보존했고 보존 산출물 검사는 manifest의 파일명을 읽도록 보완했다. 커밋/푸시하지 않았다.
- 자동: 프런트42파일656개, Rust56+probe1=57개, 브라우저전체86개 통과. npm lint/build/format:check, workspace all-targets clippy/fmt 통과. JSON/Python/PowerShell/Bash 구문 및 실제 Bash 연동 설치, notices424개/누락0, 과거 증거4파일/5결과 해시 확인. 최종 diff/링크/잔여이름 검사도 수행한다. 기존 Vite 큰청크 경고는 유지한다.
- 실제 Windows: 새 debug로 PowerShell/CMD/Ubuntu WSL PTY·한글/분할/resize/종료, 테마12종·재시작, OS 인증정보 저장/마스터 암호화/복호화/잠금/재시작/테스트 비밀삭제, 복구 v3/new format·새ID·경로 거부 통과. FTP/FTPS UI와 실제 FTP/FTPS/CP949 전체32MiB/64MiB 전송·재개/영속 큐 회귀 통과. NSIS 설치/제품명·레지스트리/동일버전재설치/실행/정상종료/제거 통과.
- 발견/처리: 복구검사 스크립트가 과거 스키마 필드만 기대해 실패하여 현행 v3 format/templates를 검사하도록 고쳤다. FTP 첫 실패ConnectionReset·두번째StorageFull, C:여유약0.11GiB 확인. 첫 실패 원인은 확정하지 않는다. 제품 전송 코드는 추가 변경 없이 D:의 전용 TEMP/TMP로 전체 재실행해 통과했다. Docker 엔진 응답은 여전히 없어 실제 SSH/PodTree 재검증은 미실행, 확인용 서비스 시작은 원래 중지상태로 복원했다.
- 산출물: `target/debug/dachsterm.exe`, `target/release/dachsterm.exe`, `target/release/bundle/nsis/DachsTerm_0.5.1_x64-setup.exe`(12,404,911바이트,11.83MiB). 실제 파일/설치payload SHA 및 전체 명령/결과는 [개명 검증](verification/rename.md). 새 설치본은 미서명/비공개이며 기존 설치본과 별개다. 임시 native harness·결과/화면은 무시되는 `target/verification/rename*`에 보존한다.
- 남은 ID: **N.1 실제 SSH/OpenSSH/PodTree·Mac 재검증**, 기존 각 Phase의 물리IME/OS조작·네트워크/절전·장시간/선택환경 대기. 이번 Windows 패키지 검사는 전체5.3 공개배포·Mac완료를 뜻하지 않는다. 다음 첫 행동: 디스크 여유와 Docker 엔진 응답을 확보하고 새 debug를 지정한 `node scripts/run-phase1.mjs --native --skip-app-build`로 실제 SSH를 확인한다. Mac환경이 있으면 새 앱 ID/Keychain·빌드/설치를 실제 검증한다. 외부폴더/원격저장소 개명은 별도 요청 범위다.

## N.2 외부 이름 변경·불필요 worktree 정리 진행 (2026-11-06)

- 사용자 요청으로 실제 작업폴더/원격저장소까지 개명하고 불필요한 보존 worktree를 정리한다. GitHub 저장소 및 origin은 `splatoon-git/dachsterm-workspace`로 변경했고 ls-remote main=c2655c7 확인.
- `g86-source`의 변경 제품/검사 소스가 본체에 반영됐음을 대조한 뒤 worktree 제거를 실행했다. Git 등록은 본체1개만 남았다. 그러나 내부 target junction을 먼저 분리하지 않아 Git 제거가 공유 target 빌드/검증 산출물까지 삭제했다. 본체 제품소스·미커밋변경·Git이력은 유지하며 실행/설치 산출물을 다시 생성해야 한다. 이전 N.1 기록의 보존 산출물은 현재 존재 여부를 따로 확인해야 한다.
- 폴더 이동은 실행 중 프로세스의 잠금으로 아직 실패했다. 연결폴더 잔여 정리·앱 정상 종료·폴더/Codex 경로 변경과 재빌드/실행 확인을 계속한다. 실제SSH/Mac 대기는 유지한다.


### N.2 이름 변경 상태 재확인 (2026-11-06)

- `git rev-parse --show-toplevel`과 `git remote get-url origin`으로 현재 작업 폴더와 origin 모두 `dachsterm-workspace`임을 확인했다. 위 폴더 이동 실패는 이전 시점의 기록이다.
- `rg -i dax`와 파일명 검색 결과, 게임 화면 문구(`src/features/games/SnackScene.tsx`의 `DAX’S SNACK TIME`), 게임 컴포넌트·CSS·테스트·설계 문서 파일명에 옛 표기가 남았다. 과거 산출물 경로·제3자 저작자 표기·무결성 해시는 구분한다.
- `Test-Path`로 표준 target 경로의 debug/release EXE 및 0.5.1 NSIS 설치본이 모두 없음을 확인했다. 이번 상태 점검에서는 빌드·실행 검사를 수행하지 않았다. 다음 첫 행동은 N.2 게임 표기와 참조를 정리한 뒤 새 폴더에서 빌드·설치본을 재생성해 실행을 확인하는 것이다. N.1 실제 SSH/PodTree·macOS 재검증도 대기 중이다.


### N.2 게임 이름 통일·README 갱신 (2026-11-06)

- `DachsGames.tsx`, `DachsSprite.tsx`, `dachsEngines.ts`와 대응 단위 테스트, `tests/ui/dachs-games.spec.ts`, `docs/design/dachs-survivor.md`로 파일명을 변경했다. import, 게임 상수·컴포넌트·CSS, 테스트 스크린샷 출력 이름과 문서 참조를 맞췄다. 간식 게임 시작 화면에는 `DACHS’S SNACK TIME`이 표시된다. 한국어 이름은 닥스다.
- README에 GitHub 저장소, 제품·마스코트·Windows 실행 파일명과 빌드 경로를 반영했다. 세션 교환 JSON v3(v1/v2 읽기)와 최대 4홉의 현행 점프 호스트 지원을 바로잡았다. roadmap과 개명 검증 문서의 현재 위치도 갱신했다.
- `rg -il dax`로 제품 소스·스크립트·테스트·설정·README에서 발견 0건. `rg --files --hidden -g '!.git' | rg -i dax`로 관리 대상 파일명 발견 0건. README/docs/마스코트 README의 상대 링크 대상 누락 0건. 과거 검증 기록과 빌드 증거, 제3자 저작권·URL 및 잠금 파일 무결성 값은 보존했다.
- 최초 검사에서 node_modules 실행 도구 누락을 확인하고 잠금 파일 기준 `npm ci --prefer-offline --no-audit --no-fund` 후 재시도했다. `npm run lint` 통과, Vitest(`run src --maxWorkers=2`) 16파일 226개 통과. Playwright(`test tests/ui/dachs-games.spec.ts tests/ui/snack.spec.ts --workers=1`) 12개 통과. 새 제목을 확인하는 1280px 통합 테스트 재실행 1개 통과. 변경 코드의 Prettier 검사와 `git diff --check` 통과. 최종 `npm run format:check`도 전체 통과했다.
- `npm run tauri -- build --bundles nsis`, `npm run tauri -- build --debug --no-bundle` 모두 통과. 새 폴더의 `target/release/dachsterm.exe` (SHA256 `3FAD096A79F9B1794B2791AD557045C330291F42F884A23A0096EA1738FAED65`), `target/debug/dachsterm.exe` (`E6FA58DE7B979C4FF6BCF2C71817DED1E78F381DC527ED1EC3FA63DAB8FC05F1`), `target/release/bundle/nsis/DachsTerm_0.5.1_x64-setup.exe` (`B49F189F655DAFFE9AEF2C85CA4FCCDE34D7440374753F01BCFD070DD4E8AA9C`) 생성. `scripts/test-installer.ps1 -Reinstall`로 설치 등록/제품명·버전, 동일 버전 재설치, 실제 창 초기화·정상 종료·제거 통과. `node scripts/test-games-native.mjs`로 실제 WebView2 게임 6종·로컬 PTY 입력 격리 통과.
- N.2 이름 변경·Windows 재빌드 검증 완료. 남은 ID는 N.1 실제 SSH/OpenSSH·PodTree 및 macOS 재검증이다. 이번에는 게임 개명과 Windows 빌드·설치를 검증했다. 다음 첫 행동은 Docker 엔진 가용 시 현재 debug로 `node scripts/run-phase1.mjs --native --skip-app-build`를 실행하는 것이다.

## G.8.Q2 — 서바이버 지형 잔상감과 레벨업 흐름 개선 (2026-11-06)

- `src/features/games/survivor/{scenery,renderer}.ts`에서 중첩 반투명 수관·지면 타원·야영지 동심원을 정리했다. 지역 테마색으로 만든 불투명 지형 타일, 한 번에 칠하는 교차로, 침엽수·활엽수·바위·꽃과 일부 야영지 텐트를 적용했다. 카메라는 출력 픽셀에 정렬하고 피격 효과를 캐릭터 자세·피해량 표시로 옮겼다. `engine.ts`, `types.ts`에서 이동과 대기 자세를 구분한다.
- `SurvivorGame.tsx`, `survivor.css`에서 같은 전장 위에 성장 카드 패널을 띄운다. 선택 전후 전장·HUD 크기와 위치를 유지하고 작은 화면은 패널 내부를 스크롤한다. 카드에 단축키·종류·신규/랭크·효과 수치를 표시하며 선택 직후 전장 포커스를 복원한다. 전투 일시정지·결과도 인게임 패널로 표시한다.
- 검사 파일은 `engine.test.ts`, `tests/ui/survivor.spec.ts`, `tests/ui/{survivor-quality.spec.ts,fixtures/survivor-quality.ts}`, `scripts/test-survivor-ui-native.mjs`. 카메라 왕복 후 픽셀 일치, 피격 시 지형 고정, 360/560/1280px 패널과 전장 위치, 포커스·연속 선택·테마를 검증했다.
- 최종 `npm run build`, 관련 ESLint·Prettier 통과(Vite 큰 청크 경고). `node node_modules/vitest/vitest.mjs run src/features/games/survivor --testTimeout=30000 --maxWorkers=2` 8파일 163개 통과. `node node_modules/@playwright/test/cli.js test --config target/verification/survivor-flow/playwright.config.ts survivor.spec.ts survivor-profile.spec.ts survivor-quality.spec.ts --workers=1 --output target/survivor-flow-final` 22개 통과. 포트 14437의 독립 Vite를 사용했다. 초기 병렬 실행에서 5초 단위검사 타임아웃, 공유 Vite 연결 거부, Web Locks 소유권 재획득 대기가 있었고 최종 실행에서 통과했다.
- 실제 플레이: 빌드된 프런트의 기본 메뉴로 시작해 입력과 자동공격으로 첫 레벨업, 카드 선택 중 tick 정지·동일 canvas 유지·선택 직후 이동을 확인했다. Windows WebView2 debug에서도 `node scripts/test-survivor-ui-native.mjs` 통과. 실제 이동·첫 성장 선택·Esc 작업 복귀 후 카드 유지·재개·종료 저장 실패/재시도/재실행까지 확인했다. `target/debug/dachsterm.exe` SHA256 `e6fa58de7b979c4ff6bcf2c71817ded1e78f381dc527ed1ec3fa63dab8fc05f1`. 결과·화면은 `target/verification/survivor-ui-native.{json,png}`, `target/verification/survivor-flow/level-up.png`에 있다.
- 남은 ID: G.8.Q2 Windows 구현·플레이 검증 완료. G.8.6 macOS 실기기·사람의 장시간 플레이 평가는 이번 세션에서 미실행. 다음 첫 행동은 Mac에서 동일한 이동·피격·첫 카드 선택 후 재개 흐름을 확인하는 것이다.

## 구조 검토·구현 규칙 추가 (2026-11-06)

- 사용자 요청으로 저장소 전체 구조를 검토하고 규칙을 추가했다. 추가: `CLAUDE.md`, `docs/engineering-rules.md`, `docs/architecture-review.md`. 이후 승인에 따라 CI와 버그 3건을 수정해 `main`에 병합·푸시했다(`9536b28`, CI 실행 `42160705400` 성공).
- CI(P1, P4): `.gitattributes`를 `* text=auto eol=lf`로 변경. 깨끗한 클론에서 수정 전 Prettier 183개 실패, 수정 후 통과. 이전 CI는 `format:check`에서 멈춰 뒤 게이트가 실행된 적이 없었다. 실행 `42156057319`가 첫 성공이다(Vitest 226개, Playwright 87개 포함).
- 테스트 수(P2): `vite.config.ts`에 `test.include`를 추가했다. 이전 기록의 "42파일 656개"는 재현되지 않으며 worktree 사본 집계로 추정한다. 이 수치를 현재 값으로 인용하지 않는다.
- 버그: F1 `UserError`로 스니펫 오류 표시. F2 `app/workspaceTabs.ts`의 `insertTab`으로 분할 화면 새 탭 표시. F3 글꼴·스크롤백을 공용 스토어로 동기화.
- 로컬 검증: `npx vitest run src` 18파일 231개, `npx tsc --noEmit`, `npx eslint src`, `npx playwright test` 87개, `node scripts/test-local-native.mjs`(실제 PTY 분할 패널 글꼴 동기화 단언 추가) 통과. F1, F2 회귀 테스트는 수정을 되돌리면 실패함을 확인했다.
- 미검증: F2는 함수 단위 테스트만 있고 실제 PodTree 탭 동작은 Kubernetes 환경이 필요해 실행하지 않았다. 실제 SSH 네이티브는 후속 P3·B9 작업에서 실행했다.
- P3·B9와 실제 SSH 회귀 결과: [검증 기록](verification/tests-typecheck-and-unused-commands.md). `test:native`는 3회 중 1회만 전체 통과했으며 불안정 원인은 T5로 남겼다.
- 남은 ID: `docs/architecture-review.md`의 P5, P6, B1~B8, B10, B11, U*, T*. 다음 첫 행동은 상단 항목을 따른다.
