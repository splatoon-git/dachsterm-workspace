# 편집기 부품 시험 (GE.4)

- 실행일: 2026-11-08. Windows 11 Pro 10.0.26300, WebView2 `Edg/157.0.4341.42`, Monaco `0.57.0`.
- 설계: [git-editor GE.4](../design/git-editor.md#ge4--편집기-부품-시험). Mac 항목은 [macos-readiness M.16](macos-readiness.md).
- 대상: 브랜치 `feat/ge4-editor-trial`의 커밋 전 트리. 결과의 앱 빌드 뒤에는 검사 스크립트의 창 표시·종료 처리와 `eslint.config.js`의 제외 목록만 바꿨다.

**결론: Windows 자동 측정은 37/37 통과, 잠정 선택은 Monaco(`editContext: false`).** 다만 IME는 CDP로 만든 합성 입력이고 실제 IME 입력은 아직 없다. 최종 선택은 Mac 실기기 한글 조합을 본 뒤 정한다.

## 측정 방법

- `tests/editor-trial/`의 시험 화면을 앱 페이지 자리에 넣은 별도 빌드를 쓴다(`tauri.trial.json`, 출력 `target/editor-trial`). 앱의 실제 CSP와 `tauri.localhost` 아래에서 돌고, 시험 코드는 제품에 들어가지 않는다.
- 실행: `npm run test:editor-trial`(빌드 포함), `node scripts/test-editor-native.mjs --reuse-build`. 원자료는 `test-results-native/editor-trial/report.json`과 스크린샷이다.
- 조합은 CDP `Input.imeSetComposition`·`Input.insertText`로 넣는다. 편집기의 조합 이벤트 처리는 확인하지만 **OS IME를 거치지 않으므로 IME 합격이 아니다.**

## 결과

| 기준 | 판정 | 결과 |
|---|---|---|
| 한글 조합(받침, 받침 넘어가기) | 합성 통과 / 실제 IME 수동 대기 | `한글 값이 아녕` 일치. 아래 "재현되지 않은 실패" 참고 |
| 조합 중 커서 이동 | 합성 통과 / 수동 대기 | 조합 중 화살표 `가나다`, 확정 뒤 이동 `가나라다` |
| 조합 중 저장 단축키 | 합성 통과 / 수동 대기 | 글자 손실 없음. **조합이 열린 동안의 Ctrl+S는 저장이 실행되지 않았다**(textarea 경로). 확정 뒤 Ctrl+S는 전체 글자를 넘긴다 |
| 일본어·중국어 | 합성 통과 / 실제 IME 수동 대기 | `漢字日本`, `你好世界` |
| 10만 줄 스크롤 | 통과 | 아래 표 |
| 앱 테마 전환 | 통과 | 12개 테마. 코드 화면은 배경·키워드 색, diff 화면은 배경이 토큰과 일치 |
| diff 좌우·한 줄 | 통과 | 좌우 590/625px와 변경 표시, 한 줄은 원본 줄번호 칸(41px)과 삭제 줄 표시. 스크린샷 확인 |
| 웹 워커 로딩 | 통과 | `editor`·`ts`·`json`·`css`·`html` 워커 시작, TS·JSON·CSS 진단 표시, 메인 스레드 대체 경고 없음 |
| CSP·글꼴·lazy | 통과 | CSP 위반 0, codicon 글꼴 로딩, 첫 화면 HTML이 편집기 청크를 미리 불러오지 않음 |

10만 줄(각 행 약 40바이트, 약 4MiB):

| 언어 | 열기 | 휠 프레임 p50/p95/최대 | 끌기 프레임 p50/p95/최대 | 힙 |
|---|---|---|---|---|
| plaintext | 214ms | 33/36/41ms | 33/36/37ms | 57MiB |
| typescript | 190ms | 33/36/286ms | 33/35/36ms | 167MiB |

- 유휴 상태도 p50 33ms라 이 측정 환경의 프레임 간격은 약 30fps가 상한이다. 60fps 환경의 체감을 뜻하지 않는다.
- 휠 90회로 237번째 줄까지 내려갔다. CDP의 `deltaY: 2400`도 `wheelDeltaY: -120`, 즉 실제 휠 한 칸으로 전달되며 칸당 50px은 Monaco 기본값이다. 스크롤바 끌기로 49,980번째 줄, `Ctrl+End`로 마지막 줄에 도달했다.
- typescript 최대 286ms는 네 번의 실행에서 224~299ms로 반복됐다. 구문 강조가 켜진 경우 스크롤 중 한 번 생기는 멈춤이다. 설계상 2MiB를 넘는 파일은 강조를 끄므로 GE.5의 "크게 열기"에서는 plaintext 값이 기준이다.

## 결정: `editContext: false`

Monaco는 Chromium에서 기본으로 EditContext 입력 경로를 쓴다. 같은 합성 입력에서 두 경로가 달랐다.

| 경로 | 조합 중 왼쪽 화살표 | 조합 중 Ctrl+S |
|---|---|---|
| EditContext(기본값) | **`가다다`: `나`가 사라지고 `다`가 중복** | 저장 실행 |
| textarea | `가나다` | 저장 실행 안 됨, 글자 손실 없음 |

WKWebView에는 EditContext가 없어 textarea를 쓴다. 글자 손실이 없고 두 OS의 Monaco 입력 코드가 같아지도록 `editContext: false`로 정했다. 합성 입력은 조합이 열린 채 키가 들어간 경우이고 실제 IME가 같은 순서로 보내는지는 미확인이다.

## 재현되지 않은 실패

`editContext: false` 빌드에서 첫 조합 검사가 한 번 `한글 값이 ㅇ아녕`으로 실패했다(`ㅇ`이 남음). 같은 빌드에서 첫 검사와 반복을 합쳐 144회 중 이 1회뿐이다. 반복 측정은 25ms 간격 80회, 60ms 간격 40회, 페이지를 새로 로드한 직후 20회이고 모두 일치했다. **원인은 찾지 못했고 고친 것이 아니다.** 커밋 직후 다음 조합이 시작될 때의 타이밍 문제일 수 있다. 실제 IME 수동 확인에서 글자 잔류를 함께 본다.

## 의존성

- 프로덕션 의존성 `monaco-editor` `0.57.0`(MIT). 고지(`licenses/`)를 재생성했다(450개, 검토 필요 0).
- Monaco 0.57.0은 패키지 안에 DOMPurify 3.4.15 사본을 넣어 쓰고, 이 버전은 공개 권고 범위(`<=3.4.16`, 심각 등급 포함)에 든다. npm `audit`이 실패해 두 가지를 했다.
  - `package.json` `overrides`로 npm 패키지를 3.4.17로 올렸다. `npm audit --audit-level=low`는 0건이다.
  - 이것만으로는 번들이 바뀌지 않으므로 `vite.config.ts` 별칭으로 Monaco의 내장 사본을 npm 패키지로 대체했다. 시험 빌드 번들에 `3.4.17`만 있고 `3.4.15`는 없음을 확인했다.
  - Monaco의 살균 호출은 권고 대상 옵션(`IN_PLACE`, `SAFE_FOR_TEMPLATES`, `PARSER_MEDIA_TYPE`)을 쓰지 않는다. 고정 버전이 들어간 Monaco가 나오면 둘 다 뺀다.

## Mac 실기기 자동 키 이벤트 (2026-11-09)

macOS 26.5, Apple Silicon, 패키지 시험 앱(`9855a93` 기준 제품 코드, `open` 실행), macOS 한글 2벌식 입력기. System Events의 키 코드를 보내 **실제 OS 입력기를 거쳤고**, 결과는 시험 창 캡처로 판정했다. 사람이 친 입력이 아니며 조합 타이밍은 키 간격 90ms로 고정이다.

**결론: 이 범위에서 CodeMirror로 바꿀 이유는 나오지 않았다. Monaco를 유지한다.** 사람의 입력으로 보는 최종 확인은 [M.18](macos-readiness.md)의 실제 앱 항목에 남긴다.

| 항목 | 결과 |
|---|---|
| 받침, 받침 넘어가기 | `안녕 값이 닭을` 일치. 손실·중복·자모 잔류 없음 |
| 조합 중 왼쪽 화살표 | 조합이 확정되고 커서가 한 칸 앞으로 이동. `가나다`에서 `←` 뒤 `라` 입력으로 `가나라다` |
| 조합 중 `Cmd+S` | **저장 실행**(`저장 1회`), 글자 유지. 조합은 확정된다(이어 친 모음이 앞 받침으로 넘어가지 않고 `안ㅏ`). Windows textarea 경로와 다르다. 저장된 값에 조합 중 글자가 포함됐는지는 화면에서 읽을 수 없어 미확인 |
| TypeScript 진단 | 정의되지 않은 이름에 빨간 밑줄. 웹 워커 동작, 구문 강조 정상 |
| 10만 줄 | 열기, `PageDown`, `Cmd+↓`로 100000번째 줄 도달. 휠·스크롤바 끌기와 프레임 측정은 미실행 |
| diff | 좌우·한 줄 모두 삭제·추가 표시 정상 |
| 테마 전환 | Retro Blue Light ↔ Dark로 편집기·diff 색 반영 |

**미실행:** 일본어·중국어 입력기(이 Mac에 없음), Web Inspector의 CSP 오류, 아이콘 글꼴, 사람의 실제 타이핑.

Mac의 시험 앱은 Windows `--manual`과 달리 데이터를 격리하지 않고 제품과 같은 앱 데이터·웹 저장소를 쓴다. 시험 중 바꾼 테마는 원래대로 돌렸다.

## 수동 대기 (Windows)

실행: `node scripts/test-editor-native.mjs --manual`(빌드가 있으면 `--reuse-build` 추가). 격리된 데이터로 시험 창을 띄운다. 창이 뜨고 닫으면 끝나는 것까지만 확인했고 IME 입력은 하지 않았다.

- Microsoft 한글 IME: 받침·받침 넘어가기, 조합 중 화살표, 조합 중 Ctrl+S, 글자 잔류·중복
- Microsoft 일본어 IME, Microsoft 병음 입력기: 변환과 확정 각 한 번
