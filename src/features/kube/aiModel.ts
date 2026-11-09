import { statusText } from './aiFormat';
import type { AiRead, GpuDevice, ScrapeStatus, VllmSample } from './aiTypes';
import {
  combine,
  highest,
  modelValues,
  sumOf,
  total,
  type ModelValues,
  type Reading,
} from './aiValues';
import type { KubePod } from './snapshotTypes';
import { ownerOf } from './tree';
import {
  DEFAULT_MINUTES,
  addMetricPoint,
  metricVerdicts,
  watchKeyOf,
  type MetricPoint,
  type Verdict,
  type WorkerSummary,
  type WorkerVerdict,
} from './workers';

export const NO_MODEL_LABEL = '(모델 라벨 없음)';
export const UNKNOWN_MODEL = '(수집 불가)';
export const ALL_MODELS = '@all';
const TREND_POINTS = 40;

export type PodGpu = { util: number | null; used: number | null; total: number | null };

export type PodRow = {
  key: string;
  namespace: string;
  pod: string;
  node: string;
  status: ScrapeStatus;
  endpoint: string;
  values: ModelValues | null;
  gpu: PodGpu | null;
  stalled: Verdict | null;
};

export type ModelGroup = {
  model: string;
  ok: number;
  values: ModelValues;
  gpu: PodGpu;
  rows: PodRow[];
};

export type GpuNode = {
  node: string;
  devices: GpuDevice[];
  utilAverage: number | null;
  utilMax: number | null;
  used: number | null;
  total: number | null;
  tempMax: number | null;
  power: number | null;
};

export type AiPodState = {
  namespace: string;
  pod: string;
  status: ScrapeStatus;
  previous: Reading | null;
  latest: Reading | null;
  lastModel: string | null;
  /** By model. `completed` holds generated tokens, so a long answer does not read as a stall. */
  points: Record<string, MetricPoint[]>;
};

export type Trend = {
  run: (number | null)[];
  wait: (number | null)[];
  donePerMinute: (number | null)[];
  kv: (number | null)[];
};

export type AiView = { at: number; groups: ModelGroup[]; nodes: GpuNode[]; all: ModelValues };

export type AiData = {
  read: AiRead | null;
  /** Survives a detection that failed, so one bad poll does not hide the tab. */
  available: boolean;
  pods: Record<string, AiPodState>;
  trends: Record<string, Trend>;
  view: AiView | null;
  summaries: WorkerSummary[];
};

export const emptyAiData = (): AiData => ({
  read: null,
  available: false,
  pods: {},
  trends: {},
  view: null,
  summaries: [],
});

export const NO_AI: AiData & { setFast: (on: boolean) => void; error: string } = {
  ...emptyAiData(),
  setFast: () => undefined,
  error: '',
};

const modelsOf = (sample: VllmSample) =>
  [...new Set(sample.series.map((item) => item.model))].sort();

/** A device's whole-device figures, for each pod the exporter says is using it. */
function podGpus(gpus: GpuDevice[]) {
  const devices = new Map<string, GpuDevice[]>();
  for (const device of gpus)
    for (const pod of device.pods) devices.set(pod, [...(devices.get(pod) ?? []), device]);
  return new Map<string, PodGpu>(
    [...devices].map(([pod, list]) => [
      pod,
      {
        util: highest(list.map((d) => d.util)),
        used: total(list.map((d) => d.used)),
        total: total(list.map((d) => d.total)),
      },
    ]),
  );
}

function gpuNodes(gpus: GpuDevice[]): GpuNode[] {
  const nodes = new Map<string, GpuDevice[]>();
  for (const device of gpus) nodes.set(device.node, [...(nodes.get(device.node) ?? []), device]);
  return [...nodes].map(([node, devices]) => ({
    node,
    devices,
    utilAverage: devices.length ? (total(devices.map((d) => d.util)) ?? 0) / devices.length : null,
    utilMax: highest(devices.map((d) => d.util)),
    used: total(devices.map((d) => d.used)),
    total: total(devices.map((d) => d.total)),
    tempMax: highest(devices.map((d) => d.temp)),
    power: total(devices.map((d) => d.power)),
  }));
}

const podKey = (namespace: string, pod: string) => `${namespace}/${pod}`;

function ownerKeys(kubePods: KubePod[]) {
  const owners = new Map<string, { kind: string; name: string }>();
  for (const pod of kubePods) {
    const owner = ownerOf(pod);
    if (owner) owners.set(podKey(pod.namespace, pod.name), owner);
  }
  return owners;
}

function stallOf(state: AiPodState, model: string, minutes: number): Verdict | null {
  if (state.status !== 'ok') return null;
  return metricVerdicts(state.points[model] ?? [], minutes, 'stalled')[0] ?? null;
}

function applyPod(old: AiPodState | undefined, pod: AiRead['pods'][number], minutes: number) {
  const base: AiPodState = old ?? {
    namespace: pod.namespace,
    pod: pod.pod,
    status: pod.status,
    previous: null,
    latest: null,
    lastModel: null,
    points: {},
  };
  // A pod that could not be read has no current value and starts its comparison over.
  if (pod.status !== 'ok' || !pod.sample)
    return { ...base, status: pod.status, previous: null, latest: null };
  const latest: Reading = { identity: pod.identity, sample: pod.sample };
  const models = modelsOf(pod.sample);
  const points: Record<string, MetricPoint[]> = {};
  for (const model of models) {
    const run = sumOf(pod.sample, 'run', model);
    const before = base.points[model] ?? [];
    points[model] =
      run === null
        ? before
        : addMetricPoint(
            before,
            {
              at: pod.sample.atMs,
              busy: run,
              total: null,
              completed: sumOf(pod.sample, 'output', model),
            },
            minutes,
          );
  }
  return {
    ...base,
    status: pod.status,
    previous: base.latest,
    latest,
    lastModel: models[0] ?? base.lastModel,
    points,
  };
}

function buildView(
  states: Record<string, AiPodState>,
  read: AiRead,
  kubePods: KubePod[],
  now: number,
  minutes: number,
): AiView {
  const owners = ownerKeys(kubePods);
  const gpus = podGpus(read.gpus);
  const workloadOf = (key: string, namespace: string) => {
    const owner = owners.get(key);
    return owner ? watchKeyOf(namespace, owner.kind, owner.name) : null;
  };
  // Replicas of a workload serve one model: one that never answered goes with its siblings.
  const siblingModel = new Map<string, string>();
  for (const [key, state] of Object.entries(states)) {
    const workload = workloadOf(key, state.namespace);
    if (workload && state.lastModel !== null && !siblingModel.has(workload))
      siblingModel.set(workload, state.lastModel);
  }
  const grouped = new Map<string, PodRow[]>();
  const add = (model: string, row: PodRow) =>
    grouped.set(model, [...(grouped.get(model) ?? []), row]);
  for (const pod of read.pods) {
    const key = podKey(pod.namespace, pod.pod);
    const state = states[key];
    const base = {
      key,
      namespace: pod.namespace,
      pod: pod.pod,
      node: pod.node,
      status: pod.status,
      endpoint: pod.endpoint,
      gpu: gpus.get(key) ?? null,
    };
    if (pod.status !== 'ok' || !state.latest) {
      const workload = workloadOf(key, pod.namespace);
      const model = state.lastModel ?? (workload ? siblingModel.get(workload) : null);
      add(model ?? UNKNOWN_MODEL, { ...base, values: null, stalled: null });
      continue;
    }
    for (const model of modelsOf(state.latest.sample))
      add(model, {
        ...base,
        values: modelValues(state.previous, state.latest, model),
        stalled: stallOf(state, model, minutes),
      });
  }
  const groups: ModelGroup[] = [...grouped]
    .map(([model, rows]) => ({
      model,
      ok: rows.filter((row) => row.values).length,
      values: combine(rows.flatMap((row) => (row.values ? [row.values] : []))),
      gpu: {
        util: highest(rows.map((row) => row.gpu?.util ?? null)),
        used: total(rows.map((row) => row.gpu?.used ?? null)),
        total: total(rows.map((row) => row.gpu?.total ?? null)),
      },
      rows,
    }))
    .sort((a, b) => {
      if (a.model === UNKNOWN_MODEL) return 1;
      if (b.model === UNKNOWN_MODEL) return -1;
      return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
    });
  return {
    at: now,
    groups,
    nodes: gpuNodes(read.gpus),
    all: combine(groups.flatMap((group) => (group.ok ? [group.values] : []))),
  };
}

const pushed = (list: (number | null)[], value: number | null) =>
  [...list, value].slice(-TREND_POINTS);

function nextTrend(trend: Trend | undefined, values: ModelValues): Trend {
  const old = trend ?? { run: [], wait: [], donePerMinute: [], kv: [] };
  return {
    run: pushed(old.run, values.run),
    wait: pushed(old.wait, values.wait),
    donePerMinute: pushed(old.donePerMinute, values.donePerMinute),
    kv: pushed(old.kv, values.kv),
  };
}

function usageOf(rows: PodRow[]) {
  const values = rows.flatMap((row) => (row.values ? [row.values] : []));
  if (!values.length) return '';
  return `실행 ${total(values.map((v) => v.run)) ?? '-'} · 대기 ${total(values.map((v) => v.wait)) ?? '-'}`;
}

/** The same summary a watched workload gets, so the tree and dashboard show both one way. */
function summariesOf(view: AiView, kubePods: KubePod[]): WorkerSummary[] {
  const owners = ownerKeys(kubePods);
  const byWorkload = new Map<
    string,
    { namespace: string; kind: string; name: string; rows: PodRow[] }
  >();
  for (const row of view.groups.flatMap((group) => group.rows)) {
    const owner = owners.get(row.key);
    if (!owner) continue;
    const key = watchKeyOf(row.namespace, owner.kind, owner.name);
    const entry = byWorkload.get(key) ?? {
      namespace: row.namespace,
      kind: owner.kind,
      name: owner.name,
      rows: [],
    };
    entry.rows.push(row);
    byWorkload.set(key, entry);
  }
  return [...byWorkload].map(([key, entry]) => {
    const stalled = new Map<string, WorkerVerdict>();
    for (const row of entry.rows) {
      if (!row.stalled) continue;
      const earlier = stalled.get(row.pod);
      if (!earlier || row.stalled.since < earlier.since)
        stalled.set(row.pod, { ...row.stalled, pod: row.pod });
    }
    const usage = usageOf(entry.rows);
    const failing = entry.rows.find((row) => row.status !== 'ok');
    return {
      key,
      namespace: entry.namespace,
      kind: entry.kind,
      name: entry.name,
      usage,
      note: failing ? statusText[failing.status] : usage ? '' : '수집 중',
      newestAt: view.at,
      verdicts: [...stalled.values()],
    };
  });
}

/** A workload with a watch keeps it, and its stall verdicts join what the watch found. */
export function mergeAiSummaries(watches: WorkerSummary[], ai: WorkerSummary[]): WorkerSummary[] {
  if (!ai.length) return watches;
  const found = new Map(ai.map((summary) => [summary.key, summary]));
  const merged = watches.map((watch) => {
    const extra = found.get(watch.key);
    if (!extra) return watch;
    found.delete(watch.key);
    return { ...watch, verdicts: [...watch.verdicts, ...extra.verdicts] };
  });
  return [...merged, ...found.values()];
}

/** One poll's answer. A detection that failed changes nothing but what the screen says about it. */
export function applyAiRead(
  data: AiData,
  read: AiRead,
  kubePods: KubePod[],
  now: number,
  minutes = DEFAULT_MINUTES,
): AiData {
  if (read.state.kind !== 'ready') return { ...data, read, view: null, summaries: [] };
  const pods: Record<string, AiPodState> = {};
  for (const pod of read.pods) {
    const key = podKey(pod.namespace, pod.pod);
    pods[key] = applyPod(data.pods[key], pod, minutes);
  }
  const view = buildView(pods, read, kubePods, now, minutes);
  const trends: Record<string, Trend> = {
    [ALL_MODELS]: nextTrend(data.trends[ALL_MODELS], view.all),
  };
  for (const group of view.groups)
    trends[group.model] = nextTrend(data.trends[group.model], group.values);
  return {
    read,
    available: read.pods.length > 0 || read.exporters.length > 0,
    pods,
    trends,
    view,
    summaries: summariesOf(view, kubePods),
  };
}
