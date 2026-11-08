import { describe, expect, it } from 'vitest';
import type { GitRow } from '../features/git/gitViewModel';
import { commitDiffTarget, diffTargetOf, sameDiffTarget } from './gitDiffTabs';

const row = (over: Partial<GitRow>): GitRow => ({
  key: 'k',
  group: 'changes',
  path: 'src/a.ts',
  oldPath: null,
  change: 'modified',
  readable: true,
  ...over,
});

describe('what a Git view row compares', () => {
  it('compares a staged row with HEAD', () => {
    expect(diffTargetOf(row({ group: 'staged' }), '/srv/app')).toEqual({
      folder: '/srv/app',
      path: 'src/a.ts',
      oldPath: null,
      compare: { kind: 'headIndex' },
    });
  });

  it('compares a changed row with the index', () => {
    expect(diffTargetOf(row({}), '/srv/app')?.compare).toEqual({
      kind: 'indexWorktree',
      deleted: false,
    });
    expect(diffTargetOf(row({ change: 'deleted' }), '/srv/app')?.compare).toEqual({
      kind: 'indexWorktree',
      deleted: true,
    });
  });

  it('shows an untracked row as a new file', () => {
    const untracked = row({ group: 'untracked', change: 'untracked' });
    expect(diffTargetOf(untracked, '/srv/app')?.compare).toEqual({ kind: 'untracked' });
  });

  it('has no diff for a conflict or a name that is not the real one', () => {
    expect(diffTargetOf(row({ group: 'conflict', change: 'conflict' }), '/r')).toBeNull();
    expect(diffTargetOf(row({ readable: false }), '/r')).toBeNull();
  });

  it('reads the old name of a staged rename', () => {
    const staged = row({ group: 'staged', change: 'renamed', oldPath: 'old.ts' });
    expect(diffTargetOf(staged, '/r')?.oldPath).toBe('old.ts');
  });

  it('does not read the old name of a file renamed in the index and then changed', () => {
    expect(diffTargetOf(row({ oldPath: 'old.ts' }), '/r')?.oldPath).toBeNull();
  });
});

describe('one tab per comparison', () => {
  const changed = diffTargetOf(row({}), '/r')!;

  it('is the same tab when only the listing changed', () => {
    expect(sameDiffTarget(changed, diffTargetOf(row({ change: 'deleted' }), '/r')!)).toBe(true);
  });

  it('keeps the staged and changed sides of a file apart', () => {
    expect(sameDiffTarget(changed, diffTargetOf(row({ group: 'staged' }), '/r')!)).toBe(false);
  });

  it('keeps worktrees apart', () => {
    expect(sameDiffTarget(changed, diffTargetOf(row({}), '/other')!)).toBe(false);
  });
});

describe('a commit file', () => {
  const file = {
    path: 'new.ts',
    oldPath: 'old.ts',
    change: 'renamed',
    added: 1,
    removed: 0,
    binary: false,
    readable: true,
  } as const;
  const origin = { hash: 'a'.repeat(40), parent: 'b'.repeat(40) };
  const target = commitDiffTarget(file, origin, '/r')!;

  it('compares the commit with its parent, under the name each side had', () => {
    expect(target).toEqual({
      folder: '/r',
      path: 'new.ts',
      oldPath: 'old.ts',
      compare: { kind: 'commit', ...origin },
    });
  });

  it('is its own tab for each commit, and is not a working tree diff of that file', () => {
    expect(sameDiffTarget(target, commitDiffTarget(file, origin, '/r')!)).toBe(true);
    const other = commitDiffTarget(file, { ...origin, hash: 'c'.repeat(40) }, '/r')!;
    expect(sameDiffTarget(target, other)).toBe(false);
    const working = { ...target, compare: { kind: 'headIndex' } as const };
    expect(sameDiffTarget(working, target)).toBe(false);
    expect(sameDiffTarget(target, working)).toBe(false);
  });

  it('a name that is not UTF-8 cannot be asked for', () => {
    expect(commitDiffTarget({ ...file, readable: false }, origin, '/r')).toBeNull();
  });
});
