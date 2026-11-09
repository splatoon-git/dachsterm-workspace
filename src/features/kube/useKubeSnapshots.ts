import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import { advanceHistory, emptyHistory } from './dashboardHistory';
import { advanceIssues, emptyIssues } from './history';
import {
  applySnapshot,
  dueKinds,
  emptySnapshots,
  failedSnapshot,
  finished,
  newSchedule,
  nextWakeIn,
  problemKinds,
  resumed,
  snapshotKinds,
  started,
  type Schedule,
} from './polling';
import type { Snapshot } from './snapshotTypes';

const subscribeVisibility = (change: () => void) => {
  document.addEventListener('visibilitychange', change);
  return () => document.removeEventListener('visibilitychange', change);
};
const documentVisible = () => document.visibilityState !== 'hidden';
export const useDocumentVisible = () => useSyncExternalStore(subscribeVisibility, documentVisible);

/**
 * Polls while `shown`. Each kind waits for its own previous request, and the backend holds a
 * connection to three remote runs. What is running when the tab is hidden still finishes and is
 * kept, but nothing new starts, unless `watching`: alerts that only work while the tab is on screen
 * would tell the user nothing, so a watched tab keeps polling just what decides problems.
 */
export function useKubeSnapshots(
  id: string,
  settings: KubeSettings | null,
  shown: boolean,
  watching: boolean,
) {
  const [{ store, history, issues }, setData] = useState(() => ({
    store: emptySnapshots(),
    history: emptyHistory(),
    issues: emptyIssues(),
  }));
  const [now, setNow] = useState(() => Date.now());
  const visible = useDocumentVisible();
  const schedule = useRef<Schedule | null>(null);
  /** Set only while polling. A request that outlives a hide finds nothing here and stops. */
  const pump = useRef<(() => void) | null>(null);
  const foreground = shown && visible && settings !== null;
  const polling = settings !== null && (foreground || watching);

  useEffect(() => {
    if (!polling || !settings) return;
    const kinds = foreground ? snapshotKinds : problemKinds;
    let timer: number | undefined;
    let current = resumed(schedule.current ?? newSchedule(Date.now()), Date.now());
    schedule.current = current;
    const run = () => {
      window.clearTimeout(timer);
      current = schedule.current ?? current;
      for (const kind of dueKinds(current, Date.now(), kinds)) {
        current = started(current, kind);
        schedule.current = current;
        void call<Snapshot>('kube_snapshot', { id, kube: settings, kind })
          .catch((error: unknown) => failedSnapshot(errorText(error)))
          .then((snapshot) => {
            schedule.current = finished(schedule.current ?? current, kind, Date.now(), snapshot);
            setData((now) => {
              const next = applySnapshot(now.store, kind, snapshot);
              return {
                store: next,
                history: advanceHistory(now.history, next),
                issues: advanceIssues(now.issues, next),
              };
            });
            pump.current?.();
          });
      }
      const wait = nextWakeIn(current, Date.now(), kinds);
      if (wait !== null) timer = window.setTimeout(run, wait);
    };
    pump.current = run;
    run();
    return () => {
      pump.current = null;
      window.clearTimeout(timer);
    };
  }, [id, foreground, polling, settings]);

  useEffect(() => {
    if (!foreground) return;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, [foreground]);

  return { store, history, issues, now };
}
