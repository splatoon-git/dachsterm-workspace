export type GuideProgram = 'vi' | 'vim' | 'less' | 'tail' | 'cat';
export function programMetadata(value: string): GuideProgram | null | undefined {
  if (value === 'DaxTerm;end') return null;
  const match = /^DaxTerm;program;(vi|vim|less|tail|cat)$/.exec(value);
  return match ? (match[1] as GuideProgram) : undefined;
}
export type CommandExample = { group: string; title: string; command: string; note?: string };
export const commands: CommandExample[] = [
  { group: '파일/폴더', title: '현재 경로', command: 'pwd' },
  { group: '파일/폴더', title: '숨김 파일 포함 목록', command: 'ls -lah' },
  { group: '파일/폴더', title: '폴더 이동', command: "cd -- '경로'" },
  { group: '파일/폴더', title: '폴더 만들기', command: "mkdir -p -- '경로'" },
  { group: '파일/폴더', title: '파일 복사 · 덮어쓰기 확인', command: "cp -i -- '원본' '대상'" },
  { group: '파일/폴더', title: '파일 이동 · 덮어쓰기 확인', command: "mv -i -- '원본' '대상'" },
  {
    group: '파일/폴더',
    title: '파일명 찾기',
    command: "find . -type f -name '*파일명*'",
    note: '현재 폴더 아래만 검색합니다. *는 파일명 패턴입니다.',
  },
  {
    group: '파일/폴더',
    title: '대소문자 무시 파일명 찾기',
    command: "find . -type f -iname '*파일명*'",
    note: 'GNU find 기준 · 현재 폴더 아래만 검색합니다.',
  },
  {
    group: '파일/폴더',
    title: '실행 파일 위치',
    command: 'command -v 프로그램명',
    note: 'PATH에서 찾습니다. 출력 없음은 미설치 또는 PATH 밖일 수 있습니다. 셸 내장/함수/별칭은 파일 경로가 아닐 수 있습니다. 설정·데이터를 포함한 전체 설치 경로는 아닙니다.',
  },
  {
    group: '파일/폴더',
    title: '관련 바이너리·매뉴얼 위치',
    command: 'whereis 프로그램명',
    note: 'Linux whereis 기준. 알려진 경로를 검색하며 모든 설정/데이터 위치를 보장하지 않습니다.',
  },
  {
    group: '파일/폴더',
    title: '링크의 실제 경로',
    command: "readlink -f -- '경로'",
    note: 'GNU coreutils 기준. 다른 OS에서는 옵션이 다를 수 있습니다.',
  },
  {
    group: '내용/로그',
    title: '파일 전체 출력',
    command: "cat -- '파일명'",
    note: '출력 후 종료합니다. 많은 내용은 less로 탐색하세요.',
  },
  {
    group: '내용/로그',
    title: '페이지 단위 탐색',
    command: "less -- '파일명'",
    note: '/검색어 후 Enter · n 다음 · q 종료',
  },
  { group: '내용/로그', title: '마지막 100줄', command: "tail -n 100 -- '파일명'" },
  {
    group: '내용/로그',
    title: '실시간 보기',
    command: "tail -f -- '파일명'",
    note: 'Ctrl+C 종료. -f는 열린 파일을 추적합니다.',
  },
  {
    group: '내용/로그',
    title: '로그 교체도 따라가기',
    command: "tail -F -- '파일명'",
    note: 'GNU tail 기준. 이름으로 재시도해 로그 회전/교체를 따라갑니다. Ctrl+C 종료.',
  },
  { group: '용량/메모리', title: '디스크 여유 공간', command: 'df -h' },
  { group: '용량/메모리', title: '폴더 사용량', command: "du -sh -- '경로'" },
  { group: '용량/메모리', title: '메모리 상태', command: 'free -h', note: 'Linux procps 기준' },
  { group: '용량/메모리', title: '가동 시간과 부하', command: 'uptime' },
  {
    group: '프로세스',
    title: '프로세스 목록',
    command: 'ps aux',
    note: '명령 인자에 비밀이 있을 수 있으므로 공유 전 확인하세요.',
  },
  {
    group: '프로세스',
    title: '실시간 프로세스',
    command: 'top',
    note: 'q 종료. top은 별도의 조작 방식을 사용합니다.',
  },
  {
    group: '프로세스',
    title: '프로세스 이름 찾기',
    command: "pgrep -a -x -- '프로그램명'",
    note: 'Linux procps 기준. -x는 이름 전체 일치입니다.',
  },
  {
    group: '네트워크',
    title: '인터페이스 주소',
    command: 'ip -brief address',
    note: 'Linux iproute2 기준',
  },
  {
    group: '네트워크',
    title: '열린 TCP/UDP 포트',
    command: 'ss -lntu',
    note: 'Linux iproute2 기준',
  },
  {
    group: '네트워크',
    title: '연결 확인 · 4회',
    command: 'ping -c 4 호스트',
    note: 'Linux 기준. ICMP가 차단되면 응답하지 않을 수 있습니다.',
  },
  {
    group: '로그 필터',
    title: '특정 문구 포함 · cat 출력 필터',
    command: "cat -- '파일명' | grep -F -- '검색어'",
    note: "파일 하나는 grep -F -- '검색어' '파일명'만으로도 같습니다. -F는 정규식이 아닌 문자 그대로 찾습니다.",
  },
  { group: '로그 필터', title: '특정 문구 제외', command: "grep -F -v -- '제외어' '파일명'" },
  {
    group: '로그 필터',
    title: '둘 중 하나 포함 · OR',
    command: "grep -F -e '문구1' -e '문구2' -- '파일명'",
    note: '-e를 여러 번 쓰면 하나 이상 일치하는 줄을 보여줍니다.',
  },
  {
    group: '로그 필터',
    title: '두 문구 모두 포함 · AND',
    command: "grep -F -- '문구1' '파일명' | grep -F -- '문구2'",
    note: '첫 필터 결과를 다시 필터해 같은 줄에 두 문구가 모두 있어야 합니다.',
  },
  {
    group: '로그 필터',
    title: '일치 줄 앞뒤 3줄',
    command: "grep -F -C 3 -- '검색어' '파일명'",
    note: 'GNU grep 기준. 주변 줄은 검색어가 없어도 표시합니다.',
  },
  {
    group: '로그 필터',
    title: '실시간 포함 필터',
    command: "tail -f -- '파일명' | grep --line-buffered -F -- '검색어'",
    note: 'GNU grep 기준. 줄 단위 출력으로 지연을 줄입니다. Ctrl+C 종료.',
  },
  {
    group: '로그 필터',
    title: '실시간 두 문구 모두 · AND',
    command:
      "tail -F -- '파일명' | grep --line-buffered -F -- '문구1' | grep --line-buffered -F -- '문구2'",
    note: 'GNU tail/grep 기준. 각 필터에 --line-buffered를 적용합니다. Ctrl+C 종료.',
  },
];
export const guideKeys: Record<GuideProgram, [string, string][]> = {
  vi: [
    ['명령 모드부터', 'Esc'],
    ['입력 모드', 'i'],
    ['이동', '방향키 / h j k l'],
    ['다음 / 이전 페이지', 'Ctrl+f / Ctrl+b'],
    ['처음 / 끝 줄', '1G / G'],
    ['검색', '/검색어 + Enter'],
    ['다음 / 이전 검색', 'n / N'],
    ['저장', ':w + Enter'],
    ['종료', ':q + Enter'],
    ['저장 후 종료', ':wq + Enter'],
    ['변경 버리고 종료', ':q! + Enter'],
  ],
  vim: [
    ['명령 모드부터', 'Esc'],
    ['입력 모드', 'i'],
    ['이동', '방향키 / h j k l'],
    ['다음 / 이전 페이지', 'Ctrl+f / Ctrl+b'],
    ['처음 / 끝 줄', 'gg / G'],
    ['검색', '/검색어 + Enter'],
    ['다음 / 이전 검색', 'n / N'],
    ['저장', ':w + Enter'],
    ['종료', ':q + Enter'],
    ['저장 후 종료', ':wq + Enter'],
    ['변경 버리고 종료', ':q! + Enter'],
  ],
  less: [
    ['다음 / 이전 페이지', 'Space / b'],
    ['처음 / 끝', 'g / G'],
    ['검색', '/검색어 + Enter'],
    ['다음 / 이전 검색', 'n / N'],
    ['종료', 'q'],
  ],
  tail: [
    ['실시간 보기 종료', 'Ctrl+C'],
    ['이전 출력 보기', '터미널 스크롤백 · 휠/스크롤바'],
  ],
  cat: [
    ['출력 완료', '자동 종료'],
    ['많은 내용 탐색', 'less 파일명'],
    ['이전 출력 보기', '터미널 스크롤백 · 휠/스크롤바'],
  ],
};
// Explicit opt-in wrappers, session only. Do not inspect history, keystrokes or arguments.
// Refuse aliases/functions so user customizations are never silently replaced.
export const guideHook = `if [ -n "$BASH_VERSION" ]; then
  __dax_guide_install() {
    local p
    for p in vi vim less tail cat __dax_guide_prompt; do
      case "$(type -t "$p")" in function|alias) printf '%s\\n' "DaxTerm: $p 별칭/함수가 있어 연동을 취소했습니다."; return 1;; esac
    done
${(['vi', 'vim', 'less', 'tail', 'cat'] as const)
  .map(
    (p) => `    ${p}() {
      local __dax_rc=0 __dax_notify=0
      if [ -t 0 ] && [ -t 1 ]; then
        printf '\\033]777;DaxTerm;program;${p}\\007'
        __dax_notify=1
      fi
      command ${p} "$@" || __dax_rc=$?
      if [ "$__dax_notify" = 1 ]; then printf '\\033]777;DaxTerm;end\\007'; fi
      return "$__dax_rc"
    }`,
  )
  .join('\n')}
    __dax_guide_prompt() { printf '\\033]777;DaxTerm;end\\007'; }
    if declare -p PROMPT_COMMAND 2>/dev/null | command grep -q '^declare -a'; then
      PROMPT_COMMAND+=(__dax_guide_prompt)
    else
      PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND; }__dax_guide_prompt"
    fi
  }
  __dax_guide_install
  unset -f __dax_guide_install
else
  printf '%s\\n' 'DaxTerm: Bash에서만 지원합니다. 수동 조작표를 사용하세요.'
fi`;
