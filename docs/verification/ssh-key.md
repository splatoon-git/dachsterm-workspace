# SSH 키 만들기 검증 기록 (TL.3)

- 일자: 2026-11-08
- 대상: 브랜치 `feat/tl3-ssh-keygen`의 커밋 전 트리
- 환경: Windows 11 x64, 시스템 OpenSSH(`C:\Windows\System32\OpenSSH`), Docker `tests/openssh` 이미지의 sshd

## 합격 기준 결과

`npm run test:ssh-key`(`scripts/test-ssh-key-native.mjs`) 종료 0. `npm run tauri -- build --debug --no-bundle`로 만든 실제 앱을 WebView2 CDP로 조작했다. 키와 Passphrase는 실행마다 임시 폴더에 만들고 끝나면 지운다.

| 기준 | 방법 | 결과 |
|---|---|---|
| 기본값 표시 | 도구 → SSH 키 만들기 | `id_ed25519`, `…\.ssh`, `사용자@PC` 표시 |
| `ssh-keygen -y -f`가 읽음 | Passphrase 없음·있음 각각 실행해 공개키 비교 | 일치. 틀린 Passphrase는 거부 |
| 지문 일치 | `ssh-keygen -l -E sha256`, 완료 화면, 앱 `ssh_key_info` | 세 값 일치. 암호화 표시도 맞음 |
| 기존 파일 거부 | 같은 이름으로 다시 생성 | 오류 표시, 파일 내용 그대로 |
| 소유자 전용 ACL | `icacls` | 현재 사용자 1개, 상속 없음 |
| 실제 `ssh` 로그인 | `ssh.exe -i`로 Docker OpenSSH 접속, Passphrase는 `SSH_ASKPASS` | 두 키 모두 로그인 |
| ACL이 합격 원인인지 대조 | 같은 키를 상속 ACL(4개 항목)로 복사해 `ssh.exe -i` | 거부(`UNPROTECTED PRIVATE KEY FILE`) |
| 세션 폼 **새 키…** | 폼 안에서 생성 → 경로 입력됨 → 호스트 키 신뢰 → 연결 | 앱에서 `연결됨` |
| 암호화 키의 앱 로그인 | 폼에 경로와 Passphrase 입력 → 연결 | `연결됨`, 서버 셸 2개 |

키 폴더는 저장소의 `target/` 아래다. 이 드라이브는 Authenticated Users에 수정 권한을 상속하므로, 사용자 프로필 폴더보다 엄격한 조건이다.

스크립트는 처음 3번 실패했고 앱 쪽 원인은 없었다. ① 주석 단정: 기본값이 채워지기 전에 입력을 시작해 실패한 것으로 보이며(실제 값을 출력하지 않아 원인은 추정), 기본값을 기다리게 고친 뒤 재현되지 않았다. ② 빈 작업 공간의 자리표시 탭 때문에 탭 수 단정이 틀렸다. 세션 이름으로 찾게 고쳤다.

## 자동 검사

| 명령 | 결과 |
|---|---|
| `cargo test -p dachsterm --lib --locked ssh_key` | 8/8 (새 `ssh_keygen` 6건, 기존 `ssh_keys` 2건) |
| `cargo fmt --all --check` | 종료 0 |
| `cargo clippy -p dachsterm --all-targets --locked -- -D warnings` | 종료 0 |
| `cargo clippy … --target aarch64-apple-darwin` (C 컴파일러 대역) | 종료 0 ([macOS](#macos)) |
| `npm run typecheck`, 바꾼 파일 eslint·prettier | 종료 0 |
| `npx playwright test tests/ui/ssh-key.spec.ts` | 5/5 (마지막 수정 뒤에는 실패했던 1건만 재실행) |
| `npx playwright test tests/ui/session-form.spec.ts tests/ui/forward-keys.spec.ts` | 8/8 |

전체 Rust·Vitest·Playwright 게이트와 CI는 바꾼 범위만 검사한다는 작업 지시에 따라 실행하지 않았다.

## macOS

`cargo clippy -p dachsterm --all-targets --locked --target aarch64-apple-darwin -- -D warnings` 종료 0. Windows에서 C 컴파일러 대역으로 실행한 타입·린트 검사이며, `cfg(unix)` 분기가 컴파일된다는 것만 확인한다. 링크와 실행은 하지 않았다.

**대기(Mac 실기기):** 패키지된 앱에서 `0600` 권한, `~/.ssh` 자동 생성(`0700`), `/bin/hostname`으로 만든 기본 주석, OS 폴더 창, 실제 `ssh` 로그인. 위 네이티브 검사는 WebView2 전용이라 Mac에서 돌지 않는다. [macos-readiness](macos-readiness.md) M.21에 등록했다.

Windows OS 폴더 창(`ssh_key_pick_folder`)은 자동 검사가 조작할 수 없어 Playwright Mock으로 화면 연결만 확인했고 실제 창은 수동 확인 대기다.
