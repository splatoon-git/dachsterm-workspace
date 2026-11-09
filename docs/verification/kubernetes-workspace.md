# 쿠버네티스 작업 화면 검증 기록

## KV.0 실측 (2026-11-08)

설계안의 [KV.0 질문](../design/kubernetes-workspace.md#kv0--실측-게이트)에 답하려고 실제 OpenSSH와 kind 클러스터에서 잰 결과다. 앱 코드는 바꾸지 않았고 **DachsTerm 앱은 실행하지 않았다.** 측정 스크립트는 일회성이라 저장소에 넣지 않았다.

### 환경

| 항목 | 값 |
|---|---|
| 클러스터 | kind v0.33.0, Kubernetes v1.37.0, control-plane 1 + worker 1 (WSL Ubuntu-24.04, Docker 28.5.1, CPU 8, 메모리 약 20GB) |
| `kubectl` | 1.34.1 클라이언트 |
| SSH 서버 | `tests/openssh` 이미지(Debian bookworm), `sshd -T` 기준 `MaxSessions 10`. kind 네트워크에 연결 |
| SSH 클라이언트 | WSL의 OpenSSH. 채널 다중화는 ControlMaster로 쟀다. **앱의 russh 경로는 아니다** |
| root 전용 kubeconfig | 컨테이너의 `/etc/rancher/rke2/rke2.yaml`(root:root 600, 상위 폴더 755)로 흉내 냈다. **실제 RKE2가 아니다** |
| 파드 5,000개 | KWOK v0.8.0 가짜 노드 50개, Deployment 500개 × 10. 실제 컨테이너는 없고 API 객체만 실제다 |
| 인그레스 | ingress-nginx controller v1.15.1, kind용 정적 매니페스트 |

시간은 한 PC 안에서 잰 값이고 SSH는 localhost라 네트워크 지연이 없다. 측정 뒤 클러스터와 SSH 컨테이너는 지웠다. WSL의 `kind` 실행 파일(`~/.local/bin/kind`, 체크섬 확인)과 노드 이미지는 뒤 작업에 쓰려고 남겼다.

### 측정 중 고친 스크립트 실수

- `sudoers`에 없는 경우에 암호를 넣지 않아 `sudo` 입력 대기로 멈췄다. 암호를 넣어 다시 쟀다.
- 5,000개 첫 측정은 템플릿을 불러오면서 변수가 덮어써져 전부 실패했고, WSL 시계가 튀어 시간이 음수로 나왔다. 단조 시계(`/proc/uptime`, 해상도 10ms)로 다시 쟀다. 아래 표는 다시 잰 값이다.
- 표준 입력 측정은 파이프가 끝나기를 기다려 값이 무의미했다. 다시 쟀다.

### 1. `kubectl`과 `KUBECONFIG` 탐지

`.bashrc`/`.zshrc`에만 `PATH`와 `KUBECONFIG`를 넣고 실제 SSH로 실행했다.

| 명령 | 결과 |
|---|---|
| 그냥 실행, `bash -c`, `bash --noprofile --norc` | 못 찾음(기존 PodTree 탐지 방식) |
| `"$SHELL" -lc` | 못 찾음. `.profile` 출력만 나옴 |
| `"$SHELL" -ic` (Bash) | 찾음 |
| `"$SHELL" -lic` (Bash, Zsh) | **찾음**, 약 200ms |

- rc 출력(일반 글자, ANSI 색)은 표식 앞에만 섞였다. 앞뒤 표식 사이만 읽으면 된다.
- Bash는 stderr에 `cannot set terminal process group`, `no job control in this shell`을 낸다. 탐지에서는 stderr를 무시한다.
- rc 안의 `exit 7`: 종료 코드 7, 끝 표식 없음, `.bash_logout` 출력이 stdout에 나옴. 끝 표식이 없으면 실패로 보고 다음 단계로 넘어간다.
- rc 안의 `read -r -t 12`: 표준 입력이 열려 있으면 **12,210ms** 대기, `</dev/null`을 붙이면 **200ms**. 현재 `remote_exec.rs`는 채널에 EOF를 보내지 않으므로(코드 확인) 탐지 명령에 `</dev/null`이 필요하다.

### 2. 권한과 인증 오류

모두 `kubectl` 종료 코드는 1이다. stderr에는 klog 줄(`E1108 ...`)이 최대 5번 앞서 나와 **마지막 줄**만 뜻이 있다.

| 상황 | 마지막 줄 | 판별 |
|---|---|---|
| root 전용 kubeconfig | `error: error loading config file "...": open ...: permission denied` | `test -e` 0, `test -r` 1 |
| 파일 없음, `KUBECONFIG` 환경 변수 | `The connection to the server localhost:8080 was refused - ...` | **오해하기 쉽다.** 먼저 `test -e`로 거른다 |
| 파일 없음, `--kubeconfig` | `error: stat ...: no such file or directory` | |
| 틀린 토큰 | `error: You must be logged in to the server (the server has asked for the client to provide credentials)` | 인증 실패 |
| 다른 CA의 클라이언트 인증서 | 위와 같은 문구 | 인증 실패. **실제로 만료된 인증서는 재지 못했다** |
| 권한 부족(RBAC) | `Error from server (Forbidden): ...` | |
| 없는 context | `Error in configuration: context was not found for specified context: nope` | |
| API 서버 연결 거부 | `The connection to the server ...:1 was refused - ...` | |
| API 서버 응답 없음 | `Unable to connect to the server: context deadline exceeded (...)` | **`--request-timeout=8s`인데 약 36초** 걸렸다(35,797ms, klog 시각 12:02:11~12:02:38) |
| metrics-server 없음 | `error: Metrics API not available` | |

### 3. 복사 명령

`mkdir -p ~/.kube && sudo install -m 600 -o "$(id -u)" -g "$(id -g)" <경로> ~/.kube/dachsterm.config`를 `ssh -tt`로 실행했다.

| 경우 | 결과 |
|---|---|
| 암호 필요 `sudo`, 프롬프트에 입력 | 종료 0, `600 probe:probe`, 이후 `kubectl` 성공 |
| NOPASSWD | 종료 0, 이후 `kubectl` 성공 |
| 기존 `~/.kube/config`가 있을 때 | 기존 파일 내용 유지 |
| `sudoers`에 없음 | 암호를 먼저 물은 뒤 `probe is not in the sudoers file.`, 종료 1 |

### 4. 파드 5,000개 (실제 줄 수 5,115: DaemonSet이 가짜 노드에도 생겨 +100)

SSH로 실제 출력을 받아 잰 값이다. 3회 범위.

| 조회 | 시간 | 출력 |
|---|---|---|
| `get pods -A` go-template | 5,850~6,160ms | 3.75MB, 5,115줄, 최대 2,057자, gzip 252KB |
| 같은 조회, `--chunk-size=0` | 6,010~6,250ms | 같음 |
| `get pods -A -o json` | 5,080~5,450ms | **65.8MB**, gzip 1.23MB |
| `get pods -n` 한 namespace(250개) | 500~540ms | 183KB |
| 워크로드 500개 go-template | 660~680ms | 19.6KB |
| 노드 52개 go-template | 260~270ms | 24.6KB |
| Warning 이벤트 | 300ms | 2KB |

템플릿은 `podtree.sh`의 것을 그대로 썼다. 파드 객체는 컨테이너 2개, 환경 변수 10개를 넣었지만 실제 운영 파드의 크기와는 다르다.

### 5. `MaxSessions`와 동시 실행

| 측정 | 결과 |
|---|---|
| 기본값 | 10 |
| 연결 하나에 채널 12개 | 10개 성공, 11번째부터 `Session open refused by peer` |
| 셸 1개 + 5,000개 조회 3개 동시 | 각 6,360~6,580ms |
| 셸 1개 + 5,000개 조회 9개 동시 | 각 10,520~11,740ms, 거부 없음 |

### 6. kubelet `container_threads`

- `get --raw /api/v1/nodes/<노드>/proxy/metrics/cadvisor`에 `container_threads`와 `container_threads_max`가 있다. worker 노드 하나의 응답은 411KB, 261ms다.
- `container=""` 행은 cgroup 합계와 pause이므로 `container`가 있는 행만 쓴다.
- `nodes/proxy` get이 없으면 `Forbidden`, `kubectl auth can-i get nodes --subresource=proxy`는 `no`와 종료 1이다. 권한을 주면 같은 계정으로 읽힌다.

### 7. 셸 없는 이미지

`registry.k8s.io/pause:3.10`으로 쟀다. 종료 코드는 둘 다 1이다.

- `exec -- sh -c ...`: `... exec: "sh": executable file not found in $PATH`
- `exec -- /bin/cat ...`: `... exec: "/bin/cat": stat /bin/cat: no such file or directory`
- 셸이 있는 이미지의 `/proc/1/status` 읽기는 정상이다.
- `pods/exec` 권한이 없으면 `Forbidden`이다.

### 8. `/metrics` 후보 탐지

| 대상 | 결과 |
|---|---|
| 메트릭이 있는 포트 | 정상 |
| 열렸지만 메트릭 없음 | `Error from server (NotFound): the server could not find the requested resource` |
| 닫힌 포트 | `Error from server (ServiceUnavailable): error trying to reach service: dial tcp ...: connect: connection refused` |

ingress-nginx 컨트롤러는 메트릭 포트 10254를 `containerPort`로 선언하지 않고 annotation도 없다. **선언 정보만으로는 찾을 수 없는 메트릭 포트가 실제로 있다.**

### 9. ingress-nginx 메트릭

- 정적 매니페스트 그대로 설치하면(`--enable-metrics` 없음) `/metrics`는 8.7KB이고 `nginx_ingress_controller_*`가 **하나도 없다.**
- `--enable-metrics=true`로 켜면 64.9KB이고 이름은 다음과 같다: `nginx_ingress_controller_requests`, `_request_duration_seconds`, `_response_duration_seconds`, `_connect_duration_seconds`, `_nginx_process_connections`, `_config_last_reload_successful`, `_ssl_expire_time_seconds`, `_orphan_ingress` 등.
- `nginx_ingress_controller_requests`는 호스트·서비스별로 나뉜다(`ok.local`, `dead.local` 2줄).
- `pods/proxy` get이 없으면 `Forbidden`, 있으면 읽힌다.
- 준비된 백엔드가 없는 Service의 EndpointSlice `endpoints`는 `null`이다.
- GitHub API 기준 `kubernetes/ingress-nginx` 저장소는 `archived: true`다.

### 기타

kind의 `kindnet` 파드 하나(control-plane)가 파드 5,000개 생성 뒤 `CrashLoopBackOff`였다(종료 코드 2). 조회 결과와 무관해 보여 원인은 확인하지 않았다.

### 미확인으로 남은 것

| 항목 | 이유 |
|---|---|
| 실제 RKE2 서버의 권한 오류, `/etc/rancher/rke2` 폴더 권한 | RKE2 환경 없음. 폴더를 지나갈 수 없으면 `test -e`가 "없음"을 낸다 |
| 실제로 만료된 클라이언트 인증서의 문구 | 다른 CA의 인증서로 대신했다 |
| vLLM 메트릭 이름과 포트 | GPU와 실제 vLLM 없음 |
| 실제 대형 클러스터의 시간, 실제 파드 크기 | KWOK 가짜 노드와 localhost SSH 기준이다 |
| russh 채널에서의 거부 동작 | OpenSSH 클라이언트로만 쟀다. KV.1 구현 때 앱에서 확인한다 |
| `MaxSessions`가 10보다 작은 서버 | 기본값만 쟀다 |
| 앱이 시간 초과로 채널을 닫은 뒤 원격 `kubectl`의 종료 | 재지 않았다 |
| fish 등 다른 셸 | Bash, Zsh만 쟀다 |

## KV.1 앱 검증 (2026-11-08)

대상: 브랜치 `feat/kv1-kube-detect`의 커밋 전 트리. `npm run tauri -- build --debug --no-bundle`로 만든 실제 앱(WebView2), `tests/openssh` 기반 실제 OpenSSH, 실제 kind 클러스터. 명령: `node scripts/verify-kube-detect.mjs --cluster=dachsterm-kv1 --keep`, 종료 0.

### 환경

`scripts/kube-fixture.sh`(`npm run kube:fixture -- <클러스터> up`)가 만든다. kind v0.33.0, `kubectl` 1.34.1, `sshd -T` 기준 `MaxSessions 10`. SSH 서버는 kind 네트워크에 붙어 `--internal` kubeconfig로 API 서버에 닿는다. 검사가 끝나면 클러스터와 SSH 컨테이너는 지웠다.

| 계정 | 흉내 낸 서버 |
|---|---|
| `probe` | `~/.bashrc`의 대화형 구간에만 `PATH=/opt/kube/bin`과 `KUBECONFIG=/opt/kube/config`. context 2개 |
| `rkeuser` | `kubectl`은 `/var/lib/rancher/rke2/bin`, kubeconfig는 `/etc/rancher/rke2/rke2.yaml`(root:root 600). 암호 필요 `sudo`. **실제 RKE2가 아니다** |

### 합격 기준

| 항목 | 결과 |
|---|---|
| `.bashrc`에만 `PATH`, `KUBECONFIG`가 있는 서버 | 첫 접속에서 `/opt/kube/bin/kubectl`, `/opt/kube/config` 발견 |
| context·namespace 선택과 저장 | `second`, `kube-system`, 절대 경로가 세션에 저장, `operate` false |
| 설정을 마친 세션의 다음 접속 | 재접속에서 설정 화면 없이 바로 작업 화면 |
| root 전용 kubeconfig | 안내 표시 → 복사 버튼 → 터미널에 명령 입력(Enter는 검사가 사용자처럼 누름) → `sudo` 암호를 터미널에 입력 → `600 rkeuser` 복사본 생성 → 헤더의 다시 확인 → 작업 화면, 세션에 `~/.kube/dachsterm.config` 저장 |
| 복사한 설정의 다음 접속 | 바로 작업 화면 |
| 복사본이 낡은 경우(토큰을 틀리게 바꿈) | 재접속 시 "클러스터 인증에 실패했습니다", 복사 버튼 활성 |
| 숨은 셸 | 작업 화면과 전환해도 출력이 유지되고, 경로 알림 훅이 입력되지 않음 |
| 터미널 세션에서 탭 메뉴로 열기 | 같은 연결 ID, 세션 저장값 없음, 닫으면 터미널로 복귀 |
| 프롬프트를 보고하는 셸의 복사 | 명령이 Enter까지 입력되어 `sudo` 프롬프트가 나옴 |

### 앱 SSH 채널의 `MaxSessions` 초과

연결 하나에 `kube_detect`(scan) 14개를 동시에 실행했다. 로그인 셸 rc에 `sleep 4`를 넣어 채널을 오래 잡게 했다. 같은 연결에 셸과 SFTP가 이미 있다.

| 실행 | 결과 | 거부까지 | 성공까지 |
|---|---|---|---|
| 1회 | 성공 5, 거부 9 | 기록 안 함 | 전체 3,877ms |
| 2회 | 성공 6, 거부 8 | 8~11ms 6개, 3,741ms 2개 | 3,859~3,877ms |
| 3회 | 성공 6, 거부 8 | 7~13ms 8개 | 3,781~3,796ms |

- OpenSSH의 거부는 russh에서 `Error::ChannelOpenFailure`로 온다. `channel_open_session`이 멈추지 않고 바로 실패하며 `KubeState::ChannelLimit`이 된다. 3,741ms의 거부 2개는 앞 단계 채널을 잡았던 호출이 다음 단계 채널을 열 때 거부된 것으로 본다(호출별 단계는 기록하지 않았다).
- 거부된 뒤에도 연결은 유지됐다. 곧바로 실행한 `kube_detect`는 `ready`이고 터미널 입력도 동작했다.
- 동시에 잡을 수 있는 채널은 6~8개로, 셸과 SFTP를 뺀 `MaxSessions` 10의 나머지와 맞는다.
- rc가 `sleep 4`인데 약 3.8초로 나온 것은 측정이 Windows 쪽 시계라 컨테이너 VM 시계와의 차이로 보이며 확인하지 않았다.
- 파드 탭과 로그 검색의 거부 안내는 KV.2·KV.4·KV.5에서 이 상태를 쓴다. 기본값 10 외의 값은 재지 않았다.

### 단위·UI

- `cargo test -p dachsterm --lib --locked -- kube remote_exec settings storage` 60건 통과. 상태 분류의 입력은 KV.0 실측 문구다.
- `npx vitest run src/features/kube src/features/terminal/shellReadiness.test.ts src/features/git src/app/tabMenu.test.ts` 112건, 뒤에 넣은 `tabMenu` 2건은 그 파일만 다시 실행.
- `npx playwright test tests/ui/kube-workspace.spec.ts` 12건.
- `npm run typecheck`, 바꾼 파일 eslint·prettier, `cargo fmt --all --check`, `cargo clippy -p dachsterm --all-targets --locked -- -D warnings` 종료 0.

### 미확인

| 항목 | 이유 |
|---|---|
| 실제 RKE2, 실제로 만료된 인증서 | 환경 없음. 복사본의 토큰을 틀리게 바꿔 대신했다 |
| 숨은 셸에 프로그램이 도는 동안 복사 버튼을 막는 것 | 실제 앱에서 재현하지 않았다. 판단은 Vitest, 표시는 Playwright까지 |
| Mac 실기기, CI | Mac은 대기. CI는 `main`에 반영할 때 돈다 |
| 분리 창 | 1차에서 끈다(`새 창으로 분리` 비활성) |

## KV.2 앱 검증 (2026-11-08)

### 환경

- `scripts/kube-fixture.sh`의 kind 클러스터(노드 1개)와 OpenSSH 서버 컨테이너. `metrics-on`, `metrics-off`로 metrics-server를 켜고 끈다.
- 검사: `node scripts/verify-kube-tree.mjs --cluster=dachsterm-kv2 --keep` (`npm run test:kube-tree`), 커밋 전 트리. 서버의 `kubectl`을 호출 기록용 스크립트로 감싸 실제 실행을 서버 쪽에서 쟀다.

### 합격 기준

종료 0, PASS 9줄.

| 항목 | 결과 |
|---|---|
| 첫 화면이 트리이고 기본 묶기가 워크로드 | `Deployment/api`, 맨 위 `노드 1/1 준비` |
| metrics-server 없음 | 파드·서비스가 `25m / 50m`, `16Mi / 32Mi`로 요청량·제한 표시, "파드 사용량: metrics-server 없음" |
| metrics-server 켠 뒤 | CPU·메모리 사용량으로 바뀜 |
| CrashLoopBackOff | 문제만 필터에 남고 정상 파드는 빠짐 |
| 조회 주기와 동시 수 | 서버에서 동시 최대 3개, 파드 간격 5.4~5.6초(`kubectl` 감싸기의 지연 포함) |
| 서버 터미널로 전환 | 11초 동안 `kubectl` 0회, 돌아오면 3초 안에 조회 |
| 다른 탭으로 전환 | 11초 동안 `kubectl` 0회, 돌아오면 3초 안에 조회 |
| API 서버 중지(`docker pause`) | "클러스터 연결 불가", 행 유지, 몇 초 전 숫자 증가, 복구 뒤 자동 갱신 |

측정 중 고친 것: Docker VM의 벽시계가 약 30초마다 보정돼 `date` 기준 간격이 3초로 보였다. 앱의 호출 시각을 함께 기록해 정확히 5초 간격임을 확인하고 서버 쪽 시각을 `/proc/uptime`으로 바꿨다. 앱 결함으로는 이름이 긴 행의 열 어긋남과 묶기 선택 상자의 글자 잘림을 찾아 고쳤다.

KV.1 검사도 공용 헬퍼로 옮기고 첫 화면 기대값을 바꿔 다시 실행했다. `node scripts/verify-kube-detect.mjs --cluster=dachsterm-kv2 --keep` 종료 0, PASS 10줄. 동시 14개 조회에서 6개 성공, 8개 거부.

### 단위·UI

커밋 전 트리. `cargo test -p dachsterm --lib --locked kube` 51건, `vitest run src/features/kube` 97건, Playwright `kube-tree` 28건, `kube-workspace` 12건, typecheck, 바꾼 파일 eslint·prettier, `cargo fmt --all --check`, `cargo clippy -p dachsterm --all-targets --locked -- -D warnings` 통과.

### 미확인

- 파드 5,000개 화면은 Playwright의 합성 데이터로만 확인했고 실제 대형 클러스터는 없다.
- 권한 없는 항목(`Forbidden`), `MaxSessions` 거부로 조회를 미루는 동작, 출력 상한과 시간 상한은 단위·UI 테스트로만 확인했다.
- 한글 입력 상태의 키는 `code`가 있는 합성 키 이벤트로 확인했고 실제 IME는 눌러 보지 않았다.
- 실제 RKE2, Mac 실기기, CI(`main` 미반영), 전체 Rust·Playwright·네이티브 회귀는 실행하지 않았다.

## KV.3 앱 검증 (2026-11-08)

### 환경

- KV.2와 같은 kind 클러스터(노드 1개)와 OpenSSH 서버(`npm run kube:fixture -- dachsterm-kv3 up`, 끝난 뒤 `down`). 확인용으로 항상 실패하는 `broken`과 메모리 제한 16Mi를 넘겨 죽는 `oom` Deployment를 올린다.
- 검사: `npm run test:kube-dashboard -- --cluster=dachsterm-kv3 --keep`(`verify-kube-tree.mjs --dashboard`), 커밋 전 트리. 서버의 `kubectl`을 호출 기록용 스크립트로 감싸 조회를 서버 쪽에서 쟀다.

### 합격 기준

종료 0, PASS 5줄.

| 항목 | 결과 |
|---|---|
| metrics-server 없음 | "metrics-server가 없어…" 안내, 요청량과 할당량 표시, 사용량 없음, 자원 상위는 "요청량 기준입니다." |
| metrics-server 켠 뒤 | 사용량, 추세 그래프, 사용량 기준 자원 상위로 바뀜 |
| 재시작·에러 | `broken`의 `Error (종료 코드 1)`, `oom`의 `OOMKilled (종료 코드 137)`, 탭을 연 뒤 증가 수 `+N` |
| 미달 워크로드, 최근 경고 | `Deployment/broken` `0/1 준비`, `BackOff` 경고 |
| 트리로 이동 | 파드, 워크로드, 노드 항목을 눌러 트리의 해당 행이 선택됨 |
| 조회가 늘지 않음 | 대시보드를 17초 연 동안 서버에서 실행된 `kubectl`은 트리가 조회하는 7종뿐이고 파드 간격 4.5초 이상 |
| 인그레스·워커 | 자리만 표시 |

### 단위·UI

커밋 전 트리. `cargo test -p dachsterm --lib --locked kube::snapshot` 16건, `cargo fmt --all --check`, `cargo clippy -p dachsterm --all-targets --locked -- -D warnings`, `vitest run src/features/kube` 138건(뒤에 더한 1건 포함 `dashboard.test.ts` 33건), Playwright `kube-dashboard` 20건·`kube-tree` 28건·`kube-workspace` 12건, typecheck, 바꾼 파일 eslint·prettier 통과.

`cargo test`의 첫 실행은 `rustc`가 `tokio`, `windows`를 컴파일하다 `STATUS_STACK_BUFFER_OVERRUN`으로 종료했다. 코드를 바꾸지 않고 다시 실행해 통과했으며 원인은 조사하지 않았다.

실제 앱 검사 뒤 화면 캡처에서 `OOMKilled · OOMKilled (종료 코드 137)`처럼 상태와 사유가 겹쳐 종료 코드가 잘리는 것을 찾아 고쳤다. 이 수정은 단위 테스트와 해당 Playwright 1건으로 확인했고 실제 앱을 다시 실행하지 않았다.

### 미확인

- 권한 없는 항목, namespace를 정한 세션, API 서버 중지 중의 대시보드, 목록 상한은 Playwright의 합성 데이터로만 확인했다.
- 스크립트의 전체 경로(`npm run test:kube-tree`, 대시보드 단계 뒤 `metrics-off`로 돌아가 KV.2 단계를 계속)는 실행하지 않았다. KV.2 단계의 코드는 바꾸지 않았다.
- Mac 실기기(WKWebView 표시), CI(`main` 미반영), 전체 Rust·Playwright·네이티브 회귀는 실행하지 않았다.

## KV.4 앱 검증 (2026-11-08)

### 환경

- KV.2와 같은 kind 클러스터(노드 1개)와 OpenSSH 서버(`npm run kube:fixture -- dachsterm-kv4 up`, 끝난 뒤 `down`). 이미지는 `busybox:1.36`, 셸이 없는 쪽은 `registry.k8s.io/pause:3.10`.
- 검사: `node scripts/verify-kube-detail.mjs --cluster=dachsterm-kv4 --keep`(`npm run test:kube-detail`). 실패 원인이 모두 스크립트 쪽이었고 통과한 단계를 반복하지 않으려고 3번에 나눠 실행했다. 처음부터 끝까지 한 번에 통과시킨 실행은 없다. 뒤의 두 번은 `--from-follow`, `--from-parent`로 시작 지점을 옮겼다.
- 실행 파일은 세 번 모두 같은 빌드다. 그 뒤에 바꾼 코드는 `useKubeTabs.ts`의 닫힌 탭 기록 정리, 주석 1줄, KV.3 병합이고 실제 앱으로 다시 실행하지 않았다.

### 실측

| 동작 | 결과 |
|---|---|
| 셸 없는 이미지에서 `exec -- sh -c` | 종료 1, `... exec: "sh": executable file not found in $PATH` |
| 정지한 컨테이너에 `exec` | 종료 1, `error: unable to upgrade connection: container not found ("c")` |
| 재시작한 적 없는 컨테이너의 `logs --previous` | 종료 1, `Error from server (BadRequest): previous terminated container "main" in pod "..." not found` |
| 재시작 대기 중(현재 `terminated`)인 컨테이너의 `logs --previous` | **종료 0, stdout에 `unable to retrieve container logs for containerd://...`** |
| 없는 파드의 `logs` / `get` | `error: error from server (NotFound): ...` / `Error from server (NotFound): ...` |
| `exec` 중 파드 삭제 | 종료 137, `command terminated with exit code 137` |

### 합격 기준

PASS 13줄과 측정 1줄.

| 항목 | 결과 |
|---|---|
| 로그 패널 | `Enter`와 더블클릭으로 열림, annotation의 컨테이너 선택, 키워드 필터, `Esc`로 닫으면 같은 파드에 커서와 포커스 |
| 우클릭 메뉴와 상세 | 로그·셸·이벤트·상세 4개, 이벤트·YAML·관계(`web · 로테이션 포함`)·개요에 실제 데이터 |
| 재시작한 파드 | 상세가 장애 원인으로 열림, `Error`와 종료 코드 9, 직전 인스턴스 로그, 패널 체크박스로도 직전 로그 |
| 직전 인스턴스 없음 | 안내와 함께 현재 로그 |
| 셸 탭 | 조회 모드에서 열림, 탭 제목 `kind-… · 파드`, 명령 실행 |
| 복귀 | `exit 3`으로 탭이 닫히고 트리의 같은 파드에 포커스 |
| 여러 컨테이너 | annotation이 없으면 한 번 묻고 다음부터 묻지 않음 |
| 셸 없는 이미지 | 트리 옆 안내, 탭이 열리지 않음 |
| 로그 따라가기 | 터미널 탭에 실시간 출력, 탭 닫기 |
| 파드 삭제 | 끝난 카드에서 물음, 재접속하면 새 파드(`hostname`으로 확인), 이전 명령이 다시 실행되지 않음 |
| 채널 거부 | 셸 탭 9개 뒤 `kube_terminal_probe`가 거부되어 동시 세션 한도 안내 |
| 부모 연결 종료 | 셸 탭과 로그 탭이 모두 닫힘 |

첫 실행의 실패 2건은 모두 스크립트 문제였다. 탭 머리글을 클릭하면 포커스가 그곳에 남아 `Esc`가 트리로 가지 않았고, 세션 한도에 닿은 채로 패널을 열어 조회 채널이 없었다.

### 단위·UI

KV.3을 합친 커밋 전 트리. `cargo test -p dachsterm --lib --locked -- kube podtree` 71건, `vitest run src/features/kube` 169건, Playwright `kube-tree`·`kube-dashboard`·`kube-workspace` 67건, typecheck, 바꾼 파일 eslint·prettier, `cargo fmt --all --check`, `cargo clippy -p dachsterm --all-targets --locked -- -D warnings`(`-j 2`) 통과.

첫 `cargo clippy`는 메모리 할당 실패(`STATUS_STACK_BUFFER_OVERRUN`)로 끝났다. `-j 2`로 줄여 통과했다.

### 미확인

- PTY를 여는 순간의 채널 거부(`ChannelOpenFailure` → 세션 한도 문구): 실측한 거부는 그 앞 `kube_terminal_probe`에서 났다. 이 분기는 실행되지 않았다.
- 컨테이너만 재시작해 끊긴 셸의 재접속, StatefulSet의 같은 이름 새 파드, 2초 안에 실패한 셸의 안내 유지는 단위 테스트까지다.
- 개요의 사용량과 추세: 이번 환경에 metrics-server가 없어 실제 값으로 그려 보지 않았다.
- 패널 경계선 끌기, 실제 IME, 권한 없는 계정(`pods/exec`, Ingress·NetworkPolicy 조회 거부)은 실행하지 않았다.
- Mac 실기기(`mac-verify`), CI(`main` 미반영), 전체 Rust·Playwright·네이티브 회귀는 실행하지 않았다. `test-phase63-67-native.mjs`는 명령 이름만 고쳤고 원래 실행할 수 없는 상태다.

## KV.5 앱 검증 (2026-11-08)

### 환경

- KV.2와 같은 kind 클러스터(노드 1개)와 OpenSSH 서버(`npm run kube:fixture -- dachsterm-kv5 up`, 끝난 뒤 `down`). 이미지는 `busybox:1.36`. 파드는 `chatty` 3개, `flood` 6개, `bulky` 30개(키워드가 없는 약 8MB 로그), `multi`(컨테이너 2개와 default-container annotation), `restarted`(한 번 재시작)다.
- 검사: `node scripts/verify-kube-log-search.mjs --cluster=dachsterm-kv5 --keep`(`npm run test:kube-log-search`). 한 번 실행, 종료 0. 실행 파일은 커밋 직전 트리로 빌드했고 그 뒤로 바꾼 것은 문서뿐이다.

### 합격 기준

PASS 11줄.

| 항목 | 결과 |
|---|---|
| 여러 파드 검색 | 워크로드 범위 파드 3개에서 15줄, 파드마다 5줄, 키워드 강조 |
| 키워드 | `!level=debug` 제외와 대소문자 무시(9줄). `$(touch${IFS}/tmp/kv5-injected)`는 0줄이고 서버에 파일이 생기지 않음 |
| 컨테이너 | 기본은 annotation의 컨테이너 1개, **컨테이너 전체**는 2개 |
| 이전 인스턴스 | 재시작한 컨테이너의 이전 로그를 `이전` 표시와 함께 2줄로 |
| 파드당 상한 | 일치 1,500줄인 파드가 1,000줄에서 멈추고 `파드당 1,000줄` 표시 |
| 전체 상한 | 파드 6개 검색이 5,000줄에서 멈추고 `전체 5,000줄` 표시 |
| 결과 행 | 클릭은 주변 로그, 우클릭은 그 파드의 로그 패널과 셸. 셸 안 `hostname` 확인 후 `exit`로 복귀 |
| 실시간 따라가기 | 터미널 탭에 키워드로 거른 로그 표시, 탭 닫기 |
| 취소 | 서버에 `kubectl ... logs`가 있는 동안 취소, 화면 `취소됨`, 이후 서버의 `kubectl ... logs` 프로세스 0개 |
| 채널 거부 | 셸 탭으로 `MaxSessions`를 채운 뒤 2개만 닫고 검색: 동시 수를 줄였다는 안내가 나오고 실패 목록 없이 완료 |

취소 시 서버 감시는 위 시나리오와 별도로 fixture의 dash에서 스크립트 조각만 돌려 확인했다. 300초짜리 프로세스를 대신 넣고 stdin을 닫으면 그 프로세스가 SIGTERM으로 끝나고(`EXIT 143`) `timeout 30`에 닿지 않았다. 앱 시나리오의 `bulky` 검색은 kubectl이 원래 짧게 끝나는 작업이라, 감시가 끊은 것인지 스스로 끝난 것인지는 앱 시나리오만으로는 구분되지 않는다.

### 단위·UI

커밋 전 트리. `cargo fmt --all --check`, `cargo clippy -p dachsterm --all-targets --locked -- -D warnings`, `npm run typecheck`, 바꾼 파일 eslint·prettier 통과. `cargo test -p dachsterm --lib --locked -- log_ kube::shell kube::snapshot kube::settings kube::logs remote_exec` 58건, 뒤이어 `Streamed` 필드 제거와 전체 상한 잠금 변경 뒤 `-- log_ remote_exec` 30건 재실행. `vitest run src/features/kube` 189건. Playwright `kube-log-search` 9건(첫 실행의 1건 실패는 스펙의 사용량 데이터가 비어 대시보드 행이 없던 것으로, 고친 뒤 그 1건만 재실행 통과), 트리·대시보드를 고쳐 함께 돌린 `kube-tree`·`kube-dashboard`·`kube-workspace` 67건.

### 미확인

- 파드 100개 상한과 전체 60초 상한은 실제 클러스터에서 재지 않았다(단위 테스트와 Playwright 표시까지). 대상 하나의 16MiB 상한과 한 줄 4,096자 자르기는 단위 테스트까지다.
- 트리·대시보드 우클릭으로 시작하는 경로와 `usePodShell`로 옮긴 트리의 셸 열기는 Playwright까지다. `test:kube-detail`은 재실행하지 않았고, 같은 훅을 쓰는 결과 행 셸만 실제 앱에서 확인했다.
- `grep --line-buffered`는 busybox 서버에서 쓸 수 없다. kubectl을 busybox 환경에서 쓰는 서버의 실시간 따라가기는 확인하지 않았다.
- 파일 저장은 만들지 않았다(설계안 KV.5). 대형 클러스터, 실제 IME, 권한 없는 계정은 실행하지 않았다.
- Mac 실기기(`mac-verify`), CI(`main` 미반영), 전체 Rust·Playwright·네이티브 회귀는 실행하지 않았다.

## KV.8 앱 검증 (2026-11-09)

### 환경

- 대상: 커밋 전 트리(`feat/kv8-kube-ingress`), `npm run tauri -- build --debug --no-bundle`로 만든 실제 앱, OpenSSH 컨테이너, kind v0.33.0, ingress-nginx controller v1.15.1(kind용 정적 매니페스트).
- 명령: `node scripts/verify-kube-ingress.mjs --cluster=dachsterm-kv8 --keep`. 환경은 `npm run kube:fixture -- dachsterm-kv8 up`, `ingress-up`, `ingress-metrics-on|off`로 올렸고 끝난 뒤 `down`했다. 기존 `metrics-on|off`는 metrics-server 전환이라 컨트롤러 메트릭과 무관하다.

### 실측

- 메트릭을 끈 컨트롤러의 `/metrics`에 `nginx_ingress_controller_*` 줄은 0개였다.
- 정적 매니페스트의 기본 접근 로그에는 호스트가 없다. `ok.local` 요청 130건 뒤 로그에서 `ok.local` 일치 0줄이고, 줄 형식은 `... "GET / HTTP/1.1" 200 6 "-" "Wget" 71 0.001 [kv8-ingress-web-80] [] 10.244.0.11:8080 6 0.001 200 <id>`이다.
- 새 Ingress의 `status.loadBalancer`는 컨트롤러의 동기화 주기를 기다려 생성 후 바로 채워지지 않는다. 그동안 앱은 "주소 미할당"을 표시한다.
- go-template: `host`가 없는 규칙은 `<no value>`로 나오고 `http`가 없는 규칙은 경로 없이 나온다(파서가 처리).

### 합격 기준

PASS 12줄, 종료 코드 0.

| 항목 | 결과 |
|---|---|
| 백엔드 장애 | `dead.local`은 `백엔드 준비 0: down`, `ghost.local`은 `백엔드 없음: nowhere`, `tls.local`은 `TLS Secret 없음: no-such-cert`. 대시보드 패널이 이 호스트들만 나열하고 누르면 해당 호스트로 필터된 인그레스 화면이 열림 |
| 메트릭 꺼짐 | "컨트롤러 메트릭이 꺼져 있어 구성 점검만 표시합니다", 오류 표시 없음, 비율 칸 `-` |
| 메트릭 켜짐 | `ingress-metrics-on` 롤아웃 후 안내가 사라짐. 다시 끄면 꺼짐 안내로 돌아감 |
| 호스트별 비율 | `ok.local`에 200 60건·404 20건·500 20건을 보낸 뒤 2xx 60%, 4xx 20%, 5xx 20%. `dead.local` 503 5건은 5xx 100% |
| 요청률 | 두 번째 조회 이후 `ok.local` 200 30건을 더 보내면 구간 비율 2xx 100%, 5xx 0%, 요청률 1/s |
| pods/proxy 권한 없음 | `pods/proxy`가 없는 ServiceAccount context: "pods/proxy 권한이 없어 트래픽을 표시하지 못합니다."만 표시되고 구성 점검은 동작 |
| 백엔드 파드로 이동 | `ok.local` 행 클릭으로 트리의 `web-*` 파드가 선택됨 |
| 컨트롤러 로그 검색 | 세션 namespace 밖의 컨트롤러를 범위로 검색. 호스트 `ok.local`은 `검색 완료 1/1 · 0줄`, upstream `kv8-ingress-web-80`은 `검색 완료 1/1 · 130줄` |

같은 시나리오의 앞선 실행 2번은 실패했다. 1번째는 스크립트가 주소 할당을 기다리지 않은 탓이어서 대기만 늘렸다. 2번째는 요청률 단계에서 화면이 트리로 바뀌고 검사가 누르지 않은 파드 우클릭 메뉴가 열려 있었다. 서버 카운터는 정상이었고 앱의 조작 경로에도 이 동작이 없어 외부 마우스 입력으로 추정하지만 원인은 확정하지 못했다. 코드 수정(호스트 행의 upstream 메뉴) 후 재빌드한 앱으로 처음부터 다시 실행한 결과가 위 표다.

### 단위·UI

커밋 전 트리. `cargo fmt --all --check`, `cargo clippy -p dachsterm --all-targets --locked -- -D warnings`, `npm run typecheck`, 바꾼 파일 eslint·prettier 통과. `cargo test -p dachsterm --lib --locked kube::ingress` 22건, Vitest `src/features/kube` 211건, Playwright `kube-ingress` 15건·`kube-log-search` 9건, `kube-dashboard`의 인그레스·워커 자리 1건, `kube-tree`의 마지막 화면 1건.

### 미확인

- 평균 지연 값은 단위·Playwright까지다. 실제 앱에서는 값이 맞는지 대조하지 않았다.
- 컨트롤러 여러 개의 합산과 일부만 읽힌 표시, 컨트롤러 없음, 컨트롤러 파드 조회 거부, 일시적 읽기 실패 뒤 유지는 단위·Playwright까지다.
- 전체 namespace 세션(`-A` 경로)과 실제 TLS Secret이 있는 경우의 앱 실행은 하지 않았다. namespace 세션으로만 실행했다.
- 대형 클러스터의 메트릭 크기, 실제 운영 클러스터, Mac 실기기(`mac-verify`), CI(`main` 미반영), 전체 Rust·Playwright·네이티브 회귀는 실행하지 않았다.

## KV.9 앱 검증 (2026-11-09)

### 실제 앱·실제 SSH·kind

`npm run test:kube-workers`(`scripts/verify-kube-workers.mjs`), 클러스터 `dachsterm-kv9`. 실행 파일은 `npm run tauri -- build --debug --no-bundle`로 빌드한 커밋 전 트리다. PASS 9줄, 실패 없음.

| 항목 | 결과 |
|---|---|
| annotation 후보 | `prometheus.io/port` 파드에서 `:8080/metrics` 지표 4개, annotation 표시. 런타임 내부 지표 `go_goroutines`는 목록에서 빠짐 |
| 트리 행 표시 | 우클릭으로 사용 중·전체·완료 수를 지정하고 감시를 켜면 워크로드 행에 `사용 8/8` |
| 스레드 | kubelet `container_threads`에서 컨테이너 `app` 행 표시 |
| **워커 미반환 재현** | 숫자가 움직이지 않는 파드(`worker_busy 8`, 완료 수 고정), 판정 기준 1분: 트리 행에 `의심`, 제목에 `반환 안 됨 의심`, 값 `사용 8/8` 유지 |
| 정상 워크로드 | 완료 수가 계속 오르는 파드는 같은 시간에 `사용 2/8`만 표시 |
| 대시보드 | `반환 안 됨 의심`, `워커 포화 의심`과 정상 워크로드의 `이상 없음` 표시. 판정 행을 누르면 해당 파드의 런타임 탭이 열림 |
| 프로브 | 워크로드별 첫 수집만 확인 창 표시. `httpd` 프로세스, 8080 포트, ESTABLISHED 표시 |
| 후보의 404·연결 거부 | `메트릭 없음 (404)`, `메트릭 없음 (연결 거부)`이고 오류 표시 없음 |
| 포트 직접 입력 | 선언하지 않은 8082를 입력해 읽음 |
| **셸 없는 이미지** | `registry.k8s.io/pause:3.10`: `이 컨테이너에서는 읽을 수 없음` |
| **`pods/exec` 권한 없음** | `pods/exec`, `nodes/proxy`가 없는 ServiceAccount context: `pods/exec 권한이 없어 읽을 수 없음`, `nodes/proxy 권한이 없어` 안내 |

위 실행 뒤 프로브 단독 감시의 오래된 값 표시와 트리 칸 제목을 고치고 다시 빌드했다. 그 빌드로는 새로 넣은 단계만 실행했다(`--only-probe-repeat`). 메트릭이 없는 워크로드를 프로브 반복만으로 감시해 트리 행에 `프로세스 N`이 표시됨, PASS 1줄, 종료 코드 0. 앞의 9단계는 재실행하지 않았다.

첫 실행은 스크립트의 기대값 오류(지표 3개, 실제 4개)로 실패했고 기대값만 고쳤다.

### 단위·UI

KV.8과 합친 트리(`dev` 병합 전). `cargo fmt --all --check`, `cargo clippy -p dachsterm --all-targets --locked -- -D warnings`, `npm run typecheck`, `eslint src/features/kube`와 바꾼 스펙 통과. `cargo test -p dachsterm --lib --locked -- kube::` 133건, `vitest run src/features/kube` 274건 통과. Playwright `kube-workers`·`kube-dashboard` 24건 통과, 1건은 KV.8이 더한 대시보드의 `kube_ingress` 조회를 기대값에 넣지 않은 탓에 실패해 기대값을 고치고 그 1건만 재실행했다. `kube-tree`는 병합 전 트리에서 통과했다.

### 미확인

- `CLOSE_WAIT`와 FD·스레드 증가 판정은 단위 테스트까지다. 실제 파드로 재현하지 않았다.
- KV.8과 합친 뒤의 실제 앱 실행, 메트릭 HTTPS 후보(`prometheus.io/scheme: https`), 실제 운영 앱의 워커 메트릭, 파드 50개 상한, nginx master·worker 구분의 실제 파드 확인은 실행하지 않았다.
- `verify-kube-detail.mjs`의 파드 메뉴 기대값을 고쳤으나 재실행하지 않았다.
- Mac 실기기(`mac-verify`), CI(`main` 미반영), 전체 Rust·Playwright·네이티브 회귀는 실행하지 않았다.

## KV.6 간단 제어 검증 (2026-11-09)

대상: 브랜치 `feat/kv6-kube-control`, `e56215c` 기준 미커밋 트리. 환경: macOS(Apple Silicon)의 Docker, kind 전용 클러스터 `dachsterm-kv6`, `tests/openssh` 기반 OpenSSH 컨테이너(`scripts/kube-fixture.sh`).

### 실제 SSH·kind

`DACHSTERM_KUBE_FIXTURE=dachsterm-kv6 npm run test:kube-actions` 통과(`#[ignore]` 1건, 46초). 앱의 `Connections`로 실제 OpenSSH에 접속하고, 프로필 재확인(`permit`)과 `action::run`을 지나 kubectl이 실행된다. 결과는 `docker exec`로 따로 읽었다.

| 항목 | 확인한 결과 |
|---|---|
| 조회 모드 | 저장된 프로필이 `operate: false`면 서버에 가기 전 거부. 파드 변화 없음 |
| 소유 파드 삭제 | 30초 유예 파드인데 10초 안에 반환. Deployment가 새 파드로 교체 |
| 단독 파드 삭제 | 사라진 뒤 돌아오지 않음 |
| 정적 파드 삭제 | 미러 파드 UID가 바뀌어 약 1분 뒤 돌아옴. 컨테이너 ID 유지 |
| 롤아웃 재시작 | Deployment, StatefulSet, DaemonSet 모두 `restartedAt` 기록, 모든 파드 UID 교체 |
| Cordon | `spec.unschedulable=true`, 실행 중 파드 유지, 새 파드 Pending |
| Uncordon | 필드 해제, Pending 파드 배치 |
| RBAC 거부 | `view` 권한 계정에서 `Error from server (Forbidden): pods "..." is forbidden: User "system:serviceaccount:kv6-control:kv6-limited" cannot delete resource "pods" ...`를 그대로 반환. 파드 유지 |
| 없는 대상 | `Error from server (NotFound): pods "no-such-pod" not found`를 그대로 반환 |

첫 실행에서 정적 파드 복귀 대기(60초)가 실패했다. 유예 30초 뒤 약 1분이 걸리는 실제 동작이어서 대기를 180초로 늘리고, 컨테이너 ID가 다시 보고된 뒤 비교하도록 고쳤다.

### 단위·UI·게이트

- `cargo test -p dachsterm --lib --locked kube::action` 포함 전체 `cargo test --workspace --locked`: lib 551 통과, 1 실패, 2 무시. 실패한 `git_graph::tests::a_repositorys_signature_program_does_not_run`은 변경 없는 `e56215c`(worktree `dachsterm-verify-kv13`)에서도 같은 실패가 나며 KV.6과 무관하다.
- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm audit --audit-level=low` 통과.
- `npm test`: 100파일 1242건 통과.
- `npm run test:ui -- --workers=2`: 502 통과, 1 실패. 실패는 새 명령이 `kube-dashboard`의 "추가 요청 없음" 목록에 걸린 것으로, 테스트를 고친 뒤 해당 스펙과 `kube-actions`를 다시 실행해 통과했다(아래). 전체 재실행은 하지 않았다.
- `npm run format:check`: `scripts/test-phase63-67-native.mjs` 한 파일이 실패한다. 이 작업에서 바꾸지 않은 파일이고 `e56215c`에서도 같다. 그 때문에 `bash scripts/verify-macos.sh`는 이 단계에서 멈추므로, 나머지 단계를 위 명령으로 각각 실행했다.

### 미확인

- **실제 앱 화면으로 kind를 조작하는 검사.** 이 Mac에는 WKWebView 자동화 경로가 없다. 메뉴·확인창은 Playwright 픽스처, 백엔드는 위 실제 검사로 나눠 확인했고, 둘을 이은 앱 전체 동작은 사람이 보지 않았다. Windows `*-native.mjs` 검사도 작성·실행하지 않았다.
- Mac 실기기 항목(`mac-verify`), CI.

## KV.7 검증 (2026-11-09)

MacBook(darwin, Apple Silicon), 브랜치 `feat/kv7-kube-issues`를 KV.6이 합쳐진 `1cebc0b` 위로 올린 트리. **실제 앱 실행은 하지 않았다.** 쿠버네티스 네이티브 검사는 WebView2 전용이다.

**kubectl 실측(kind, `dachsterm-kv7`):** `templates.rs`의 PVCS·JOBS·HPAS 문자열을 그대로 읽어 `kubectl get ... -A -o go-template=`로 실행했다. 세 종류 모두 종료 0.

| 재현 | 출력 |
|---|---|
| 없는 StorageClass의 PVC | `kv7\tstuck-claim\tPending` |
| `backoffLimit: 0`의 실패 Job | `kv7\tbroken-job\t...\t\t2026-11-09T03:49:51Z;BackoffLimitExceeded` |
| CronJob에서 만든 실패 Job | `kv7\tnightly-1\t...\tCronJob/nightly,\t2026-11-09T03:49:52Z;BackoffLimitExceeded` |
| `maxReplicas: 1`의 HPA(metrics-server 없음) | `kv7\tapi\tDeployment\tapi\t1\t1` |

이 출력을 `kube/cluster_issues/tests.rs`의 입력으로 고정했다.

**자동 검사(위 트리에서 재실행):** `cargo fmt --all --check` 종료 0, `cargo test -p dachsterm --lib --locked kube::` 164건 통과(2건 ignored), `cargo clippy -p dachsterm --all-targets --locked -- -D warnings` 종료 0. 새 파서 테스트 9건 포함.

- `npm run typecheck` 종료 0, 바꾼 파일 eslint·prettier 종료 0, `npm run build` 종료 0.
- Vitest 전체 105파일 1,284건 통과.
- Playwright(Mac, Chromium) `kube-problems` 8건 포함 쿠버네티스 9개 스펙 122건 통과. WKWebView 결과가 아니다.
- `kube-tree`의 "polling stops" 기대값을 종류 수 증가에 맞춰 7에서 10으로 고쳤다.

**미확인:** 실제 앱의 화면과 OS 알림 표시(Windows·Mac), 앱에서 실제 SSH로 조회하는 경로, 실제 클러스터의 재시작·회복 변화 기록(순수 로직과 합성 데이터까지), 숨겨진 창의 타이머 제한 영향(WebView2 강한 타이머 제한, WKWebView App Nap으로 조회 간격이 늘 수 있다), 권한 없는 계정의 `pvcs`·`jobs`·`hpas`, `scripts/verify-kube-tree.mjs`의 조회 목록 수정분 실행, 대형 클러스터, CI.
## KV.10 검증 (2026-11-09)

대상: `feat/kv10-kube-vllm`의 미커밋 트리(기준 `7edabce`), 이 MacBook, Rust 1.99.1, Apple Git 2.50.1.

**이 환경에는 GPU와 실제 vLLM이 없다. 아래의 메트릭은 전부 대역이며 파서 검증까지만 인정한다.** 메트릭 이름, 라벨, 값의 의미가 실제 엔진과 맞는지는 확인하지 못했다.

| 범위 | 명령 | 결과 |
|---|---|---|
| 파서·탐지 단위 | `cargo test --workspace --locked --no-fail-fast` | 594 통과, 1 실패, 3 무시. 실패는 `git_graph::tests::a_repositorys_signature_program_does_not_run`이다. KV.10이 건드리지 않은 모듈이고 KV.13 기록의 실패와 같은 테스트다. 기준 커밋 재실행은 하지 않았다 |
| 프런트 단위 | `npm test` | 1308/1308 |
| 화면(백엔드 대역) | `npx playwright test` (Chromium) | 517 통과. `kube-ai.spec.ts` 6건 포함 |
| 정적 검사 | `npm run typecheck`, `npm run lint`, `npm run build`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings` | 통과 |
| 형식 검사 | `npm run format:check` | 경고 1건 `scripts/test-phase63-67-native.mjs`. KV.10 변경 밖이다 |
| 탐지·proxy 경로 | `DACHSTERM_KUBE_FIXTURE=kv10 npm run test:kube-ai` (kind, 앱의 SSH 연결 경로, busybox `httpd` 대역) | 통과 |

kind에서 확인한 것(대역 응답 기준):

- `AI_PODS` go-template이 실제 kubectl에서 동작하고, annotation·이미지·명령줄로 대상을 찾는다. 표시 없는 파드는 읽지 않는다.
- `get --raw` proxy 읽기가 조회 모드(`operate: false`)에서 동작한다.
- annotation이 `/admin/delete`를 가리키는 파드는 요청 자체가 가지 않는다. **파드의 `httpd` 로그에 해당 경로가 없다.**
- 지원 메트릭 없음, 잘못된 포트, 허용되지 않는 경로를 구분해 표시한다.
- namespace를 지정하면 vLLM은 그 안에서만, GPU exporter는 전체에서 찾는다.
- `view`만 가진 계정은 `pods/proxy`가 없어 권한 없음으로, 전체 목록 조회가 막히면 GPU 일부만 표시로 나온다.

**대기:**

- 실제 vLLM·DCGM exporter에서 메트릭 이름·라벨·값 확인(`vllm:*`, `DCGM_FI_DEV_*`), 처리 정지 판정의 실제 동작. GPU와 실제 엔진이 있는 환경에서 해야 한다.
- 실제 앱 화면(패키지 앱, WKWebView, WebView2). Playwright는 백엔드 대역이다.
- Mac 실기기(`mac-verify`), Windows 앱, CI.

## KV.13·KV.9 Mac 실기기 검증 (2026-11-09)

`mac-verify` 절차로 실행했다. 범위는 사용자가 지정한 SSH 세션의 실시간 로그, 요청 흐름, 중지 시 서버 `kubectl` 정리, 런타임 탭이다.

### 대상과 환경

| 항목 | 값 |
|---|---|
| 대상 커밋 | `e56215c`(KV.6 병합 전 `dev`), 별도 worktree에서 빌드 |
| Mac | macOS 26.5(25F71), arm64 |
| 도구 | Node 26.0.0, Rust 1.99.1(`/opt/homebrew/opt/rustup/bin`), Docker 29.8.0, kind 0.32.0 |
| 앱 | `npm run tauri -- build --debug --bundles app`로 만든 `.app`을 `open`으로 실행 |
| 접속 | 앱의 실제 SSH 접속 → `tests/openssh` 서버 컨테이너 → kind `kv13`, 데이터는 `DACHSTERM_TEST_DATA_DIR`로 격리 |
| 쿠버네티스 환경 | ingress-nginx v1.15.1, `kv13-logs`(ticker×2, quiet, web×2, other, traffic), `kv9-workers`(stuck, healthy, noshell) |

**화면 조작 방식:** 이 세션에는 데스크톱 제어 도구가 없고 `osascript`는 손쉬운 사용 권한이 없다. 그래서 프런트엔드 빌드 산출물에 조작 스크립트 하나를 주입하고 CSP에 `unsafe-eval`과 루프백 연결만 더한 **임시 빌드**를 만들어 WKWebView 안에서 조작했다. 소스와 Rust 코드는 위 커밋 그대로이고 임시 빌드는 삭제했다. 클릭은 DOM에 합성 이벤트를 보낸 것이고, 결과 판정은 화면 DOM과 서버 프로세스 목록이다. 앱 비밀번호는 fixture 값을 메모리로만 전달했다.

**서버 쪽 관측:** `docker exec kv13-ssh ps`를 1초마다 돌려 `kubectl ... logs -f` 프로세스와 `awk`, `sshd: probe@` 세션 수의 변화를 기록했다.

### 자동 게이트

`verify-macos.sh --package`는 `format:check`에서 중단되므로 같은 단계를 worktree(`e56215c`)에서 나눠 실행했다.

| 단계 | 결과 |
|---|---|
| `typecheck`, `lint`, `build`, `audit` | 종료 0, `audit` 0건 |
| `format:check` | **실패**: `scripts/test-phase63-67-native.mjs` 경고(KV.13 변경 밖, 기존과 동일) |
| `npm test` | 1229/1229 |
| `npm run test:ui -- --workers=2` | 496/496(Chromium) |
| `cargo fmt --check`, `clippy --workspace --all-targets -D warnings` | 종료 0 |
| `cargo test --workspace --locked` | **538 통과 1 실패** `git_graph::tests::a_repositorys_signature_program_does_not_run`("the fixture's signature program did not run", 기존과 동일) |
| `npm run tauri -- build --debug --bundles app` | 종료 0 |

`verify-macos.sh`는 `~/.cargo/bin`만 `PATH`에 넣는다. 이 Mac의 rustup은 Homebrew keg 전용이라 `/opt/homebrew/opt/rustup/bin`을 따로 지정해야 Rust 단계가 실행됐다.

`npm run probe`, `probe:phase1`은 범위 밖이라 실행하지 않았다.

### 합격 시나리오

KST 시각. 입력 감시(아래 "실제 입력과 겹침")는 런타임 단계부터 켰다.

| 항목 | 결과 |
|---|---|
| 실시간 로그 시작 | 워크로드 `ticker`, `quiet`를 고르자 칸 3개, 서버에 `kubectl logs -f` 3개(12:57:14). `awk` 3, SSH 세션 1 |
| 조용한 파드 | `quiet`의 새 줄이 약 20초 주기로 바로 도착(mawk 블록 버퍼링 회귀 없음) |
| 오류 색 | `ERROR` 줄 `kube-line error`(글자색 rgb(142,53,37)), 일반 줄 `kube-line normal` |
| **중지: 항목 빼기** | `ticker`, `quiet`를 빼자 시작 화면으로 돌아가고 서버 `kubectl` 0개, `awk` 0개(12:58:10). SSH 세션은 유지 |
| 요청 흐름 | `flow.local`의 **요청 흐름**: 위 **인그레스 컨트롤러** 칸은 `[kv13-logs-web-80] 요청만`, 아래 `web` 파드 2칸. 컨트롤러 칸에 `kv13flow` 17줄, `kv13other` 0줄, `web` 칸에 `response:200` 수신. 서버 `kubectl` 3개 |
| 4xx 색 | `/missing-N` 줄 `kube-line warn` |
| 전체 요청 | **전체 요청** 뒤 헤더 `모든 요청`, `kv13other` 줄 도착 |
| **중지: 요청 흐름** | 칩을 모두 빼자 서버 `kubectl` 0개(12:58:42) |
| 런타임 후보 | `stuck` 파드 우클릭 **런타임**: `:8080/metrics`, `지표 4개`, `annotation`. 목록에 `go_goroutines` 없음 |
| 워커 감시 | 메트릭 메뉴로 사용 중·전체·완료 수 지정, 판정 1분, **워커 감시 켜기**: 트리 행 `사용 8/8`, 이후 `⚠ 의심`, 제목 `반환 안 됨 의심`, `워커 포화 의심` |
| 프로브 | **수집** → `런타임 읽기` 확인창 → 실행: `httpd`, `8080`, `ESTABLISHED` 표시. 같은 워크로드 재수집은 확인창 없음 |
| 셸 없는 이미지 | `noshell`(`pause:3.10`): `이 컨테이너에서는 읽을 수 없음` |
| 롤아웃 추적 | `rollout restart deployment/ticker` 뒤 새 파드 칸이 추가되고 서버 스트림이 새 파드 2개로 교체(13:06:35), 잠시 뒤 옛 파드 칸이 사라짐 |
| **중지: 탭 닫기** | 쿠버네티스 탭을 닫자 서버 `kubectl` 0개, SSH 세션 0개(13:07:03) |

### 찾은 문제

- **스트림 재개 시 줄 중복 표시(이 검증 뒤 수정).** `ticker` 칸이 있는 상태에서 `quiet`를 추가해 스트림이 교체되자, `ticker-…-j2q9q` 칸에 `tick 460`과 `ERROR sample failure 460`이 두 번씩 표시됐다(둘 다 `12:57:13.241`). 서버 인자는 `--since-time=…03:57:13.241206845Z`였다. `src/features/kube/logBoardModel.ts`의 `LineStore.add`는 재개 지점을 `at < from.at || time === from.time`으로 판정한다. 그래서 재개 지점과 나노초만 다른 같은 밀리초의 앞줄이 통과하면 그 뒤로 재개 상태가 풀리고, 재개 지점의 줄까지 다시 들어간다. `LineStore.add`가 같은 밀리초 안에서는 소수부 전체를 비교하도록 고치고, 수정 전에 실패하는 재현 테스트를 `logBoardModel.test.ts`에 넣었다. 수정 뒤 실제 앱과 kind로는 다시 실행하지 않았다(위 표의 앱 결과는 `e56215c`의 것이다).

### 관찰

- **창이 가려지면 감시 조회가 멈춘다.** VS Code 창이 앱을 완전히 덮었을 때 WKWebView의 `document.visibilityState`가 `hidden`이었고, 설계대로 워커 감시 조회가 멈춰 `의심` 판정이 나오지 않았다(13:04:41 확인). 앱을 앞으로 가져오자 곧 판정이 표시됐다.
- **실제 입력과 겹침.** 런타임 단계부터 `isTrusted` 입력을 기록했다. 13:01:55~13:02:01과 13:05:21~13:05:34에 실제 마우스 클릭이 들어와 화면이 바뀌었고, 해당 구간의 조작(런타임 첫 시도, 롤아웃 첫 시도)은 입력이 멈춘 뒤 다시 실행했다. 표의 런타임·롤아웃·탭 닫기 결과는 입력이 없던 구간의 것이다. 실시간 로그·요청 흐름 단계는 입력 기록 전에 실행했고, 서버 프로세스 시각이 조작 시각과 일치한다.

### 미확인

- 실제 마우스·키보드 조작(합성 이벤트만), 화면 모양(스크린샷 없음, 화면 기록 권한 없음).
- Mac에서 대시보드의 워커 판정 표시, `pods/exec` 권한 없는 계정, 프로브 단독 감시, 호스트 우클릭 메뉴의 요청 흐름.
- 소스 20개 상한, 초당 3000줄 상한, 12시간 상한.
- Windows 실제 앱(KV.13), CI, `dev` 이후 커밋(KV.6)과 합친 트리의 앱.

## KV.13 구현 경과 (병합 전 기록)

`docs/progress.md` 상단에 있던 내용을 옮긴 것이다. "미커밋", "현재" 표현은 병합 전 시점 기준이다.

**KV.13 실시간 로그 보드·화면 개선: 프런트엔드 구현·Playwright 통과 / Rust 컴파일·실제 클러스터·Mac 실기기 미검증** — 브랜치 `feat/kv13-kube-workbench`(`b343613` 기준 미커밋), [설계안](design/kubernetes-workspace.md#kv13--실시간-로그-보드와-화면-개선). 사용자 요청: 상세 패널 마우스 리사이즈, 로그 크게 보기, 여러 파드 동시 보기, 인그레스→서비스 파드 로그 동시 보기, UI 품질. **원인과 수정:** 패널 리사이즈가 안 된 것은 `.resize-handle`이 그리드 칸에서 폭을 받는데 쿠버네티스 분할은 flex라 폭이 0px이었기 때문이다(측정값 0, 로그 검색의 분할도 같은 원인). 새 화면 **실시간 로그**: 서비스·워크로드·노드·파드·인그레스 컨트롤러를 골라 파드별로 나눠 보거나 시간순으로 합쳐 보고, 칸 크게 보기, 글자 크기, 줄바꿈, 일시정지, 필터, 경고·오류만을 제공한다. 인그레스 호스트 행의 **요청 흐름**은 컨트롤러 로그(upstream으로 좁힘)를 위에, 서비스 파드를 아래에 연다. 롤아웃으로 파드가 바뀌면 스트림을 교체해 마지막 시각부터 잇는다. 파드 패널에 크게 보기와 오류 색, 트리 메뉴에 진입점을 넣었고 헤더·트리·대시보드·인그레스를 다듬었다(`문제만` 글자 세로 깨짐 수정). 명령 `kube_log_stream` 추가(취소는 `kube_log_cancel` 공용, SSH 채널 하나에 최대 20개). 파일: `src-tauri/src/kube/log_stream.rs`, `src/features/kube/LogBoard.tsx`, `LogLines.tsx`, `LogBoardPicker.tsx`, `logBoardModel.ts`, `useLogBoard.ts`, `logBoard.css`, `tests/ui/kube-board.spec.ts`. 실제 클러스터 검사에서 **mawk가 파이프 입력을 블록으로 모아 읽어 조용한 파드의 로그가 나오지 않는 버그**를 찾아 고쳤다(`-W interactive` 선택, 한 줄 한 번에 쓰기). `scripts/kube-fixture.sh`는 호스트의 kubectl 대신 kind 노드의 Linux kubectl을 넣게 고쳐 Mac에서도 동작한다(WSL 경로 재실행은 안 함). 검사 `npm run test:kube-stream`(fixture 필요, `--ignored`) 추가. 결과(미커밋 트리, 이 MacBook, Rust 1.99.1): `verify-macos.sh`의 단계를 나눠 실행해 typecheck·lint·`npm test` 1229/1229·`npm run build`·`cargo fmt --check`·`cargo clippy --workspace --all-targets -D warnings`·`npm audit` 0건 통과. 실제 kind(`test:kube-stream`, `docker exec -i`로 서버 셸 실행): 여러 파드 수신, 서버 필터, 없는 파드의 오류 보고, stdin 종료 시 kubectl 0개 통과. mawk에서 3KB 줄 8만 개 동시 쓰기 깨짐 0. **게이트 실패 3건, 모두 이번 변경 밖:** ① `format:check` 경고 `scripts/test-phase63-67-native.mjs`(`origin/dev`와 동일, 이 때문에 스크립트가 중단돼 나눠 실행). ② Playwright 479 통과 1 실패 `session-form.spec.ts:45`(Mac에서 행 배치, 수정 전 `b343613`에서도 동일 실패). ③ `cargo test --workspace` 538 통과 1 실패 `git_graph::tests::a_repositorys_signature_program_does_not_run`(Apple Git 2.50.1, 건드리지 않은 모듈이며 기준 커밋 재실행은 안 함). **미검증:** 실제 SSH 채널 위의 스트림과 취소(`docker exec`로 대체해 스크립트까지만 확인), 앱 화면과 실제 백엔드의 연결(Playwright는 백엔드 대역), 패키지된 앱의 화면 동작(`npm run tauri -- build --debug --bundles app` 종료 0, `open`으로 프로세스와 창 생성까지 확인, 화면 기록 권한이 없어 창 내용은 못 봄), Mac WKWebView, Windows 앱, CI, 사용 안내서. 사용자 실기기 지적 후속(같은 브랜치, 미커밋): ① 글꼴 스택에 Mac 글꼴 추가(`foundations.ts`, M.7). ② `select`를 `appearance: none`으로 직접 그려 Mac에서 입력칸보다 납작하던 문제 수정(`styles.css`). ③ 새 연결의 `접속 후 화면`을 전체 폭으로 수정(`WorkspaceField.tsx`), 위 게이트 실패 ②의 원인이었고 `session-form.spec.ts:45`는 Chromium·WebKit 모두 통과. 결과: Chromium의 `session-form`·`terminal-font`·`themes`·`kube-board`·`kube-ingress` 42/42, `npm test` 1229/1229, `.app` 재빌드 종료 0. 전체 Playwright를 수정 ②까지 적용해 WebKit으로 돌린 결과는 462 통과 18 실패다: Tab 포커스(Safari 기본 동작) 10건은 `layout`·`session-manager`·`themes`·`session-form:71`, 나머지는 `games` 3건, `port-tools` 클립보드 권한 1건, `layout:45`, `themes:92`, `workspace:87`이며 ③의 대상이던 `session-form:45`는 위와 같이 해결했다. `layout:45`, `themes:92`, `workspace:87`, `games`는 원인을 확인하지 않았다. WebKit 결과는 WKWebView 실기기 결과가 아니다. ④ 사용자 캡처: Mac 앱의 SSH 키 만들기 창에서 본문이 접혀 제목과 버튼만 보였다. Playwright WebKit(27.2)에서는 재현되지 않았고, `.dialog-body`의 `flex: 1`(0% 기준)을 `flex: 1 1 auto`로 바꿨다(사용자가 Mac 앱에서 정상 표시를 확인). 재발 방지로 `ssh-key.spec.ts`에 기준값 검사를 넣었다. 결과: `ssh-key`·`session-form`·`agent-launch`·`tools`·`themes` 32/32(Chromium), 두 엔진에서 새 연결·설정·SSH 키 창 크기 유지, `.app` 재빌드 후 실행. ⑤ WebKit 실패 분석: `layout:45`는 재실행 통과(일시적), `workspace:87`은 앱 시작 전에 값을 쓰는 테스트 타이밍(대기 후 두 엔진 동일). 실제 버그 2건 수정: 게임 일시정지가 WebKit에서 바로 재개되던 문제(`games/shared.tsx`, 클릭해도 버튼에 포커스가 가지 않아 게임판 blur가 먼저 일시정지), 저장소 쓰기 실패 시 앱이 사라지던 문제(`App.tsx` 효과 2곳, 새 `lib/saveSetting.ts`). WebKit에서 `games`·`themes:92` 재실행 6/6 통과. ⑥ 쿠버 UI: 대시보드 순서를 현황·재시작·미달 워크로드 먼저로 변경, 표본 2개 전에는 추세 차트 숨김, 노드 행 폭, 상세 탭 여백·표 머리·이벤트 경고색. 결과(미커밋 트리): lint·typecheck 오류 출력 없음, `npm test` 1229/1229, Playwright Chromium 전체 480/480, `.app` 재빌드·재실행. WebKit Tab 포커스 10건은 미수정(기본 동작으로 판단, Mac 전체 키보드 접근 설정의 실기기 확인은 안 함). 로그 검색 화면은 구조 변경 없음. 사용자 확인(2026-11-09, 이 MacBook의 디버그 `.app`, kind `kv13`에 실제 SSH 접속): 쿠버네티스 화면이 "잘 보인다"고 확인했다. 화면별 세부 항목(요청 흐름의 스트림, 중지 시 서버 kubectl 정리)은 따로 확인하지 않았다. 다음 첫 행동: 사용자 요청 시 커밋하고 `dev`에 병합한다. 이어서 SSH 세션의 실시간 로그와 요청 흐름을 확인한다.
