# G.8.5 — 서바이버 화면·입력·종료 검증

- 날짜: 2026-11-05 / Windows, Chromium 및 실제 Tauri WebView2.
- 범위: 게임 목록과 탭 수명, Canvas/HUD, 카드·구간 통과·결과, 입력·테마·음향, 종료 저장. 설계는 [닥스의 서바이버](../design/dachs-survivor.md), 진행 정본은 [progress](../progress.md)다.
- **G.8.5 구현/해당 범위 검증 완료**. G.8.6의 첫 두 보스 일반 입력 클리어·밸런스·성능·실제 PTY/SSH·배포 검증을 대신하지 않는다.

## 구현

- `catalog.ts`, `GamePane.tsx`, `App.tsx`: 게임 목록에 `닥스의 서바이버`를 추가했다. 기존 6종 및 터미널을 유지한다. 탭 전환/Esc는 정지, 명시적 닫기는 포기 정산이다. 저장 실패 시 탭을 제거하지 않고 해당 게임 결과와 재시도를 표시한다.
- `survivor/controller.ts`: 탭마다 store/session 1개, 시작·카드·다시 뽑기·다음 구간·정산 명령 뒤 sync, 보통 HUD 10Hz와 의미 있는 변화 즉시 발행. React StrictMode의 effect 재실행은 잠금 해제나 정산으로 취급하지 않는다. 실제 unmount에서 소유권을 해제한다.
- `SurvivorGame.tsx`, `survivor.css`: 기존 쉼터 연결, HP/XP/구간·보스 시간/수집·보스·영구 골드, 무기/능력 각4칸, DOM 카드/정지/통과/결과. 360px 세로 카드·560/1280px 3열, 내부 스크롤과 최소44px 조작을 제공한다. 카드의 실제 변화량 및 정지 도움말의 진화 조건을 표시한다.
- `renderer.ts`: 960×540 고정 논리 시야, 3200×3200 월드 경계, 시드 기반 비충돌 장식, 기존 atlas의 좌우 반전, 적8종/드롭3종/6무기·진화 공격/보스 체력·방향/돌진·씨앗·도약 예고. 색상은 공통 테마에서 받으며 렌더링은 엔진 난수를 소비하지 않는다. CSS 크기와 DPR(최대2)은 Canvas 해상도에만 반영한다.
- 입력: 게임이 포커스를 소유할 때만 WASD/방향키·1/2/3·R/P/M/Space/Enter를 처리한다. 텍스트 입력/조합키/IME 조합은 제외한다. 키 반복·keyup 경계·화면 choiceId/구간 번호를 적용하며 Enter는 포커스한 버튼만 실행한다. 카드/정지/탭·창 이탈 때 이동키와 포인터를 비우고 자동 재개하지 않는다. 외부 텍스트 필드로 이동한 포커스를 빼앗지 않는다.
- `audio.ts`: 사용자 제스처 뒤 합성 타격·XP·레벨업·진화·보스 효과음을 활성화한다. 최대3음/80ms 간격, 현재 공격 ID만 추적하며 정지·비활성·음소거·해제 시 정리한다. 프로필 음소거/모션 설정을 사용하고 임시 판은 영구 저장을 수정하지 않는다. 모션 줄이기에서 흔들림/스프라이트·무기 장식 회전을 줄이고 공격 예고를 유지한다. 음향 청취 품질·실제 스피커 검사는 미실행이다.
- 네이티브 종료: `getCurrentWindow().onCloseRequested`에서 실패 시 preventDefault, 성공 시 Tauri의 기본 destroy→기존 Rust 종료 정리로 진행한다. 이 API의 기본 종료에 필요한 `core:window:allow-destroy`를 `survivor-window.json`의 **main 창에만** 허용했다. 새 Rust 명령/게임 프레임의 SSH·PTY·파일 IPC는 추가하지 않았다. 브라우저 beforeunload는 최선 노력이며 OS 강제 종료 보장과 다르다.

## 실행한 검증

Node 명령에는 메모리 제한 `--max-old-space-size=1024`를 적용했다. npm/Playwright/Tauri 실행에는 PowerShell `$env:NODE_OPTIONS='--max-old-space-size=1024'`를 사용했다.

| 검증 명령 | 실제 결과 |
|---|---|
| `node --max-old-space-size=1024 node_modules/typescript/bin/tsc --noEmit` | 종료0 |
| `node --max-old-space-size=1024 node_modules/eslint/bin/eslint.js .` | 종료0 |
| `node --max-old-space-size=1024 node_modules/vitest/vitest.mjs run src --maxWorkers=1` | 12파일 / 209개 통과 |
| `node node_modules/@playwright/test/cli.js test tests/ui/survivor.spec.ts tests/ui/survivor-profile.spec.ts tests/ui/games.spec.ts tests/ui/dachs-games.spec.ts --workers=1` | 26개 통과 (당시 신규 UI7 + 기존 회귀19) |
| 최종 `node node_modules/@playwright/test/cli.js test tests/ui/survivor.spec.ts --workers=1` | 9개 통과 (상태 보존/외부 포커스2개 추가). 위 실행과 합쳐 **고유28개** |
| `npm run build` 및 `node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle` | 종료0, 최신 frontend 내장 debug 실행 파일 생성. 기존 main 번들500KB 경고 유지 |
| `node scripts/test-survivor-ui-native.mjs` | 실제 WebView2 검증 종료0, 아래 내용 참조 |
| 변경 소스/검사/설정 `prettier --check`, `git diff --check` | 종료0 |

브라우저 신규9개는 실제 React UI·Web Locks·localStorage를 사용했다. 폭별 카드/통과/결과·라이트/다크, 95/135골드 정산, Enter로 마무리, 연속 카드/다시 뽑기/다음 구간의 반복 억제, 선택 중 blur/탭 이탈과 같은 카드 복귀, 이동키 해제, 포인터 cancel, 음소거 저장, 모션 줄이기, 외부 입력·조합키, resize/테마 변경 후 엔진 전체 직렬화 일치, 저장 실패 닫기 차단·재시도·새 탭 잠금 획득을 검사했다. 실제 제품 카탈로그/탭에서 기존 xterm 인스턴스 유지와 Esc 복귀도 확인했다. xterm 미리보기는 실제 PTY/SSH 검사가 아니다.

복잡한 카드/구간/보스 보상 UI는 **테스트 전용 fixture에서 상태를 설정**했다. 제품 번들에는 fixture/테스트 제어를 포함하지 않는다. 이 검사로 첫 두 보스 실플레이 클리어나 난이도 적합성을 주장하지 않는다. 초반 실패 중 하나는 검사 중 소스 포맷 변경에 따른 Vite reload였으며, 나머지는 전투 시작 뒤 가상 시계 설치·화면 밖 포인터 좌표·fixture가 choosing 이전에 카드를 요청한 설정 오류였다. 시계를 시작 전에 설치하고 포인터를 스크롤 안에 배치하며 실제 엔진 계약에 맞게 fixture를 수정한 후 통과했다.

## 실제 Windows 실행

`scripts/test-survivor-ui-native.mjs`는 새 `target/debug/daxterm.exe`를 별도의 임시 데이터/WebView 폴더로 실행했다. 현재 제품 코드·내장 자산을 사용했으며 엔진 시드나 전투 상태를 주입하지 않았다. 실패 경로에서만 해당 프로필 키의 저장 예외를 주입했다.

- 게임 목록→새 도전, 실제 WASD 이동 및 자동 공격으로 **첫 레벨업(레벨2)/카드3장** 확인.
- 카드 포커스, Esc→게임 재진입→일시정지→재개 후 동일 카드, 숫자 선택 및 정지 중 tick 유지.
- 실제 native window close 명령에서 저장 실패 시 **프로세스/결과 유지**, 명시적 저장 재시도 후 정산1개·checkpoint 제거.
- 정상 창 종료 시 프로세스 exit0, 같은 격리 데이터로 재실행 후 **프로필 전체 일치** 및 추가 정산 없음. 첫 선택까지의 자연 진행 결과이며 보스 클리어 검사는 아니다.
- pageerror 0. 캡처/결과: `target/verification/survivor-ui-native.png`, `survivor-ui-native.json`. 결과 JSON에 실행 파일 절대 경로와 SHA256을 기록한다. 실제 검사 프로세스는 종료했다.

폭별 화면은 `target/verification/survivor-{battle,cards,result}-{360,560,1280}.png`에 저장했다. 360 세로 카드의 내부 스크롤, 560 다크의3열, 1280과 native 화면을 직접 확인하고 카드 내용의 상단 정렬을 보완했다.

## 미실행과 다음 검증

- G.8.6: 일반 입력으로 3/6 보스 처치 후4/7 진입, 장기 상한/골드 수익·재미/난이도, 상한 부하60초 p95와 반복10판 메모리, 실제 로컬 PTY/SSH 입력 격리, 정상 OS 종료/절전, release/NSIS 생성·설치 확인.
- Mac WKWebView/실기기·물리 멀티터치·스피커 청취 검사는 이번 Windows 자동 환경에서 수행하지 않았다. Rust 제품 코드를 변경하지 않아 Rust 단위/clippy/SSH 엔진 전체 회귀를 반복하지 않았다.
- localStorage의 원자적 레코드 교체는 전원 차단/프로세스 전체 강제 종료의 디스크 내구성 보장이 아니다. **5초 저장 호출 주기가 손실 상한을 보장하지 않는다.** [G.8.4 저장 한계](survivor-profile.md)를 그대로 유지한다.
- 기존 release/설치본은 갱신하지 않았다. 현재 플레이용 변경은 위 최신 debug 실행 파일에 포함된다.
