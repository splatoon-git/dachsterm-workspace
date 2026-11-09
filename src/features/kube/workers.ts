import { stateNote } from './polling';
import type {
  MetricSeries,
  MetricSource,
  MetricsRead,
  NoMetricsReason,
  ProbeRead,
  Runtime,
} from './runtimeTypes';
import { workloadGroupId } from './tree';

export const DEFAULT_MINUTES = 5;
export const MIN_MINUTES = 1;
export const MAX_MINUTES = 240;
/** A longer hole, such as a hidden tab, means the state in between was not seen. */
const GAP_LIMIT = 150_000;
/** "Keeps rising at every sample": fewer than this is ordinary start-up or a passing burst. */
const RISING_SAMPLES = 5;
const MAX_PROBE_POINTS = 20;

export type MetricRoles = { busy: string; total: string; completed: string };

/** One workload being watched, kept per session. `key` is `namespace/Kind/name`. */
export type WorkerWatch = {
  key: string;
  namespace: string;
  kind: string;
  name: string;
  minutes: number;
  metrics: (MetricSource & { roles: MetricRoles }) | null;
  probe: { container: string } | null;
};

export const watchKeyOf = (namespace: string, kind: string, name: string) =>
  `${namespace}/${kind}/${name}`;

export const seriesSelector = (series: Pick<MetricSeries, 'name' | 'labels'>) =>
  series.labels ? `${series.name}{${series.labels}}` : series.name;

export const selectorName = (selector: string) => selector.split('{', 1)[0];

/** A bare name adds up every series of that name; a selector with labels is one exact series. */
export function selectorValue(series: MetricSeries[], selector: string): number | null {
  if (selector.includes('{')) {
    const found = series.find((item) => seriesSelector(item) === selector);
    return found ? found.value : null;
  }
  const named = series.filter((item) => item.name === selector);
  return named.length ? named.reduce((sum, item) => sum + item.value, 0) : null;
}

export type MetricPoint = {
  at: number;
  busy: number;
  total: number | null;
  completed: number | null;
};

export type ProbePoint = {
  at: number;
  processes: number;
  closeWait: number;
  fds: number;
  threads: number;
};

/** `null` when the pod's answer does not contain the metric chosen for "in use". */
export function metricPoint(
  series: MetricSeries[],
  roles: MetricRoles,
  at: number,
): MetricPoint | null {
  const busy = selectorValue(series, roles.busy);
  if (busy === null) return null;
  return {
    at,
    busy,
    total: selectorValue(series, roles.total),
    completed: selectorValue(series, roles.completed),
  };
}

export function probePoint(runtime: Runtime, at: number): ProbePoint {
  return {
    at,
    processes: runtime.processes.length,
    closeWait: runtime.tcp.closeWait,
    fds: runtime.processes.reduce((sum, item) => sum + (item.fds ?? 0), 0),
    threads: runtime.processes.reduce((sum, item) => sum + item.threads, 0),
  };
}

export type VerdictKind = 'stuck' | 'stalled' | 'saturated' | 'connections' | 'leak';
export type Verdict = { kind: VerdictKind; since: number };

/** Every one says "suspected": metrics alone cannot prove the cause (design KV.9). */
export const verdictLabels: Record<VerdictKind, string> = {
  stuck: '반환 안 됨 의심',
  stalled: '처리 정지 의심',
  saturated: '워커 포화 의심',
  connections: '연결 미반환 의심',
  leak: '누수 의심',
};
const verdictOrder: VerdictKind[] = ['stuck', 'stalled', 'saturated', 'connections', 'leak'];

/** How long `holds` has been true, counting back from the newest point. */
function holdingSince<T extends { at: number }>(
  points: T[],
  holds: (point: T, newest: T) => boolean,
): number | null {
  const newest = points.at(-1);
  if (!newest || !holds(newest, newest)) return null;
  let since = newest.at;
  for (let index = points.length - 2; index >= 0; index--) {
    const point = points[index];
    if (since - point.at > GAP_LIMIT || !holds(point, newest)) break;
    since = point.at;
  }
  return since;
}

/**
 * Busy with nothing moving. vLLM passes its generated tokens as `completed` and asks for `stalled`:
 * a long answer finishes no request for minutes while its tokens keep coming, and that is not a
 * stall (design KV.10).
 */
export function metricVerdicts(
  points: MetricPoint[],
  minutes: number,
  notMoving: 'stuck' | 'stalled' = 'stuck',
): Verdict[] {
  const newest = points.at(-1);
  if (!newest) return [];
  const window = minutes * 60_000;
  const verdicts: Verdict[] = [];
  const stuck = holdingSince(
    points,
    (point, last) =>
      point.busy > 0 && point.completed !== null && point.completed === last.completed,
  );
  if (stuck !== null && newest.at - stuck >= window)
    verdicts.push({ kind: notMoving, since: stuck });
  const saturated = holdingSince(
    points,
    (point) => point.total !== null && point.total > 0 && point.busy >= point.total,
  );
  if (saturated !== null && newest.at - saturated >= window)
    verdicts.push({ kind: 'saturated', since: saturated });
  return verdicts;
}

function risingSince<T extends { at: number }>(points: T[], value: (point: T) => number) {
  if (points.length < RISING_SAMPLES) return null;
  const recent = points.slice(-RISING_SAMPLES);
  const rising = recent.every(
    (point, index) =>
      index === 0 ||
      (value(point) > value(recent[index - 1]) && point.at - recent[index - 1].at <= GAP_LIMIT),
  );
  return rising ? recent[0].at : null;
}

export function probeVerdicts(points: ProbePoint[]): Verdict[] {
  const verdicts: Verdict[] = [];
  const connections = risingSince(points, (point) => point.closeWait);
  if (connections !== null) verdicts.push({ kind: 'connections', since: connections });
  const fds = risingSince(points, (point) => point.fds);
  const threads = risingSince(points, (point) => point.threads);
  const leak = Math.min(fds ?? Infinity, threads ?? Infinity);
  if (leak !== Infinity) verdicts.push({ kind: 'leak', since: leak });
  return verdicts;
}

export function addMetricPoint(points: MetricPoint[], point: MetricPoint, minutes: number) {
  const keepFrom = point.at - minutes * 60_000 - GAP_LIMIT;
  return [...points.filter((item) => item.at >= keepFrom), point];
}

export const addProbePoint = (points: ProbePoint[], point: ProbePoint) =>
  [...points, point].slice(-MAX_PROBE_POINTS);

const absentText: Record<NoMetricsReason, string> = {
  notFound: '메트릭 없음 (404)',
  refused: '메트릭 없음 (연결 거부)',
  notPrometheus: '메트릭 없음 (형식이 다름)',
};
export const NO_METRIC_CHOSEN = '지정한 메트릭이 응답에 없음';

/** Empty when the read gave series. */
export function metricReadNote(read: MetricsRead): string {
  if (read.state.kind === 'forbidden') return '권한 없음 (pods/proxy)';
  if (read.state.kind !== 'ready') return stateNote(read.state);
  return read.data?.kind === 'absent' ? absentText[read.data.reason] : '';
}

export function probeReadNote(read: ProbeRead): string {
  switch (read.kind) {
    case 'ready':
      return '';
    case 'noShell':
      return '이 컨테이너에서는 읽을 수 없음';
    case 'notRunning':
      return '컨테이너가 실행 중이 아님';
    case 'blocked':
      return read.state.kind === 'forbidden'
        ? 'pods/exec 권한이 없어 읽을 수 없음'
        : stateNote(read.state);
  }
}

export type PodWatchState = {
  metrics: MetricPoint[];
  probes: ProbePoint[];
  metricNote: string;
  probeNote: string;
};
export const emptyPodState = (): PodWatchState => ({
  metrics: [],
  probes: [],
  metricNote: '',
  probeNote: '',
});
export const podStateKey = (namespace: string, pod: string) => `${namespace}/${pod}`;

export function applyMetricRead(
  state: PodWatchState,
  read: MetricsRead,
  watch: WorkerWatch,
  at: number,
): PodWatchState {
  if (!watch.metrics) return state;
  const note = metricReadNote(read);
  if (note) return { ...state, metricNote: note };
  if (read.data?.kind !== 'series') return { ...state, metricNote: NO_METRIC_CHOSEN };
  const point = metricPoint(read.data.items, watch.metrics.roles, at);
  if (!point) return { ...state, metricNote: NO_METRIC_CHOSEN };
  return {
    ...state,
    metricNote: '',
    metrics: addMetricPoint(state.metrics, point, watch.minutes),
  };
}

export function applyProbeRead(state: PodWatchState, read: ProbeRead, at: number): PodWatchState {
  if (read.kind !== 'ready') return { ...state, probeNote: probeReadNote(read) };
  return {
    ...state,
    probeNote: '',
    probes: addProbePoint(state.probes, probePoint(read.runtime, at)),
  };
}

export type WorkerVerdict = Verdict & { pod: string };

export type WorkerSummary = {
  key: string;
  namespace: string;
  kind: string;
  name: string;
  /** `사용 8/8`, or the process count for a workload watched by probe alone. Empty until known. */
  usage: string;
  note: string;
  newestAt: number;
  verdicts: WorkerVerdict[];
};

function usageText(watch: WorkerWatch, fresh: PodWatchState[]) {
  if (watch.metrics) {
    const latest = fresh.flatMap((state) => state.metrics.slice(-1));
    if (!latest.length) return '';
    const busy = latest.reduce((sum, point) => sum + point.busy, 0);
    const known = latest.every((point) => point.total !== null);
    return known
      ? `사용 ${busy}/${latest.reduce((sum, point) => sum + (point.total ?? 0), 0)}`
      : `사용 ${busy}`;
  }
  const latest = fresh.flatMap((state) => state.probes.slice(-1));
  return latest.length ? `프로세스 ${latest.reduce((sum, point) => sum + point.processes, 0)}` : '';
}

/**
 * A pod whose latest read failed gives no value and no verdict: an old number must not read as the
 * current one. Its note is shown instead, next to whatever the other pods still report.
 */
export function summarize(
  watch: WorkerWatch,
  pods: string[],
  states: Record<string, PodWatchState>,
): WorkerSummary {
  const entries = pods.map((pod) => ({
    pod,
    state: states[podStateKey(watch.namespace, pod)] ?? emptyPodState(),
  }));
  const freshStates = entries
    .filter(({ state }) => !(watch.metrics ? state.metricNote : state.probeNote))
    .map(({ state }) => state);
  const verdicts: WorkerVerdict[] = entries
    .flatMap(({ pod, state }) => [
      ...(watch.metrics && !state.metricNote
        ? metricVerdicts(state.metrics, watch.minutes).map((v) => ({ ...v, pod }))
        : []),
      ...(watch.probe && !state.probeNote
        ? probeVerdicts(state.probes).map((v) => ({ ...v, pod }))
        : []),
    ])
    .sort((a, b) => verdictOrder.indexOf(a.kind) - verdictOrder.indexOf(b.kind));
  const usage = usageText(watch, freshStates);
  const noted = entries.flatMap(({ state }) =>
    [watch.metrics ? state.metricNote : '', watch.probe ? state.probeNote : ''].filter(Boolean),
  );
  const newestAt = Math.max(
    0,
    ...entries.flatMap(({ state }) => [
      state.metrics.at(-1)?.at ?? 0,
      state.probes.at(-1)?.at ?? 0,
    ]),
  );
  const note = !pods.length ? '실행 중인 파드 없음' : (noted[0] ?? (usage ? '' : '수집 중'));
  return {
    key: watch.key,
    namespace: watch.namespace,
    kind: watch.kind,
    name: watch.name,
    usage,
    note,
    newestAt,
    verdicts,
  };
}

export const verdictLine = (verdict: Verdict, now: number) => {
  const minutes = Math.floor((now - verdict.since) / 60_000);
  const lasting = ['stuck', 'stalled', 'saturated'].includes(verdict.kind);
  return lasting && minutes >= 1
    ? `${verdictLabels[verdict.kind]} · ${minutes}분째`
    : verdictLabels[verdict.kind];
};

export type WorkerCell = { text: string; suspect: boolean; title: string };

/** What the tree's worker column shows for each workload row, by group id. */
export function workerCells(summaries: WorkerSummary[]) {
  return new Map<string, WorkerCell>(
    summaries.map((summary) => [
      workloadGroupId(summary.namespace, summary.kind, summary.name),
      {
        text: summary.usage || summary.note,
        suspect: summary.verdicts.length > 0,
        title: [
          ...summary.verdicts.map((v) => `${v.pod}: ${verdictLabels[v.kind]}`),
          ...(summary.note ? [summary.note] : []),
        ].join('\n'),
      },
    ]),
  );
}
