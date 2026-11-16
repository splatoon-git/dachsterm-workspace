# 5.1 장시간·대용량·장애 측정 (2026-11-16)

roadmap Phase 5의 "대량 출력·대용량 전송·장시간 연결·연결 반복 후 메모리와 자원 점검"과 "절전·복귀, 네트워크 변경·단절, 앱 종료 중 전송 처리"를 실제 OpenSSH로 측정한 기록이다.

- 환경: macOS 27.2.1, Apple M5(10코어, 32GiB), Docker 29.8.0, 서버 `OpenSSH_9.2p1 Debian-2+deb12u10`(`tests/openssh`, 커널 7.0.12-linuxkit). 측정은 release 빌드의 제품 엔진(`ssh::Connections`, `sftp::Transfers`)으로 했다.
- 브랜치 `verify/5-1-endurance`, `52cb524` 위 미커밋 트리.
- **환경 경고.** 측정하는 동안 같은 Mac에서 다른 세션 4개가 빌드·테스트를 돌렸고(부하 평균 17~90), Docker VM에는 다른 프로젝트의 kind 클러스터 여러 개가 함께 떠 있어 VM이 CPU 550%를 썼다. Docker 데몬이 수 분씩 응답하지 않은 적도 있다. **처리량의 절대값은 이 환경의 값이고 제품의 상한이 아니다.** 판정은 수정 전후 비교, 바이트 일치, 연결 생존 여부, 자원 추세로 했다.

## 무엇으로 쟀나

| 도구 | 하는 일 |
|---|---|
| `npm run probe:endurance` (`scripts/run-endurance.mjs` + `src-tauri/examples/endurance_probe.rs`) | 일회용 OpenSSH 컨테이너에 제품 엔진으로 접속해 시나리오를 실행한다. 장애는 러너가 일으킨다: 프로브 프로세스 SIGSTOP/SIGCONT(절전 대용), 그 사이 서버 세션 강제 종료, `docker pause`(응답 없는 네트워크), `docker network disconnect`(링크 끊김), SIGKILL(강제 종료). 결과는 `target/verification/endurance-<시나리오>.json` |
| `npm run measure:render` (`scripts/measure-terminal-render.mjs`) | xterm 6.0.0을 앱과 같은 옵션(글꼴 14, 스크롤백 5000, `screenReaderMode: true`)과 같은 ACK 방식(32KiB 프레임 하나씩, write 콜백 뒤 다음 프레임)으로 띄워 DOM 렌더러와 WebGL 애드온(0.19.0, 임시 폴더에만 설치)을 비교한다. Chromium이 WebView2, WebKit이 WKWebView를 대신한다 |

프로브에는 WebView가 없다. 메모리 수치는 앱의 Rust 쪽만이다. 화면 쪽은 렌더 벤치로 따로 쟀고, 둘을 합친 실제 앱의 측정은 하지 않았다(아래 "남은 것").

## 결함과 수정

### F1. 대량 출력이 ACK 왕복 하나에 SSH 메시지 하나로 묶였다 — 수정

`ssh.rs`와 `kube/terminal.rs`는 SSH 데이터 메시지를 받는 대로 프레임 하나로 보내고, 그 프레임의 렌더 ACK가 올 때까지 다음 메시지를 읽지 않았다. 서버 PTY가 보내는 메시지는 약 4KiB여서 256MiB 출력이 프레임 69,311개(평균 4KiB)가 됐다. 처리량이 xterm의 그리기 속도가 아니라 IPC 왕복 횟수에 묶인다.

수정: `src-tauri/src/terminal_output.rs`의 출력 펌프를 SSH 터미널과 파드 터미널이 함께 쓴다. 진행 중인 프레임은 여전히 하나이고, ACK를 기다리는 동안 도착한 데이터를 32KiB까지 모아 다음 프레임으로 보낸다. 32KiB가 차면 읽기를 멈춰 SSH 흐름 제어가 서버를 늦춘다. 로컬 PTY(`local.rs`)는 ACK를 기다리는 동안 커널 버퍼에 데이터가 쌓여 다음 읽기가 이미 모아서 돌려주므로 바꾸지 않았다.

재현 테스트: `terminal_output::tests::gathers_messages_that_arrive_while_a_frame_waits`(4KiB 메시지 16개 → 프레임 4KiB, 32KiB, 32KiB, 바이트 순서 동일), `splits_a_message_larger_than_a_frame`, `sends_the_output_read_before_a_failure`(tmux 거부·kube 종료 코드 오류 전에 읽은 출력을 먼저 보낸다).

| 프레임당 렌더 지연(프로브의 ACK 지연) | 수정 전 | 수정 후 |
|---|---|---|
| 0ms, 256MiB | 0.7MiB/s, 평균 4KiB, 69,311프레임 | 1.6MiB/s, 평균 8KiB, 32,692프레임 |
| 1ms, 64MiB | 0.8MiB/s, 4KiB | 1.0MiB/s, 18KiB |
| 4ms, 64MiB | 0.5MiB/s, 4KiB | 1.8MiB/s, 23KiB |
| 16ms, 32MiB | 0.2MiB/s, 4KiB | 1.1MiB/s, 27KiB |

렌더가 느릴수록 프레임이 32KiB에 가까워지고 효과가 커진다(16ms에서 5.5배). 수정 후 ACK를 바로 보내도 1.6MiB/s인 것은 이번 환경에서 서버 쪽 전달이 느렸기 때문이다(프레임이 8KiB밖에 차지 않았다). 두 측정은 부하가 달라 절대값을 일대일로 비교하지 않는다. 최대 RSS는 수정 전후 모두 11~16MiB였다.

Ctrl+C: 끝없는 출력 중 32MiB를 받은 뒤 Ctrl+C를 보내면 프롬프트가 돌아오기까지 수정 전 0.04초/0.2MiB(렌더 0ms), 0.21초/0.1MiB(4ms), 수정 후 0.07초/0.1MiB, 0.10초/0.0MiB였다. 모아 보내기가 중단 응답을 늦추지 않았다.

### F2. 깨어난 직후 시계 기반 제한이 한꺼번에 만료된다 — 수정

Rust 문서는 절전 시간이 `Instant`에 포함되는지를 정하지 않는다. Windows의 QueryPerformanceCounter는 절전 시간을 센다. 따라서 Windows에서 긴 절전 뒤 깨어나면, 절전 전에 걸어 둔 시간 제한이 모두 이미 지난 것으로 판정된다. SIGSTOP은 같은 상황(시계는 흐르고 프로세스는 멈춤)을 만든다. macOS의 `CLOCK_UPTIME_RAW`가 실제 절전에서 멈추는지는 실기기로 확인하지 않았다.

두 곳이 시계로 제한을 쟀다.

1. **SFTP 요청당 10초(russh-sftp 기본값).** 수정 전 `suspend`(120초 정지)에서 터미널 셋은 모두 살아남았는데, **전송만 깨어난 순간(120.1초) `SFTP 작업 실패: Timeout`으로 실패했다**(이어받기로는 정확히 완료). 같은 제한 때문에 수정 전 2GiB 업로드도 부하 속에서 75초 만에 `Timeout`으로 실패했다. 연결이 살아 있는데 전송만 먼저 끊긴 것이다.
   수정: `sftp::open`에서 요청 제한을 1시간 안전장치로만 두고, 끊긴 연결은 keepalive가 판정하게 했다. keepalive는 경과 시간이 아니라 응답 없는 탐침 수(3회)를 세므로 시계가 건너뛰어도 한 번으로 센다. 연결이 끝나면 전송 큐 작업은 기존 `stop` 신호로 "연결 종료 · 부분 파일 보존"이 된다.
2. **터미널 출력 ACK 30초.** 깨어날 때 프레임 하나가 ACK를 기다리던 중이면, WebView가 다시 그리기 전에 30초 제한이 먼저 만료돼 연결을 끊을 수 있다. SIGSTOP 모사에서는 재현되지 않았다(같은 프로세스 안의 ACK가 먼저 처리됐다). 바쁜 출력 셸을 2ms 늦은 ACK로 함께 돌렸지만 살아남았다. 그래도 같은 위험이 코드에 있으므로, 출력 펌프는 "1초 동안 진척 없음"을 30번 센 횟수로 판정한다. 시계가 몇 시간 건너뛰어도 한 번으로 센다.

재현 테스트: `terminal_output::tests::a_clock_jump_while_waiting_counts_as_one_step`(멈춘 시계를 120초 건너뛴 뒤 ACK). 판정을 옛 방식(30초 한 번)으로 바꾸면 이 테스트만 실패하고 되돌리면 통과함을 확인했다. `a_window_that_never_acknowledges_ends_after_thirty_steps`는 출력이 계속 와도 응답 없는 창을 30초 뒤 끊는지 본다. SFTP 쪽 재현은 엔진 시나리오 `suspend`와 `stall`이다(아래 표의 수정 전후).

## 시나리오 결과 (수정 후)

판정 기준: 살아남아야 하는 장애에서는 터미널 셋(1초마다 번호를 찍는 셸, 유휴 셸, 2ms 늦은 ACK로 끝없이 출력하는 셸)이 끊기지 않고 번호가 빠지지 않아야 한다. 전송은 다시 시도하지 않고 처음 그대로 완료돼야 한다. 끊겨야 하는 장애에서는 모두 오류로 끝나고, 새 연결에서 이어받아 SHA-256이 일치해야 한다. 모든 시나리오는 끝난 뒤 연결·핸들 수가 시작 값으로 돌아와야 한다.

| 시나리오 | 장애 | 결과 | 수정 전 |
|---|---|---|---|
| 대량 출력 | 256MiB, 64MiB, 32MiB, Ctrl+C | 통과(F1 표) | 통과(4KiB 프레임) |
| 대용량 전송 업로드 | 2GiB | **통과.** SHA-256 일치, 1,093초(1.9MiB/s), 최대 RSS 13MiB | 75초에 `SFTP 작업 실패: Timeout` |
| 대용량 전송 다운로드 | 2GiB | **미판정.** 30분에 91%(1.95GB)까지 받는 중에 프로브의 대기 한도(1,800초)에 걸렸다. 제품 오류는 없었다. 한도는 7,200초로 늘렸고 재실행은 대기 | 미실행 |
| `stall` | 서버 컨테이너 정지 12초(Docker 지연으로 실제 18초) | **통과.** 터미널 셋 생존, 틱 43개 누락 0, 유휴 셸 응답 1.5초, 바쁜 셸 52MiB, 전송 실패 없이 완료·SHA-256 일치 | **실패 재현**: 터미널 셋은 생존, 전송은 정지 11.3초에 `SFTP 작업 실패: Timeout`. 이어받은 전송도 느린 경로에서 다시 `Timeout` |
| `suspend` | 프로브 프로세스 SIGSTOP 120초(절전 대용) | **통과.** 터미널 셋 생존, 틱 308개 누락 0, 유휴 셸 응답 0.44초, 바쁜 셸 44MiB, 전송 실패 없이 완료·SHA-256 일치 | 터미널 셋 생존, **전송은 깨어난 순간(120.1초) `Timeout`**, 이어받아 일치 |
| `link` | 서버 네트워크 분리 20초(실제 29초) | 끊김 판정: 유휴 셸 53.6초, 틱 셸 60.8초, 바쁜 셸·전송 61.1초에 모두 오류로 끝남("서버 연결이 끊어졌습니다. 재접속하면 새 셸이 열립니다."). keepalive 15초×4의 예상과 맞다. **재접속·이어받기는 미판정**: Docker가 네트워크를 다시 붙여도 게시 포트를 복구하지 않아 이 서버에 다시 접속할 수 없었다 | 미실행 |
| 연결 반복 | 접속→1MiB 출력→종료 | **30회까지만.** 10·20·30회 모두 RSS 12MiB, fd 12, 스레드 11로 변화 없음, 매 회 연결·핸들 수 복귀. 회당 13초가 걸려 중단했다(수정 전 바이너리) | — |
| 장시간 연결 | 터미널 6개 + 5분마다 16MiB 왕복 | **9분까지만.** RSS 9~15MiB, fd 19, 스레드 11~13로 일정, 틱 누락 없음, 5분째 전송 왕복 일치. 10분째 왕복에서 `SFTP 연결 시간 초과`(채널 열기 15초 초과)로 중단. 같은 VM에서 2GiB 전송을 함께 돌린 탓에 입력 왕복이 3.4~5.6초까지 늘었던 구간이다. 단독 재실행은 대기 | — |

`blip`(짧은 정지 후 생존), `blackhole`(150초 정지 후 끊김 판정과 이어받기), `suspend-drop`(정지 중 서버가 세션을 끊음), `quit-graceful`(앱 종료 경로), `quit-kill`(SIGKILL 후 재시작 복구)은 구현했지만 **유효한 결과가 없다.** 시도한 실행은 Docker CLI가 1분 이상 걸려 8초로 의도한 정지가 97초가 되거나, 새 연결의 SSH 협상이 시간 초과되거나, `docker run`·`docker ps`가 응답하지 않아 장애를 일으키기 전에 끝났다. 정지는 Docker API를 거치지 않고 컨테이너 안에 열어 둔 셸로 바로 `pkill -STOP/-CONT/-KILL -u probe`를 보내도록 러너를 바꿨다. 이 방식으로는 아직 실행하지 못했다.

메모리: 모든 유효한 실행에서 프로브의 최대 RSS는 16MiB 이하였다. 2GiB 업로드 중에도 13MiB여서 전송이 파일을 메모리에 올리지 않는다.

## WebGL 렌더러 판단

**도입하지 않는다.** 32MiB, 1280×800, 세 번 측정(MiB/s, 32KiB 프레임의 p95 처리 시간):

| 엔진 | 렌더러 | `screenReaderMode` 켬(앱 설정) | 끔 |
|---|---|---|---|
| Chromium 156 | DOM | 25.8~33.6, p95 1.7ms | 66.4~79.4, p95 0.7ms |
| Chromium 156 | WebGL(ANGLE Metal, Apple M5) | 36.9~38.7, p95 1.7ms | 72.2~84.8, p95 0.7ms |
| WebKit 27.2 | DOM | 24.0~29.3, p95 2.0ms | 51.3~56.1, p95 1.0ms |
| WebKit 27.2 | WebGL(Apple GPU) | 12.9~15.8, p95 2.0ms | 40.2~58.5, p95 1.0ms |

- xterm은 write 콜백을 파싱 뒤에 부르고 그리기는 애니메이션 프레임마다 화면 한 장만 한다. 그래서 대량 출력의 처리량은 렌더러보다 파서와 접근성 트리가 정한다. WebGL은 Chromium에서 `screenReaderMode` 켬 기준 약 10~50%, 끔 기준 약 0~25% 빨랐고, macOS의 웹뷰인 WebKit에서는 `screenReaderMode` 상태에서 오히려 절반 수준으로 느렸다.
- 앱 설정(DOM, `screenReaderMode` 켬)의 24~34MiB/s와 프레임당 2ms 이하는 엔진·서버 경로의 실측(이번 환경 1~2MiB/s)보다 한 자릿수 이상 높다. 렌더러가 병목이 아니다.
- 메인 스레드 멈춤(애니메이션 프레임 사이 최대 간격)은 첫 실행의 Chromium DOM 233ms·WebGL 150ms를 빼면 렌더러와 무관하게 33~130ms였다.
- 처리량을 두 배 가까이 바꾸는 요인은 `screenReaderMode`다. 접근성 기본값을 바꾸는 일이라 이번에 손대지 않았다. 필요해지면 설정으로 끄는 선택지를 검토한다.
- 한계: 헤드리스 브라우저이고 Tauri IPC 왕복은 메시지 채널 한 번으로 대신했다. Chromium 헤드리스도 실제 GPU(ANGLE Metal)를 썼다. WebKit은 첫 실행에서 애니메이션 프레임이 0번 돈 경우가 한 번 있었다.

## 실행한 검사 (`52cb524` 위 미커밋 트리, macOS)

| 명령 | 결과 |
|---|---|
| `cargo test --locked -p dachsterm` | 685 통과, 4 무시, 실패 0 (새 `terminal_output` 테스트 5개 포함) |
| `cargo test --locked -p dachsterm --lib terminal_output` 5회 반복 | 매번 5 통과 |
| 같은 테스트, 판정을 옛 방식(30초 한 번)으로 바꾼 트리 | `a_clock_jump_while_waiting_counts_as_one_step`만 실패. 원복 |
| `cargo clippy --locked -p dachsterm --all-targets -- -D warnings`, `cargo fmt --all -- --check` | 통과 |
| `npm run probe:endurance` (위 표의 실행들) | 표 참고. 수정 후 결과는 출력 펌프와 SFTP 수정이 들어간 제품 코드로 실행했다. 그 뒤로 바뀐 것은 테스트와 프로브의 장애 주입(`docker pause` → 서버 셸의 `freeze`)뿐이고, 바꾼 러너로는 Docker 무응답 때문에 실행하지 못했다. 수정 전 결과는 `stall`만 SFTP 수정을 뺀 별도 빌드, 나머지는 수정 전 트리의 빌드다 |
| `npm run measure:render` 3회 | WebGL 표 |

실행하지 않은 것: `cargo test --workspace`(이번 변경은 `dachsterm` 패키지뿐), 프런트엔드 게이트(프런트엔드 코드 변경 없음), Windows 게이트와 CI, 실제 앱 조작.

## 남은 것

- **Docker 환경이 회복되면 순서대로**: `npm run probe:endurance -- --reuse-build --fault-mib 128 --scenarios blip,suspend-drop,blackhole,quit-graceful,quit-kill,cycles,link`, 이어서 `--scenarios transfer`(2GiB 다운로드), 마지막에 `--scenarios long --minutes 60`을 **단독으로** 실행한다. `--fault-mib`는 느린 경로에서만 줄인다. 깨끗한 환경에서는 기본값 512MiB가 장애보다 오래 걸린다.
- 실제 OS 절전·복귀: SIGSTOP은 "시계는 흐르고 프로세스는 멈춘" 상태만 흉내 낸다. 무선 연결 해제, NIC 전원 관리, 깨어난 뒤의 DHCP는 들어 있지 않다. Windows(시계가 절전을 센다)와 macOS(`CLOCK_UPTIME_RAW`) 실기기에서 SSH 5개, 터널, 전송을 켠 채 절전했다가 복귀하는 확인은 대기다([체크리스트 M4](windows-release-checklist.md)).
- 실제 네트워크 변경(Wi-Fi 전환, IP 변경): 이 Mac의 네트워크를 끊으면 작업 세션도 끊겨 하지 않았다. 서버 쪽 분리(`link`)와 응답 없음(`freeze`)으로 대신했다.
- 앱 화면을 포함한 대량 출력: 프로브(엔진)와 렌더 벤치(xterm)를 따로 쟀다. 실제 앱에서 `yes`·`cat`으로 대량 출력을 보내며 입력 반응과 WebView 메모리를 보는 확인은 대기다. Mac WKWebView에는 자동 검사 경로가 없다.
- 24시간 사용(M6): 대기. 장시간 시나리오는 60분이 기본이고 `--minutes`로 1440까지 늘릴 수 있다.
- 다운로드 창 크기(후속 후보): 클라이언트 SSH 수신 창이 256KiB(`ssh/route.rs`, 처음 들여온 코드부터의 값, 이유 기록 없음)라 다운로드는 대략 256KiB÷왕복 지연에 묶인다(100ms면 약 2.5MiB/s). 이번 다운로드(약 1.1MiB/s)는 업로드(1.9MiB/s)보다 느렸지만, 환경 지연 때문인지 창 때문인지는 가르지 못했다. 창을 키우면 터미널마다 버퍼에 쌓이는 양도 커지므로, 지연을 주입해 효과를 잰 뒤 정한다.
- `screenReaderMode`: 대량 출력 처리량을 절반으로 낮춘다. 접근성 기본값이라 바꾸지 않았다.
