# FV 그림·문서 미리보기와 기본 프로그램으로 열기 검증

- 범위: [roadmap §28](../roadmap.md#28-그림문서-미리보기와-기본-프로그램으로-열기-2026-11-18-사용자-요청--fv). 사용법은 [사용 안내서](../user-guide.md#그림과-문서-미리보기).
- 실행: 2026-11-20, Windows 11, 브랜치 `feat/fv-file-preview`(`dev` `9b99392` 위 커밋 전 트리).
- Mac에서는 아무것도 실행하지 않았다. 아래 결과를 Mac 결과로 쓰지 않는다.

## 구성

| 종류 | 그리는 방법 | 넣은 것 |
|---|---|---|
| PDF | `pdfjs-dist` 6.5.438 legacy 빌드, 워커 1개, 캔버스 | 문자 맵·표준 글꼴·ICC·디코더를 `dist/pdfjs/`에 복사(`scripts/vite-package-folders.mjs`). 스크립트 샌드박스(quickjs)는 뺌 |
| Word | `docx-preview` 0.4.1 (`jszip` 3.10.2) | 문서 내 글꼴·HTML 조각(`altChunk`)은 끔, 그림은 data URL |
| Excel | 직접 작성(`sheetModel.ts`) | 저장된 값, 날짜·시간·백분율 서식만. 시트당 1,000행 50열 |
| PowerPoint | 직접 작성(`slidesModel.ts`) | 슬라이드별 제목·글·표·그림. 배치는 읽지 않음 |
| 한글 | `@rhwp/core` 0.9.0 (WebAssembly 26.8MB, gzip 약 10MB) | 쪽을 SVG로 받아 `<img>`로만 표시 |
| 그림 | `<img>` | BMP·ICO 추가, 확대·축소 |

파일 종류는 Rust `file_read/format.rs`가 첫 바이트로 정한다. ZIP·복합 파일 형식은 확장자를 함께 본다. 문서는 32MiB까지 통째로 base64로 보낸다.

## 내용 정책(CSP) 변경

`script-src 'self'`에 `'wasm-unsafe-eval'`을, `connect-src`에 `'self'`를 추가했다.

- `'wasm-unsafe-eval'`: 한글 엔진의 WebAssembly 컴파일에 필요하다. JavaScript `eval`은 계속 막힌다.
- `connect-src 'self'`: 엔진 파일과 PDF 문자 맵을 앱 자신의 자산에서 `fetch`로 읽는 데 필요하다. 다른 출처로의 연결은 계속 막힌다.
- `frame-src 'none'`, `object-src 'none'`, `img-src 'self' asset: data:`는 그대로다. 문서 안의 바깥 그림과 글꼴은 불러오지 않는다.
- 근거는 CSP 규격이다. 두 항목을 뺀 빌드로 실패를 재현하지는 않았다. 넣은 빌드에서 거부 메시지가 0건인 것은 아래 네이티브 검사가 확인한다.

## 자동 검사

| 명령 | 결과 |
|---|---|
| `cargo fmt --all --check` | 종료 0 |
| `cargo clippy --workspace --all-targets --locked -- -D warnings` | 종료 0 |
| `cargo test -p dachsterm --lib --locked` | 771 통과, 9 무시 |
| `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` | 종료 0 |
| `npx vitest run src/features/editor src/features/sftp src/features/git src/app src/components src/lib src/themes` | 478 통과 |
| `npx playwright test`의 `file-preview`·`file-tab`·`local-files`·`edit-save`·`ui-consistency`·`layout`·`workspace`·`tools` | 137 통과 |
| `npx playwright test`의 `git-view`·`themes`·`local-files` | 56 통과 |
| `npx playwright test`의 `git-diff`·`themes`·`file-tab`·`file-preview` | 97 통과 |
| `node scripts/audit-npm.mjs` | 0건, 예외 0 |
| `node scripts/audit-dependencies.mjs` | 0건, 예외 1(`chrono`), 대상 밖 5 |
| `node scripts/generate-notices.mjs` | 553개, 원문 없는 항목 0 |

- 전체 Vitest와 전체 Playwright는 실행하지 않았다. 이 PC는 메모리가 적어 대상 범위만 돌렸다.
- 새 단위 시험: 파일 종류 판정(`format.rs`), 문서 통째 읽기(`file_read.rs`), 여는 프로그램 경계(`file_opener.rs`), 확대 단계(`zoom.test.ts`), ZIP 선언 크기(`zipEntries.test.ts`), 시트(`sheetModel.test.ts`), 슬라이드(`slidesModel.test.ts`).
- `tests/ui/file-preview.spec.ts` 16건은 Chromium에서 실제 라이브러리로 그린다: PDF 12쪽 중 보이는 쪽만 그리기와 확대, 깨진 PDF 안내, Word 쪽과 종이 색·링크 차단, 통합 문서 값과 시트 전환, 프레젠테이션 개요와 그림, 선언 크기 초과 거부, hwp·hwpx 쪽, 그림 확대와 깨진 그림 안내, 기본 프로그램 버튼.

## 실제 앱 (WebView2, 실제 내용 정책)

`npm run tauri -- build --debug --no-bundle`로 만든 `target/debug/dachsterm.exe`.

`npm run test:file-preview` (로컬 PowerShell 탭, 실제 `file_read`):

- PASS a PDF draws Korean text that needs a fetched character map: 글꼴이 들어 있지 않고 `UniKS-UCS2-H` 문자 맵을 쓰는 PDF의 한글이 그려진다.
- PASS 한글 files (hwp, hwpx) are laid out by the engine under the real policy
- PASS a Word document and a workbook are read from real files
- PASS a bitmap shows as a picture
- PASS the tab and the file menu hand a local file to the program for its type: 탭의 버튼과 파일 우클릭 메뉴. 연결 프로그램 자리에 기록용 대역(`DACHSTERM_TEST_OPENER`, debug 빌드 전용)을 썼다.
- PASS nothing a preview loaded was refused by the content policy: 콘솔의 CSP 거부 메시지 0건.

`npm run test:native:edit` (Docker의 실제 OpenSSH):

- PASS FV.2 a server file is fetched, marked as downloaded and handed to its program: `보고서.docx`를 받아 `working.docx`로 두고 `Zone.Identifier`(`ZoneId=3`)를 붙여 넘긴다.
- PASS FV.2 saving the fetched copy asks on the tab, uploads, and the edit closes clean
- 같은 실행에서 기존 외부 편집 GE.1·GE.6 단계도 모두 통과했다(`Editors::start` 시그니처 변경의 회귀 확인).

실제 연결 프로그램: `cargo test -p dachsterm --lib --locked file_opener -- --ignored`가 `연결 확인 %TEMP% & a.txt`를 Windows 셸에 넘겼고, 이 PC의 txt 연결 프로그램 창 제목에 그 이름이 그대로 나왔다(환경 변수 확장·명령 분리 없음). `open` 크레이트를 `shellexecute-on-windows`로 바꾼 결과다. 기본값은 `cmd /c start`라 경로의 `%이름%`이 확장된다.

## 확인하지 않은 것

- **실제 문서 표본.** 검사에 쓴 문서는 모두 검사용으로 만든 작은 파일이다. 실무에서 쓰는 복잡한 hwp·docx·pdf(표, 그림, 머리글, 세로쓰기, 암호)의 충실도는 보지 않았다. 사람이 실제 파일 몇 개를 열어 봐야 한다.
- **실제 오피스·한글 프로그램으로 열기.** 다운로드 표시 때문에 제한된 보기로 열리는지, **편집 사용** 뒤 저장이 업로드로 이어지는지, 프로그램이 파일을 잠근 순간의 저장 감지는 실행하지 않았다. 저장 감지는 2초마다 파일을 읽으므로, 프로그램이 파일을 교체하는 순간과 겹치면 편집 항목이 오류 상태가 될 수 있다(기존 외부 편집과 같은 동작).
- **확인 창.** 실행될 수 있는 종류를 열 때 뜨는 네이티브 확인 창은 자동 검사가 누를 수 없어 실행하지 않았다. 어떤 이름이 창을 거치는지는 단위 시험이 확인한다.
- **링크 열기.** `url_open`도 같은 크레이트를 쓰므로 Windows에서 `ShellExecuteExW`로 바뀌었다. 실제 앱에서 링크를 눌러 브라우저가 열리는지는 다시 보지 않았다.
- **구형 WebView2.** W.1의 100 버전 PC에서 PDF·한글 보기가 뜨는지 모른다. legacy 빌드를 썼지만 측정하지 않았다. 실패하면 안내와 **기본 프로그램으로 열기**가 나와야 한다.
- **큰 파일.** 32MiB 가까운 문서의 메모리와 시간, 수백 쪽 한글 문서의 첫 표시 시간(엔진이 창의 주 스레드에서 돈다).
- **설치 패키지 크기.** 한글 엔진이 약 10MB(압축 기준)를 더한다. NSIS 패키지를 만들어 재지 않았다.
- **Mac 전부.** WKWebView에서의 `zoom` CSS, WebAssembly, PDF 워커, `/usr/bin/open`으로 열기, quarantine 표시(`/usr/bin/xattr`), `verify-macos.sh`. [macos-readiness](macos-readiness.md#fv-그림문서-미리보기-2026-11-20) 참고.
- **고지.** `@rhwp/core`의 `notices/`(엔진에 든 제3자 고지)와 PDF 디코더의 `LICENSE_*`는 고지 생성기가 모으지 않는다. PDF 쪽은 `dist/pdfjs/wasm/`에 파일로 함께 실린다. 공개 배포 전 검토 대상이다.
- CI. `dev`에는 CI가 없다.
