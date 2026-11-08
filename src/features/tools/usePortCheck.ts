import { Channel } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { call } from '../../lib/ipc';
import {
  applyCheckEvents,
  beginCheck,
  idleCheck,
  type CheckEvent,
  type CheckStart,
  type CheckState,
} from './portCheck';
import type { Source } from './sourceLink';

export type CheckRequest = {
  source: Source;
  targets: string;
  ports: string;
  timeoutSeconds: number;
  confirmed: boolean;
  /** Keep the current list and replace only what comes back. */
  keep?: boolean;
};

/** Thousands of results can arrive in a few seconds, so they reach the screen in batches. */
const FLUSH_MS = 60;

/** One port check at a time. Leaving the screen cancels a check still running. */
export function usePortCheck() {
  const [state, setState] = useState<CheckState>(idleCheck);
  const job = useRef<string | null>(null);
  const started = useRef(false);
  const pending = useRef<CheckEvent[]>([]);
  const timer = useRef<number | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    if (!started.current) return;
    const events = pending.current;
    pending.current = [];
    if (!events.length) return;
    if (events.some((event) => event.type === 'finished')) job.current = null;
    setState((current) => applyCheckEvents(current, events, Date.now()));
  }, []);
  const schedule = useCallback(() => {
    if (timer.current === null) timer.current = window.setTimeout(flush, FLUSH_MS);
  }, [flush]);

  const stop = useCallback(() => {
    const id = job.current;
    // A job that has already ended has nothing to cancel.
    if (id) void call('net_cancel', { jobId: id }).catch(() => {});
  }, []);

  useEffect(
    () => () => {
      stop();
      job.current = null;
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [stop],
  );

  const start = useCallback(
    async ({ keep = false, ...request }: CheckRequest): Promise<CheckStart> => {
      const jobId = crypto.randomUUID();
      const channel = new Channel<CheckEvent>();
      channel.onmessage = (event) => {
        if (job.current !== jobId) return;
        pending.current.push(event);
        schedule();
      };
      pending.current = [];
      started.current = false;
      job.current = jobId;
      let answer: CheckStart;
      try {
        answer = await call<CheckStart>('net_port_check', { ...request, jobId, onEvent: channel });
      } catch (error) {
        job.current = null;
        throw error;
      }
      if (answer.state === 'running') {
        started.current = true;
        setState((current) => beginCheck(current, keep));
        schedule();
      } else {
        job.current = null;
      }
      return answer;
    },
    [schedule],
  );

  const reset = useCallback(() => setState(idleCheck), []);
  return { state, start, stop, reset };
}
