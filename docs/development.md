# DachsTerm 개발 가이드

개발 환경, 빌드, 검사 방법을 정리한다. 코드 작성 규칙은 [구현 규칙](engineering-rules.md), 알려진 구조 부채는 [아키텍처 리뷰](architecture-review.md)에 있다.

## 개발 환경

- Node 24 이상과 npm. `package-lock.json`으로 프런트엔드 버전을 고정한다.
- Rust 1.99.1. `rust-toolchain.toml`이 지정하며 설치는 [rustup](https://rustup.rs/)을 쓴다.
- Windows: Visual Studio C++ Build Tools, Windows SDK, WebView2.
- macOS: Xcode Command Line Tools. **이 저장소의 Mac 실행 결과는 아직 없다.**
- 실접속 검사: Docker의 Linux 컨테이너 엔진. 호스트 OpenSSH 서비스 설정은 바꾸지 않는다.

네이티브 요구 환경은 [Tauri 문서](https://v2.tauri.app/start/prerequisites/)를 참고한다. Windows에서 `cargo`를 찾지 못하면 먼저 PATH에 추가한다.

```powershell
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm ci
npm run tauri -- dev
```

## 실행과 빌드

| 명령 | 결과 |
|---|---|
| `npm run dev` | 브라우저 UI만 실행(포트 1420, 백엔드 없음) |
| `npm run tauri -- dev` | 네이티브 앱 개발 실행 |
| `npm run tauri -- build --debug --no-bundle` | 프런트엔드를 내장한 검사용 실행 파일(`target/debug/dachsterm.exe`) |
| `npm run tauri -- build --bundles nsis` | Windows 실행 파일과 설치 파일(`target/release/bundle/nsis/DachsTerm_<버전>_x64-setup.exe`) |
| `npm run tauri -- build --bundles app,dmg` | macOS 앱과 DMG(미검증) |
| `npm run icons` | `src/assets/brand` 원본에서 앱 아이콘 재생성 |

공개 배포에는 Windows 코드 서명과 macOS Developer ID 서명·공증이 필요하고, 별도의 자격증명과 실기기 검증이 있어야 한다. 개인 로컬 빌드와 서명된 공개 배포를 구분한다. 자동 업데이트 서비스는 아직 구성하지 않았다.

## 자동 검사

`./scripts/verify-windows.ps1`이 CI와 같은 검사 전체를 실행한다. `-Native`는 실제 앱 검사를, `-Package`는 설치 파일 생성과 설치 검사를, `-RequireSigned`는 서명 확인을 추가한다. 미해결 Cargo 보안 감사는 이 게이트를 실패시킨다.

개별 명령은 다음과 같다.

```text
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npx playwright install chromium    최초 1회
npm run test:ui
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

단일 테스트는 다음처럼 실행한다.

```text
npx vitest run src/features/terminal/snippets.test.ts
npx playwright test tests/ui/themes.spec.ts
cargo test -p dachsterm --lib --locked hostkeys
```

## 실환경 검사

| 명령 | 검사 내용 |
|---|---|
| `npm run probe` | 전용 OpenSSH 컨테이너로 인증, 호스트키, PTY 기반 동작 실증 |
| `npm run probe:phase1` | 제품 엔진을 실제 OpenSSH로 검사. 이름과 달리 Phase 2~4 검사도 포함 |
| `npm run test:native` | Windows 전용. 앱을 빌드하고 WebView2 UI로 실제 SSH에 접속 |
| `npm run probe:ftp` | FTP, FTPS, CP949 |
| `node scripts/run-ftp.mjs --reuse-build --native-only` | 빌드를 재사용한 FTP 네이티브 검사 |
| `node scripts/test-<기능>-native.mjs` | 개별 네이티브 검사. `target/debug/dachsterm.exe`가 먼저 필요 |
| `scripts/test-installer.ps1` | Windows 설치, 실행, 정상 종료, 제거. 기존 DachsTerm 설치가 있으면 중단 |

같은 EXE를 빌드와 테스트가 동시에 쓰면 잠금 오류가 난다.

### OpenSSH 실증(`npm run probe`)

Rust 실증기를 빌드하고 전용 Debian OpenSSH 컨테이너를 만든다. 호스트에는 `127.0.0.1`의 임의 포트만 공개한다. 비밀번호, 개인키, Passphrase는 실행마다 생성해 컨테이너 tmpfs와 검사 프로세스의 메모리·환경으로만 전달하며, 빌드 스크립트나 프런트엔드에는 전달하지 않는다. 호스트키는 Docker 제어 경로로 얻은 공개키와 대조하고, 잘못된 키의 거부를 따로 확인한다. 제품의 최초 신뢰 확인이나 `known_hosts` UI를 구현한 것은 아니다.

### 제품 엔진 검사(`npm run probe:phase1`)

앱이 쓰는 `src-tauri/src/ssh.rs`와 저장소를 직접 검증한다.

- **인증**: 비밀번호, RSA SHA-2(일반·암호화 OpenSSH, PEM, 암호화 PKCS8), agent, 키+PAM MFA, 일반·암호화 Ed25519
- **호스트키**: 거부, 변경, 폐기
- **연결**: 5개 동시 연결, PTY, UTF-8, resize, 흐름 제어, 취소, 재접속, 실제 OS 저장소
- **파일**: SFTP 바이너리·한글·공백 왕복, 권한, 외부 편집 충돌과 원자적 교체, CP949 변환, 128MiB 업로드 중 취소
- **기타**: Local·Remote·SOCKS5 왕복, Linux 지표

개인키 파일 읽기는 실행 중 만든 임시 디렉터리에서 검증하고 종료 시 삭제한다.

### 네이티브 UI 검사(`npm run test:native`)

내장 자산 앱을 빌드한 뒤 같은 OpenSSH에 WebView2 UI로 접속한다. 테스트 데이터와 WebView 프로필은 임시 디렉터리로 분리한다. 디버그 빌드에서만 `DACHSTERM_TEST_DATA_DIR`와 `DACHSTERM_TEST_CDP_PORT`를 지원하고 릴리스 빌드는 무시한다. 스크린샷은 `test-results-native/`에 생성된다. 한글은 xterm composition 이벤트를 자동으로 재현하며, 실제 Windows IME 키 조합 검증과는 다르다.

### FTP 검사

Python 가상환경에 `scripts/ftp-fixture-requirements.txt`를 설치한 뒤 실행한다. Windows 기본 경로는 `.tools/ftp-fixture/Scripts/python.exe`이고 `DACHSTERM_FTP_PYTHON`으로 바꿀 수 있다. 실행마다 임시 자격 증명, CA, loopback 서버를 만들고 종료 후 제거한다. 네이티브 검사는 디버그 앱 빌드가 먼저 필요하다.

### 남은 컨테이너 정리

검사가 끝나면 컨테이너와 테스트 파일·키를 삭제한다. 프로세스 강제 종료로 남았는지 확인하려면 다음을 실행하고, 남은 전용 컨테이너만 개별 ID로 정리한다. 다른 컨테이너나 볼륨은 삭제하지 않는다.

```text
docker ps -a --filter label=app.dachsterm.purpose=phase0-probe
docker ps -a --filter label=app.dachsterm.purpose=phase1-probe
```

## 테마 구조

새 테마는 정의 추가와 레지스트리 등록만으로 동작해야 한다.

| 위치 | 역할 |
|---|---|
| `src/themes/contract.ts` | 타입 계약. 필수 토큰 누락은 TypeScript 오류 |
| `src/themes/presets/light.ts` | 기본 크림색 테마 |
| `src/themes/presets/collection.ts`, `create.ts` | 추가 11개 정의 |
| `src/themes/registry.ts` | 제공 테마와 기본값 조회 |
| `src/themes/adapters/` | CSS 변수, xterm.js, 차트 변환 |
| `src/themes/store.ts`, `useTheme.ts` | 저장, 창 동기화, 기본값 복귀 |
| `src/themes/ThemePicker.tsx` | 키보드로 선택할 수 있는 미리보기 카드 |

모든 테마의 일반 글자 4.5:1, 포커스·입력 경계 3:1과 ANSI 대비를 테스트한다. 다크 테마의 ANSI black은 TUI 배경 위 검은 글자 용도로 유지한다. 네이티브 검사는 `node scripts/test-themes-native.mjs`다.

## 설계와 검증 기록

- **설계**: [docs/design/](design/), [docs/adr/](adr/)
- **세션 교환 형식**: [session-transfer.md](session-transfer.md), [session-format.schema.json](session-format.schema.json)
- **릴리스**: [Windows 안정화·복구 절차](verification/windows-hardening.md), [수동 검증 체크리스트](verification/windows-release-checklist.md)
- **제3자 고지**: [licenses/README.md](../licenses/README.md)

| 영역 | 기록 |
|---|---|
| 기반 실증 | [Windows](verification/phase-0-windows.md), [macOS 절차](verification/phase-0-macos.md) |
| SSH 터미널 | [Windows](verification/phase-1-windows.md), [macOS 절차](verification/phase-1-macos.md) |
| SFTP·터널·모니터링·안정화 | [Windows](verification/phase-2-5-windows.md), [macOS 절차](verification/phase-2-5-macos.md) |
| 인증·터미널 기본 동작 | [RSA·agent·MFA](verification/security-terminal-basics.md) |
| 폴더 전송·영속 큐 | [기록](verification/phase-6-1.md) |
| 스니펫·명령 모음·조작표 | [기록](verification/phase-6-2-6.md) |
| 세션 로그·PodTree | [기록](verification/phase63-67.md) |
| 점프 호스트·세션 이관 | [기록](verification/phase-6-jump-sessions.md) |
| 설정 UI | [기록](verification/settings-ui.md) |
| 테마 | [기록](verification/themes.md) |
| 제품명 변경 | [기록](verification/rename.md) |
| 서바이버 게임 | [영구 성장](verification/survivor-profile.md), [UI](verification/survivor-ui.md), [품질](verification/survivor-quality.md), [통합 검증](verification/survivor-validation.md) |

## 명명

제품명은 **DachsTerm**, 마스코트는 **Dachs**다. 패키지는 `dachsterm`, Windows 실행 파일은 `dachsterm.exe`, 앱 ID와 OS 보안 저장소 서비스명은 `app.dachsterm.desktop`이다. 2026-11-06 개명 이전의 개발 데이터는 이전하거나 호환하지 않고, 자동 삭제하지도 않는다. 과거 검증 기록의 산출물 경로와 해시는 당시 이름을 유지한다.
