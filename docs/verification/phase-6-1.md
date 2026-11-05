# 6.1 폴더 전송·영속 큐 검증

2026-11-05. 구현 범위는 roadmap 6.1이다. 다른 Phase의 병행 변경·검증과 구분한다.

## 사용과 보존 정책

- 원격 파일 패널에서 파일 업로드/폴더 업로드로 여러 항목을 선택한다. 파일과 폴더를 함께 드롭하면 목적지와 적용 정책을 확인하고 큐에 추가한다. 원격 파일/폴더 다중 선택 → 선택 다운로드 → 로컬 폴더 선택도 지원한다. 기존 서버 내부 복사/붙여넣기와 별도다.
- 새 묶음의 충돌 정책은 기본 **건너뛰기**다. 이름 변경은 UUID 접미사를 붙인다. **덮어쓰기 (선택 전체)**는 다음 선택/드롭 묶음의 동명 파일 전체에 적용된다. 같은 이름의 디렉터리는 병합하며 기존 다른 파일을 삭제하지 않는다. 종류가 다른 대상은 정책에 따라 건너뛰거나 이름 변경하고, 덮어쓰기로 파일/폴더 종류를 강제 교체하지 않는다.
- 큐는 대기/탐색/전송/일시정지/실패/완료/취소 상태, 대기 항목 맨 앞으로 이동, 개별 및 선택 묶음 중지/취소/재개, 전체·현재 파일 진행률과 100개씩 파일별 결과를 제공한다. 한 항목 실패는 그 루트 묶음을 중지하며 다른 묶음은 계속한다.
- 중지·취소는 부분 파일과 생성한 빈 폴더를 보존한다. **부분 파일 삭제**는 해당 작업의 UUID 부분/준비 파일과 기록만 정리한다. 기존 파일, 완료 파일, 생성한 빈 폴더는 지우지 않는다. 완료 기록도 사용자가 정리한다.
- 재시작 후 미완료 작업은 자동 실행하지 않는다. 같은 프로필 및 동일 목적지에 다시 인증한 후 **확인 후 이어서 보내기/받기**를 누른다. 비밀번호·키·Passphrase는 큐에 저장하지 않는다. 완료 파일은 재전송하지 않는다.

## 구현과 제한

`src-tauri/src/transfer_queue.rs`는 기존 `sftp::source/resumed`, `ftp::transfer_source/transfer`의 원본 크기/수정 시각 및 부분 파일 전체 prefix 비교를 사용한다. 새로운 큐 명령은 `workspace.rs`, 명령 등록/권한은 `lib.rs`, `build.rs`, `capabilities/main.json`에 있다. `FilePanel.tsx`/`TransferQueue.tsx`와 공통 테마 CSS로 표시한다.

| 제한 | 값 |
|---|---:|
| 큐 루트/다중 선택 | 100개 |
| 동시 탐색/전송 묶음 | 2개, 묶음 안에서는 순차 처리 |
| 묶음 탐색 항목 / 전체 보관 항목 | 10,000 / 20,000개 |
| 하위 깊이 | 64 |
| 묶음 탐색 경로 예산 | 4MiB |
| 직렬화 기록 / 전체 기록 | 16MiB / 64MiB |
| 전송 버퍼 | 64KiB, prefix 비교 버퍼 2개 |
| 결과 IPC 페이지 | 100개 |

탐색은 본 전송 전에 완료하고 저장한다. 탐색 중 중단되면 다음 재개에서 탐색을 다시 한다. 전체 목록의 메타데이터가 상한을 넘으면 쓰기 전에 실패한다. SQLite settings의 `queue:<UUID>` version1 기록으로 저장하며 기존 `transfer:<UUID>` 단일 파일 계획을 이행한다. 손상/미지원 기록은 삭제하지 않고 복구 오류를 반환한다. 디스크 저장 실패 시 새 전송/재개는 실행하지 않으며 완료 체크포인트 실패도 오류로 보인다.

로컬 symlink/Windows reparse point(junction 포함), 원격 링크/특수 파일, `..`, 경로 구분자가 들어간 항목명, Windows 예약명·ADS·대소문자 목적지 충돌, 겹치는 미완료 목적지를 차단한다. 각 항목 실행 및 최종 교체 때 경로와 대상 정보를 다시 검사한다. 링크를 보존해 전송하는 기능은 없다.

새 큐의 파일은 UUID `.part` → `.ready` → 최종 이름 순서로 처리한다. SFTP 명시적 덮어쓰기는 `posix-rename@openssh.com`을 요구하며 미지원 시 기존 파일을 보존하고 실패한다. 로컬은 덮어쓰기 rename 또는 no-replace hard link를 사용한다. FTP는 기존 파일을 UUID `.backup`으로 이동한 뒤 교체하며, 실패 시 복원하거나 큐/백업을 보존한다. 최종 교체 intent를 먼저 저장하고, 중단 복구 시 원본 상태와 최종 파일 **전체 바이트**를 비교해 완료 여부를 판단한다. FTP 교체는 원자적 트랜잭션이 아니므로 짧은 이름 공백이 있을 수 있다.

FTP RFC에는 원자적 no-replace rename이 없다. 다른 클라이언트가 확인 직후 같은 대상을 바꾸는 경쟁을 완전히 막지는 못한다. 원본 크기/수정 시각을 유지한 미전송 영역의 변경까지 탐지하는 원본 전체 스냅샷은 아니다. 공격적인 외부 프로세스가 검사 직후 경로를 교체하는 모든 OS 수준 경쟁까지 보장하지 않는다. 시간/달력 예약은 범위 밖이다.

## 실행한 검증

- `cargo test -p daxterm --lib --locked`: 54개 통과. 이 중 큐5개는 경로/예약명/링크 조상 거부, 상태/순서/저장 실패, 재시작 비자동 실행/완료 보존, 미지원 기록 보존을 검사한다. 다른 테스트 수는 공유 트리 시점의 결과다.
- `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src --maxWorkers=1`: 41파일652개 통과.
- TypeScript, 변경 TS/JS ESLint/Prettier, Rust lib clippy `-D warnings`, Windows Tauri debug 빌드 통과. Vite의 기존 큰 메인 번들 경고는 남는다.
- `node scripts/run-ftp.mjs`: 실제 FTP/FTPS/CP949 모두 종료0. 중첩/빈 폴더/한글·공백/같은 이름·24작은파일 내용 왕복, 건너뛰기/이름 변경/명시적 업·다운 덮어쓰기, 64MiB 중지/영속 복구/재개, 다른 프로필 거부, 동시2/순서/묶음취소/재시도, 링크거부/정리, 탐색 중지/10,001개 입력 상한/원본 변경 거부. 기존32MiB 업·다운 재개 및 파일작업 회귀도 통과.
- 실제 OpenSSH의 동일 큐 시나리오와 권한 거부, 최대128MiB로 사전 제한한 컨테이너 전용 `/dev/shm`의 실제 ENOSPC 검사를 통과했다. 부분 파일 정리 후 제한 tmpfs 폴더도 제거했다. `node scripts/run-phase1.mjs` 최종 실행도 큐 정리·기존128MiB 재개·인증/호스트키/터널/편집/모니터링·접속 종료를 포함해 종료0이다.
- `playwright test --config tests/queue.config.ts --workers=1`: 360/800px 2개 통과. 키보드·상태·묶음별 정확한 ID·새 연결 ID로 재개·순서·파일 결과·가로 넘침 없음. `target/verification/transfer-queue-{360,800}.png` 확인.
- Windows WebView2 + 실제 FTPS: `DAXTERM_TEST_BINARY=<보존 debug> node scripts/run-ftp.mjs --reuse-build --queue-native-only` 종료0. 256MiB 전송 중 앱 프로세스 트리 강제 종료, SQLite 큐 복구/비자동 실행, 새 인증/새 연결 ID, 제품 UI 버튼으로 재개, 완료 파일 수정 시각 유지, 전체 SHA-256 일치, 빈/중첩 폴더 포함6항목 완료, pageerror0. 임시 암호는 저장하지 않고 재시작 때 다시 입력했다. 파일 선택/드롭은 IPC 경로로 주입했으며 물리 OS 조작 검증으로 세지 않는다.

프로토콜 공통 검사는 `src-tauri/examples/queue/checks.rs`, 실제 앱 검사는 `scripts/test-transfer-queue-native.mjs`에 있다. 임시 서버/앱은 검사 종료 후 정리한다. 빌드 해시와 네이티브 결과는 `target/verification/transfer-queue-native/result.json`, 보존 실행 파일은 `target/verification/transfer-queue-artifacts/daxterm-debug.exe`다. 공유 `target/debug`는 다른 작업이 바꿀 수 있다.

## 발견하여 수정한 문제

- Windows FTP 서버가 동명 파일 위 RNTO를 거부함: 기존 파일 백업→교체→복원/정리 경로를 추가했다.
- 부분 RETR 검사 후 ABOR 226/225 응답 경합과 FTPS 원본 파일 핸들 잔류: 종료/중단 응답을 기다리고 그 제어 세션을 버린 뒤 새 세션에서 REST한다. 기존 FTP/FTPS 파일 rename 회귀까지 다시 통과했다.
- 실제 Tauri UI 재개가 동기 IPC에서 `tokio::spawn`을 호출하여 reactor 부재 panic: `transfer_control`을 비동기 명령으로 변경했다. 엔진 검사만으로 드러나지 않았으며 실제 앱 강제 종료/재실행/버튼 재개를 다시 통과했다.
- 좁은 UI fixture의 기존 숨김 CSS를 별도 fixture 표시로 보정했다. 제품 폴더 업로드 버튼 배치와 큐 표시 높이도 확장했다.

## 남은 검증

OS 폴더 다중 선택창·탐색기에서 물리 드롭, 실제 네트워크 단절/재연결과 절전, Mac의 폴더 선택/권한/링크/키보드/UI 및 네이티브 빌드는 대기다. 실제 디스크 부족은 SFTP 원격 제한 tmpfs에서 검증했으며 Windows 로컬 볼륨/FTP 서버 자체 저장소를 꽉 채우는 검사는 수행하지 않았다. 모든 OS/서버 조합의 오류를 통과했다고 주장하지 않는다. release/설치본은 이 작업에서 생성하지 않았다.

다음 첫 행동: 보존 실행 파일의 결과 JSON 해시를 대조하고 Windows OS 폴더 선택/물리 드롭을 확인한 뒤, 별도 테스트 환경에서 네트워크 단절/절전 및 Mac 항목을 기록한다.

최종 보존 debug SHA256: `7b8ee9f9d52ad698aa6cdc9528365b13d2685cf42076406800e8c35181d665ab`. 최종 소스로 다시 빌드한 보존 EXE의 네이티브256MiB 검사는 종료0이며 result.json의 해시와 일치한다.
