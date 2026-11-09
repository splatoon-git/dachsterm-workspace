import { Channel } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import type { IngressController } from './ingressTypes';
import {
  INITIAL_TAIL,
  LineStore,
  readBoardPrefs,
  resolveSources,
  writeBoardPrefs,
  type BoardEntry,
  type BoardPrefs,
  type BoardSource,
  type StreamEvent,
  type StreamRequest,
} from './logBoardModel';
import { stateNote } from './polling';
import type { KubePod, KubeService } from './snapshotTypes';

/** Fast enough to read as live, slow enough that 20 panes are not redrawn per line. */
const FLUSH_MS = 150;
const NO_PODS: KubePod[] = [];
const NO_SERVICES: KubeService[] = [];

export type BoardPhase = 'idle' | 'live' | 'ended';
export type SourceEnd = { failed: boolean; note: string };

/**
 * Held by the workspace rather than the board screen, so looking at the tree does not stop the
 * logs. One stream at a time; when the pods change it is replaced and each pod continues from the
 * last line it showed. Closing the tab cancels it.
 */
export function useLogBoard(
  connectionId: string,
  kube: KubeSettings | null,
  pods: KubePod[] | null,
  services: KubeService[] | null,
  controllers: IngressController[],
) {
  const [entries, setEntries] = useState<BoardEntry[]>([]);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [phase, setPhase] = useState<BoardPhase>('idle');
  const [error, setError] = useState('');
  const [ended, setEnded] = useState<Record<string, SourceEnd>>({});
  const [dropped, setDropped] = useState(0);
  const [version, setVersion] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [prefs, setPrefsState] = useState<BoardPrefs>(readBoardPrefs);
  const [store] = useState(() => new LineStore());

  const { sources, omitted } = useMemo(
    () => resolveSources(entries, pods ?? NO_PODS, services ?? NO_SERVICES, controllers, excluded),
    [entries, pods, services, controllers, excluded],
  );
  const latest = useRef({ sources, kube });
  useEffect(() => {
    latest.current = { sources, kube };
  });
  const streamKey = sources.map((source) => `${source.key}|${source.filter}`).join('\n');
  const kubeKey = kube ? `${kube.context}/${kube.kubeconfig}/${kube.kubectl}` : '';

  useEffect(() => {
    const current = latest.current;
    if (!streamKey || !current.kube) {
      setPhase('idle');
      return;
    }
    const streamSources: BoardSource[] = current.sources;
    const streamId = crypto.randomUUID();
    const channel = new Channel<StreamEvent>();
    const pending: StreamEvent[] = [];
    let timer: number | null = null;
    let live = true;
    let cancellable = false;

    const cancel = () => {
      // A stream that has already ended has nothing to cancel.
      void call('kube_log_cancel', { searchId: streamId }).catch(() => {});
    };
    const flush = () => {
      timer = null;
      if (!live) return;
      const events = pending.splice(0);
      let lost = 0;
      const ends: Record<string, SourceEnd> = {};
      for (const event of events) {
        if (event.type === 'lines') {
          lost += event.dropped;
          for (const line of event.lines) {
            const source = streamSources[line.source];
            if (source) store.add(source, line.time, line.text);
          }
        } else if (event.type === 'sourceEnded') {
          const source = streamSources[event.source];
          if (source)
            ends[source.key] = {
              failed: event.state.kind !== 'ready',
              note: event.state.kind === 'ready' ? '로그가 끝났습니다.' : stateNote(event.state),
            };
        } else if (event.type === 'finished') {
          setPhase('ended');
          if (event.state.kind !== 'ready') setError(stateNote(event.state));
        }
      }
      if (lost) setDropped((now) => now + lost);
      if (Object.keys(ends).length) setEnded((now) => ({ ...now, ...ends }));
      setVersion((now) => now + 1);
    };
    channel.onmessage = (event) => {
      if (event.type === 'started') {
        cancellable = true;
        // Replaced before the backend registered it: cancelling earlier would have done nothing.
        if (!live) cancel();
        return;
      }
      if (!live) return;
      pending.push(event);
      timer ??= window.setTimeout(flush, FLUSH_MS);
    };

    setPhase('live');
    setError('');
    setEnded({});
    const request: StreamRequest[] = streamSources.map((source) => {
      const since = store.lastTime(source.key);
      if (since) store.resume(source.key);
      return {
        namespace: source.namespace,
        pod: source.pod,
        container: source.container,
        tail: INITIAL_TAIL,
        since,
        filter: source.filter || null,
      };
    });
    call('kube_log_stream', {
      id: connectionId,
      kube: current.kube,
      streamId,
      sources: request,
      onEvent: channel,
    }).catch((e: unknown) => {
      if (!live) return;
      setPhase('ended');
      setError(errorText(e));
    });
    return () => {
      live = false;
      if (timer !== null) window.clearTimeout(timer);
      if (cancellable) cancel();
    };
  }, [connectionId, kubeKey, streamKey, attempt, store]);

  /** Adds what is not on the board yet, or starts over with exactly these. */
  const watch = useCallback((next: BoardEntry[], replace = false) => {
    setExcluded(new Set());
    setEntries((now) =>
      replace
        ? next
        : [...now, ...next.filter((entry) => !now.some((item) => item.id === entry.id))],
    );
  }, []);
  const removeEntry = useCallback((id: string) => {
    setEntries((now) => now.filter((entry) => entry.id !== id));
  }, []);
  const excludeSource = useCallback((key: string) => {
    setExcluded((now) => new Set(now).add(key));
  }, []);
  const clearFilter = useCallback((id: string) => {
    setEntries((now) => now.map((entry) => (entry.id === id ? { ...entry, filter: '' } : entry)));
  }, []);
  const clearLines = useCallback(() => {
    store.clear();
    setDropped(0);
    setVersion((now) => now + 1);
  }, [store]);
  const restart = useCallback(() => setAttempt((now) => now + 1), []);
  const setPrefs = useCallback((change: Partial<BoardPrefs>) => {
    setPrefsState((now) => {
      const next = { ...now, ...change };
      writeBoardPrefs(next);
      return next;
    });
  }, []);

  return {
    entries,
    sources,
    omitted,
    phase,
    error,
    ended,
    dropped,
    version,
    store,
    prefs,
    setPrefs,
    watch,
    removeEntry,
    excludeSource,
    clearFilter,
    clearLines,
    restart,
  };
}

export type LogBoardHandle = ReturnType<typeof useLogBoard>;
