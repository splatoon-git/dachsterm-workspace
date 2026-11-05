# Phase 6.3 세션 로그 · 6.7 PodTree

## 구현 계약

- `src-tauri/src/session_log.rs`: Rust PTY 출력 생산자 한 곳에서만 디코딩/기록한다. SSH의 Broker 재생/창 분리는 기록 경로가 아니다. 로컬/WSL은 같은 Logs 소유자를 공유한다. 인증 이벤트와 입력은 API에 연결하지 않는다.
- 출력 디코더/ANSI 상태는 꺼짐/일시정지 중에도 이어진다. UTF-8·CP949 등 세션 인코딩을 UTF-8로 바꾼 뒤 CSI/OSC/DCS/APC/PM/SOS와 제어문자를 제거한다. 화면 자체를 재구성하지 않으므로 CR/커서 이동을 쓰는 TUI 출력은 화면과 동일한 배치가 아니다.
- 로그당 64개 프레임(원본 프레임32KiB, 디코딩 최대 약96KiB) 큐, 미완성 줄64KiB 상한. 디스크 쓰기는 전용 작업자에서 수행한다. 큐 초과/줄 상한/디스크 오류는 중단과 누락 안내를 남기며 SSH ACK/화면을 종료시키지 않는다. 문자열 마스크는 완성된 줄에서 겹친 구간까지 병합하며 패킷/ANSI 경계를 넘는다. 마스킹은 메모리에만 유지하고 끝나면 zeroize한다.
- 시작/일시정지/재개/종료·상태/현재 파일·자동 기록 설정을 UI에 표시한다. 기본 꺼짐. 자동 설정은 SSH 프로필 또는 로컬 환경별로 명시적 저장하고 설정 복제/세션 내보내기에 섞지 않는다. 마스킹 없는 자동 기록임을 표시한다.
- 파일은 이름 정제+Unix 시각+UUID 전용 폴더에 `create_new`로 생성한다. 회전1~1024MiB, UTC 날짜 변경, 기록당1~100파일 보관. 기존 기록은 덮어쓰거나 삭제하지 않는다. **이전 기록 폴더의 총 용량은 사용자 관리**다. Unix 폴더0700/파일0600, Windows는 선택 위치의 ACL을 상속한다.
- 일시정지 경계에서 미완성 줄을 버린다. 정상 종료는 큐의 기존 출력과 마지막 조각을 flush/sync한다. 앱 종료 시 최대3초 기다리고 미완료이면 저장 시간 초과를 표시한다. 강제 OS 종료/디스크 고장은 무손실을 보장하지 않는다.
- `src-tauri/src/podtree.rs`: 독립 SSH session/PTY 또는 WSL/Bash PTY, 최대16탭, 입력32프레임/출력32KiB ACK·30초 타임아웃. 셸/멀티 입력/스니펫/세션 로그 관리 대상과 별도 소유한다. SSH 연결 해제는 종속 PodTree 종료로 전파되며 PodTree 종료는 원래 셸을 유지한다.
- 설치 없는 사용자 전용 임시 배치 방식. 의존성·context/namespace를 확인하고 전역 current-context나 kubeconfig를 변경하지 않는다. 준비 시간20초/출력128KiB 상한, PTY 준비15초. 임시 경로는 상태바에 표시. 실패/취소는 채널을 닫고, 스크립트 EXIT/HUP/TERM은 자식 수집기/포워딩과 소유 임시 파일을 정리한다. 네트워크가 물리적으로 끊기거나 OS가 프로세스를 강제 종료하면 서버의 신호 처리에 따라 임시 파일이 남을 수 있다.
- `src-tauri/assets/podtree`: 사용자 제공2.4.0, 수정판2.4.0-daxterm.1. 원본 변경 없음. 포함·수정·배포 권한은2026-11-05 사용자 확인. 출처/양쪽SHA는 provenance.json, 저작 고지는 licenses/PODTREE_NOTICE.txt. 공개 OSS 라이선스를 임의 부여하지 않았다.
- 조회 모드는 delete/rollout/cordon 이외 exec/debug/캡처/포트포워딩/네트워크 실행 프로브/raw proxy도 차단한다. producer의 직접 kubectl 실행 우회와 AI 직접 raw 경로를 막고 GPU/vLLM proxy수집을 끈다. `LESSSECURE=1`로 pager 셸 탈출을 막는다. 운영 모드는 사용자가 선택하며 추가 동작은 context·실제 대상·부작용 확인을 거친다. `.podtreerc`는 내장에서 읽지 않고 scope 변경 키도 새 탭 안내로 대체한다.

## 실행 검증

- Windows debug 앱 + 실제 PowerShell/OpenSSH/WSL + 실제 kind Kubernetes. 테스트용 OpenSSH 암호는 tmpfs에서 메모리로만 읽으며 로그 마스크에는 합성 문자열을 사용했다. 토큰/인증서/kubeconfig는 격리 클러스터와 테스트용 실행 환경 안에서만 사용하며 앱 저장/출력 파일에 복사하지 않았다.
- Rust 단위: UTF-8/CP949 분할 바이트, ANSI/OSC 분할, 겹친 마스크, pause 경계, 다시 시작 시 새 파일, 크기/날짜 회전, 보관 수, 읽기 전용 파일 핸들의 쓰기 실패, 큐 가득 참. PodTree 인자 인용/이름 검증·자산 해시.
- 실제 Windows/OpenSSH 기본 통합 통과: UI 기록 시작, 한글/마스크/정지/재개/flush; 실제 SSH 출력 순서/패킷 경계; 3MiB 이상 출력의1MiB 회전/2파일 보관; CP949 분할 바이트→UTF-8 파일; WSL 명시적 자동 기록·종료flush; 창 분리30줄 정확히1회·순서 유지.
- 실제 Kubernetes 기본 통합 통과: SSH와 WSL의 context/namespace/tree/logs, 조회 모드 키 차단, 멀티 입력 대상 제외, resize, 탭 종료와 임시 폴더 삭제. metrics-server 없음이 트리를 막지 않음.
- 최종 추가 통합 통과: WSL 제한 RBAC 계정의 namespace 목록 거부 안내·허용된 파드/로그 조회, 빈 namespace, 이벤트, SSH kubectl 부재/PowerShell 대상 거부. 운영 모드의 대상 확인→포트 포워딩 실제 스트림→탭 종료 후 프로세스 정리, 부모 SSH 종료→PodTree 종료/임시 파일 정리, 전역 current-context 불변.
- 실제 앱 재시작에서 명시적 자동 기록 설정 복원·새 파일 기록/flush, 560px 다크 테마에서 사이드바 접기→로그 설정/자동 기록 끄기 통과. 최종 native 13개 시나리오, pageErrors0, 정상 종료0. 키별 조회 차단은 실제 PTY 입력 IPC로 검사했으며 물리 키보드 검증과 구분한다.
- 정적/단위: Rust 전체54개 및 최종 로그6개/PodTree2개, frontend41파일652개, TypeScript, 관련 TS/JS ESLint·Prettier, Rust clippy lib 경고0, Bash 자산/fixture 구문 검사 통과. 최종 `tauri build --debug --no-bundle` 성공(Vite의 기존 번들 크기 경고 유지).
- 보존 실행 파일: `target/verification/phase63-67-artifacts/daxterm-debug.exe`, SHA256 `4cd220a16efe4d8e54151a98a04391f2f611320c19cb20e89f9546f5aa78b8e4`. 해당 파일을 명시한 `node scripts/test-phase63-67-native.mjs` 최종 종료0. `phase63-67-native.json` 및 화면 캡처를 같은 보존 폴더에 복사했다. 공유 target/debug나 기존 release/설치본을 이 결과로 대체하지 않는다.

## 재현

1. WSL Ubuntu에 Bash4+, kind, kubectl, Docker 및 고정 kind/busybox 이미지를 준비한다. `bash scripts/setup-phase63-67.sh`는 이름이 같은 기존 클러스터가 있으면 생성에서 실패하며 기본 kubeconfig를 변경하지 않는다.
2. `node node_modules/@tauri-apps/cli/tauri.js build --debug --no-bundle` (Cargo PATH, Node 메모리1GiB 설정). 독립 보존본을 `DAXTERM_TEST_BINARY`에 지정한다.
3. `node scripts/test-phase63-67-native.mjs`. 결과 `target/verification/phase63-67-native.json`, UI캡처. 테스트가 만든 OpenSSH 컨테이너/앱은 finally에서 종료한다. 실패 중 인증 대화 내용은 출력하지 않는다.
4. 테스트 후 WSL에서 `kind delete cluster --name daxterm-podtree-check`, `/tmp/daxterm-podtree-check.config`만 제거한다. 사용자 kubeconfig와 다른 컨테이너는 유지한다.

## 미검증

Mac 실기기·WKWebView, 물리 IME·키보드, 강제 OS 종료/실제 디스크 가득 참·24시간 기록, GPU/vLLM/DCGM 실제 공급자·디버그 이미지/패킷 캡처. 조회 모드와 기본 트리 성공을 이 환경의 성공으로 확대하지 않는다. release/NSIS 재생성·설치는 이번 요청에서 수행하지 않았다.
