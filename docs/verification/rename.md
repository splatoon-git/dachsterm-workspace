# N.1 — DachsTerm 제품명·내부 식별자 변경

2026-11-06 사용자 요청. 표시명과 내부 이름을 모두 바꾸며 기존 개발 데이터 호환은 제공하지 않는다. 기존 데이터를 삭제하거나 읽어 옮기지 않고 새 저장 공간을 사용한다.

## 변경 계약

| 영역 | 새 이름 |
|---|---|
| 제품명·창 제목·설치 등록·PE 제품명 | `DachsTerm` |
| npm·Rust 패키지 / 기본 실행 파일 | `dachsterm` / `dachsterm.exe` |
| SSH 실증 패키지 | `dachsterm-ssh-probe` |
| Tauri 앱 ID·OS 보안 저장소 서비스명 | `app.dachsterm.desktop` |
| localStorage·게임 기록·레이아웃·터미널 설정 | `dachsterm.*` |
| JSON 교환 포맷 | `dachsterm.sessions` |
| 테스트 환경변수·모니터링 구분자·PodTree 내장 변수 | `DACHSTERM_*` |
| 셸 알림·경로/명령 안내 함수 | `DachsTerm` / `__dachsterm_*` |
| 전송·압축·편집 임시 파일 및 중복 파일 표시 | `.dachsterm-*` / `DachsTerm` |
| 내장 PodTree 변형 | `2.4.0-dachsterm.1` |

`package-lock.json`과 `Cargo.lock`도 함께 바꿨다. 마스터 키 AAD, 임시 파일 검사·정리 조건, 실제 테스트 fixture의 생성자/소비자도 동일 이름으로 변경했다. PodTree 수정 자산 SHA256은 `f3dd5e0bacb8ba150fa302d4b1c5af835fc37ad1ac4d9e6fcadb3a6208083a16`이며 원본 SHA는 유지했다. RSA 패치 설명 파일은 `vendor/ssh-key/DACHSTERM-PATCH.md`로 변경했다.

앱 데이터 위치는 새 앱 ID를 따른다. 기존 이름으로 저장된 설정/인증정보/암호문/명시적 format JSON을 자동 이전하지 않는다. 기존 format 없는 v1 읽기 경로는 원래 기능을 유지하며 이전 브랜드를 탐색하는 호환 분기는 없다.

N.1 이후 N.2에서 작업 폴더와 GitHub 저장소도 개명했다. 현재 경로는 `D:/Work/dachsterm-workspace`, origin은 `splatoon-git/dachsterm-workspace`다. 과거 검증 산출물의 파일명/경로·해시는 증거로 유지한다. 과거 기록의 설명과 명령 예시는 현재 제품명으로 정리했으며 당시 실행 파일을 새 제품으로 재검증한 의미는 아니다. 보존 산출물 검사 스크립트는 기존 manifest의 실제 파일명을 읽도록 바꿔 과거 검증 기능을 유지했다.

## 실행한 검증

- `npm run lint`, `npm run build`, `npm run format:check`: 종료0. build는 TypeScript 프로젝트 검사와 Vite 빌드를 포함한다. 기존 500KB 청크 경고는 유지한다.
- `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src --maxWorkers=1`: 42파일/656개 통과.
- `node node_modules/@playwright/test/cli.js test --workers=2`: 브라우저 전체86개 통과. 테마·저장·세션·전송·터미널·게임 UI를 포함한다.
- `cargo test --workspace --locked`: 최종 앱56개/SSH probe1개, 합계57개 통과. `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo fmt --all --check`: 종료0.
- `node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle`, `... build --bundles nsis`: 새 이름의 debug/release 및 NSIS 생성 성공.
- `node scripts/test-local-native.mjs`: 실제 Windows PowerShell/CMD/Ubuntu WSL PTY, 한글·resize·분할·개별 종료/재실행·출력 흐름·앱 종료 통과.
- `node scripts/test-themes-native.mjs`: 실제 WebView2의 12개 팔레트·기존 xterm 유지·종료 포커스·앱 재시작 복원 통과.
- `node target/verification/rename-native.mjs`: 이번 검증용 임시 harness. 새 실행 파일/환경변수로 실행·실제 제목, OS 인증정보 저장→마스터 암호화→복호화→잠금→앱 재시작→설정/인증정보 복원→테스트 인증정보 삭제 통과. 자격 증명은 실행 중 생성하며 출력/결과에 저장하지 않았다. `target/verification/rename/native.json`의 completed=true/pageErrors=0, `desktop.png` 시각 확인.
- `node scripts/test-maintenance-native.mjs`: 복구 UI·새 JSON format/version3·비밀정보 제외·새 ID·경로 거부·재시작 통과. 첫 실행에서 Phase6 이전 스키마만 기대하던 검사 실패를 발견해 현재 v3의 format/templates와 새 브랜드 계약을 검사하도록 수정했다.
- `node scripts/run-ftp.mjs --reuse-build --native-only`: 실제 FTP/FTPS 앱 연결·한글 파일 관리·복사/삭제·바이너리 업로드·좁은 창 통과.
- D:의 전용 `TEMP`/`TMP`를 지정한 `node scripts/run-ftp.mjs --reuse-build`: FTP/FTPS/CP949 전체 통과. 폴더·빈 폴더·한글·24개 작은 파일·충돌·64MiB 일시정지/영속 복구·잘못된 프로필 거부·동시/취소·링크·탐색 상한·원본 변경 거부, 32MiB 왕복/REST 재개·바이너리 일치를 실제 확인했다.
- `scripts/test-installer.ps1 -Version 0.5.1 -Reinstall`: 실제 설치·새 이름의 레지스트리/실행 파일/PE 제품명/버전·동일 버전 재설치·실행·정상 종료·제거 통과. 이전 브랜드 업그레이드/데이터 이전 검사는 요청에서 제외했다.
- `node scripts/generate-notices.mjs`: 424개 컴포넌트, 라이선스 본문 누락0. `node scripts/verify-survivor-artifacts.mjs`: 과거 보존 산출물4개/증거5개 해시 일치 유지.
- WSL 실제 Bash에서 PodTree/설정 fixture/RBAC/생성한 셸 연동의 `bash -n` 및 새 `__dachsterm_guide_prompt` 설치·리다이렉션 출력 비오염 확인. 변경 Python/JSON 구문·PowerShell 파서·Markdown 로컬 링크·diff 공백 검사 통과.

## 실패·환경 제한

- FTP 확대 검사의 첫 실행은 `ConnectionReset`, 두 번째는 `StorageFull`로 실패했다. 당시 C: 여유 공간은 약0.11GiB였다. 첫 실패 원인을 확정하지 않는다. 제품 전송 코드를 추가 변경하지 않고 D:의 `target/verification/rename-tmp`를 테스트 임시 경로로 지정한 전체 재실행에서 통과했다.
- Docker context 조회는 가능했으나 엔진 응답이 반복 지연되어 실제 SSH/SFTP/터널/OpenSSH·PodTree Kubernetes 통합 검사를 이번 개명 후 재실행하지 못했다. Mock 성공으로 대체하지 않았다. 확인 목적으로 시작한 Docker 서비스는 원래의 중지 상태로 복원했다.
- Mac 실기기/빌드·Keychain·설치, 물리 IME·실제 네트워크/절전·장시간 검증은 이번에 실행하지 않았다. 이전 Phase의 남은 환경 검증도 유지한다. 새 패키지는 Authenticode `NotSigned`이며 공개 배포는 하지 않았다.

## 산출물

| 파일 | SHA256 |
|---|---|
| `target/debug/dachsterm.exe` | `2d169e1a97695d76c6bfdb169703306a5700f1949269647005f10c8629b11397` |
| `target/release/dachsterm.exe` | `add08565ed5df293138ee7ccc89d0e9ac8544f5068b0d1a83438c49037b2a9c9` |
| `target/release/bundle/nsis/DachsTerm_0.5.1_x64-setup.exe` | `5986d4252ed679ab6596957ac94451d6adab00b95c2aad714d8700d3402f48ec` |
| 설치된 payload 사본 `target/installed-smoke.exe` | `85e7c66ce6a989bc8b77bd1ce3c5b2d94b38f86f6f8e572eb42f27a883d8c5a4` |

NSIS 설치 payload는 Tauri bundle-type 표시가 바뀌므로 release 실행 파일과 해시가 다르다. 위 파일은 모두 무시되는 빌드 산출물이며 Git에 추가하지 않는다.

남은 ID: **N.1 실제 SSH/OpenSSH/PodTree·Mac 재검증**, 기존 Phase별 수동·환경 대기. 다음 첫 행동: Docker 엔진 응답/디스크 여유를 확보한 뒤 새 `dachsterm.exe`를 지정해 `node scripts/run-phase1.mjs --native --skip-app-build`를 실행하고 실제 SSH 결과를 추가한다. N.2의 게임 표기 정리와 후속 검증 결과는 [진행 기록](../progress.md)을 따른다.
