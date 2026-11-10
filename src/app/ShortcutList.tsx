import { isMac, modKey } from '../lib/platform';

const rows: [string, string][] = [
  ['새 연결', modKey('Shift+N')],
  ['로컬 터미널', modKey('Shift+L')],
  ['명령 (스니펫·기본 명령)', modKey('Shift+S')],
  ['터널', modKey('Shift+U')],
  ['설정', modKey(',')],
  ['키보드 단축키', modKey('Shift+/')],
  ['사이드바 접기 / 펼치기', modKey('Shift+B')],
  ['연결 검색', modKey('Shift+O')],
  ['파일', modKey('Shift+E')],
  ['터미널 검색', modKey('Shift+F')],
  ['파일 저장 / 다른 이름으로 저장 (파일 탭)', `${modKey('S')} / ${modKey('Shift+S')}`],
  ['전체화면 / 종료', 'F11'],
  ['선택 터미널 확대 / 분할 복원', modKey('Shift+Enter')],
  ['칸 사이 포커스 이동', `${modKey('Alt')} + 방향키`],
  ['같은 연결로 오른쪽에 분할', modKey('Shift+\\')],
  ['변경 검토 (SSH 탭)', modKey('Shift+G')],
  ['동시 입력 중지 / 입력 받을 창 선택', modKey('Shift+M')],
  ['다음 입력 대기 탭으로 이동', modKey('Shift+.')],
  ['에이전트 채팅 (새 채팅 · 위치 · 열린 채팅)', modKey('Shift+A')],
  ['탭 이동 (탭에 포커스)', '← / → · Home / End'],
  ['탭 메뉴 · 모든 탭 배치 (탭에 포커스)', 'Shift+F10 · 메뉴 키 · 우클릭'],
  ['네트워크 도구 결과 행 메뉴 (행에 포커스)', 'Shift+F10 · 메뉴 키 · 우클릭'],
  ['터미널 복사 / 붙여넣기', `${modKey('Shift+C')} / V · Shift+Insert`],
  ['터미널 글꼴 크기', `${isMac ? '⌘' : 'Ctrl'} + 스크롤`],
  ['터미널 이전 / 다음 프롬프트로 이동', `${modKey('Shift+↑')} / ↓`],
  ['TUI 마우스 모드에서 선택 / 붙여넣기', 'Shift + 드래그 / 우클릭'],
  ['메뉴 / 대화상자 닫기', 'Esc'],
  ...(isMac ? [['탭 닫기 · 탭이 없으면 창 닫기', '⌘W'] as [string, string]] : []),
];

export function ShortcutList() {
  return (
    <dl className="shortcut-list">
      {rows.map(([name, keys]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd>
            <kbd>{keys}</kbd>
          </dd>
        </div>
      ))}
    </dl>
  );
}
