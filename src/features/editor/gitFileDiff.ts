import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeGitChanges } from '../../lib/gitChanges';
import { call, errorText } from '../../lib/ipc';
import { sameSource, type Source } from '../../lib/source';
import type { DiffLayout } from './editorTypes';

/** What `git_file_diff` compares (`git_diff/sides.rs`). */
export type DiffCompare =
  | { kind: 'headIndex' }
  /** `deleted`: the file is gone from the working tree, so the right side is empty. */
  | { kind: 'indexWorktree'; deleted: boolean }
  | { kind: 'untracked' };

export type GitDiffTarget = {
  /** The repository root. */
  folder: string;
  /** Relative to the root. */
  path: string;
  /** Where the left side is found, when the file has been renamed since. */
  oldPath: string | null;
  compare: DiffCompare;
};

export type DiffSide =
  | { kind: 'absent' }
  | { kind: 'text'; text: string; encoding: string; lossy: boolean; hash: string }
  | { kind: 'binary'; format: string }
  | { kind: 'tooLarge' };
export type GitFileDiff = { original: DiffSide; modified: DiffSide };

export type DiffReadState =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  /** A different `generation` is a new text on the right, and so a fresh editor. */
  | { status: 'done'; diff: GitFileDiff; generation: number };

export function sideLabels(compare: DiffCompare): [string, string] {
  if (compare.kind === 'headIndex') return ['HEAD', '인덱스'];
  if (compare.kind === 'indexWorktree') return ['인덱스', '작업 트리'];
  return ['없음', '작업 트리'];
}

export function diffTabTitle(name: string, compare: DiffCompare) {
  if (compare.kind === 'headIndex') return `${name} ↔ HEAD`;
  if (compare.kind === 'indexWorktree') return `${name} ↔ 인덱스`;
  return `${name} (새 파일)`;
}

/** Only the working tree can be edited, and saved over. */
export const editsWorktree = (compare: DiffCompare) => compare.kind !== 'headIndex';

function sameSide(a: DiffSide, b: DiffSide) {
  return a.kind === b.kind && (a.kind !== 'text' || a.hash === (b as typeof a).hash);
}

/**
 * The Git view changed something while the tab is open. The left side simply follows. The right
 * side is replaced only if it really changed, and never over edits the user has not saved: a save
 * then stops at the conflict card instead.
 */
export function mergeRefresh(old: GitFileDiff, next: GitFileDiff, dirty: boolean) {
  const keep = sameSide(old.modified, next.modified) || dirty;
  return keep
    ? { diff: { original: next.original, modified: old.modified }, remount: false }
    : { diff: next, remount: true };
}

/** Why the two sides cannot be shown as text, or null when they can. */
export function unshownReason(diff: GitFileDiff) {
  const sides = [diff.original, diff.modified];
  if (sides.some((side) => side.kind === 'tooLarge')) return 'tooLarge' as const;
  return sides.some((side) => side.kind === 'binary') ? ('binary' as const) : null;
}

const layoutKey = 'dachsterm.gitDiff.layout';

export function readDiffLayout(): DiffLayout {
  try {
    return localStorage.getItem(layoutKey) === 'inline' ? 'inline' : 'split';
  } catch {
    // Storage can be blocked; side by side is the default.
    return 'split';
  }
}

export function saveDiffLayout(layout: DiffLayout) {
  try {
    localStorage.setItem(layoutKey, layout);
  } catch {
    // Storage can be blocked; the choice simply is not remembered.
  }
}

/** Reads a tab's two sides, and again when the Git view changes the repository. */
export function useGitFileDiff(source: Source, target: GitDiffTarget, dirty: () => boolean) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<DiffReadState>({ status: 'loading' });
  /** A newer read of either kind makes the answer of an older one stale. */
  const reads = useRef(0);
  const latestDirty = useRef(dirty);
  useEffect(() => {
    latestDirty.current = dirty;
  });
  const read = useCallback(
    () =>
      call<GitFileDiff>('git_file_diff', {
        source,
        folder: target.folder,
        path: target.path,
        oldPath: target.oldPath,
        compare: target.compare,
      }),
    [source, target],
  );

  useEffect(() => {
    const id = ++reads.current;
    read().then(
      (diff) => {
        if (id === reads.current) setState({ status: 'done', diff, generation: 0 });
      },
      (e) => {
        if (id === reads.current) setState({ status: 'failed', message: errorText(e) });
      },
    );
  }, [read, revision]);

  useEffect(() => {
    let running = false;
    let again = false;
    const refresh = () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      const id = ++reads.current;
      read()
        .then((next) => {
          if (id !== reads.current) return;
          setState((old) => {
            // This read overtook the first one, whose answer is now ignored.
            if (old.status !== 'done') return { status: 'done', diff: next, generation: 0 };
            const { diff, remount } = mergeRefresh(old.diff, next, latestDirty.current());
            return { status: 'done', diff, generation: old.generation + (remount ? 1 : 0) };
          });
        })
        .catch(() => {
          // The connection may be gone or the file renamed; what is shown stays until a reload.
        })
        .finally(() => {
          running = false;
          if (again) {
            again = false;
            refresh();
          }
        });
    };
    return subscribeGitChanges((change) => {
      if (
        change.kind === 'index' &&
        change.root === target.folder &&
        sameSource(change.source, source)
      )
        refresh();
    });
  }, [read, source, target.folder]);

  return {
    state,
    reload: useCallback(() => {
      setState({ status: 'loading' });
      setRevision((value) => value + 1);
    }, []),
    /** The tab just saved this text, so the right side is what the file now holds. */
    adopt: useCallback((hash: string, text: string) => {
      setState((old) =>
        old.status === 'done' && old.diff.modified.kind === 'text'
          ? { ...old, diff: { ...old.diff, modified: { ...old.diff.modified, hash, text } } }
          : old,
      );
    }, []),
  };
}
