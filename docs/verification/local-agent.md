# 로컬·WSL 탭 키 제공 실측 (DX.13.0)

- 실행일: 2026-11-08. 설계: [developer-workflow DX.13.0](../design/developer-workflow.md#dx130--실측-게이트). 제품 코드는 바꾸지 않았다.
- 환경
  - Windows 11 Pro 10.0.26300
  - 기본 OpenSSH: `ssh.exe -V`는 `OpenSSH_for_Windows_9.5p2, LibreSSL 3.8.2`, `ssh.exe`·`ssh-add.exe` 파일 버전 9.5.6.4
  - Git for Windows 2.51.2(PortableGit 설치), 동봉 ssh는 `OpenSSH_10.2p1`
  - WSL2 Ubuntu 24.04(커널 6.18.33.2), WSL 안 git 2.43.0
  - Docker 28.5.1 Linux 엔진, 기존 `dachsterm-openssh-probe` 이미지(Debian 12, OpenSSH, git 2.39.5)를 진입점만 바꿔 SSH Git 서버로 사용
- 이 PC의 상태는 바꾸지 않았다.
  - `ssh-agent` 서비스: 실측 전후 모두 Stopped/Disabled
  - 전역·시스템 git의 `core.sshCommand`: 없음, 그대로
  - 사용자 `~/.ssh/known_hosts`: 검사 포트 항목 0건
  - Windows `ssh.exe`의 홈 폴더는 `USERPROFILE`·`HOME`으로 바뀌지 않았다(`ssh -G` 확인). 그래서 끝까지 가는 push는 `-F <빈 설정> -o UserKnownHostsFile=<scratch>`를 붙인 명령으로 했다.
- 임시 도구는 모두 세션 scratch에 두고 끝난 뒤 지웠다. 저장소에는 넣지 않았다.
  - agent 응답기(Node): 실행 중에 메모리에서 Ed25519 키를 만들고, 공개키 한 줄만 파일로 썼다. 요청 종류만 기록하고 `\\.\pipe\dachsterm-probe-<난수>`에서 수신했다.
  - ConPTY 실행기(Rust, `portable-pty 0.9.0`): 앱의 로컬 탭과 같은 방식이다. 시작할 때 오는 `ESC[6n`에 응답한다.
  - helper 두 개(Rust): `windows_subsystem = "windows"`인 것과 콘솔인 것. PE 하위 시스템 값은 각각 2와 3이다.

## 결과

| 질문 | 결과 | 처리 |
|---|---|---|
| Windows 기본 `ssh.exe`·`ssh-add.exe`가 `SSH_AUTH_SOCK`의 사용자 정의 named pipe를 쓰는가 | **쓴다.** `ssh-add.exe -l`이 임시 agent의 키를 보여주고, `ssh.exe` 로그인과 push가 그 pipe로 서명했다. 변수가 없으면 `Error connecting to agent`(서비스 꺼짐) | DX.13 Windows 방식 확정 |
| Git for Windows가 `GIT_SSH`로 Windows `ssh.exe`를 쓰고, `core.sshCommand`가 있으면 그것을 우선하는가 | **그렇다.** 우선순위는 `GIT_SSH_COMMAND` > `core.sshCommand` > `GIT_SSH`이다. 동봉 ssh는 pipe를 쓰지 못한다 | 설계대로 `GIT_SSH` |
| WSL2 git이 interop으로 Windows `ssh.exe`를 실행해 push하는가 | **한다.** WSL git 2.43.0이 `/mnt/c/.../ssh.exe`를 실행했고, pipe로 서명해 push했다 | WSL SSH를 후속으로 미루지 않는다 |
| `WSLENV`로 넘긴 `SSH_AUTH_SOCK`을 그 `ssh.exe`가 받는가 | **받는다.** 그러나 Linux 쪽에도 값이 생겨 Linux `ssh-add`가 실패한다. `WSLENV`에 넣지 않아도 interop 프로그램은 wsl.exe의 Windows 환경을 세션별로 상속하고, 이때 Linux 쪽은 비어 있다 | **설계 변경:** `SSH_AUTH_SOCK`은 `WSLENV`에 넣지 않는다 |
| `windows_subsystem = "windows"` 실행 파일을 WSL interop helper로 쓸 때 표준 입출력이 이어지는가 | **이어진다.** 표준 입력, 출력, 오류, 종료 코드, 1MiB 왕복, `git credential fill` 소비 모두 정상. 시작 시간 중앙값 18ms | 콘솔용 실행 파일은 필요 없다 |
| 자동 마운트 위치(`wsl.conf`의 `root`)를 바꾼 경우의 경로 변환 | 이 PC는 `[automount]` 설정이 없어 `/mnt/`. 설정을 바꾸지 않아 바꾼 경우는 **미검증**. `/p`는 마운트가 없는 경로에서 탭에 경고를 출력한다 | **설계 변경:** helper 경로는 실행 시 `wslpath -u`로 구한다 |
| Finder로 실행한 Mac 앱의 로컬 셸에 시스템 `SSH_AUTH_SOCK`이 있는가 | **대기(Mac)** | M.15에서 확인 |

## 1. Windows 기본 OpenSSH와 사용자 정의 pipe

PowerShell에서 `SSH_AUTH_SOCK=\\.\pipe\dachsterm-probe-<난수>`를 주고 실행했다.

| 명령 | 결과 | agent가 받은 요청 |
|---|---|---|
| 변수 없이 `ssh-add.exe -l` | `Error connecting to agent: No such file or directory`, 종료 2 | 없음 |
| `ssh-add.exe -l` | 임시 키 1개(ED25519) 표시, 종료 0 | `REQUEST_IDENTITIES` |
| `ssh-add.exe -D` | `Failed to remove all identities.`, 종료 1 | type 19(`REMOVE_ALL_IDENTITIES`), type 9(옛 RSA 전체 삭제). 둘 다 `FAILURE`로 답함 |
| `ssh.exe -F <빈 설정> -o UserKnownHostsFile=<scratch> -o BatchMode=yes -o IdentityFile=NONE` 로그인 | `login-ok`, 종료 0 | type 27(확장, session-bind), `REQUEST_IDENTITIES`, `SIGN_REQUEST flags=0` |

- `ssh.exe`는 서명 전에 type 27을 보낸다. 임시 agent가 `FAILURE`로 답해도 로그인은 계속됐다.
  - DX.11·DX.13 agent는 이를 `SUCCESS`로 받고 대상 호스트키를 기록한다(설계대로).
- `ssh-add -D`는 type 19와 type 9를 차례로 보낸다. 기존 필터처럼 둘 다 거부하면 된다.

## 2. Git for Windows의 ssh 선택

임시 저장소의 로컬 설정과 환경 변수만 썼다. 원격은 `ssh://probe@127.0.0.1:<포트>/home/probe/repo.git`이다.

| 조건 | 실행된 명령(`GIT_TRACE`) | 결과 |
|---|---|---|
| `GIT_SSH=%SystemRoot%\System32\OpenSSH\ssh.exe`만 | `'C:\WINDOWS\System32\OpenSSH\ssh.exe' -o SendEnv=GIT_PROTOCOL -p <포트> probe@127.0.0.1 'git-upload-pack ...'` | ssh 변형으로 인식했다(`-p`, `SendEnv`). 사용자 `known_hosts`에 없는 호스트라 호스트키 질문에서 콘솔 입력을 기다렸다. 답하지 않고 6초 뒤 종료했다(아래 4절) |
| `GIT_SSH`와 로컬 `core.sshCommand`(Windows `ssh.exe`, scratch known_hosts) | `core.sshCommand`의 명령 | push 성공(`* [new branch] HEAD -> main`). agent는 `REQUEST_IDENTITIES`, `SIGN_REQUEST`를 받았다 |
| 위 + `GIT_SSH_COMMAND=marker-...` | `marker-... -G -o SendEnv=GIT_PROTOCOL -p <포트> ...` | `GIT_SSH_COMMAND`가 둘 다 앞선다. 모르는 이름이라 `-G`로 변형을 조사했다 |
| 동봉 ssh(`ssh -F /dev/null ...`, `GIT_SSH` 없음) | 동봉 `usr/bin/ssh` | `Permission denied (publickey,keyboard-interactive)`. agent에는 연결이 열렸다가 바로 닫혔다. 동봉 `ssh-add -l`은 `Error connecting to agent: Bad file descriptor` |

결론
- 동봉 ssh(MSYS)는 Windows named pipe를 열기만 하고 agent 프로토콜을 주고받지 못한다. 그래서 `GIT_SSH`로 Windows `ssh.exe`를 지정해야 한다.
- `GIT_SSH`는 우선순위가 가장 낮아 사용자의 `GIT_SSH_COMMAND`, `core.sshCommand`를 덮지 않는다.
- `GIT_SSH`만으로 끝까지 가는 push는 하지 않았다. 사용자 `known_hosts`에 기록하게 되기 때문이다.
  - 같은 `ssh.exe`·pipe·agent로 `core.sshCommand` 경로의 push는 성공했다.
  - `GIT_SSH`가 그 `ssh.exe`를 올바른 인자로 실행하는 것도 확인했다.
  - 남은 차이는 명령 앞의 옵션뿐이다. 실제 탭에서 `GIT_SSH`만으로 하는 push는 DX.13 네이티브 검사에서 확인한다.

## 3. WSL2 git과 Windows ssh.exe

PowerShell에서 환경을 정하고 `wsl.exe -d Ubuntu-24.04`로 스크립트를 실행했다. 앱이 wsl.exe에 환경을 넘기는 상황과 같다.

| `WSLENV`와 `SSH_AUTH_SOCK` | Linux의 `SSH_AUTH_SOCK` | interop Windows 프로그램이 받은 값 |
|---|---|---|
| 목록에 없음 | 없음 | **wsl.exe의 값**. Linux에서 다른 값을 export하거나 지워도 그대로다 |
| `SSH_AUTH_SOCK/u` | pipe 경로 | wsl.exe의 값. Linux 값과 무관 |
| `SSH_AUTH_SOCK/w` | 없음 | Linux에서 export한 값만. 없으면 없음 |
| `SSH_AUTH_SOCK`(플래그 없음) | pipe 경로 | Linux 값. Linux에서 지우면 없음 |

- **세션 분리:** wsl.exe 두 개를 서로 다른 `SSH_AUTH_SOCK`(`tab-A`, `tab-B`)으로 동시에 띄웠다. 각 세션의 interop 프로그램은 자기 값을 받았다. 탭마다 다른 pipe를 써도 섞이지 않는다.
- **`WSLENV`에 넣지 않은 경우**
  - Linux `ssh-add -l`: `Could not open a connection to your authentication agent`. 원래와 같다.
  - `/mnt/c/.../ssh-add.exe -l`: 임시 키를 보여줬다.
  - WSL git의 push: `GIT_SSH_COMMAND`로 Windows `ssh.exe`를 쓰고 scratch known_hosts를 줬다. `* [new branch] HEAD -> wsl-inherit`, 종료 0이었고 agent는 `SIGN_REQUEST`를 받았다.
- **`WSLENV`에 `SSH_AUTH_SOCK`을 넣은 경우**
  - Linux에도 `\\.\pipe\...` 값이 생긴다.
  - Linux `ssh-add -l`이 `Error connecting to agent: No such file or directory`로 실패한다. 사용자가 WSL 안에서 쓰던 agent 설정을 가릴 수 있다.
  - push는 마찬가지로 성공했다.
- **`GIT_SSH`:** 이 값은 Linux git이 읽어야 하므로 `WSLENV`에 `GIT_SSH/up`로 넣었다.
  - `C:\WINDOWS\System32\OpenSSH\ssh.exe`가 `/mnt/c/WINDOWS/System32/OpenSSH/ssh.exe`로 바뀌었다.
  - git은 이것을 ssh 변형으로 실행했다: `-o SendEnv=GIT_PROTOCOL -p <포트>`.
- **문서 근거:** interop 프로그램이 `WSLENV`에 없는 변수를 상속하는 동작은 Microsoft 문서에 적혀 있지 않다. [WSLENV 소개 글](https://devblogs.microsoft.com/commandline/share-environment-vars-between-wsl-and-windows/)은 `WSLENV`에 넣는 방법만 설명한다. 그래서 DX.13 네이티브 검사의 합격 항목으로 둔다.

## 4. 처음 보는 호스트의 질문

- 콘솔 없이 띄운 wsl.exe(PowerShell 도구, `script` pty) 안에서 Windows `ssh.exe`는 호스트키 확인 단계에서 멈췄다.
  - `-v -E` 로그로 보면 known_hosts 조회 뒤 답을 기다렸다.
  - 질문은 Linux pty에 나오지 않았고, pty나 파이프 입력도 받지 않았다.
- **ConPTY로 띄운 wsl.exe는 다르다.** 앱 로컬 탭과 같은 `portable-pty` 방식이다.
  - 질문 전문(`The authenticity of host ... (yes/no/[fingerprint])?`)이 탭 출력에 나왔다.
  - `yes`를 입력하자 scratch known_hosts에 기록되고 접속해 agent 서명까지 갔다. 질문은 0.46초 뒤에 나왔다.
  - Windows 프로그램이 wsl.exe의 콘솔(ConPTY)을 쓰기 때문으로 보인다.
- PowerShell 탭의 `GIT_SSH` 경로도 같은 Windows 콘솔 질문을 쓴다. 2절 첫 줄이 멈춘 것은 콘솔이 보이지 않는 도구에서 실행했기 때문으로 본다. **ConPTY 안의 PowerShell 탭에서는 재지 않았다(추정).** DX.13 합격 항목에서 확인한다.
- Windows `ssh.exe`는 Windows 쪽 `~/.ssh/known_hosts`와 `~/.ssh/config`를 쓴다. WSL 안의 `~/.ssh`는 읽지 않는다.

## 5. GUI 하위 시스템 helper

WSL에서 직접 실행한 결과다. 시간은 20회 중앙값이다.

| | `windows_subsystem = "windows"` (PE 2) | 콘솔 (PE 3) |
|---|---|---|
| 표준 입력(37바이트 요청) → 표준 출력 | 그대로 | 그대로 |
| 표준 오류 | 그대로 | 그대로 |
| 종료 코드 3 | 3 | 3 |
| 1MiB 입력 왕복 | 1,048,610바이트 출력(입력 + 머리 34바이트) | 같음 |
| git `credential.helper`로 `credential fill` | `username` 반환, 종료 0 | 같음 |
| 시작 시간 (최소/중앙/최대) | 17 / **18** / 24ms | 29 / 30 / 35ms |

- 비교: `/bin/true`는 1ms, `cmd.exe /c exit`는 35ms(10회 중앙값)다.
- ConPTY 탭 안의 git이 GUI helper를 부른 경우도 확인했다. 값을 받았고, 직접 실행한 helper의 출력·오류·종료 코드가 탭에 그대로 나왔다.
- 측정한 helper는 150KB짜리 임시 파일이다. 앱 실행 파일은 크고 가져오는 DLL이 많아 더 느릴 수 있으므로, DX.14 구현 때 실제 앱으로 다시 잰다.
- 앱 `main.rs`는 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`이다.
  - release는 GUI(2), debug(`target/debug/dachsterm.exe`)는 콘솔(3)이다.
  - 두 경우 모두 helper로 동작한다.

## 6. 자동 마운트 위치와 경로 변환

- 이 PC
  - `/etc/wsl.conf`에 `[automount]`가 없다. `/proc/mounts`에서 `C:\`, `D:\`, `E:\`가 `/mnt/c`, `/mnt/d`, `/mnt/e`에 9p로 붙어 있다.
  - `wslpath -u 'C:\Windows'`는 `/mnt/c/Windows`, `wslpath -w /mnt/c`는 `C:\`다.
- `WSLENV`의 `/p` 변환
  - `C:\Program Files\DachsTerm\dachsterm.exe` → `/mnt/c/Program Files/DachsTerm/dachsterm.exe`
  - `D:\...\git.exe` → `/mnt/d/...`
- **`/p` 실패:** 마운트가 없는 `Z:\...`와 UNC `\\server\share\...`는 **`wsl: Failed to translate '<경로>'`를 표준 오류로 출력**하고 변수를 빼고 시작했다. 탭을 열 때마다 화면에 이 줄이 남는다.
  - pipe 경로 `\\.\pipe\x`를 `/p`로 넘기면 빈 값이 된다. `wslpath -u`도 실패한다. pipe 경로는 변환하지 않는다.
- **문서**
  - [wsl.conf](https://learn.microsoft.com/en-us/windows/wsl/wsl-config): `root`의 기본값은 `/mnt/`이고, `/windir/`로 바꾸면 `C:\`가 `/windir/c`에 붙는다. 설정은 배포판별이고, 그 배포판의 모든 셸이 끝난 뒤 약 8초 지나 재시작해야 적용된다.
  - [파일 시스템](https://learn.microsoft.com/en-us/windows/wsl/filesystems): `/p`는 "WSL/Linux 경로와 Win32 경로를 변환한다"고만 적혀 있다. `root`를 따른다는 문구는 없다.
- **미검증:** `root`를 바꾼 배포판에서 `/p`와 `wslpath`의 결과. 이 PC 설정을 바꾸지 않았다.
  - 두 변환은 모두 WSL 자신의 마운트 정보를 쓰므로 `root`를 따를 것으로 보인다. 확인한 사실은 아니다.
  - 그래서 설계는 `/mnt`를 가정하지 않는 방법을 쓴다. 실행 시점의 `wslpath -u`이고, 실패하면 helper가 조용히 빠진다.

## 대기

| 항목 | 이유 | 확인 위치 |
|---|---|---|
| Finder로 실행한 Mac 앱의 로컬 셸 `SSH_AUTH_SOCK` | Mac 실기기 필요 | 대기(Mac), M.15 |
| `wsl.conf` `root`를 바꾼 배포판의 `/p`·`wslpath` | 이 PC의 WSL 설정을 바꾸지 않음 | 사용자가 그런 배포판을 쓸 때 수동 확인 |
| 실제 앱 탭에서 `GIT_SSH`만으로 SSH push | 사용자 `known_hosts`에 기록하지 않으려고 명령 옵션 경로로 대신함 | DX.13 `test-local-native`. 사용자 `known_hosts`를 바꾸지 않는 방법은 DX.13에서 정한다 |
| 실제 앱 실행 파일의 helper 시작 시간 | 아직 helper 분기가 없음 | DX.14 구현 |
| WSL tmux 안에서, 처음 연 탭을 닫은 뒤의 interop | 측정하지 않음. 처음 탭이 닫히면 그 탭의 pipe도 사라진다 | DX.13 구현 때 안내서 범위 결정 |
