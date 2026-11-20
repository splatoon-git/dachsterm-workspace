# 앱 업데이트 검증 (CG.6)

[roadmap §26](../roadmap.md#26-상용-제품-대비-보완-2026-11-16-사용자-요청--cg) CG.6의 실행 기록이다. 구현 요약과 남은 항목은 [progress](../progress.md)에 있다.

## 구성

- Rust의 `updates.rs`가 확인·내려받기·서명 검증·설치·재시작을 맡는다. 웹뷰에는 업데이터 플러그인의 명령 권한을 주지 않고 `update_status`, `update_auto_set`, `update_check`, `update_install`만 연다.
- 자동 확인은 시작 10초 뒤와 하루 한 번. 설정 값 `update.auto`(기본 켜짐)가 꺼져 있으면 백엔드가 자동 확인 요청을 무시하고, **지금 확인**은 항상 실행한다.
- 서명: `plugins.updater.pubkey`(minisign 공개 키)와 `requireSignedVersion: true`. 서명의 trusted comment에 기록된 버전과 `latest.json`의 버전이 다르면 설치하지 않는다. tauri-cli 2.12.4가 `version:<버전>`을 기록하는 것을 시험 서명에서 확인했다.
- 설치 순서: macOS는 새 번들로 교체한 **뒤에** 세션을 닫고(종료와 같은 `finish_sessions`) 인스턴스 잠금을 풀고 다시 시작한다. 교체가 실패하면 앱은 그대로 동작한다. Windows는 NSIS 설치기를 실행하기 직전(`on_before_exit`)에 세션을 닫고, 플러그인이 프로세스를 끝낸다.
- 저장소의 `pubkey`에 제품 서명 키의 공개 키를 넣었다(2026-11-20, 키 ID `8DA0581BD1E94937`). 개인 키는 사용자가 저장소 밖에 보관하고 저장소 시크릿으로만 CI에 준다([개발 가이드](../development.md#앱-업데이트-배포)). 공개 키가 빈 빌드는 업데이트를 확인하지 않는다.

## Mac 실기기 (2026-11-16, `52cb524` 위 `feat/cg6-updater` 미커밋 트리)

macOS 26.5(Apple Silicon). 저장소 키 대신 scratchpad의 일회용 시험 키를 썼고, 시험 키·암호는 기록하지 않았다. 사용자 데이터와 섞이지 않도록 식별자를 `app.dachsterm.updatetest`로 바꾼 설정 덮어쓰기로 빌드했다. 엔드포인트는 `http://127.0.0.1:8765/latest.json`(Python `http.server`, `dangerousInsecureTransportProtocol`)이다. 이 세 가지(키, 식별자, 엔드포인트) 말고는 제품 코드와 같다.

| 항목 | 방법 | 결과 |
|---|---|---|
| 시험 빌드 | `npm run tauri -- build --bundles app --config <0.5.1 덮어쓰기>`, `TAURI_SIGNING_PRIVATE_KEY=<시험 키> npm run tauri -- build --bundles app --config <0.5.2 + createUpdaterArtifacts>` | 0.5.1 `.app`(ad hoc 서명), 0.5.2 `DachsTerm.app.tar.gz`(22.42 MiB)와 `.sig` |
| 배포 파일 | `node scripts/update-release.mjs collect`·`manifest --base-url http://127.0.0.1:8765` | `DachsTerm_0.5.2_aarch64.app.tar.gz`, `latest.json`(`darwin-aarch64`). 공개 키가 빈 기본 설정으로 `collect`하면 거부 |
| 자동 확인 | 0.5.1을 `open`으로 실행 | 13:55:24 시작 → 13:55:38 `GET /latest.json`. 제목 줄에 `새 버전 0.5.2`, 누르면 설정 → 업데이트가 열리고 릴리스 노트·설치 버튼 표시(창 캡처) |
| **설치(사람 조작)** | 사용자가 `내려받아 설치`를 직접 누름 | 15:00:54 `GET /DachsTerm_0.5.2_aarch64.app.tar.gz` → 번들 `Info.plist` 0.5.2, 실행 파일 SHA-256이 0.5.2 빌드와 일치 → 15:01:07 다시 시작한 앱의 자동 확인 요청. 사용자 관찰: 앱이 저절로 다시 열림. 다시 연 앱의 설정에 현재 버전 0.5.2(창 캡처) |
| 교체된 번들 | `xattr`, `codesign --verify --deep --strict`, `spctl -a` | `com.apple.quarantine` 없음(`com.apple.provenance`만), ad hoc 서명 검증 통과, `spctl`은 서명 없는 앱이라 rejected. 격리 속성이 없어 Gatekeeper 확인 없이 실행됨 |
| 세션 정리 | 첫 시도(15:00:18 종료) 전 zsh 로컬 탭(PID 52854)을 열어 둠 | 종료 뒤 zsh 프로세스 없음. 이 종료는 설치 요청 없이 일어나 사용자가 창을 닫은 것으로 보이며, **설치 경로의 세션 정리는 별도로 확인하지 못했다** |
| 서명 불일치 거부 | `latest.json`을 `0.5.3`으로 바꾸고 0.5.2 파일·서명을 그대로 둠 | 15:08:11·15:35:21 내려받기 후 설치 거부. 앱 계속 실행, 번들 0.5.2·해시 그대로, 임시 폴더 남지 않음. 문구 "내려받은 파일의 서명이 맞지 않아 설치하지 않았습니다. 현재 버전은 그대로입니다." **같은 문구가 두 번 표시**되는 문제를 찾아 고쳤다(아래) |
| 자동 확인 끄기 | 설정에서 끔 → `update.auto=false` 저장 → Apple Event 종료 → `open` | 실행 뒤 43초 동안 서버 요청 0건. 다시 연 설정에서 스위치 꺼짐 유지. **지금 확인**은 요청을 보내고 `새 버전 0.5.3`을 표시 |

입력: 설치는 사람이 직접 눌렀다. 나머지 클릭은 사용자가 Mac을 쓰지 않을 때(HID 유휴 시간 확인) CGEvent로 보냈고 판정은 서버 기록, 프로세스, 디스크 내용, 창 캡처다. 사용자가 Mac을 쓰는 동안 보낸 자동 클릭은 앞 앱이 바뀌어 반영되지 않았다.

시험 뒤 고친 것(실제 앱에서 재실행하지 않음): 실패 문구 중복 제거(`separateError`, 단위 테스트), 안내 문구 "설치할 수 있는 새 버전: <버전>"(조사 문제), 설치 버튼을 `primary`로.

## 남은 확인

- **Windows NSIS 실제 설치**: 대기. 이 Mac에는 Windows 대상 Rust 표준 라이브러리도 없어 `#[cfg(windows)]` 경로(`on_before_exit`에서 세션 정리)는 컴파일조차 확인하지 못했다. Windows에서 `cargo clippy`로 컴파일을 확인하고, 위와 같은 방식으로 0.5.1 → 0.5.2 NSIS 설치(passive 설치 창, 다시 시작, 서명 없는 설치 파일의 SmartScreen 표시 여부)를 확인한다.
- macOS 설치 경로에서 열린 SSH·로컬 탭이 닫히고 세션 로그가 저장되는지(위 첫 시도는 사용자 종료로 보인다).
- 브라우저로 받은 DMG에서 처음 설치할 때의 Gatekeeper 확인(격리 속성 있음). 이 시험의 0.5.1은 로컬 빌드라 격리 속성이 없었다.
- ad hoc 서명이 바뀐 새 번들이 이전 버전이 저장한 Keychain 항목을 읽을 때 접근 확인 창이 뜨는지. 이 시험에는 저장한 인증정보가 없었다.
- `/Applications`처럼 관리자 권한이 필요한 위치에서의 설치(플러그인의 관리자 인증 경로), 디스크 이미지·App Translocation에서 실행할 때의 안내.
- 실제 GitHub 릴리스 엔드포인트와 제품 서명 키(사용자 결정 뒤).
