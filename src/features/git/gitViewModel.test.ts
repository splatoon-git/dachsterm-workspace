import { describe, expect, it } from 'vitest';
import {
  buildTree,
  flattenTree,
  groupEntries,
  splitPath,
  type GitListItem,
  type GitViewEntry,
} from './gitViewModel';

const entry = (path: string, over: Partial<GitViewEntry>): GitViewEntry => ({
  path,
  oldPath: null,
  index: null,
  worktree: null,
  readable: true,
  ...over,
});

const shown = (items: GitListItem[]) =>
  items.map((item) =>
    item.kind === 'file' ? `${item.depth}:${item.row.path}` : `${item.depth}:[${item.name}]`,
  );

describe('groupEntries', () => {
  it('shows a file changed on both sides in both groups', () => {
    const groups = groupEntries([entry('a.ts', { index: 'modified', worktree: 'deleted' })]);
    expect(groups.map((g) => [g.id, g.rows[0].change])).toEqual([
      ['staged', 'modified'],
      ['changes', 'deleted'],
    ]);
    expect(new Set(groups.map((g) => g.rows[0].key)).size).toBe(2);
  });

  it('keeps the order of the sidebar and hides empty groups', () => {
    const groups = groupEntries([
      entry('conflict', { index: 'conflict', worktree: 'conflict' }),
      entry('new', { worktree: 'untracked' }),
      entry('edit', { worktree: 'modified' }),
      entry('add', { index: 'added' }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['스테이지됨', '변경', '추적 안 함', '충돌']);
    expect(groups.find((g) => g.id === 'conflict')!.rows).toHaveLength(1);
    expect(groupEntries([])).toEqual([]);
  });

  it('carries the old name and whether the name can be asked for', () => {
    const [group] = groupEntries([
      entry('new name', { index: 'renamed', oldPath: 'old name', readable: false }),
    ]);
    expect(group.rows[0]).toMatchObject({ oldPath: 'old name', readable: false });
  });
});

describe('the tree layout', () => {
  const rows = groupEntries([
    entry('src/app/a.ts', { worktree: 'modified' }),
    entry('src/app/b.ts', { worktree: 'modified' }),
    entry('src/lib/deep/c.ts', { worktree: 'modified' }),
    entry('README.md', { worktree: 'modified' }),
  ])[0].rows;

  it('lists folders before files and joins single-folder chains', () => {
    expect(shown(flattenTree(buildTree(rows), new Set(), 'changes'))).toEqual([
      '0:[src]',
      '1:[app]',
      '2:src/app/a.ts',
      '2:src/app/b.ts',
      '1:[lib/deep]',
      '2:src/lib/deep/c.ts',
      '0:README.md',
    ]);
  });

  it('leaves out what a folded folder holds', () => {
    expect(shown(flattenTree(buildTree(rows), new Set(['changes/src']), 'changes'))).toEqual([
      '0:[src]',
      '0:README.md',
    ]);
  });

  it('folds a joined chain under the key of its deepest folder', () => {
    const items = flattenTree(buildTree(rows), new Set(), 'changes');
    const joined = items.find((i) => i.kind === 'folder' && i.name === 'lib/deep');
    expect(joined).toMatchObject({ key: 'changes/src/lib/deep' });
  });
});

describe('splitPath', () => {
  it('separates the name from its folder', () => {
    expect(splitPath('a/b/c.ts')).toEqual({ name: 'c.ts', folder: 'a/b' });
    expect(splitPath('c.ts')).toEqual({ name: 'c.ts', folder: '' });
  });
});
