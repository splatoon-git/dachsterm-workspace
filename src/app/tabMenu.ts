import type { SessionCapabilities } from '../features/terminal/sessionKind';

export type TabCommand =
  | 'search'
  | 'log'
  | 'guide'
  | 'splitRight'
  | 'splitDown'
  | 'zoom'
  | 'detach'
  | 'disconnect'
  | 'reconnect'
  | 'close'
  | 'closeOthers';
export type TabMenuState = {
  /** What the tab's session supports, or null for a game or the preview. */
  capabilities: SessionCapabilities | null;
  /** The state of the tab's connection, or null for a tab without one. */
  connection: 'live' | 'ended' | null;
  recording: boolean;
  groupCount: number;
  zoomed: boolean;
  /** Other tabs in the same group. */
  otherTabs: number;
  /** A narrow window shows one group, so it cannot split. */
  narrow: boolean;
};
export type TabMenuEntry = {
  command: TabCommand;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  separated?: boolean;
};

/** The tab header menu: actions on the tab's own view, its place in the layout, and its life. */
export function tabMenuEntries(state: TabMenuState): TabMenuEntry[] {
  const can = state.capabilities;
  const view: TabMenuEntry[] = [];
  if (can?.terminal)
    view.push({ command: 'search', label: '터미널 검색', shortcut: 'Ctrl/Cmd+Shift+F' });
  if (can?.log)
    view.push({ command: 'log', label: state.recording ? '세션 기록 · 기록 중…' : '세션 기록…' });
  if (can?.guide) view.push({ command: 'guide', label: '조작표 전체 보기' });
  const layout: TabMenuEntry[] = [];
  if (can?.split)
    layout.push(
      { command: 'splitRight', label: '오른쪽으로 분할', disabled: state.narrow },
      { command: 'splitDown', label: '아래로 분할', disabled: state.narrow },
    );
  layout.push({
    command: 'zoom',
    label: state.zoomed ? '분할 복원' : '이 창 확대',
    shortcut: 'Ctrl/Cmd+Shift+Enter',
    disabled: state.groupCount < 2,
  });
  if (can?.detach)
    layout.push({
      command: 'detach',
      label: '새 창으로 분리',
      disabled: state.connection !== 'live',
    });
  const life: TabMenuEntry[] = [];
  if (state.connection === 'live') life.push({ command: 'disconnect', label: '연결 종료' });
  if (state.connection === 'ended') life.push({ command: 'reconnect', label: '재접속' });
  life.push(
    { command: 'close', label: '탭 닫기' },
    { command: 'closeOthers', label: '다른 탭 닫기', disabled: state.otherTabs === 0 },
  );
  return [view, layout, life]
    .filter((section) => section.length)
    .flatMap((section, i) =>
      section.map((entry, j) => (i > 0 && j === 0 ? { ...entry, separated: true } : entry)),
    );
}
