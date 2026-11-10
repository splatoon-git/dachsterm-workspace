// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  chatLaunchKey,
  defaultLaunch,
  readLaunch,
  saveLaunch,
  withoutMissing,
  withRecent,
  type ChatWorkspace,
} from './chatPlaces';

const web: ChatWorkspace = { kind: 'ssh', profileId: 'p1', folder: '/srv/app' };
const here: ChatWorkspace = { kind: 'local', folder: 'C:\\Users\\me\\work' };

describe('chat launch choice', () => {
  beforeEach(() => localStorage.clear());

  it('starts by following the focused tab and keeps a saved choice', () => {
    expect(readLaunch()).toEqual(defaultLaunch);
    saveLaunch({ mode: 'fixed', fixed: web, recent: [web, here] });
    expect(readLaunch()).toEqual({ mode: 'fixed', fixed: web, recent: [web, here] });
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
    expect(readLaunch()).toEqual({ mode: 'follow', fixed: null, recent: [web] });
    localStorage.setItem(chatLaunchKey, '{not json');
    expect(readLaunch()).toEqual(defaultLaunch);
  });

  it('keeps recent workspaces newest first without repeats', () => {
    let launch = defaultLaunch;
    for (const folder of ['/a', '/b', '/c', '/d', '/e', '/f', '/g'])
      launch = withRecent(launch, { kind: 'ssh', profileId: 'p1', folder });
    launch = withRecent(launch, { kind: 'ssh', profileId: 'p1', folder: '/e' });
    expect(launch.recent.map((r) => r.folder)).toEqual(['/e', '/g', '/f', '/d', '/c', '/b']);
  });

  it('forgets workspaces of deleted sessions', () => {
    const launch = withoutMissing({ mode: 'fixed', fixed: web, recent: [web, here] }, new Set());
    expect(launch).toEqual({ mode: 'follow', fixed: null, recent: [here] });
  });
});
