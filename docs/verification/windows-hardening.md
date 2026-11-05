# Windows 안정화 W.1~W.4

> S.1 후속: 아래 W.3의 RSA 차단·취약점1건은 기존0.5.1 산출물 이력이다. 현재 소스는 취약 의존성을 제거하고 RSA SHA-2 인증을 복구했다. Windows 감사0건이며 [S.1 검증](security-terminal-basics.md)과 progress의 최신 결과가 우선한다.

2026-11-05 사용자 요청으로 Mac을 후순위로 두고 Windows 데이터 보호·진단·배포 검사를 보완한다. 실제 검증 결과는 progress의 최신 기록을 우선한다.

## 데이터 보호와 복구

- 세션 삭제: DB 삭제와 OS 인증정보 정리 journal을 같은 트랜잭션으로 확정한 후 OS 항목을 제거한다. DB 실패 시 기존 세션과 참조를 유지한다. OS 삭제 실패는 다음 세션 조회에서 재시도하고 경고한다.
- 시작: DB quick_check, 5초 busy timeout, 스키마 트랜잭션. 손상된 DB/미래 버전을 자동 초기화하지 않는다. 앱별 데이터 폴더의 OS 파일 잠금은 중복 프로세스가 같은 저장소를 수정하는 것을 막고, 프로세스 종료 시 해제된다.
- 설정: 기존 세션 수정·세션/그룹 삭제·터널 설정 교체·JSON 가져오기 전에 사용자 전용 `recovery` 폴더에 복구본을 저장한다. 최근 10개만 보관한다. 복구본 저장 실패 시 변경을 중단한다.
- 복구 범위: 세션·그룹·터널 설정. 비밀번호·개인키 내용·OS credential 참조·마스터 암호 설정·신뢰 호스트키·편집 파일·전송 부분 파일·UI 테마는 포함하지 않는다. 주소/계정/키 경로 등 접속 메타데이터는 포함되므로 외부 공유하지 않는다. 복구 시 새 ID로 추가하고 터널 자동 시작을 끈다.
- 파일 교체는 같은 디렉터리의 임시 파일을 동기화한 뒤 원자적으로 교체한다. 파일 시스템의 정전 내구성을 보장하는 전체 시스템 백업은 아니다. 설정 파일은 읽는 도중에도 2MiB 상한을 적용한다.
- 외부 편집 복구 manifest도 같은 원자적 저장을 사용한다. 재시작 시 manifest 읽기 크기를 제한하고, 형식이 깨진 파일 때문에 로컬 수정본을 삭제하지 않는다.

### 앱이 시작되지 않을 때

1. 기존 DaxTerm 창/프로세스가 있는지 먼저 확인하고 정상 종료한다. 잠금 파일 자체를 지워 실행 중인 보호를 우회하지 않는다.
2. `%APPDATA%\app.daxterm.desktop`을 확인한다(Tauri 앱 데이터 위치). **앱을 완전히 종료한 뒤** `sessions.sqlite3`와 `-wal`/`-shm`, `recovery`, `edits`, `known_hosts`를 포함한 폴더 전체를 별도 위치에 보존한다. DB 파일 하나만 실행 중 복사하지 않는다.
3. 손상 DB를 덮어쓰지 않는다. 별도 Windows 사용자/테스트 환경의 새 앱에서 보존한 `recovery/*.json`을 가져와 설정을 복구하고 인증정보를 다시 입력한다. SSH 호스트 지문을 다시 검증한다. 원래 OS 자격 증명과 마스터 설정이 없는 다른 PC로 암호가 복원되지는 않는다.
4. 미업로드 수정본은 `edits`에서 별도로 보존·대조한다. 자동 삭제하지 않는다. 이전 앱의 DB 형식이 다르면 설치 파일만 되돌려 복구됐다고 판단하지 않는다.

## 진단

설정의 진단 저장은 앱 버전/OS/아키텍처/debug 여부/DB quick_check·스키마/세션·그룹·작업 개수만 JSON으로 저장한다. raw 로그·오류 문자열·프로필 값·환경변수·경로·터미널 출력을 수집하지 않는다. 사용자 선택 파일로만 저장하며 자동 전송하지 않는다.

## Windows 실행 창과 분할 포커스

- `src-tauri/src/main.rs`는 debug에 콘솔을 허용하고 release에 Windows GUI subsystem을 적용한다. 2026-11-05 실제 PE 헤더 확인: `target/debug/daxterm.exe` subsystem 3(Console), `target/release/daxterm.exe` subsystem 2(GUI). debug EXE 직접 실행 시 검은 콘솔 창이 함께 뜨는 것은 현재 설정에 따른 동작이다. 배포 설치본은 release 실행 파일을 사용한다.
- 분할 화면의 모든 보이는 터미널이 각각 포커스를 요구하던 문제를 수정했다. 보임과 입력 대상 상태를 구분해 활성 pane만 포커스를 받고, pane 안 검색창/컨트롤의 포커스를 빼앗지 않는다. 실제 SSH 2×2 각 pane 입력·출력 검사 및 전체 Windows native 회귀를 통과했다.

## 보안·공급망

- npm 개발 의존성의 `minimatch@10.2.6`에서 [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)를 확인. 해당 범위를 11.0.1로 한정 override하고 lockfile을 갱신했다. Node24에서 lint/build/test로 호환성을 확인한다. 상위 패키지가 수정 버전을 요구하면 override를 제거한다.
- FTPS PEM 읽기는 유지보수가 끝난 rustls-pemfile 대신 같은 Rustls pki-types의 PemObject를 사용한다. [RustSec 권고](https://rustsec.org/advisories/RUSTSEC-2025-0134.html).
- **RSA 개인키 인증 차단**: [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)에 수정 버전이 없으므로 제품의 원격 인증 서명 전에 RSA 개인키를 거부한다. RSA 서버 호스트 공개키 검증과 개인키 서명은 다른 경로다. 라이브러리는 남아 있으므로 audit 결과를 0건으로 주장하지 않는다. 검증된 대체 구현/업스트림 수정 전 공개 배포 보안 게이트는 보류한다.
- 전체 Cargo.lock에는 Linux 전용 경고도 포함된다. Windows 의존 경로와 빌드 전용 경로를 구분해 검토하되 무조건적인 ignore 목록은 추가하지 않는다.
- `scripts/audit-windows.mjs`는 전체 감사 결과를 보존한 채 Windows 대상 의존 그래프에 실제 포함되는 항목으로 출시 판정을 한다. 2026-11-05 결과: Windows RSA 취약점 1건으로 실패, 나머지 5개 경고는 Windows 그래프 밖이다. RSA 개인키 경로 차단은 완화 조치이며 라이브러리 자체 수정이나 감사 0건을 의미하지 않는다.
- `scripts/generate-notices.mjs`: 잠긴 Windows 의존성 및 npm 런타임 의존성의 라이선스·원문을 `licenses/`에 생성한다. 패키지에 원문이 없으면 `--fetch-missing`으로 해당 패키지의 저장소/커밋에서 찾아 고정한다. 찾지 못한 항목은 실패로 보고하며 이름·버전을 inventory에 남긴다. 앱 자체 라이선스/마스코트 배포 권리는 이 수집으로 확정되지 않는다.

## 반복 가능한 검사

```powershell
./scripts/verify-windows.ps1
./scripts/verify-windows.ps1 -Native
./scripts/verify-windows.ps1 -Native -Package -RequireSigned
node scripts/run-phase1.mjs --stress-minutes 5
```

- 자동 검사는 실패 즉시 중단한다. Cargo 감사에 미해결 항목이 있으면 게이트 전체는 실패다. 서명 옵션은 유효한 Authenticode가 없는 설치본을 공개용으로 승인하지 않는다.
- GitHub Actions 정의는 Windows 정적/단위/UI 검사를 실행한다. 이 작업 공간은 Git 저장소/연결된 원격 저장소가 없어 원격 CI가 실행됐다는 의미는 아니다. Docker Linux fixture의 실접속은 로컬 `-Native` 단계로 구분한다.
- 기존 실행 앱을 덮어쓰지 않으려면 `CARGO_TARGET_DIR`로 검사 빌드 폴더를 분리한다. SSH/FTP wrapper가 같은 경로의 앱과 probe를 사용한다. 단독 maintenance 검사는 해당 경로의 실행 파일을 `DAXTERM_TEST_BINARY`로 지정한다. `--skip-app-build`는 이미 검증 대상 앱을 빌드했을 때 SSH 예제만 재빌드하고 실행한다.
- SSH stress는 실제 제품 엔진의 연결/1MiB 출력/종료를 최소30회·지정 시간 반복한다. 10회마다 프로세스 private bytes/handle 수를 기록하고 첫 샘플 대비 +96MiB/+128 상한을 적용한다. `target/verification/ssh-stress.json`에 시간·횟수·수치를 남긴다. WebView2나 실제 절전·24시간 검사 결과를 대신하지 않는다.
- 설치 검사는 기존 사용자 설치가 있으면 중단한다. 선택적 `-Reinstall`은 같은 버전 덮어설치와 테스트 파일 보존을 검사한다. 실제 이전 버전에서의 데이터 이행은 별도 수동 검증이다.
- `scripts/test-installer.ps1 -PreviousVersion 0.5.0 -Version 0.5.1`은 테스트 전용 경로의 이전 설치본을 새 설치본으로 교체하고 버전/일반 파일 보존을 검사한다. 실제 사용자 데이터에 테스트 세션이나 암호를 주입하지 않으므로 이 검사도 전체 데이터 이행 성공을 뜻하지 않는다.

실제 수동/외부 환경 목록: [Windows 출시 체크리스트](windows-release-checklist.md).

## 2026-11-05 검증 기록

- `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`(29개), `npm run build`, `npm run test:ui -- --workers=2`(20개) 통과. 초기 4-worker 실행에서 테마 순회 검사 1건이 전체 시간 제한에 걸렸으며, 2-worker 전체 실행은 통과했다. 검사 내용을 생략하거나 assertion을 완화하지 않았다.
- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo test --workspace --locked`(앱 23개+실증 1개) 통과. DB 삭제 실패/이행 rollback/손상 원본 보존/파일 잠금/복구본 및 진단의 민감 값 제외를 검사했다. 중간 PDB 링크 실패는 재실행으로 통과했고, 기본 앱 EXE 사용 중 빌드 실패는 별도 `target/windows-hardening` 빌드로 분리했다.
- `node scripts/test-maintenance-native.mjs`(해당 DAXTERM_TEST_BINARY 지정): 실제 Windows WebView2 복구본 생성→세션 삭제→새 ID로 가져오기→잘못된 경로 거부→재시작 후 유지, 560px 넘침 검사 통과. `test-results-native/maintenance.png`, `maintenance-narrow.png` 시각 확인 자료. 초기 테스트가 테마 상태 텍스트까지 선택하던 locator 오류를 복구 영역으로 한정해 수정했다.
- `node scripts/run-ftp.mjs --reuse-build --native`(해당 CARGO_TARGET_DIR 지정): 실제 FTP/FTPS/CP949 32MiB 재개/바이트 일치·미신뢰 CA 거부, Windows FTP/FTPS 폼·파일 작업·좁은 창 검사 통과. 수정한 PEM 파서 포함.
- `npm audit --audit-level=low`: 0건. `cargo audit --deny warnings`: 취약점1/경고5로 실패. `node scripts/audit-windows.mjs`: Windows 해당 취약점1, Windows 밖 경고5로 실패. `scripts/verify-windows.ps1`은 앞선 정적/단위/UI 검사를 통과한 뒤 이 보안 게이트에서 의도대로 중단되었으며 전체 성공으로 기록하지 않는다.
- `node scripts/generate-notices.mjs`: Windows Cargo 및 npm runtime 426개 항목, 원문 누락0. 설치 리소스에 포함. 공개 배포 권리와 라이선스 의무의 검토는 별도다.
- SSH 장시간/최종 패키지의 마지막 실행 결과와 정확한 SHA256은 progress의 최종 W.1~W.4 기록을 참조한다. 5분 stress는 24시간 실사용이나 OS 절전 검사 완료를 의미하지 않는다.
- 최종 SSH 엔진 stress: 보고서 경로를 UI 검사 정리 대상 밖으로 옮긴 뒤 재실행 종료0. 300초/329회/회당1MiB 출력·종료 통과. 첫 리소스 샘플 private6,164,480바이트/핸들194, 마지막 샘플10,473,472바이트/193, 최대10,473,472바이트/197. `target/verification/ssh-stress.json`의 `completed:true`로 확인. 이전 300초/322회 실행도 통과했다. 초기 하네스에서 대기 연결 ACK를 처리하지 않던 문제와 종료 후 이미 큐에 들어온 Data를 삭제된 Control로 ACK하던 경합을 수정했다. 앞선 실패를 성공으로 집계하지 않았다.
- 최종 패키지: `DaxTerm_0.5.1_x64-setup.exe` 9.26MiB, SHA256 `CAAE2072D5A89E0633FFF23C32B2792B17A0138792DE15C27198C11DDBA10EBC`. 설치→0.5.0에서의 설치본 교체→동일 버전 재설치→실행/종료/제거, 라이선스 파일 포함 통과. 실제 사용자 DB/암호 이행은 수동 항목으로 유지. Authenticode `NotSigned` 및 공개 승인 false manifest 동봉.
