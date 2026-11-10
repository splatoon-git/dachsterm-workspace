// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  chatLaunchKey,
  defaultLaunch,
  readLaunch,
  saveLaunch,
  withoutMissing,
  withoutRecent,
  withRecent,
  type ChatWorkspace,
} from './chatPlaces';

const web: ChatWorkspace = { kind: 'ssh', profileId: 'p1', folder: '/srv/app', program: 'claude' };
const here: ChatWorkspace = { kind: 'local', folder: 'C:\\Users\\me\\work', program: 'codex' };

describe('chat launch choice', () => {
  beforeEach(() => localStorage.clear());

  it('starts by following the focused tab and keeps a saved choice', () => {
    expect(readLaunch()).toEqual(defaultLaunch);
    saveLaunch({ mode: 'fixed', fixed: web, recent: [web, here], program: 'codex' });
    expect(readLaunch()).toEqual({
      mode: 'fixed',
      fixed: web,
      recent: [web, here],
      program: 'codex',
    });
  });

  it('reads workspaces saved before codex chats as claude ones', () => {
    const old: Partial<ChatWorkspace> = { ...web };
    delete old.program;
    localStorage.setItem(chatLaunchKey, JSON.stringify({ mode: 'follow', recent: [old] }));
    expect(readLaunch()).toEqual({ ...defaultLaunch, recent: [web] });
    localStorage.setItem(
      chatLaunchKey,
      JSON.stringify({ mode: 'follow', recent: [{ ...old, program: 'vim' }], program: 'vim' }),
    );
    expect(readLaunch()).toEqual(defaultLaunch);
  });

  it('drops values that do not check out', () => {
    localStorage.setItem(
      chatLaunchKey,
      JSON.stringify({
        mode: 'fixed',
        fixed: { kind: 'ssh', profileId: 'p1', folder: 'relative' },
        recent: [web, { kind: 'local', folder: 'a\nb' }, { kind: 'ftp', folder: '/' }, 'x'],
      }),
    );
    // No usable fixed workspace means following the tab.
    expect(readLaunch()).toEqual({ ...defaultLaunch, recent: [web] });
    localStorage.setItem(chatLaunchKey, '{not json');
    expect(readLaunch()).toEqual(defaultLaunch);
  });

  it('keeps recent workspaces newest first without repeats', () => {
    let launch = defaultLaunch;
    for (const folder of ['/a', '/b', '/c', '/d', '/e', '/f', '/g'])
      launch = withRecent(launch, { ...web, folder });
    launch = withRecent(launch, { ...web, folder: '/e' });
    expect(launch.recent.map((r) => r.folder)).toEqual(['/e', '/g', '/f', '/d', '/c', '/b']);
    // The same folder with the other agent is another workspace.
    launch = withRecent(launch, { ...web, folder: '/e', program: 'codex' });
    expect(launch.recent.slice(0, 2).map((r) => r.program)).toEqual(['codex', 'claude']);
  });

  it('forgets workspaces of deleted sessions', () => {
    const launch = withoutMissing(
      { mode: 'fixed', fixed: web, recent: [web, here], program: 'codex' },
      new Set(),
    );
    expect(launch).toEqual({ mode: 'follow', fixed: null, recent: [here], program: 'codex' });
  });

  it('forgets one recent workspace and keeps the fixed one', () => {
    const launch = { ...defaultLaunch, mode: 'fixed' as const, fixed: web, recent: [web, here] };
    expect(withoutRecent(launch, { ...web })).toEqual({ ...launch, recent: [here] });
    expect(withoutRecent(launch, { ...here, folder: '/other' })).toEqual(launch);
  });
});
