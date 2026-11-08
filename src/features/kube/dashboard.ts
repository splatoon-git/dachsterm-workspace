import type { KubeState } from './kubeModel';
import { snapshotKinds, stateNote, type SnapshotStore } from './polling';
import type { DashboardHistory } from './dashboardHistory';
import { recentWarnings, type WarningRow } from './dashboardWarnings';
import type { ContainerState, KubePod, KubeWorkload } from './snapshotTypes';
import { nodeSection, type NodeSection } from './tree';
import { podViews, severity, worse, type Health, type PodView } from './treePods';
import type { TreeTarget } from './treeReveal';

/** Long lists stop here and say how many are left; the tree still has every row. */
export const LIST_LIMIT = 30;
export const TOP_LIMIT = 10;

/**
 * One area's data. `missing` has its reason because an empty area must never read as "no problem"
 * when the account simply may not see it.
 */
export type Part<T> =
  { state: 'ready'; value: T } | { state: 'waiting' } | { state: 'missing'; reason: string };

function part<D, T>(
  entry: { data: D | null; state: KubeState | null },
  build: (data: D) => T,
): Part<T> {
  if (entry.data !== null) return { state: 'ready', value: build(entry.data) };
  if (entry.state && entry.state.kind !== 'ready')
    return { state: 'missing', reason: stateNote(entry.state) };
  return { state: 'waiting' };
}

export type Capped<T> = { items: T[]; more: number };
const capped = <T>(items: T[], limit = LIST_LIMIT): Capped<T> => ({
  items: items.slice(0, limit),
  more: Math.max(0, items.length - limit),
});

export type Amount = {
  /** `null` without metrics-server. */
  used: number | null;
  /** `null` until the pods are known. */
  requested: number | null;
  allocatable: number | null;
};

export type NodeBar = {
  name: string;
  status: string;
  health: Health;
  cpu: Amount;
  memory: Amount;
};

export type Resources = { cpu: Amount; memory: Amount; nodes: Capped<NodeBar> };

/** The scheduler holds room for what is placed on a node and has not finished. */
const holdsRequests = (pod: KubePod) =>
  !!pod.node && pod.phase !== 'Succeeded' && pod.phase !== 'Failed';

const sumOf = (values: (number | null)[]) =>
  values.some((value) => value !== null)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0)
    : null;

const totalAmount = (amounts: Amount[]): Amount => ({
  used: sumOf(amounts.map((a) => a.used)),
  requested: sumOf(amounts.map((a) => a.requested)),
  allocatable: sumOf(amounts.map((a) => a.allocatable)),
});

export const share = (value: number | null, total: number | null) =>
  value === null || !total ? null : Math.round((value / total) * 100);

export function resources(section: NodeSection, pods: KubePod[] | null): Resources {
  const requested = new Map<string, { cpu: number; memory: number }>();
  for (const pod of pods ?? []) {
    if (!holdsRequests(pod)) continue;
    const held = requested.get(pod.node) ?? { cpu: 0, memory: 0 };
    held.cpu += pod.cpuRequest ?? 0;
    held.memory += pod.memoryRequest ?? 0;
    requested.set(pod.node, held);
  }
  const bars = section.nodes.map((view): NodeBar => {
    const held = requested.get(view.node.name) ?? { cpu: 0, memory: 0 };
    return {
      name: view.node.name,
      status: view.status,
      health: view.health,
      cpu: {
        used: view.cpu,
        requested: pods ? held.cpu : null,
        allocatable: view.node.cpuAllocatable,
      },
      memory: {
        used: view.memory,
        requested: pods ? held.memory : null,
        allocatable: view.node.memoryAllocatable,
      },
    };
  });
  const fullness = (bar: NodeBar) =>
    share(bar.cpu.used ?? bar.cpu.requested, bar.cpu.allocatable) ?? 0;
  const ordered = [...bars].sort(
    (a, b) =>
      severity[b.health] - severity[a.health] ||
      fullness(b) - fullness(a) ||
      a.name.localeCompare(b.name),
  );
  return {
    cpu: totalAmount(bars.map((bar) => bar.cpu)),
    memory: totalAmount(bars.map((bar) => bar.memory)),
    nodes: capped(ordered),
  };
}

export type PodCounts = {
  total: number;
  statuses: { status: string; count: number; health: Health }[];
};

export function podCounts(views: PodView[]): PodCounts {
  const counts = new Map<string, { count: number; health: Health }>();
  for (const view of views) {
    const now = counts.get(view.status) ?? { count: 0, health: 'ok' as Health };
    counts.set(view.status, { count: now.count + 1, health: worse(now.health, view.health) });
  }
  return {
    total: views.length,
    statuses: [...counts]
      .map(([status, value]) => ({ status, ...value }))
      .sort(
        (a, b) =>
          severity[b.health] - severity[a.health] ||
          b.count - a.count ||
          a.status.localeCompare(b.status),
      ),
  };
}

export type WorkloadCount = { kind: string; ready: number; total: number };

export function workloadCounts(workloads: KubeWorkload[]): WorkloadCount[] {
  const counts = new Map<string, WorkloadCount>();
  for (const workload of workloads) {
    const now = counts.get(workload.kind) ?? { kind: workload.kind, ready: 0, total: 0 };
    now.total += 1;
    if (workload.ready >= workload.desired) now.ready += 1;
    counts.set(workload.kind, now);
  }
  return [...counts.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

export type TroubleRow = {
  key: string;
  target: TreeTarget;
  namespace: string;
  name: string;
  health: Health;
  status: string;
  /** Why the newest restart happened, such as `OOMKilled (종료 코드 137)`. */
  reason: string;
  /** The status and the reason on one line, without saying the same word twice. */
  detail: string;
  restarts: number;
  /** Restarts since this tab first saw the pod. */
  increase: number;
  lastAt: number | null;
};

const finishedAt = (container: ContainerState) => {
  const time = Date.parse(container.lastFinished);
  return Number.isFinite(time) ? time : null;
};

function stopText(container: ContainerState, named: boolean) {
  const code = container.lastExitCode === null ? '' : `종료 코드 ${container.lastExitCode}`;
  const text =
    container.lastReason && code
      ? `${container.lastReason} (${code})`
      : container.lastReason || code;
  return text && named ? `${container.name}: ${text}` : text;
}

/** The container that stopped most recently speaks for the pod. */
function lastStop(pod: KubePod) {
  const stopped = pod.containers.filter((c) => c.lastReason || c.lastExitCode !== null);
  const newest = stopped.reduce<ContainerState | null>(
    (best, c) => (best === null || (finishedAt(c) ?? 0) > (finishedAt(best) ?? 0) ? c : best),
    null,
  );
  return {
    reason: newest ? stopText(newest, pod.containers.length > 1) : '',
    at: newest && finishedAt(newest),
  };
}

/** The same pods as the tree's "problems only", plus any that restarted since the tab opened. */
export function troubles(views: PodView[], base: ReadonlyMap<string, number>): TroubleRow[] {
  return views
    .map((view) => ({
      view,
      increase: Math.max(0, view.restarts - (base.get(view.key) ?? view.restarts)),
    }))
    .filter(({ view, increase }) => view.problem || increase > 0)
    .map(({ view, increase }): TroubleRow => {
      const { pod } = view;
      const stop = lastStop(pod);
      return {
        key: view.key,
        target: { type: 'pod', namespace: pod.namespace, name: pod.name },
        namespace: pod.namespace,
        name: pod.name,
        // A healthy pod is on this list because it restarted, which is worth a warning mark.
        health: worse(view.health, 'warn'),
        status: view.status,
        reason: stop.reason,
        detail:
          stop.reason && !stop.reason.includes(view.status)
            ? `${view.status} · ${stop.reason}`
            : stop.reason || view.status,
        restarts: view.restarts,
        increase,
        lastAt: stop.at,
      };
    })
    .sort(
      (a, b) =>
        severity[b.health] - severity[a.health] ||
        (b.lastAt ?? 0) - (a.lastAt ?? 0) ||
        a.name.localeCompare(b.name),
    );
}

export type TopRow = {
  key: string;
  target: TreeTarget;
  namespace: string;
  name: string;
  value: number;
  limit: number | null;
  /** Percent of the limit. Above 100 is possible for CPU. */
  ofLimit: number | null;
};

export type TopList = { basis: 'usage' | 'request'; cpu: TopRow[]; memory: TopRow[] };

function topBy(
  views: PodView[],
  value: (view: PodView) => number | null,
  limit: (pod: KubePod) => number | null,
): TopRow[] {
  return views
    .map((view) => ({ view, amount: value(view) }))
    .filter((item): item is { view: PodView; amount: number } => (item.amount ?? 0) > 0)
    .sort((a, b) => b.amount - a.amount || a.view.pod.name.localeCompare(b.view.pod.name))
    .slice(0, TOP_LIMIT)
    .map(({ view, amount }) => ({
      key: view.key,
      target: { type: 'pod', namespace: view.pod.namespace, name: view.pod.name },
      namespace: view.pod.namespace,
      name: view.pod.name,
      value: amount,
      limit: limit(view.pod),
      ofLimit: share(amount, limit(view.pod)),
    }));
}

/** Without `top pods` the largest requests are the next best answer, and the screen says so. */
export function topConsumers(views: PodView[], metrics: boolean): TopList {
  return {
    basis: metrics ? 'usage' : 'request',
    cpu: topBy(
      views,
      (v) => (metrics ? v.cpu : v.pod.cpuRequest),
      (pod) => pod.cpuLimit,
    ),
    memory: topBy(
      views,
      (v) => (metrics ? v.memory : v.pod.memoryRequest),
      (pod) => pod.memoryLimit,
    ),
  };
}

export type UnderRow = {
  key: string;
  target: TreeTarget;
  kind: string;
  namespace: string;
  name: string;
  ready: number;
  desired: number;
};

export function underReady(workloads: KubeWorkload[]): UnderRow[] {
  return workloads
    .filter((workload) => workload.ready < workload.desired)
    .sort(
      (a, b) =>
        b.desired - b.ready - (a.desired - a.ready) ||
        a.namespace.localeCompare(b.namespace) ||
        a.name.localeCompare(b.name),
    )
    .map((workload) => ({
      key: `${workload.kind}/${workload.namespace}/${workload.name}`,
      target: {
        type: 'workload',
        kind: workload.kind,
        namespace: workload.namespace,
        name: workload.name,
      },
      kind: workload.kind,
      namespace: workload.namespace,
      name: workload.name,
      ready: workload.ready,
      desired: workload.desired,
    }));
}

/** Set when some kind kept old data after a failed poll; the screen must not pass it off as new. */
export function staleNote(store: SnapshotStore) {
  for (const kind of snapshotKinds) {
    const { data, state } = store[kind];
    if (data !== null && state && state.kind !== 'ready') return stateNote(state);
  }
  return '';
}

function usageNote(store: SnapshotStore) {
  const { data, state } = store.nodeUsage;
  if (data !== null || !state || state.kind === 'ready') return '';
  if (state.kind === 'metricsMissing')
    return 'metrics-server가 없어 사용량 대신 요청량과 할당 가능량을 표시합니다.';
  return `사용량을 읽지 못했습니다: ${stateNote(state)}`;
}

export type Dashboard = {
  /** When the pods were collected, so relative times do not change between polls. */
  now: number;
  stale: string;
  usageNote: string;
  resources: Part<Resources>;
  nodes: Part<{ ready: number; total: number }>;
  pods: Part<PodCounts>;
  workloads: Part<WorkloadCount[]>;
  troubles: Part<Capped<TroubleRow>>;
  top: Part<TopList>;
  under: Part<Capped<UnderRow>>;
  warnings: Part<Capped<WarningRow>>;
  warningsNow: number;
};

const noNodes: NodeSection = { ready: 0, total: 0, health: 'ok', nodes: [] };

export function buildDashboard(store: SnapshotStore, history: DashboardHistory): Dashboard {
  const { pods, podUsage, services, nodes, nodeUsage, workloads, events } = store;
  const now = pods.collectedAt ?? 0;
  const views = pods.data && podViews(pods.data, podUsage.data ?? [], services.data ?? [], now);
  const entryOfViews = { data: views, state: pods.state };
  const section = {
    data: nodes.data && (nodeSection(nodes.data, nodeUsage.data ?? [], views ?? []) ?? noNodes),
    state: nodes.state,
  };
  const warningsNow = events.collectedAt ?? now;
  return {
    now,
    stale: staleNote(store),
    usageNote: usageNote(store),
    resources: part(section, (value) => resources(value, pods.data)),
    nodes: part(section, ({ ready, total }) => ({ ready, total })),
    pods: part(entryOfViews, podCounts),
    workloads: part(workloads, workloadCounts),
    troubles: part(entryOfViews, (value) => capped(troubles(value, history.restartBase))),
    top: part(entryOfViews, (value) => topConsumers(value, podUsage.data !== null)),
    under: part(workloads, (value) => capped(underReady(value))),
    warnings: part(events, (value) => capped(recentWarnings(value, warningsNow))),
    warningsNow,
  };
}
