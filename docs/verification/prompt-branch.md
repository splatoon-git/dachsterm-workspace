# GE.11 터미널 안 브랜치 검증 기록

- 대상: 브랜치 `feat/ge11-prompt-branch`, 커밋 `61c2065`(`dev` 병합 전). 실행일 2026-11-08, Windows 11 빌드 26300.
- 설계: [git-editor.md GE.11](../design/git-editor.md#ge11--터미널-안-브랜치).

## GE.0 실측

### Bash·Zsh 함수 (`npm run probe:prompt-branch`)

Docker 안의 pty(`script -q -c`)에서 생성한 훅을 넣고, 각 명령 뒤 첫 프롬프트의 보고값을 읽었다. 앱을 거치지 않은 셸 단독 확인이다. 셸은 `bash:3.2`, `bash:4.4`, `bash:5.2` 이미지의 Bash와 `bash:5.2` 이미지에 apk로 설치한 Zsh이고, Bash 5.2와 Zsh는 `LANG=C`로도 돌렸다. 결과는 종료 0, PASS 85줄(6개 셸 × 14단계 + 요약 1줄), FAIL 0.

| 단계 | 보고값 |
|---|---|
| 저장소 밖 | 빈 값 |
| 커밋 전 저장소, 첫 커밋 뒤 | `main` |
| `git checkout -b feature/ge11`, 되돌아가기 | `feature/ge11`, `main` |
| 한글 브랜치, 하위 폴더 | `feature/한글`(`LANG=C`에서는 빈 값) |
| 분리된 HEAD | `@` + 7자 |
| linked worktree, submodule(상대 `gitdir`) | 그 브랜치 이름 |
| 제어 문자를 넣은 `.git/HEAD` | 빈 값, 출력에 해당 시퀀스 없음 |
| 줄바꿈 없는 HEAD | 이름을 읽음 |
| reftable의 `ref: refs/heads/.invalid` | 빈 값 |
| 대상이 없는 `.git` 파일 | 빈 값, 오류 문구 없음 |

모든 단계에서 보고가 `133;A`보다 먼저 왔다. 빈 값은 앱이 Git 조회 결과로 대신한다.

### 지연 (프롬프트 1회, 200회 반복의 평균)

| 위치 | Bash 3.2 | Bash 4.4 | Bash 5.2 | Zsh |
|---|---|---|---|---|
| 얕은 폴더, 저장소 없음(깊이 3) | 145µs | 120µs | 130µs | 85µs |
| 저장소 하위(깊이 5) | 225µs | 150µs | 140µs | 125µs |
| 저장소 없는 303단계 폴더(최악) | 61.9ms | 42.2ms | 27.7ms | 80.5ms |

`LANG=C`의 303단계는 Bash 5.2가 24.7ms, Zsh가 154.8ms다. 해당 실행은 `--timing`으로 했고, 그 뒤로 훅 문구는 바뀌지 않았다.

WSL Ubuntu-24.04 Bash(100회 평균): ext4 깊이 3은 70µs, 9p `/mnt/c` 깊이 6은 1.26ms, 9p `/mnt/e` 저장소 안 깊이 7은 3.23ms. 프로세스를 띄우지 않으므로 체감 지연은 없다고 판단했다.

### WSL ConPTY 커서 줄

`portable-pty` 0.9.0 임시 실행기로 앱의 `PROMPT_COMMAND`를 넣은 `wsl.exe`를 띄우고 원시 출력을 기록했다(임시 파일, 저장소에 없음).

- `1337;CurrentDir`, `777;DachsTerm;branch`, `133;A`가 모두 ConPTY를 통과하고, 이 순서로 프롬프트 글자보다 먼저 온다. 앞 명령의 출력(`seq 1 40`)도 OSC보다 먼저 끝난다.
- 두 줄 PS1, `clear`, 창 크기 변경(100→60열) 뒤에도 커서는 입력 줄에 있다.
- 프롬프트 끝 공백은 글자가 아니라 `CSI 1C`로 그려져 커서가 글자 끝보다 한 칸 뒤에 있을 수 있다. 줄 끝 계산은 글자 끝과 커서 중 큰 값을 쓴다.

## 앱 검사

| 명령 | 범위 | 결과 |
|---|---|---|
| `node scripts/run-phase1.mjs --native --agent-only --reuse-build` | 실제 앱, Docker OpenSSH Bash 5.2 | 종료 0, PASS 39줄 |
| `node scripts/test-local-native.mjs --git-only` | 실제 앱, PowerShell·WSL 탭 | 종료 0 |

SSH 탭에서 확인한 것: 배지 `⎇ main ●3`이 커서 줄의 오른쪽 끝에 있음, `git checkout -b` 뒤 첫 프롬프트에서 2초 안에 새 이름, 상태바가 3초 안에 따라옴(프롬프트 5초 간격이었다면 늦었을 시점), 분리된 HEAD, `sleep`·`less` 중 숨김, `PS1`이 같은 브랜치를 보여주면 숨김, 240자 입력에서 숨고 지우면 돌아옴, 터미널 글자에 `⎇` 없음, 설정 키 `off`에서 숨김, 저장소 밖에서 숨김. WSL 탭에서 확인한 것: 배지 내용, checkout 뒤 첫 프롬프트, 배지가 커서 줄에 있음.

실패한 실행과 원인:

1. 긴 줄 단계. 이 검사 흐름은 `stty -echo` 상태라 입력이 화면에 나오지 않는다. 그 구간만 `stty echo`로 켠 뒤 통과했다(검사 쪽 수정).
2. `group and profile` 단계의 `selectOption` 시간 초과 1회. GE.11과 무관한 코드 경로이고 앞뒤 실행에서 재현되지 않았다. **원인 미확인.**
3. DX.6의 fsmonitor 미실행 확인. GE.11 단계의 `git checkout`이 남긴 흔적 때문이라 단계 끝에서 지웠다(검사 쪽 수정).

첫 `tauri build`가 `tao`에서 E0463으로 한 번 실패했고, 같은 소스로 다시 빌드하니 성공했다. **원인 미확인.**

## 그 밖의 결과

- `dev` 병합 전 트리: `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test -p dachsterm --lib --locked local` 29건, eslint(`src/app`, `src/features/terminal`, `src/features/git`, 바꾼 스크립트) 통과.
- `dev` 병합 트리: typecheck, Vitest 5개 파일 55건 통과.

## 미실행

- 병합 트리의 네이티브 검사, 전체 게이트, CI.
- `verify-terminal-basics.mjs`: 저장된 설정 기대값에 새 키를 더했지만 `--agent-only` 경로에 없어 실행하지 않았다.
- 실제 앱의 Bash 3.2·4.4·Zsh 탭(훅 단독으로만 확인), `Ctrl+L`·두 줄 프롬프트·창 크기 변경에서 배지 위치(ConPTY 원시 출력과 코드로만 확인), 배지 클릭 새로 고침, 툴팁, 흐린 변경 수.
- **Mac 대기:** 로컬 탭(입력식 훅), macOS `/bin/bash` 3.2의 `[[:print:]]`와 한글 브랜치, 배지 위치. 실기기 결과 없음.
