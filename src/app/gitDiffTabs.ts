import type { DiffCompare, GitDiffTarget } from '../features/editor/gitFileDiff';
import type { CommitFileOrigin } from '../features/git/commitGraphModel';
import type { DiffFile } from '../features/git/gitDiff';
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

/** A file in the commit graph. A name that is not UTF-8 cannot be asked for. */
export function commitDiffTarget(
  file: DiffFile,
  origin: CommitFileOrigin,
  root: string,
): GitDiffTarget | null {
  if (!file.readable) return null;
  return {
    folder: root,
    path: file.path,
    oldPath: file.oldPath,
    compare: { kind: 'commit', hash: origin.hash, parent: origin.parent },
  };
}

const sameCompare = (a: GitDiffTarget['compare'], b: GitDiffTarget['compare']) =>
  a.kind === 'commit' ? b.kind === 'commit' && a.hash === b.hash : a.kind === b.kind;

export const sameDiffTarget = (a: GitDiffTarget, b: GitDiffTarget) =>
  a.folder === b.folder && a.path === b.path && sameCompare(a.compare, b.compare);
