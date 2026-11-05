# Phase 2~5 및 추가 기능 Windows 검증 (2026-11-04)

## 환경

Windows11, Node24, Rust1.99.1, Tauri2/WebView2. SSH는 격리된 Debian OpenSSH Docker, FTP는 pyftpdlib2.2.0/pyOpenSSL26.4.0 loopback fixture를 사용했다. 실제 네트워크·제품 엔진 검사이며 Mock이 아니다. 인증정보와 키는 실행 시 임시 생성하고 출력하지 않으며 서버/테스트 데이터는 종료 시 정리한다. 네이티브 앱 테스트는 실행 파일 잠금 및 WebView2 시작 경합을 피하기 위해 순차 실행한다.

## 통과한 범위

- `npm run test:native`: 제품 엔진 및 WebView2. 인증/호스트키/타임아웃/5개 연결/PTY UTF8/CP949/resize/출력 역압력, 네트워크 침묵·재접속·종료 후 원격 셸 해제.
- 파일: 한글·공백·바이너리 왕복, mkdir/newfile/chmod/rename/delete, 다중 복사/폴더 복사/이동/재귀 삭제, 기존 대상·하위 경로 거부, 부분 실패 분리.
- 압축: ZIP/TAR/TAR.GZ 실제 왕복, 기존 대상 거부, ../·절대 경로·symlink ZIP 거부. WebView2 권한 폼·압축/해제 실행.
- 편집: CP949→UTF8 작업본→CP949 재인코딩, 표현 불가 문자 거부, SHA256 원격 충돌/수정본 보존/원자적 교체/권한 보존. 확인·수동·자동 모드와 32MiB 업로드 중 취소 시 원격 원본/로컬 수정본 유지. 실제 외부 Node 실행 파일을 UI에서 지정해 파일 저장 → 확인/취소/보존 → 재시도 → 자동 업로드 검증.
- SFTP: 128MiB 업로드·다운로드 일시 중지/재개, 부분 파일 바이트 변조 거부, 정확한 최종 바이트, staging 정리.
- `npm run probe:ftp`: UTF8 FTP/명시적 FTPS/CP949 FTP 각각32MiB REST 업·다운 재개, SQLite 계획 재로딩 후 재개, 최종 바이트 일치, 목록/복사/rename/delete. FTPS 미신뢰 CA 거부·추가 CA 승인.
- `node scripts/run-ftp.mjs --reuse-build --native-only`: 실제 FTP/FTPS 세션 폼/연결/파일 화면, 한글 빈 파일/폴더, 컨텍스트 복사/붙여넣기, Ctrl+A/Delete 다중 삭제, 바이너리 업로드, 800px 파일 화면.
- Local/Remote/SOCKS5: 실제 echo·도메인·포트 충돌·리스너 취소·종료 정리. Linux CPU/RAM/NET/DISK/Load 독립 exec, 첫 샘플과 차분, native 상태바/차트.
- 분할2×2 독립 입력/단일 복원, 독립 창 연결 인계/출력/입력/종료, 연결 중 테마 전환 및 다른 창 동기화. 멀티 입력은 선택된2개에만 전달, 대상 종료 시 전체 해제, 재접속 자동 포함 없음.
- 마스터 보관함: Windows OS 저장소에 암호문, 트랜잭션 이행 실패 rollback, 잠금/잘못된 암호 거부/재인증 보기·숨김/마스터 변경/이전 암호 거부/재시작 잠김/저장 인증정보 재접속. 평문이 SQLite에 없음을 검사.
- `npm test`29개, `cargo test --workspace --locked` 앱14개+실증1개, `npm run test:ui`15개. `typecheck`, `lint`, `format:check`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings` 통과(최종 보완 후 결과는 progress의 마지막 기록 참조).
- Windows NSIS0.5.0 생성 및 `scripts/test-installer.ps1` 설치/레지스트리·EXE 버전/실제 네이티브 창 초기화/정상 종료/제거 통과. 설치 위치는 workspace 안의 UUID 경로, 기존 설치가 있으면 검사를 거부한다. 사용자 앱 데이터는 삭제하지 않는다.

## 발견 및 수정

1. 동기 IPC에서 tokio 작업을 만들던 모니터/전송 진입점을 async로 변경해 프로세스 종료 수정.
2. 분리 창 WebView2 데이터 폴더/브라우저 옵션을 기본 창과 통일해 창 생성/구독 인계 수정.
3. 파일명 손실 변환 시 작업 차단, 목록 크기/항목 상한, 편집·전송 복구의 프로필/대상/프로토콜/FTP 인코딩 검증.
4. FTPS를 Rustls+OS CA로 전환하고 취소 시 TLS 데이터 종료 응답을 기다려 Windows 서버의 파일 핸들이 열린 채 재개되는 문제 수정.
5. 파일 선택으로 도구 영역이 생길 때 목록 위치가 바뀌어 더블클릭이 빗나가던 문제를 고정 높이로 수정. FTP 화면 전체 너비, FTP에서 지원하지 않는 편집 진입 차단.
6. Windows 네이티브 탭의 DOM layout/hit testing 시점을 검사에서 기다림. 테스트 폼 locator·버튼 이름 보정.
7. 설치된 EXE와 원본은 Tauri bundle type 표시 `UNK`→`NSS` 3바이트만 다름을 확인. 설치/제거는 레지스트리와 EXE 버전 및 실제 실행으로 검증.

## 남은 수동/외부 환경 검증

- 물리 Microsoft IME 조합/받침/삭제, 네이티브 파일 선택 대화상자와 OS 드롭 제스처. synthetic composition/제품 IPC 검증으로 대신 완료 표시하지 않는다.
- VS Code/Cursor/Sublime 등 실제 GUI 편집기의 수동 조작(외부 프로세스 실행·저장 감지는 검증됨).
- 장시간 메모리/자원 추이, OS 절전·복귀 및 실제 네트워크 변경. Docker pause 단절 검증과 구분한다.
- 모든 macOS 실행/Keychain/설치: 실기기 부재. 공개 배포 서명/공증 자격 증명도 제공되지 않았다.

스크린샷은 `test-results-native/`의 `workspace-monitoring.png`, `files-editor.png`, `detached-window.png`, `ftp-files.png`, `ftps-files.png`를 확인한다. 암호 보기 상태의 스크린샷은 저장하지 않는다.

최종 산출물 SHA256: `17906363634D714AFB19380C7D3ED3D0E8883B010B31CAE1ACB7D6BD1DDC3A26` (`DaxTerm_0.5.0_x64-setup.exe`). 마스터 인증 처리 중 blur→뒤늦은 암호 표시 차단 검사도 최종 native 실행에서 통과했다.
