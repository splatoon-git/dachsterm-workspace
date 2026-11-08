# 도구 메뉴와 네트워크 도구 검증 기록

설계 정본은 [설계안](../design/tools-menu.md)이다.

## TL.0 실측 (2026-11-08)

대상 커밋: `dev`의 `b1b5c36`. 제품 코드는 바꾸지 않았다.

### 환경과 방법

- **이 PC:** Windows 11 Pro 10.0.26300, Docker Desktop 28.5.1(WSL2 엔진).
- **프로브:** 저장소 밖의 일회용 Rust 크레이트. 제품과 같은 `russh =0.65.1`, 저장소의 `vendor/ssh-key` 패치, `Cargo.lock`을 쓴다. 저장소에 넣지 않았다.
- **서버:** `debian:bookworm-slim`에 `openssh-server`(`1:9.2p1-2+deb12u10`)를 넣은 컨테이너. 포트별로 `AllowTcpForwarding`·`PermitOpen`·`DisableForwarding`를 달리한 `sshd`와 fd 제한(`ulimit -n` 64·1024) `sshd`를 띄웠다.
- **대상:** 같은 Docker 네트워크의 컨테이너. `iptables`로 REJECT(5종)·DROP을 만들었고, 경로 없음은 `ip route`의 `unreachable`·`blackhole`·`prohibit`, 쓰지 않는 주소(ARP 무응답)로 만들었다.
- 컨테이너와 네트워크(`dachsterm-tl0-*`)는 끝나고 지웠다.

응답 시간은 Docker Desktop 포트 전달을 거친 값이다. 절대값이 아니라 분류를 위해서만 쓴다.

### 1. `direct-tcpip` 실패 구분

`russh::Error::ChannelOpenFailure`의 사유와 `Handler::channel_open_failure`로 받은 설명. 한 연결에서 시도 1개씩만 실행했다(n은 사례별 횟수).

| 사례 | n | 사유 | 서버 설명 | 응답 ms (최소/중앙/최대) |
|---|---|---|---|---|
| 열린 포트 | 7 | 열림 | — | 0.7 / 0.8 / 41.8 |
| 포트 닫힘(RST) | 7 | `ConnectFailed` | `Connection refused` | 0.7 / 0.9 / 39.8 |
| REJECT `tcp-reset` | 7 | `ConnectFailed` | `Connection refused` | 0.7 / 0.8 / 39.6 |
| REJECT `icmp-port-unreachable` | 7 | `ConnectFailed` | `Connection refused` | 1.0 / 1.0 / 940.3 |
| REJECT `icmp-host-unreachable` | 7 | `ConnectFailed` | `No route to host` | 933.0 / 941.6 / 966.4 |
| REJECT `icmp-net-unreachable` | 7 | `ConnectFailed` | `Network is unreachable` | 47.4 / 941.4 / 966.2 |
| REJECT `icmp-admin-prohibited` | 7 | `ConnectFailed` | `No route to host` | 26.6 / 944.8 / 965.9 |
| 같은 대역의 빈 주소(ARP 무응답) | 3 | `ConnectFailed` | `No route to host` | 2829.8 / 2835.5 / 2842.8 |
| 경로 `unreachable` | 7 | `ConnectFailed` | `open failed` | 3.0 / 17.5 / 59.1 |
| 경로 `blackhole` | 7 | `ConnectFailed` | `open failed` | 9.5 / 18.6 / 47.9 |
| 경로 `prohibit` | 7 | `ConnectFailed` | `open failed` | 8.1 / 15.1 / 48.2 |
| 이름 해석 실패 | 5 | `ConnectFailed` | `Name or service not known` | 16.0 / 39.0 / 171.0 |
| DROP(서버가 포기할 때까지) | 3 | `ConnectFailed` | `Connection timed out` | 약 123,965 |
| `AllowTcpForwarding no` | 7 | `AdministrativelyProhibited` | `open failed` | 8.1 / 9.4 / 43.1 |
| `AllowTcpForwarding remote` | 7 | `AdministrativelyProhibited` | `open failed` | 1.6 / 7.4 / 55.2 |
| `DisableForwarding yes` | 7 | `AdministrativelyProhibited` | `open failed` | 1.2 / 6.3 / 40.9 |
| `PermitOpen none` | 7 | `AdministrativelyProhibited` | `open failed` | 1.8 / 7.1 / 46.6 |
| `PermitOpen` 목록 밖 | 7 | `AdministrativelyProhibited` | `open failed` | 4.3 / 15.3 / 62.8 |
| `PermitOpen` 목록 안 | 7 | 열림 | — | 9.9 / 21.5 / 57.9 |

결론:

- **사유 코드만으로는 닫힘과 경로 없음이 구분되지 않는다.** 전부 `ConnectFailed`다. 설계의 "구분 불가" 판단은 사유 코드 기준으로는 맞다.
- **설명 문자열로는 구분된다.** OpenSSH가 connect 오류를 그대로 보낸다. 다만 설명은 `Handler::channel_open_failure`에만 오고 `channel_open_direct_tcpip`의 결과에는 없다. Handler가 받는 채널 ID를 호출자는 알 수 없어, **동시에 여러 개를 열면 어느 시도의 설명인지 대응시킬 수 없다.** 위 표처럼 하나씩 열 때만 대응된다.
- **응답 시간으로는 구분할 수 없다.** ICMP 도달 불가가 빠르게 오기도 하고(최소 26.6ms), 같은 `Connection refused`도 ICMP로 올 때는 최대 940ms 걸렸다.
- `open failed`는 두 종류를 뜻한다. 포워딩 금지(`AdministrativelyProhibited`)일 때는 고정 문구이고, `ConnectFailed`일 때는 서버가 connect를 시작조차 못 한 경우(즉시 실패하는 경로, 아래 fd 고갈)다.
- 이 설명은 OpenSSH 9.2p1에서 확인한 값이다. 다른 SSH 서버 구현은 측정하지 않았다.

### 2. 시간 초과로 포기한 뒤 늦게 열린 채널

대상 포트를 DROP으로 막고 시작한 뒤 클라이언트가 1초 만에 포기하게 하고, DROP을 풀어 늦게 열리게 했다. `ss`로 서버 쪽 소켓을 셌다.

| 실험 | 처리 | 결과 |
|---|---|---|
| A | open 미래를 `timeout`으로 드롭 | **누수.** 서버 `SYN-SENT` 1개 → 해제 뒤 `ESTABLISHED` 1개. 40초 뒤에도 서버·대상 모두 연결이 살아 있다. 연결을 끊자 0.21초 뒤 0개 |
| B | 별도 태스크가 open을 소유하고 늦게 성공하면 `close()` | 누수 없음. 표시 시간 초과 뒤 태스크가 살아 있다가 `close() -> Ok`, 0.21초 뒤 서버 연결 0개, SSH 연결은 유지 |
| C | 8개를 드롭한 뒤 대기 | 서버 `SYN-SENT` 8개가 5초 뒤에도 유지. 연결을 끊자 0.20초 뒤 0개 |
| D | 4개를 드롭하고 서버가 포기할 때까지 대기 | 약 123초 뒤 `SYN-SENT` 0개, Handler가 `Connection timed out` 4건 수신. 세션은 살아 있고 새 채널도 열린다 |

결론:

- **open 미래를 드롭하면 안 된다.** russh는 드롭된 수신측으로 `Open`을 보내다 실패해도 무시하고 채널을 닫지 않는다.
- 닫는 방법은 둘이다. ① open을 태스크가 끝까지 소유하다가 늦게 성공하면 `close()`. ② 연결 끊기(0.2초). 서버가 응답하기 전의 채널을 닫는 메시지는 SSH 프로토콜에 없다.

### 3. 한 연결의 동시 `direct-tcpip` 상한

`MaxSessions`는 기본값이다. 대상은 열린 포트, 시도는 동시에 시작했다.

| 조건 | n | 결과 |
|---|---|---|
| fd 제한 없음(65536) | 16 ~ 16,384 | 전부 열림(16,384개 8.1초) |
| fd 제한 없음 | 20,000 | 열림 6,586, `ConnectFailed`/`open failed` 7,905, 시간 초과(30초) 5,509 |
| 닫힌 포트 | 4,096 | 전부 `ConnectFailed`/`Connection refused` (217ms) |
| `ulimit -n 1024` | 900 | 전부 열림 |
| `ulimit -n 1024` | 1100, 2048 | **1,016개만 열림**, 나머지 `ConnectFailed`/`open failed` |
| `ulimit -n 64` | 32 | 전부 열림 |
| `ulimit -n 64` | 64, 128 | **56개만 열림**, 나머지 `ConnectFailed`/`open failed` |
| DROP, 3초 포기, 제한 없음 | 4,096 | 전부 시간 초과, 서버 `SYN-SENT` 4,096 |
| DROP, 3초 포기, `ulimit -n 1024` | 1100 | 시간 초과 1,016, `ConnectFailed`/`open failed` 84 |

- **프로토콜 상한은 사실상 없다**(16,384 통과). 실제 상한은 서버 프로세스의 fd다. 설정값보다 약 8개 적게 쓸 수 있다.
- **응답 없는 대상은 포기해도 서버 fd를 그대로 쥐고 있다.** Linux 기본 재전송(`tcp_syn_retries=6`)으로 약 124초다.

단순 스캐너의 결과(동시 16, 3초 포기, DROP 포트, `ulimit -n 64`, 18초):

```text
t=  8s attempts=32 syn_sent=48
t= 10s attempts=9119 syn_sent=56
t= 17s attempts=112814 syn_sent=56
outcomes {"ConnectFailed": 115192, "client timeout": 56}
handler tally {"ConnectFailed / open failed": 115192}
session alive true; new open: ConnectFailed
```

fd가 차는 순간부터 모든 시도가 즉시 `ConnectFailed`로 끝난다. 사유 코드만 보면 **전부 "닫힘"으로 표시되고** 같은 연결의 다른 채널도 열리지 않는다. 계산(재실행 측정 아님): 서버가 약 124초에 포기하므로 `ulimit -n 1024`에서 동시 16·3초 포기는 미해결 약 661개에서 평형을 이뤄 고갈되지 않고, 시간 초과를 1초로 낮추면 약 63초 뒤 고갈된다. 더 낮은 fd 제한이나 다른 채널이 있으면 3초에서도 고갈될 수 있다.

서버가 응답할 때까지 권한을 쥐는 상한(semaphore)으로 다시 실행했다.

| 조건 | 결과 |
|---|---|
| `ulimit -n 64`, 동시 16, 상한 32, 15초 | 시간 초과 32건, `ConnectFailed` 0건, `SYN-SENT` 최대 32, 새 채널 열림, 끊자 0.20초 뒤 0개 |
| `ulimit -n 1024`, 동시 16, 상한 256, 60초 | 시간 초과 256건, `ConnectFailed` 0건, `SYN-SENT` 최대 256, 새 채널 열림, 끊자 0.18초 뒤 0개 |

상한에 닿으면 서버가 포기할 때까지 새 시도가 멈춘다. 계산으로는 전체가 DROP인 4,096회 작업이 상한 없이 약 13분, 상한 256에서 약 31분 걸린다(재실행 측정 아님). 전체 DROP인 대규모 작업은 드물고, 대신 fd가 적은 서버에서 잘못된 결과를 내지 않는다.

### 4. 서버 이미지별 도구

공식 이미지 그대로, 그리고 `openssh-server`만 더 설치한 뒤 확인했다. 결과는 두 경우가 같았다. 컨테이너 이미지는 최소 구성이라 실제 서버보다 도구가 적다는 하한으로 읽는다.

| 이미지 | `ss` | `lsof` | `netstat` | `traceroute` | `tracepath` | `bash` | `nc` | `/proc/net/tcp` |
|---|---|---|---|---|---|---|---|---|
| Alpine 3.22 | 없음 | BusyBox | BusyBox | BusyBox | 없음 | 없음 | BusyBox | 읽힘 |
| Debian 12 slim | 없음 | 없음 | 없음 | 없음 | 없음 | 있음 | 없음 | 읽힘 |
| Ubuntu 20.04, 24.04 | 없음 | 없음 | 없음 | 없음 | 없음 | 있음 | 없음 | 읽힘 |
| Rocky Linux 9 | 없음 | 없음 | 없음 | 없음 | 없음 | 있음 | 없음 | 읽힘 |

일반 계정(uid 1000) 동작. Alpine 3.22 기본 상태와 도구를 설치한 Alpine·Debian 12·Ubuntu 24.04·Rocky 9에서 확인했다. Docker 기본 capability에서 실행했다.

| 명령 | 일반 계정 결과 |
|---|---|
| `/proc/net/tcp` | 모든 이미지에서 다른 사용자 소켓까지 읽힌다 |
| `ss -H -ltnp` | 모든 소켓이 나오지만 프로세스 이름은 **자기 소유만** |
| `netstat -ltnp` (net-tools, BusyBox) | 위와 같음. BusyBox도 자기 소유 이름은 준다 |
| `lsof -nP -iTCP -sTCP:LISTEN` | lsof 정식판은 **자기 소유 소켓만** 나온다. BusyBox `lsof`는 옵션을 무시하고 fd 목록만 출력해 쓸 수 없다 |
| `traceroute -n` | 정식판은 동작. BusyBox는 `socket: Operation not permitted`로 실패 |
| `traceroute -T` | 정식판은 권한 부족으로 실패. BusyBox는 옵션 자체가 없다 |
| `traceroute -I` | 정식판은 동작(`ping_group_range`가 열린 Docker 환경 기준). BusyBox는 실패 |
| `tracepath -n` | 있으면 동작(Alpine 기본에는 없음) |
| `nc -z -w 2` | 열림 종료 코드 0. **닫힘과 응답 없음이 모두 1**이라 코드만으로 구분되지 않는다(BusyBox·OpenBSD·Ncat) |
| `bash` `/dev/tcp` | 열림 0, 거부 1(`Connection refused`), 응답 없음은 `timeout`이 끊어 124 또는 143. **구분된다** |

root 계정: Debian 12와 Alpine(정식 `traceroute` 설치) `traceroute -T -n -p`는 열린 포트·닫힌 포트 모두 대상까지 도달하고 DROP은 `*`로 끝났다. Alpine 기본(BusyBox)은 `-T`가 없다.

### 5. Windows 일반 권한

이 PC는 내장 Administrator 계정(UAC 꺼짐)이다. 비교를 위해 `runas /trustlevel:0x20000`으로 Administrators가 거부 전용인 토큰으로도 실행했다. 이 토큰의 무결성 수준은 **High 그대로**이므로 실제 표준 사용자 계정과 같지 않다. 표준 사용자 계정 결과는 대기다.

| 항목 | 관리자 토큰 | Administrators 거부 전용 토큰 |
|---|---|---|
| `GetExtendedTcpTable`(IPv4·IPv6 listener) | 성공, 51·11개, 0.4ms | 성공, 51·11개, 0.3ms |
| 고유 소유 PID | 28 | 28 |
| `OpenProcess`+`QueryFullProcessImageNameW` | 27/28 (`System`은 오류 31) | **14/28** (나머지 오류 5, 서비스 프로세스) |
| `CreateToolhelp32Snapshot`의 실행 파일 이름 | 28/28 | **28/28** |
| `IcmpSendEcho` TTL 1~15로 1.1.1.1 경로 추적 | 14홉 도달, 상태 11013(TTL 초과), 마지막 0 | 14홉 도달(11홉째 11010 시간 초과 1건, 한 번 시행) |

- 소켓 목록과 ICMP 경로 추적은 권한 없이 동작한다.
- 프로세스는 **Toolhelp 스냅숏으로 이름을 얻는다.** 전체 경로는 일반 권한에서 일부만 얻을 수 있다.

### 6. 인증서 해석 크레이트

저장소의 매니페스트와 `Cargo.lock`을 복사한 작업 폴더에서 비교했다. 저장소에는 추가하지 않았다. `audit-windows`는 그 폴더에서 저장소 스크립트로 실행했다.

| 항목 | `x509-cert =0.3.0` | `x509-parser =0.18.1` |
|---|---|---|
| `cargo tree` 기준 Windows 그래프에 새로 들어오는 크레이트 | **3개**(`x509-cert`, `der_derive`, `flagset`) | 11개(`nom`, `asn1-rs` 등) |
| `cargo metadata` 기준 새 항목(`generate-notices`가 쓰는 그래프) | 6개 | 11개 |
| `audit-windows` | 0건 | 0건 |
| 고지용 라이선스 문서가 크레이트에 있는가 | 전부 있음 | `asn1-rs-impl` 없음(`--fetch-missing` 필요) |
| 라이선스 | Apache-2.0 OR MIT(`flagset`은 Apache-2.0) | MIT/Apache-2.0 계열(`nom`, `synstructure`는 MIT) |
| 샘플 파싱 | RSA·P-256·Ed25519·만료·한글 주체·SAN 200개·실제 서버 2종 성공 | 동일 |
| 손상 입력(빈 파일·잘린 DER·잘못된 길이·임의 바이트) | 오류, 패닉 없음 | 오류, 패닉 없음 |
| 파싱 예제 실행 파일 크기(`none` 146,944 바이트 기준) | 412,672 | 454,656 |

`der`, `spki`, `const-oid`가 이미 잠금 파일에 있어 `x509-cert`의 증가분이 작다. **`x509-cert =0.3.0`을 쓴다.** 주체 문자열 순서는 두 크레이트가 반대이므로(`x509-cert`는 RFC 4514 표기) 화면 표시는 항목별로 뽑아 쓴다.

### 7. Mac

`/usr/sbin/lsof`, `/usr/sbin/traceroute -P tcp`의 일반 권한 동작은 **대기**다. MacBook 실기기가 필요하다.

### 미검증

- 다른 SSH 서버 구현(Dropbear, Windows OpenSSH 서버)의 실패 설명.
- 실제 표준 사용자 계정의 Windows 결과(위 5번 토큰은 무결성 High).
- Mac 전체(7번).

### 제품 코드에서 확인한 것

`src-tauri/src/tunnels.rs:180`과 `src-tauri/src/ssh.rs:369`도 `channel_open_direct_tcpip`를 `timeout`으로 드롭한다. 2번 A 실험과 같은 경로다. 이번 범위에서는 고치지 않았다.

## TL.2·TL.5 도구 탭과 셸 없는 연결

대상: 커밋 전 트리(`dev` `b5846ac`에서 갈라진 `feat/tl5-network-base`). 합격 기준은 [설계안 §8](../design/tools-menu.md#8-순서와-검증)이다.

### 자동 검사

| 명령 | 범위 | 결과 |
|---|---|---|
| `npm run typecheck` | 전체 | 종료 0 |
| 바꾼 파일 `npx eslint`, `npx prettier --check` | 바꾼 파일 | 종료 0 |
| `cargo fmt --all --check`, `cargo clippy -p dachsterm --all-targets --locked -- -D warnings` | Rust | 종료 0 |
| `cargo test -p dachsterm --lib --locked net_tools` | 미사용 시간, 재사용 해제 | 5/5 |
| `npx vitest run src/features/tools` | 출발지 상태, 재선택, 늦은 연결 정리 | 10/10 |
| `npx vitest run src/app/workspaceLayout.test.ts` | 도구 탭의 열기·이동·분할·닫기·재시작 | 69/69(새 4건) |
| Playwright `tools.spec.ts` | 메뉴 순서, 탭 하나, 출발지 목록, 카드, 마스터 암호 대기 | 7/7 |
| Playwright `navigation`, `tunnels`, `ssh-key` | 기존 메뉴와 터널 위치 | 15/15 |
| Playwright `file-tab.spec.ts -g "tools menu"` | 도구 메뉴의 문서 편집기 | 5/5 |

전체 Vitest·Playwright와 `verify-windows.ps1` 전체는 바꾼 범위 밖이라 돌리지 않았다.

### 실제 SSH (Windows 실제 앱, Docker OpenSSH)

`npm run test:network-base`(`scripts/test-network-base-native.mjs`, `verify-windows.ps1 -Native`에 연결), 컨테이너 `dachsterm-tl5-network-*`. 종료 0.

| 확인 | 결과 |
|---|---|
| 호스트 키 거부, 틀린 암호, 정상 로그인이 도구 탭 안의 카드로 처리됨 | 통과 |
| 로그인 뒤 서버의 `sshd: probe` 1개, `@pts` 없음, 셸 0개, 터미널 탭 0개 | 통과 |
| 자동 시작이 켜진 터널이 있는 세션에서 도구 연결은 터널을 시작하지 않음. 같은 세션의 터미널 연결은 시작함 | 통과 |
| 저장된 암호가 있으면 카드 없이 연결 | 통과 |
| 연결된 터미널 재사용: 로그인 1개, 셸 1개 유지, 카드 없음. 목록에 `연결됨` 표시 | 통과 |
| 재사용 중인 도구 탭을 닫아도 터미널 유지, 터미널이 끝나면 도구가 종료를 표시 | 통과 |
| 경유 경로: 두 단계 인증 카드, 신규 호스트 키, 로그인 2개, PTY·셸 없음, 탭 닫으면 0개 | 통과 |
| 탭을 닫으면 서버 쪽 로그인이 사라짐 | 통과 |
| 같은 세션 재선택이 미사용 시간을 다시 재고, 지나면 닫힘(시험값 6초, `DACHSTERM_TEST_NET_IDLE_SECONDS`는 debug 빌드 전용) | 통과 |

이 검사가 잡은 결함: 암호 응답 뒤 호스트 키 질문이 오면 답한 인증 카드가 남았다. `applyLinkEvent`를 고치고 단위 테스트를 넣었다.

### 터미널 연결 회귀

| 명령 | 결과 |
|---|---|
| `node scripts/run-phase1.mjs --native --reuse-build` | 종료 0, PASS 77줄. 최초 호스트 키, 비밀번호·키·에이전트·추가 인증, 5탭, 분리 창, 재접속, 재시작, 마스터 암호, 변경된 호스트 키 차단 |
| `node scripts/run-phase1.mjs --native --jumps --reuse-build` | 종료 0. 경유 인증 카드, 두 호스트 키 카드, 실제 PTY |
| `node scripts/run-ftp.mjs --native-only --reuse-build` | 종료 0, PASS 6줄. FTP·FTPS 탭(같은 `start_route`를 지남) |
| `node scripts/run-phase1.mjs --native --skip-app-build` (제품 엔진 프로브) | **종료 1.** `credential_checks/mod.rs:336`의 `one card for an LFS push`(카드 0장, push는 성공). 그 앞 PASS 46건은 통과 |

프로브 실패는 **변경 전 커밋 `b5846ac`에서 같은 줄, 같은 값, 같은 PASS 46건으로 재현**돼 이번 변경의 회귀가 아니다. Git 자격 증명 코드는 바꾸지 않았다. 원인은 조사하지 않았다. 이 실패로 프로브의 그 뒤 항목(앱에 저장한 토큰 등)은 양쪽 모두 실행되지 않았다.

### 미검증

- Mac 실기기, CI.
- 실제 5분 미사용(시험값으로만 확인).
- 분리 창의 터미널 재사용. 코드 경로는 같지만 실행하지 않았다.
