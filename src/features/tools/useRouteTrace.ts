import { Channel } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { call, errorText } from '../../lib/ipc';
import { applyTraceEvent, beginTrace, idleTrace, type TraceEvent } from './routeTrace';
import type { Source } from './sourceLink';

/** One trace at a time. Leaving the screen, or running another check, cancels what is running. */
export function useRouteTrace() {
  const [state, setState] = useState(idleTrace);
  const [error, setError] = useState('');
  const job = useRef<string | null>(null);

  const stop = useCallback(() => {
    const id = job.current;
    // A job that has already ended has nothing to cancel.
    if (id) void call('net_cancel', { jobId: id }).catch(() => {});
  }, []);
  useEffect(
    () => () => {
      stop();
      job.current = null;
    },
    [stop],
  );

  const start = useCallback(async (source: Source, host: string, port: number) => {
    const jobId = crypto.randomUUID();
    const channel = new Channel<TraceEvent>();
    channel.onmessage = (event) => {
      if (job.current !== jobId) return;
      if (event.type === 'finished') job.current = null;
      setState((current) => applyTraceEvent(current, event));
    };
    job.current = jobId;
    setError('');
    setState(beginTrace());
    try {
      await call('net_trace', { source, host, port, jobId, onEvent: channel });
    } catch (e) {
      if (job.current !== jobId) return;
      job.current = null;
      setError(errorText(e));
      setState(idleTrace);
    }
  }, []);
  return { state, error, start, stop };
}
