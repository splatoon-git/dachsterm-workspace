# S.1 — RSA·인증·터미널 기본 기능

2026-11-05 사용자 요청. 이전 0.5.1의 RSA 개인키 차단 정책을 대체한다.

## 보안 변경

- [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)은 수정 버전이 없는 상태다. 두 workspace manifest에서 russh의 `rsa` feature를 제거하여 해당 패키지가 Cargo.lock에 남지 않게 했다. 감사 무시 목록은 추가하지 않았다.
- `src-tauri/src/rsa_auth.rs`: OpenSSH 일반/암호화, PKCS#1 PEM, PKCS#8 일반/암호화 키를 파싱하고 ring 0.17.14에 서명을 맡긴다. 누락된 CRT 지수만 crypto-bigint의 공개 모듈러스 크기/상수시간 나머지 API로 계산한다. 키 원문·중간 버퍼는 Zeroizing, 키 파일 읽기는1MiB 상한이다. RSA2048~8192비트, SHA256/512만 허용한다. SHA512 거부 시 SHA256으로 재시도하며 SHA1로 낮추지 않는다.
- russh의 호스트 검증은 ssh-key를 사용하므로 feature 제거만 하면 RSA 서버 호스트키도 사라진다. `vendor/ssh-key`에0.7.0-rc.11의 소스/라이선스를 보존하고 공개 RSA 검증만 ring에 연결했다. 변경점/유지보수 기준은 `vendor/ssh-key/DAXTERM-PATCH.md`. 자체 RSA 패딩·지수승 알고리즘을 구현하지 않았다. 업그레이드 때 패치 재검토가 필요하다.
- `ssh_auth.rs`: Windows OpenSSH named pipe 또는 Unix SSH_AUTH_SOCK, 최대5회 키 시도, 가능한 경우 session binding, agent forwarding 없음. agent 사용자 인증서 identity 경로도 있지만 CA 실서버/하드웨어 agent 조합은 미검증이다.
- keyboard-interactive 전용 모드와 password/key/agent의 partial-success 뒤 추가 인증. 질문 최대16개/12회, 응답당120초, 요청·전송30초. 응답은 연결 소유 창의 전용 IPC/1개 큐로 전달하고 DB·로그·복구본에 저장하지 않는다. 취소 시 해당 연결 종료. UI와 native 명령 모두 추가 인증 답변 저장을 거부한다.

## 기본 기능 점검

| 항목 | 결과 |
|---|---|
| 선택 자동 복사·우클릭 붙여넣기 | 기본 켜짐, 개별 설정. TUI 마우스 모드에서는 Shift로 명시적 우회 |
| Ctrl/Cmd+Shift+C/V·Shift+Insert | 추가. Ctrl+C/방향키 등 기존 xterm 입력 유지 |
| 여러 줄·제어문자 붙여넣기 | 버튼·키보드·우클릭 모두 확인/취소 |
| Backspace/방향키/Home/End/Delete/Tab | xterm 모드 유지, PTY VERASE=127/IUTF8 요청, Ctrl+H 호환 선택 |
| SFTP 경로 따라가기 | 기본 켜짐·연결별 끄기·새 탐색기 기본값 저장, OSC7/1337 |
| 알림 없는 Bash/Zsh | 셸 대기 중 연결 버튼으로 현재 세션용 prompt hook, dotfile 변경 없음 |
| 검색/스크롤백/글꼴·탭/분할·재접속/KeepAlive·known_hosts | 기존 구현 유지/회귀 대상 |
| 폴더 재귀 업·다운로드/예약 큐·세션 로그·점프 호스트 | 미지원. 원격 폴더 복사와 로컬 폴더 전송은 별개 |
| GSSAPI/Kerberos·직접 FIDO2·Pageant·agent forwarding·호스트 CA 인증서 | 미지원. 모든 인증 방식을 지원한다고 표현하지 않음 |

SFTP는 같은 연결의 원격 경로만 사용한다. OSC의 호스트를 새로운 접속이나 로컬 파일 URL로 해석하지 않는다. 절대 경로·길이·제어문자를 검사한다. `cd` 입력을 추측하거나 별도 셸의 `pwd`를 조회하지 않는다. 알림 없는 셸은 연결 버튼 또는 수동 경로 이동이 필요하다. 서버 terminfo/로케일/셸 오류까지 클라이언트만으로 자동 수정하지 않는다.

## 검증

- Windows 감사0건, 전체 보고서의 타 플랫폼 경고5개 보존. npm audit0건. 고지424개/라이선스 원문 누락0(vendored ssh-key 포함).
- `node scripts/run-phase1.mjs` 실제 OpenSSH 엔진 전체 종료0: RSA 일반·암호화 OpenSSH/PEM/암호화 PKCS8, 잘못된 Passphrase 거부, 실제 OpenSSH agent를 격리 named pipe로 연결, RSA-only 호스트·SHA256-only 사용자키·키+PAM 추가 인증·취소 및 기존 전체 회귀. 실제 OTP 제공자를 시험한 것은 아니다.
- 프런트 단위32개, UI26개, build/typecheck/lint/format 통과 기록. 마지막 변경 이후 최종 결과는 progress의 S.1 최종 기록을 따른다.
- `$env:CARGO_TARGET_DIR='D:/Work/daxterm-workspace/src-tauri/target/windows-hardening'; node scripts/run-phase1.mjs --native --reuse-build` 종료0. `scripts/verify-terminal-basics.mjs`를 기존 test-native가 호출했다(기능 검사 생략 옵션 미사용). 실제 Bash cwd·팔로우on/off·패널 재마운트, 캔버스 드래그 복사, 우클릭/단축키 붙여넣기와 위험 붙여넣기 취소, 방향키/Home/End/Backspace·Ctrl+H·설정 유지, agent·서버 질문·암호화 RSA+추가 인증과 비밀 참조 미저장 모두 통과. 기존 게임 복귀/5탭/선택 입력/파일·편집/CP949/분할/TUI/분리창/재접속/보관함/변경 호스트키 차단까지 전체 통과. 테스트 fixture·키·자격 증명·원격 파일 제거 완료.
- 앞선 실패는 비동기 클립보드 읽기 직후 Enter를 보낸 검사 순서와 테스트 프로필 삭제창이 닫히기 전 다음 단계 입력을 시작한 문제를 보정했다. 실제 keyboard-interactive의 질문0개 정보 요청은 즉시 응답하도록 제품 코드를 수정한 뒤 재검증했다. 최초 실패를 통과로 기록하지 않았다.
- Mac, 물리 Windows IME, 실제 OTP/스마트카드·FIDO agent, Zsh 실기기, 다른 서버OS, 장시간/절전은 미검증. 기존 W.4/M1~M10을 완료 처리하지 않는다.

참조: [MobaXterm 설정](https://mobaxterm.mobatek.net/documentation.html), [russh0.65.1](https://docs.rs/russh/0.65.1/russh/), [ring0.17.14 RSA 소스](https://docs.rs/crate/ring/0.17.14/source/src/rsa/keypair.rs). 디자인은 기존 공통 테마 계약을 유지한다.
