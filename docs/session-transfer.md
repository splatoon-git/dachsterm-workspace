# 세션 교환 포맷과 외부 설정 가져오기 — I.1

2026-11-05 사용자 요청. DaxTerm의 공개 교환 규약을 버전 있는 JSON으로 고정하고 프로그램별 읽기 어댑터로 변환한다. 여러 프로그램이 이미 합의한 업계 표준이라는 뜻은 아니다. 다른 제품이 DaxTerm JSON을 직접 읽는다고 주장하지 않는다.

## 사용

설정 → 세션 가져오기·내보내기 → 형식/파일 인코딩 → 파일 선택·미리보기 → 가져올 항목 선택/빠진 사용자명 입력 → 세션 추가. 같은 파일을 다시 적용하면 사본이 추가된다. 자동으로 연결하거나 원본 세션을 덮어쓰지 않는다. 변경 전에 기존 설정 복구본을 만든다.

PuTTY는 `HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions`를 레지스트리 편집기에서 `.reg` 파일로 내보낸다. DaxTerm은 그 파일을 텍스트로 읽으며 레지스트리에 실행/등록하지 않는다. MobaXterm은 왼쪽 세션 목록의 우클릭 내보내기 `.mxtsessions` 또는 `MobaXterm.ini`를 사용한다. OpenSSH는 `config` 파일을 선택한다. UTF-16 BOM을 자동 처리하며 UTF-8, CP949, Windows-1252를 선택할 수 있다. 글자가 깨지면 적용 전에 인코딩을 바꿔 다시 선택한다.

| 입력 | 변환 범위 | 제외·제약 |
|---|---|---|
| DaxTerm JSON v1 | 기존 파일의 세션·그룹·터널 | 새 ID, 비밀정보 참조 제외, 자동 시작 해제 |
| DaxTerm JSON v2 | SSH/FTP/FTPS 세션·그룹·즐겨찾기·인코딩·인증 방식/키 경로·터널 | 앱 테마/배치/실행 중 연결·접속 이력·보관함·호스트키 신뢰 제외 |
| PuTTY `.reg` | SSH 세션명(% 인코딩), 호스트, 포트, 사용자, OpenSSH 키 경로 | SSH 외/프록시 세션 제외. `.ppk`는 PuTTYgen에서 별도 OpenSSH 변환 후 재지정. 터널/agent 우선순위/자동 명령 등 제외 |
| MobaXterm `.mxtsessions`, `.ini` | `[Bookmarks]`/`[Bookmarks_N]`의 SSH 공통 접두부(type 0): 이름, 호스트, 포트, 사용자, SubRep 폴더 경로 | 중첩 폴더는 `상위 / 하위` 단일 그룹. 추가 필드(키·게이트웨이·프록시·터널·명령 등)는 변환하지 않으며 경고 표시. SSH 외 제외. 모든 버전 호환을 보장하지 않음 |
| OpenSSH `config` | 명시적 Host 별칭, Host 와일드카드/부정 패턴, 첫 값 우선, HostName/User/Port/첫 IdentityFile, 따옴표·주석 | Match/Include 파일 전체 거부(조건/외부 파일 실행 없음), ProxyJump/ProxyCommand 대상 제외, 키 경로의 `~`/환경변수/토큰 미확장. 나머지 인증/포워딩/연결 옵션은 경고 후 제외 |
| SecureCRT·Xshell·Termius·WinSCP 등 | 아직 어댑터 없음 | 제품명만으로 호환이라고 표시하지 않는다. 공식 형식/익명 fixture와 검증을 확보한 뒤 별도 어댑터 추가 |

외부 설정은 기본 SSH 정보의 변환이다. 특히 MobaXterm의 게이트웨이 의존 세션은 직접 접속 설정으로 미리보기에 나타나므로 대상과 누락 설정을 확인하고 제외해야 한다. 사용자명을 임의로 root/로컬 계정으로 채우지 않는다. 파일당 2MiB/20,000줄, 세션500·그룹100·터널128개 제한. 미지원/유효하지 않은 항목 수와 경고를 표시한다.

## JSON v2 규약

기계 판독용 [JSON Schema](session-format.schema.json)와 Rust 검증이 계약이다. `format: "daxterm.sessions"`, `version: 2`, `profiles`, `groups`, `tunnels`가 최상위 필드다. v1은 format 없는 version1을 계속 읽는다. 알 수 없는 필드/미래 버전은 거부하며 자동 초기화하지 않는다. v2 파일을 구버전 DaxTerm에서 읽을 수 있다고 보장하지 않는다.

```json
{
  "format": "daxterm.sessions",
  "version": 2,
  "profiles": [{
    "id": "example-session",
    "name": "개발 서버",
    "host": "dev.example.com",
    "port": 22,
    "username": "developer",
    "auth": "password",
    "protocol": "ssh",
    "tlsCaPath": "",
    "encoding": "utf-8",
    "keyPath": "",
    "groupId": "example-group",
    "favorite": false,
    "timeout": 15,
    "keepalive": 15,
    "lastConnected": null,
    "hasSecret": false
  }],
  "groups": [{ "id": "example-group", "name": "개발" }],
  "tunnels": []
}
```

ID는 파일 안의 참조 키이며 가져올 때 새 UUID로 재발급한다. ID 중복, 없는 그룹/프로필 참조, 비SSH 세션의 터널은 거부한다. 문자열 길이는 런타임에서 UTF-8 바이트로 검증한다(JSON Schema의 문자 길이보다 엄격할 수 있음). 이름/그룹은 공백만 허용하지 않는다. 트랜잭션으로 전체 적용/전체 롤백하며 선택한 세션의 그룹·터널만 함께 적용한다. 전체 터널 제한도 확인한다. 자체 JSON의 키 경로와 TLS CA 경로는 메타데이터이며 키/인증서 내용을 복사하지 않는다.

`hasSecret`은 false만 허용한다. `lastConnected`는 읽어도 버린다. 비밀번호·Passphrase·OTP·개인키 내용·보안 저장소 참조·마스터 암호/암호화 보관함은 어떤 내보내기에도 넣지 않는다. JSON은 암호화 백업이 아니므로 호스트/사용자명 같은 접속 메타데이터는 포함한다.

## 첫 접속의 암호 저장

가져온 세션을 포함해 저장된 암호가 없는 세션의 인증창에서 **로그인 성공 후 이 세션의 암호 저장**을 선택한다(기본 미선택). SSH/FTP/FTPS 로그인 성공 이벤트에서만 기존 보안 저장소에 저장하고, 다음 접속은 기존 저장 암호 흐름을 사용한다. 실패/취소/호스트키 거부 시 저장하지 않는다. 서버가 요청하는 keyboard-interactive/OTP 응답은 저장 대상이 아니다. 키 인증에서는 입력한 Passphrase에 적용되며 빈 값은 저장하지 않는다.

Rust의 임시 값은 Zeroizing으로 보관하고 성공·실패 시 제거한다. 인증 중 대상/계정/인증 방식/키 경로 또는 기존 credential 참조가 변경되면 저장하지 않는다. 보관함이 잠겨 있거나 OS 저장에 실패하면 연결을 유지하면서 연결 상태줄에 저장 실패를 표시한다. 비밀정보를 일반 DB/JSON/로그에 대체 저장하지 않는다.

## 근거와 검증 범위

- [PuTTY 공식 설정 문서](https://www.puttyssh.org/0.83/htmldoc/Chapter4.html): 세션 저장과 레지스트리 위치.
- [MobaXterm 공식 문서](https://mobaxterm.mobatek.net/documentation.html): 세션 내보내기/가져오기 동선. 내부 파일 형식 전체에 대한 공식 표준은 확인하지 못했다.
- [MTPuTTY→MobaXterm 변환기 원본](https://github.com/affifuddin-hazam/mtputty2mobaxterm/blob/main/mtputty2mobaxterm.py): 공개 구현의 SSH 공통 접두부와 Bookmarks/SubRep 예시를 대조했다. 자체 파서는 해당 기본 필드만 독립 구현하며 제품 전체 호환 근거로 확대하지 않는다.
- [OpenBSD/OpenSSH ssh_config 공식 매뉴얼](https://man.openbsd.org/ssh_config): 첫 값 우선, 패턴, 조건, 인용 규칙.

자동 검증 명령/실제 결과·미검증 환경은 `progress.md` I.1 기록을 따른다. 합성 fixture의 파서 테스트를 실제 PuTTY/MobaXterm 모든 버전 내보내기 검사로 표시하지 않는다.
