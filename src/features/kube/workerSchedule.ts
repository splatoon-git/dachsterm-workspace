import type { KubeState } from './kubeModel';
import type { KubePod } from './snapshotTypes';
import { ownerOf } from './tree';
import { watchKeyOf, type WorkerWatch } from './workers';

export const MAX_WATCHED_PODS = 50;
export const WATCH_CONCURRENCY = 4;
const METRICS_PERIOD = 15_000;
/** Design KV.9: a probe is an `exec` in a production pod, so it never repeats faster than this. */
const PROBE_PERIOD = 30_000;
const SLOW_FACTOR = 3;
const LIMIT_FACTOR = 4;
const MAX_BACKOFF = 120_000;

export type TaskKind = 'metrics' | 'probe';
export type WorkerTask = {
  id: string;
  kind: TaskKind;
  watch: WorkerWatch;
  namespace: string;
  pod: string;
};

/**
 * The pod list the tree already polls says which pods to read, so watching adds no list query.
 * The limit is on pods across all watches, in the order the watches were turned on.
 */
export function watchTargets(watches: WorkerWatch[], pods: KubePod[]) {
  const running = new Map<string, string[]>();
  for (const pod of pods) {
    const owner = ownerOf(pod);
    if (!owner || pod.phase !== 'Running' || pod.deleting) continue;
    const key = watchKeyOf(pod.namespace, owner.kind, owner.name);
    running.set(key, [...(running.get(key) ?? []), pod.name]);
  }
  const tasks: WorkerTask[] = [];
  const podsByWatch = new Map<string, string[]>();
  let counted = 0;
  let capped = 0;
  for (const watch of watches) {
    const names = running.get(watch.key) ?? [];
    const allowed = names.slice(0, Math.max(0, MAX_WATCHED_PODS - counted));
    capped += names.length - allowed.length;
    counted += allowed.length;
    podsByWatch.set(watch.key, allowed);
    for (const pod of allowed) {
      const base = `${watch.key}/${pod}`;
      if (watch.metrics)
        tasks.push({
          id: `${base}/metrics`,
          kind: 'metrics',
          watch,
          namespace: watch.namespace,
          pod,
        });
      if (watch.probe)
        tasks.push({ id: `${base}/probe`, kind: 'probe', watch, namespace: watch.namespace, pod });
    }
  }
  return { tasks, podsByWatch, capped };
}

type TaskSchedule = { inFlight: boolean; nextAt: number };
export type WorkerSchedule = Record<string, TaskSchedule>;

/** At most `limit` running in all, and one per task (rules §7). */
export function dueTasks(
  tasks: WorkerTask[],
  schedule: WorkerSchedule,
  now: number,
  limit: number,
) {
  const running = Object.values(schedule).filter((item) => item.inFlight).length;
  return tasks
    .filter((task) => {
      const entry = schedule[task.id];
      return !entry || (!entry.inFlight && entry.nextAt <= now);
    })
    .slice(0, Math.max(0, limit - running));
}

export const taskStarted = (schedule: WorkerSchedule, id: string): WorkerSchedule => ({
  ...schedule,
  [id]: { inFlight: true, nextAt: schedule[id]?.nextAt ?? 0 },
});

export function taskDelay(kind: TaskKind, elapsedMs: number, state: KubeState) {
  const base = kind === 'metrics' ? METRICS_PERIOD : PROBE_PERIOD;
  const period = Math.max(base, elapsedMs * SLOW_FACTOR);
  if (state.kind === 'timedOut' || state.kind === 'tooLarge')
    return Math.min(MAX_BACKOFF, Math.max(period, base * LIMIT_FACTOR));
  return period;
}

export const taskFinished = (
  schedule: WorkerSchedule,
  task: WorkerTask,
  now: number,
  elapsedMs: number,
  state: KubeState,
): WorkerSchedule => ({
  ...schedule,
  [task.id]: { inFlight: false, nextAt: now + taskDelay(task.kind, elapsedMs, state) },
});

/** Milliseconds until a task is due, `null` when there is nothing to wait for. */
export function nextTaskIn(tasks: WorkerTask[], schedule: WorkerSchedule, now: number) {
  const waiting = tasks.filter((task) => !schedule[task.id]?.inFlight);
  if (!waiting.length) return null;
  return Math.max(0, Math.min(...waiting.map((task) => schedule[task.id]?.nextAt ?? 0)) - now);
}
