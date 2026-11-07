import { useEffect, useRef, useState } from 'react';
import { call, errorText } from '../../lib/ipc';
import {
  sameBase,
  type DiffBase,
  type DiffFile,
  type DiffList,
  type FileDiff,
  type GitRefs,
} from './gitDiff';

export type Loaded<T> =
  { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T };
const loading = { state: 'loading' } as const;
const failed = (e: unknown) => ({ state: 'error', message: errorText(e) }) as const;

/**
 * What the review shows, asked for only when the user opens the tab, changes the base, the
 * worktree or the file, or refreshes. There is no polling. Each reply is filed under the request
 * it answers, so a late reply never shows for a newer choice.
 */
export function useReviewData(connectionId: string, folder: string) {
  const [refs, setRefs] = useState<Loaded<GitRefs>>(loading);
  const [root, setRoot] = useState('');
  const [base, setBase] = useState<DiffBase>({ kind: 'workingTree' });
  const [round, setRound] = useState(0);
  const [listed, setListed] = useState<{ key: string; list: Loaded<DiffList> } | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [diffs, setDiffs] = useState(() => new Map<string, Loaded<FileDiff>>());
  const latestRefs = useRef(0);

  useEffect(() => {
    const ticket = ++latestRefs.current;
    void call<GitRefs>('git_refs', { id: connectionId, folder: root || folder })
      .then((value) => {
        if (ticket !== latestRefs.current) return;
        setRefs({ state: 'ready', value });
        setRoot(value.root);
        // A branch that disappeared since the last look falls back to HEAD.
        setBase((old) =>
          old.kind === 'branch' && !value.refs.includes(old.ref) ? { kind: 'workingTree' } : old,
        );
      })
      .catch((e) => {
        if (ticket === latestRefs.current) setRefs(failed(e));
      });
    // `root` is read when a round starts; choosing a worktree sets it and starts a round itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, folder, round]);

  const listKey = root ? JSON.stringify([root, base, round]) : '';
  useEffect(() => {
    if (!listKey) return;
    let current = true;
    void call<DiffList>('git_diff_files', { id: connectionId, root, base })
      .then((list) => {
        if (!current) return;
        setListed({ key: listKey, list: { state: 'ready', value: list } });
        const files = list.kind === 'files' ? list.files : [];
        setPath((old) =>
          old && files.some((f) => f.path === old)
            ? old
            : (files.find((f) => f.readable)?.path ?? null),
        );
      })
      .catch((e) => {
        if (current) setListed({ key: listKey, list: failed(e) });
      });
    return () => {
      current = false;
    };
    // The key names everything the request uses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, listKey]);

  const list = !listKey ? null : listed?.key === listKey ? listed.list : loading;
  const files = list?.state === 'ready' && list.value.kind === 'files' ? list.value.files : [];
  const current = files.find((f) => f.path === path) ?? null;
  const fileKey =
    current?.readable && JSON.stringify([listKey, current.oldPath, current.path, current.change]);

  useEffect(() => {
    if (!current || !fileKey || diffs.has(fileKey)) return;
    void call<FileDiff>('git_diff_file', {
      id: connectionId,
      root,
      base,
      path: current.path,
      oldPath: current.oldPath,
      untracked: current.change === 'untracked',
    })
      .then((value): Loaded<FileDiff> => ({ state: 'ready', value }))
      .catch(failed)
      .then((loaded) => setDiffs((old) => new Map(old).set(fileKey, loaded)));
    // The key names everything the request uses; `diffs` only says whether it was asked before.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, fileKey]);

  return {
    refs,
    root,
    base,
    list,
    files,
    current,
    file: fileKey ? (diffs.get(fileKey) ?? loading) : null,
    chooseBase: (next: DiffBase) => setBase((old) => (sameBase(old, next) ? old : next)),
    chooseRoot: (next: string) => {
      setRoot(next);
      setRound((n) => n + 1);
    },
    choose: (next: DiffFile) => setPath(next.path),
    refresh: () => {
      setDiffs(new Map());
      setRound((n) => n + 1);
    },
  };
}
export type ReviewData = ReturnType<typeof useReviewData>;
