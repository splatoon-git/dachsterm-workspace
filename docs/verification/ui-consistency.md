# UI.1 — 배치·글자·컨트롤 점검

- 날짜: 2026-11-18. Windows. 최초 `ba1513a`에서 분리해 작업했고, 최종 `dev` 병합·Windows ZIP은 아래 기록을 따른다.
- 범위: [역할별 기준](../design/ui-consistency.md). 사용자 첨부의 로컬 클러스터 설정 폼, 제목/본문 위계, 일반 컨트롤 크기, 작업 화면의 시작선.
- 공유 `dev`에는 WebView 높이 호환성과 가져오기 작업이 진행 중이어서 별도 worktree `D:/Work/dachsterm-ui1`에서 진행했다. 그 변경은 수정하지 않았다.
- 구현 커밋: `5afbeb9`. `dev`의 `ebb85c0`에서 `git merge --no-ff --no-edit codex/ui1-consistency-audit`를 시도했으나 미커밋 `docs/progress.md`, `src/app/styles.css`, `src/features/terminal/commandPanel.css`를 덮어쓸 수 있어 Git이 중단했다. 병합 상태나 사용자 파일 변경 없이 작업 브랜치를 보존했다.

## 확인한 결함과 수정

| 항목 | 수정 전 근거 | 수정 |
|---|---|---|
| 일반 버튼이 입력보다 큼 | Classic 1280px 실측: 에이전트 삭제·추가, Git 파일 선택, 하이라이트 규칙 추가, 연결 폼 새 키가 14px/37px. 같은 화면 입력·footer는 12px/32px | 공통 기본 글자·버튼·입력·select를 정해 12px/32px로 일치 |
| 복사 버튼의 또 다른 크기 | 터미널 설정의 훅/tmux 복사 버튼 12px/34px | 12px/32px로 일치 |
| 본문과 제목의 역할이 불명확 | 기본 본문 14px가 상속되고, 다수 구획 제목은 12px. 쿠버네티스 전체 본문도 14px | 일반 본문 12px, 구획 제목 14px, 작업/설정 제목 16px. 밀집 목록의 그룹명은 12px semibold |
| 이유 없는 중앙 폼 | `.kube-setup`의 `justify-content:center`, 내용 폭 520px. 사용자 첨부와 동일한 코드 경로 | 왼쪽 20px 시작선, 내용 최대 680px, 폼 버튼도 왼쪽 정렬 |
| 같은 작업 화면의 제목 규모 차이 | 쿠버네티스 설정 14px, 실시간 로그 시작 28px 및 `margin:auto` | 두 제목 16px, 모두 왼쪽 위 배치 |
| 과도하게 작은 실제 UI 문구 | 메뉴 힌트·상태·연결 배지·파일 설명·명령 도움말에 9·10px | 일반 보조 문구 11px. 축소 그림·파일 아이콘·게임은 명시적 예외 |
| 컨트롤 기준의 로드 순서 의존 | 공통 `--control-height`가 작업 공간 CSS에만 있음 | 모든 화면이 읽는 기본 CSS에 정의 |
| 공통 행간 변경에 따른 상태바 회귀 | 전체 회귀가 인코딩 버튼 22px / 옆 배지 18.5px 차이를 검출 | 파일 정보 버튼은 주변 배지의 행간을 상속. 상태바 11건 재실행 통과 |

## 점검 범위와 증거

- 정적 목록: `src` 아래 CSS **66개**의 크기·행간·굵기·높이 선언을 수집했다. 토큰 검사는 정의 누락·직접 숫자·색상과 작은 UI 글자를 별도로 검사한다. 이것을 모든 상태에 대한 수동 시각 검토라고 부르지 않는다.
- 렌더링 측정: 설정 9분류 + 연결 폼 기본/고급/키 = 12상태 × 4너비 × 3테마 = **144조합**, 수정 전후 각각 실행. 문서 자체의 가로 넘침 0. 내부 넘침 후보에는 테마의 숨겨진 legend와 모달 footer의 의도적 음수 여백이 포함돼 자동 결함 수로 세지 않았다.
- 실제 Windows 앱의 수정 전 화면: 사용자가 실행한 ZIP 앱에서 시작 화면, 테마 설정, 터미널 설정, Git 설정, 새 연결 창을 직접 보았다. 앱 설정 값을 바꾸거나 연결을 생성하지 않았다. 이 실행 파일에 이번 수정이 포함됐다고 주장하지 않는다.
- 픽스처 이미지 직접 확인: 800px 에이전트 설정 수정 전후, 360px 터미널 설정, 1280px 가져오기, 채팅, 1280/360px 쿠버네티스 설정. 이미지·실측 JSON은 worktree의 `test-results/ui-audit/`, `test-results/ui-audit-after/`, `test-results/ui-review/`에 있다.
- 사용자가 첨부한 로컬 설정과 회귀 시험의 서버 설정은 `KubeSetup`/동일 CSS를 공유한다. 회귀 시험은 화면 배치 검사이며 실제 로컬 kubeconfig 탐지나 SSH 검사가 아니다.

## 실행 기록

| 명령 | 결과 |
|---|---|
| `node .tools/ui-audit.mjs` (초기 진단용, 1426) | 수정 전 144조합·66 CSS 수집 |
| `npm run audit:ui -- http://127.0.0.1:1426 test-results/ui-audit-after` | 수정 후 144조합 수집, 문서 가로 넘침 0 |
| `npx playwright test --config .tools/ui-playwright.config.mjs ui-consistency.spec.ts` | 첫 공통 수정: 36/36 통과. 최종 소스는 아래 전체 검사에 포함 |
| `npm run typecheck` | 통과 |
| `npx vitest run src/themes` | 최종 작은 글자 규칙 포함 3파일 56/56 통과 |
| `npm run lint` 및 최종 변경 JS/TS의 `npx eslint` | 통과 |
| 전체 Prettier 검사 및 최종 수정 CSS 재검사, `git diff --check` | 통과 |
| `npm run build` | 최종 변경 뒤 종료 0. 일반 Vite 청크 크기 경고 있음 |
| `npx playwright test --config .tools/ui-playwright.config.mjs --reporter=line` | 584건 중 583 통과, 상태바 1건 실패(위 표). 6.2분. 최초 실행은 도구 실행 세션 재시작으로 중단돼 결과에 포함하지 않음 |
| `npx playwright test --config .tools/ui-playwright.config.mjs status-bar.spec.ts --output test-results/ui-status-review` | 위 실패를 수정한 뒤 11/11 통과. 584건 전체를 이 수정 뒤 다시 돌렸다고 기록하지 않음 |
| `npx playwright test --config .tools/ui-playwright.config.mjs ui-consistency.spec.ts --grep 'cluster setup' --output test-results/ui-review` | 12/12 통과 및 스크린샷 직접 확인 |

최종 진단 재실행은 `test-results/ui-audit-final.log`/`.exit`, 최종 빌드는 `test-results/ui-build-final.log`/`.exit`에 기록했다. UI 회귀 로그는 `test-results/ui-suite.log`, 상태바 재검사는 `test-results/ui-status-review.log`다.

포트 1420의 다른 개발 작업을 건드리지 않으려고 검사 서버는 1426, 임시 설정은 `.tools/ui-playwright.config.mjs`를 썼다. 이 설정은 기존 UI 테스트 디렉터리 전체와 Chromium을 가리키고 Windows에서 WebKit 시험을 제외하며 동시 worker는 2개다. 기본 `npm run test:ui`에도 새 회귀 시험이 자동 포함된다.

검사 서버 종료 로그에서 의존성 junction의 실제 경로가 Vite 허용 목록 밖이라 Monaco 아이콘 글꼴을 거부한 것을 확인했다. 제품 설정은 바꾸지 않고 `.tools/vite-ui.config.mjs`에서 이 worktree와 실제 `node_modules` 경로만 허용해 다시 실행했다. 해당 `codicon.ttf` HTTP 200, `file-tab.spec.ts -g 'code is highlighted and read-only'` 1/1 통과. 전체 584건 실행 당시에는 이 아이콘 글꼴이 로드되지 않았으므로 그 실행을 에디터 아이콘의 시각 검증으로 해석하지 않는다.

## 남은 확인

- 생성한 Windows ZIP의 실제 앱 화면, OS 배율 100/125/150%, 실제 파일·SSH 내용이 들어간 화면.
- macOS 빌드·WKWebView와 실제 시스템 폰트/배율. Windows Chromium 결과로 대체하지 않는다.
- 모든 프로토콜·오류·대용량 데이터·게임 상태를 사람이 전수 검토한 것은 아니다. 화면 144조합과 UI 자동 회귀를 구분한다.

## 팝업·설정 후속 점검 (2026-11-18)

사용자 요청으로 터미널 작업 화면은 제외하고 팝업·설정의 소스 진입점을 조사했다. `Dialog` 사용처, 별도의 `role="dialog"`/`alertdialog`를 검색하고 공통 프레임과 개별 CSS를 읽었다. 기존 본문·터미널 변경을 새로 확장하지 않았다.

| 분류 | 렌더링 점검 범위 |
|---|---|
| 통합 설정 | 9분류, Git·에이전트·가져오기·복구·업데이트 오류, 세션 일괄 변경 미리보기, 복구 확인 |
| 연결·보안 | 그룹 편집, SSH·FTPS·FTP·Telnet·시리얼 폼, SSH 고급/키 인증, 키 생성/결과, 보관함 생성/잠김/해제/암호 보기 |
| 파일·에이전트 | 다른 이름으로 저장, 저장 안 됨 1개/여러 개, 삭제/이름 바꾸기/편집기 선택, 채팅 열기, 에이전트 시작/명령 미입력 |
| 운영·설정 팝업 | 터널 목록/새 터널, 포트 열기, 쿠버네티스 작업 확인/운영 모드, 분리 창 터미널 설정, 세션 로그 설정 |
| Git·외부 링크 | 브랜치 생성/선택, 태그, stash, 강제 push, 변경 버리기, 외부 URL 확인 |

`dialog-audit` 픽스처는 실제 컴포넌트를 렌더링하며 IPC만 가짜 데이터로 응답한다. 키·암호·서버는 생성하거나 접속하지 않는다. 상태당 1280/800/560/360px와 Classic/GitHub Dark/Terminal Green을 검사한다. 360px는 실제 앱 최소 폭 560px보다 좁은 스트레스 조건이고 높이도 600px로 줄인다. CSS 단순 넘침 후보는 입력 값의 내부 스크롤·숨겨진 레이블·sticky footer를 포함하므로 따로 기록하고, 실제 모달/본문/설정 패널의 가로 넘침을 실패로 판정한다.

수정 전 Classic 360px에서 가로 넘침 12상태를 재현했다(`test-results/dialog-before.json`). 긴 이름이 제목 또는 본문을 넘어가던 암호 보기·저장 확인·파일 삭제·Git·채팅/에이전트·포트 팝업과 설정 오류를 공통 `overflow-wrap`으로 고쳤다. 터널 목록 제목이 버튼 사이에 눌리던 문제는 제목 14px와 행 전환으로 수정했다. 설정 적용 버튼의 시작선을 맞추고, 폼 밖 레이블 간격을 4px로 정했으며, SSH 공개키/로그 마스킹 textarea의 브라우저 기본 흰 배경·테두리·여백을 테마에 맞췄다. 긴 Git 호스트 옆의 삭제 버튼이 두 줄로 찌그러지지 않게 했다.

초기 검증: 확장한 Classic 360px 54상태 통과(`dialog-expanded2.json`), 테마 56/56, typecheck, 수정 테스트 eslint와 prettier 통과. 전체 조합·회귀와 Windows 빌드는 최신 `dev`를 합친 뒤 실행한다.

스크린샷 검토에서 설정 분류를 바꿔도 이전 패널의 스크롤 위치가 남아 제목이 가려지는 문제도 찾았다. `SettingsDialog.tsx`에서 분류 변경 시 스크롤을 0으로 되돌리고, 700px 이하 가로 탭의 ARIA 방향과 방향키를 실제 배치에 맞췄다. 공통 레이블 스타일은 클래스 없는 필드에 한정해 Git 대상 같은 기존 가로 행을 보존했다. Classic 1280/360px 2조합 재검사 통과(`dialog-scroll.json`). 진행 중이던 전체 검사는 중단했으며 최종 소스의 전체 실행을 별도로 기록한다.

소스로 확인했으나 이 픽스처에서 따로 캡처하지 않는 진입점은 App 안의 인증/세션 삭제/로컬 셸 선택/단축키, 원격 파일 작업의 추가 옵션, 포트 다중 점검·런타임 읽기 확인, 채팅 모델/권한 팝오버다. 기존 기능 테스트와 공통 프레임 검증을 함께 사용하며 모든 실제 데이터 상태의 사람 시각 검토로 주장하지 않는다. 터미널 안 trust/서명/자격 증명/붙여넣기/전송 카드는 사용자 범위에서 제외했다.

### 통합 검증

최신 `dev`의 W.1과 감사 예외를 `dc2ab26`에서 합친 뒤, `ac98b4d`를 대상으로 실행했다. 공통 레이블/스크롤 수정 중 중단한 실행은 최종 수치에서 제외한다.

| 명령·범위 | 결과 |
|---|---|
| `npx playwright test --config .tools/ui-playwright.config.mjs --reporter=json --output test-results/ui-final2` | **598/598 통과**, 건너뜀·재시도 0. 407.9초. `ui-final2.json` |
| 위 실행의 `dialog-layout.spec.ts` | 54상태 × 4너비 × 3테마 = **648조합**. 제목/본문 위계, 입력 12px, footer 최소 32px, 가로 넘침·뷰포트 경계, 분류 이동 시 제목 노출·방향키 통과. 상단/스크롤 끝 PNG 저장 |
| `npm test -- --maxWorkers=1 --testTimeout=30000` | **124파일 1,433/1,433 통과**. 메모리 사용을 제한하려고 worker 1, 기존 게임 시험은 제한 30초. `ui-vitest.log` |
| `npm run typecheck`, `npm run lint`, `npm run format:check`, `git diff --check` | 통과 |

마지막 스크린샷 검토에서 보관함 상태 배지의 원래 아래 여백이 공통 `p[role=status]`에 덮여 **입력 레이블까지 간격 0px**인 것을 확인했다. `vault.css`의 기존 상태 선택자를 명확히 해 원래 16px 여백을 복구했다. 이 CSS 수정 뒤 `dialog-layout.spec.ts --grep 'vault status'`를 실행해 **12/12 통과**(`vault-final2.json`): 4너비 × 3테마의 실제 간격과 오류 배너를 확인했다. 최종 추가 테스트 eslint·prettier도 통과했다. 전체 598건은 이 마지막 여백 수정 전이며, 최종 소스 전체 610건을 다시 실행한 것으로 기록하지 않는다.

직접 본 스크린샷에는 Classic 360/560/800/1280, GitHub Dark 360/560/800의 보관함·Git/에이전트·업데이트·세션 미리보기, SSH 키 결과, 저장 확인, 터널 편집창이 포함된다. Windows release 빌드와 ZIP은 아래에 결과를 추가한다. 이번 실행에는 Windows 실제 앱 클릭 검사·OS 배율·Mac 검증이 포함되지 않는다.

### Windows release ZIP

- `dev` 병합: `5f5e6cbdeaad7b4d733b9b04910e2384dff791e6`. 병합한 로컬 작업 브랜치는 삭제했고 원격에는 만들지 않았다. 감사 예외·W.1 변경을 포함한다.
- `CARGO_BUILD_JOBS=1 npm run tauri -- build --no-bundle`: 종료 0. 프런트엔드 빌드 포함, Rust release 최적화 7분 5초. Vite 큰 청크 경고만 있음. 로그 `test-results/ui-release.log`.
- ZIP: `target/release/bundle/DachsTerm_0.5.1_x64_5f5e6cb.zip` (23196542 bytes). 구성은 `DachsTerm.exe`, `THIRD_PARTY_NOTICES.txt`, `build-info.json` 3개.
- ZIP SHA-256: `03d73394e29c3634677cfad5eab320d58b68ec1574be689019ffc868d7355538`.
- EXE SHA-256: `e6c8a8cc7207bc3cd254c9833abf95e93bfb31a47a915e1ab73add685aa18b8a` (48575488 bytes).
- `zipfile.testzip()` CRC 검사, ZIP 안 EXE와 빌드 원본의 SHA-256 일치, 라이선스 원본 일치, 빌드 정보의 커밋 일치, EXE PE AMD64 확인 통과. 결과 `test-results/ui-package-verified.json`.
- ZIP을 새 실제 앱으로 실행한 화면/OS 배율, 구형 WebView2 PC, Mac 실기기는 미검증이다. `main` 반영·푸시·CI는 요청 범위에 포함하지 않았다.
