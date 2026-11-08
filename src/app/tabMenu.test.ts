import { describe, expect, it } from 'vitest';
import { capabilities, sessionKind } from '../features/terminal/sessionKind';
import { blankProfile } from '../lib/ipc';
import { tabMenuEntries, type TabMenuState } from './tabMenu';

const ssh = { profile: { ...blankProfile(), protocol: 'ssh' as const } };
const ftp = { profile: { ...blankProfile(), protocol: 'ftps' as const } };
const local = {
  profile: blankProfile(),
  localTarget: {
    id: 'pwsh',
    name: 'PowerShell',
    kind: 'shell' as const,
    follow: 'launch' as const,
  },
};
const podtree = {
  profile: blankProfile(),
  podtree: {
    kind: 'script' as const,
    location: { kind: 'local' as const, id: 'x' },
    context: 'c',
    namespace: 'n',
    operational: false,
  },
};
const base: TabMenuState = {
  capabilities: capabilities(ssh),
  review: true,
  connection: 'live',
  recording: false,
  groupCount: 2,
  zoomed: false,
  otherTabs: 1,
  tabCount: 1,
  narrow: false,
};
const arrangeCommands: string[] = ['columns', 'rows', 'grid', 'single'];
const all = (state: Partial<TabMenuState>) =>
  tabMenuEntries({ ...base, ...state }).map((entry) => entry.command);
/** The menu without the window-wide arrange items, which every kind of tab shares. */
const commands = (state: Partial<TabMenuState>) =>
  all(state).filter((command) => !arrangeCommands.includes(command));

describe('sessionKind', () => {
  it('tells the four kinds apart', () => {
    expect([ssh, ftp, local, podtree].map(sessionKind)).toEqual(['ssh', 'ftp', 'local', 'podtree']);
  });
  it('lets only SSH leave the window or report server load', () => {
    expect([ssh, ftp, local, podtree].map((s) => capabilities(s).detach)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect([ssh, ftp, local, podtree].map((s) => capabilities(s).monitor)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('tabMenuEntries', () => {
  it('offers the full menu on a live SSH tab, grouped by separators', () => {
    const entries = tabMenuEntries(base);
    expect(entries.map((e) => e.command)).toEqual([
      'search',
      'log',
      'guide',
      'review',
      'splitRight',
      'splitDown',
      'zoom',
      'detach',
      'columns',
      'rows',
      'grid',
      'single',
      'disconnect',
      'close',
      'closeOthers',
    ]);
    expect(entries.filter((e) => e.separated).map((e) => e.command)).toEqual([
      'splitRight',
      'columns',
      'disconnect',
    ]);
  });
  it('hides terminal-only items on an FTP tab', () => {
    expect(commands({ capabilities: capabilities(ftp), review: null })).toEqual([
      'zoom',
      'disconnect',
      'close',
      'closeOthers',
    ]);
  });
  it('keeps search but not logs, guides or splitting on PodTree', () => {
    expect(commands({ capabilities: capabilities(podtree), review: null })).toEqual([
      'search',
      'zoom',
      'disconnect',
      'close',
      'closeOthers',
    ]);
  });
  it('lets a local terminal split but not detach', () => {
    const list = commands({ capabilities: capabilities(local), review: null });
    expect(list).toContain('splitRight');
    expect(list).not.toContain('detach');
  });
  it('offers reconnect after the connection ends and cannot detach it', () => {
    const entries = tabMenuEntries({ ...base, connection: 'ended' });
    expect(entries.map((e) => e.command)).toContain('reconnect');
    expect(entries.map((e) => e.command)).not.toContain('disconnect');
    expect(entries.find((e) => e.command === 'detach')?.disabled).toBe(true);
  });
  it('gives games only layout and closing', () => {
    expect(commands({ capabilities: null, connection: null, review: null })).toEqual([
      'zoom',
      'close',
      'closeOthers',
    ]);
  });
  it('opens the Kubernetes workspace from a terminal session, and keeps detach away from it', () => {
    const opened = tabMenuEntries({ ...base, kube: 'open' });
    expect(opened.find((e) => e.command === 'kube')?.label).toBe('쿠버네티스 화면 열기');
    expect(opened.find((e) => e.command === 'detach')?.disabled).toBe(false);
    const open = tabMenuEntries({ ...base, kube: 'close' });
    expect(open.find((e) => e.command === 'kube')?.label).toBe('쿠버네티스 화면 닫기');
    expect(open.find((e) => e.command === 'detach')?.disabled).toBe(true);
    const fixed = tabMenuEntries({ ...base, kube: 'fixed' });
    expect(fixed.some((e) => e.command === 'kube')).toBe(false);
    expect(fixed.find((e) => e.command === 'detach')?.disabled).toBe(true);
  });

  it('cannot open the Kubernetes workspace on an ended connection', () => {
    const entries = tabMenuEntries({ ...base, kube: 'open', connection: 'ended' });
    expect(entries.find((e) => e.command === 'kube')?.disabled).toBe(true);
  });

  it('disables what cannot apply', () => {
    const entries = tabMenuEntries({ ...base, groupCount: 1, otherTabs: 0, narrow: true });
    const disabled = entries.filter((e) => e.disabled).map((e) => e.command);
    expect(disabled).toEqual(['splitRight', 'splitDown', 'zoom', 'closeOthers']);
  });
  it('lays out every tab at once with two tabs or a split to gather', () => {
    const entries = tabMenuEntries({ ...base, tabCount: 3 });
    const arrange = entries.filter((e) => arrangeCommands.includes(e.command));
    expect(arrange.map((e) => e.label)).toEqual([
      '모든 탭 좌우',
      '모든 탭 상하',
      '모든 탭 2 × 2',
      '모든 탭 하나로',
    ]);
    expect(arrange[0].separated).toBe(true);
    expect(all({ tabCount: 3, narrow: true })).not.toContain('columns');
    expect(all({ tabCount: 1, groupCount: 1 })).not.toContain('columns');
    // One tab left in a split can still be gathered into one group.
    expect(all({ tabCount: 1, groupCount: 2 })).toContain('single');
    expect(tabMenuEntries({ ...base, tabCount: 2, groupCount: 1 }).at(-4)?.disabled).toBe(true);
  });
  it('offers the change review on SSH tabs, disabled until the shell folder is known', () => {
    const entry = (review: boolean | null) =>
      tabMenuEntries({ ...base, review }).find((e) => e.command === 'review');
    expect(entry(true)).toMatchObject({ label: '변경 검토', disabled: false });
    expect(entry(false)?.disabled).toBe(true);
    expect(entry(null)).toBeUndefined();
  });
  it('names the state it is in', () => {
    const labels = tabMenuEntries({ ...base, zoomed: true, recording: true }).map((e) => e.label);
    expect(labels).toContain('분할 복원');
    expect(labels).toContain('세션 기록 · 기록 중…');
  });
});
