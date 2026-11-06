# G.8.6 — 서바이버 밸런스·성능·실환경 검증

- 날짜: 2026-11-05, Windows / WebView2. 범위 정본은 [로드맵 G.8](../roadmap.md), 규칙은 [설계 §11~12](../design/dachs-survivor.md), 이어할 위치는 [progress](../progress.md)다.
- 구현: 절전/정체 후 긴 프레임 간격, `pagehide`, `freeze`에서 전투를 정지하고 입력을 비우며 체크포인트를 저장한다. 네이티브 종료의 기존 정산/실패 차단 계약은 유지한다.
- 자동 명령 시뮬레이션, 실제 내장 제품의 키보드 플레이, 인공 부하를 주입한 소스 프로브를 구분한다. 사람의 재미 평가나 Mac/실제 OS 종료·절전을 자동 검사로 대체하지 않는다.

## 반복 가능한 명령

Node에는 `--max-old-space-size=1024` 또는 PowerShell `$env:NODE_OPTIONS='--max-old-space-size=1024'`를 사용했다. 네이티브 검사는 각각 격리된 임시 앱/WebView 데이터와 검사 소유 프로세스를 사용한다. 동일 시각에 여러 네이티브 검사를 실행하면 창 포커스·성능이 영향을 받을 수 있으므로 재측정은 순차 실행한다.

```text
node node_modules/vitest/vitest.mjs run src --maxWorkers=1
node node_modules/@playwright/test/cli.js test tests/ui/survivor.spec.ts tests/ui/survivor-profile.spec.ts tests/ui/games.spec.ts tests/ui/dachs-games.spec.ts --workers=1
node scripts/measure-survivor-balance.mjs
node scripts/play-survivor-native.mjs
node scripts/measure-survivor-native.mjs
node scripts/measure-survivor-lifecycle-native.mjs
node scripts/test-survivor-integration-native.mjs
node scripts/test-survivor-ui-native.mjs
```

결과 JSON과 캡처는 Git에서 제외한 `target/verification/survivor-*`에 남긴다. 이번8.6의 최종 JSON/설치 결과는 공유 경로 덮어쓰기와 구분해 **`target/verification/survivor-g86-artifacts/evidence/`**에도 보존했다. 성능 프로브는 `DACHSTERM_VERIFICATION_DIR`로 출력 폴더를 지정할 수 있다. 제품 번들에는 `tests/native`의 정책·상한 부하·상태 제어를 연결하지 않는다. SSH 검사는 localhost 임의 포트의 전용 Docker OpenSSH를 사용하고 최초 호스트키 지문을 컨테이너 공개키와 대조한다. 인증정보는 메모리·컨테이너 tmpfs에서만 처리하고 오류의 locator trace를 출력하지 않는다. 종료 때 컨테이너를 제거한다.

## 밸런스와 장기 진행

`tests/native/survivor-balance.ts`는 `newSurvivor` 기본 옵션에서 시작해 공개 이동·카드·다음 구간 명령만 사용한다. 무적·HP 보정·강화 지급·보스 HP 변경·시간 건너뛰기는 없다. 효율적인 정책의 결과이며 사람의 플레이 시간/난이도 판정은 아니다.

| 시드 | 첫 보스 전투 | 두 번째 보스 전투 | 7구간 진입 누적 전투 | 카드 선택 | 수집 / 보스 골드 |
|---|---:|---:|---:|---:|---:|
| 1 | 21.83초 | 7.98초 | 392.82초 | 32회 | 98 / 80 |
| 42 | 12.45초 | 6.80초 | 382.25초 | 31회 | 94 / 80 |
| 2026 | 13.25초 | 7.72초 | 383.97초 | 32회 | 109 / 80 |
| 11305 | 19.02초 | 13.48초 | 395.50초 | 33회 | 101 / 80 |
| 71037 | 52.88초 | 7.47초 | 423.35초 | 33회 | 94 / 80 |

첫 보스 이전 2구간까지 수집 골드26~33, 첫 보스 통과 합계77~90에 프로필 최초 보스30을 더하면107~120이다. 제안한 초반 수익 범위 안이다. 7구간 도달까지 보스 포함 환산 수익은 시간당 약1,480~1,772골드다. 카드·정지·구간 화면에 머무는 현실 시간은 분모에서 제외했으므로 실제 사용자 수익보다 높을 수 있다. 영구 강화가 없는 프로필이며 첫 보스30은 시간당 반복 수익에 포함하지 않았다.

장기 시드1/71037은 각각1,819.28/1,864.75초에28구간에서 사망했다. 레벨40은478.38/510.65초에 도달했고 이후 XP0·총 카드39회·4무기/4능력·랭크5·진화2 상한을 지켰다. 보스9회/360골드, 수집668/678골드로 시간당 약2,034/2,004골드다. 드롭250 상한에 도달했으며 적 최대67/78, 공격25, 적탄15/16으로 배열 상한을 넘지 않았다. 같은 정책의 반복 구간에서 무한 성장이나 추가 카드 누적은 없었다.

성장 후 두 번째 보스가 빠르게 끝나는 점과 약8분에 레벨 상한에 도달하는 점은 플레이 평가 대상이다. 자동 정책만으로 HP/보상/가격을 임의 변경하지 않았다. 콘텐츠 버전3과 기존 수치는 유지한다.

## 실시간 일반 입력 플레이

`play-survivor-native.mjs`는 **실제 내장 제품**의 Canvas 픽셀·DOM HUD를 읽고 WASD·숫자 카드키·버튼으로 진행한다. 엔진을 import하거나 런 상태·시드·시간·프로필을 주입하지 않는다. 자연 생성된 시드와 카드 제안·선택, 구간별 HP/전투 tick, 종료 결과를 기록한다. 자동 키보드 검사이므로 사람의 재미 평가와 구분한다.

| 자연 생성 시드 | 3구간 보스 통과 tick / HP | 6구간 보스 통과 tick / HP | 7구간 진입 tick / HP | 실제 경과 / 카드 | 수집 / 보스 |
|---|---|---|---|---|---|
| 2105255200 | 12847 / 60 | 24269 / 100 | 24276 / 100 | 409.840초 / 30회 | 85 / 80 |
| 3108173795 | 12338 / 70 | 24267 / 83 | 24273 / 83 | 409.787초 / 31회 | 87 / 80 |

두 판 모두 무강화/물기1 시작, 첫 두 보스 처치 후4·7구간 진입, 자연 카드/진화·성장 유지가 확인됐다. HUD 기준 첫 보스전32/24초, 두 번째8/17초다. 첫 판 종료 지급195(85+80+첫 보스30), 두 번째는 기존195 잔액으로 시작하되 구매하지 않아 기본 능력이며 첫 보스30은 재지급하지 않는다. 전체 결과 `survivor-play-native.json`과 구간/종료 캡처를 남겼다. 첫 판6구간 통과 캡처에서4무기·진화2, 누적보상80, 다음7 버튼과 HP100을 직접 확인했다.

## 상한 부하와 메모리

실행 환경은 Intel Core i5-1340P / 논리16코어 / RAM 약16GiB / Windows / Edge WebView2 156이다. 인공 시나리오는 일반 적180+정예2+보스1, 공격240, 드롭250, 적탄100을 유지한다. 적의 HP·플레이어 무적·구간 시간을 검사 전용으로 고정한다. 실제 조합으로 상한까지 도달한 플레이가 아니다. 공격은 충돌 후보가 많은 장판240개이며 모든 공격 종류의 최악 비용을 증명하지 않는다.

최종 검사는 이 작업의 다른 네이티브 검사를 종료한 뒤8.6 고정 소스·보존 debug EXE를 명시해 순차 측정했다. 공유 Windows의 다른 작업 부하는 통제하지 않았다.1280px/DPR1·4무기/4능력 HUD·위 객체 상한을 사용했다.

| 측정 | 기간 / 프레임 | CPU p95 / 최대 | RAF 간격 p95 |
|---|---|---|---|
| 엔진1틱 + Canvas 명령 제출 | 60.016초 / 3587 | 2.3 / 8.2ms | 16.8ms |
| 실제 SurvivorGame/controller/session/store/audio/HUD 소스의 RAF | 60초 / 2870 | 5.4 / 14.3ms | 33.4ms |

두 CPU p95가16.7ms 처리 시간 목표 이내였다. 두 번째는 고정 스냅샷의 실제 React UI와 저장 수명을 WebView2에 별도 mount하고 인공 런만 주입했다. 새로운 게임 프레임 코드를 모사한 측정이 아니다. 비동기 React 작업·GPU/합성·화면 표시 지연은 RAF 콜백 CPU에서 제외된다. **UI RAF 간격 p95는33.4ms이며 안정적인60FPS 표시를 통과한 것으로 해석하지 않는다.** CPU 처리 시간과 프레임 간격을 구분해 조용한/전경 환경의 장시간 재측정 대상으로 남긴다. 실제 내장 제품 일반 입력 플레이와는 별개의 소스 부하 실증이다. 정지/복귀 후 추가 틱1개·스폰 예약 유지, 모든 객체 상한 유지. 최종 결과는 보존 evidence의 `survivor-performance-native.json`이다.2초 smoke/초기 엔진 전용/1282px 및 병행 변경 debug 호스트로 실행된 중간 결과는 이 최종 결과와 구분한다.

실제 내장 제품에서 탭 열기→잠금 획득→짧은 판 시작→정지→닫기 정산→unmount를 반복했다. 최초 Playwright locator 기반10회는 DOM801/리스너335 고정, JS 힙약7.50→7.80MB로 증가했다. 이를 곧바로 누수 없음으로 판정하지 않았다.

페이지 안의 단일 이벤트 드라이버로70회 재검사했다.10회 예열 이후70회까지 JS 힙4,821,228→5,075,064바이트, DOM334/리스너214 고정, backing storage865,172→865,142바이트였다. 원시 heap snapshot은 저장하지 않고 타입/생성자별 개수·바이트 차이만 메모리에서 집계했다. 증가분 대부분은 code235,188바이트였으며 Object는9개/288바이트, array는1개/76바이트 증가했다. 렌더러 LayoutShift/리소스 타이밍·DevTools 캐시 증가도 관찰했다. 적·공격·런 배열/DOM/리스너가 판마다 누적되는 증거는 없으나 **전체 힙이 완전히 평탄하다는 뜻이나10개 장시간 전투의 검증은 아니다**. 코드 캐시를 포함한 장시간 메모리는 별도 확인한다.

## 실제 PTY/SSH와 수명

- 새 debug 내장 자산에서 실제 Windows PowerShell `Read-Host`, 실제 SSH `read`를 대기시킨 뒤 WASD/방향키/1·2·3/R/M/Space/Enter/P 및 자연 레벨업 카드·다시 뽑기·선택을 실행했다.
- 두 셸 모두 반환 입력이 `SURVIVOR_INPUT<>`로 비어 있었다. 연결 ID가 유지됐고 게임 복귀 뒤 같은 셸에서 `AFTER_SURVIVOR_OK` 출력을 받았다. Mock/xterm 미리보기 결과로 대체하지 않았다.
- 일시정지1.1초 동안 tick이 유지됐다. 명시적 창 닫기로 exit0, pageerror0. 결과는 `survivor-integration-native.json`에 SHA256과 함께 기록했다.
- 초기 검사 실패는 상태 텍스트가 붙은 탭 이름의 exact locator, lazy UI 표시 전 분기, 빈 문자열인 `details[open]`의 falsy 판정 문제였다. 검사 드라이버를 수정했으며 제품의 연결/전투 규칙을 통과 목적에 맞춰 바꾸지 않았다.
- 긴 프레임60초 점프는 전투 tick 증가 없이 정지/체크포인트 저장, 재개 후 held 이동 없음. 카드 중 `freeze`/`pagehide`는 동일 choiceId와 tick을 유지하고 정산하지 않는 것을 브라우저에서 확인했다. 실제 OS 절전/종료 실증과는 다르다.

## 배포와 남은 검증

8.6의 `tauri build --debug --no-bundle`, `tauri build --bundles nsis`가 모두 종료0이었다. 프런트엔드 tsc-b/Vite 포함이며 기존 main 번들500KB 경고는 유지한다. 별도 병행 작업이 content/enemies/renderer/scenery 및 검사를 변경하기 시작해, 기존 HEAD `da01f5c`에 이번8.6 소유 파일만 반영한 **`target/verification/g86-source` 스냅샷**을 만들었다. 콘텐츠 버전3/전투 수치는 유지한 검사다. 이후 병행 작업의 버전/수치/시각 변경에 이 결과를 그대로 적용하지 않는다.

실행 파일이 다른 빌드로 바뀌지 않도록 아래를 `target/verification/survivor-g86-artifacts/`에 복사 보존했다. 전체 경로·크기·해시는 같은 폴더 `manifest.json`에 있다. 재검사 시 `DACHSTERM_TEST_BINARY`로 보존 debug 파일을 지정할 수 있다.

| 파일 | SHA256 |
|---|---|
| dachsterm-debug.exe | `5bce56589788e9f6be1197a96ca178dfd5662933e5f7d965623ce03c46fb2c66` |
| dachsterm-release.exe | `baaa170867457c00159f94d1b316b0a6d0849930cb779bea2f13e3def39acbc0` |
| dachsterm-nsis-payload.exe | `c2cbfe04065df67236fa3a11bb227fb9b00ff486f31e6111e4c532cedd7d0b23` |
| DaxTerm_0.5.1_x64-setup.exe | `fbc6bb6c92945048f8e8c9195fe968bce6357fc12b37b30b2be66bec37eb7c18` |

**설치 EXE와 단독 release의 해시는 다르다.** 최초 예상 해시 비교는 실패했다. 두 파일을 실제 바이트 비교한 결과 길이28,689,408바이트가 같고 차이는23,527,274~23,527,276의3바이트뿐이었다. `__TAURI_BUNDLE_TYPE_VAR_UNK`가 NSIS용 `...NSS`로 바뀐다. 로컬 `tauri-utils-2.10.2/src/platform.rs`의 bundle-type marker 및 빌드의 bundle type patch 로그와 일치한다. `verify-survivor-artifacts.mjs`가 그 marker만 치환한 메모리 사본과 설치 payload 전체 일치를 검사하며 실행 파일을 수정하지 않는다. 같은 스크립트로5개 native 결과의 debug SHA 일치도 확인한다. 단독 EXE 해시를 설치 payload의 예상 해시로 사용하지 않는다.

최종 설치 명령:

```powershell
& scripts/test-installer.ps1 -Reinstall `
  -InstallerPath 'D:\Work\daxterm-workspace\target\verification\survivor-g86-artifacts\DaxTerm_0.5.1_x64-setup.exe' `
  -ExpectedBinarySha256 'C2CBFE04065DF67236FA3A11BB227FB9B00FF486F31E6111E4C532CEDD7D0B23'
node scripts/verify-survivor-artifacts.mjs
```

최종 설치 검사는 종료0. 기존 설치가 없음을 확인한 뒤 검사 소유 임의 폴더에 설치했다. 버전0.5.1·등록 위치·고지 파일·설치 payload 해시, 동일 버전 재설치 시 검사 표식 보존, 실제 release 네이티브 창 초기화·정상 종료, 제거/등록 정리를 확인했다. 설치된 release에서 전체 보스 플레이를 다시 수행한 것은 아니며 전투/저장 검사는 위 debug 결과다. 서명된 공개 배포·Mac 패키지를 의미하지 않는다.

최종 회귀는8.6 고정 범위에서 단위13파일/215개, 브라우저11+19=30개 통과. 기존6종을 포함한다. 타입/전체린트·변경 파일 포맷을 통과했고 상한 프로브 TypeScript는 별도 명시 파일 검사도 종료0이었다. 최신 보존 debug로 `test-survivor-ui-native.mjs`를 재실행해 자연 카드/입력·저장 실패 창닫기 차단·정산 재시도1회·정상 종료/재실행 전체프로필 일치를 다시 통과했다. 현재 공유 작업 트리 전체는 병행 변경을 포함하므로 이8.6 고정 결과와 구분한다. 중간 전체 타입 검사에서 별도 scenery의 Vec2 import 오류를 관찰했으며 해당 병행 파일은 이 작업에서 고치거나 되돌리지 않았다.

대기: 사람의 무강화 다중 시드 플레이·난이도/재미 평가, 실제 OS 종료/절전, Mac WKWebView/실기기, 물리 멀티터치·스피커 청취,10개 장시간 전투 메모리와 전경/부하 통제 환경의 RAF 간격. 환경/사람의 평가가 필요한 항목을 자동 시뮬레이션으로 완료 표시하지 않는다. [기존 저장 검증](survivor-profile.md)의 강제 종료 디스크 손실 가능성은 유지하며5초 저장주기가 손실 상한이라는 보장은 없다.
