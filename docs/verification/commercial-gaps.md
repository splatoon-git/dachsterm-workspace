# 상용 제품 대비 보완(CG) 검증 기록

설계는 [design/commercial-gaps.md](../design/commercial-gaps.md), 범위는 [roadmap §26](../roadmap.md)이다.

## CG.0 실측 (2026-11-16)

- 환경: MacBook(Apple Silicon, macOS 27.2), Docker Desktop 엔진 29.8.0, Rust 1.99.1, Node 26.0.0. 대상 코드 `dev` `52cb524`.
- **제품 코드 변경 없음.** 저장소에 넣은 것은 검사 환경(`tests/connect-fixture/`, `scripts/connect-fixture.mjs`, `npm run connect:fixture`)뿐이다.
- 실측 프로그램은 저장소 밖의 독립 크레이트다(TL.0과 같은 방식). 앱과 같은 조건으로 맞췄다: `russh =0.65.1`(`default-features = false`, `ring`만), 저장소 `Cargo.lock` 복사, `[patch.crates-io] ssh-key = vendor/ssh-key`, 앱의 `rsa_auth.rs`를 `#[path]`로 그대로 포함. `serialport` 4.10.1만 추가했다.
- 비밀은 일회성 `init` 컨테이너가 만들고 OS 임시 폴더(0700, 개인키 0600)로 복사했다. 실측 프로그램은 파일에서 읽고 출력하지 않는다.
- **Windows는 실행하지 않았다.** Pageant, Windows ProxyCommand, com0com, VcXsrv는 대기다.

### 검사 환경

| 서비스 | 내용 | 호스트 포트 |
|---|---|---|
| `target` | OpenSSH 9.2(bookworm), X11Forwarding, `TrustedUserCAKeys`, lrzsz 0.12.21, trzsz 1.1.7. **내부 망에만 있다** | 없음 |
| `jump` | `target`과 같은 이미지, 두 망에 연결 | 42222 |
| `edge` | tinyproxy 1.11.1(Basic, CONNECT는 22번만), microsocks 1.0.3(사용자·암호 필수), inetutils telnetd(inetd), Xvfb(:0, TCP, 쿠키), 시리얼 콘솔 대역(socat이 PTY 위 bash를 TCP 7000에 노출) | 43128, 41080, 42323, 46000, 47000 |
| `init` | 사용자·프록시 암호, X 쿠키, 호스트 키, CA, 인증서 4종(정상 Ed25519·RSA, 만료, 다른 주체) | 없음 |

`npm run connect:fixture -- up` 종료 0(`--wait`로 `jump`, `edge` Healthy). 이 Mac의 Docker VM에 다른 kind 클러스터 9개가 떠 있어 컨테이너 시작과 `docker exec`가 수 분씩 걸렸다. 아래 시간 값은 이 부하의 영향을 받는다.

### 1. russh 0.65.1 API (소스 확인)

| 항목 | 결과 |
|---|---|
| `client::connect_stream` | `AsyncRead + AsyncWrite + Unpin + Send + 'static` 아무 스트림. `connect`도 내부에서 이것을 부른다 (`client/mod.rs:1188-1260`) |
| `AgentClient::connect_pageant` | **`cfg(windows)`에서만 존재. 기능 플래그 없음.** russh `Cargo.toml`의 `[target."cfg(windows)".dependencies.pageant] 0.2`. 저장소 `Cargo.lock`에 `pageant 0.2.5`가 이미 있고 `cargo tree --target x86_64-pc-windows-msvc -i pageant -e features`에서 기본 기능 `namedpipes`·`wmmessage`가 켜져 있다 |
| Pageant 전송 순서 | 이름 있는 파이프 `\\.\pipe\pageant.<사용자>.<CryptProtectMemory 후 SHA-256>`(50ms×40회 재시도) → 실패하면 `FindWindowW("Pageant")` + `WM_COPYDATA`(공유 메모리 8KiB) |
| Pageant 없음 판정 | `wmmessage::PageantStream::new()`는 창을 찾지 않고 항상 성공한다. **창이 없다는 오류는 첫 요청(`request_identities`)에서 난다** |
| `WM_COPYDATA` 호출 | `tokio::spawn` 안에서 `SendMessageA`를 동기 호출한다. Pageant가 응답할 때까지 작업자 스레드 하나가 묶인다 |
| `authenticate_openssh_cert(user, Arc<PrivateKey>, Certificate)` | 존재. 서명은 `PrivateKey`의 `Signer` 구현, 알고리즘 이름은 인증서 알고리즘 그대로 |
| `authenticate_certificate_with(user, cert, hash, signer)` | 존재. 앱이 에이전트 안 인증서에 이미 쓴다 |
| `Channel::request_x11` | 존재(`want_reply`, `single_connection`, 프로토콜, 쿠키 문자열, 화면 번호) |
| `Handler::server_channel_open_x11` | 존재. **기본 구현이 `reply.accept()`**. 앱 `Host`는 이를 구현하지 않는다 |

### 2. 프록시 경유 `connect_stream` (CG.1)

| 시나리오 | 결과 |
|---|---|
| HTTP CONNECT `target:22` + Basic → `connect_stream` → 암호 인증 → `hostname` | 성공, `target`. 응답 `HTTP/1.0 200 Connection established`, 헤더 `Proxy-agent` 하나 |
| SOCKS5(방법 `00 02` → 사용자 인증) 도메인 `target` | 성공, `target`. 내부 망 이름을 프록시가 풀었다(ATYP 3) |
| 프록시 경유 세션 위 `direct-tcpip` | 성공(SSH 배너 읽음). 터널·SFTP는 같은 핸들을 쓰므로 경로가 같다 |
| SOCKS5 → `jump` 키 인증 → `direct-tcpip target:22` → `connect_stream` → 암호 | 성공, `target`. 프록시와 경유지 조합 |
| HTTP 인증 헤더 없음 | `HTTP/1.0 407 Proxy Authentication Required`, `Proxy-Authenticate: Basic realm="Tinyproxy"` |
| HTTP 암호 틀림 | **`HTTP/1.0 401 Unauthorized`**, `WWW-Authenticate`(tinyproxy는 407이 아니라 401을 쓴다) |
| HTTP 허용 안 된 포트(23) | `HTTP/1.1 403 Access violation` |
| HTTP 없는 호스트 | `HTTP/1.1 500 Unable to connect` |
| SOCKS5 인증 없이 | 방법 응답 `05 FF` |
| SOCKS5 암호 틀림 | 인증 응답 `01 02` |
| SOCKS5 없는 호스트 | 응답 코드 1(일반 실패, 4가 아님) |
| SOCKS5 닫힌 포트 | 응답 코드 5(연결 거부) |

- CONNECT 응답 헤더는 바이트 단위로 빈 줄까지만 읽었다. 그 뒤는 바로 SSH 배너다.
- 시간: 터널 수립까지 HTTP 6.6~15.6초, SOCKS5 0.2~0.6초(각 3회). tinyproxy 로그에서 한 요청 안의 단계 사이가 0.5~4초씩 벌어져 있어 DNS가 아니라 Docker VM CPU 부하로 본다. 프록시 자체 성능은 이 환경에서 판단하지 않는다.

### 3. ProxyCommand (CG.2)

`/bin/sh -c "exec <명령>"`, 환경 변수는 비우고 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`(Finder 실행 앱과 같음)과 `HOME`만 둔 뒤 표준 입출력을 `tokio::io::join`으로 `connect_stream`에 넘겼다. `kill_on_drop(true)`.

| 명령 | 결과 | 연결 종료 뒤 자식 | 표준 오류 |
|---|---|---|---|
| `nc 127.0.0.1 42222` | 성공, `jump` | 종료 0 | 없음 |
| `ssh -i plain … -p 42222 -W target:22 probe@127.0.0.1` | 성공, `target` | 종료 0 | 없음 |
| `socat - TCP:127.0.0.1:42222`(이름만) | `Disconnected`(10ms) | 종료 127 | `/bin/sh: line 0: exec: socat: not found` |
| `/opt/homebrew/bin/socat - TCP:…`(절대 경로) | 성공, `jump` | 종료 0 | 없음 |

결론: 최소 `PATH`에서는 Homebrew 프로그램 이름이 실패한다. 앱은 `login_path`가 합친 `PATH`를 쓰므로 실제 패키지 앱에서 다시 확인해야 한다(CG.10). 실패 이유는 표준 오류에만 있어 사용자에게 보여주려면 보관이 필요하다.

### 4. 인증서 (CG.3)

| 키·방법 | 결과 | 서버 로그 |
|---|---|---|
| Ed25519 인증서, `authenticate_openssh_cert` | `Success` | `Accepted publickey … ED25519-CERT` |
| RSA 인증서, `authenticate_openssh_cert` | `Failure` | **`signature algorithm ssh-rsa-cert-v01@openssh.com not in PubkeyAcceptedAlgorithms`** |
| RSA 인증서, `authenticate_certificate_with` + 앱 `RsaSigner` + SHA-512(`best_supported_rsa_hash` = `Sha512`) | `Success` | `Accepted publickey … RSA-CERT` |
| 만료 인증서 | `Failure`(일반) | `Certificate invalid: expired` |
| 다른 주체 인증서 | `Failure`(일반) | `Certificate invalid: name is not a listed principal` |
| ssh-agent(호스트 OpenSSH 10.5)의 RSA·Ed25519 인증서, `authenticate_certificate_with` | 둘 다 `Success` | |

- `authenticate_openssh_cert`는 해시를 고를 수 없어 RSA는 SHA-1 이름으로 나간다. RSA는 서명기 경로가 필요하다.
- 만료·주체 불일치는 클라이언트에 이유가 오지 않는다. 앱이 연결 전에 판정해야 사용자에게 이유를 보여줄 수 있다.
- 부수 관찰: 인증에 성공한 핸들로 다시 인증을 요청하면 응답이 오지 않았다(실측 프로그램의 첫 실행). 앱은 성공 뒤 더 시도하지 않으므로 영향 없음.

### 5. X11 (CG.9)

`jump`에 암호로 로그인 → 세션 채널 `request_x11(true, false, "MIT-MAGIC-COOKIE-1", <임의 16바이트>, 0)` → `xdpyinfo` 실행. `server_channel_open_x11`에서 수락하고 접속 설정 패킷을 읽어 Xvfb(127.0.0.1:46000)로 중계했다.

| 모드 | 결과 |
|---|---|
| 가짜 쿠키를 실제 쿠키로 바꿔 전달 | `x11-req` 응답 `Success`, 서버 `DISPLAY=localhost:10.0`, 채널은 `::1`에서 열림, 설정 패킷 바이트 순서 `l`·프로토콜 `MIT-MAGIC-COOKIE-1`·16바이트·가짜 쿠키와 일치, `xdpyinfo`가 `The X.Org Foundation` 표시, 116/10032바이트 중계 |
| 바꾸지 않고 전달 | `Invalid MIT-MAGIC-COOKIE-1 key`, `unable to open display` |

서버 쪽 `xauth list`에는 가짜 쿠키만 있다. 요청하지 않은 X11 채널을 서버가 여는 경우는 OpenSSH로 만들 수 없어 실행하지 않았다(소스상 기본 수락).

### 6. 터미널 안 전송 표식 (CG.8)

PTY(`xterm-256color`)로 실행한 뒤 처음 96바이트:

| 명령 | 출력 |
|---|---|
| `sz sample.bin` | `rz\r**\x18B00000000000000\r\x8a\x11` |
| `rz` | `rz waiting to receive.**\x18B0100000023be50\r\x8a\x11` |
| `tsz sample.bin` | `\x1b7::TRZSZ:TRANSFER:S:1.1.7:9480343880100:43823\r\r\n` |
| `trz` | `\x1b7::TRZSZ:TRANSFER:R:1.1.7:9480344648200:37549\r\r\n` |

- ZMODEM 헤더 끝의 `\x8a`는 8비트 바이트다. 출력을 텍스트로 디코딩하면 깨진다.
- trzsz는 `ESC 7`(커서 저장) 뒤에 표식이 오고 방향(`S`/`R`)·버전·고유 번호가 붙는다. Python trzsz는 시작에 2.5초 넘게 걸렸다(부하 환경).

### 7. Telnet (CG.4)

inetutils telnetd가 보낸 요청(순서대로): `WILL AUTH`, `WILL ENCRYPT`, `DO TTYPE`, `DO TSPEED`, `DO XDISPLOC`, `DO NEW-ENVIRON`, `DO OLD-ENVIRON`, `SB TTYPE SEND`, `WILL SGA`, `DO ECHO`, `DO LINEMODE`, `DO NAWS`, `WILL STATUS`, `DO LFLOW`, `WILL ECHO`, `DO TIMING-MARK(6)`, `DO BINARY(0)`.

응답: `DO TTYPE`·`DO NAWS`만 `WILL`(TTYPE `XTERM-256COLOR`, NAWS 120×40), 서버 `WILL SGA`·`WILL ECHO`는 `DO`, 나머지는 `WONT`/`DONT`. 결과: 로그인 성공, `tput cols` = `120`, `TERM=xterm-256color`, `exit` 후 서버 종료. 출력 줄 끝은 `\r\n` 12회, `\r\0` 1회.

### 8. 시리얼 (CG.5)

`npm run connect:fixture -- serial`(호스트 socat 1.8.1.3이 `/dev/ttys002`를 만들고 컨테이너 7000번에 연결) → `serialport` 4.10.1.

| 항목 | 결과 |
|---|---|
| `available_ports()` | `/dev/cu.*`·`/dev/tty.*`의 debug-console, Bluetooth-Incoming-Port. **socat PTY는 목록에 없다** |
| 115200으로 열기 | **실패 `Not a typewriter`(ENOTTY).** macOS에서는 속도를 `IOSSIOSPEED` ioctl로 설정하는데 PTY가 지원하지 않는다(크레이트 주석과 일치) |
| 속도 0으로 열기 | 성공. `echo serial-$((40+2))` → `serial-42`, 장치 대역의 `device>` 프롬프트 |
| `set_break`/`clear_break` | 둘 다 `Ok`. PTY라 실제 Break 신호 여부는 확인 불가 |
| 열린 뒤 `set_baud_rate(9600)` | `Not a typewriter` |
| socat 종료(장치 분리 흉내) | 읽기가 `BrokenPipe` 오류로 즉시 끝남(`Ok(0)` 아님), 이후 쓰기도 `BrokenPipe` |

결론: macOS PTY로는 입출력·분리 처리만 검증할 수 있다. 속도·Break·흐름 제어는 실제 USB 시리얼 장치가 필요하다.

### 9. 자동 업데이트 (CG.6, 실행 없음)

crates.io·GitHub 공개 API 조회: `tauri-plugin-updater` 2.14.1(2026-10-28)·2.14.0(2026-10-14), 요구 `tauri ^2.12`(앱 2.12.5), `reqwest ^0.13`(앱 `Cargo.lock`에 0.13.5 있음), `minisign-verify ^0.3`, Windows `zip ^9`, `windows-sys ^0.61`(앱 0.61.2와 같음). 저장소는 인증 없이 조회되는 공개 저장소이고 릴리스는 0개다. `tauri.conf.json`에 `plugins` 절이 없다.

### 10. 하이라이트 비용 (CG.7)

Node 26.0.0(V8, WebView2와 같은 엔진 계열). ANSI 색이 섞인 로그형 출력 8MiB를 32KiB 프레임으로 나눠 규칙별 `exec` 반복:

| 조건 | 처리량 | 32KiB 프레임당 |
|---|---|---|
| 규칙 0개, ANSI 제거만 | 139 MiB/s | 0.22ms |
| 키워드 규칙(`\bWARN(ING)?\b`, `\btimeout\b` 등) 하나 | 2.4~8.9 GiB/s | — |
| `\bERROR\b` 하나 | 151 MiB/s | — |
| IPv4 패턴 하나(일치 63,978개) | 61 MiB/s | — |
| 대표 규칙 10개 | 20 MiB/s | 1.53ms |
| 10개를 하나의 교대식으로 합침 | 15 MiB/s | — |
| 50개(무거운 패턴 반복 포함) | 2 MiB/s | 14.9ms |

결론: 비용은 규칙 수보다 **일치 수와 무거운 패턴**이 정한다. 합친 정규식은 빠르지 않았다. WKWebView(JavaScriptCore)는 재지 않았다.

### 남은 것

- Windows: Pageant(PuTTY 0.75 이상 파이프, 이전 `WM_COPYDATA`), `connect_pageant` 호출부 컴파일, Windows ProxyCommand(`CreateProcessW`, `ssh.exe -W`), com0com·실제 COM 포트, VcXsrv 인증 없는 X11.
- Mac: 실제 USB 시리얼 장치의 속도·Break, XQuartz Unix 소켓 `DISPLAY`, 패키지 앱(Finder 실행)의 ProxyCommand `PATH`.
- 실제 업데이트 동작(서명 없는 앱의 Keychain·Gatekeeper·SmartScreen)은 CG.6 구현 뒤.

## CG.1 프록시 경유 접속 (2026-11-16, `feat/cg1-proxy`)

### 구현

- 프로필 `proxy`(`storage/proxy.rs`): `{kind: http|socks5, host, port, username, secretRef}`. SSH만, 경유지가 있는 세션은 거부(첫 경유지에 지정), 사용자 이름·암호 255바이트. 경유지 구간의 두 번째 이후 홉에 프록시가 있어도 쓰지 않는다(그 홉의 TCP는 앞 홉이 연다).
- 암호 참조는 `ForwardKey.secretRef`와 같은 방식이다. 폼이 보낸 값은 무시하고, 같은 종류·호스트·포트·사용자일 때만 저장된 참조를 유지한다. `save_session`의 `proxySecretAction`(`keep`/`replace`/`forget`)으로 저장·삭제하고, 떠난 참조는 `credential_gc`로 회수한다. 마스터 암호 변경(`vault.rs`)과 정리(`cleanup_credentials`)가 프로필 JSON 안의 참조를 함께 다룬다(`Profile::data_refs`). **설계와 다른 점:** 프런트엔드는 `hasSecret` 대신 `secretRef`를 받는다(전달 키와 같은 방식이며, 값을 보내도 백엔드가 무시한다).
- 연결(`ssh/first_hop.rs`): `route::open`의 첫 TCP 연결만 바꿨다. HTTP는 응답 헤더를 빈 줄까지 1바이트씩 읽고(16KiB 상한), SOCKS5는 이름을 프록시가 풀도록 ATYP 3으로 보낸다. 저장된 암호가 없으면 `프록시 암호` 입력을 연결 때 묻는다. 상태 메시지는 `연결됨 · SOCKS5 프록시 경유 (호스트:포트) → …`. 프로필 시간 제한 하나가 프록시 TCP와 협상을 덮는다. 열린 탭과 저장된 프록시가 다르면 `connect`가 거부한다.
- 세션 교환 v4(`settings::CURRENT_VERSION`): 내보내기는 프록시 암호 참조를 지우고, 가져오기는 v3 이하의 `proxy`와 파일 안의 `secretRef`를 거부한다. 병합은 같은 프록시일 때 저장된 암호를 유지한다. 스키마 `session-format.schema.json`을 v4로 올리고 v3를 `session-format.v3.schema.json`으로 남겼다.
- 가져오기(`session_transfer/proxy.rs`): OpenSSH `nc [-X 5|connect] -x 호스트[:포트] [-P 사용자] %h %p`, PuTTY `ProxyMethod` 2·3. SOCKS4·Telnet·로컬 명령·SSH 프록시는 경고와 함께 제외하고, `ProxyJump`와 함께 있으면 `ProxyJump`만 쓴다. 그 밖의 `ProxyCommand`는 지금처럼 제외한다(CG.2). `session_transfer.rs`는 순증 없이(비테스트 802 → 797줄) 하위 모듈로 옮겼다.
- 화면: 세션 폼 고급 옵션의 `프록시` 칸(`ProxyField.tsx`, 순수 로직 `proxy.ts`). 사용자 이름이 있을 때만 암호 칸이 보이고, 암호를 입력하면 보관 방식이 `저장`으로 바뀐다. FTP로 바꾸면 프록시를 지운다.

### 검증 (Mac, 미커밋 트리)

| 검사 | 결과 |
|---|---|
| 단위: 협상(`first_hop_tests.rs`, `tokio::io::duplex`로 CG.0 응답 고정) | HTTP Basic 요청 바이트, 헤더 뒤 배너 보존, 401/407/403/500/400, 헤더 16KiB 상한, IPv6 대괄호, SOCKS5 `00 02`·사용자 인증·ATYP 1/3/4·바인드 주소 읽기, `05 FF`·`01 02`·응답 2/1/5 통과 |
| 단위: 저장(`storage/proxy.rs`, `settings.rs`) | JSON 형태와 미지 필드 거부, SSH·경유지·필드 검증, 폼이 고른 참조 무시, 같은 프록시만 참조 유지, 잊기·삭제·변경의 회수 기록, 사용 중 참조 보존, v4 내보내기에 참조 없음·가져오기 성공·v3 거부·참조 위조 거부·v5 거부 |
| 단위: 가져오기(`session_transfer/proxy.rs`) | nc 4형식 변환, SOCKS4·다른 옵션·다른 위치 인자·`ncat`·`ssh -W` 제외, ProxyJump 우선 경고, PuTTY 0/2/3 변환과 1/4/5/6 제외 |
| 프런트엔드 | Vitest `proxy.test.ts`, Playwright `session-form.spec.ts`의 프록시 칸(종류별 기본 포트, 사용자 이름이 있을 때만 암호, 입력 시 저장으로 전환, FTP 전환 시 제거) |
| **실제 환경 `npm run probe:connect`**(새 검사, `connect:fixture` 필요) | 제품 엔진으로 아래 전부 통과 |

`npm run probe:connect` 출력:

```text
PASS HTTP CONNECT (asked password): terminal, SFTP, Local tunnel, monitoring
PASS SOCKS5 (saved password, name resolved by the proxy): terminal, SFTP, Local tunnel, monitoring
PASS SOCKS5 → jump → target: terminal, SFTP, Local tunnel, monitoring
PASS proxy errors: wrong password (HTTP 401, SOCKS 01 02), auth required (407, 05 FF), port refused (403), unknown host (500, SOCKS 1), closed proxy port
```

- `target`은 내부 망에만 있어 프록시나 경유지가 아니면 닿지 않는다. 터미널에서 `hostname` = `target`, SFTP `/` 목록, Local 터널로 대상 sshd 배너(`SSH-`), 모니터링 2회 수집을 각 연결에서 확인했다.
- 오류 문구는 설계 §CG.1 표 그대로 나왔다(문자열 포함 비교).
- 게이트(미커밋 트리, `verify-macos.sh` 단계): typecheck·lint·format 통과, Vitest 1387/1388(게임 `survivor/stages.test.ts`의 30/60/120Hz 시험이 부하 평균 35~46에서 5초 제한 초과, `--testTimeout=60000` 단독 재실행 17/17 통과, 이 변경과 무관), build, Playwright 537, `cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings`, `cargo test --workspace` 711(무시 4)+1, `npm audit` 0건, 의존성 감사, 고지 532개. 첫 실행은 lint(`react-hooks/immutability`: 고쳐 쓰는 ref 속성 이름)로 멈춰 이름을 `passwordRef`로 바꾸고 다시 돌렸다.

### 대기

- Windows: 네이티브 검사 `test-proxy-native.mjs`와 `verify-windows.ps1 -Native` 연결, Windows 실행.
- Mac 패키지 앱에서 사람이 세션 폼으로 프록시를 지정해 터미널·SFTP·터널·모니터링을 여는 확인(WKWebView 자동 검사 경로 없음, CG.10).

