import type {
  HostTraffic,
  IngressController,
  IngressReport,
  KubeIngress,
  IngressRule,
  Traffic,
} from './ingressTypes';
import type { KubeState } from './kubeModel';
import { stateNote, type SnapshotStore } from './polling';
import type { KubePod } from './snapshotTypes';
import { selects, worse, type Health } from './treePods';
import type { TreeTarget } from './treeReveal';

export const INGRESS_POLL_MS = 30_000;

const READY: KubeState = { kind: 'ready' };

/** Percentages of the requests in `basis`: the last poll's interval, or everything so far. */
export type HostRate = {
  /** `null` until a second sample exists to compare with. */
  perSecond: number | null;
  ok: number | null;
  clientError: number | null;
  serverError: number | null;
  latencyMs: number | null;
  basis: 'recent' | 'total' | 'none';
};

type TrafficSample = { at: number; read: number; hosts: Record<string, HostTraffic> };

export type IngressData = {
  state: KubeState | null;
  ingresses: KubeIngress[] | null;
  servicesState: KubeState;
  secretsState: KubeState;
  controllers: IngressController[];
  traffic: Traffic;
  /** Why the traffic on screen is from an earlier poll; empty when it is current. */
  trafficNote: string;
  sample: TrafficSample | null;
  rates: Record<string, HostRate>;
  collectedAt: number | null;
};

export const emptyIngress: IngressData = {
  state: null,
  ingresses: null,
  servicesState: READY,
  secretsState: READY,
  controllers: [],
  traffic: { kind: 'notRead' },
  trafficNote: '',
  sample: null,
  rates: {},
  collectedAt: null,
};

/** What a poll that failed in the app, not in kubectl, looks like to the rest of the code. */
export const failedIngress = (message: string): IngressReport => ({
  state: { kind: 'unknown', message },
  ingresses: null,
  servicesState: READY,
  secretsState: READY,
  controllers: [],
  traffic: { kind: 'notRead' },
  collectedAt: Date.now(),
  elapsedMs: 0,
});

const COUNTERS = ['ok', 'redirect', 'clientError', 'serverError', 'other'] as const;
type Counter = (typeof COUNTERS)[number];

const percent = (part: number, whole: number) => Math.round((part / whole) * 100);

function ratios(amount: (key: Counter) => number) {
  const total = COUNTERS.reduce((sum, key) => sum + amount(key), 0);
  if (total === 0) return null;
  return {
    total,
    ok: percent(amount('ok'), total),
    clientError: percent(amount('clientError'), total),
    serverError: percent(amount('serverError'), total),
  };
}

const latency = (sum: number, count: number) => (count > 0 ? (sum / count) * 1000 : null);

/** Counters only go up, so one that went down is a controller that restarted: a new baseline. */
function hostRate(now: HostTraffic, before: HostTraffic | undefined, seconds: number | null) {
  const change = (key: Counter | 'durationSum' | 'durationCount') =>
    now[key] - (before?.[key] ?? 0);
  const comparable =
    before !== undefined &&
    seconds !== null &&
    seconds > 0 &&
    COUNTERS.every((key) => change(key) >= 0) &&
    change('durationCount') >= 0;
  if (comparable) {
    const recent = ratios(change);
    if (recent)
      return {
        perSecond: recent.total / seconds,
        ok: recent.ok,
        clientError: recent.clientError,
        serverError: recent.serverError,
        latencyMs: latency(change('durationSum'), change('durationCount')),
        basis: 'recent',
      } satisfies HostRate;
  }
  const total = ratios((key) => now[key]);
  return {
    perSecond: comparable ? 0 : null,
    ok: total?.ok ?? null,
    clientError: total?.clientError ?? null,
    serverError: total?.serverError ?? null,
    latencyMs: latency(now.durationSum, now.durationCount),
    basis: total ? 'total' : 'none',
  } satisfies HostRate;
}

function advanceTraffic(data: IngressData, report: IngressReport): IngressData {
  const { traffic } = report;
  if (traffic.kind === 'ready') {
    const hosts = Object.fromEntries(traffic.hosts.map((host) => [host.host, host]));
    // A different set of controllers answering is not a change in traffic.
    const before = data.sample?.read === traffic.read ? data.sample : null;
    const seconds = before ? (report.collectedAt - before.at) / 1000 : null;
    return {
      ...data,
      traffic,
      trafficNote: '',
      sample: { at: report.collectedAt, read: traffic.read, hosts },
      rates: Object.fromEntries(
        traffic.hosts.map((host) => [host.host, hostRate(host, before?.hosts[host.host], seconds)]),
      ),
    };
  }
  // A busy connection or a slow proxy says nothing about the traffic already on screen.
  if (traffic.kind === 'failed' && data.traffic.kind === 'ready')
    return { ...data, trafficNote: stateNote(traffic.state) };
  if (traffic.kind === 'notRead') return data;
  return { ...data, traffic, trafficNote: '', sample: null, rates: {} };
}

/** Like the snapshots: a brief failure keeps the last list, and a refusal empties it. */
export function applyIngress(data: IngressData, report: IngressReport): IngressData {
  if (report.state.kind === 'ready' && report.ingresses)
    return advanceTraffic(
      {
        ...data,
        state: READY,
        ingresses: report.ingresses,
        servicesState: report.servicesState,
        secretsState: report.secretsState,
        controllers: report.controllers,
        collectedAt: report.collectedAt,
      },
      report,
    );
  if (report.state.kind === 'forbidden') return { ...emptyIngress, state: report.state };
  return { ...data, state: report.state };
}

export type PathRow = {
  key: string;
  namespace: string;
  ingress: string;
  className: string;
  addresses: string[];
  tls: boolean;
  rule: IngressRule;
  problems: string[];
  health: Health;
};

export type HostGroup = {
  host: string;
  label: string;
  paths: PathRow[];
  problems: string[];
  health: Health;
  rate: HostRate | null;
};

const CATCH_ALL = '(호스트 없음)';

const coversHost = (pattern: string, host: string) =>
  pattern === host ||
  (pattern.startsWith('*.') && host.endsWith(pattern.slice(1)) && host !== pattern.slice(2));

function pathProblems(item: KubeIngress, rule: IngressRule, tls: KubeIngress['tls']) {
  const list: { text: string; health: Health }[] = [];
  if (rule.backend === 'noService')
    list.push({ text: `백엔드 없음: ${rule.service}`, health: 'error' });
  if (rule.backend === 'noReady')
    list.push({ text: `백엔드 준비 0: ${rule.service}`, health: 'error' });
  if (!item.addresses.length) list.push({ text: '주소 미할당', health: 'warn' });
  for (const entry of tls)
    if (entry.missing) list.push({ text: `TLS Secret 없음: ${entry.secret}`, health: 'warn' });
  return list;
}

const unique = (values: string[]) => [...new Set(values)];

/** Hosts in the order they deserve attention: failures first, then by name. */
export function hostGroups(data: IngressData): HostGroup[] {
  const groups = new Map<string, HostGroup>();
  for (const item of data.ingresses ?? []) {
    item.rules.forEach((rule, at) => {
      const tls = item.tls.filter(
        (entry) => !entry.hosts.length || entry.hosts.some((p) => coversHost(p, rule.host)),
      );
      const found = pathProblems(item, rule, tls);
      const row: PathRow = {
        key: `${item.namespace}/${item.name}/${at}`,
        namespace: item.namespace,
        ingress: item.name,
        className: item.className,
        addresses: item.addresses,
        tls: tls.length > 0,
        rule,
        problems: found.map((problem) => problem.text),
        health: found.reduce<Health>((health, problem) => worse(health, problem.health), 'ok'),
      };
      const group = groups.get(rule.host);
      if (group) {
        group.paths.push(row);
        group.problems = unique([...group.problems, ...row.problems]);
        group.health = worse(group.health, row.health);
      } else
        groups.set(rule.host, {
          host: rule.host,
          label: rule.host || CATCH_ALL,
          paths: [row],
          problems: row.problems,
          health: row.health,
          rate: data.rates[rule.host] ?? null,
        });
    });
  }
  const rank: Record<Health, number> = { error: 0, warn: 1, ok: 2 };
  return [...groups.values()].sort(
    (a, b) => rank[a.health] - rank[b.health] || a.label.localeCompare(b.label),
  );
}

export function filterHostGroups(groups: HostGroup[], text: string, problemsOnly: boolean) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = (fields: string[]) => {
    const line = fields.join(' ').toLowerCase();
    return words.every((word) => line.includes(word));
  };
  return groups.flatMap((group) => {
    const paths = group.paths.filter(
      (row) =>
        (!problemsOnly || row.problems.length > 0) &&
        hits([
          group.label,
          row.rule.path,
          row.rule.service,
          row.namespace,
          row.ingress,
          row.className,
          ...row.addresses,
        ]),
    );
    return paths.length ? [{ ...group, paths }] : [];
  });
}

const DASHBOARD_ROWS = 30;

/** What the dashboard's ingress area lists. Only the configuration; traffic is on its own screen. */
export function ingressProblems(groups: HostGroup[]) {
  const items = groups.filter((group) => group.problems.length > 0);
  return {
    items: items.slice(0, DASHBOARD_ROWS),
    more: Math.max(0, items.length - DASHBOARD_ROWS),
  };
}

export function backendPods(row: PathRow, store: SnapshotStore): KubePod[] {
  const service = store.services.data?.find(
    (item) => item.namespace === row.namespace && item.name === row.rule.service,
  );
  if (!service) return [];
  return (store.pods.data ?? []).filter(
    (pod) => pod.namespace === row.namespace && selects(service, pod),
  );
}

const isTroubled = (pod: KubePod) => pod.containers.some((container) => !container.ready);

/** The pod a click goes to: one that is failing, if any. A backend with no pods lands on its namespace. */
export function backendTarget(row: PathRow, store: SnapshotStore): TreeTarget {
  const pods = backendPods(row, store);
  const pod = pods.find(isTroubled) ?? pods[0];
  return pod
    ? { type: 'pod', namespace: pod.namespace, name: pod.name }
    : { type: 'namespace', namespace: row.namespace };
}

/** A wildcard host never appears literally in a log line; its fixed part does. */
export const hostKeyword = (host: string) => host.replace(/^\*\./, '');

/** ingress-nginx names an upstream `namespace-service-port`, and its access log prints that name. */
export const upstreamKeyword = (row: PathRow) =>
  `${row.namespace}-${row.rule.service}-${row.rule.port}`;

/** One line on why traffic is or is not shown. Being turned off is reported, not an error. */
export function trafficNote(data: IngressData): string {
  const { traffic } = data;
  switch (traffic.kind) {
    case 'notRead':
      return '';
    case 'noController':
      return 'ingress-nginx 컨트롤러가 없어 구성 점검만 표시합니다.';
    case 'controllersUnknown':
      return `컨트롤러 파드를 조회하지 못했습니다: ${stateNote(traffic.state)}`;
    case 'off':
      return '컨트롤러 메트릭이 꺼져 있어 구성 점검만 표시합니다. --enable-metrics=true로 켤 수 있습니다.';
    case 'proxyForbidden':
      return 'pods/proxy 권한이 없어 트래픽을 표시하지 못합니다.';
    case 'failed':
      return `컨트롤러 메트릭을 읽지 못했습니다: ${stateNote(traffic.state)}`;
    case 'ready':
      if (data.trafficNote) return `지난 조회의 트래픽입니다: ${data.trafficNote}`;
      return traffic.read < traffic.controllers
        ? `컨트롤러 ${traffic.controllers}개 중 ${traffic.read}개만 읽었습니다.`
        : '';
  }
}

/** Why part of the configuration could not be checked. */
export function checkNotes(data: IngressData): string[] {
  const note = (what: string, state: KubeState) =>
    state.kind === 'ready' ? [] : [`${what}: ${stateNote(state)}`];
  return [
    ...note('백엔드를 확인하지 못했습니다', data.servicesState),
    ...note('TLS Secret을 확인하지 못했습니다', data.secretsState),
  ];
}

export const formatRate = (perSecond: number | null) =>
  perSecond === null ? '-' : perSecond < 10 ? perSecond.toFixed(1) : perSecond.toFixed(0);

export const formatShare = (value: number | null) => (value === null ? '-' : `${value}%`);

export const formatLatency = (ms: number | null) =>
  ms === null ? '-' : ms < 1000 ? `${ms.toFixed(ms < 10 ? 1 : 0)}ms` : `${(ms / 1000).toFixed(2)}s`;
