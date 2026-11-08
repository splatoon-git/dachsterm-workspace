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
