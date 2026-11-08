import { Channel } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import {
  allScope,
  applySearchEvents,
  idleSearch,
  type SearchEvent,
  type SearchResult,
  type SearchScope,
  type SearchTarget,
} from './logSearchModel';

export type SearchForm = {
  scope: SearchScope;
  since: string;
  customSince: string;
  query: string;
  allContainers: boolean;
  previous: boolean;
  /** Lines shown on each side of a result, when one is opened. */
  around: number;
  byPod: boolean;
  descending: boolean;
};

const initialForm: SearchForm = {
  scope: allScope,
  since: '15m',
  customSince: '',
  query: '',
  allContainers: false,
  previous: false,
  around: 10,
  byPod: false,
  descending: false,
};

/** Results can arrive faster than the screen is worth redrawing. */
const FLUSH_MS = 80;

/**
 * Held by the workspace rather than the search screen, so moving to the tree and back keeps the
 * results and a search still running. Leaving the tab cancels it. Everything stays in memory.
 */
export function useLogSearch(connectionId: string) {
  const [form, setForm] = useState<SearchForm>(initialForm);
  const [result, setResult] = useState<SearchResult>(idleSearch);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const running = useRef<string | null>(null);
  const pending = useRef<SearchEvent[]>([]);
  const timer = useRef<number | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    const events = pending.current;
    pending.current = [];
    if (!events.length) return;
    if (events.some((event) => event.type === 'finished')) running.current = null;
    setResult((now) => applySearchEvents(now, events));
  }, []);

  const start = useCallback(
    async (kube: KubeSettings, targets: SearchTarget[], since: string, query: string) => {
      if (running.current) return;
      const searchId = crypto.randomUUID();
      const channel = new Channel<SearchEvent>();
      running.current = searchId;
      pending.current = [];
      setError('');
      setStarting(true);
      setResult(idleSearch);
      channel.onmessage = (event) => {
        if (running.current !== searchId) return;
        // The backend has registered the search before its first event, so it can be cancelled now.
        if (event.type === 'started') setStarting(false);
        pending.current.push(event);
        timer.current ??= window.setTimeout(flush, FLUSH_MS);
      };
      try {
        await call('kube_log_search', {
          id: connectionId,
          kube,
          searchId,
          request: { targets, since, query },
          onEvent: channel,
        });
      } catch (e) {
        if (running.current === searchId) running.current = null;
        setError(errorText(e));
      } finally {
        setStarting(false);
      }
    },
    [connectionId, flush],
  );

  const cancel = useCallback(() => {
    const searchId = running.current;
    // A search that has already ended has nothing to cancel.
    if (searchId) void call('kube_log_cancel', { searchId }).catch(() => {});
  }, []);

  useEffect(
    () => () => {
      cancel();
      running.current = null;
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [cancel],
  );

  return { form, setForm, result, error, starting, start, cancel };
}

export type LogSearchHandle = ReturnType<typeof useLogSearch>;
