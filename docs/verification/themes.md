# T.1 — 다중 테마 구현 및 검증

날짜: 2026-11-04. 범위: 현재 화면을 기본으로 보존하면서 화이트·다크·레트로·터미널 컨셉 추가.

## 기존 구조 점검

기존 `ThemeDefinition`, 레지스트리, CSS/xterm/차트 어댑터와 열린 터미널의 `applyTheme`는 구현되어 있었다. 그러나 등록 테마는 하나, `useTheme`는 읽기/다른 창 storage 이벤트 수신만 제공했으며 설정에는 선택 기능이 없었다. 확장 기반은 있었지만 사용자가 바꾸는 기능까지 완성된 상태는 아니었다.

## 제공 테마와 참고 자료

공식 포트 인증이나 원본 팔레트의 완전한 복제는 아니다. 아래 자료의 색상 방향을 참고해 DachsTerm의 의미 토큰/컨트롤/차트/ANSI로 매핑했다. 외부 사이트/폰트/CDN에 런타임 의존하지 않는다.

| 테마 | 참고 자료와 구현 방향 |
|---|---|
| DachsTerm Classic | 기존 `pms-retro-light`의 크림색 표면·블루/머스터드와 마스코트 보존 |
| GitHub White / Dark | [GitHub Primer 색상 사용](https://primer-docs-preview.github.com/product/getting-started/foundations/color-usage/): 화이트/흑연색 표면, 블루 액션 |
| Dracula | [공식 색상/ANSI 명세](https://spec.draculatheme.com/): 보랏빛 배경, 퍼플/핑크/민트 |
| Nord | [공식 팔레트](https://www.nordtheme.com/docs/colors-and-palettes/): Polar Night/Snow Storm/Frost/Aurora 계열 |
| Catppuccin Mocha | [공식 저장소/팔레트](https://github.com/catppuccin/catppuccin): Mocha의 base/mantle/crust, 라벤더 파스텔 |
| Gruvbox Light / Dark | [공식 저장소](https://github.com/morhetz/gruvbox): 아이보리/숯빛, 올리브/머스터드/오렌지 |
| Solarized Light / Dark | [저자 공식 설명](https://ethanschoonover.com/solarized/): 아이보리/청록 바탕과 절제된 강조색 |
| Terminal Green / Amber | 클래식 인광 모니터 컨셉으로 직접 구성. [iTerm2 Color Schemes](https://github.com/mbadolato/iTerm2-Color-Schemes)의 터미널 팔레트 구성을 참고. ANSI 색상 구분은 보존하며 UI 기본 글자만 초록/앰버 계열 |

## 구현

- `src/themes/contract.ts`: 설명·분류·light/dark color-scheme 추가. 기존 의미 토큰 계약 유지.
- `presets/light.ts`: 이름을 DachsTerm Classic으로 변경하되 ID·기본값·크림색 표면 유지. 선택 배경 위 보조 텍스트가 4.495:1이던 미세한 부족을 보완하기 위해 `#606970` → `#5F686F`로만 보정. 기존 ANSI 값은 유지.
- `presets/create.ts`, `collection.ts`, `registry.ts`: 추가 11개 팔레트. CSS 변수/터미널/차트가 동일한 정의를 사용한다. 컴포넌트의 테마 ID 조건 분기는 없다.
- `ThemePicker.tsx`, `picker.css`: 미리보기 카드, 선택 표시, 네이티브 radio 키보드 이동, 현재 테마/자동 저장 상태. 3열/2열/1열 반응형 배치.
- `store.ts`, `useTheme.ts`, `main.tsx`: 동일 창 구독 알림, 다른 창 storage 변경 반영, 시작 전 토큰 적용, 저장 실패 알림, 알 수 없는 ID/삭제 시 기본 복귀. 저장 키 `dachsterm.theme` 유지. `adapters/css.ts`는 브라우저 기본 컨트롤에 color-scheme도 반영한다.
- `App.tsx`: 워크스페이스 설정에 선택 UI 연결. 기존 JSON 설정 백업과 배치 설정 유지. 로컬 테마 설정은 세션 JSON 내보내기에 포함하지 않는다.
- `Dialog.tsx`: 선택한 radio 우선 포커스, DOM 제거 전 닫기/기존 실행 버튼으로 포커스 복귀. 테마 선택 중 터미널을 재생성하거나 연결을 재시작하지 않는다.

## 대비와 ANSI 정책

- 12개 모두 기본/보조 텍스트와 상태 텍스트가 모든 기본 표면에서 4.5:1 이상, 입력 경계와 포커스는 3:1 이상. 액션/배지/선택 상태와 커서도 검사한다.
- 어두운 테마의 ANSI black은 black-on-color TUI를 위해 어둡게 보존한다. 이 항목을 제외한 ANSI 글자색은 터미널 배경에서 4.5:1 이상이다. 모든 테마의 black-on-green/blue/cyan도 4.5:1 이상이다.
- Gruvbox Light/Solarized Light의 짙은 종이색 표면에서는 위 두 ANSI 기준을 동시에 만족시키기 어려워 터미널 배경만 밝은 아이보리 `#FFFEFA`로 조정했다. 일반 UI의 원래 컨셉은 유지한다.
- 원본 팔레트의 일부 낮은 대비 색상(주석색/붉은 상태색 등)을 밝히거나 어둡게 보정했다. 서버가 직접 지정하는 truecolor, 256색 테이블, TUI 로직은 변경하지 않았다. 모든 가능한 전경/배경 조합의 대비를 보장한다는 뜻은 아니다.

## 실행 결과

- `npm test`: 전체 29개 통과(테마 계약/팔레트 14개 포함).
- `npm run typecheck`, `npm run lint`: 통과.
- `npx prettier --check src/themes src/main.tsx src/app/App.tsx src/components/Dialog.tsx tests/ui/themes.spec.ts tests/ui/layout.spec.ts scripts/test-themes-native.mjs`: 변경 파일 검사 통과.
- `npm run test:ui`: 전체 15개 통과. 테마 6개 검사에서 전체 팔레트 전환/기존 xterm DOM 유지/재로드, 여러 페이지의 실제 storage 동기화/새 창/삭제/알 수 없는 ID, 1280·560·360px 키보드와 넘침/포커스, 저장 실패를 확인. 기존 레이아웃·게임 회귀 검사 포함.
- `npm run build`: 통과. 메인 JS 약 680KB(압축 전)의 기존 500KB 번들 경고는 유지.
- `npm run tauri -- build --debug --no-bundle`: 통과. 내장 자산 Windows 실행 파일 `target/debug/daxterm.exe` 생성. Rust 소스는 이 테마 작업에서 수정하지 않았다.
- `node scripts/test-themes-native.mjs`: 종료 코드 0. 격리된 테스트 데이터의 실제 Windows WebView2 앱에서 12개 전환, 열린 xterm 객체 유지와 배경 동기화, Escape 포커스 복귀, **전체 앱 종료/재실행 후 Dracula 복원** 통과. 테스트 소유 앱은 종료했다.
- 실제 스크린샷: `test-results-native/themes.png`, `test-results-native/theme-<id>.png`. 테마 선택창/초록 터미널 실제 캡처를 시각 확인했다. 브라우저 좁은 창 캡처는 `test-results/theme-picker-<width>.png`.
- 초기 검사에서 발견한 보조 글자/ANSI 대비 부족과 설정창 포커스 소실은 수정 후 재검증했다. 기본값이 이미 선택된 radio의 `check()`는 change 이벤트를 발생시키지 않으므로 테스트는 다른 테마에서 기본값으로 돌아오는 실제 변경 흐름으로 보정했다.

## 미검증과 다음 행동

- 실제 SSH 연결 중 테마 전환과 **네이티브 SSH 분리 창**의 storage 전달은 이번 작업에서 실행하지 않았다. 브라우저 여러 페이지 동기화/네이티브 미리보기 결과를 실제 SSH 검증으로 대체하지 않는다. 다음 Windows 3.2/5.1 통합 검증에서 열린 SSH·분리 창을 유지한 채 12개 전환과 입력/출력·차트 반영을 확인한다.
- macOS는 실기기 부재로 미검증. 5.2에서 color-scheme/글꼴/대화상자/독립 창/복원을 확인한다.
- 설치 패키지는 다시 만들지 않았다. 기존 5.3 단계에서 최종 자산을 포함해 재생성/설치 검증한다.
- 기존 Phase 2~5, 파일/FTP/멀티 입력 및 게임 작업 상태는 별도 진행 기록을 유지한다. 이번 결과가 전체 Phase 완료를 뜻하지 않는다.

## 후속 Windows 통합 결과 (0.5.0, 2026-11-04)

`npm run test:native` 실제 OpenSSH 연결·독립 창에서 Terminal Green 전환, 다른 창 토큰/storage 동기화와 SSH 입력·출력 유지, Classic 복귀를 검증했다. 전체12개 팔레트 검사는 위 독립 검사와 구분한다. 최종 NSIS0.5.0에 테마/게임 자산이 포함되었고 설치·실행·정상 종료·제거 통과. Mac 검증 대기는 유지한다.

## T.2 레트로 팔레트 4종 (2026-11-08)

사용자가 지정한 6색 팔레트를 `presets/retro.ts`에 추가했다. 화면 컴포넌트는 고치지 않았고, 등록은 `registry.ts`뿐이다.

| 지정 색 | 쓰인 토큰 | 원본 그대로인가 |
|---|---|---|
| 배경 | `surface.app` (다크는 터미널 배경도) | 그대로 |
| 표면 | `surface.panel` | 그대로 |
| 메인 | `action.primary`, 포커스 링, 커서, 차트 1번 | 그대로 |
| 포인트 | `action.accent`. 다크는 `status.warning`, ANSI yellow, 차트 4번도 | 그대로. 라이트의 경고·ANSI는 같은 색조를 어둡게 |
| 서브 | 선택 배경과 경계선에 섞어 사용. Retro Dark는 ANSI magenta(차트 3번), Retro Blue Dark는 ANSI white로 원색 사용 | 라이트와 UI에서는 혼합 |
| 텍스트 | `text.primary`, 터미널 전경 | 그대로 |

대비 기준 때문에 파생한 값:

- 메인 위 글자(`onAction`): Retro Light는 `#1C100A`, Retro Blue Light는 `#000000`. 흰 글자는 각각 3.71:1, 4.33:1, 지정 텍스트색은 3.00:1, 2.16:1로 4.5:1에 못 미친다.
- 라이트 터미널 배경: 지정 표면(`#FFF9EE`, `#FFF9ED`)에서는 ANSI green·blue·cyan이 터미널 배경 4.5:1과 ANSI black 글자 4.5:1을 동시에 만족할 수 없어 Classic과 같은 `#FFFCF5`를 쓴다.
- Retro Light의 `surface.header`는 메인색 포커스 링 3:1을 지키는 범위에서만 어둡게 했다(`#F3E7D2`).

알려진 제한:

- `action.primary`가 작은 글자색으로도 쓰이는 곳(`.link-button`, 전송 실행 중 표시, 마크다운 외부 링크, Git 범위 버튼, 명령 강조)은 Retro Light 3.54:1, Retro Blue Light 4.13:1이다. 계약 테스트는 이 조합을 검사하지 않는다.

실행 결과(커밋 전 트리, Windows):

- `npx vitest run src/themes` 51/51, `npm run typecheck`, `npx eslint src/themes scripts/test-themes-native.mjs`, 바꾼 TS의 Prettier 통과.
- `npx playwright test tests/ui/themes.spec.ts` 6/6. 16개 전환, 기존 xterm 유지, 재로드, 창 간 동기화, 1280·560·360px 배치.
- `DACHSTERM_EXE=target/verification/debug/dachsterm.exe node scripts/test-themes-native.mjs` 종료 0. 실제 WebView2에서 16개 전환, 터미널 배경 동기화, Escape 포커스, 앱 재시작 후 복원. `tauri dev` 실행 중이라 별도 target에 빌드했다.
- 미실행: 전체 스위트, 실제 SSH 연결 중 새 테마 전환(테마 경로 변경 없음), Mac 실기기(WKWebView 표시는 대기), CI.

## T.3 토큰 결함 수정 (2026-11-08)

- `--shadow-popup`을 `foundations.shadow.popup`으로 정의했다. 정의가 없어 팝업 8곳의 `box-shadow`가 무효였다.
- `paste.css`의 `--color-text-muted`를 `--color-text-secondary`로 바꿨다. 계약에 없는 토큰이었다.
- (T.4에서 주요 액션색으로 변경) 사이드바 보기 탭의 선택 상태를 `action.accent` 채움과 `action.onAccent` 글자로 바꿨다. 포인트색을 밑줄로 쓰지 않은 이유는 일부 테마의 값이 표면 대비를 위한 색이 아니기 때문이다(GitHub White 1.14:1, Solarized Light 1.5:1). 계약이 검사하는 것은 `onAccent`와의 4.5:1이다. 선택 탭 hover에서 배경이 투명해지던 규칙도 선택 탭을 제외했다.
- 재발 방지: `src/themes/tokens.test.mjs`가 CSS·TSX의 테마 토큰 참조가 정의된 값인지 검사한다. 수정 전 9건(`--shadow-popup` 8, `--color-text-muted` 1)으로 실패함을 확인했다. Vitest가 CSS를 빈 모듈로 바꾸고 프로젝트에 Node 타입이 없어 디스크에서 읽는 `.mjs`로 두었고, `vite.config.ts`의 테스트 대상에 `.mjs`를 추가했다.

실행 결과(커밋 전 트리, Windows): `npx vitest run src/themes` 52/52, `npm run typecheck`, 바꾼 파일 eslint·Prettier, `npx playwright test tests/ui/themes.spec.ts` 6/6(16개 테마의 선택 탭 색과 hover 유지 포함).

미실행: 실제 앱 재검사(CSS와 토큰 값만 바꿨고 Playwright와 같은 Chromium 렌더링), 팝업 그림자의 픽셀 비교, 전체 스위트, Mac 실기기, CI.

## T.4 사이드바 선택 탭 색 (2026-11-08)

사용자가 Classic의 선택 탭이 머스터드로 보여 포인트인 레트로 블루와 다르다고 지적했다. roadmap §2.2는 선택·버튼·포커스를 주요 액션색으로, 머스터드(`action.accent`)를 배지·장식 강조로 정한다. T.3의 연결이 이 기준과 달랐으므로 Classic 색상값은 그대로 두고 탭을 `action.primary` 채움과 `text.onAction` 글자로 바꿨다. 탭 밑줄과 같은 색이 되며 16개 테마 모두에 적용된다.

그 결과 `--color-action-accent`, `--color-action-on-accent`를 쓰는 CSS는 다시 없다. 포인트색은 Retro Dark·Retro Blue Dark의 경고색과 ANSI yellow로만 화면에 나타난다. 배지 같은 소비처를 만들지는 사용자 결정 전까지 보류한다.

실행 결과(커밋 전 트리, Windows): `npm run typecheck`, 바꾼 파일 eslint·Prettier, `npx vitest run src/themes/tokens.test.mjs` 1/1, `npx playwright test tests/ui/themes.spec.ts -g "every theme"` 1/1(16개 테마의 선택 탭 색과 hover 유지 포함). Classic 스크린샷 시각 확인. 미실행: 전체 스위트, 실제 앱 재검사, Mac 실기기, CI.

## T.5 터미널 글자 대비 보정 (2026-11-09)

사용자가 agnoster 프롬프트의 검은 띠를 보고 테마가 터미널 기본 설정을 덮지 못하는지 물었다. 띠는 프롬프트가 지정한 ANSI black이고 색은 테마 값이 적용된 것이다(스크린샷은 Retro Dark로 보인다). 띠 자체는 그대로 두기로 했다.

실제 결함은 라이트 테마에 있었다. agnoster는 기본 글자색을 ANSI black 위에 그리는데, 라이트 테마 6종은 글자색이 어둡고 `black`이 `#000000`이라 대비가 1.33~2.24:1이었다(Classic 1.66). 테마의 ANSI 값은 터미널 배경 대비만 보장하므로 글자·배경을 프로그램이 따로 고르는 조합은 팔레트로 해결되지 않는다. 그래서 `src/themes/adapters/xterm.ts`의 `terminalColorOptions`로 xterm `minimumContrastRatio: 4.5`를 켜고 `session.ts`와 `TerminalPreview.tsx`가 함께 쓴다.

재현 테스트 `tests/ui/terminal-contrast.spec.ts`는 제품 `TerminalSession`으로 프롬프트와 같은 색을 그려 화면 색을 읽는다. 16개 테마에서 black 위 글자 4.5:1 이상, 일반 글자와 ANSI red는 테마 값 유지, Powerline 화살표는 보정 없이 black 유지를 확인한다. 수정 전에는 라이트 테마 6종이 실패했다.

실행 결과(macOS, `b343613` 기준 미커밋 트리): `npm run typecheck`, 바꾼 파일 eslint·Prettier 종료 0, `npx vitest run` 1204/1204(98개 파일). 새 테스트 Chromium 16/16, Playwright WebKit 16/16. Chromium 전체 Playwright 484 통과·1 실패. 실패 `session-form.spec.ts:45`는 제품 코드를 고치기 전 실행에서도 같은 값으로 실패했으며 원인은 확인하지 않았다. 포트 1420을 다른 세션의 개발 서버가 쓰고 있어 worktree 전용 서버(1431)로 실행했다.

미실행: 실제 앱 화면(이 경로에는 WKWebView 자동 검사가 없다), Windows, CI. WebKit 결과는 WKWebView 실기기 결과가 아니다. 256색 이상과 트루컬러 글자도 같은 보정을 받지만 별도로 측정하지 않았다.
