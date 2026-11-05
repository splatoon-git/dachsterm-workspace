# G.8.4 영구 성장·저장 검증

- 날짜: 2026-11-05. 범위: G.8.4만. 게임 탭/전투 화면 연결은 G.8.5, 실제 플레이/밸런스/성능/최종 산출물은 G.8.6이다.
- 정본: [설계 §7/§10](../design/dax-survivor.md), [진행 현황](../progress.md), [로드맵](../roadmap.md).
- 파일: `src/features/games/survivor/{profile.ts,profileStore.ts,session.ts,SurvivorHub.tsx,hub.css,profile.test.ts}`, `tests/ui/survivor-profile.spec.ts`, `tests/ui/fixtures/survivor-profile.{html,tsx}`, `tests/native/survivor-profile.ts`, `scripts/test-survivor-profile-native.mjs`.
- 기존 G.8.1~G.8.3 전투 엔진·다른 게임·카탈로그·App·Rust/IPC·패키지 의존성은 변경하지 않았다. 기존 `useBest`를 영구 잔액에 사용하지 않는다.

## 실제 실행 결과

모든 Node 명령은 메모리 한도1024MiB로 실행했다. PowerShell에서 `$env:NODE_OPTIONS='--max-old-space-size=1024'`를 설정하거나 `node --max-old-space-size=1024`를 사용한다.

| 명령 | 결과 | 범위 |
|---|---|---|
| `node node_modules/vitest/vitest.mjs run src --maxWorkers=1` | 12파일/209개 통과 | 신규 프로필59개 + 기존150개. 서바이버 전체153개 포함 |
| `node node_modules/typescript/bin/tsc --noEmit` | 종료0 | 초기 신규 소스 타입 확인. 최종 변경은 아래 build의 `tsc -b`도 통과 |
| `node node_modules/eslint/bin/eslint.js .` | 종료0 | 전체 소스/테스트/스크립트 |
| `npm run build` | 종료0 | `tsc -b` 및 기존 앱 Vite 번들. 기존 메인 번들500KB 경고 유지 |
| `node node_modules/@playwright/test/cli.js test tests/ui/survivor-profile.spec.ts --workers=1` | 8개 통과 | 실제 Chromium 독립 쉼터·두 페이지 Web Locks/localStorage |
| `node scripts/test-survivor-profile-native.mjs` | 종료0 | 실제 Windows WebView2에 현재 프로필/세션 소스를 주입해 API/저장/중단복구 실증 |

단위 검사:

- 스키마 누락/추가·미래 버전·손상 JSON·과대 데이터, 음수/소수 잔액·NaN/Infinity·단계 상한·중복/미지원 해금 거부.
- 최대 영구 강화의 실제 엔진 시작HP/공격력/수집/골드 배율·카드 후보·다시뽑기2회. 기본 장비는 물기1개 유지.
- 같은 화면 리비전의 구매 연타, 잔액 부족·최대 단계·중복 해금·판 중 구매/환불 차단. 실제 과거 지불액 환불·해금 제외·잔액 상한·반복 환불 차단.
- 구매·환불·설정·판 시작·체크포인트·정산 쓰기 실패와 재시도. 쓰기 실패 시 이전 프로필/원본 문자열 유지. 정산 실패는 result/현재 수집 합계를 유지하며 새 판/닫기를 차단한다.
- 사망/마무리/포기 모두 `floor(25.75) + 80 + 30 = 135`를 한 번의 레코드 쓰기로 반영. 소수 잔여는 여러 체크포인트/구간을 지나도 정산 전에 내리지 않는다. 첫 보스 플래그/기록/잔액/체크포인트 제거가 함께 반영된다.
- 보스 전/후·스테이지 통과·연속 카드 대기 중 체크포인트 복구, 첫 보스 보상1회, 최근20개 이후 오래된 이벤트·다른 runId/seed·감소한 합계·불일치 보스 증거 거부. `recover()`로 현재 플레이 중인 판을 중단 정산할 수 없다.
- 5초 경과/카드 화면ID/정지/구간 변경 저장, 실패 시 전투 정지·명시적 재시도, 소유권 상실 시 다음 sync에서 즉시 정지. 잠금 미지원·접근/쓰기 불가·미래/손상 저장의 명시적 임시 플레이는 원본을 변경하지 않는다.

브라우저:

- 360/560/1280px에서 구매 효과/잔액·더블클릭/반복 키·환불 확인·해금 제외·음소거/모션 저장·리로드 복원·가로 넘침 없음. 560px는 GitHub Dark, 다른 크기는 기본 크림 테마.
- 실제 같은 origin의 두 페이지: 한쪽만 소유권 획득, 읽기 전용 구매 차단, storage 이벤트 잔액 갱신, 소유 페이지 닫기 후 재확인/중단 정산, 재리로드 중복 지급 없음.
- 저장 실패 주입 시 구매 미적용/명시적 저장 재시도, 미래/손상 데이터 원문 보존, 잠금 API 미지원 대체 경로.
- 이미지: `target/verification/survivor-hub-{360,560,1280}.png`. 360/1280 화면을 직접 확인했고 체크박스에 전역 input 너비가 적용되어 글자가 세로로 나뉘던 문제를 수정했다.

## Windows WebView2 실증과 한계

- 기존 `target/debug/daxterm.exe`(이번 요청에서 재빌드하지 않음)를 **별도 임시 앱 데이터/WebView 폴더**로 실행했다. 현재 `profileStore/session/profile` 소스를 Vite 테스트 라이브러리로 번들해 CDP로 주입했다. 사용자 앱 데이터는 사용하지 않았다.
- origin은 `http://tauri.localhost`, secure context true, Web Locks/`crypto.randomUUID` 지원 true, 런타임 UA는 Edg156.0.0.0이었다.
- 실제 동일 origin의 peer iframe에서 소유권 경쟁·읽기 전용·storage 이벤트를 검사했다. 이는 독립 문서 검사이며 **제품의 두 네이티브 창 UI 통과가 아니다**. 실제 두 브라우저 페이지 검사는 위 Playwright 결과다.
- 첫 판 정산135 → HP강화30 구매 → 잔액105 → 둘째 판2.75 체크포인트 →6초 대기 → 앱/WebView 전체 프로세스 강제 종료 → 동일 데이터로 재실행 → 중단 정산2 → **잔액107/HP1단계/첫 보스지급 true/정산2개/체크포인트 null**을 확인했다.
- 기계 판독 결과: `target/verification/survivor-profile-native.json`. 이 파일은 로컬 검증 산출물이며 Git에서 무시한다.
- **실패 관찰을 보존한다:** 최초 즉시 전체 프로세스 강제 종료 실험에서는 localStorage가 성공 응답했어도 재실행 시 신규 프로필0으로 읽혔다. Web Storage의 레코드 교체 원자성과 프로세스/디스크 내구성은 다르다. 프로세스 전체를 즉시 죽이거나 전원이 끊기면 최근 체크포인트뿐 아니라 최근 구매/정산도 디스크 반영 전에 잃을 수 있다. 6초 대기 통과를 항상6초 내 flush 보장으로 해석하지 않는다. 애플리케이션의5초 저장 주기도 최대 손실 시간 보장이 아니다.
- 초기 네이티브 검사 스크립트에서 Vite library build 반환값이 배열인 경우를 누락해 소스 주입 전에 실패한 것은 테스트 하네스에서 수정했다. 저장 손실 관찰과 별개다.

## 연결 및 남은 검증

- G.8.5: 게임 탭 수명에 `SurvivorProfileStore`/`SurvivorSession`을 연결하고, 프레임/카드/다음 구간 후 `sync`, 비활성화에 `pause`, 닫기에 `close()` 성공 여부, 종료 결과의 `retrySave()`를 사용한다. React effect 정리에서 정산하지 않는다. 상세 API는 설계 §10을 따른다.
- 브라우저 UI 검사는 독립 쉼터이고 네이티브 검사는 현재 저장소 소스 주입이다. 아직 제품 카탈로그에 등록하지 않았으며 전체 서바이버 전투/입력/음향/앱 정상 종료 UI 검사는 실행하지 않았다.
- native debug/release/NSIS 새 빌드·설치, Rust 단위/clippy, 실제 로컬PTY/SSH 입력 격리, Mac WKWebView/실기기, 물리터치, 첫 두 보스 일반 플레이·장기 밸런스·p95/메모리는 이번 범위에서 미실행. 각각 화면 연결/후속 범위 또는 해당 환경 결과가 필요하다.
- G.8.6에서 정상 앱 종료·OS 비정상 종료/절전의 저장 동작과 실제 손실 범위를 추가 확인한다. 디스크 내구성을 더 강하게 보장하려면 별도 저장 기술/IPC 설계가 필요하며 이번의 localStorage 범위에서 보장한 것으로 표시하지 않는다.
