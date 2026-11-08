import type { ContainerState, KubePod, KubePodUsage, KubeService } from './snapshotTypes';

export type Health = 'ok' | 'warn' | 'error';
export const severity: Record<Health, number> = { ok: 0, warn: 1, error: 2 };
export const worse = (a: Health, b: Health) => (severity[b] > severity[a] ? b : a);

const ONE_HOUR = 3_600_000;

/** The STATUS column kubectl would print, from the same fields. */
export function podStatus(pod: KubePod): string {
  if (pod.deleting) return 'Terminating';
  if (pod.reason) return pod.reason;
  const failed = (c: ContainerState) => c.terminated && c.terminated !== 'Completed';
  const pendingInit = pod.initContainers.findIndex((c) => !c.ready);
  if (pendingInit >= 0) {
    const init = pod.initContainers[pendingInit];
    if (init.waiting) return `Init:${init.waiting}`;
    if (failed(init)) return `Init:${init.terminated}`;
    return `Init:${pendingInit}/${pod.initContainers.length}`;
  }
  const stuck = pod.containers.find((c) => c.waiting || failed(c));
  if (stuck) return stuck.waiting || stuck.terminated;
  return pod.phase === 'Succeeded' ? 'Completed' : pod.phase;
}

function healthOf(status: string, ready: number, total: number): Health {
  if (status === 'Completed') return 'ok';
  if (status === 'Running') return ready === total ? 'ok' : 'warn';
  const passing =
    ['Pending', 'ContainerCreating', 'PodInitializing', 'Terminating'].includes(status) ||
    /^Init:\d+\/\d+$/.test(status);
  return passing ? 'warn' : 'error';
}

export type PodView = {
  key: string;
  pod: KubePod;
  status: string;
  health: Health;
  ready: number;
  total: number;
  restarts: number;
  /** The newest restart is less than an hour old. */
  recentRestart: boolean;
  oom: boolean;
  /** Abnormal, restarted in the last hour, or killed for memory: what "문제만" keeps. */
  problem: boolean;
  cpu: number | null;
  memory: number | null;
  services: KubeService[];
  search: string;
};

const podKey = (namespace: string, name: string) => `${namespace}/${name}`;

function selects(service: KubeService, pod: KubePod) {
  const wanted = Object.entries(service.selector);
  return wanted.length > 0 && wanted.every(([key, value]) => pod.labels[key] === value);
}

/** `now` is when the pods were collected, so ages do not change between polls. */
export function podViews(
  pods: KubePod[],
  usage: KubePodUsage[],
  services: KubeService[],
  now: number,
): PodView[] {
  const used = new Map(usage.map((item) => [podKey(item.namespace, item.name), item]));
  const byNamespace = new Map<string, KubeService[]>();
  for (const service of services) {
    const list = byNamespace.get(service.namespace);
    if (list) list.push(service);
    else byNamespace.set(service.namespace, [service]);
  }
  return pods.map((pod) => {
    const key = podKey(pod.namespace, pod.name);
    const status = podStatus(pod);
    const ready = pod.containers.filter((c) => c.ready).length;
    const total = pod.containerCount;
    const health = healthOf(status, ready, total);
    const recentRestart = pod.containers.some((c) => {
      const finished = Date.parse(c.lastFinished);
      return c.restarts > 0 && Number.isFinite(finished) && now - finished < ONE_HOUR;
    });
    const oom = pod.containers.some(
      (c) => c.lastReason === 'OOMKilled' || c.terminated === 'OOMKilled',
    );
    const members = (byNamespace.get(pod.namespace) ?? []).filter((s) => selects(s, pod));
    const usageOf = used.get(key);
    return {
      key,
      pod,
      status,
      health,
      ready,
      total,
      restarts: pod.containers.reduce((sum, c) => sum + c.restarts, 0),
      recentRestart,
      oom,
      problem: health !== 'ok' || recentRestart || oom,
      cpu: usageOf?.cpu ?? null,
      memory: usageOf?.memory ?? null,
      services: members,
      search: [
        pod.namespace,
        pod.name,
        pod.node,
        status,
        pod.ownerName,
        ...members.map((s) => s.name),
        ...Object.values(pod.labels),
      ]
        .join(' ')
        .toLowerCase(),
    };
  });
}

export type Filter = { include: string[]; exclude: string[]; problemsOnly: boolean };

/** Spaces are AND and `!word` excludes. A lone `!` while typing excludes nothing. */
export function parseFilter(text: string, problemsOnly: boolean): Filter {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return {
    include: words.filter((word) => !word.startsWith('!')),
    exclude: words.filter((word) => word.startsWith('!') && word.length > 1).map((w) => w.slice(1)),
    problemsOnly,
  };
}

export const filterActive = (filter: Filter) =>
  filter.problemsOnly || filter.include.length > 0 || filter.exclude.length > 0;

export const matches = (view: PodView, filter: Filter) =>
  (!filter.problemsOnly || view.problem) &&
  filter.include.every((word) => view.search.includes(word)) &&
  !filter.exclude.some((word) => view.search.includes(word));

export type Totals = {
  health: Health;
  ready: number;
  total: number;
  restarts: number;
  recentRestart: boolean;
  cpu: number | null;
  memory: number | null;
  cpuRequest: number | null;
  memoryRequest: number | null;
  cpuLimit: number | null;
  memoryLimit: number | null;
};

const plus = (sum: number | null, value: number | null) =>
  value === null ? sum : (sum ?? 0) + value;

export function totalsOf(views: Iterable<PodView>): Totals {
  const totals: Totals = {
    health: 'ok',
    ready: 0,
    total: 0,
    restarts: 0,
    recentRestart: false,
    cpu: null,
    memory: null,
    cpuRequest: null,
    memoryRequest: null,
    cpuLimit: null,
    memoryLimit: null,
  };
  for (const view of views) {
    totals.health = worse(totals.health, view.health);
    totals.ready += view.ready;
    totals.total += view.total;
    totals.restarts += view.restarts;
    totals.recentRestart ||= view.recentRestart;
    totals.cpu = plus(totals.cpu, view.cpu);
    totals.memory = plus(totals.memory, view.memory);
    totals.cpuRequest = plus(totals.cpuRequest, view.pod.cpuRequest);
    totals.memoryRequest = plus(totals.memoryRequest, view.pod.memoryRequest);
    totals.cpuLimit = plus(totals.cpuLimit, view.pod.cpuLimit);
    totals.memoryLimit = plus(totals.memoryLimit, view.pod.memoryLimit);
  }
  return totals;
}
