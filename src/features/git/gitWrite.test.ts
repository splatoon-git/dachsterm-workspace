// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { terminalReadiness, type TerminalFacts } from './gitTerminal';
import {
  branchChoices,
  branchPicks,
  failureText,
  safeTerminalWord,
  trackCommand,
} from './gitWrite';
import { groupItems, rowItems, type FileActions } from './gitWriteMenu';
import type { GitGroup, GitRow } from './gitViewModel';

const facts = (over: Partial<TerminalFacts> = {}): TerminalFacts => ({
  connected: true,
  directory: '/srv/app/src',
  root: '/srv/app',
  tmux: false,
  fullScreen: false,
  reportsPrompts: true,
  promptWaiting: true,
  promptHasText: false,
  ...over,
});

describe('terminalReadiness', () => {
  it('lets a waiting prompt in the repository take the command', () => {
    expect(terminalReadiness(facts())).toEqual({ state: 'ready' });
    expect(terminalReadiness(facts({ directory: '/srv/app' }))).toEqual({ state: 'ready' });
  });
  it('blocks while a command or a full-screen program runs', () => {
    expect(terminalReadiness(facts({ promptWaiting: false }))).toEqual({
      state: 'blocked',
      text: '터미널이 사용 중입니다.',
    });
    expect(terminalReadiness(facts({ fullScreen: true }))).toEqual({
      state: 'blocked',
      text: '터미널이 사용 중입니다.',
    });
  });
  it('never adds to what the user is typing', () => {
    expect(terminalReadiness(facts({ promptHasText: true }))).toEqual({
      state: 'blocked',
      text: '터미널 프롬프트에 입력 중인 글자가 있습니다.',
    });
  });
  it('runs only in the folder the view shows', () => {
    const blocked = (directory: string | null) =>
      terminalReadiness(facts({ directory })).state === 'blocked';
    expect(blocked(null)).toBe(true);
    expect(blocked('/srv/other')).toBe(true);
    expect(blocked('/srv/app2')).toBe(true);
  });
  it('matches a Windows folder however it is spelled', () => {
    expect(terminalReadiness(facts({ directory: 'C:\\repo\\src', root: 'C:/repo' })).state).toBe(
      'ready',
    );
    expect(terminalReadiness(facts({ directory: 'c:\\repo', root: 'C:/repo' })).state).toBe(
      'ready',
    );
  });
  it('asks when nothing reports what the terminal does', () => {
    expect(terminalReadiness(facts({ reportsPrompts: false, promptWaiting: false }))).toEqual({
      state: 'ask',
    });
  });
  it('asks in tmux, whose screen always looks full-screen, but still checks the folder', () => {
    const tmux = facts({ tmux: true, fullScreen: true, reportsPrompts: false });
    expect(terminalReadiness(tmux)).toEqual({ state: 'ask' });
    expect(terminalReadiness({ ...tmux, directory: '/elsewhere' }).state).toBe('blocked');
  });
  it('blocks a closed connection first', () => {
    expect(terminalReadiness(facts({ connected: false })).state).toBe('blocked');
  });
});

describe('typing branch names', () => {
  it('accepts names that read the same in every shell', () => {
    for (const name of ['main', 'origin/feat/기능-1', 'v1.2_x']) {
      expect(safeTerminalWord(name), name).toBe(true);
    }
  });
  it('refuses anything a shell would read differently', () => {
    for (const name of [
      '',
      '-f',
      'a b',
      'a;rm',
      '$(x)',
      'a`b',
      "a'b",
      'a&b',
      'a|b',
      'a#b',
      '@x',
      'a\nb',
      'a..b',
      '%PATH%',
    ]) {
      expect(safeTerminalWord(name), name).toBe(false);
    }
  });
  it('builds the checkout line only for a safe name', () => {
    expect(trackCommand('origin/feat')).toBe('git checkout --track origin/feat');
    expect(trackCommand('origin/$(x)')).toBeNull();
  });
});

describe('branchChoices', () => {
  const refs = [
    'refs/heads/feat',
    'refs/heads/main',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/feat',
    'refs/remotes/origin/only-remote',
    'refs/remotes/up/a/b',
  ];
  it('lists other local branches and remote ones without a local copy', () => {
    expect(branchChoices(refs, 'main')).toEqual({
      local: ['feat'],
      remote: ['origin/only-remote', 'up/a/b'],
    });
  });
  it('lists every local branch when HEAD is detached', () => {
    expect(branchChoices(refs, null).local).toEqual(['feat', 'main']);
  });
});

describe('failureText', () => {
  const failed = (reason: 'identity' | 'git' | 'timeout', detail: string) =>
    ({ kind: 'failed', commands: [] as string[], reason, detail }) as const;
  it('points at the settings for a missing identity, with Git’s own line', () => {
    expect(failureText(failed('identity', 'fatal: empty ident name'))).toBe(
      '커밋 작성자 이름·이메일이 없습니다. 설정 → Git에서 지정하세요. fatal: empty ident name',
    );
  });
  it('shows a hook’s line as it is, and never nothing', () => {
    expect(failureText(failed('git', 'lint: 3 errors'))).toBe('lint: 3 errors');
    expect(failureText(failed('git', ''))).toBe('Git 명령이 실패했습니다.');
    expect(failureText(failed('timeout', ''))).toContain('저장소 상태를 확인하세요');
  });
});

describe('menus', () => {
  const row = (over: Partial<GitRow>): GitRow => ({
    key: 'k',
    group: 'changes',
    path: 'a.txt',
    oldPath: null,
    change: 'modified',
    readable: true,
    ...over,
  });
  const actions = (busy = false) =>
    ({ busy, stage: vi.fn(), unstage: vi.fn(), discard: vi.fn() }) satisfies FileActions;
  const labels = (items: { label: string }[]) => items.map((item) => item.label);

  it('offers each group its own actions', () => {
    const act = actions();
    expect(labels(rowItems(row({ group: 'staged' }), act))).toEqual(['스테이지 취소']);
    expect(labels(rowItems(row({ group: 'changes' }), act))).toEqual(['스테이지', '변경 버리기…']);
    expect(labels(rowItems(row({ group: 'untracked' }), act))).toEqual(['스테이지', '파일 삭제…']);
    expect(labels(rowItems(row({ group: 'conflict' }), act))).toEqual(['해결됨으로 스테이지']);
  });
  it('unstages both names of a rename', () => {
    const act = actions();
    rowItems(row({ group: 'staged', path: 'new', oldPath: 'old' }), act)[0].run();
    expect(act.unstage).toHaveBeenCalledWith(['new', 'old']);
  });
  it('keeps tracked discards and untracked deletes apart', () => {
    const act = actions();
    rowItems(row({}), act)[1].run();
    expect(act.discard).toHaveBeenLastCalledWith({ paths: ['a.txt'], untracked: [] });
    rowItems(row({ group: 'untracked' }), act)[1].run();
    expect(act.discard).toHaveBeenLastCalledWith({ paths: [], untracked: ['a.txt'] });
  });
  it('disables a file whose name cannot be asked for, and everything while busy', () => {
    expect(rowItems(row({ readable: false }), actions()).every((i) => i.disabled)).toBe(true);
    expect(rowItems(row({}), actions(true)).every((i) => i.disabled)).toBe(true);
  });
  it('acts on the files a group lists and says how many it left out', () => {
    const group: GitGroup = {
      id: 'changes',
      label: '변경',
      rows: [row({ path: 'a' }), row({ path: 'bad', readable: false }), row({ path: 'b' })],
    };
    const act = actions();
    const [stage, discard] = groupItems(group, act);
    stage.run();
    expect(act.stage).toHaveBeenCalledWith(['a', 'b']);
    discard.run();
    expect(act.discard).toHaveBeenCalledWith({ paths: ['a', 'b'], untracked: [], omitted: 1 });
  });
  it('has nothing to do to a whole conflict group', () => {
    const group: GitGroup = { id: 'conflict', label: '충돌', rows: [row({ group: 'conflict' })] };
    expect(groupItems(group, actions())).toEqual([]);
  });
});

describe('branchPicks', () => {
  const choices = { local: ['feat/a', 'main'], remote: ['origin/Feat-b'] };
  it('offers creating a branch first, then local, then remote', () => {
    expect(branchPicks(choices, '')).toEqual([
      { kind: 'create', name: '' },
      { kind: 'local', name: 'feat/a' },
      { kind: 'local', name: 'main' },
      { kind: 'remote', name: 'origin/Feat-b' },
    ]);
  });
  it('narrows either kind, ignoring case and spaces around', () => {
    expect(branchPicks(choices, ' FEAT ').map((pick) => pick.name)).toEqual([
      '',
      'feat/a',
      'origin/Feat-b',
    ]);
  });
  it('still offers creating when nothing matches', () => {
    expect(branchPicks(choices, 'zzz').map((pick) => pick.kind)).toEqual(['create']);
  });
});
