import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { call, errorText, type KubeSettings } from '../../lib/ipc';
import type { KubeState } from './kubeModel';
import type { MetricsRead, ProbeRead } from './runtimeTypes';
import type { KubePod } from './snapshotTypes';
import { useDocumentVisible } from './useKubeSnapshots';
import type { Workers } from './workerContext';
import {
  readWorkerPrefs,
  withConsent,
  withPinToggled,
  withWatch,
  withoutWatch,
  writeWorkerPrefs,
  type WorkerPrefs,
} from './workerPrefs';
import {
  WATCH_CONCURRENCY,
  dueTasks,
  nextTaskIn,
  taskFinished,
  taskStarted,
  watchTargets,
  type WorkerSchedule,
  type WorkerTask,
} from './workerSchedule';
import {
  applyMetricRead,
  applyProbeRead,
  emptyPodState,
  podStateKey,
  selectorName,
  summarize,
  workerCells,
  type PodWatchState,
  type WorkerWatch,
} from './workers';

const IDLE_WAKE = 1000;
const MIN_WAKE = 250;

type Outcome = {
  apply: (state: PodWatchState, at: number) => PodWatchState;
  elapsedMs: number;
  state: KubeState;
};

const failedOutcome = (task: WorkerTask, message: string): Outcome => ({
  apply: (state) =>
    task.kind === 'metrics' ? { ...state, metricNote: message } : { ...state, probeNote: message },
  elapsedMs: 0,
  state: { kind: 'unknown', message },
});

async function readTask(id: string, kube: KubeSettings, task: WorkerTask): Promise<Outcome> {
  const { watch, namespace, pod } = task;
  try {
    if (task.kind === 'metrics' && watch.metrics) {
      const { port, path, https, roles } = watch.metrics;
      const only = [...new Set(Object.values(roles).map(selectorName))];
      const read = await call<MetricsRead>('kube_metrics', {
        id,
        kube,
        target: { kind: 'pod', namespace, pod, port, path, https, only },
      });
      return {
        apply: (state, at) => applyMetricRead(state, read, watch, at),
        elapsedMs: read.elapsedMs,
        state: read.state,
      };
    }
    const read = await call<ProbeRead>('kube_probe', {
      id,
      kube,
      target: { namespace, pod },
      container: watch.probe?.container ?? '',
    });
    return {
      apply: (state, at) => applyProbeRead(state, read, at),
      elapsedMs: read.kind === 'ready' ? read.elapsedMs : 0,
      state: read.kind === 'blocked' ? read.state : { kind: 'ready' },
    };
  } catch (error) {
    return failedOutcome(task, errorText(error));
  }
}

/** Reads what is being watched while the workspace is on screen, four at a time. */
export function useWorkerWatch(
  id: string,
  kube: KubeSettings | null,
  shown: boolean,
  pods: KubePod[] | null,
  session: string,
): Workers {
  const [prefs, setPrefs] = useState<WorkerPrefs>(() => readWorkerPrefs(session));
  const [states, setStates] = useState<Record<string, PodWatchState>>({});
  const documentVisible = useDocumentVisible();
  const polling = shown && documentVisible && kube !== null;
  const schedule = useRef<WorkerSchedule>({});
  const pump = useRef<(() => void) | null>(null);

  useEffect(() => writeWorkerPrefs(session, prefs), [session, prefs]);

  const targets = useMemo(() => watchTargets(prefs.watches, pods ?? []), [prefs.watches, pods]);
  const latest = useRef(targets);
  useLayoutEffect(() => {
    latest.current = targets;
    const live = new Set(targets.tasks.map((task) => task.id));
    schedule.current = Object.fromEntries(
      Object.entries(schedule.current).filter(
        ([taskId, entry]) => live.has(taskId) || entry.inFlight,
      ),
    );
    pump.current?.();
  }, [targets]);

  useEffect(() => {
    if (!polling || !kube) return;
    let timer: number | undefined;
    const run = () => {
      window.clearTimeout(timer);
      const { tasks } = latest.current;
      for (const task of dueTasks(tasks, schedule.current, Date.now(), WATCH_CONCURRENCY)) {
        schedule.current = taskStarted(schedule.current, task.id);
        void readTask(id, kube, task).then((outcome) => {
          const now = Date.now();
          schedule.current = taskFinished(
            schedule.current,
            task,
            now,
            outcome.elapsedMs,
            outcome.state,
          );
          const key = podStateKey(task.namespace, task.pod);
          setStates((all) => ({ ...all, [key]: outcome.apply(all[key] ?? emptyPodState(), now) }));
          pump.current?.();
        });
      }
      const wait = nextTaskIn(tasks, schedule.current, Date.now());
      timer = window.setTimeout(run, wait === null ? IDLE_WAKE : Math.max(MIN_WAKE, wait));
    };
    pump.current = run;
    run();
    return () => {
      pump.current = null;
      window.clearTimeout(timer);
    };
  }, [id, kube, polling]);

  const summaries = useMemo(
    () =>
      prefs.watches.map((watch) =>
        summarize(watch, targets.podsByWatch.get(watch.key) ?? [], states),
      ),
    [prefs.watches, targets, states],
  );
  const cells = useMemo(() => workerCells(summaries), [summaries]);

  const setWatch = useCallback(
    (watch: WorkerWatch) => setPrefs((now) => withWatch(now, watch)),
    [],
  );
  const removeWatch = useCallback((key: string) => setPrefs((now) => withoutWatch(now, key)), []);
  const togglePin = useCallback(
    (key: string, selector: string) => setPrefs((now) => withPinToggled(now, key, selector)),
    [],
  );
  const grantConsent = useCallback((key: string) => setPrefs((now) => withConsent(now, key)), []);

  return useMemo(
    () => ({
      summaries,
      cells,
      capped: targets.capped,
      watchOf: (key) => prefs.watches.find((watch) => watch.key === key) ?? null,
      setWatch,
      removeWatch,
      pinsOf: (key) => prefs.pins[key] ?? [],
      togglePin,
      hasConsent: (key) => prefs.consent.includes(key),
      grantConsent,
    }),
    [summaries, cells, targets.capped, prefs, setWatch, removeWatch, togglePin, grantConsent],
  );
}
