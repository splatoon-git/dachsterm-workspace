# 보안 점검 (2026-11-09)

- 대상: `17cc876` (`dev`), 커밋된 소스와 잠금 파일.
- 방법: 의존성·시크릿은 아래 명령을 실행했다. 소스는 코드 경로 추적이고, **실행으로 재현한 항목은 S.1뿐이다.** 나머지 항목의 Windows 동작은 Mac에서 코드만 읽었다.
- 상태: S.1~S.5와 S.10은 브랜치 `fix/s1-s5-security`에서 수정했다(아래 수정 결과). S.6~S.9, S.11은 열려 있다.

## 결론

의존성에서 출시 빌드에 들어가는 취약점은 0건이다. 소스에서는 High 1건(S.1), Medium 4건(S.2~S.5)이 나왔다. SSH 호스트키 검증, 비밀 보관, 경로 이탈, SQL, DOM 주입에서는 문제를 찾지 못했다.

## 의존성·공급망

| 검사 | 결과 |
|---|---|
| `npm audit --audit-level=low` | 0건 (`verify-macos.sh`) |
| `node scripts/audit-dependencies.mjs` (cargo-audit, Windows·macOS 그래프) | 차단 0건, 대상 밖 5건 |
| osv-scanner v2.2.3 (`package-lock.json`, `Cargo.lock`) | 5개 패키지. 위 대상 밖 5건과 동일 |
| gitleaks v8.28.0 (git 이력 165커밋, redact) | 3건 모두 `vendor/ssh-key` 문서·코드의 PEM 예시 |
| Cargo 출처 | 689개 모두 crates.io. 패치는 `vendor/ssh-key` 하나 |
| npm 출처 | 모두 npm 레지스트리, integrity 있음. 설치 스크립트는 `fsevents`뿐 |
| CSP | `script-src 'self'`, `object-src 'none'`, `frame-src 'none'` |

대상 밖 5건은 Linux 그래프에만 있다: `glib` 0.18.5(RUSTSEC-2024-0429), `proc-macro-error`(RUSTSEC-2024-0370), `zvariant`·`zvariant_derive`·`zbus_names`(RUSTSEC-2026-0370·0371·0372). Linux를 출시 대상에 넣으면 다시 봐야 한다.

GitHub Actions는 커밋 SHA가 아니라 태그(`@v4`)로 고정돼 있다. 권한은 `contents: read`다.

## 소스

| ID | 심각도 | 위치 | 내용 | 조치 | 근거 |
|---|---|---|---|---|---|
| S.1 | High | `git_run.rs` `SAFE_CONFIG`, `useGitStatus.ts`, `preferences.ts`(`gitStatus` 기본 켜짐) | 내려받은 폴더의 `.git/config`에 있는 `filter.*.clean` 프로그램이 로컬 Git 자동 조회에서 실행된다. 재귀 다운로드가 `.git`을 그대로 저장하고, 조회는 `cd`와 터미널 출력의 OSC 7/1337로도 시작된다. | `git config --local --includes --name-only --get-regexp '^filter\.'`로 이름을 읽어 `-c filter.<이름>.clean= -c filter.<이름>.process=`를 붙인다. 전역 설정의 LFS 필터는 끄지 않도록 저장소 범위만 읽는다. | **재현함.** 격리 저장소에서 일반 `git status`는 필터를 실행했고, 위 `-c`를 붙이면 실행하지 않았다. 재현 테스트 포함. |
| S.2 | Medium | `AgentLaunchDialog.tsx`, `lib/shell.ts`, `launch.ts`, `sftp.rs` | 서버의 폴더 이름에 든 제어 문자(`^U`, CR)가 "에이전트 시작…"의 프롬프트 입력에 그대로 들어가 서버 셸 명령이 된다. | 트리에서 고른 폴더에도 `folderProblem`과 같은 제어 문자 거부를 적용한다. | 코드 추적 |
| S.3 | Medium | `kube/log_stream.rs` `Reader::pending` | 개행 없는 출력을 보내는 서버가 앱 메모리를 고갈시킬 수 있다. `log_search.rs`에는 상한이 있다. | 일정 크기를 넘으면 스트림을 끊는다. | 코드 추적 |
| S.4 | Medium | `prompt_files.rs` `remove_old`, `russh-sftp` `read_dir` | EOF를 주지 않는 서버가 첨부 정리 중 메모리를 고갈시킬 수 있다. 전체 시간 제한이 없다. | 항목 수 제한과 전체 timeout. | 코드 추적 |
| S.5 | Medium | `preferences.ts`(UNC 허용), `integrations.ts`, `git_run.rs` | Windows 로컬 탭 출력의 OSC가 UNC 경로를 보고하면 자동 조회가 SMB 연결을 열어 NTLM이 나갈 수 있다. | `//`로 시작하는 경로는 수동 조회만 허용. | 코드 추적, Windows 미실행 |
| S.6 | Low | `promptAttachments.ts` | PowerShell 탭에 끌어 놓은 파일 이름의 `$()`가 Enter 뒤 실행된다. | 셸별 인용. | 코드 추적 |
| S.7 | Low | `agent_filter.rs`, `agent_relay.rs`, `AgentSignCard.tsx` | 서명 카드의 "로그인할 서버의 호스트키"가 검증되지 않은 서버 주장값이다. 승인 자체는 우회되지 않는다. | 서명과 session ID 검증 후에만 표시. | 코드 추적 |
| S.8 | Low | `integrations.ts`, `preferences.ts` | OSC 52 클립보드 쓰기가 기본 켜짐이고 알림이 없다. 읽기는 거부한다. | 기본 끄기 또는 쓸 때 알림. | 코드 추적 |
| S.9 | Low | `storage.rs`, `ssh/route.rs`, `ftp.rs` | 가져온 세션의 `keyPath`·`tlsCaPath`에 UNC가 허용돼 연결 시 Windows SMB 인증이 나갈 수 있다. | 가져오기에서 UNC 거부 또는 경고. | 코드 추적 |
| S.10 | Low | `sftp.rs` `list` | 항목 이름 길이 상한이 없어 20초 안에 큰 메모리를 쓸 수 있다. | 이름 4,096바이트 또는 누적 상한. | 코드 추적 |
| S.11 | Low | `editor.rs`, `local_files.rs`, `capabilities/main.json`, `commands.rs` | architecture-review B11이 그대로다. 프런트엔드가 준 프로그램 실행은 XSS가 전제이고, 현재 XSS 경로는 찾지 못했다. `connect`의 조기 반환에서 secret이 지워지지 않는다. | 저장된 편집기만 허용, 진입 첫 줄에서 `Zeroizing`. | 코드 추적 |

## 수정 결과

| ID | 수정 | 테스트 |
|---|---|---|
| S.1 | `git_run::git_read`가 저장소 범위(`local`, `worktree`)의 필터 이름을 읽어 `clean`·`process`를 비우고 `required=false`를 붙인다. 자동 조회 두 곳(`git_status::query`, `git_status::view::query`)만 쓴다. | `a_repositorys_own_filter_does_not_run_when_a_tab_shows_it`, `a_filter_that_cannot_be_turned_off_stops_the_query`, `only_a_repositorys_own_filters_are_turned_off`. 수정을 빼면 앞의 둘이 실패함을 확인했다. |
| S.2 | 트리에서 고른 폴더에도 `folderProblem`을 적용한다. | `agent-launch.spec.ts`의 제어 문자 폴더 |
| S.3 | 개행 없는 출력이 64KiB를 넘으면 버린다. 서버 스크립트가 줄을 3800바이트로 자르므로 정상 서버는 닿지 않는다. | `an_endless_line_cannot_grow_the_buffer` |
| S.4 | `remove_old`가 상한이 있는 `sftp::list`를 쓰고 삭제 전체에 10초 제한을 둔다. | `only_old_regular_files_of_this_module_expire`(만료 판정). 끝나지 않는 서버의 동작은 악성 SFTP 서버 fixture가 없어 미실행 |
| S.5 | `directoryFromOsc`가 Windows 탭에서 `\\`, `//`, `/\`, `\/`로 시작하는 경로를 거부한다. | `preferences.test.ts`. Windows 실행은 대기 |
| S.10 | `sftp::list`가 4,096바이트를 넘는 이름을 거부한다. S.4가 이 목록을 쓰게 되어 함께 고쳤다. | 없음. 악성 서버 fixture 필요 |

결정과 남는 동작:

- **스테이지, 커밋, 사용자가 연 diff는 필터를 그대로 쓴다.** 끄면 암호화 필터를 쓰는 저장소에서 평문이 커밋된다.
- **SSH 탭은 필터를 끄지 않는다.** 앱의 다운로드는 이 PC에 저장되고, 서버 폴더는 사용자의 셸 프롬프트도 같은 위험이 있다. 프롬프트마다 SSH 채널을 더 쓰는 비용도 있다. [user-guide](../user-guide.md)에 적었다.
- 필터를 끄고 읽으면 내용이 같은 파일이 변경으로 보일 수 있다.
- 이름에 `=`가 든 필터는 `-c`로 끌 수 없어 조회를 거부한다. 실험에서 그대로 실행됐다.
- Git 2.26 미만은 필터 범위를 읽을 수 없어 자동 조회를 하지 않는다(WSL·이 PC).
- Windows 탭에서 네트워크 공유로 `cd`하면 파일 패널이 따라가지 않는다. 경로를 직접 입력하면 열린다.

## 문제를 찾지 못한 영역 (코드 추적)

호스트키 검증(모든 연결이 `route.rs` 한 곳), 알고리즘, Vault(Argon2id, 임의 nonce, AAD), agent 소켓 권한, 세션 로그, 원격 이름의 경로 이탈, 압축 해제, 임시 파일, 원격 셸 인용과 인자 주입, 터널 바인딩(127.0.0.1), FTPS 인증서, PASV, SQL 매개변수, `innerHTML` 계열, Markdown 살균, 가져오기의 실행 필드.

읽지 않은 범위: `src/features/games`, `net_tools`의 세부.
