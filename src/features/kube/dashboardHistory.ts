import type { SnapshotStore } from './polling';
import type { KubePod } from './snapshotTypes';

export const TREND_SAMPLES = 120;

export type TrendSample = { at: number; cpu: number | null; memory: number | null };

/** What the snapshots alone cannot tell: kept in memory while the tab is open and never saved. */
export type DashboardHistory = {
  podsAt: number | null;
  usageAt: number | null;
  /** Each pod's restart total when it was first seen, for "how many since this tab opened". */
  restartBase: ReadonlyMap<string, number>;
  trend: TrendSample[];
};

export const emptyHistory = (): DashboardHistory => ({
  podsAt: null,
  usageAt: null,
  restartBase: new Map(),
  trend: [],
});

const podRestarts = (pod: KubePod) => pod.containers.reduce((sum, c) => sum + c.restarts, 0);

/**
 * Restarts before the first snapshot are history. A pod that appears later started after the tab
 * opened, so all of its restarts count. A lower total than before is a new pod under the same name.
 */
function nextBase(previous: DashboardHistory, pods: KubePod[]) {
  const first = previous.podsAt === null;
  const base = new Map<string, number>();
  for (const pod of pods) {
    const key = `${pod.namespace}/${pod.name}`;
    const restarts = podRestarts(pod);
    const known = previous.restartBase.get(key);
    if (known === undefined) base.set(key, first ? restarts : 0);
    else base.set(key, restarts < known ? 0 : known);
  }
  return base;
}

const percentOf = (value: number, total: number) => (total > 0 ? (value / total) * 100 : null);

function nextTrend(trend: TrendSample[], store: SnapshotStore, at: number) {
  const usage = new Map((store.nodeUsage.data ?? []).map((item) => [item.name, item]));
  const measured = (store.nodes.data ?? []).filter((node) => usage.has(node.name));
  const sum = (pick: (name: string) => number) =>
    measured.reduce((total, node) => total + pick(node.name), 0);
  const allocatable = (key: 'cpuAllocatable' | 'memoryAllocatable') =>
    measured.reduce((total, node) => total + (node[key] ?? 0), 0);
  const sample: TrendSample = {
    at,
    cpu: percentOf(
      sum((name) => usage.get(name)?.cpu ?? 0),
      allocatable('cpuAllocatable'),
    ),
    memory: percentOf(
      sum((name) => usage.get(name)?.memory ?? 0),
      allocatable('memoryAllocatable'),
    ),
  };
  return [...trend, sample].slice(-TREND_SAMPLES);
}

/** Returns the same object when no new data arrived, so a failed poll adds no sample. */
export function advanceHistory(history: DashboardHistory, store: SnapshotStore): DashboardHistory {
  const { pods, nodeUsage, nodes } = store;
  let next = history;
  if (pods.data && pods.collectedAt !== history.podsAt)
    next = { ...next, podsAt: pods.collectedAt, restartBase: nextBase(history, pods.data) };
  if (nodeUsage.data && nodes.data && nodeUsage.collectedAt !== history.usageAt)
    next = {
      ...next,
      usageAt: nodeUsage.collectedAt,
      trend: nextTrend(history.trend, store, nodeUsage.collectedAt ?? 0),
    };
  return next;
}
