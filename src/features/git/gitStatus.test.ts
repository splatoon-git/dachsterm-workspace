import { describe, expect, it } from 'vitest';
import {
  GitScheduler,
  gitPath,
  gitSentence,
  gitStatusText,
  gitTooltip,
  treeMarks,
  type GitRepo,
  type GitResult,
} from './gitStatus';

const repo = (root: string, patch: Partial<GitRepo> = {}): GitRepo => ({
  kind: 'repo',
  root,
  branch: 'main',
  oid: 'abcdef0123456789',
  upstream: 'origin/main',
  ahead: 2,
  behind: 1,
  entries: [],
  truncated: false,
  ...patch,
});

/** A scheduler whose clock, timers and server answers the test controls. */
function setup(answer: (folder: string) => GitResult | Error = (f) => repo(f)) {
  let now = 0;
  let auto = true;
  const timers: { at: number; run: () => void }[] = [];
  const asked: string[] = [];
  const pending: (() => void)[] = [];
  let hold = false;
  const scheduler = new GitScheduler({
    query: (folder) => {
      asked.push(folder);
      const result = answer(folder);
      const settle = (resolve: (r: GitResult) => void, reject: (e: unknown) => void) =>
        result instanceof Error ? reject(result) : resolve(result);
      return new Promise((resolve, reject) => {
        if (hold) pending.push(() => settle(resolve, reject));
        else settle(resolve, reject);
      });
    },
    auto: () => auto,
    now: () => now,
    later: (run, ms) => {
      const timer = { at: now + ms, run };
      timers.push(timer);
      return () => timers.splice(timers.indexOf(timer), 1);
    },
    changed: () => {},
    failed: (e) => (e instanceof Error ? e.message : String(e)),
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    scheduler,
    asked,
    flush,
    advance: async (ms: number) => {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(timer), 1);
        timer.run();
      }
      await flush();
    },
    setAuto: (value: boolean) => (auto = value),
    hold: (value: boolean) => (hold = value),
    release: async () => {
      pending.splice(0).forEach((settle) => settle());
      await flush();
    },
    timers,
  };
}

describe('git status schedule', () => {
  it('asks at once, then waits out the rest of the interval only once', async () => {
    const { scheduler, asked, flush, advance, timers } = setup();
    scheduler.request('folder', '/srv/app');
    await flush();
    scheduler.request('prompt', '/srv/app');
    scheduler.request('prompt', '/srv/app');
    expect(asked).toEqual(['/srv/app']);
    expect(timers).toHaveLength(1);
    await advance(4999);
    expect(asked).toHaveLength(1);
    await advance(1);
    expect(asked).toEqual(['/srv/app', '/srv/app']);
  });

  it('drops a tab switch when the last answer is recent', async () => {
    const { scheduler, asked, flush, advance, timers } = setup();
    scheduler.request('folder', '/a');
    await flush();
    scheduler.request('activate', '/a');
    expect(timers).toHaveLength(0);
    await advance(30_000);
    scheduler.request('activate', '/a');
    await flush();
    expect(asked).toEqual(['/a', '/a']);
  });

  it('runs one query at a time and keeps only the latest waiting one', async () => {
    const { scheduler, asked, flush, hold, release } = setup();
    hold(true);
    scheduler.request('folder', '/a');
    await flush();
    scheduler.request('folder', '/b');
    scheduler.request('folder', '/c');
    expect(asked).toEqual(['/a']);
    hold(false);
    await release();
    expect(asked).toEqual(['/a', '/c']);
  });

  it('leaves only the manual query when automatic queries are off', async () => {
    const { scheduler, asked, flush, setAuto } = setup();
    setAuto(false);
    scheduler.request('folder', '/a');
    scheduler.request('prompt', '/a');
    await flush();
    expect(asked).toEqual([]);
    scheduler.request('manual', '/a');
    await flush();
    expect(asked).toEqual(['/a']);
    expect(scheduler.view('/a')).toEqual({ repo: repo('/a') });
  });

  it('stops asking about a repository whose query hit a limit until the user asks', async () => {
    let slow = false;
    const { scheduler, asked, flush, advance } = setup(() =>
      slow ? { kind: 'stopped', reason: 'timeout' } : repo('/r', { entries: [] }),
    );
    scheduler.request('folder', '/r/src');
    await flush();
    slow = true;
    await advance(5000);
    scheduler.request('prompt', '/r/src');
    await flush();
    expect(scheduler.view('/r/src')).toEqual({ stopped: 'timeout' });
    await advance(60_000);
    scheduler.request('prompt', '/r/src');
    scheduler.request('folder', '/r/lib');
    await flush();
    expect(asked).toEqual(['/r/src', '/r/src']);
    slow = false;
    scheduler.request('manual', '/r/src');
    await flush();
    expect(scheduler.view('/r/src')).toEqual({ repo: repo('/r') });
    await advance(5000);
    scheduler.request('prompt', '/r/src');
    await flush();
    expect(asked).toHaveLength(4);
  });

  it('stays quiet outside a repository or on failure, unless the user asked', async () => {
    const answers: Record<string, GitResult | Error> = {
      '/tmp': { kind: 'notRepo', detail: 'fatal: not a git repository' },
      '/down': new Error('원격 명령 채널을 열 수 없습니다.'),
    };
    const { scheduler, flush } = setup((folder) => answers[folder]);
    scheduler.request('folder', '/tmp');
    scheduler.request('refresh', '/down');
    await flush();
    await flush();
    expect(scheduler.error).toBe('');
    expect(scheduler.view('/tmp')).toBeNull();
    scheduler.request('manual', '/tmp');
    await flush();
    expect(scheduler.error).toBe('fatal: not a git repository');
    scheduler.request('manual', '/down');
    await flush();
    expect(scheduler.error).toBe('원격 명령 채널을 열 수 없습니다.');
  });

  it('finds the repository of a folder below one already asked about', async () => {
    const { scheduler, flush } = setup((folder) =>
      folder.startsWith('/r/inner') ? repo('/r/inner') : repo('/r'),
    );
    scheduler.request('folder', '/r');
    await flush();
    scheduler.request('folder', '/r/inner');
    await flush();
    expect(scheduler.view('/r/docs/a')).toEqual({ repo: repo('/r') });
    expect(scheduler.view('/r/inner/x')).toEqual({ repo: repo('/r/inner') });
    expect(scheduler.view('/rest')).toBeNull();
    expect(scheduler.view(undefined)).toBeNull();
    scheduler.clear();
    expect(scheduler.view('/r')).toBeNull();
  });
});

describe('git status text', () => {
  const changed = repo('/srv/app', {
    entries: [
      { path: 'src/main.rs', mark: 'M' },
      { path: 'src/deep/new.rs', mark: 'A' },
      { path: 'notes/', mark: '?' },
    ],
  });

  it('reads as a branch with a change count', () => {
    expect(gitStatusText(changed)).toBe('main ●3');
    expect(gitStatusText(repo('/r'))).toBe('main');
    expect(gitStatusText(repo('/r', { branch: null }))).toBe('(abcdef0)');
    expect(gitStatusText({ ...changed, truncated: true })).toBe('main ●3+');
    expect(gitSentence(changed)).toBe('Git main, 변경 3개');
    expect(gitSentence(repo('/r'))).toBe('Git main, 변경 없음');
  });

  it('puts the upstream difference in the tooltip', () => {
    expect(gitTooltip(changed)).toBe(
      '저장소 /srv/app\n브랜치 main · origin/main 대비 앞섬 2 · 뒤처짐 1\n' +
        '변경 3개 (수정 1 · 추가 1 · 추적 안 함 1)',
    );
    expect(gitTooltip(repo('/r', { upstream: null }))).toContain('업스트림 없음');
  });

  it('marks files with their letter and every folder above them', () => {
    expect(Object.fromEntries(treeMarks(changed))).toEqual({
      '/srv/app/src/main.rs': 'M',
      '/srv/app/src': 'folder',
      '/srv/app/src/deep/new.rs': 'A',
      '/srv/app/src/deep': 'folder',
      '/srv/app/notes': '?',
    });
    expect(treeMarks(repo('/', { entries: [{ path: 'etc/x', mark: 'D' }] })).get('/etc')).toBe(
      'folder',
    );
  });

  it('reads Windows folders in the spelling Git prints', () => {
    expect(gitPath('c:\\Users\\a\\repo')).toBe('C:/Users/a/repo');
    // The local file panel joins children with a slash.
    expect(gitPath('C:\\repo/src')).toBe('C:/repo/src');
    expect(gitPath('\\\\wsl.localhost\\Ubuntu\\home')).toBe('//wsl.localhost/Ubuntu/home');
    // A backslash is part of a POSIX file name.
    expect(gitPath('/srv/a\\b')).toBe('/srv/a\\b');
    const windows = repo('C:/repo', { entries: [{ path: 'src/main.rs', mark: 'M' }] });
    expect(treeMarks(windows).get(gitPath('C:\\repo/src'))).toBe('folder');
    expect(treeMarks(windows).get(gitPath('C:\\repo/src/main.rs'))).toBe('M');
  });
});

describe('git status of a Windows folder', () => {
  it('shows the repository for a folder below its root', async () => {
    const { scheduler, flush } = setup((folder) =>
      folder === 'C:/repo' ? repo('C:/repo') : { kind: 'notRepo', detail: '' },
    );
    scheduler.request('folder', 'C:/repo');
    await flush();
    expect(scheduler.view(gitPath('C:\\repo\\src'))).toEqual({ repo: repo('C:/repo') });
  });
});
