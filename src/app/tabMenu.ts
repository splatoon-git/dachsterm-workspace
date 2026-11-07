import type { SessionCapabilities } from '../features/terminal/sessionKind';
import { modKey } from '../lib/platform';
import type { Preset } from './workspaceLayout';

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
  | 'closeOthers'
  | Preset;
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
  /** All tabs in the window, which the arrange items lay out together. */
  tabCount: number;
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
    view.push({ command: 'search', label: '터미널 검색', shortcut: modKey('Shift+F') });
  if (can?.log)
    view.push({ command: 'log', label: state.recording ? '세션 기록 · 기록 중…' : '세션 기록…' });
  if (can?.guide) view.push({ command: 'guide', label: '조작표 보기·고정' });
  const layout: TabMenuEntry[] = [];
  if (can?.split)
    layout.push(
      { command: 'splitRight', label: '오른쪽으로 분할', disabled: state.narrow },
      { command: 'splitDown', label: '아래로 분할', disabled: state.narrow },
    );
  layout.push({
    command: 'zoom',
    label: state.zoomed ? '분할 복원' : '이 창 확대',
    shortcut: modKey('Shift+Enter'),
    disabled: state.groupCount < 2,
  });
  if (can?.detach)
    layout.push({
      command: 'detach',
      label: '새 창으로 분리',
      disabled: state.connection !== 'live',
    });
  // The whole window at once: for two tabs or more, or to gather one tab out of a split.
  const arrange: TabMenuEntry[] =
    (state.tabCount < 2 && state.groupCount < 2) || state.narrow
      ? []
      : [
          { command: 'columns', label: '모든 탭 좌우' },
          { command: 'rows', label: '모든 탭 상하' },
          { command: 'grid', label: '모든 탭 2 × 2' },
          { command: 'single', label: '모든 탭 하나로', disabled: state.groupCount < 2 },
        ];
  const life: TabMenuEntry[] = [];
  if (state.connection === 'live') life.push({ command: 'disconnect', label: '연결 종료' });
  if (state.connection === 'ended') life.push({ command: 'reconnect', label: '재접속' });
  life.push(
    { command: 'close', label: '탭 닫기' },
    { command: 'closeOthers', label: '다른 탭 닫기', disabled: state.otherTabs === 0 },
  );
  return [view, layout, arrange, life]
    .filter((section) => section.length)
    .flatMap((section, i) =>
      section.map((entry, j) => (i > 0 && j === 0 ? { ...entry, separated: true } : entry)),
    );
}
