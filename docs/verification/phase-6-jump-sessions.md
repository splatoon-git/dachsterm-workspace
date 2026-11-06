# Phase 6.4 / 6.5 점프 호스트·세션 관리 검증

2026-11-05. 구현·Windows 자동 검증 완료. Mac과 실제 외부 제품별 내보내기 파일 검증은 별도 대기다. 병행 6.1~6.3/6.6~6.7 변경은 이 기록의 완료 범위가 아니다.

## 구현 계약

- SSH 프로필의 `jumpIds`는 순서 있는 참조다. 참조 프로필의 경로를 먼저 펼친다. 최종 서버를 제외하고 최대 4홉, 자기 참조·순환·중복 홉·없는 참조·FTP 경유를 거부한다. 경유지를 삭제하기 전에 참조 세션/템플릿을 수정해야 한다. 열린 연결은 시작 시 설정으로 유지한다.
- 한 터미널이 홉별 SSH 핸들을 독립 소유한다. 공유 풀/agent forwarding/임의 ProxyCommand는 없다. `direct-tcpip` 스트림 위에서 다음 SSH를 협상한다. 각 홉의 host:port로 known_hosts를 확인하며 변경된 키를 거부한다. UI 신뢰 결정은 홉별 일회용 challenge로 구분한다.
- 홉별 비밀번호/개인키/agent/MFA와 취소·타임아웃을 적용한다. 저장 암호가 없으면 기존 추가 인증 UI로 이번 접속용 암호/Passphrase를 받는다. 경유지에 개인키를 복사하지 않는다. 최종 핸들만 PTY/SFTP/외부 편집/모니터링/터널에 노출한다. 정지·단절은 종속 작업에 알리고 모든 소유 핸들을 disconnect한다. 재접속은 새 셸이다.
- SQLite 스키마 4: 그룹 `parent_id`/`sort_order`, JSON 프로필 기본값을 통해 평면 그룹/기존 프로필을 유지한다. 그룹 깊이 최대 16. 삭제는 직속 세션과 직속 하위 그룹을 최상위로 이동하며 범위를 UI에 표시한다. 템플릿 참조 그룹은 먼저 참조를 해제한다.
- 프로필 태그 최대 32개, UTF-8 64바이트/태그. 검색은 공백 AND 및 `tag:`/`host:`/`user:`/`group:`/`protocol:`. 그룹 선택은 하위 그룹을 포함한다. 정렬 순서는 숫자 후 이름이다.
- 일괄 수정은 체크한 필드만 미리보기→복구본→단일 DB 트랜잭션으로 적용한다. 미리보기 후 대상 변경을 거부한다. 저장 암호가 있는 세션의 인증 대상/경유 변경은 개별 편집에서 암호 해제 후 진행한다. 템플릿은 공통 필드만 저장하며 인증 비밀·목적지·사용자명을 복제하지 않는다.
- JSON v3은 계층/태그/경유/템플릿을 포함한다. v1/v2 읽기는 유지한다. 알 수 없는 필드/버전, 중복 ID, 고아 참조, 순환을 거부한다. 추가 시 모든 참조를 새 ID로 매핑한다. 선택한 세션의 경유지·상위 그룹·템플릿 의존성도 포함한다.
- 명시적 병합은 동일 프로토콜·호스트·포트·계정·인증·키·CA의 기존 프로필만 허용하고 저장 암호 참조를 유지한다. 저장 암호가 있는 경유 경로 변경은 병합에서 차단한다. 다른 대상은 새 ID로 추가한다. 가져온 터널은 자동 시작을 해제한다. 복구본 복원은 기존 제품 계약대로 추가 복원이며 파괴적 원상 교체가 아니다.

## 외부 형식 지원과 제한

| 형식 | 지원 | 제외/차단 |
|---|---|---|
| OpenSSH config | 명시 Host·패턴 첫 값, HostName/User/Port, 치환 없는 IdentityFile, 범위 내 timeout/keepalive, ProxyJump 별칭·user@host:port, IPv4 루프백 Local/Remote/DynamicForward | Match, ProxyCommand, HostKeyAlias, KnownHostsCommand, CertificateFile, hostname 정규화 조건은 차단/세션 제외. 자동 명령·신뢰·추가 IdentityFile 등은 이전하지 않음 |
| OpenSSH Include | 선택 설정 파일의 폴더를 루트로 경로 목록→사용자 선택 승인→확장 미리보기 | 절대/부모 경로·링크·루트 이탈·미승인 파일·순환 거부. 최대 탐색 1000개/8깊이, 읽기 64회/총 2MiB. 상대 경로 기준이 원래 시스템/사용자 루트와 다르면 파일 배치부터 확인 |
| PuTTY reg | 기본 접속·OpenSSH 키 경로, 루프백 L/R/D PortForwardings | PPK 자동 변환, 프록시, 명령, 암호, 비루프백·지원하지 않는 escape/수신 주소. 기본 PuTTY 세션 저장 자체에는 폴더 필드가 없어 임의 경로 구분을 추정하지 않음 |
| MobaXterm Bookmarks | SubRep 계층, 기본 접속, 명시 키 경로, SSH gateway host/port/user/key 목록 | 프록시·인증서·SSHv1 조건 제외. PPK/드라이브 치환 키는 경고 후 재지정. 별도 터널 섹션·명령/매크로·신뢰 제외 |

형식 근거: [OpenSSH 공식 ssh_config](https://man.openbsd.org/ssh_config), [PuTTY 설정 설명](https://the.earth.li/~sgtatham/putty/0.85/htmldoc/Chapter4.html), [PuTTY 저장 파서 소스](https://raw.githubusercontent.com/github/putty/master/settings.c). MobaXterm의 비공개 북마크 필드는 [작성자의 26.3 형식 관찰 자료](https://gist.github.com/Ruzgfpegk/ab597838e4abbe8de30d7224afd062ea)를 참고했다. 이를 제품별 전체 호환/로컬 실측으로 표시하지 않는다. reg/mxtsessions/config는 작성 제품 버전을 보장하지 않아 미리보기 보고서에도 버전 확인 불가를 알린다.

## 실행 결과

- `cargo test -p dachsterm --lib -- --test-threads=1`: 최종 전체 54개 통과. 경로/계층, 스키마 이행, 트랜잭션 롤백, 템플릿/병합/비밀 참조 유지, Include 승인/순환/이탈, 오래된 호스트키 응답의 다음 홉 승인 차단 포함. `cargo clippy -p dachsterm --all-targets -- -D warnings` 통과.
- `node scripts/run-phase1.mjs --jumps`: 실제 Docker OpenSSH에서 1홉/2홉, 각각 최초 호스트키, 암호+RSA SHA-2+MFA와 OS agent, PTY 한글/SFTP/외부 편집 왕복, Local/Remote/SOCKS5 왕복·모니터링 통과. 중간 바이트 브리지를 실제 종료해 종속 터널 정리·다른 직접 연결 격리·새 셸 재접속을 확인했다. 첫/중간/최종 변경 호스트키·잘못된 암호·MFA 취소·포워딩 handshake timeout과 연결/포워딩 맵 정리도 통과했다. 모든 fixture 인증정보/키/파일은 임시 환경에서 제거했다.
- `vitest run src/features/sessions --maxWorkers=1`: 3개 통과. 계층 검색·의존 선택·순환 미리보기.
- Playwright `session-transfer.spec.ts`, `session-manager.spec.ts`: 각 4개 통과. 500세션 복합 검색/선택·명시적 필드 미리보기, 360/560/1280px overflow·키보드, 기존 가져오기 실패/재시도/취소. UI fixture 검증은 실제 SSH 검증과 구분한다.
- `tsc --noEmit`, 소유 프런트 소스 ESLint, Windows debug Tauri 빌드 통과. 기존 번들 크기 경고는 유지한다.
- 실제 WebView2에서 두 번째 홉의 신뢰 승인 실패를 발견했다. `trust_host`의 단일 응답 상태를 홉별로 초기화하고 challenge를 추가했으며, 이전 IPC 응답이 새 프롬프트를 지우지 않게 수정했다. 수정 후 최종 `node scripts/run-phase1.mjs --native --jumps --reuse-build` 종료0: 경유 암호 입력·두 host:port 승인·실제 PTY, v3 참조 재매핑·그룹·일괄 수정 미리보기/적용·템플릿·비밀 제외 복구 내보내기·재시작 복원 통과. pageErrors0. OS 파일 대화상자의 직접 조작은 이 검사에 포함하지 않는다.
- 직전 빌드의 `node scripts/run-phase1.mjs --native --session-transfer --reuse-build` 종료0: 기존 v2 가져오기/롤백·직접 연결 신뢰 거절/잘못된 암호·일회용 암호·저장 동의/OS 보관함 재사용·보관함 잠금 저장 실패·복구 정리 통과.
- 최종 검증 EXE는 `target/verification/phase64-65/daxterm-debug.exe`, SHA256 `74E4B3566DF94481B8B87117C194A704BAB741552DFF6A51A1979327806C3304`. 실행 시 `DACHSTERM_TEST_BINARY`로 지정했다. 결과/화면은 `target/verification/session-management-native.{json,png}`, 내보내기 결과는 `session-v3-export.json`. 이후 소스 변경은 Rust 서식 정리다. 기존 release/설치본을 이 결과로 대체하지 않는다.

## 별도 대기

- 실제 PuTTY/MobaXterm 제품에서 생성한 익명화 파일과 제품 버전별 대조, OS 파일 대화상자 직접 선택/저장. 합성 어댑터 검사를 실제 제품 내보내기 검사로 바꾸어 기록하지 않는다.
- Mac Keychain/agent/WKWebView/실제 경유, 실제 OTP 공급자/하드웨어 agent, 장시간·절전/네트워크 전환. Windows 결과로 대체하지 않는다.
- 최신 설치 패키지/release 배포는 이번 요청에 포함하지 않는다. debug 빌드와 기존 release를 구분한다.
