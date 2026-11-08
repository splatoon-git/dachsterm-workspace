# HTTPS Git 자격 증명 전달 실측 (DX.12.0)

- 실행일: 2026-11-08. 제품 코드는 바꾸지 않았다. 앱 대신 OpenSSH 클라이언트의 원격 소켓 전달(`ssh -R <원격 소켓>:<로컬 소켓>`)과 임시 응답 프로그램으로 확인했다.
- 설계: [developer-workflow DX.12](../design/developer-workflow.md#dx12--https-git-자격-증명-전달-2026-11-08-추가). 이 기록의 결론은 설계안 DX.12 절에 반영했다.
- 비밀 취급: Git 서버 암호와 시험 토큰은 실행 중에 컨테이너나 격리 폴더에서 만들고 지웠다. 출력의 `password=` 줄은 모두 가렸다. 이 PC의 자격 증명 관리자에는 시험 호스트 항목이 0건임을 대상 이름만 읽어 확인했다(`cmdkey /list`).

## 환경

| 서버 이미지 | git | OpenSSH | tmux | git-lfs | `/bin/sh` |
|---|---|---|---|---|---|
| CentOS 7 | 1.8.3.1 | 7.4p1 | 1.8 | 없음 | bash 4.2 |
| Ubuntu 18.04 | 2.17.1 | 7.6p1 | 2.6 | 2.3.4 | dash |
| Ubuntu 20.04 | 2.25.1 | 8.2p1 | 3.0a | 2.9.2 | dash |
| Debian 12 | 2.39.5 | 9.2p1 | 3.3a | 3.3.0 | dash |
| Alpine edge (최신) | 2.56.0 | 10.6p2 | 3.8 | 3.8.1 | busybox ash |
| Debian 12 + systemd | 2.39.5 | 9.2p1 | 3.3a | - | dash |

- 서버 5종은 `UsePAM no`로 띄웠다(컨테이너에 systemd가 없다). `XDG_RUNTIME_DIR` 확인용 Debian 12는 systemd를 PID 1로 띄우고 `UsePAM yes`, `libpam-systemd`(systemd 252)를 썼다.
- 클라이언트: Alpine 3.22의 OpenSSH 클라이언트와 Python 응답 프로그램. 응답 프로그램은 요청 바이트와 EOF 도착 여부를 기록하고(비밀 키는 가림) 모드에 따라 자격 증명, 빈 답, 즉시 종료로 답한다.
- HTTPS Git 서버: [tests/git-https](../../tests/git-https/Dockerfile)(Gitea 1.24.6 rootless, Basic 인증, LFS, 자체 서명 인증서). 서버에서는 `GIT_SSL_NO_VERIFY=1`로 접속했다. 이 fixture는 DX.12의 `probe:phase1` 확장에 다시 쓴다.
- 이 PC: Windows 11, Git for Windows 2.51.2(PortableGit, `D:\Dev\tools\git\PortableGit`, `%ProgramFiles%\Git` 없음), Git Credential Manager 2.6.1(전역 설정 `credential.helper=manager`), git-lfs 3.7.1.

## 결과 요약

| 질문 | 결과 | 설계 처리 |
|---|---|---|
| 요청 형식과 응답 처리가 1.8~최신에서 같은가 | **같다.** `action=get`, `timeout=900`, 자격 증명 줄 순서이고 빈 줄 없이 끝난다. 그 뒤 쓰기 쪽을 닫아 EOF가 SSH 채널을 거쳐 응답 전에 도착한다. 클라이언트는 EOF까지 읽은 내용을 그대로 git에 넘긴다. git 2.56은 `capability[]=authtype`, `capability[]=state`를 더 보내고 git-lfs 3.8.1은 `wwwauth[]`를 보낸다. `path`는 `credential.useHttpPath`가 켜진 경우에만 온다 | 파서 하나로 처리. 모르는 키 무시 규칙 유지. 응답 뒤 채널을 닫아야 한다 |
| 연결 없는 소켓에서 `get`이 조용히 끝나고 다음으로 넘어가는가 | **그렇다.** 다음 네 경우 모두 종료 코드 0, 출력 0바이트이고 git은 다음 helper, 그다음 터미널 질문으로 넘어간다(5개 버전): 파일 없음, 남은 소켓 파일(받는 쪽 없음), 전달은 살아 있지만 클라이언트 쪽 연결 실패, 빈 답이나 즉시 종료 | 경로가 사라진 경우의 처리 불필요 |
| `GIT_CONFIG_PARAMETERS`에 덧붙인 `!` helper가 인용까지 맞고 기존 helper 뒤에 붙는가 | **그렇다(1.8~2.56).** 이전 형식 값(`'core.pager=less -R' 'user.name=a b'`)에 공백 하나로 덧붙여도 기존 값과 helper가 모두 해석된다. Bash 3.2.57, Bash 4.2, Zsh 5.9가 같은 값을 만든다(md5 일치). 호출 순서는 사용자 전역 helper → 우리 helper → 그 뒤 항목이다. **`store`·`erase`는 모든 helper에 전달되므로, 우리가 넘긴 값을 사용자의 기존 helper(`store` 등)가 받는다** | 1안 확정. 서버 helper 경고 추가 |
| sshd 기본값, 소켓 권한, 연결 종료 뒤 남는 소켓, `StreamLocalBindUnlink` | 5개 버전 모두 `AllowStreamLocalForwarding yes`, `StreamLocalBindMask 0177`(소켓 `srw-------`), `StreamLocalBindUnlink no`. **소켓 파일은 연결 종료 뒤에도, `cancel-streamlocal-forward` 뒤에도 남는다**(7.4, 9.2, 10.6). 파일이 남은 경로에 다시 전달하면 `remote port forwarding failed`. 서버가 `AllowStreamLocalForwarding no`나 `DisableForwarding yes`이면 같은 오류이고 셸은 계속 쓸 수 있다 | 종료 시 직접 삭제 유지. 소유자 확인 추가 |
| exec 환경의 `XDG_RUNTIME_DIR` | pam_systemd가 있으면 exec와 pty 모두 `/run/user/1000`(0700, 사용자 소유). 그 안에도 원격 소켓을 만들 수 있다. 다른 세션이 남아 있으면 소켓 파일도 남고, 마지막 세션이 끝나면 약 10초 뒤(`UserStopDelaySec` 기본값) 폴더째 사라진다. pam_systemd가 없거나 `UsePAM no`이면 값이 없다 | 소켓 위치 설계대로 |
| tmux `new-session -e`와 `set-environment` | **`new-session -e`는 1.8, 2.6, 3.0a에서 `unknown option -- e`로 명령 전체가 실패한다**(세션도 만들지 않는다). 3.3a, 3.8은 동작한다. `set-environment -t <세션>`은 1.8부터 모든 버전에서 이후 새 창·분할 패널에 적용된다. 새 tmux 서버는 그 서버를 띄운 클라이언트의 환경을 전역 환경으로 가지며, 이후 다른 세션의 패널도 그 값을 받는다. 이미 떠 있는 서버에 만든 새 세션의 첫 패널은 클라이언트 환경이 아니라 서버 전역 환경을 받는다. tmux 1.8은 `-t =이름` 정확 일치 대상을 지원하지 않는다 | tmux 처리 수정 |
| 이 PC의 `git credential fill`이 창 없는 프로세스에서 동작하는가 | 격리 HOME과 `store`: 저장된 값을 약 0.1초에 돌려준다. 값이 없으면 `GIT_TERMINAL_PROMPT=0`에서 즉시(0.1초) 128로 끝나고, 이 변수가 없어도 콘솔이 없어 멈추지 않고 128로 끝난다. **GCM 2.6.1(사용자 승인 후)**: 로그인 창을 띄우고 입력값을 돌려준다(종료 0). 취소하면 `User cancelled dialog`로 128. 이름이 확인되지 않는 호스트는 창을 띄우기 전에 0.6초 만에 실패한다. macOS 키체인은 **대기(Mac)** | 이 PC 쪽 출처 설계대로 |
| Git LFS가 같은 helper를 쓰는가 | **쓴다.** git-lfs 2.3.4, 2.9.2, 3.3.0, 3.8.1에서 LFS 객체 push와 clone이 같은 helper로 성공했다(서버에 객체 4개). **LFS push 한 번에 `get`이 3번(git 1, LFS 2), clone에 2번 온다.** 서버가 계속 401을 주면 git-lfs 2.9.2는 `get`·`erase`를 끝없이 반복한다(약 4분 30초에 `get` 1만 회 이상) | 카드 반복·폭주 대비 추가 |

## 상세

### 요청 형식

응답 프로그램이 받은 요청(5개 버전 동일, `password` 없음):

```text
직접 호출  : action=get / timeout=900 / protocol=https / host=git.test / path=probe/r.git / username=probe
git push  : action=get / timeout=900 / protocol=https / host=git.test:3000
git 2.56 + git-lfs 3.8.1 : action=get / timeout=900 / capability[]=authtype / capability[]=state / protocol=https / host=git.test:3000 / wwwauth[]=Basic realm="gitea-lfs"
```

- 매 요청은 EOF가 응답보다 먼저 도착했다(`eof_before_reply: true`). 클라이언트는 요청을 보낸 뒤 쓰기 쪽만 닫고, SSH가 이를 채널 EOF로 전달한다.
- `capability[]=authtype`이 없는 응답(`username`, `password`만)으로도 git 2.56의 push가 성공했다.
- 서버에 실제 캐시 데몬을 띄운 경우, git 2.56 데몬은 응답에 `capability[]=authtype`을 넣는다. 앱의 응답에는 필요 없다.

### store와 데몬

- 우리 helper(`get`만 전달)로 `git credential approve`·`reject`를 해도 데몬은 0개였다(5개 버전).
- 원래 `credential-cache store`를 받는 쪽 없는 경로에 보내면, 그 경로의 폴더 권한에 따라 결과가 다르다.
  - `/tmp`: 데몬이 `The permissions on your socket directory are too loose`로 뜨지 않고 128로 끝난다.
  - 0700 폴더(예: `XDG_RUNTIME_DIR`): **데몬이 뜨고 암호를 서버 메모리에 캐시한다**(5개 버전). 이후 같은 경로의 `get`이 그 값을 돌려준다.
- 따라서 `store`를 소켓으로 보내지 않는 규칙이 필요하다.

### 기존 helper 순서

사용자 전역 설정에 기록용 helper를 두고 `GIT_CONFIG_PARAMETERS`에 우리 helper와 그 뒤 기록용 helper를 덧붙인 결과다(5개 버전 동일).

| 단계 | 호출 순서 |
|---|---|
| 응답이 자격 증명 | 사용자 `get` → 우리 `get`(값 받음, 이후 `get` 없음) |
| 응답이 빈 답 또는 즉시 종료 | 사용자 `get` → 우리 `get` → 그 뒤 helper `get` → 터미널 질문 |
| `approve` | 사용자 `store` → 우리 `store` → 그 뒤 helper `store` |
| `reject` | 사용자 `erase` → 우리 `erase` → 그 뒤 helper `erase` |

git 1.8에는 `GIT_TERMINAL_PROMPT`가 없어 `/dev/tty`를 열려다 `No such device or address`로 끝난다(pty가 있으면 터미널에서 묻는다).

### 원격 소켓

| 확인 | 결과 |
|---|---|
| 소켓 권한 | `srw-------`, 사용자 소유(5개 버전, `/tmp`와 0700 폴더 모두) |
| 연결 종료 뒤 | 파일이 남는다(5개 버전). 그 파일에 `get`은 종료 0, 출력 0바이트 |
| `cancel-streamlocal-forward` 뒤(`ssh -O cancel`) | 파일이 남는다(7.4, 9.2, 10.6). `get`은 출력 0줄 |
| 남은 파일 경로로 다시 전달 | `Error: remote port forwarding failed for listen path ...`(`StreamLocalBindUnlink no`) |
| `AllowStreamLocalForwarding no`, `DisableForwarding yes`(9.2) | 같은 오류. `ExitOnForwardFailure` 없이 접속하면 셸은 계속 동작하고 파일은 생기지 않는다 |
| 소유자 확인 | `[ -S <경로> ] && [ -O <경로> ]`가 bash 4.2, dash, busybox ash에서 내 소켓은 참, root 소유 파일은 거짓. 이 조건을 넣은 helper 값으로 `fill`이 5개 버전에서 동작하고, 남의 소유 경로에서는 다음 단계로 넘어간다 |

### XDG_RUNTIME_DIR (Debian 12 + systemd 252)

- exec 채널과 pty 모두 `XDG_RUNTIME_DIR=/run/user/1000`, 권한 700, 사용자 소유였다.
- 다른 세션 없이 접속해도 `ssh -R`로 그 폴더 안에 소켓이 만들어졌다. OpenSSH 클라이언트는 세션 채널보다 전달 요청을 먼저 보낸다.
- 같은 사용자의 다른 세션이 남아 있으면 소켓 파일이 남는다. 마지막 세션이 끝나면 폴더가 사라진다(12초, 20초 뒤 확인).
- 설정은 `KillUserProcesses=no`, `UserStopDelaySec=10`(주석 처리된 기본값)이다.

### tmux

각 버전에서 독립 서버(`tmux -L`, `-f /dev/null`)로 확인했다. 표의 값은 새 패널이 받은 변수 값이다.

| 경우 | 1.8 | 2.6 | 3.0a | 3.3a | 3.8 |
|---|---|---|---|---|---|
| 새 서버를 띄운 클라이언트의 값(첫 패널, 이후 창) | 적용 | 적용 | 적용 | 적용 | 적용 |
| 떠 있는 서버에 다른 값의 클라이언트가 만든 새 세션 첫 패널 | 서버 값 | 서버 값 | 서버 값 | 서버 값 | 서버 값 |
| `new-session -d -s c -e K=V` | 실패(`unknown option -- e`) | 실패 | 실패 | 적용 | 적용 |
| `-e` 실패 시 `-e` 없이 생성한 뒤 `set-environment` | 세션 1개, 값 적용 | 같음 | 같음 | `-e` 성공 | - |
| `set-environment -t b` 뒤 새 창 | 적용 | 적용 | 적용(`-t b:`) | 적용 | 적용 |
| `set-environment -t b` 뒤 분할 패널 | - | - | 적용 | - | - |
| `-t =b` | `session not found` | 동작 | 동작 | 동작 | 동작 |

- 3.0a의 `new-window -t b`는 `create window failed: index 0 in use`로 실패했고, `-t b:`로는 동작했다. 대상 해석 차이다.
- 세션 `work2`만 있을 때 `has-session -t work`는 성공한다(1.8, 3.0a, 3.8, 접두사 일치). `list-sessions -F '#{session_name}' | grep -qx -- work`는 없음으로 판별한다. `work`를 만든 뒤 `set-environment -t work`는 `work`에만 적용됐다(정확한 이름 우선).
- 3.1과 3.2는 측정하지 않았다.
- 부수 발견: DX.7의 일회성 시작 명령은 `has-session -t '=work'`와 `attach-session -t '=work'`를 쓴다(`terminal_start.rs`). tmux 1.8에서는 이 대상을 찾지 못하므로 시작이 실패할 것으로 보인다. 앱으로는 확인하지 않았고, 이번 범위에서 코드를 바꾸지 않았다.

### HTTPS push와 LFS

| 서버 | push | helper 호출(push) | LFS push | helper 호출(LFS push) | LFS clone |
|---|---|---|---|---|---|
| CentOS 7 (git 1.8.3.1) | 성공 | get 1, store 1 | git-lfs 없음 | - | - |
| Ubuntu 18.04 (2.17.1, lfs 2.3.4) | 성공 | get 1, store 1 | 성공 | get 3, store 4 | 성공, 포인터 파일로 받음(clone 쪽에 LFS 필터 없음) |
| Ubuntu 20.04 (2.25.1, lfs 2.9.2) | 성공 | get 1, store 1 | 성공 | get 3, store 3 | 성공(get 2), 4096바이트 |
| Debian 12 (2.39.5, lfs 3.3.0) | 성공 | get 1, store 1 | 성공 | get 3, store 3 | 성공(get 2), 4096바이트 |
| Alpine edge (2.56.0, lfs 3.8.1) | 성공 | get 1, store 1 | 성공 | get 3, store 3 | 성공(get 2), 4096바이트 |

- Git 서버에는 4096바이트 LFS 객체가 4개 생겼다(LFS가 있는 4개 서버).
- 첫 시도는 LFS pre-push가 push로 저장소가 생성되기 전에 객체를 올려 서버가 계속 401을 돌려줬다. 그때의 결과는 다음과 같다.
  - git-lfs 2.9.2: `get` 10,841회, `erase` 10,838회를 반복했다(4분 26초).
  - git-lfs 2.3.4: `get` 3회 뒤 `erase`만 22,986회 반복했다.
  - 2.3.4의 반복은 우리 helper 없이 일반 `store` helper로도 같았다(60초 제한으로 종료). 우리 방식이 아니라 이 상황의 git-lfs 동작이다.
- 저장소를 먼저 만든 뒤에는 위 표처럼 정상이었다.

### 이 PC의 git credential fill

앱처럼 콘솔 창 없이(`CreateNoWindow`, 표준 입출력 파이프) 실행했다.

| 경우 | 결과 |
|---|---|
| 격리 HOME(`HOME`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL`, `XDG_CONFIG_HOME`)과 `store --file`, 저장된 호스트 | 종료 0, 96ms, `username`·`password` 반환. `path`와 `username`을 줘도 같다 |
| 같은 환경, 값 없음, `GIT_TERMINAL_PROMPT=0` | 종료 128, 94ms, `terminal prompts disabled` |
| 같은 환경, 값 없음, `GIT_TERMINAL_PROMPT` 없음 | 종료 128, 128ms. 콘솔이 없어 질문 스크립트가 `/dev/tty`를 열지 못한다. 멈추지 않는다 |
| GCM, `GCM_INTERACTIVE=never`, 없는 호스트(`dachsterm-probe.invalid`) | 종료 128, 623ms. 창 없음. GCM은 공급자를 알아내려고 호스트에 HTTP 요청을 먼저 보내고, 이름 확인 실패로 끝난다 |
| GCM, 대화형 허용, 같은 호스트 | 종료 128, 561ms. 같은 이유로 창 없음 |
| GCM, 대화형 허용, 이 PC 안의 401 Basic 시험 서버(`http://127.0.0.1:18081`, `GCM_ALLOW_UNSAFE_REMOTES=true`) | **로그인 창이 떴다.** 사용자가 취소하자 `fatal: User cancelled dialog.`, 종료 128(30.4초) |
| 같은 경우, 사용자가 가짜 값 입력 | 종료 0(6.3초), `username`·`password` 반환 |

- 시험 호스트로 저장된 자격 증명은 0건이었다. `approve`를 부르지 않았다.
- 이 세션의 환경에는 `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`가 들어 있어 시험마다 자식 환경에서 명시적으로 지정·제거했다. 앱이 이런 환경을 물려받으면 GCM 창이 뜨지 않는다.
- PowerShell 5.1의 `Process.StandardInput`은 첫 바이트에 BOM을 넣어 git이 `missing protocol field`로 거부했다. 시험 도구의 문제이고, 앱은 Rust `Command`라 해당하지 않는다.
- 창 감시 작업(프로세스 이름에 `credential`, `gcm`이 들어간 창)은 GCM 창을 찾지 못했다. 창 표시는 GCM의 출력과 사용자 조작으로 확인했다.

## 대기

| 항목 | 이유 |
|---|---|
| macOS 키체인의 `git credential fill`(창 없는 Finder 앱 프로세스), `/usr/bin/git` 설치 창 | 대기(Mac). Mac 실기기 필요. M.15에 추가 대상 |
| 실제 호스팅(GitHub, GitLab.com, Bitbucket)의 GCM 로그인 창 | 사용자의 실제 자격 증명을 건드리므로 이번 실측에서 하지 않았다. DX.12 수동 합격 항목 |
| tmux 3.1, 3.2의 `new-session -e` | 해당 버전 이미지를 쓰지 않았다. 설계는 실패 시 대체 명령을 써서 버전에 의존하지 않는다 |
| WSL 경로 | DX.13.0 범위 |

## 재현

- 서버 이미지와 응답 프로그램, 검사 스크립트는 저장소에 넣지 않았다(실측용 임시 파일).
- 서버는 distro 패키지의 `openssh-server git tmux git-lfs`에 사용자 `probe`(공개키만)를 둔 이미지다. 클라이언트 키는 컨테이너 시작 시 만들었다.
- HTTPS Git 서버는 `docker build -t dachsterm-git-https tests/git-https`로 만들어 Docker 네트워크에 `--network-alias git.test`로 띄운다.
- 컨테이너, 네트워크, 시험 저장소는 실행 후 제거했다.

## DX.12 구현 검증

- 실행일: 2026-11-08, 브랜치 `feat/dx12-git-credentials`, 기준 `24cbbb7` 위 미커밋 트리. 설계에 반영한 결정은 [설계안 DX.12 "구현에서 정한 것"](../design/developer-workflow.md#dx12--https-git-자격-증명-전달-2026-11-08-추가)에 있다.
- 비밀 취급: Git 서버 암호는 컨테이너가 만들고 검사 프로세스 환경에만 둔다. 출력에는 값이 나오지 않는다(셸은 `stty -echo`, 값은 파일로만 받는다). 이 PC 쪽 git은 격리 폴더(`HOME`, `XDG_CONFIG_HOME`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`)와 `store` helper로만 실행했다. 사용자의 자격 증명 관리자에는 묻지 않았다. 앱이 OS 저장소에 쓴 시험 항목은 검사가 지우고 지워졌음을 확인한다. 끝난 뒤 `cmdkey /list`에 `git.test` 대상은 0건이었다.

### 자동 검사

| 범위 | 명령 | 결과 |
|---|---|---|
| Rust 단위 | `cargo test -p dachsterm --lib --locked -- git_credential terminal_start storage settings vault` | 45 통과 |
| Rust 정적 | `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings` | 통과 |
| 프런트엔드 | `npm run typecheck`, 바꾼 파일 eslint·prettier | 통과 |
| Vitest | `agentSign`, `shellHook`, `inputQueue`, `SessionTab`, `sessions/model` | 5파일 28건 통과 |
| Playwright | `git-credential.spec.ts`(새 카드) 9건, 설정 창·세션 폼을 여는 `agent-launch`·`session-form` 11건 | 통과 |
| 실제 프로토콜 | `node scripts/run-phase1.mjs`(= `npm run probe:phase1`) | 종료 0, PASS 60줄(자격 증명 8줄) |
| 버전별 서버 | `node scripts/run-phase1.mjs --git-versions-only` | 종료 0, 서버 4종 PASS |
| 네이티브 | `node scripts/run-phase1.mjs --native --agent-only --reuse-build` | 종료 0, PASS 36줄(자격 증명 5줄) |

### 실제 프로토콜 (Docker)

`tests/openssh`(Debian 12, git 2.39.5, tmux 3.3a, git-lfs)와 `tests/git-https`(Gitea, Basic 인증, LFS)를 검사용 Docker 네트워크에서 `git.test`로 붙였다. fixture에 `XDG_RUNTIME_DIR`(사용자 소유 0700), root 소유 소켓 `/tmp/dachsterm-git-rootowned`, 소켓 전달을 막은 MFA 서버(`AllowStreamLocalForwarding no`)를 더했다. 검사 코드는 `src-tauri/examples/credential_checks/`다.

| 확인 | 결과 |
|---|---|
| 소켓 위치와 권한 | `XDG_RUNTIME_DIR` 아래, `srw-------`. 버전별 서버(값 없음)는 `/tmp` |
| 셸에 넣는 줄 | 대화형 Bash에 두 번 입력해도 `GIT_CONFIG_PARAMETERS`에 helper가 한 번만 붙는다 |
| 직접 입력 | 카드에서 입력한 값으로 push 성공, 카드 1번 |
| `store`·`erase` | `git credential approve`·`reject` 뒤 `credential-cache--daemon` 없음(0700 폴더에서도) |
| LFS | LFS 객체 push 한 번에 카드 1번("이번만 허용" 30초 재사용) |
| 앱 저장 토큰 | 금고(`Vault::save`)와 참조로 저장한 토큰이 "이번만 허용"으로 push. 삭제 뒤 OS 항목이 사라진다 |
| 이 PC의 `git credential fill` | 격리 `store`의 값으로 push |
| 거부 | git이 터미널에서 `Username for 'https://git.test:3000'`을 묻고, 빈 답이면 push가 실패한다 |
| 10분 허용 | 같은 연결의 다음 push는 카드 없이 성공 |
| `http` | 카드 없이 거부, 연결당 안내 1번 |
| 남의 소켓 | root 소유 소켓 경로로 helper를 바꿔도 요청이 가지 않는다(수신 기록 0바이트) |
| 64KiB 초과 | 답 없이 닫힘, 카드 없음 |
| 다섯째 채널 | 열린 채널 4개가 있을 때 거부, 카드 없음 |
| 반복 요청 | 10초 안 11번째 `get`이 거부되고 안내 1번 |
| 서버 helper 경고 | 서버 사용자 `credential.helper=store`가 카드의 `serverHelpers`에 보인다 |
| 정상 종료 | 탭을 닫은 연결의 소켓 파일이 다음 연결에서 보이지 않는다 |
| 소켓 전달 거부 서버 | 키 전달 거부와 함께 안내 1번, 셸은 열린다 |
| tmux | 새 tmux 서버의 첫 패널, 새 창, 분할 패널이 이 연결의 helper를 받는다. 다시 연결하면 새 창·패널이 새 연결의 소켓을 받는다. 새 창의 `git credential fill`이 카드로 값을 받는다 |

버전별 서버(`tests/git-servers`, `--git-versions` 또는 `--git-versions-only`): 각 서버에서 직접 입력으로 push, 데몬 없음, tmux 첫 패널·새 창·분할 패널·재접속 확인.

| 이미지 | git | tmux | 결과 |
|---|---|---|---|
| centos:7 | 1.8.3.1(배포판 패키지) | 1.8 | 통과(`new-session -e` 실패 후 대체 생성) |
| ubuntu:18.04 | 2.17.1(배포판 패키지) | 2.6 | 통과 |
| ubuntu:20.04 | 2.25.1(배포판 패키지) | 3.0a | 통과 |
| alpine:edge | 2.56.0 | 3.8 | 통과 |

git 버전은 Alpine만 검사 출력에서 읽었다. 나머지는 DX.12.0 기록과 같은 배포판 패키지이고, 출력 파싱을 고친 뒤 다시 돌리지 않았다.

검사를 만들며 고친 것:

- 반복 요청 차단을 10초 안 5번에서 10번으로 바꿨다. LFS 저장소에서 push 두 번이 이어지면 6번이 되어 두 번째 push가 막혔다(제품 변경, 설계안 메모).
- tmux 화면은 커서 이동으로 다시 그려져 줄 끝 표식이 맞지 않는다. tmux 결과는 같은 서버의 일반 셸 연결로 파일을 읽어 확인한다.
- CentOS 7 sshd는 기본 `UseDNS yes`라 컨테이너에서 로그인이 멈춰 버전별 서버 설정에 `UseDNS no`를 넣었다.
- 전체 실행에서는 앞 검사가 같은 세션 DB에 마스터 암호를 켜 두므로 자격 증명 검사는 별도 DB를 쓴다. 검사 동안 앞서 연 연결의 출력도 받아 ACK해 30초 렌더링 제한으로 끊기지 않게 한다.

### 네이티브 (WebView2, 실제 앱)

`scripts/verify-agent-terminal.mjs`의 DX.12 단계. 세션 폼의 **HTTPS Git 자격 증명 전달**을 켜고 연결해, 셸 훅이 helper 줄을 넣을 때까지 기다린 뒤 진행했다.

- 카드에 저장소 서버, 세션 이름, "서버로 전달됩니다"가 보이고 탭이 `입력 대기`가 된다. 카드는 터미널의 포커스를 가져가지 않는다.
- **직접 입력**과 **이 PC에 저장**으로 push 성공, `git_credentials_saved`에 `git.test:3000 · probe`.
- 다시 연결한 뒤 **이번만 허용**은 저장 토큰으로 push.
- **거부**하면 터미널에 git의 `Username for` 질문이 보인다.
- 설정 창 › 에이전트 목록에서 지우면 목록과 저장값이 비고, 세션 삭제 뒤 `credentialWarning`이 없다.
- 격리 `store`에 값을 두고 **이 연결에서 10분 허용**을 고르면 이 PC의 `git credential fill`로 push가 되고, 다음 push는 카드 없이 된다.

### DX.12 대기

| 항목 | 이유 |
|---|---|
| GitHub, GitLab.com, Bitbucket 실제 push(이 PC의 자격 증명 관리자) | 사용자의 실제 계정과 자격 증명 관리자가 필요하다. 수동 합격 항목 |
| macOS 키체인 `git credential fill`, Finder 앱에서 `/usr/bin/git` 설치 창이 뜨지 않음, Mac 카드 동작 | Mac 실기기 필요(M.15) |
| GCM 로그인 창이 앱의 "가져오는 중" 동안 뜨고 값이 돌아오는 흐름 | DX.12.0에서 GCM 자체는 확인했다. 앱을 거친 흐름은 실제 호스팅 확인 때 함께 본다 |
| Windows·macOS CI | 푸시하지 않았다 |
| fish·csh 수동 한 줄, 서버 helper 경고, 재접속 갱신 줄의 안내서 반영 | 설계 §9대로 DX.13과 함께 안내서를 고칠 때 |
