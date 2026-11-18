# UI.1 — 배치·글자·컨트롤 점검

- 날짜: 2026-11-18. Windows, `ba1513a`에서 분리한 `codex/ui1-consistency-audit`의 미커밋 소스.
- 범위: [역할별 기준](../design/ui-consistency.md). 사용자 첨부의 로컬 클러스터 설정 폼, 제목/본문 위계, 일반 컨트롤 크기, 작업 화면의 시작선.
- 공유 `dev`에는 WebView 높이 호환성과 가져오기 작업이 진행 중이어서 별도 worktree `D:/Work/dachsterm-ui1`에서 진행했다. 그 변경은 수정하지 않았다.

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

## 남은 확인

- `dev` 통합. 공유 작업 트리의 다른 작업이 수정 중인 `styles.css`, `commandPanel.css`, `progress.md`와 겹치므로 그 변경을 보존해야 한다.
- 이번 소스의 Windows 패키지 앱, OS 배율 100/125/150%, 실제 파일·SSH 내용이 들어간 화면.
- macOS 빌드·WKWebView와 실제 시스템 폰트/배율. Windows Chromium 결과로 대체하지 않는다.
- 모든 프로토콜·오류·대용량 데이터·게임 상태를 사람이 전수 검토한 것은 아니다. 화면 144조합과 UI 자동 회귀를 구분한다.
