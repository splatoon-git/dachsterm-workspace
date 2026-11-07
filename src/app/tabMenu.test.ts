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
    location: { kind: 'local' as const, id: 'x' },
    context: 'c',
    namespace: 'n',
    operational: false,
  },
};
const base: TabMenuState = {
  capabilities: capabilities(ssh),
  connection: 'live',
  recording: false,
  groupCount: 2,
  zoomed: false,
  otherTabs: 1,
  narrow: false,
};
const commands = (state: Partial<TabMenuState>) =>
  tabMenuEntries({ ...base, ...state }).map((entry) => entry.command);

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
      'splitRight',
      'splitDown',
      'zoom',
      'detach',
      'disconnect',
      'close',
      'closeOthers',
    ]);
    expect(entries.filter((e) => e.separated).map((e) => e.command)).toEqual([
      'splitRight',
      'disconnect',
    ]);
  });
  it('hides terminal-only items on an FTP tab', () => {
    expect(commands({ capabilities: capabilities(ftp) })).toEqual([
      'zoom',
      'disconnect',
      'close',
      'closeOthers',
    ]);
  });
  it('keeps search but not logs, guides or splitting on PodTree', () => {
    expect(commands({ capabilities: capabilities(podtree) })).toEqual([
      'search',
      'zoom',
      'disconnect',
      'close',
      'closeOthers',
    ]);
  });
  it('lets a local terminal split but not detach', () => {
    const list = commands({ capabilities: capabilities(local) });
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
    expect(commands({ capabilities: null, connection: null })).toEqual([
      'zoom',
      'close',
      'closeOthers',
    ]);
  });
  it('disables what cannot apply', () => {
    const entries = tabMenuEntries({ ...base, groupCount: 1, otherTabs: 0, narrow: true });
    const disabled = entries.filter((e) => e.disabled).map((e) => e.command);
    expect(disabled).toEqual(['splitRight', 'splitDown', 'zoom', 'closeOthers']);
  });
  it('names the state it is in', () => {
    const labels = tabMenuEntries({ ...base, zoomed: true, recording: true }).map((e) => e.label);
    expect(labels).toContain('분할 복원');
    expect(labels).toContain('세션 기록 · 기록 중…');
  });
});
