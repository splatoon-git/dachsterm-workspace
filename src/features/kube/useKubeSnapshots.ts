import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import { advanceHistory, emptyHistory } from './dashboardHistory';
import {
  applySnapshot,
  dueKinds,
  emptySnapshots,
  failedSnapshot,
  finished,
  newSchedule,
  nextWakeIn,
  resumed,
  started,
  type Schedule,
} from './polling';
import type { Snapshot } from './snapshotTypes';

const subscribeVisibility = (change: () => void) => {
  document.addEventListener('visibilitychange', change);
  return () => document.removeEventListener('visibilitychange', change);
};
const documentVisible = () => document.visibilityState !== 'hidden';

/**
 * Polls while `shown`. Each kind waits for its own previous request, and the backend holds a
 * connection to three remote runs. What is running when the tab is hidden still finishes and is
 * kept, but nothing new starts.
 */
export function useKubeSnapshots(id: string, settings: KubeSettings | null, shown: boolean) {
  const [{ store, history }, setData] = useState(() => ({
    store: emptySnapshots(),
    history: emptyHistory(),
  }));
  const [now, setNow] = useState(() => Date.now());
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible);
  const schedule = useRef<Schedule | null>(null);
  /** Set only while polling. A request that outlives a hide finds nothing here and stops. */
  const pump = useRef<(() => void) | null>(null);
  const polling = shown && visible && settings !== null;

  useEffect(() => {
    if (!polling || !settings) return;
    let timer: number | undefined;
    let current = resumed(schedule.current ?? newSchedule(Date.now()), Date.now());
    schedule.current = current;
    const run = () => {
      window.clearTimeout(timer);
      current = schedule.current ?? current;
      for (const kind of dueKinds(current, Date.now())) {
        current = started(current, kind);
        schedule.current = current;
        void call<Snapshot>('kube_snapshot', { id, kube: settings, kind })
          .catch((error: unknown) => failedSnapshot(errorText(error)))
          .then((snapshot) => {
            schedule.current = finished(schedule.current ?? current, kind, Date.now(), snapshot);
            setData((now) => {
              const next = applySnapshot(now.store, kind, snapshot);
              return { store: next, history: advanceHistory(now.history, next) };
            });
            pump.current?.();
          });
      }
      const wait = nextWakeIn(current, Date.now());
      if (wait !== null) timer = window.setTimeout(run, wait);
    };
    pump.current = run;
    run();
    return () => {
      pump.current = null;
      window.clearTimeout(timer);
    };
  }, [id, polling, settings]);

  useEffect(() => {
    if (!polling) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, [polling]);

  return { store, history, now };
}
