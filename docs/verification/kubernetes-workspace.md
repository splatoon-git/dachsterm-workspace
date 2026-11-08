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
