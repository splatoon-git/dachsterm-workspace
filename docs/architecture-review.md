# 구조 검토와 정리 목록

남은 구조 부채와 정리 순서다. 다른 문서가 ID로 참조하므로(예: engineering-rules의 "review T2") 항목을 지워도 남은 ID는 바꾸지 않는다. 끝난 항목은 표에서 지운다.

- 표시: **확인** = 코드·명령 출력으로 확인 / **보고** = 코드 리뷰 결과이며 재확인하지 않음
- 줄 수는 테스트를 포함한 파일 전체 기준이다. 구조 정리는 ID 단위의 별도 작업으로 진행한다.

## 프로세스와 문서

| ID | 심각도 | 상태 | 내용 | 조치 |
|---|---|---|---|---|

## 실제 버그

| ID | 심각도 | 상태 | 내용 | 위치 |
|---|---|---|---|---|
| F4 | 중간 | 확인 | `App.tsx` 초기 상태가 `localStorage.getItem`을 try/catch 없이 읽어, 저장소 접근이 실패하면 앱 초기화가 실패할 수 있다 | `App.tsx`의 `sidebarOpen`, `leftWidth` 초기값 |
| F5 | 낮음 | 확인 | `setInterval` 폴러 두 곳에 중첩 방지가 없어 이전 요청이 끝나기 전에 다음 요청을 보낸다. `lib/poller.ts`의 `Poller`나 `MonitorBar`의 `pending` 방식으로 바꾼다 | `FilePanel.tsx`의 전송·편집·클립보드 폴링, `TransferQueue.tsx`의 `Results` |

## 백엔드 구조

| ID | 심각도 | 상태 | 내용 | 조치 | 규모 |
|---|---|---|---|---|---|
| B1 | 높음 | 확인 | **터미널 세션 3중 구현과 동작 차이.** SSH와 파드 터미널은 `terminal_output::pump`를 공유하지만 ACK 규칙이 다르다(SSH `terminal_ack`는 `seq > current`, 로컬·파드는 `seq == ack + 1`). 로컬은 별도 스레드에서 종료 전까지 무기한 ACK를 기다린다. rows 상한은 SSH·분리 창 500, 로컬·파드 1000이다 | 차이를 먼저 결정한 뒤 `terminal` 모듈로 통합. SSH의 `>`는 창 인계 재생과 관련될 수 있어 확인 필요 | M |
| B2 | 높음 | 확인 | **UI 스레드 차단.** 명령 182개 중 약 54개가 sync다. `save_session`은 sync 명령에서 `mutation` 락을 쥔 채 `maintenance::snapshot`(Windows에서 `whoami.exe`·`icacls`)을 실행한다. `Broker::send`는 락을 쥔 채 sink를 호출한다 | I/O 명령 비동기화, sink를 락 밖에서 호출 | M |
| B3 | 중간 | 확인 | **명령 배치 불일치.** 명령이 49개 파일에 흩어져 있고 `commands.rs` 14개, `workspace.rs` 17개, 터널 명령은 `settings.rs`에 있다. 명령 이름 목록은 네 곳에 수기로 맞춘다(engineering-rules §5) | 도메인별 정리, 필요하면 목록 생성 자동화 | M |
| B4 | 중간 | 확인 | **전송 엔진 분기.** `transfer_queue.rs`의 `Backend`가 `sftp`·`ftp` Option 쌍으로 분기한다. `.dachsterm-` 임시 이름 규약이 10개 파일에 흩어져 있다 | `RemoteFs` trait, `staging.rs`. 재시작 복구 규약을 건드리므로 실제 재개 회귀 필수 | L |
| B5 | 중간 | 확인 | **캡슐화 부재.** `Store(pub Mutex<Connection>)`를 `maintenance.rs`, `session_management.rs`, `settings.rs`, `transfer_queue.rs`가 직접 잠가 SQL을 쓴다. `mutation` 락을 16개 파일이 수동으로 잠근다 | 필드 비공개, `store.mutate()`, 오류 모듈 분리 | M |
| B6 | 중간 | 보고 | "같은 접속 대상" 비교가 목적별로 여러 벌이다(`commands.rs`의 `same_credential_target`·`same_proxy`, `Proxy::same_target`, Git 자격 증명의 `same_target`). 다른 모듈의 인라인 비교는 재확인하지 않았다 | 비교 의도별 함수로 통합 | S |
| B7 | 중간 | 확인 | **오류 모델.** `sftp::failure`가 "SFTP 작업 실패"를 붙이는데 로컬 파일(`local_links.rs`, `desktop_files.rs`), 압축(`archive.rs`), 편집기, FTP를 거치는 전송에서도 쓴다. `settings.rs`는 손상된 터널 설정을 `unwrap_or_default()`로 빈 목록으로 삼킨다 | 프로토콜별 오류 문구, 손상 데이터는 오류로 올림. 필요하면 `AppError` 도입 | M~L |
| B8 | 중간 | 확인 | `.lock().unwrap()`이 365건이다. 한 번 오염되면 연쇄 panic이 된다. 종료 경로가 전송·모니터·터널을 다루지 않는다(보고) | 공용 잠금 헬퍼, 종료 순서 정리 | M |
| B10 | 낮음 | 확인 | 소규모 복제: `posix-rename` 처리가 `editor.rs`와 `transfer_queue.rs`에 있다. `sftp::transfer`는 examples(`workspace_checks.rs`)만 쓴다. glob·인코딩 라벨 복제는 재확인하지 않았다 | 병합 또는 테스트 영역으로 이동 | S |

## 프런트엔드 구조

| ID | 심각도 | 상태 | 내용 | 조치 | 규모 |
|---|---|---|---|---|---|
| U1 | 높음 | 확인 | `src/app/App.tsx` 793줄, `useState` 20개. 상한(400줄)을 넘는다 | 탭·사이드바·연결 흐름·다이얼로그를 훅과 컴포넌트로 계속 분리 | L |
| U2 | 높음 | 확인 | `features/sftp/FilePanel.tsx` 880줄 중 `ConnectedFiles` 한 함수가 대부분이고 `useState` 27개다. `operation` 문자열 상태가 상태기계 역할을 한다 | 판별 유니온, 편집 트레이·압축 다이얼로그·메뉴 분리 | L |
| U3 | 높음 | 확인 | IPC 계약 부재. `call('명령')`의 이름과 응답에 타입 검사가 없다 | `lib/commands.ts`의 `CommandMap`, 이후 tauri-specta 검토 | M |
| U4 | 중간 | 확인 | 터미널 종류 분기는 transport 객체로 옮겼지만 FTP 탭도 `TerminalSession`이 xterm을 만든다 | 셸이 없는 FTP 탭에서 xterm 생성 제거 | M |
| U5 | 중간 | 확인 | 공통 저장소 헬퍼가 없다. `localStorage` 직접 접근이 32개 파일에 있다. busy·try/finally 반복(보고) | `lib/storage.ts`, `useAsyncAction`, `<Notice>` | M |
| U6 | 중간 | 보고 | CSS 소유권: `src/app/styles.css`(1247줄)와 `workspace.css`(418줄)에 파일 내·파일 간 선택자 중복과 미사용 규칙이 있다 | 미사용 제거 → 기능별 이동 → `@layer`. 시각 회귀 위험이 가장 크다 | L |
| U8 | 낮음 | 확인 | `features/sftp`가 FTP와 로컬 파일도 다룬다 | `features/files`로 이름 변경 | M |

## 테스트 인프라

| ID | 심각도 | 상태 | 내용 | 조치 | 규모 |
|---|---|---|---|---|---|
| T2 | 중간 | 확인 | 공용 헬퍼 `scripts/lib/native-app.mjs`(`launchNativeApp`)가 있지만 `test-ftp`, `test-jump`, `test-local`, `test-maintenance`, `test-session-log`, `test-session-transfer`, `test-transfer-queue`, `test-workspace`의 `-native.mjs` 8개는 여전히 앱 실행과 CDP 연결을 각자 구현한다 | 남은 스크립트를 공용 헬퍼로 옮긴다 | M |
| T3 | 낮음 | 확인 | `tests/ui/fixtures/tunnels.tsx`가 `TunnelConfig`, `TunnelStatus`를 import하지 않고 `Config`, `Status`로 다시 선언한다. `Status`는 이미 제품 타입과 필드가 다르다 | 제품 타입 import | S |
| T4 | 낮음 | 확인 | Phase 기반 이름 `run-phase1.mjs`(Phase 2~4 포함, `probe:phase1`, `test:native`)가 남아 있다 | 기능 이름으로 변경, 문서 참조 함께 수정 | S |
| T5 | 중간 | 대부분 처리 | `test:native` 불안정. 스크립트의 경합과 짧은 대기를 고쳤고 제품 결함은 확인되지 않았다. 분할 단계 실패 1건은 원인 미확인이고 부하 상태 재검증은 하지 않았다. [기록](verification/native-test-flakiness.md) | 다시 실패하면 남긴 진단으로 분할 단계 원인 확인 | S |

## 합치지 말아야 할 것

- `credentials`, `vault`, `ssh_auth`, `rsa_auth`: 층이 다르다. RSA 재시도만 병합 대상이다.
- 외부 형식 파서(PuTTY, MobaXterm, OpenSSH)와 Include 승인 흐름.
- FTP의 취소 대기와 새 세션 사용: 데이터 스트림 정리 때문에 필요하다.
- SSH의 다중 홉 인증.
- `archive.rs`의 원격 실행: 표준 입력과 시간 초과 정책이 `remote_exec.rs`와 다르다.
- `crates/ssh-probe/src/socks.rs`와 `tunnels.rs`: 격리된 실증 목적이다.
- `DetachedWindow`와 App: 복제가 아니다. `Dialog`는 이미 잘 공유되고 있으며 범용 Form 추상화는 필요 없다.
- `games/`: 앱과의 경계가 깨끗하다. 내부 구조 차이는 우선순위가 낮다.

## 기각한 지적

- **`ftp.rs` `cwd(directory)`의 CRLF 미검증**: 앱 쪽 검사는 없지만 `suppaftp`에 줄바꿈 명령을 거부하는 `validate_command_line`이 있어 주입 취약점으로 분류하지 않았다. 다른 경로와 맞추는 일관성 정리 대상이다.
- **셸 주입**: `archive`, `monitoring`에서 지점을 찾지 못했다(보고).

## 권장 순서

| 단계 | 내용 | ID |
|---|---|---|
| 1 | 작은 버그와 테스트 정리 | F4, F5, B6, T3, T4 |
| 2 | 네이티브 공용 헬퍼 | T2, T5 |
| 3 | UI 차단 제거 | B2 |
| 4 | IPC 타입과 공통 훅 | U3, U5, U4 |
| 5 | 터미널 통합 | B1 |
| 6 | App·FilePanel 분해 | U1, U2 |
| 7 | 전송 엔진과 CSS | B4, U6 |

3단계 이후는 실제 OpenSSH·FTP 회귀 검사가 전제다. B3, B5, B7, B8, B10, U8은 관련 단계에서 함께 처리한다.

## 측정 방법

```text
npx jscpd@4 src src-tauri/src src-tauri/examples scripts tests crates --min-lines 8 --min-tokens 70
gh run list --limit 6
npx vitest list src --filesOnly
git ls-files --eol
```
