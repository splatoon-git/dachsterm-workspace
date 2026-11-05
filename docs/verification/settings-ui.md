# U.3 — 설정 이해도·버튼 일관성

- 요청일: 2026-11-05. 첨부된 DaxTerm/MobaXterm 화면을 상호작용 참고로 사용했다. 기존 크림색 기본 테마·공통 토큰·독립 UI를 유지한다.
- 범위: 공통 액션 크기/강조 단계와 터널 설정·목록. 다른 Phase의 완료 상태나 보안·포워딩 엔진 계약을 변경하지 않는다.

## 점검 결과와 수정

- `.primary`에만 별도 세로 padding이 있어 일반 액션과 높이가 달랐다. 강조는 색상으로 구분하고 폼 액션·닫기·터널 목록 액션을 공통 32px 기준으로 정렬했다. 대화상자 입력/select도 같은 기본 높이를 사용한다. 긴 문구는 필요한 경우 줄바꿈할 수 있다.
- 기존 터널 화면은 목록과 신규/수정 폼이 동시에 표시되고 저장 후에도 편집 폼이 남았다. 목록 중심 진입, 명시적인 새 터널/수정, 성공 후 목록 복귀, 취소 시 저장값 보존으로 바꿨다.
- 유형은 목적 중심 라디오 카드로 선택한다. 내 PC/SSH 서버/목적지 노드 안에 입력을 배치하고 연결 방향, 목적지 `127.0.0.1` 해석 위치, 루프백 제한, 자동 포트, SOCKS5 사용법을 설명한다. Remote는 SSH 서버 자신에서 접속하며 임의 외부 공개를 뜻하지 않는다.
- 저장과 실행을 구분한다. 목록에서 시작/중지, 다음 연결 시 자동 시작, 수정/삭제를 제공한다. 현재 탭뿐 아니라 열린 SSH 연결을 사용하며 동일 프로필 연결이 여러 개면 실행할 연결을 선택한다. 다른 창/연결의 실행 인스턴스도 상태 목록에서 확인하고 실행 중 수정/삭제를 막는다.
- 설정 하나가 여러 연결에서 실행되면 개수를 표시하고 중지 버튼이 해당 설정의 모든 실행 인스턴스를 중지함을 설명한다. 중지 요청 직후 성공 상태를 가정하지 않고 엔진 상태를 다시 읽는다.
- SSH 프로필만 편집 대상에 표시한다. 연결이 없으면 시작을 비활성화하고 연결할 세션명을 안내한다. 저장/시작/상태 조회 실패는 별도 표시하고 실패한 입력을 보존한다. 연속 클릭을 잠그고, 저장/삭제 직전 실행 상태를 다시 확인한다.
- 간단한 설정은 기존 컴팩트 UI를 유지한다. 복잡한 설정의 후속 개선에도 ‘목적 선택 → 관련 입력과 설명 → 저장 결과 목록’ 원칙을 roadmap §14에 기록했다.

## 파일

- 제품: `src/features/tunnels/{TunnelPanel.tsx,tunnels.css}`, `src/app/{App.tsx,styles.css,workspace.css}`.
- UI 검사: `tests/ui/tunnels.spec.ts`, `tests/ui/fixtures/tunnels.{html,tsx}`, `tests/ui/layout.spec.ts`.
- 실제 검사: `scripts/verify-tunnels.mjs`, 기존 `scripts/test-native.mjs`의 U.3 단계.
- 테스트용 HTML/IPC fixture는 Vite 테스트 경로에만 있으며 프로덕션 진입점/배포 번들에 포함되지 않는다. 이 검사 자체를 실제 SSH 검증으로 집계하지 않는다.

## 실행 결과

- `npm run test:ui -- --workers=2`: 전체 32개 통과.
- 공통 세션 폼 액션 높이/테마 primary 색상 안정화 확인과 낡은 터널 CSS 제거 후 `npm run test:ui -- tests/ui/tunnels.spec.ts tests/ui/layout.spec.ts --workers=2`: 12개 통과. 360/560/800/1280px, 크림/다크/터미널 테마, 라디오 방향키, 포커스 이동, 저장/취소/실패/자동 포트/시작·중지/연결 해제/다른 연결 실행·상태 실패 보호를 확인했다.
- `npm test`: 실행 당시 32개 통과. 병행 게임 모듈의 이후 추가 검사는 해당 작업 기록을 따른다.
- `npm run typecheck`, 변경 파일 Prettier 검사, `cargo fmt --all -- --check`: 통과.
- 최초 `npm run lint`: 통과. 후속 전체 lint에서 병행 작업의 `scripts/test-session-transfer-native.mjs` 미사용 변수 오류가 한 번 발생했다. 해당 작업 수정 후 최종 `npm run lint` 종료0, U.3 변경 파일 대상 ESLint도 종료0.
- 최초 네이티브 빌드는 병행 게임 수정의 `./DaxGames` 파일 생성 전 누락으로 실패했다. 파일 생성 후 및 최종 CSS 정리 후 `npm run tauri -- build --debug --no-bundle` 모두 종료0. 실행 경로는 `src-tauri/target/windows-hardening/debug/daxterm.exe`. 기존 500KB 번들 경고는 유지된다.
- 시각 검토: `test-results/tunnel-local-1280.png`와 `tunnel-list-360.png`를 직접 확인했다. 설명/노드/버튼/단일 열 목록과 테마 적용을 확인했다. 나머지 폭/Remote 캡처는 같은 디렉터리에 생성된다.

## Windows 실제 검사

- `$env:CARGO_TARGET_DIR='D:/Work/daxterm-workspace/src-tauri/target/windows-hardening'; node scripts/run-phase1.mjs --native --reuse-build`로 새 앱을 격리 데이터/일회용 실제 OpenSSH fixture에 연결했다. `--reuse-build`이므로 독립 엔진 probe를 재실행한 것으로 기록하지 않는다.
- U.3 단계 통과: 실제 UI로 Local/Remote/SOCKS5 생성 → 저장 후 목록 → 자동 시작 값 저장/해제 → 시작 → 자동 배정 포트 → TCP 왕복(동적은 도메인 CONNECT) → 창 닫기/재열기 상태 유지 → 중지 → 삭제. 실행 중 수정 비활성화도 확인했다. Remote 왕복은 SSH 서버 안에서 리스너에 접속하고 Windows 로컬 echo 서버가 응답한다.
- 중간 검사 실패 2회: (1) 비동기 저장 checkbox에 Playwright `check()`의 즉시 판정을 적용, 저장 완료를 기다리는 click+expect로 수정. (2) 테스트 Node 프로세스가 동기 docker 실행으로 자체 echo 서버 이벤트 루프를 막음, 비동기 execFile로 수정. 제품 엔진을 변경하거나 Mock 응답으로 우회하지 않았고, 수정 후 실제 세 종류 왕복이 모두 통과했다.
- `test-results-native/tunnel-editor-{local,remote,dynamic}.png`, `tunnel-saved-list.png` 생성. 실제 Local 편집 화면을 직접 열어 시각 확인했다.
- 위 native 명령의 최종 종료0과 fixture 정리 확인. 기존 S.1 인증·RSA/agent/MFA·터미널 기본기, 다중 입력/로컬·SSH, SFTP/편집/모니터링, CP949, 분할/TUI, 분리 창, KeepAlive/재시작/보관함/호스트키 거부까지 전체 회귀 통과. 실패한 앞선 실행을 성공에 포함하지 않는다.
- Rust 소스/IPC/스키마는 이번 U.3에서 변경하지 않았다. 같은 target와 CARGO_BUILD_JOBS=1에서 `cargo clippy --workspace --all-targets --locked -- -D warnings` 종료0(8분07초). Rust fmt·정적 검사·Windows 앱 빌드 완료.

## 남은 확인

- U.3 Mac 실기기, 최신 설치 패키지: 이번 환경/범위에서 아직 수행하지 않음. 기존 W.3/W.4/5.1~5.3 미검증 상태 유지.
