import { useCallback, useEffect, useRef, useState } from 'react';
import { call, errorText } from '../../lib/ipc';
import type { Source } from '../../lib/source';
import {
  graphMax,
  graphPage,
  type CommitDetail,
  type GitGraphResult,
  type GraphScope,
} from './commitGraphModel';

type Request = { source: Source; folder: string; limit: number; scope: GraphScope };

/**
 * The history of one repository. The component remounts for another tab or repository, so every
 * reply here belongs to it. A change while a query runs waits for it and sends only the newest.
 */
export function useCommitGraph({
  source,
  folder,
  version,
  scope,
}: {
  source: Source;
  folder: string;
  /** Changes when the history may have: HEAD, the upstream, or a manual refresh. */
  version: string;
  scope: GraphScope;
}) {
  const [limit, setLimit] = useState(graphPage);
  const [result, setResult] = useState<GitGraphResult | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const wanted = useRef<Request | null>(null);
  const running = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    wanted.current = { source, folder, limit, scope };
    if (running.current) return;
    running.current = true;
    void (async () => {
      while (wanted.current) {
        const request = wanted.current;
        wanted.current = null;
        try {
          const reply = await call<GitGraphResult>('git_graph', request);
          if (alive.current && !wanted.current) {
            setResult(reply);
            setError('');
          }
        } catch (e) {
          if (alive.current && !wanted.current) setError(errorText(e));
        }
      }
      running.current = false;
    })();
  }, [source, folder, version, limit, attempt, scope]);

  return {
    result,
    error,
    limit,
    /** Whether the next load can still ask for more commits. */
    canLoadMore: limit < graphMax,
    loadMore: useCallback(() => setLimit((n) => Math.min(n + graphPage, graphMax)), []),
    retry: useCallback(() => setAttempt((n) => n + 1), []),
  };
}

export type DetailState =
  { kind: 'loading' } | { kind: 'ready'; detail: CommitDetail } | { kind: 'failed'; error: string };

/** A commit never changes, so a fetched detail is kept; only a failed one is asked for again. */
export function useCommitDetail(source: Source, folder: string) {
  const [opened, setOpened] = useState<string | null>(null);
  const [details, setDetails] = useState<ReadonlyMap<string, DetailState>>(() => new Map());
  // Read before the state updates, so a hover and a click on one commit ask only once.
  const known = useRef(new Map<string, DetailState>());
  const set = useCallback((hash: string, state: DetailState) => {
    known.current.set(hash, state);
    setDetails(new Map(known.current));
  }, []);
  const load = useCallback(
    (hash: string) => {
      const state = known.current.get(hash);
      if (state && state.kind !== 'failed') return;
      set(hash, { kind: 'loading' });
      call<CommitDetail>('git_commit_detail', { source, folder, hash })
        .then((detail) => set(hash, { kind: 'ready', detail }))
        .catch((e: unknown) => set(hash, { kind: 'failed', error: errorText(e) }));
    },
    [source, folder, set],
  );
  const toggle = (hash: string) => {
    if (opened === hash) {
      setOpened(null);
      return;
    }
    setOpened(hash);
    load(hash);
  };
  return { opened, details, toggle, load };
}
