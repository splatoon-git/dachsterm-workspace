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
