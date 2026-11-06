# 구조 검토와 정리 목록

- 검토일: 2026-11-06 / 기준: `c2655c7` + 미커밋 개명 작업(N.1/N.2)
- 검토 중 Codex가 같은 트리를 수정하고 있었다. **줄 번호는 밀릴 수 있으니** 함수명으로 다시 찾는다.
- 앱 실행 없이 코드 읽기와 아래 도구 결과로 판단했다. 수정은 하지 않았다.
- 표시: **확인** = 코드·명령 출력으로 재확인 / **보고** = 코드 리뷰 결과이며 재확인하지 않음

## 결론

**2026-11-06 처리 완료**: P1, P2, P4, F1, F2, F3 (브랜치 `chore/ci-line-endings`). 아래 표와 설명은 검토 시점의 기록이다.

기능별 코드는 생각보다 정돈되어 있다. 복붙 비율은 1.56%(jscpd, 8줄·70토큰 이상)이고, 색상 토큰 규칙 위반은 0건이며, 하위 계층이 `features`를 import하는 경우도 없다.

문제는 다음 세 가지다.

1. **검증 기록을 믿기 어렵다.** CI는 한 번도 통과하지 않았고, 기록된 테스트 수는 실측과 다르다.
2. **같은 개념이 병렬로 구현되어 동작이 벌어지고 있다.** 터미널 3벌, 전송 2벌이 대표적이다.
3. **몇몇 파일과 문서에 책임이 쏠려 있다.** App, FilePanel, transfer_queue, progress.md가 그렇다.

## 프로세스와 검증

| ID | 심각도 | 상태 | 내용 | 조치 |
|---|---|---|---|---|
| P1 | 높음 | 확인 | **CI 3회 전부 실패.** 최신 실행(`42132676168`)에서 `format:check`가 184개 파일을 거부해, 뒤의 테스트·빌드·clippy·cargo test·audit이 CI에서 실행된 적이 없다. progress에는 이 실패 기록이 없다. | 아래 참고 |
| P2 | 높음 | 확인(원인은 추정) | **단위 테스트 수 불일치.** 기록은 42파일 656개, 실측은 16파일 226개. 기록이 215↔649처럼 오간 점으로 보아 worktree 사본(`g86-source`)이 함께 집계된 것으로 추정한다. `vite.config.ts`에 `test.include`가 없고 `run src`는 경로 부분 일치다. | `test.include: ['src/**/*.test.{ts,tsx}']` 추가, progress의 수치 정정 |
| P3 | 중간 | 확인 | `tests/`가 tsconfig에 없어 타입 검사를 받지 않는다. 임시 설정으로 돌리면 fixture·spec에서 실제 오류 6건이 나온다(`assistant.tsx`, `survivor.spec.ts`). | `tsconfig.tests.json` 추가 후 게이트 연결 |
| P4 | 중간 | 확인 | 줄바꿈 혼재: `progress.md`, `roadmap.md`, `README.md` 등이 mixed이고, `eol=lf` 대상인 `ftp-fixture.py`, `archive_helper.py`가 작업 트리에서 CRLF다. | P1 조치에 포함 |
| P5 | 중간 | 확인 | `progress.md` 225KB, `roadmap.md` 83KB, `README.md` 37KB. AGENTS.md대로 읽으면 매 세션 약 300KB를 소비한다. 낡은 문장도 남아 있다(97행 "Git 저장소가 아니므로"). | 상단 요약만 남기고 과거 기록은 `docs/history/`로 이동 |
| P6 | 낮음 | 확인 | roadmap §6의 모듈 구성(`commands/`, `ssh/`, `features/editor`)이 실제와 다르다. | 실제 구조로 갱신하거나 B3 결정에 맞춘다 |

**P1 원인과 조치**: `.gitattributes`의 `* text=auto`로는 Windows 러너에서 CRLF로 체크아웃되는데, Prettier는 기본값이 `endOfLine: lf`라 파일을 거부했다. 같은 커밋의 깨끗한 클론에서 수정 전 183개 실패, `* text=auto eol=lf` 적용 후 전부 통과로 확인했다. CI 실행 `42156057319`가 처음으로 성공했다.

**단위 테스트 현재 상태**: 11:25 기준 `npx vitest run src` 16파일 226개 통과. 11:17 실행에서는 `survivor/engine.test.ts` 1건이 실패했는데, 병행 중이던 G.8.Q2 수정의 중간 상태였고 완료 후 통과했다.

## 실제 버그

| ID | 심각도 | 상태 | 내용 | 위치 |
|---|---|---|---|---|
| F1 | 높음 | 확인 | 스니펫 검증 오류가 전부 "작업에 실패했습니다"로 표시된다. `throw new Error('…')`를 `errorText`가 일반 문구로 바꾼다. | `SnippetDialog.tsx` `review`, `snippets.ts:24`, `ipc.ts:52` |
| F2 | 중간 | 확인 | 분할 화면에서 PodTree를 열면 활성 탭인데 보이지 않을 수 있다. 다른 탭은 앞에 넣지만 PodTree만 뒤에 넣고, 앞쪽 탭만 표시한다. | `App.tsx:310,317,1123`, `:955` |
| F3 | 중간 | 확인 | 글꼴 크기·스크롤백 변경이 같은 창의 다른 패널에 반영되지 않는다. `storage` 이벤트는 같은 문서에 오지 않는다. | `TerminalPane.tsx:41-56` |
| F4 | 중간 | 보고 | `localStorage` 읽기에 try/catch가 없어 저장소 접근 실패 시 앱 초기화가 실패할 수 있다. `layout`은 검증 없이 클래스명이 된다. | `App.tsx:116-119,236` |
| F5 | 낮음 | 보고 | 폴러 3개에 중첩 방지가 없다. `MonitorBar`는 성공해도 이전 오류를 지우지 않는다. | `FilePanel:166`, `BroadcastControl:41`, `TransferQueue:60`, `MonitorBar:112` |

## 백엔드 구조

| ID | 심각도 | 상태 | 내용 | 조치 | 규모 |
|---|---|---|---|---|---|
| B1 | 높음 | 확인 | **터미널 세션 3중 구현과 동작 차이.** ACK: SSH는 `seq > current`, Local은 `seq == ack + 1`. ACK 대기: SSH·PodTree는 30초, Local은 종료 전까지 무기한. rows 상한 500/1000. 입력 상한 16KiB/32KiB(broadcast). 공유 가능량은 추정 70~80%. | 차이를 먼저 결정한 뒤 `terminal` 모듈로 통합. SSH의 `>`는 창 인계 재생과 관련될 수 있어 확인 필요 | M |
| B2 | 높음 | 확인 | **UI 스레드 차단.** 명령 81개 중 약 52개가 sync다. `save_session` → `snapshot` → `whoami.exe`·`icacls`를 메인 스레드에서 실행한다. `Broker::send`는 락을 쥔 채 sink를 호출하고, sink는 keyring 저장까지 한다. | I/O 명령 비동기화, sink를 락 밖에서 호출 | M |
| B3 | 중간 | 일부 확인 | **명령 배치 불일치.** `commands.rs` 12개, `workspace.rs` 17개, 터널은 `settings.rs`, 나머지는 각 모듈. `connect`는 125줄이다. 수기 목록 3곳은 현재 81개로 일치한다(확인). | 도메인별 정리, 필요하면 목록 생성 자동화 | M |
| B4 | 중간 | 일부 확인 | **전송 엔진 분기.** `Backend`가 Option 쌍으로 17곳에서 분기하고, `.dachsterm-` 이름 규약이 16곳에 흩어져 있다(보고). `sftp.rs`↔`ftp.rs` 재개 전송 16줄 복제(jscpd 확인). | `RemoteFs` trait, `staging.rs`. 복구 규약을 건드리므로 실제 재개 회귀 필수 | L |
| B5 | 중간 | 일부 확인 | **캡슐화 부재.** `Store(pub Mutex<Connection>)`를 외부에서 15곳 직접 사용(확인). `AppState` pub 필드 17개. `mutation` 락을 7개 모듈이 수동으로 잠근다. 모듈 18개가 순환 묶음(보고). | 필드 비공개, `store.mutate()`, `error.rs` 분리 | M |
| B6 | 중간 | 일부 확인 | "같은 접속 대상" 비교가 여러 벌이고 필드가 다르다(`commands.rs:39,116`, `settings.rs:257` 확인). 그 외 `session_management.rs:172`, `editor.rs:43` 등은 보고. | 비교 의도별 함수로 통합 | S |
| B7 | 중간 | 보고 | 오류 모델: `sftp::failure`가 로컬·exec·FTP 오류까지 "SFTP"로 표시한다. `editor.rs`는 문자열로 제어 흐름을 분기한다. `settings.rs:26`은 손상된 터널 설정을 빈 목록으로 삼킨다. | `AppError` 도입 | M~L |
| B8 | 중간 | 일부 확인 | `.lock().unwrap()` 160건 이상(확인). 한 번 오염되면 연쇄 panic이 된다. 종료 경로가 전송·모니터·터널을 다루지 않는다(보고). | 공용 잠금 헬퍼, 종료 순서 정리 | M |
| B9 | 낮음 | 확인 | 호출되지 않는 명령: `config_import`, `transfer_cancel`, `transfer_resume`. `transfer_drop`은 테스트 스크립트만 쓴다. 등록 3곳에서 함께 제거한다. | 제거 | S |
| B10 | 낮음 | 보고 | 소규모 복제: `posix-rename` 처리, glob, 인코딩 라벨, 원격 실행 3벌, 셸 quoter 2벌. examples 전용 API(`sftp::transfer`, `Connections::start`). | 병합·제거 | S |
| B11 | 낮음 | 일부 확인 | 보안 정리. `edit_start`가 프런트에서 받은 임의 프로그램을 실행한다(확인, 사용자 지정 편집기 기능이지만 허용 목록이 없음). `connect`는 조기 반환 경로에서 secret을 아직 보호하지 않는다(보고). capability 설명 "Main window only"와 달리 `terminal-*`도 대상이다(확인). | 저장된 편집기 설정과 대조, 진입 첫 줄에서 `Zeroizing` | S |

## 프런트엔드 구조

| ID | 심각도 | 상태 | 내용 | 조치 | 규모 |
|---|---|---|---|---|---|
| U1 | 높음 | 보고 | `App.tsx` 1381줄, useState 31개. 탭, 사이드바, 연결 흐름, 다이얼로그, 단축키가 섞여 있다. | `useWorkspaceTabs`, `SessionSidebar`, `useAppShortcuts`, 다이얼로그 순으로 분리 | L |
| U2 | 높음 | 보고 | `FilePanel`의 `ConnectedFiles` 한 함수가 약 1000줄, useState 27개. `operation` 문자열이 상태기계 역할을 한다. | 판별 유니온, 편집 트레이·압축 다이얼로그·메뉴 분리 | L |
| U3 | 높음 | 일부 확인 | IPC 계약 부재. 명령 문자열에 타입이 없고 응답 타입이 기능 폴더에 흩어져 있다. 터널 구조 3벌, 이름만 같은 `Status` 3개(보고). 현재 호출 이름 오타는 0건(확인). | `lib/commands.ts`의 `CommandMap`, 이후 tauri-specta 검토 | M |
| U4 | 중간 | 확인 | `TerminalSession`이 3갈래 명령 분기를 반복하고 FTP 탭도 xterm을 생성한다. | `session.kind`와 transport 객체 | M |
| U5 | 중간 | 일부 확인 | 공통 훅·저장소 없음. `localStorage` 직접 접근 31곳/8개 파일(확인), busy·try/finally·폴링 반복(보고). | `lib/storage.ts`, `usePolling`, `useAsyncAction`, `<Notice>` | M |
| U6 | 중간 | 보고 | CSS 소유권: `styles.css` 276개 선택자 중 76개, `workspace.css` 165개 중 37개가 파일 내 중복, 두 파일 간 겹침 53개. 미사용 규칙도 있다. | 미사용 제거 → 기능별 이동 → `@layer`. 시각 회귀 위험이 가장 크다 | L |
| U7 | 중간 | 보고 | 단위 테스트 편중: games 11개 파일 3525줄, 나머지 5개 파일 259줄. `session.ts`의 replay 차단·입력 분할에 단위 테스트가 없다. | 순수 함수 추출 후 테스트 | M |
| U8 | 낮음 | 보고 | 배치: Snippet·CommandGuide는 `features/assistant`, PodTree는 `features/podtree`, `sftp`는 `files`가 자연스럽다. | 이름 변경 작업과 묶어서 진행 | M |

## 테스트 인프라

| ID | 심각도 | 상태 | 내용 | 조치 | 규모 |
|---|---|---|---|---|---|
| T1 | 높음 | 확인 | 네이티브 검사가 게이트에 거의 연결되지 않았다. CDP로 앱을 띄우는 스크립트 18개 중 게이트 쪽에서 참조하는 것은 6개이고, CI는 `-Native` 없이 실행한다. 나머지 12개는 문서의 명령으로만 실행된다. | `verify-windows.ps1 -Native`에 연결 또는 npm 스크립트 등록 | S |
| T2 | 중간 | 확인 | 스크립트 전체 복제율 5.77%가 이 영역에 집중된다. 18개가 각자 `launch()`를 구현하고(최대 58줄 동일), `shutdown`, `invoke`도 반복된다. | `scripts/lib/native-app.mjs` | M |
| T3 | 낮음 | 확인 | `tests/ui/fixtures/tunnels.tsx`가 `TunnelPanel`의 타입 22줄을 복제한다. | 제품 타입 import | S |
| T4 | 낮음 | 확인 | Phase 기반 이름: `test-phase63-67-native.mjs`, `run-phase1.mjs`(Phase 2~4 포함). | 기능 이름으로 변경, 문서 참조 함께 수정 | S |

## 합치지 말아야 할 것

- `credentials`, `vault`, `ssh_auth`, `rsa_auth`: 층이 다르다. RSA 재시도만 병합 대상이다.
- 외부 형식 파서(PuTTY, MobaXterm, OpenSSH)와 Include 승인 흐름.
- FTP의 취소 대기와 새 세션 사용: 데이터 스트림 정리 때문에 필요하다.
- PodTree의 broadcast 제외, SSH의 다중 홉 인증.
- `crates/ssh-probe/src/socks.rs`와 `tunnels.rs`: 격리된 실증 목적이다.
- `DetachedWindow`와 App: 복제가 아니다. `Dialog`는 이미 잘 공유되고 있으며 범용 Form 추상화는 필요 없다.
- `games/`: 앱과의 경계가 깨끗하다. 내부 구조 차이는 우선순위가 낮다.

## 기각한 지적

- **`ftp.rs` `cwd(directory)`의 CRLF 미검증**: 앱 쪽 검사는 없지만 `suppaftp` 12.2.1에 줄바꿈 명령을 거부하는 `validate_command_line`과 관련 테스트가 있어 주입 취약점으로 분류하지 않았다. 다른 경로와 맞추는 일관성 정리 대상이다.
- **셸 주입**: `podtree`, `archive`, `monitoring`에서 지점을 찾지 못했다(보고).

## 권장 순서

| 단계 | 내용 | ID |
|---|---|---|
| 0 | 개명 변경 커밋 (완료) | N.1/N.2 |
| 1 | CI 통과와 테스트 수 정정 (P3만 남음) | ~~P1, P4, P2~~, P3 |
| 2 | 작은 버그와 미사용 코드 정리 (B9, B6 남음) | ~~F1~F3~~, B9, B6 |
| 3 | 문서 축소, 네이티브 게이트 연결과 공용 헬퍼 | P5, T1, T2 |
| 4 | UI 차단 제거 | B2 |
| 5 | IPC 타입과 공통 훅 | U3, U5, U4 |
| 6 | 터미널 통합 | B1 |
| 7 | App·FilePanel 분해 | U1, U2 |
| 8 | 전송 엔진과 CSS | B4, U6 |

한 단계씩 별도 작업으로 진행한다. 4단계 이후는 실제 OpenSSH·FTP 회귀 검사가 전제다.

## 측정 방법

```text
npx jscpd@4 src src-tauri/src src-tauri/examples scripts tests crates --min-lines 8 --min-tokens 70
gh run list --limit 6
gh run view <id> --log-failed
npx vitest list src --filesOnly
git ls-files --eol
```

읽지 않은 범위: `vendor/`, 게임 엔진 본문, CSS 전문(집계만), `session_log.rs`·`snippets.rs`·`routes.rs`의 후반부(대부분 테스트), examples와 `ssh-probe`의 상세.
