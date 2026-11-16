# 상용 제품 대비 보완 — 설계안

- 작업 ID: **CG.0~CG.10**, 설계일: **2026-11-16**.
- 현재 상태: **CG.0 실측·설계 작성 / 사용자 승인 전.** 구현 상태의 정본은 [progress.md](../progress.md)다.
- 기준 자료: `dev` `52cb524`의 코드, russh 0.65.1·pageant 0.2.5 소스, CG.0 실측([검증 기록](../verification/commercial-gaps.md)). 범위는 [roadmap §26](../roadmap.md#26-상용-제품-대비-보완-2026-11-16-사용자-요청--cg)이다.

## 1. 목표와 범위

상용 SSH 클라이언트에서 넘어온 사용자가 **접속 단계에서 바로 막히는 기능**(프록시, ProxyCommand, Pageant, 인증서)을 먼저 채우고, 장비 접속(Telnet·시리얼), 출시 운영(자동 업데이트), 터미널 편의(하이라이트·트리거, 터미널 안 파일 전송, X11 중계)를 그 다음에 둔다. 새 작업 영역은 늘리지 않는다.

제외(roadmap §26): Mosh, GSSAPI/Kerberos, 터미널 이미지, UI 다국어, Linux·Intel Mac·Windows ARM, 앱 안의 X 서버, 클라우드 동기화.

## 2. 현재 구조에서 확인한 것

| 항목 | 현재 | 근거 |
|---|---|---|
| SSH 연결 진입점 | **`route::open` 한 곳.** 첫 구간만 `TcpStream::connect`, 다음 구간은 `channel_open_direct_tcpip(...).into_stream()`이고 둘 다 `Box<dyn Transport>`로 `client::connect_stream`에 들어간다 | `ssh/route.rs:113-138`, `:183-184`, `:238` |
| `route::open` 호출자 | 터미널(`ssh.rs:255`)과 셸 없는 로그인(`login_only.rs:103`, 네트워크 도구·에이전트 채팅)뿐. SFTP·터널·모니터링·쿠버네티스·Git은 열린 연결을 `Connections::handle`로 재사용한다 | `ssh.rs:71-79` |
| FTP 연결 | `ftp.rs:64`에서 따로 연결한다. 프록시 경로 밖이다 | `ftp.rs` |
| Handler | `Host`가 `check_server_key`, `channel_open_failure`, 포워딩 3종을 구현한다. **`server_channel_open_x11`은 구현하지 않아 russh 기본값(수락)이 쓰인다.** 앱은 `request_x11`을 보내지 않는다 | `ssh/host.rs:24-92`, russh `client/mod.rs:3070-3082` |
| 에이전트 인증 | Unix `connect_env`, Windows `connect_named_pipe(\\.\pipe\openssh-ssh-agent)`. 에이전트 안의 인증서는 이미 `authenticate_certificate_with`로 쓴다. **Pageant는 없다** | `ssh_auth.rs:62-143`, `agent_relay.rs:42-50` |
| 키 파일 인증 | Ed25519·ECDSA는 `authenticate_publickey`, RSA는 ring 서명기(`RsaSigner`)와 SHA-2만. **인증서 파일은 읽지 않는다** | `ssh_auth.rs:146-189`, `rsa_auth.rs` |
| 프로필 | `Profile`(JSON `data` 열, `deny_unknown_fields`). 새 필드는 `ALTER` 없이 serde 기본값으로 추가한다. 비밀은 `profiles.secret_ref` 하나와 `ForwardKey.secret_ref`(JSON 안)뿐이다 | `storage.rs:12-64`, `:223-270` |
| 프로토콜 | `ssh`, `ftp`, `ftps`. SSH 외는 암호 인증만. 시작 분기는 `start_route` 안의 `protocol == "ssh"` 한 줄 | `storage.rs:171-176`, `ssh.rs:121-147` |
| 터미널 이벤트 | 세 구현이 `ssh::Event` 하나를 공유한다. ACK 규칙은 SSH(`seq > current`)와 로컬·파드(`seq == ack+1`)가 다르다(architecture-review B1) | `ssh/event.rs:4-38` |
| 입력 경로 | IPC 입력은 UTF-8 **문자열**이고 프로필 인코딩으로 바꿔 `Input::Data(Vec<u8>)`로 보낸다. 이진 입력 경로는 없다 | `commands.rs:334`, `broadcast.rs:118-134` |
| 출력 디코딩 | 프런트엔드 `TerminalDecoder(profile.encoding)` | `session.ts:274` |
| 가져오기 | OpenSSH의 `ProxyCommand`·`CertificateFile` 호스트를 통째로 제외하고, `ForwardX11`은 조용히 무시한다. PuTTY는 `ProxyMethod≠0`을 제외한다. Include는 파일 목록 → 체크 → 승인한 파일만 읽는 2단계다 | `session_transfer.rs:278-280`, `:635-648`, `config_includes.rs` |
| 세션 교환 | v3(`version: 3`, `additionalProperties: false`). 새 기능은 이전 버전 파일이 쓰면 거부하는 방식으로 늘려 왔다 | `settings.rs:146-171`, `docs/session-format.schema.json` |
| 외부 프로그램 | macOS는 시작 때 로그인 셸 `PATH`를 합친다(`/opt/homebrew/bin`, `/usr/local/bin` 포함) | `login_path.rs:18-78`, `lib.rs:98` |
| 알림 | `NotificationLimiter`(앱 2초·탭 5초), `notificationBody`(200자) | `src/lib/notifications.ts` |
| xterm | 6.0.0. `registerMarker`만 쓰고 `registerDecoration`은 쓰지 않는다. 데코레이션은 셀 범위의 `foregroundColor`·`backgroundColor`를 지원한다 | `commandMarks.ts:161`, `xterm.d.ts:555` |
| 업데이트 | 없음. `tauri.conf.json`에 `plugins` 절이 없고 릴리스 0개, 저장소는 공개다 | `gh` 없이 공개 API로 확인 |

## 3. 공통 결정

1. **연결 경로는 `route::open`의 첫 구간 하나만 바꾼다.** `TcpStream::connect` 자리를 `first_hop::open(profile, secret) -> Box<dyn Transport>`로 바꾸면 SFTP·터널·모니터링·쿠버네티스·Git·네트워크 도구·에이전트 채팅이 모두 같은 경로를 탄다(roadmap CG.1의 "같은 경로" 요구). 새 모듈은 `src-tauri/src/ssh/first_hop.rs`(직접·HTTP·SOCKS5·명령)다.
2. **프록시·ProxyCommand는 그 TCP 연결을 소유한 프로필에 붙는다.** 경유지가 있는 세션의 첫 TCP 연결은 첫 경유지 프로필이 연다. 그래서 대상 세션에 `jump_ids`와 프록시를 함께 지정하면 저장 단계에서 "첫 경유지 세션에 프록시를 지정하세요"로 거부한다. 경유지 프로필에 프록시를 넣으면 `프록시 → 경유지 → 대상`이 된다(CG.0에서 실측).
3. **Telnet·시리얼은 FTP처럼 `Connections`의 새 프로토콜**로 넣는다. `start_route`의 분기를 `match protocol`로 바꾸고 `telnet::run`, `serial::run`을 둔다. 둘 다 `Event::Data`와 `control.input`을 쓰므로 세션 로그(`logs.register`), 스니펫(`snippet_send`), 동시 입력(`broadcast`), 창 분리(`Broker`), 인코딩이 그대로 동작한다. ACK는 SSH 규칙(`seq > current`, 30초)을 따른다. 프런트엔드는 `sessionKind`에 `telnet`, `serial`을 더하되, 진행 중인 U4(`TerminalSession`의 transport 객체화, 브랜치 `refactor/u4-terminal-transport`)가 먼저 병합되면 그 위에 transport를 추가하고, 아니면 `this.x ? :` 분기를 늘리지 않도록 U4를 선행한다(engineering-rules §7).
4. **프로필 필드는 모두 JSON `data`에 serde 기본값으로 추가**하므로 DB 스키마(`user_version` 4)는 바꾸지 않는다. 단 `deny_unknown_fields` 때문에 **새 필드가 들어간 DB를 이전 앱이 읽으면 실패**한다. 지금까지와 같은 조건이며, 내려 설치(downgrade)는 지원하지 않는다고 사용 안내서에 적는다.
5. **세션 교환은 v4 한 번으로 올린다.** CG.1~CG.5, CG.9의 새 필드를 모아 v4 스키마를 만들고, v3 이하 파일이 새 필드를 쓰면 기존 방식대로 거부한다. 비밀(프록시 암호)은 내보내지 않는다. **실행 정보(ProxyCommand)는 내보내되 가져올 때 승인 대상**이다(§CG.2).
6. **비밀 참조는 `ForwardKey.secret_ref`와 같은 방식**(JSON 안의 참조, `credential_gc` 회수 대상)으로 추가한다. 회수 목록을 만드는 곳에 새 참조를 넣는 것을 저장 테스트로 확인한다.

## 4. 작업별 설계

### CG.0 — 실측 (이 문서)

결과는 [검증 기록](../verification/commercial-gaps.md)에 있다. 검사 환경은 `tests/connect-fixture`와 `npm run connect:fixture -- up|status|serial|down`이다. 모든 포트는 `127.0.0.1`에만 열고, 대상 SSH 서버는 외부와 끊긴 내부 망에 있어 프록시나 경유지로만 닿는다. 비밀은 일회성 `init` 컨테이너가 매번 새로 만들고 OS 임시 폴더로 복사하며 화면에 찍지 않는다.

실측 결과와 설계에 반영한 것:

| 항목 | 결과 | 설계 반영 |
|---|---|---|
| `connect_stream` + HTTP CONNECT·SOCKS5 | 둘 다 성공. SOCKS5 → 경유지 → 대상도 성공. 경유 세션 위 `direct-tcpip` 성공 | CG.1을 `route::open` 첫 구간 교체로 한정 |
| HTTP 오류 응답 | 인증 없음 407, **암호 틀림 401**(tinyproxy), 포트 불허 403, 목적지 실패 500 | 401과 407을 모두 인증 실패로 처리 |
| SOCKS5 오류 응답 | 인증 요구 `05 FF`, 암호 틀림 `01 02`, 없는 호스트 코드 1(4 아님), 닫힌 포트 코드 5 | 코드 1을 "목적지 연결 실패"로 묶음 |
| ProxyCommand | `nc`, `ssh -W` 성공. 최소 `PATH`에서 Homebrew `socat`은 `not found`(종료 127, 표준 오류에만 이유) | 표준 오류 4KiB 보관, 패키지 앱 확인 |
| Pageant | 기능 플래그 없이 `cfg(windows)`에서 이미 그래프에 있음. 없을 때 오류는 첫 요청에서 남 | 판정 위치·문구 |
| 인증서 | Ed25519 `authenticate_openssh_cert` 성공. **RSA는 그 함수로 `ssh-rsa-cert-v01`(SHA-1)이 나가 거부**, `authenticate_certificate_with`+`RsaSigner`+SHA-512로 성공. 만료·주체 불일치는 클라이언트에 이유가 오지 않음 | RSA 서명기 경로, 연결 전 로컬 판정 |
| X11 | 가짜 쿠키 → 실제 쿠키 치환으로 `xdpyinfo` 성공, 치환하지 않으면 `Invalid MIT-MAGIC-COOKIE-1 key` | OpenSSH 방식 확정 |
| ZMODEM·trzsz 표식 | `**\x18B00…`(sz), `**\x18B01…`(rz), `\x1b7::TRZSZ:TRANSFER:S|R:<버전>:…` | 감지기 표식, 8비트 바이트(`\x8a`) 때문에 Rust 쪽 감지 |
| Telnet | inetutils telnetd가 17개 옵션 요청. TTYPE·NAWS·SGA·ECHO만 받고 나머지 거부로 로그인·크기·TERM 정상 | 옵션 목록 |
| 시리얼 | macOS에서 `serialport`가 PTY를 **속도 지정으로 열면 ENOTTY**(`IOSSIOSPEED`), 속도 0이면 열림. 분리는 `BrokenPipe` 읽기 오류. PTY는 포트 목록에 없음 | 직접 경로 입력, 분리 판정, PTY 검사용 속도 0 경로(테스트 전용) |
| 하이라이트 비용 | 키워드 규칙은 GiB/s, IPv4 패턴 61MiB/s, 대표 10개 20MiB/s(프레임당 1.5ms) | 상한·일시 중지·워커 |
| 업데이트 플러그인 | 2.14.x가 `tauri ^2.12`, 이미 있는 `reqwest 0.13` 사용 | 버전 선택 |

Windows 항목(Pageant, Windows ProxyCommand, COM 포트, VcXsrv)은 실행하지 않았다.

### CG.1 — 프록시 경유 접속

**프로필 필드**

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub proxy: Option<Proxy>,

#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Proxy {
    Http { host: String, port: u16, username: String, secret_ref: Option<String> },
    Socks5 { host: String, port: u16, username: String, secret_ref: Option<String> },
    Command { command: String },          // CG.2
}
```

- TS: `proxy?: { kind: 'http' | 'socks5'; host; port; username; hasSecret } | { kind: 'command'; command }`. 프런트엔드는 `secretRef`를 받지 않고 `hasSecret`만 받는다(현재 `has_secret`과 같은 방식).
- 검증: SSH만 허용(FTP는 "FTP 세션에는 프록시를 쓸 수 없습니다"), `jump_ids`와 동시 지정 거부(§3-2), 호스트는 `host` 규칙 재사용, 사용자 이름 255바이트(SOCKS5 상한), 암호 255바이트.
- 암호: 사용자 이름이 비어 있으면 인증 없이 시도한다. 암호는 저장하거나(OS 저장소·금고) 연결 때 묻는다. 묻는 경우 기존 `AuthPrompt` 이벤트에 `프록시 암호` 이름으로 보낸다.

**연결 동작**(`first_hop.rs`)

- HTTP: `CONNECT host:port HTTP/1.1`, `Host`, 필요하면 `Proxy-Authorization: Basic`. 응답 헤더는 **빈 줄까지만** 읽는다(뒤는 이미 SSH 배너다, 실측). 2xx가 아니면 상태 줄로 오류를 만든다. 헤더 16KiB 상한.
- SOCKS5: 사용자 이름이 있으면 방법 `00 02`, 없으면 `00`. 대상은 **항상 도메인 이름(ATYP 3)으로 보내 프록시가 이름을 푼다**(실측에서 내부 망 이름 `target`이 풀렸다). IP 문자열이면 ATYP 1·4.
- 시간 제한: 프로필 `timeout` 하나가 프록시 TCP·협상·SSH 배너까지 덮는다.
- 오류 문구(사용자에게 보이는 것, 프로토콜을 밝힌다):

| 상황 | 문구 |
|---|---|
| 프록시 TCP 실패 | `프록시(호스트:포트)에 연결할 수 없습니다.` |
| HTTP 401·407(인증을 보냈을 때) / SOCKS 인증 응답 `01 xx`(xx≠0) | `프록시 인증에 실패했습니다. 사용자 이름과 암호를 확인하세요.` |
| HTTP 407(인증을 안 보냈을 때) / SOCKS 방법 응답 `05 FF` | `프록시가 인증을 요구합니다.` |
| HTTP 403 / SOCKS 응답 2 | `프록시가 이 목적지를 허용하지 않습니다.` |
| HTTP 5xx / SOCKS 응답 1·3·4·5·6 | `프록시가 목적지에 연결하지 못했습니다(<상태 줄 또는 SOCKS 코드>).` |

- 원시 응답 줄은 상태 메시지에만 쓰고 헤더 값은 기록하지 않는다(`Proxy-Authenticate` 영역에 비밀은 없지만 일반 원칙).

**화면**: 세션 폼의 고급 영역에 `프록시: 없음 | HTTP | SOCKS5 | 명령`. 경유지가 지정되어 있으면 선택을 비활성화하고 이유를 쓴다. 상태 메시지에 `프록시 경유` 문구를 붙여 경로가 보이게 한다.

**가져오기**: OpenSSH `ProxyCommand nc -X 5 -x host:port %h %p`·`-X connect`처럼 **nc 프록시 형식만** SOCKS5·HTTP 프록시로 바꾼다(명령 실행 없이 같은 효과). 그 밖의 `ProxyCommand`는 CG.2. PuTTY `ProxyMethod` 1(SOCKS4)·2(SOCKS5)·3(HTTP) 중 2·3과 `ProxyHost`·`ProxyPort`·`ProxyUsername`을 받는다. SOCKS4와 PuTTY의 Telnet·로컬 프록시는 경고와 함께 제외한다. 암호(`ProxyPassword`)는 가져오지 않는다.

**검증**: `connect_stream` 경유 실측(CG.0)을 단위 테스트로 옮긴다(프록시 협상은 `tokio::io::duplex`로 응답 고정). 실제 환경은 `connect:fixture`의 HTTP·SOCKS5로 터미널·SFTP·터널·모니터링을 각 1회, 경유지 조합 1회. Windows 네이티브 검사 `test-proxy-native.mjs`를 `verify-windows.ps1 -Native`에 연결한다. Mac은 패키지 앱에서 같은 순서를 사람이 확인한다.

### CG.2 — ProxyCommand

**프로필 필드**: `Proxy::Command { command }`(CG.1의 같은 자리). 프록시와 동시에 쓸 수 없다(OpenSSH도 하나만 쓴다).

**실행**

- 토큰: `%h`(호스트), `%p`(포트), `%r`(사용자), `%n`(원래 호스트 이름), `%%`. 그 밖의 `%x`는 저장 단계에서 거부한다. 치환 값은 이미 `host` 검증을 거쳐 공백·셸 메타 문자가 없다.
- macOS: `/bin/sh -c "exec <command>"`(OpenSSH와 같은 `exec`로 셸 프로세스가 남지 않는다). `PATH`는 `login_path`가 합친 프로세스 값을 쓴다. CG.0에서 Finder와 같은 최소 `PATH`(`/usr/bin:/bin:/usr/sbin:/sbin`)로는 Homebrew `socat`이 `not found`로 실패했다. 패키지 앱에서 다시 확인한다(CG.10).
- Windows: `cmd.exe`를 거치지 않고 명령 줄을 `CreateProcessW`로 그대로 실행한다(Windows OpenSSH의 동작과 같음). `CREATE_NO_WINDOW`로 콘솔 창을 띄우지 않는다. 프로그램 이름은 `PATH`·`PATHEXT`로 찾는다. **Windows 실측은 대기**다.
- 수명: 표준 입출력을 `tokio::io::join`으로 묶어 `connect_stream`에 넘긴다. `kill_on_drop(true)`와 연결 종료 때 명시적 `kill`. 표준 오류는 마지막 4KiB만 보관해 연결 실패 때 상태 메시지에 붙인다(비밀이 나올 수 있으므로 세션 로그에는 쓰지 않는다).

**승인 흐름** (Include와 같은 원칙: 사용자가 내용을 본 뒤에만 실행 정보가 저장된다)

1. OpenSSH·PuTTY·DachsTerm JSON 가져오기의 미리보기는 `ProxyCommand`가 있는 세션을 **기본 해제된 체크박스**로 따로 묶고 명령 전문을 고정폭으로 보여준다. 체크하지 않은 세션은 명령 없이 가져오지 않고 통째로 건너뛴다(명령 없이 가져오면 다른 경로로 접속을 시도하게 된다).
2. 체크한 세션만 `config_preview`의 계획 토큰(10분, `config_includes`와 같은 저장소)에 들어 있는 명령과 **바이트 단위로 같을 때** 저장한다. 미리보기 뒤 파일이 바뀌어도 화면에 보인 명령만 저장된다.
3. 세션 폼에서 사용자가 직접 입력한 명령은 그 자체가 승인이다.
4. 저장된 명령은 연결할 때 상태 메시지에 `명령으로 연결: <프로그램 이름>`을 보인다.

**가져오기 변경**: `session_transfer.rs:635-648`의 제외 목록에서 `proxycommand`를 빼고, 위 승인 경로로 보낸다. `ProxyCommand none`은 지금처럼 무시한다. `ProxyJump`와 함께 있으면 OpenSSH처럼 `ProxyJump`가 우선하므로 명령은 버리고 경고한다.

**세션 교환 v4**: `proxy.kind = "command"`를 내보낸다. 가져올 때는 1~2의 승인 흐름을 똑같이 탄다.

**검증**: 단위 테스트(토큰 치환, 승인 토큰 불일치 거부, 표준 오류 절단). 실제: `connect:fixture`의 `nc 127.0.0.1 42222`와 `ssh -W target:22 …`(CG.0에서 둘 다 성공). Finder 실행 패키지 앱에서 Homebrew 프로그램 이름 하나(`socat`)로 PATH 문제가 없는지 확인한다. Windows는 `ssh.exe -W`로 확인한다.

### CG.3 — 인증 확장: Pageant·인증서 파일

**Pageant**

- 프로필: `auth = "agent"`는 그대로 두고 `agent_source: "system" | "pageant"`(기본 `system`)를 더한다. `system`은 지금 동작(Unix `SSH_AUTH_SOCK`, Windows OpenSSH 파이프)이다.
- 활성화 조건(CG.0 실측): russh 0.65.1은 **기능 플래그 없이 `cfg(windows)`에서만** `pageant 0.2.5`를 의존하고 `AgentClient::connect_pageant`를 노출한다. 현재 `Cargo.lock`에 이미 들어 있으며(`namedpipes`·`wmmessage` 기본 기능) 코드 변경은 호출부뿐이다. macOS에서는 컴파일되지 않는다.
- 동작 순서: 이름 있는 파이프 `\\.\pipe\pageant.<사용자>.<CryptProtectMemory 해시>`(PuTTY 0.75 이상)를 먼저, 실패하면 `FindWindow("Pageant")`+`WM_COPYDATA`(공유 메모리 8KiB)로 넘어간다.
- **주의 1: `connect_pageant`는 Pageant가 없어도 성공한다.** `wmmessage` 쪽 `new()`는 창을 찾지 않고 첫 요청 때 찾는다. 그래서 "Pageant 없음"은 `request_identities` 실패로 판정하고 `Pageant가 실행 중이 아니거나 키가 없습니다.`로 보여준다.
- **주의 2: `WM_COPYDATA` 경로는 `SendMessageA`를 tokio 작업 안에서 동기 호출한다.** Pageant가 확인 창을 띄우면 그동안 런타임 작업자 하나가 묶인다. Tauri 런타임은 다중 스레드라 앱이 멈추지는 않지만, 에이전트 호출을 `spawn_blocking` 안에서 하지 않는 한 피할 수 없다. 실측 대기.
- 에이전트 전달: `forward_system_agent`의 출처(`agent_relay::connect_system`)도 같은 `agent_source`를 따른다.
- macOS에서 `pageant` 값을 가진 프로필(가져오기·교환 파일)은 연결 때 `Pageant는 Windows에서만 쓸 수 있습니다.`를 반환한다(engineering-rules §11).
- 가져오기: PuTTY는 에이전트 사용 여부를 세션에 두지 않으므로 대상이 없다. OpenSSH `IdentityAgent`가 `pageant`류 경로면 경고만 한다.

**인증서 파일**

- 프로필: `cert_path: String`(기본 빈 값, 4096바이트). `auth = "key"`에서만 쓴다. 비어 있으면 OpenSSH처럼 `<key_path>-cert.pub`가 있을 때 자동으로 쓴다.
- 연결 전 로컬 확인(서버는 실패 이유를 알려주지 않으므로 앱이 먼저 판정한다, 실측): 인증서의 공개키가 개인키와 같은지, 유효 기간(`valid_after`~`valid_before`)이 지금을 포함하는지, `valid_principals`가 비어 있거나 사용자 이름을 포함하는지. 앞의 둘은 거부, 셋째는 경고 후 시도.
- 서명 경로(실측으로 정함): Ed25519·ECDSA는 `authenticate_openssh_cert`, **RSA는 `authenticate_certificate_with` + 기존 `RsaSigner` + SHA-2 해시**. CG.0 결과는 §CG.0 표.
- 가져오기: OpenSSH `CertificateFile` → `cert_path`(제외 목록에서 뺀다). 여러 줄이면 첫 줄만 쓰고 경고. PuTTY `DetachedCertificate` → `cert_path`.
- 호스트 인증서(`host_key.rs:10-12`의 거부)는 이번 범위가 아니다.

**검증**: 인증서 확인 함수 단위 테스트(만료·주체 불일치·키 불일치). 실제: `connect:fixture`의 `cert_ed25519`, `cert_rsa`, `cert_expired`, `cert_other`. Pageant는 Windows 실기기에서 PuTTY 0.75 이상(파이프)과 이전 방식 둘 다 확인한다(대기).

### CG.4 — Telnet 탭

- 프로필: `protocol = "telnet"`, 기본 포트 23. **암호를 저장하지 않는다**(`auth = "interactive"`만 허용). 로그인은 터미널 안에서 사용자가 친다. 사용자 이름은 비워도 된다(Telnet에는 사용자 이름 전달 수단이 없고, 자동 입력은 만들지 않는다).
- 경고: 세션 폼에서 Telnet을 고르면 `Telnet은 암호를 포함한 모든 입력을 암호화하지 않고 보냅니다.`를 프로토콜 선택 바로 아래에 보인다. 탭이 연결되면 상태 메시지에 `Telnet · 암호화 없음`을 남긴다.
- 백엔드 `telnet.rs`: TCP 연결 → 옵션 협상 → `Event::Data`. RFC 1143 방식으로 옵션 상태를 둔다.
  - 받아들이는 옵션: 서버 `WILL ECHO`·`WILL SGA` → `DO`, 서버 `DO TTYPE` → `WILL`(SB로 `XTERM-256COLOR`), `DO NAWS` → `WILL` + 현재 크기, `BINARY`는 양방향 허용. 나머지는 `DONT`/`WONT`.
  - 실측(§CG.0)에서 inetutils telnetd가 보낸 요청 목록을 기준으로 거부 목록을 확인했다.
  - 입력: 사용자 입력의 `0xFF`는 `FF FF`로 이스케이프. `BINARY`가 아니면 Enter의 `\r`을 `\r\0`으로 바꾼다(RFC 854).
  - 출력: `IAC` 시퀀스를 걷어내고, 프레임 경계에 걸친 시퀀스는 다음 프레임과 합친다.
  - `Input::Resize` → `NAWS` 하위 협상.
- 연결 종료(서버 EOF)는 SSH와 같은 `closed` 상태와 재연결 버튼.
- 세션 교환 v4에 `telnet` 프로토콜을 추가한다. PuTTY `Protocol=telnet`은 가져온다(지금은 제외).
- 검증: 옵션 협상 단위 테스트(프레임 경계 분할, `FF FF`, `\r\0`), `connect:fixture`의 Telnet으로 로그인·크기 변경·세션 로그·스니펫 1회, Windows 네이티브 검사, Mac 패키지 앱.

### CG.5 — 시리얼 탭

- 프로필: `protocol = "serial"`, 새 필드 `serial: Option<SerialSettings>`

```rust
pub struct SerialSettings {
    pub baud: u32,            // 50~4_000_000, 기본 115200
    pub data_bits: u8,        // 5~8, 기본 8
    pub parity: Parity,       // none | odd | even
    pub stop_bits: u8,        // 1 | 2
    pub flow: Flow,           // none | software | hardware
}
```

  `host`에는 장치 이름(`COM3`, `/dev/cu.usbserial-1410`)을 넣어 목록 표시·검색·정렬 코드를 그대로 쓴다. 검증은 프로토콜별로 나눠, 시리얼에서만 `host`의 `/`를 허용하고 Windows는 `COM\d+`, macOS는 `/dev/cu.*`만 받는다. `port`·`username`은 쓰지 않는다(0과 빈 값 허용).
- 크레이트: `serialport` 4.x(MPL-2.0, 같은 라이선스 유형이 이미 그래프에 있다). 블로킹 API라 장치당 읽기 스레드 하나를 두고 `stop` 신호와 읽기 시간 제한(200ms)으로 종료한다(engineering-rules §6의 소유자·종료 경로).
- 포트 목록: `available_ports()`. macOS는 `/dev/cu.*`와 `/dev/tty.*`를 함께 돌려주므로(실측) `cu.*`만 보인다(`tty.*`는 열 때 DCD를 기다린다). 목록에 없는 경로도 직접 입력할 수 있게 한다(socat PTY는 목록에 나오지 않았다).
- macOS PTY: 속도를 지정해 열면 `IOSSIOSPEED`가 ENOTTY로 실패한다(실측). 제품은 실제 장치만 대상으로 하므로 그대로 두고, 오류 문구를 `이 장치는 통신 속도 설정을 지원하지 않습니다.`로 바꾼다. 자동 검사는 테스트 전용 경로에서 속도 0으로 PTY를 연다.
- Break: 탭 헤더 우클릭 메뉴 `Break 보내기`(250ms `set_break` → `clear_break`). 단축키는 두지 않는다(터미널에 넘길 키와 충돌).
- 장치 분리: 읽기 오류 또는 0바이트 → 상태 `장치 연결이 끊겼습니다` + 재연결. 실측된 종류는 §CG.0 표.
- 같은 장치를 두 탭에서 열면 두 번째는 OS 독점 오류를 `이미 다른 탭이나 프로그램이 이 포트를 쓰고 있습니다.`로 바꾼다.
- 세션 교환 v4에 `serial`을 넣되, 장치 이름은 PC마다 다르므로 가져올 때 그대로 두고 연결 실패 때 목록을 보여준다.
- 검증: 설정 변환 단위 테스트, macOS socat pty(`connect:fixture -- serial`)로 입출력·분리, **실제 USB 시리얼 장치로 Break와 속도 변경**(pty는 둘 다 의미가 없다, 실측). Windows는 com0com 또는 실제 장치(대기).

### CG.6 — 자동 업데이트

- 구성: `tauri-plugin-updater` 2.14.x(2026-10, `tauri ^2.12` 요구, `reqwest 0.13`은 이미 그래프에 있음). 새로 들어오는 것은 `minisign-verify`, `tar`·`flate2`, Windows `zip` 등이다. 재시작은 Tauri 코어 `AppHandle::restart`로 하고 `tauri-plugin-process`는 넣지 않는다.
- 호출은 **앱 명령으로 감싼다**: `update_check`, `update_install`, `update_settings_set`. 플러그인 JS 권한을 열지 않고 engineering-rules §5 네 곳 등록을 따른다.
- 서명: `tauri signer generate`로 사용자가 만든 키. **비밀키는 GitHub Actions 비밀(`TAURI_SIGNING_PRIVATE_KEY`, 암호 포함)로만 두고 저장소·문서에 넣지 않는다.** 공개키는 `tauri.conf.json`의 `plugins.updater.pubkey`에 넣는다(공개해도 되는 값). `bundle.createUpdaterArtifacts: true`.
- 배포 위치(사용자 결정): 공개 저장소 Releases의 `latest.json` 고정 URL이 가장 단순하다. 지금 저장소 이름이 `dachsterm-workspace`이고 공개라는 점, 릴리스가 0개라는 점을 사용자에게 확인한다.
- **Mac App Store 판매와 충돌**: App Store 배포본은 스스로 업데이트할 수 없다(심사 지침). 판매를 App Store로 하면 그 빌드는 업데이트 기능을 컴파일에서 빼야 한다(`cfg(feature = "updater")`). DMG 직접 배포에만 켠다. 사용자 결정 필요.
- 동작: 시작 30초 뒤와 24시간마다 확인(설정에서 끄면 확인도 하지 않는다). 새 버전이 있으면 제목 줄에 작은 표시만 하고(상시 버튼 금지, rules §7) 누르면 변경 내용 → `설치 후 다시 시작`. 연결된 세션·진행 중 전송 수를 보여주고 확인받는다. 전송 큐는 영속이라 재시작 뒤 재개된다.
- **서명 없는 Mac 앱의 위험**(실기기 확인 필요): ad hoc 서명은 빌드마다 코드 서명 식별 값이 바뀐다. Keychain 항목의 "항상 허용"이 이전 빌드에 묶여 있으면 업데이트 뒤 저장된 비밀마다 Keychain 확인 창이 다시 뜰 수 있다. Gatekeeper는 `reqwest`로 받은 파일에 격리 속성이 붙지 않아 막지 않을 것으로 보지만 확인 전이다. Windows도 서명 없는 설치 파일을 직접 실행하므로 SmartScreen 여부를 확인한다.
- 검증: 로컬 정적 서버(임시 서명키로 만든 `latest.json`·아티팩트, 키는 임시 폴더에서 만들고 지움)로 두 OS에서 확인→내려받기→설치→재시작. 서명 변조 파일을 거부하는지 확인. CI에는 서명 단계만 추가하고 실제 릴리스는 사용자가 요청할 때만 만든다.

### CG.7 — 키워드 하이라이트·트리거

- 규칙(앱 설정 `settings` 표의 JSON 하나, 최대 64개):

```ts
type HighlightRule = {
  id: string;
  name: string;
  pattern: string;        // JS 정규식 원문, 512자
  ignoreCase: boolean;
  scope: { kind: 'all' } | { kind: 'tags'; tags: string[] } | { kind: 'sessions'; ids: string[] };
  color: 'danger' | 'warning' | 'success' | 'info' | 'accent' | null; // 테마 토큰 이름만
  notify: boolean;
  send: { text: string; confirmedAt: number } | null;                // 자동 입력, 명시적으로 켠 규칙만
  enabled: boolean;
};
```

- 색: 규칙은 토큰 **이름**만 갖고 실제 색은 현재 테마 토큰에서 얻는다(roadmap §2.3). 테마를 바꾸면 기존 데코레이션을 다시 칠한다.
- 그리기: xterm `registerDecoration`(셀 범위 `foregroundColor`)를 쓴다. 출력 바이트에 SGR을 끼워 넣지 않는다(세션 로그·ZMODEM·복사 내용이 바뀌기 때문).
- 매칭 대상: 쓰기 완료 콜백에서 **새로 바뀐 행만** 버퍼(`translateToString`)에서 읽어 맞춘다. ANSI는 이미 빠져 있고 넓은 글자의 셀 위치를 버퍼가 알려준다.
- 성능(CG.0 실측, Node 26 V8, 8MiB 로그형 출력): 키워드 규칙은 하나당 수 GiB/s지만 **일치가 많은 규칙이 비용을 지배한다**(IPv4 패턴 하나 61MiB/s, 10개 규칙 약 20MiB/s, 32KiB 프레임당 1.5ms). 그래서
  - 데코레이션은 프레임당 200개, 탭당 살아 있는 것 2,000개를 상한으로 하고 오래된 것부터 지운다.
  - 출력이 초당 4MiB를 넘는 동안은 하이라이트를 멈추고 상태바에 `하이라이트 일시 중지`를 보인다.
  - 정규식 역추적 폭주를 막기 위해 매칭은 탭 공용 Web Worker에서 하고, 한 묶음이 100ms를 넘으면 워커를 종료하고 그 규칙을 끈 뒤 알린다. 저장할 때 샘플 텍스트로 미리 재본다.
  - WKWebView(JavaScriptCore)는 따로 잰다(CG.10).
- 알림: 규칙의 `notify`가 켜져 있으면 `NotificationLimiter`와 `notificationBody`를 그대로 쓴다.
- 자동 입력: 규칙 편집에서 `일치하면 입력 보내기`를 켜면 경고 문구와 함께 확인을 받는다. 제한: 같은 탭에서 10초에 1번, 동시 입력 모드에서는 보내지 않음, 보낸 내용은 탭에 `트리거 입력: <규칙 이름>`으로 표시. **암호 자동 입력은 만들지 않는다**: 보낼 텍스트에 비밀 참조를 넣을 방법을 두지 않고, 패턴이 `password|passphrase|암호|비밀번호` 프롬프트와 일치하는 규칙은 자동 입력을 켤 수 없다.
- 위치: 설정 → 터미널 → 하이라이트. 탭 헤더 우클릭에 `이 탭에서 하이라이트 끄기`.
- 검증: 규칙 변환·상한·워커 시간 초과 단위 테스트, Playwright로 색 토큰 반영과 테마 전환, 5.1 대량 출력 측정에 하이라이트 켠 경우를 추가.

### CG.8 — 터미널 안 파일 전송(ZMODEM·trzsz)

- **감지는 Rust 출력 경로에서 한다.** 프런트엔드는 출력을 인코딩으로 디코딩하고 입력은 UTF-8 문자열이라 이진 데이터를 손상 없이 오갈 수 없다(§2). 터미널 데이터 루프(SSH·Telnet·시리얼 공통)에 `inband::Detector`를 두고 시작 표식을 찾으면 그 채널을 전송 모드로 바꾼다. 전송 중 바이트는 `Event::Data`로 내보내지 않는다.
- 시작 표식(CG.0 실측, §CG.0 표): ZMODEM은 `**\x18B00`(ZRQINIT, 서버가 보냄 = `sz`) / `**\x18B01`(ZRINIT, 서버가 받음 = `rz`), trzsz는 `ESC 7` 뒤의 `::TRZSZ:TRANSFER:S|R:<버전>:<번호>` 줄. ZMODEM 헤더에 8비트 바이트(`\x8a`)가 있어 텍스트 디코딩 뒤에는 감지할 수 없다.
- 구현: ZMODEM은 `zmodem2` 0.7(MIT/Apache, 2026-10)을 우선 검토하고, 부족하면 ZRQINIT/ZRINIT/ZFILE/ZDATA/ZEOF/ZFIN만 직접 구현한다. trzsz는 공개 프로토콜(줄 단위 base64)을 직접 구현한다.
- 사용자 흐름: `sz` 감지 → 저장 폴더 선택 창(취소하면 중단 시퀀스 전송) → 탭 위 진행 띠 → 완료 시 터미널에 한 줄 요약. `rz` 감지 → 파일 선택 창 → 같은 진행 띠. 원격 파일 이름은 경로 구분자·`..`·제어 문자를 제거하고 이미 있으면 번호를 붙인다. 자동 수락은 하지 않는다.
- 취소: ZMODEM 중단(`CAN` 8개 + `BS` 8개), trzsz는 프로토콜의 중단 메시지.
- **전송 큐와의 관계**: 넣지 않는다. 전송 큐는 SQLite에 영속되고 `.dachsterm-*` 임시 파일로 재시작 뒤 재개하는 SFTP·FTP용이다. 터미널 안 전송은 그 채널이 살아 있는 동안만 의미가 있어 재개할 수 없다. 진행은 탭 안에서만 보이고, 끝난 기록은 남기지 않는다.
- 범위: SSH(경유지 포함), Telnet, 시리얼. 로컬·파드 탭은 제외. tmux 안에서는 ZMODEM이 깨지므로(tmux가 중계하지 않음) 감지 후 실패하면 `tmux 안에서는 trzsz를 쓰세요` 안내.
- 검증: 감지기 단위 테스트(표식이 프레임 경계에 걸친 경우, 일반 출력의 오탐), `connect:fixture`의 `sz`/`rz`/`tsz`/`trz`(lrzsz 0.12.21, trzsz 1.1.7)로 64KiB 이진 파일 왕복 해시 비교, 경유지 너머 1회.

### CG.9 — X11 포워딩

- 프로필: `forward_x11: bool`(기본 꺼짐, 세션 파일에서 켜지 않음 — `forward_agent`와 같은 취급), `x11_display: String`(빈 값이면 OS 기본: macOS는 `DISPLAY` 환경 변수, Windows는 `localhost:0.0`).
- 요청: PTY 전에 세션 채널에 `request_x11(want_reply=true, single_connection=false, "MIT-MAGIC-COOKIE-1", <가짜 쿠키 16바이트 hex>, screen)`.
- 중계: `server_channel_open_x11`을 구현한다. **요청한 연결에서만 수락**하고 아니면 `AdministrativelyProhibited`로 거부한다. 수락한 채널은 X11 접속 설정 패킷의 쿠키가 가짜 쿠키와 같은지 확인하고 실제 쿠키로 바꿔 로컬 X 서버로 넘긴다(OpenSSH 방식, CG.0에서 동작 확인). 서버는 실제 쿠키를 보지 못한다.
- 실제 쿠키: macOS는 `xauth list <display>`(XQuartz `/opt/X11/bin/xauth`, 절대 경로로 찾음)의 값. 없으면 인증 없이 보낸다(VcXsrv `-ac` 같은 경우). Windows는 VcXsrv·X410이 보통 인증 없이 TCP 6000을 쓰므로 쿠키를 지우고 이름·데이터 길이 0으로 보낸다(실측 대기).
- 로컬 연결: `DISPLAY`가 `host:n`이면 TCP `6000+n`, 경로(`/private/tmp/com.apple.launchd.*/org.xquartz:0`)면 Unix 소켓.
- 화면: 세션 폼의 고급에 `X11 포워딩(외부 X 서버 필요)`. X 서버가 없어 연결이 실패하면 탭에 한 번만 `X 서버(XQuartz, VcXsrv 등)를 먼저 실행하세요.`
- 가져오기: OpenSSH `ForwardX11 yes` → `forward_x11`은 **켜지 않고** 경고만(에이전트 전달과 같은 원칙). `ForwardX11Trusted`는 지원하지 않는다.
- 검증: 쿠키 치환 단위 테스트(바이트 순서 `l`/`B`, 길이 패딩, 불일치 거부). 실제: `connect:fixture`의 Xvfb, Mac XQuartz, Windows VcXsrv(대기).

### CG.10 — 문서·회귀·Mac

사용 안내서(프록시·명령·Pageant·인증서·Telnet·시리얼·업데이트·하이라이트·터미널 전송·X11), Windows 네이티브 검사 연결(`verify-windows.ps1 -Native`), Mac 패키지 앱 확인(`mac-verify`): Finder 실행 ProxyCommand PATH, 시리얼 `/dev/cu.*`, XQuartz Unix 소켓, ad hoc 서명 앱의 업데이트와 Keychain, WKWebView 하이라이트 성능.

## 5. 세션 교환 v4

| 필드 | 내보내기 | 가져오기 |
|---|---|---|
| `proxy`(http·socks5) | 종류·호스트·포트·사용자 이름. 암호 없음 | 그대로. 암호는 연결 때 묻는다 |
| `proxy`(command) | 명령 전문 | CG.2 승인 흐름 |
| `agentSource` | 그대로 | macOS에서 `pageant`이면 경고 |
| `certPath` | 그대로(경로) | 그대로 |
| `protocol: telnet`·`serial`, `serial` | 그대로 | 그대로 |
| `forwardX11`, `x11Display` | 내보내지 않음 | 해당 없음 |

v3 이하 파일이 위 필드를 쓰면 "v4가 필요합니다"로 거부한다. `docs/session-format.schema.json`을 v4로 올리고 v3 스키마를 `session-format.v3.schema.json`으로 남긴다(v2와 같은 방식).

## 6. IPC 명령(새로 추가)

| 명령 | 작업 | 내용 |
|---|---|---|
| `serial_ports` | CG.5 | 포트 목록(이름, USB 제조사·제품) |
| `terminal_send_break` | CG.5 | 시리얼 탭에 Break |
| `inband_transfer_answer` | CG.8 | 저장 폴더·업로드 파일 선택 결과 또는 취소 |
| `update_check`, `update_install`, `update_settings_set` | CG.6 | 업데이트 |

프록시·ProxyCommand·인증서·Telnet·X11은 기존 `connect`·`session_save`·가져오기 명령의 입력이 늘어날 뿐 새 명령이 없다. 가져오기 승인은 기존 `config_preview` 결과에 `proxy_commands` 목록을 더한다.

## 7. 보안

- 프록시 암호·인증서 개인키 암호는 기존 비밀 저장소에만 둔다. 로그·상태 메시지에 프록시 응답 헤더 값과 ProxyCommand 표준 오류를 세션 로그로 남기지 않는다.
- ProxyCommand는 화면에 보인 명령만 저장된다(CG.2 승인). 세션 파일 하나로 명령이 실행되는 경로가 없어야 한다.
- X11은 가짜 쿠키만 서버에 보낸다. **요청하지 않은 X11 채널 수락은 지금도 열려 있는 동작**이다(russh 기본값). 데이터가 로컬로 이어지지는 않아 유출은 없지만 서버가 채널을 열어 자원을 쓰게 할 수 있다. CG.9에서 거부로 바꾸며, 그 전에 고치려면 보안 점검의 새 항목으로 올린다(사용자 결정).
- 트리거 자동 입력은 비밀을 보낼 수 없고, 암호 프롬프트 패턴에는 켤 수 없다.
- 터미널 안 전송은 사용자가 고른 폴더·파일만 쓰고 읽는다.
- 업데이트는 minisign 서명 검증을 통과한 파일만 설치한다. 비밀키는 CI 비밀에만 있다.

## 8. 순서와 사용자 결정

제안 순서는 roadmap의 것을 유지한다: (5.1 장시간·S.8) → **CG.1 → CG.3 → CG.2 → CG.6 → CG.4·CG.5 → CG.7 → CG.8 → CG.9** → CG.10. 이유: CG.1이 `first_hop.rs`와 프로필 `proxy` 필드를 만들고 CG.2가 그 위에 명령 종류만 더한다. CG.3은 독립적이고 사용자 체감이 커서 CG.2보다 앞선다. CG.4·CG.5는 U4(TerminalSession transport) 이후가 깔끔하다. CG.8은 CG.4·CG.5의 데이터 루프를 공유하므로 그 뒤다.

사용자 결정이 필요한 것:

1. 업데이트 배포 위치(현재 공개 저장소의 Releases를 쓸지)와 Mac App Store 판매 시 그 빌드에서 업데이트를 뺄지(CG.6).
2. 요청하지 않은 X11 채널 수락을 CG.9 전에 보안 항목으로 먼저 고칠지(§7).
3. Telnet에서 암호 저장·자동 로그인을 계속 만들지 않을지(이 설계는 만들지 않는다).
4. 세션 교환 v4를 CG.1과 함께 올릴지, 모든 CG 필드가 들어온 뒤 한 번에 올릴지(이 설계는 CG.1에서 v4를 만들고 이후 필드를 더한다. v4는 출시 전이라 같은 버전 안에서 늘려도 된다).
