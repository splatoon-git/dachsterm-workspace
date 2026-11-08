import type { IngressController } from './ingressTypes';
import type { KubeState } from './kubeModel';
import { stateNote } from './polling';
import type { KubePod, KubeService } from './snapshotTypes';
import { ownerOf } from './tree';
import { selects } from './treePods';
import type { TreeTarget } from './treeReveal';

/** Mirrors `kube/log_search.rs`. */
export type SearchSource = {
  namespace: string;
  pod: string;
  container: string;
  previous: boolean;
};
export type SearchHit = { time: string; text: string; clipped: boolean };
export type SearchOutcome = 'done' | 'cancelled' | 'timedOut' | 'totalLimit';
export type SearchEvent =
  | { type: 'started'; jobs: number; omittedPods: number }
  | { type: 'lines'; source: SearchSource; lines: SearchHit[] }
  | {
      type: 'jobDone';
      source: SearchSource;
      state: KubeState;
      matched: number;
      truncated: boolean;
    }
  | { type: 'narrowed'; concurrency: number }
  | { type: 'finished'; outcome: SearchOutcome; unstarted: number };

export type SearchTarget = {
  namespace: string;
  pod: string;
  containers: string[];
  previous: string[];
};

/** The limits the backend enforces, for telling the user which one a result ran into. */
export const MAX_PODS = 100;
const MAX_LINES_PER_POD = '1,000';
const MAX_LINES_TOTAL = '5,000';

export type SearchRow = SearchHit & SearchSource & { id: number; at: number };
export type SearchFailure = { source: SearchSource; note: string };

export type SearchResult = {
  phase: 'idle' | 'running' | 'finished';
  rows: SearchRow[];
  jobs: number;
  jobsDone: number;
  failures: SearchFailure[];
  truncatedJobs: number;
  omittedPods: number;
  concurrency: number | null;
  outcome: SearchOutcome | null;
  unstarted: number;
};
export const idleSearch: SearchResult = {
  phase: 'idle',
  rows: [],
  jobs: 0,
  jobsDone: 0,
  failures: [],
  truncatedJobs: 0,
  omittedPods: 0,
  concurrency: null,
  outcome: null,
  unstarted: 0,
};

/**
 * The epoch time of a log timestamp. Only three fraction digits are kept, because more than that
 * is outside what `Date.parse` is specified to read and WebKit need not accept nine.
 */
export function logTimeMs(iso: string) {
  const parsed = Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function applySearchEvents(state: SearchResult, events: SearchEvent[]): SearchResult {
  let next = state;
  for (const event of events) {
    switch (event.type) {
      case 'started':
        next = {
          ...idleSearch,
          phase: 'running',
          jobs: event.jobs,
          omittedPods: event.omittedPods,
        };
        break;
      case 'lines': {
        const first = next.rows.length;
        const added = event.lines.map((hit, offset) => ({
          ...hit,
          ...event.source,
          id: first + offset,
          at: logTimeMs(hit.time),
        }));
        next = { ...next, rows: [...next.rows, ...added] };
        break;
      }
      case 'jobDone':
        next = {
          ...next,
          jobsDone: next.jobsDone + 1,
          truncatedJobs: next.truncatedJobs + Number(event.truncated),
          failures:
            event.state.kind === 'ready'
              ? next.failures
              : [...next.failures, { source: event.source, note: stateNote(event.state) }],
        };
        break;
      case 'narrowed':
        next = { ...next, concurrency: event.concurrency };
        break;
      case 'finished':
        next = {
          ...next,
          phase: 'finished',
          outcome: event.outcome,
          unstarted: event.unstarted,
        };
        break;
    }
  }
  return next;
}

export type ScopeKind = 'all' | 'namespace' | 'workload' | 'service' | 'pod' | 'controller';
/**
 * `value` is what the search box shows: `namespace` for a namespace, `namespace/Kind/name` for a
 * workload, and `namespace/name` for a service or a pod.
 */
export type SearchScope = { kind: ScopeKind; value: string };
export const allScope: SearchScope = { kind: 'all', value: '' };
export const scopeKinds: { id: ScopeKind; label: string }[] = [
  { id: 'all', label: '전체' },
  { id: 'namespace', label: 'namespace' },
  { id: 'workload', label: '워크로드' },
  { id: 'service', label: '서비스' },
  { id: 'pod', label: '파드' },
  { id: 'controller', label: '인그레스 컨트롤러' },
];

const workloadValue = (pod: KubePod) => {
  const owner = ownerOf(pod);
  return owner ? `${pod.namespace}/${owner.kind}/${owner.name}` : null;
};
const serviceValue = (service: KubeService) => `${service.namespace}/${service.name}`;
const podValue = (pod: Pick<KubePod, 'namespace' | 'name'>) => `${pod.namespace}/${pod.name}`;

/** What can be typed into the search box for this kind of scope. */
export function scopeOptions(kind: ScopeKind, pods: KubePod[], services: KubeService[]): string[] {
  const values = (() => {
    switch (kind) {
      case 'all':
      case 'controller':
        return [];
      case 'namespace':
        return pods.map((pod) => pod.namespace);
      case 'workload':
        return pods.flatMap((pod) => workloadValue(pod) ?? []);
      case 'service':
        return services.filter((s) => Object.keys(s.selector).length > 0).map(serviceValue);
      case 'pod':
        return pods.map(podValue);
    }
  })();
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/** The pods a scope covers now, from the snapshot the tree already polls. */
export function podsInScope(
  scope: SearchScope,
  pods: KubePod[],
  services: KubeService[],
): KubePod[] {
  switch (scope.kind) {
    case 'all':
      return pods;
    case 'namespace':
      return pods.filter((pod) => pod.namespace === scope.value);
    case 'workload':
      return pods.filter((pod) => workloadValue(pod) === scope.value);
    case 'service': {
      const service = services.find((item) => serviceValue(item) === scope.value);
      return service
        ? pods.filter((pod) => pod.namespace === service.namespace && selects(service, pod))
        : [];
    }
    case 'pod':
      return pods.filter((pod) => podValue(pod) === scope.value);
    // Often outside the session's namespace, so these come from the ingress report instead.
    case 'controller':
      return [];
  }
}

/** The controller's own pods, which the tree may not list when the session has a namespace. */
export const controllerTargets = (controllers: IngressController[]): SearchTarget[] =>
  controllers.map((item) => ({
    namespace: item.namespace,
    pod: item.name,
    containers: [item.container],
    previous: [],
  }));

/** A pod that has not started has no log to read. `previous` is only for what really restarted. */
export function searchTargets(
  pods: KubePod[],
  options: { allContainers: boolean; previous: boolean },
): SearchTarget[] {
  return pods
    .filter((pod) => pod.phase !== 'Pending' && pod.containers.length > 0)
    .map((pod) => {
      const names = pod.containers.map((container) => container.name);
      const containers = options.allContainers
        ? names
        : [names.includes(pod.defaultContainer) ? pod.defaultContainer : names[0]];
      const restarted = pod.containers.filter((c) => c.restarts > 0).map((c) => c.name);
      return {
        namespace: pod.namespace,
        pod: pod.name,
        containers,
        previous: options.previous ? containers.filter((c) => restarted.includes(c)) : [],
      };
    });
}

export const scopeOfTarget = (target: TreeTarget): SearchScope | null => {
  switch (target.type) {
    case 'pod':
      return { kind: 'pod', value: `${target.namespace}/${target.name}` };
    case 'workload':
      return { kind: 'workload', value: `${target.namespace}/${target.kind}/${target.name}` };
    case 'namespace':
      return { kind: 'namespace', value: target.namespace };
    case 'node':
      return null;
  }
};

/** The tree's group ids (`tree.ts`): a namespace, or a workload or service inside one. */
export function scopeOfGroup(id: string): SearchScope | null {
  const found = /^ns:([^/]+)(?:\/(wl|svc):(.+))?$/.exec(id);
  if (!found) return null;
  const [, namespace, type, name] = found;
  if (!type) return { kind: 'namespace', value: namespace };
  return { kind: type === 'wl' ? 'workload' : 'service', value: `${namespace}/${name}` };
}

export type DisplayRow =
  | { type: 'group'; key: string; label: string; count: number }
  | { type: 'line'; key: string; row: SearchRow };

/** By time, or by pod and then time inside each pod. */
export function displayRows(rows: SearchRow[], descending: boolean, byPod: boolean): DisplayRow[] {
  const sign = descending ? -1 : 1;
  const sorted = [...rows].sort((a, b) => sign * (a.at - b.at || a.id - b.id));
  const line = (row: SearchRow): DisplayRow => ({ type: 'line', key: `l${row.id}`, row });
  if (!byPod) return sorted.map(line);
  const groups = new Map<string, SearchRow[]>();
  for (const row of sorted) {
    const key = `${row.namespace}/${row.pod}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([key, group]) => [
      { type: 'group' as const, key: `g${key}`, label: key, count: group.length },
      ...group.map(line),
    ]);
}

const two = (value: number) => String(value).padStart(2, '0');

/** Local time, short enough for a table column. */
export function rowTime(at: number) {
  if (!at) return '';
  const date = new Date(at);
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${milliseconds}`;
}

export const includedWords = (query: string) =>
  query.split(/\s+/).filter((word) => word && !word.startsWith('!'));

/** The pieces of a line, with the searched words marked. */
export function highlightParts(text: string, words: string[]) {
  const escaped = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) return [{ text, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(new RegExp(escaped.join('|'), 'gi'))) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), hit: false });
    parts.push({ text: match[0], hit: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts.length ? parts : [{ text, hit: false }];
}

export const rowText = (row: SearchRow) => `${row.time} ${row.pod} ${row.container} ${row.text}`;

const LOOK_BACK_MS = 60_000;
/** How far back to read for the lines before a hit; the backend stops at its byte limit. */
export const aroundSince = (row: Pick<SearchRow, 'at'>) =>
  new Date(row.at - LOOK_BACK_MS).toISOString();

/** The lines around a hit, from `kube_logs` read with timestamps. `marked` is `-1` if not found. */
export function aroundLines(text: string, row: SearchHit, count: number) {
  const lines = text.split('\n').filter(Boolean);
  const bodyOf = (line: string) => line.slice(line.indexOf(' ') + 1);
  const timeOf = (line: string) => line.slice(0, line.indexOf(' '));
  const isHit = (line: string) =>
    timeOf(line) === row.time &&
    (row.clipped ? bodyOf(line).startsWith(row.text) : bodyOf(line) === row.text);
  const found = lines.findIndex(isHit);
  const center = found >= 0 ? found : lines.findIndex((line) => timeOf(line) >= row.time);
  const at = center >= 0 ? center : Math.max(0, lines.length - 1);
  const first = Math.max(0, at - count);
  const slice = lines.slice(first, at + count + 1).map((line) => ({
    time: timeOf(line),
    text: bodyOf(line),
  }));
  return { lines: slice, marked: found >= 0 ? at - first : -1 };
}

const count = (value: number) => value.toLocaleString('en-US');

/** Everything that says why the results are not the whole answer. Empty means nothing was cut. */
export function truncationNotes(state: SearchResult): string[] {
  const notes: string[] = [];
  if (state.truncatedJobs > 0)
    notes.push(
      `파드 ${count(state.truncatedJobs)}개가 파드당 ${MAX_LINES_PER_POD}줄 상한에 걸렸습니다.`,
    );
  if (state.outcome === 'totalLimit') notes.push(`전체 ${MAX_LINES_TOTAL}줄 상한에 걸렸습니다.`);
  if (state.outcome === 'timedOut') notes.push('전체 시간 60초 상한에 걸렸습니다.');
  if (state.omittedPods > 0)
    notes.push(`파드 ${MAX_PODS}개 상한으로 ${count(state.omittedPods)}개는 검색하지 않았습니다.`);
  if (state.unstarted > 0 && state.outcome !== 'cancelled')
    notes.push(`${count(state.unstarted)}개 대상은 시작하지 못했습니다.`);
  return notes;
}

export function statusText(state: SearchResult) {
  const progress = `${count(state.jobsDone)}/${count(state.jobs)}`;
  const lines = `${count(state.rows.length)}줄`;
  if (state.phase === 'running') return `검색 중 ${progress} · ${lines}`;
  if (state.phase === 'idle') return '';
  if (state.outcome === 'cancelled') return `취소됨 ${progress} · ${lines}`;
  return `검색 완료 ${progress} · ${lines}`;
}

export const failureText = ({ source, note }: SearchFailure) =>
  `${source.pod}/${source.container}${source.previous ? ' (이전 인스턴스)' : ''}: ${note}`;
