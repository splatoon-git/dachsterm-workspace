# ADR 0001 — russh + russh-sftp 채택, macOS 검증 조건부

- 날짜: 2026-11-04
- 상태: Windows 실증에 근거한 채택. Mac 기본 빌드·접속 통과 전 Phase 0 전체 완료는 아님.
- 범위: Phase 0 라이브러리 선택과 후속 설계 제약. 제품 연결 UI는 Phase 1 범위.

## 결정

SSH는 `russh = 0.65.1` (`ring`, `rsa`; 기본 feature 비활성), SFTP는 `russh-sftp = 3.0.1`을 사용한다. 비교 도구에만 `ssh2 = 0.9.6`을 둔다. 버전은 Cargo.toml의 exact 요구와 Cargo.lock으로 고정한다. 데스크톱 바이너리는 아직 SSH 실증 crate를 의존하지 않아 검사 전용 기능이 앱 IPC에 노출되지 않는다.

Windows MSVC에서 russh의 Ed25519·비밀번호·암호화 개인키 인증과 PTY, 같은 연결 위의 동시 SFTP, 취소, 포워딩이 실제 OpenSSH에서 통과했다. 비동기 Tokio 작업과 독립 채널을 그대로 유지할 수 있어 Rust가 연결을 소유하는 구조에 적합하다고 판단했다.

## 비교 근거

| 항목 | russh + russh-sftp | ssh2 기본 Windows backend |
|---|---|---|
| 호스트키 | Ed25519 직접 핀 검증·잘못된 키 거부 통과 | Ed25519 전용 서버 handshake 실패 `Session(-5)`. 지원 목록은 RSA 계열만 반환. RSA host를 추가하고 SHA-2 RSA를 선택한 뒤 핀 검증·접속 통과 |
| 비밀번호·개인키 | 비밀번호, 일반/암호화 Ed25519, 잘못된 비밀번호·Passphrase 거부 통과 | 비밀번호·잘못된 비밀번호 통과. 개인키 두 방식은 비교 후보에서는 미실행 |
| PTY | 실제 셸 입출력·한글·resize 통과 | PTY exec 및 resize 통과 |
| SFTP | 두 2MiB 왕복과 PTY 출력 동시 처리, 내용 일치·취소·disconnect 통과 | 64KiB 단일 왕복 내용 일치 통과. 동시 처리·취소는 미실행 |
| 포워딩 | Local / Remote 왕복·해제·SOCKS5 domain CONNECT 통과 | direct-tcpip 왕복 통과. Remote/SOCKS5는 미실행 |
| 실행 모델 | Tokio async, 독립 channel과 bounded queue | Session 공유 객체는 내부 mutex를 사용하며 blocking 호출이 같은 Session의 다른 작업도 막을 수 있음. nonblocking EAGAIN dispatcher 또는 별도 연결 전략 필요 |
| Mac | 미실행 | 미실행 |

`ssh2` 자체가 일반적으로 Ed25519를 지원하지 않는다는 뜻이 아니다. **이번에 빌드한 기본 Windows crypto backend**의 결과다. OpenSSL backend로 feature를 변경하면 결과가 달라질 수 있으나 해당 구성은 실증하지 않았다. 공개키 메모리 인증 API도 openssl feature 또는 Unix 조건부다. 별도 crypto 배포 의존과 동시성 dispatcher 비용을 추가하면서 후보를 더 확장할 근거가 없어 우선순위 후보 russh를 선택한다.

실행 근거: [Windows 검증 기록](../verification/phase-0-windows.md), `crates/ssh-probe/src/main.rs`, `npm run probe` 최종 종료 코드 0. Windows 결과를 Mac 성공으로 간주하지 않는다.

## 보안·자원 관리 계약

1. 현재 실증의 host pin은 격리된 Docker fixture에서 별도 제어 경로로 취득한다. 제품에서는 서버 주소·포트별 `known_hosts`, 미등록 키의 지문 표시와 사용자 신뢰 확인, 변경된 키 기본 차단을 구현해야 한다. `check_server_key = true` 같은 우회는 사용하지 않는다. 인증서 host key는 CA 정책 구현 전 거부한다.
2. 비밀번호·키·Passphrase는 저장소·문서·로그에 기록하지 않는다. fixture tmpfs와 검사기 프로세스 환경에서만 전달하고 검사 종료 뒤 컨테이너를 제거한다. 제품 저장은 OS 비밀 저장소와 별도 참조 ID를 사용한다.
3. 프로필 ID, 물리 연결 ID, PTY ID, 탭/뷰 ID, SFTP 작업 ID, 터널 ID를 분리한다. 연결은 Rust의 연결 관리자가 소유하고 UI 구독자는 별도로 관리한다. 재접속은 새 연결·새 셸이며 이전 명령을 재실행하지 않는다.
4. PTY·SFTP·모니터링은 독립 채널과 취소 범위를 가진다. 전송 취소 시 열린 파일을 닫고 부분 파일 정책을 실행한 뒤 worker join. 연결 단절은 종속 작업을 모두 종료시킨다. Drop만으로 원격 프로세스 정상 종료를 보장한다고 가정하지 않는다.
5. 실증기는 채널 queue 16개, 수집 출력 1MiB 상한, stage 90초 제한, 네트워크·worker timeout을 사용한다. 제품 PTY→IPC는 bounded byte queue와 소비자 acknowledgement를 설계해야 한다. 느린 UI로 인한 출력 누락·무한 메모리 증가를 허용하지 않는다. 현재 결과는 제품 고속 출력 검증이 아니다.
6. 터널은 loopback에 바인딩하며 반환된 실제 remote port를 저장한다. 실증에서 종료 후 listener 재바인드/원격 접속 거부를 확인했다. 실제 제품의 거부·충돌·재접속 UI는 Phase 3에 구현한다.
7. Dynamic은 SOCKS5 TCP CONNECT만 지원하는 자체 parser + `direct-tcpip` 조합으로 구현한다. domain을 로컬 DNS로 바꾸지 않고 서버로 전달한다. UDP ASSOCIATE/BIND와 지원하지 않는 auth method는 명시적으로 거부한다. 실증기는 한 연결만 받고 종료하며 제품 서비스가 아니다.

## 한계와 재검토 조건

- russh의 전이 의존에 `ssh-key 0.7.0-rc.11`, `rsa 0.10.0-rc.18`, `pkcs1 0.8.0-rc.4`가 포함된다. lockfile을 유지하고 업데이트마다 실제 통합 검사를 재실행한다. RC를 안정판으로 표현하지 않는다.
- RSA 사용자키·인증서·agent·PKCS#11·프록시·다른 OpenSSH 버전·실네트워크 단절은 이번 성공 범위에 없다.
- 실제 vim/top/htop·IME 조합 입력, 대량 출력 backpressure, 장시간 전송은 해당 후속 Phase의 통합 검증이 필요하다.
- Mac 네이티브 기본 빌드·접속이 실패하거나 선택 backend가 배포 요구를 충족하지 않으면 crypto feature와 엔진 결정을 재검토한다.

## 참고 API (실증과 구분)

- [russh client Handle](https://docs.rs/russh/0.65.1/russh/client/struct.Handle.html)
- [russh-sftp](https://docs.rs/russh-sftp/3.0.1/russh_sftp/)
- [ssh2 Session](https://docs.rs/ssh2/0.9.6/ssh2/struct.Session.html)
- [Tauri streaming Channel](https://v2.tauri.app/develop/calling-frontend/)
