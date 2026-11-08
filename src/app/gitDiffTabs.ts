import type { DiffCompare, GitDiffTarget } from '../features/editor/gitFileDiff';
import type { GitRow } from '../features/git/gitViewModel';

/** What a row of the Git view compares. A conflict has no single other side and opens as a file. */
function compareOf(row: GitRow): DiffCompare | null {
  if (row.group === 'staged') return { kind: 'headIndex' };
  if (row.group === 'changes') return { kind: 'indexWorktree', deleted: row.change === 'deleted' };
  return row.group === 'untracked' ? { kind: 'untracked' } : null;
}

export function diffTargetOf(row: GitRow, root: string): GitDiffTarget | null {
  const compare = compareOf(row);
  if (!compare || !row.readable) return null;
  // A file staged as renamed and then changed has that old name on its row as well, but the index
  // already holds it under the new one.
  const renamedHere = row.group === 'staged' || row.change === 'renamed';
  return { folder: root, path: row.path, oldPath: renamedHere ? row.oldPath : null, compare };
}

export const sameDiffTarget = (a: GitDiffTarget, b: GitDiffTarget) =>
  a.folder === b.folder && a.path === b.path && a.compare.kind === b.compare.kind;
