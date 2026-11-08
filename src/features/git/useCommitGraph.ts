import { useCallback, useEffect, useRef, useState } from 'react';
import { call, errorText } from '../../lib/ipc';
import type { Source } from '../../lib/source';
import { graphMax, graphPage, type CommitDetail, type GitGraphResult } from './commitGraphModel';

type Request = { source: Source; folder: string; limit: number };

/**
 * The history of one repository. The component remounts for another tab or repository, so every
 * reply here belongs to it. A change while a query runs waits for it and sends only the newest.
 */
export function useCommitGraph({
  source,
  folder,
  version,
}: {
  source: Source;
  folder: string;
  /** Changes when the history may have: HEAD, the upstream, or a manual refresh. */
  version: string;
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
    wanted.current = { source, folder, limit };
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
  }, [source, folder, version, limit, attempt]);

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
  const set = useCallback(
    (hash: string, state: DetailState) => setDetails((old) => new Map(old).set(hash, state)),
    [],
  );
  const toggle = (hash: string) => {
    if (opened === hash) {
      setOpened(null);
      return;
    }
    setOpened(hash);
    const known = details.get(hash);
    if (known && known.kind !== 'failed') return;
    set(hash, { kind: 'loading' });
    call<CommitDetail>('git_commit_detail', { source, folder, hash })
      .then((detail) => set(hash, { kind: 'ready', detail }))
      .catch((e: unknown) => set(hash, { kind: 'failed', error: errorText(e) }));
  };
  return { opened, details, toggle };
}
