import { useCallback, useEffect, useRef, useState } from 'react';
import { call, errorText } from '../../lib/ipc';
import type { ServiceFormat, ServiceReport } from './serviceCheck';
import type { Source } from './sourceLink';

export type CheckedService = {
  report: ServiceReport;
  source: Source;
  sourceName: string;
  /** Tells one check's result apart from the next, for what is kept beside it. */
  id: string;
};

/** One service check at a time. Leaving the screen cancels a check still running. */
export function useServiceCheck() {
  const [running, setRunning] = useState(false);
  const [checked, setChecked] = useState<CheckedService | null>(null);
  const [error, setError] = useState('');
  const [cancelled, setCancelled] = useState(false);
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

  const start = useCallback(
    async (source: Source, sourceName: string, target: string, format: ServiceFormat) => {
      const jobId = crypto.randomUUID();
      job.current = jobId;
      setRunning(true);
      setError('');
      setCancelled(false);
      setChecked(null);
      try {
        const report = await call<ServiceReport | null>('net_service_check', {
          source,
          target,
          format,
          jobId,
        });
        if (job.current !== jobId) return;
        if (report) setChecked({ report, source, sourceName, id: jobId });
        else setCancelled(true);
      } catch (e) {
        if (job.current === jobId) setError(errorText(e));
      } finally {
        if (job.current === jobId) {
          job.current = null;
          setRunning(false);
        }
      }
    },
    [],
  );
  return { running, checked, error, cancelled, start, stop };
}
