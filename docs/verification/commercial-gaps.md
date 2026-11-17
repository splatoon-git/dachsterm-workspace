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

## CG.7 하이라이트·트리거 (2026-11-16, 브랜치 `feat/cg7-highlight-triggers`)

### 구현

- 규칙 저장: `highlights.rs`(`settings` 표 `highlight_rules_v1`, 최대 64개, revision 비교). 새 명령 `highlight_rules`, `highlight_rules_save`(engineering-rules §5 네 곳 등록). 저장 뒤 `highlight-rules` 이벤트로 모든 창이 다시 읽는다. 손상된 저장 값은 빈 목록이 아니라 오류.
- 입력 보내기 제한(백엔드·프런트엔드 둘 다): 확인 시각(`confirmedAt`)이 없으면 거부, 패턴에 `password`·`passwd`·`passphrase`·`암호`·`비밀번호`·`비번` 글자가 있으면 거부(정규식 기호를 걷어낸 뒤 비교, `p.ssword`·`pass(word)?`도 잡힘). 프런트엔드는 추가로 패턴을 실제 프롬프트 표본(`Password:`, `[sudo] password for user:`, `Enter passphrase…`, `Verification code:`, `암호:` 등)에 돌려 일치하면 끈다. 보낼 텍스트는 1KiB, Tab·줄바꿈 외 제어문자 거부. 비밀 참조를 넣을 방법은 없다.
- 그리기: xterm `registerDecoration`의 `foregroundColor`. xterm 6에서 이 API가 proposed라 `allowProposedApi: true`로 바꿨다. 출력 바이트는 바꾸지 않는다. 색은 테마의 터미널 팔레트 토큰(위험=red, 주의=yellow, 성공=green, 정보=blue, 강조=magenta)에서 얻고, 테마를 바꾸면 기존 데코레이션을 다시 등록한다.
- 매칭: `onWriteParsed` 뒤 16ms로 묶어, 지난 묶음의 커서 줄부터 지금 커서 줄까지(최대 1,000행) 버퍼에서 논리 줄(줄바꿈된 행 결합, 넓은 글자 셀 위치)을 읽어 창 공용 Web Worker로 보낸다. 커서 줄은 다음 묶음에서 다시 읽고, 그 줄의 알림·입력은 한 번만 낸다. 대체 화면 버퍼(vim 등)에서는 하지 않는다.
- 상한: 묶음당 데코레이션 200개, 탭당 2,000개(오래된 것부터 제거), 초당 4MiB를 넘으면 일시 중지하고 상태바에 `하이라이트 일시 중지`(규칙이 있는 탭만). Worker 묶음이 첫 규칙 시작부터 100ms를 넘으면 Worker를 종료하고 그때 돌던 규칙을 끄고(저장된 규칙도 `enabled: false`로 저장) 탭에 알린다. 저장 때 표본 출력(로그형 줄과 같은 글자 512개 반복)으로 같은 제한을 미리 재서 `^(a+)+$` 같은 패턴은 저장을 거부한다.
- 알림: 탭 상태 메시지 + 이 터미널에 포커스가 없을 때 OS 알림(`appNotificationLimiter`, `notificationBody`). 입력 보내기: 같은 탭 10초에 1번, `broadcast_status`를 그때 물어 동시 입력 그룹에 든 탭이면 보내지 않음, 출력 재생 중 보내지 않음, 보낸 뒤 `트리거 입력: <규칙 이름>`.
- 화면: 설정 → 터미널의 `하이라이트` 절(목록·켜기·수정·삭제, 편집 폼, 입력 보내기 경고 확인), 탭 헤더 우클릭 `이 탭에서 하이라이트 끄기/켜기`(규칙이 있을 때만). 다시 켜면 그 시점 커서부터 본다.

### 측정 (`npm run measure:highlight`, Mac, 부하 평균 약 40에서)

앱의 터미널 창(`tests/ui/fixtures/terminal-pane`)에 ANSI 색·한글이 섞인 로그 줄을 32KiB 프레임으로, 쓰기 콜백 뒤 다음 프레임(ACK 방식)으로 보냈다. 규칙 10개는 모든 줄에 여러 개가 일치하는 최악 쪽 구성이다.

| 엔진 | 규칙 | 연속 32MiB | 일정 속도 3MiB/s 5초: 달성, 프레임 p50/p95 |
|---|---|---|---|
| Chromium | 0 | 5.7 MiB/s | 3.00 MiB/s, 5.1/6.7ms |
| Chromium | 10 | 3.2 MiB/s(일시 중지 안 걸림) | 2.99 MiB/s, 8.8/13.7ms |
| WebKit | 0 | 3.6 MiB/s | 3.00 MiB/s, 8.0/11.0ms |
| WebKit | 10 | 2.1 MiB/s | 1.89 MiB/s, 16.0/25.0ms |

해석: 다른 세션의 빌드로 부하가 매우 높아 절대값은 낮다. 규칙을 켜면 일치가 많은 출력에서 그리기 비용(셀마다 따로 그려지는 데코레이션)이 늘어 Chromium 약 45%, WebKit 약 40% 느려졌다. 연속 출력이 하이라이트 비용 때문에 4MiB/s 아래로 내려가면 일시 중지가 걸리지 않는다(속도 기준이 출력 속도라서). 부하가 낮은 환경에서 다시 재고, 필요하면 일시 중지 기준을 프레임 지연으로 바꾸는 것을 검토한다(대기). 실제 WKWebView 앱 안의 값은 CG.10.

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


## CG.3 인증 확장: 인증서 파일·Pageant (2026-11-16, `feat/cg3-auth`)

### 구현

- 프로필 `certPath`(개인키 세션만, 4096바이트)와 `agentSource`(`system`|`pageant`, 기본 `system`, SSH만)를 더했다(`storage/login.rs`). 세션 교환 v4에 그대로 내보내고, v3 이하 파일에 있으면 거부한다. `certPath`는 다른 키 경로처럼 네트워크 경로를 가져오지 않는다. 열린 탭과 둘 중 하나가 다르면 `connect`가 거부한다.
- 인증서(`ssh_cert.rs`): `certPath`, 없으면 `<keyPath>-cert.pub`. 연결 전에 사용자 인증서인지, 개인키와 짝인지, 유효 기간(`valid_after ≤ 지금 < valid_before`)을 확인한다. 주체 목록에 사용자가 없으면 경고만 하고 시도한다. **지정한 인증서**가 맞지 않으면 연결하지 않고, **키 옆에서 찾은 인증서**가 맞지 않으면 알린 뒤 키만으로 로그인한다(OpenSSH와 같은 동작, 설계안보다 구체화). 서명: Ed25519·ECDSA는 `authenticate_openssh_cert`, RSA는 `authenticate_certificate_with` + `RsaSigner` + SHA-512(거부되면 SHA-256). 서버가 인증서를 거부하면 키만으로 다시 시도한다.
- Pageant(`agent_relay::open`): `pageant`이면 Windows에서 `AgentClient::connect_pageant`, 다른 OS에서는 `Pageant는 Windows에서만 쓸 수 있습니다.` 키 목록 실패나 빈 목록은 `Pageant가 실행 중이 아니거나 키가 없습니다.` 에이전트 전달(`agent_forward`)도 같은 출처를 쓰고, 로컬 탭의 에이전트(DX.13)는 지금처럼 `system`이다.
- 가져오기(`session_transfer/login.rs`): OpenSSH `CertificateFile`(첫 값) → `certPath`(제외 목록에서 뺐다), PuTTY `DetachedCertificate` → `certPath`. 개인키가 없는 세션이나 `%`·`$`·`~` 경로는 경고 후 비운다. OpenSSH `IdentityAgent`가 Pageant를 가리키면 경고만, Windows가 아닌 PC에서 `pageant` 세션을 가져오면 경고한다. `CertificateFile`이 여러 줄이어도 경고는 하지 않는다(가져오기가 지시문마다 첫 값만 읽는 구조라 설계안의 "여러 줄 경고"는 넣지 않았다). `session_transfer.rs` 비테스트는 802줄 그대로다.
- 화면: 개인키 칸 아래 `인증서 파일 경로 (선택)`(`LoginKeyField`), 인증 방식이 에이전트일 때 `인증 에이전트: OpenSSH ssh-agent | Pageant · Windows 전용`(`AgentLoginField`).

### 검증 (Mac, 미커밋 트리)

| 검사 | 결과 |
|---|---|
| 단위 `ssh_cert` | ssh-keygen으로 만든 CA·인증서: 정상, 주체 경고, 만료, 시작 전, 주체 없음, 호스트 인증서, 다른 키. 지정 인증서는 오류, 키 옆 인증서는 건너뜀·알림, 없는 파일·형식 오류, UTC 날짜 |
| 단위 `storage/login`, `settings`, `session_transfer/login` | 필드 검증·JSON, v3 파일의 `agentSource` 거부, 인증서 가져오기 조건과 Pageant 경고 |
| Playwright `session-form.spec.ts` | 개인키에서만 인증서 칸, 에이전트에서만 Pageant 선택 |
| **실제 환경 `npm run probe:connect`** | 아래 출력. `cert_*` 키는 `authorized_keys`에 없어 인증서로만 로그인된다 |

```text
PASS certificates: Ed25519 beside the key, RSA named (SHA-2), Ed25519 through SOCKS5
PASS certificate checks: expired (named: local error; beside: skipped, key refused), other principal (warning, refused), wrong pair
```

- 게이트(미커밋 트리, `verify-macos.sh`와 같은 단계): typecheck·lint·format, Vitest 1410/1410(부하 때문에 처음부터 `--testTimeout=60000`), build, Playwright 542, `cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings`, `cargo test --workspace` 722(무시 4)+1, `npm audit` 0건, 의존성 감사, 고지 532개.

- `dev`(CG.4 병합 6201ee3)를 합친 트리에서 다시: Vitest 1414/1414(`--testTimeout=60000`), Playwright 543, `cargo test --workspace` 732(무시 5)+1, clippy·fmt, `npm audit` 0, 의존성 감사, 고지 532개, `probe:connect` 여섯 줄 모두 통과.

(같은 실행에서 CG.1의 네 줄도 통과.) 이번 실행에서 검사 환경의 tinyproxy가 CONNECT마다 18~37초(직접 잰 값, CG.0은 6~16초)를 써서, 검사 프로필의 시간 제한을 30초에서 최대값 120초로, 검사의 이벤트 대기를 150초로 늘렸다. 제품 코드의 문제는 아니다(SOCKS5와 경유지는 빠르다).

### 대기

- **Pageant 전부(Windows):** `cfg(windows)` 경로 컴파일, PuTTY 0.75 이상(이름 있는 파이프)과 이전 방식(`WM_COPYDATA`) 로그인, Pageant 없음 문구, 확인 창 동안의 동작, 에이전트 전달. 이 Mac에서 `cargo check --target x86_64-pc-windows-msvc`는 `ring`의 C 빌드가 Windows 헤더(`assert.h`)를 찾지 못해 실행할 수 없었다.
- Mac 패키지 앱에서 사람이 인증서 세션을 만들고 연결하는 확인(CG.10).

## CG.4 Telnet 탭 (2026-11-16, 브랜치 `feat/cg4-telnet`)

### 구현

- 백엔드 `telnet.rs`: TCP 연결(프로필 `timeout`) → `Event::Data`. 출력은 SSH 터미널과 같은 `terminal_output::pump`(`Source` 구현)로 보내 32KiB 프레임·ACK·30초 정지 규칙을 공유한다. 세션 로그(`logs.register`·`auto_start`, 키 `ssh:<프로필 ID>`), 스니펫·동시 입력·창 분리는 `Connections::terminal_ready`(SSH는 핸들, Telnet은 연결된 스트림)로 열었다. 서버가 닫으면 `closed`.
- 옵션 협상 `telnet/protocol.rs`(순수 함수): 서버 `WILL ECHO`·`WILL SGA`·`WILL BINARY` → `DO`, `DO TTYPE`(SB로 `XTERM-256COLOR`)·`DO NAWS`(바로 현재 크기)·`DO BINARY` → `WILL`, 나머지는 `DONT`/`WONT`. 상태가 바뀔 때만 답한다(RFC 1143, 반복 요청에 무응답). 출력에서 IAC 시퀀스를 걷어내고 읽기 경계에 걸친 시퀀스를 이어 붙인다. BINARY가 아니면 서버의 `CR NUL`의 NUL을 지운다. 입력은 `0xFF`를 `FF FF`로, 홀로 있는 `\r`을 `\r\0`으로. 크기 변경은 NAWS(255 이스케이프). 하위 협상은 512바이트, 협상 응답 대기열은 256개로 제한하고 넘치면 연결을 끊는다.
- 암호 저장·자동 로그인 없음(사용자 결정): 프로필 검증이 `protocol = "telnet"`에 `auth = "interactive"`, 빈 키 경로만 허용하고 사용자 이름은 비워도 된다. 연결 화면은 암호를 묻지 않고, 로그인은 터미널에서 친다.
- 경고: 세션 폼에서 Telnet을 고르면 프로토콜 바로 아래에 `Telnet은 암호를 포함한 모든 입력을 암호화하지 않고 보냅니다…`, 상태 메시지 `연결됨 · Telnet · 암호화 없음 · 호스트:포트`, 상태바 `Telnet · 암호화 없음`, 연결 목록 `TELNET` 표시.
- 프런트엔드: `transport.ts`의 `telnetTransport`(kind `telnet`, 폴더 훅·Git 도우미·조작표·에이전트·링크 없음, 크기는 `terminal_resize`), `sessionKind`에 `telnet`(터미널·로그·분할·창 분리 가능, 모니터링·쿠버네티스·파일 없음). `TerminalSession`은 바꾸지 않았다. 세션 폼의 프로토콜 선택은 `ProtocolField.tsx`와 순수 함수 `protocol.ts`(`switchProtocol`)로 옮겨 폼을 400→384줄로 줄였다.
- 구조: `ssh.rs`(상한 초과 파일)는 프로토콜 분기를 `match`로 바꾸고 `ready`·`ftp_session`을 `connection_ready.rs`로 옮겨 365→331줄. `session_transfer.rs`는 PuTTY 프로토콜·프록시 판정과 터널 변환을 `session_transfer/putty.rs`로 옮겨 순증 없음.
- 세션 교환 v4: CG.1이 만든 v4에 Telnet을 더했다(v3 이하에 Telnet이 있으면 거부, 스키마의 `protocol`·Telnet 조건, `docs/session-transfer.md`). PuTTY `Protocol=telnet`은 Telnet 세션으로 받고(키·터널 버림), 프록시를 쓰는 Telnet 세션은 제외한다.

### 검증

- 단위: 협상(지원·거부·반복 무응답), 모든 위치의 읽기 경계 분할, `FF FF`, `CR NUL`, 입력 `\r\0`, NAWS 이스케이프, 끝없는 하위 협상, 가짜 TCP 서버로 연결→협상 응답→로그인 입력→크기 변경→서버 종료까지(`telnet::tests`, 5회 연속 통과). v4 게이트, PuTTY Telnet 가져오기, 프로필 검증, `switchProtocol`, Telnet transport 명령 순서, 세션 폼(Playwright: 경고·포트 23·인증 방식·암호 칸 없음·사용자 선택 입력·경유지 없음).
- 실서버(`npm run probe:telnet`, `connect:fixture`의 inetutils telnetd, Mac): 터미널에서 `probe`와 암호를 입력해 로그인(암호가 화면에 되돌아오지 않음), 크기 변경 뒤 `stty size` = `43 132`, `TERM=xterm-256color`, 스니펫 명령 형식(`snippets::payload`) 입력, 한글 왕복, 세션 로그 파일에 출력 기록·암호 없음, `exit` 뒤 `closed`. 3회 실행 모두 통과.
- **대기:** 실제 앱 화면에서의 Telnet 탭(Mac 패키지 앱, Windows 네이티브 검사)은 CG.10. Docker가 응답하지 않아 `connect:fixture -- status`는 시간 초과였고, 이미 떠 있던 포트에 직접 연결해 검사했다.

## CG.2 ProxyCommand (2026-11-16, `feat/cg2-proxy-command`)

### 구현

- 프로필: `proxy`에 `{kind: "command", command}`를 더했다(`storage/proxy.rs`). 한 줄, 4096바이트, 토큰은 `%h`·`%p`·`%r`·`%n`·`%%`만(그 밖의 `%x`는 저장 거부). 암호 참조가 없다. 상태 메시지는 `명령으로 연결: <프로그램 이름>`(따옴표 경로 포함).
- 실행(`ssh/proxy_command.rs`): 토큰을 바꾼 뒤 macOS는 `/bin/sh -c "exec <명령>"`(셸이 남지 않음, `PATH`는 앱 시작 때 합친 값), Windows는 `cmd.exe` 없이 첫 단어를 프로그램으로, 나머지를 `raw_arg`로 넘기고 `CREATE_NO_WINDOW`. 표준 입출력이 SSH 스트림이 되고, 스트림을 버리면 프로세스를 죽인다(`kill_on_drop` + `start_kill`). 표준 오류는 마지막 4KiB만 메모리에 두고, 연결이 실패하면 상태 메시지에 `명령 표준 오류: …`(제어 문자 제거, 300자)로 붙인다. 세션 로그에는 쓰지 않는다.
- 가져오기 승인(`session_transfer/approval.rs`): 모든 미리보기(`config_preview`, `config_include_preview`)가 명령을 쓰는 세션과 명령 전문을 `commandPlan`(일회용 토큰, 10분)으로 돌려준다. `config_apply`(이 모듈로 옮김)는 저장할 명령마다 사용자가 체크했는지, 미리보기 때와 바이트 단위로 같은지 확인하고 토큰을 한 번 쓴다. 화면은 `ProxyCommandApproval`: 명령을 고정폭으로 보이고 기본 해제, `전체 선택`도 명령 세션은 고르지 않는다, 필요한 경유지의 명령이 승인되지 않으면 이유를 보이고 추가 버튼을 막는다. 세션 폼에서 직접 입력한 명령은 그 자체가 승인이다(`ProxyField`의 `명령 (ProxyCommand)`).
- OpenSSH 가져오기: `ProxyCommand`는 줄의 나머지를 그대로(따옴표 포함) 한 값으로 읽는다(`proxy::keyword`). nc 형식은 CG.1처럼 프록시로, SOCKS4는 제외, 그 밖은 명령 프록시로 승인 대기, 허용하지 않는 토큰이면 제외. `ProxyJump`가 있으면 명령은 버리고 경고(OpenSSH와 같이 `ProxyJump` 우선). `session_transfer.rs` 비테스트 786 → 771줄.
- 세션 교환 v4: `proxy.kind = "command"`를 내보내고, 가져올 때 같은 승인을 거친다. 스키마에 `commandProxy`를 더했다.

### 검증 (Mac, 미커밋 트리)

| 검사 | 결과 |
|---|---|
| 단위 `storage::proxy` | 명령 검증(토큰·길이·줄바꿈), JSON, 이름 표시, 같은 대상 판정, 암호 없음 |
| 단위 `ssh::proxy_command` | 토큰 치환, 표준 오류 꼬리(4KiB·300자·제어 문자), 실제 `sh`로 표준 입출력 왕복·표준 오류 보관·없는 프로그램, 스트림을 버리면 프로세스 종료 |
| 단위 `session_transfer::approval`·`proxy` | 승인 없음·체크 안 함·명령 바뀜 거부, 실패한 시도도 토큰 소모, 한 번만 사용, 명령 없는 미리보기는 승인 불필요. 원문 유지(`=`·따옴표), 명령 프록시·SOCKS4·허용 안 되는 토큰 |
| Vitest·Playwright | `proxyApproval.test.ts`, `session-transfer.spec.ts`(명령 세션 기본 해제·전체 선택에서도 제외·승인 ID 전달), `session-form.spec.ts`(명령 칸) |
| **실제 환경 `npm run probe:connect`** | 아래 출력(CG.1·CG.3 여섯 줄도 같은 실행에서 통과) |

```text
PASS ProxyCommand: nc to the jump host (process ends with the tab), ssh -W to target with SFTP, Local tunnel, monitoring
PASS ProxyCommand failure shows the command's standard error: 1홉 missing (target:22) 실패 · SSH 협상에 실패했습니다. · 명령 표준 오류: /bin/sh: line 0: exec: dachsterm-no-such-proxy: not found
```

- 게이트(미커밋 트리): typecheck·lint·format, Vitest 1416/1416(`--testTimeout=60000`), build, Playwright 544, `cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings`, `cargo test --workspace` 740(무시 5)+1, `npm audit` 0건, 의존성 감사, 고지 532개.
- `dev`(CG.5 병합 d0fca8d)를 합친 트리에서 다시: Vitest 1419/1419, Playwright 545, `cargo test --workspace` 745(무시 6)+1, clippy·fmt, `npm audit` 0, 의존성 감사, 고지 537개, `probe:connect` 여덟 줄 모두 통과.
- `nc 127.0.0.1 42222`: 연결 중에는 `pgrep`에 보이고 탭을 닫고 1초 뒤에는 없다. `ssh -W %h:%p … probe@127.0.0.1`(키 `plain`)로 내부 `target`에 닿아 터미널·SFTP·Local 터널·모니터링 통과.

### 대기

- Finder로 실행한 패키지 앱에서 Homebrew 프로그램 이름(`socat`)으로 `PATH` 문제가 없는지(CG.0에서 최소 `PATH`는 `not found`). 이 검사는 터미널에서 띄운 프로세스라 대신하지 못한다(CG.10).
- Windows 전부: `cfg(windows)` 실행 경로 컴파일·`ssh.exe -W` 실행·콘솔 창 없음(이 Mac에서는 Windows 대상 컴파일 불가, CG.3 기록).

## CG.5 시리얼 탭 (2026-11-16, 브랜치 `feat/cg5-serial`)

### 구현

- 의존성: `serialport =4.10.1`(MPL-2.0, `default-features = false`로 Linux 전용 libudev 제외). 새로 들어온 것은 `io-kit-sys`, `mach2`, `nix 0.26`, `unescaper`(잠금 파일은 온라인으로 추가만, 기존 버전 변경 없음).
- 프로필: `protocol = "serial"`, `serial: { baud 50~4,000,000, dataBits 5~8, parity none|odd|even, stopBits 1|2, flow none|software|hardware }`(`storage/serial.rs`). 장치 이름은 `host`에 두고, 저장은 두 OS 형식(`COM1~255`, `/dev/cu.*`) 모두 받되 연결할 때 이 PC 형식이 아니면 `…는 이 PC의 장치 이름이 아닙니다. 세션을 수정해 포트 목록에서 고르세요.` 암호·키·경유지·프록시 없음(`auth = interactive`).
- 백엔드 `serial.rs`: 속도 없이 열고 `set_baud_rate`를 따로 불러, 속도를 거부하는 장치(macOS PTY의 ENOTTY)를 오류 문자열이 아니라 단계로 판정해 `이 장치는 통신 속도 설정을 지원하지 않습니다.` 여는 실패는 `ErrorKind`로 `이미 다른 탭이나 프로그램이 이 포트를 쓰고 있습니다.`(NoDevice=EBUSY·TIOCEXCL, Windows 접근 거부)·`장치가 없습니다`·`권한이 없습니다`로 나눈다. 읽기는 탭당 스레드 하나(200ms 시간 제한, 탭이 끝나면 `StopOnDrop`으로 종료), 출력은 `terminal_output::pump` 공유(16개 대기열로 역압), 쓰기는 `spawn_blocking` 10초. 읽기 오류·0바이트는 `장치 연결이 끊겼습니다.`(오류 상태, 재접속 가능).
- Break: 새 명령 `terminal_send_break`(포트를 복제한 핸들로 250ms `set_break`→`clear_break`, 락을 쥔 채 기다리지 않음), 탭 헤더 우클릭 `Break 보내기`(시리얼 탭만, 연결 중에만). 포트 목록 `serial_ports`(macOS는 `/dev/cu.*`만, USB 제조사·제품 표시).
- 프런트엔드: `serialTransport`(kind `serial`, 크기 없음), `sessionKind`에 `serial`(분할 불가 — 한 장치는 한 탭만 연다, `lineBreak` 능력), 세션 폼 `SerialFields.tsx`(장치 목록·직접 입력·다시 찾기, 속도·데이터 비트·패리티·정지 비트·흐름 제어). 폼의 호스트·포트·사용자·인증 칸을 `NetworkFields.tsx`로 옮겨 `SessionForm.tsx`는 384→345줄. 상태바 `시리얼 · /dev/cu.x · 115200 8N1`. 스니펫 대상에 Telnet·시리얼 포함.
- 세션 교환 v4: 시리얼 세션(v3 이하 거부), 스키마의 `serial` 객체·장치 이름 패턴·조건, `docs/session-transfer.md`.

### 검증

- 단위: 장치 이름(두 OS 형식, `..`·`/`·`tty.*` 거부), 설정 범위·인증·네트워크 필드 거부, 다른 OS 장치 이름 안내, 설정 표시 `115200 7E1 · RTS/CTS`, 여는 실패 문구. **가상 단말 쌍(`TTYPort::pair`)으로 종단 검사**: 장치 출력 → `Event::Data`, 입력 `show version\r`이 장치에 도착, 장치 쪽을 닫으면 `장치 연결이 끊겼습니다.`로 끝남(5회 연속 통과). 프런트엔드: `switchProtocol`(시리얼 전환 시 호스트 비움·기본 115200 8N1·벗어나면 설정 제거), 시리얼 transport, 탭 메뉴 Break(시리얼·연결 중만)·분할 없음, 세션 폼(Playwright: 호스트·포트·사용자·인증 칸 없음, 기본값, 빈 칸 없는 행).
- 실장치 대역(`npm run probe:serial`, Mac): 검사가 socat으로 PTY를 만들어 `connect:fixture`의 장치 콘솔(127.0.0.1:47000)에 잇고, PTY는 속도를 거부하므로 속도 없이 연다. `echo serial-$((40+2))` → `serial-42`, Break 송신 `Ok`(PTY라 실제 신호는 확인 불가), socat 종료 → `장치 연결이 끊겼습니다.` 통과.
- **대기:** 실제 USB 시리얼 장치로 속도 변경·Break·흐름 제어·케이블 분리, macOS 실제 앱 화면(CG.10). Windows의 실제 COM 포트·com0com(사용자 지시대로 대기, Windows 대상 컴파일도 이 Mac에서는 못 함).

## CG.9 X11 포워딩 (2026-11-16, `feat/cg9-x11`)

### 구현

- 프로필 `forwardX11`(기본 꺼짐)·`x11Display`(빈 값이면 macOS는 `DISPLAY`, Windows는 `localhost:0.0`). 에이전트 전달과 같이 세션 파일로 내보내거나 가져오지 않고, 병합은 저장된 값을 유지한다. SSH만. 세션 폼 고급 옵션의 `X11 포워딩 (외부 X 서버 필요)`(`X11Field`).
- `x11.rs`: 연결이 포워딩을 요청한 경우에만 `Forward`를 만들어 그 연결의 `Host`에 둔다(`route.rs`). `Host::server_channel_open_x11`은 `Forward`가 없으면 S.12처럼 `AdministrativelyProhibited`로 거부하고, 있으면 수락해 중계한다. 경유지 연결에는 두지 않는다.
- 요청: 셸 채널을 열고 가장 먼저 `x11-req`(무작위 16바이트 가짜 쿠키, `want_reply`)를 보내 그 응답을 기다린 뒤 에이전트 전달·PTY로 간다(`Route::open_shell`, `ssh.rs`는 두 줄을 한 줄로 바꿔 순증 없음). 서버가 거부하면 탭에 한 번 알린다.
- 중계: X 클라이언트의 접속 설정 패킷(바이트 순서 `l`/`B`)에서 이름이 `MIT-MAGIC-COOKIE-1`이고 쿠키가 가짜 쿠키와 같을 때만 실제 쿠키로 바꿔(없으면 인증 없이) 로컬 X 서버로 넘긴다. 다르면 아무것도 로컬로 보내지 않고 닫는다. 실제 쿠키는 `xauth` 프로그램 대신 Xauthority 파일(`XAUTHORITY`, 없으면 `~/.Xauthority`)을 직접 읽는다(설계안의 `/opt/X11/bin/xauth` 대신, `PATH` 문제가 없음). 디스플레이 번호로 찾고 주소는 비교하지 않는다. 로컬은 `host:n` → TCP `6000+n`, `:n`·`unix:n` → `/tmp/.X11-unix/Xn`, `/…/org.xquartz:0` → 그 Unix 소켓(Windows는 TCP만). X 서버에 연결하지 못하면 `X 서버(XQuartz, VcXsrv 등)를 먼저 실행하세요.`를 탭에 한 번 알린다.
- 가져오기: OpenSSH `ForwardX11 yes`는 켜지 않고 경고만 한다.
- 함께 고친 것: 프로토콜을 바꿀 때(`switchProtocol`, CG.4) CG.3의 `certPath`·`agentSource`가 남아 FTP·Telnet 저장이 거부되던 것을 지우도록 했다(X11도 같이).

### 검증 (Mac, 미커밋 트리)

| 검사 | 결과 |
|---|---|
| 단위 `x11` | 디스플레이 형식(TCP·Unix·XQuartz 경로·IPv6·범위), Xauthority 레코드 찾기·잘린 파일, 쿠키 치환(두 바이트 순서, 실제 쿠키 있음·없음), 다른 쿠키·다른 이름·잘못된 순서 바이트·과도한 길이 거부 |
| 단위 `ssh::host`(앱 `Host` + russh 서버를 메모리 안에서) | 포워딩을 요청한 연결: 서버가 연 X11 채널의 가짜 쿠키가 지워져(실제 쿠키 없음) 로컬 가짜 X 서버로 가고 양방향 중계, 다른 쿠키는 로컬에 닿지 않고 닫힘. 요청하지 않은 연결은 S.12 시험대로 거부 |
| 단위 `settings`, `session_transfer::login` | 내보내기에 없음, 파일로 켤 수 없음, `ForwardX11` 경고 |
| Vitest·Playwright | `switchProtocol`(인증서·Pageant·X11 지움), 세션 폼의 X11 칸 |
| **실제 환경 `npm run probe:connect`** | 실행기가 검사 환경 Xvfb의 쿠키로 임시 Xauthority 파일을 만들어 `XAUTHORITY`로 넘긴다(이 PC의 파일은 건드리지 않음) |

```text
PASS X11: xdpyinfo through the fake cookie reaches Xvfb, no DISPLAY without forwarding, a missing X server is told
```

- 게이트(미커밋 트리): typecheck·lint·format, Vitest 1419/1419(`--testTimeout=60000`), build, Playwright 546, `cargo fmt --check`, `cargo clippy --workspace --all-targets -D warnings`, `cargo test --workspace` 750(무시 6)+1, `npm audit` 0건, 의존성 감사, 고지 537개.
- 포워딩: 서버의 `DISPLAY`가 `localhost:1`로 시작(sshd의 X11DisplayOffset 10 이상), `xdpyinfo`의 `vendor string: The X.Org Foundation`(Xvfb는 쿠키가 맞아야 받는다). 포워딩 없음: `DISPLAY` 비어 있음. X 서버 없음(`127.0.0.1:59000`): `xdpyinfo` 실패와 탭 알림. 같은 실행에서 CG.1~CG.3 여덟 줄도 통과.

### 대기

- Mac XQuartz(Unix 소켓 `DISPLAY`, `~/.Xauthority`)와 패키지 앱에서 사람이 확인(CG.10).
- Windows VcXsrv(인증 없는 TCP 6000)·X410(CG.10).
- 서버가 요청 없이 X11 채널을 여는 경우는 OpenSSH로 만들 수 없어 앱 `Host`를 메모리 안 russh 서버로 시험한 것으로 대신했다.

## CG.8 터미널 안 파일 전송 (2026-11-16, 브랜치 `feat/cg8-inband`)

### 구현

- 위치: SSH·Telnet·시리얼의 출력은 `pump`에 들어가기 전에 `inband::Inband`(새 `Source` 감싸기)를 지난다. 로컬·파드 탭은 제외. `ssh.rs`·`telnet.rs`·`serial.rs`는 감싸기 한 줄씩, `TerminalSession`은 이벤트 분기 한 줄과 필드 하나.
- 감지(`inband/detect.rs`): 원시 바이트에서 `**\x18B00`(sz)·`**\x18B01`(rz)·`ESC 7 ::TRZSZ:TRANSFER:S|R|D:<버전>:<13자리 ID>` 줄. 표식 앞부분일 수 있는 끝 바이트만 잡아 두고 50ms 안에 다음 출력이 없으면 화면에 보낸다. 줄 128바이트를 넘거나 형식이 틀린 trzsz 줄은 그대로 출력.
- 취소 안전: `pump`는 ACK가 먼저 오면 `next()` future를 버린다. 그래서 전송은 소스를 넘겨받은 별도 작업에서 돌리고, `next()`는 채널만 기다린다. 끝나면 소스와 전송 뒤 서버 출력을 돌려받아 화면 출력을 잇는다(같은 출력에서 다음 전송도 다시 감지).
- 사용자 흐름: 감지되면 탭에 카드(`InbandCard`, 포커스를 가져가지 않음) — 받기는 `저장할 폴더 고르기…`, 보내기는 `보낼 파일 고르기…`, `거절`. 고르는 창은 백엔드가 연다(웹뷰가 경로를 정하지 않음). 2분 안에 답이 없거나 창을 닫으면 거절. 거절은 ZMODEM 취소열(CAN 10 + BS 10)·trzsz `ACT confirm:false`. 진행 중 막대와 `취소`(ZMODEM 취소열·trzsz `#fail:`), 끝나면 터미널에 `[파일 전송 · 프로토콜] …` 한 줄. 전송 중 그 탭의 입력·스니펫·동시 입력은 거부.
- 파일(`inband/files.rs`): 서버 이름은 마지막 경로 부분만, 제어 문자·`<>:"|?*` 치환, 앞뒤 공백·점 제거, `CON`·`COM1` 같은 장치 이름 회피, 200바이트. `create_new`로만 만들어 덮어쓰지 않고 `이름 (1).확장자`로 번호를 붙인다. 실패·취소 때 쓰던 파일은 지운다. 보내기는 고른 파일만, 폴더는 거부.
- ZMODEM(`inband/zmodem.rs`): `zmodem2 0.7.3`(MIT/Apache, sans-IO). 받기는 `with_flow_control(0, true)`+수동 수락, 보내기는 스트리밍 창 무제한. `poll`이 이벤트를 쓰기보다 먼저 주므로 세션 종료 뒤 남은 바이트를 비운다. `sz`의 "OO"는 0.5초 안에 오면 걷어 낸다. 4GiB 이상은 trz 안내. 5초마다 재시도, 8번 무응답이면 중단. 실패 문구에 `tmux 안에서는 trzsz(tsz·trz)를 쓰세요` 안내.
- trzsz(`inband/trzsz.rs`): trzsz 1.1.7 파이썬 구현(`transfer.py`·`utils.py`)의 줄 프로토콜을 따른다. 늘 base64 모드(`binary:false`)를 요청해 Telnet·시리얼·tmux에서도 깨지지 않게 하고 폴더는 지원하지 않는다고 밝힌다(`trz -d`는 거절 후 안내). tmux 상태 줄 잡음은 마지막 `#TYPE:`만 읽는다. MD5 확인. 새 직접 의존성 `flate2`·`md5`는 이미 잠금 파일에 있던 판.
- 전송 큐와의 관계: 넣지 않는다(설계 그대로). 터미널 전송은 그 프로그램이 살아 있는 동안만 의미가 있어 재개할 수 없다.

### 검증

- 단위(`cargo test -p dachsterm --lib inband`): 감지(모든 위치 분할, 닮은 출력 통과, 잡아 둔 바이트), 파일 이름·덮어쓰기 금지·반쯤 쓴 파일 삭제, trzsz는 파이썬 서버 흐름을 옮긴 가짜 `tsz`·`trz`와 왕복(70KB·100KB·두 파일, MD5, 거절, `#FAIL`, tmux 잡음), ZMODEM은 반대편 `zmodem2` 상태 기계와 왕복(64KiB+3000B 두 파일, 빈 파일, 경로가 붙은 이름). 출력 경로 종단: 가짜 소스로 `hello` → tsz 표식 → 질문 중 입력 거부 → 폴더 응답 → 저장 → 이후 화면 출력 복귀를 `next()`를 20ms마다 버리며 확인, sz 거절 시 서버에 취소열, 진행 중 취소 시 `#fail:` 전달과 반쯤 쓴 파일 삭제. 프런트엔드: 문구·진행 표시·종료 줄의 제어 문자 제거·재접속 뒤 카드 숨김(Vitest), 카드·진행 막대·종료 줄(Playwright).
- 실서버(`npm run probe:inband`, Mac): 제품 SSH 경로로 `connect:fixture`의 경유지(lrzsz 0.12.21, trzsz 1.1.7)에 비밀번호 로그인 → 서버에서 만든 임의 64KiB 파일을 `sz`·`tsz`로 받아 SHA-256 일치, 모든 바이트 값이 든 50,000B 파일을 `rz -y`·`trz -y`로 보내 서버 `sha256sum` 일치, 화면에 "OO" 남지 않음. 2회 통과.
- 처음 실행에서 찾은 것: 테스트가 이전 프롬프트를 새 프롬프트로 읽어 `sz`가 끝나기 전에 다음 명령을 보냈다(서버 `sz`가 그 입력을 먹어 이후 입력이 사라진 것처럼 보임). 제품 결함이 아니라 테스트 대기 조건을 고쳤다.
- **대기:** Telnet·시리얼 위 ZMODEM 실서버(검사 환경의 Telnet 서버 `edge`에는 lrzsz가 없다. 경로는 단위 테스트로만), tmux 안에서의 동작, 실제 앱 화면의 카드와 시스템 파일 창(CG.10), 대용량(수백 MiB) 속도.

## CG.10 문서·회귀·Mac (2026-11-17, `feat/cg10-docs-mac`, `dev` `201b5e1` 위 미커밋 트리)

바꾼 것은 사용 안내서, 새 Windows 네이티브 검사와 게이트 연결, 이 기록과 progress, 그리고 Mac 앱 확인에서 찾은 가져오기 결함의 수정(`sessions/protocol.ts`의 `needsUsername`, `SessionTransfer.tsx`, `NetworkFields.tsx`)이다.

### 사용 안내서

[user-guide](../user-guide.md)에 프록시, 프록시 명령, 인증서 파일, X11 포워딩(SSH 연결 아래), 하이라이트와 트리거, 터미널 안 파일 전송(터미널 아래), 새 절 Telnet과 시리얼을 썼다. Pageant를 미지원 목록에서 지원 항목으로 옮기고, 세션 목록 표시(`TELNET`, `SERIAL`)와 세션 교환(JSON v4, 명령 승인, 프록시 가져오기)을 고쳤다. 안내서에 적은 화면 문구 17개(`이해했고 켭니다`, `하이라이트 일시 중지`, `Pageant가 실행 중이 아니거나` 등)를 `src`·`src-tauri/src`에서 찾아 모두 있음을 확인했다. 설계안·검증 기록에 기대어 쓴 곳: 시리얼 탭의 동시 입력·스니펫, Telnet 사용자 칸을 장비로 보내지 않는다는 점, ECDSA 인증서(실제 검사는 Ed25519·RSA).

### Windows 네이티브 검사

- `scripts/test-connect-native.mjs`(`npm run test:connect`). 공용 실행 헬퍼 `scripts/lib/native-app.mjs`를 써서 `launch()` 복사를 늘리지 않았다(review T2). `connect:fixture`가 떠 있어야 한다.
- 실제 WebView2 화면에서: HTTP 프록시(연결 때 묻는 `프록시 암호` 카드) → 내부 서버 `target`, 같은 탭에서 하이라이트 규칙이 일치한 줄만 다른 색으로 그려지는지(계산된 색 비교), SOCKS5 + 키 옆 `-cert.pub` 인증서, ProxyCommand(Windows OpenSSH `ssh.exe -W`, `cmd.exe` 없이 실행되는 경로), Telnet 로그인과 상태바 `Telnet · 암호화 없음`. 비밀은 앱의 입력 칸에만 넣고 실패해도 단계 이름만 출력한다.
- `verify-windows.ps1 -Native`가 `npm run connect:fixture -- up` 다음 `npm run test:connect`를 실행한다.
- 넣지 않은 것: Pageant(실행 중인 Pageant와 키가 필요), VcXsrv, 실제 COM 포트, 터미널 안 전송(시스템 파일 창은 CDP로 조작할 수 없다). 이 항목들은 사람 확인으로 남긴다.
- **Windows에서 실행하지 않았다.** 이 Mac에는 WebView2가 없다. Mac에서 확인한 것은 `eslint`, `prettier --check`, `node --check`와 게이트의 lint·format뿐이다.

### Mac 게이트

macOS 27.2.1(26B131), Apple Silicon, Node 26.0.0, Rust 1.99.1(Homebrew rustup), Docker 29.8.0. `npm ci` 뒤 `bash scripts/verify-macos.sh --package`: typecheck·lint·format 통과, Vitest 1423/1424에서 멈춤(게임 `survivor/stages.test.ts`의 30/60/120Hz 시험이 부하 평균 23~30에서 5초 초과, 이전 기록과 같은 원인). 그 파일을 `--testTimeout=60000`으로 다시 돌려 17/17 통과한 뒤 나머지 단계를 같은 순서로 실행해 모두 종료 0: build, Playwright 547, `cargo fmt`·`clippy -D warnings`, `cargo test --workspace` 766(무시 7)+1, `npm audit` 0, 의존성 감사 0(대상 밖 5), 고지 538개(변경 없음), debug `.app`(ad hoc 서명).

가져오기 결함을 고친 뒤(Rust 변경 없음) 프런트엔드 단계를 다시 실행해 모두 종료 0: typecheck·lint·format, Vitest 1425/1425(`--testTimeout=60000`, 위 게임 시험의 부하 시간 초과를 피하려고), build, Playwright 548(새 시험 1개). 고친 코드로 debug `.app`을 다시 빌드해 아래 확인에 썼다.

### Mac 패키지 앱

- 실행: `env -i HOME=… USER=… LOGNAME=… /usr/bin/open -n --env DACHSTERM_TEST_DATA_DIR=<scratchpad> DachsTerm.app`. 앱 프로세스의 시작 환경(`ps eww`)이 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `TERM` 없음으로 Finder 실행과 같다.
- **발견:** 터미널에서 그냥 `open`으로 띄우면 이 macOS에서는 셸의 `PATH`가 앱에 그대로 넘어간다(`launchctl getenv PATH`는 비어 있음). 이렇게 띄운 앱은 Finder 실행의 `PATH` 문제를 재현하지 못하므로 `mac-verify` 스킬의 실행 방법을 위 명령으로 고쳤다.
- 준비: `connect:fixture` up, `connect:fixture -- serial`(socat PTY `/dev/ttys007`), 가져오기 파일(ProxyCommand `socat STDIO TCP:%h:%p` 이름만 쓴 세션, HTTP 프록시 세션, Telnet 세션. SSH는 검사 환경의 무암호 키 `plain`).
- 조작: 사람이 아니라 에이전트가 했다. 입력은 접근성 API(요소 누르기·값 넣기, 시스템 팝업 메뉴)와 CGEvent 마우스, 앱 PID로만 보내는 키 이벤트, 판정은 앱 창만 찍는 창 캡처(`screencapture -l`)·격리 DB·`ps eww`·지문 대조다. 같은 Mac을 사용자가 쓰고 있었고(HID 유휴 0~15초), 외부 모니터가 분리·재연결되며 창이 화면 사이를 옮겨 다녔다. 그래서 클릭은 DachsTerm이 맨 앞이고 좌표가 창 안일 때만 보냈다. 이 장치가 생기기 전 클릭 2번이 다른 앱 창에 들어갔다(텍스트 위의 더블클릭, 입력 없음). 웹 내용의 접근성 트리는 도중에 비어 버려 뒤쪽은 창 캡처와 창 기준 좌표로 했다. 터미널에 명령을 붙여넣어 실행하는 조작은 권한 확인에서 두 번 거부되어 하지 않았다.
- 이 Mac의 `/dev/cu.*`: `Bluetooth-Incoming-Port`, `debug-console`뿐. USB 시리얼 장치 없음.

| 항목 | 결과 |
|---|---|
| Finder 실행 앱의 ProxyCommand `PATH`(Homebrew `socat` 이름만) | **통과.** 앱 시작 환경 `PATH=/usr/bin:/bin:/usr/sbin:/sbin`. 연결하자 앱(PID 90407)의 자식 `socat STDIO TCP:127.0.0.1:42222`가 떴고 그 `PATH`에 로그인 셸에서 가져온 `/opt/homebrew/bin`이 있다(`login_path`). 상태 `연결됨 · 명령으로 연결: socat → …`, 호스트키 지문이 검사 환경 `host_jump.pub`와 같음, 셸 `probe@jump:~$`. 앱 종료 뒤 `socat` 없음 |
| 가져오기 미리보기의 명령 승인(WKWebView) | **통과.** `연결할 때 실행할 명령 승인`에 명령 전문, 승인 체크·세션 행 모두 기본 해제, **전체 선택**을 눌러도 명령 세션은 해제 그대로, 승인하면 세션도 선택됨. 격리 DB에 명령이 그대로 저장 |
| **결함: 사용자명 없는 Telnet·시리얼 가져오기** | 첫 시도에서 **세션 추가** 버튼이 꺼져 가져올 수 없었다. 미리보기가 모든 세션에 사용자명을 요구했기 때문이다(Telnet·시리얼은 사용자명 없이 저장하는 것이 정상). `protocol.ts`의 `needsUsername`으로 고치고(세션 폼도 같은 규칙을 쓴다) Playwright 재현 시험(수정 전 실패·수정 후 통과)과 단위 시험을 넣었다. 다시 빌드한 앱에서 `3개 세션을 추가했습니다.` |
| HTTP 프록시 암호 카드 → 내부 서버 | **통과.** 키 Passphrase 창 → `서버 추가 인증` 카드 `… · 프록시 암호`(검사 환경 암호는 파일에서 접근성 값으로 넣음, 출력 없음) → `target:22` 지문이 `host_target.pub`와 같음 → `연결됨 · HTTP 프록시 경유 (127.0.0.1:43128) → … (target:22)`, 셸 `probe@target:~$`. 사이드바 SFTP도 같은 경로로 `/home/probe` 목록 |
| 하이라이트 규칙 추가와 색(WKWebView) | **통과.** 설정 → 터미널 → 하이라이트 → 규칙 추가(이름·패턴 `login`, 색 위험) → 저장, DB `highlight_rules_v1`에 저장. 그 뒤 연 Telnet 탭의 `edge login:`에서 `login`만 빨강, `edge`·`:`는 기본 색(창 캡처). 규칙 전에 나온 출력은 칠하지 않음 |
| Telnet 탭 | **일부 통과.** 연결, 배너 `Linux 7.0.12-linuxkit (edge)`, `edge login:` 프롬프트, 상태바 `Telnet · 암호화 없음 · 127.0.0.1:42323`, 장비가 로그인 시간 초과로 끊자 탭 `종료`와 `연결이 종료되었습니다 · 탭 닫기 · 재접속` 카드. **로그인 입력은 하지 않았다**(터미널 입력 거부) |
| 시리얼 포트 목록과 장치 이름 | **통과.** 새 연결 → 프로토콜 `시리얼 · 장비 콘솔` → 장치 제안 목록이 `/dev/cu.debug-console`, `/dev/cu.Bluetooth-Incoming-Port`(이 Mac의 실제 열거, `tty.*` 없음). 가상 포트 `/dev/ttys007`은 저장 단계에서 `장치는 COM3이나 /dev/cu.usbserial-1410처럼 입력하세요.`로 거부된다(의도된 규칙 `device_name`). 그래서 앱으로는 PTY를 열 수 없고 속도 거부 안내는 엔진 검사(`probe:serial`)로만 확인된 상태다. 안내서에 이 제한을 적었다. 시스템 장치(`debug-console`, Bluetooth)는 열지 않았다 |
| 터미널 안 전송 카드와 시스템 파일 창(`sz`·`rz`) | 대기. 서버에서 `sz`·`rz`를 실행하려면 터미널 입력이 필요한데 거부되어 하지 않았다 |
| XQuartz Unix 소켓 | 대기. XQuartz가 설치되어 있지 않다(`/opt/X11` 없음). 설치는 사용자 결정 |
| ad hoc 서명 앱의 업데이트와 Keychain | 대기. 같은 원인의 근거: ad hoc 앱을 다시 빌드하면 이전 빌드의 Keychain 항목 접근 때 로그인 암호 창이 뜬다([M.29](macos-readiness.md#실제-앱-조작-1차-2026-11-09-17cc876)). 업데이트도 서명(cdhash)이 바뀌므로 같은 창이 예상되지만 업데이트 경로로는 확인하지 않았다 |
| WKWebView 하이라이트 성능 | 대기. 엔진 측정은 CG.7의 Playwright WebKit(부하 평균 40)뿐이다. 앱 안 측정 경로가 없고, 이번에도 부하 평균 22~35라 다시 재지 않았다 |
| 실제 USB 시리얼 장치(속도·Break·흐름 제어·분리) | 대기. 장치 없음 |
