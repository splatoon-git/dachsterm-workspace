import type { VllmMetric, VllmSample } from './aiTypes';

export type Reading = { identity: string; sample: VllmSample };

export type ModelValues = {
  run: number | null;
  wait: number | null;
  /** Percent, the highest of what was reported. */
  kv: number | null;
  doneTotal: number | null;
  doneDelta: number | null;
  donePerMinute: number | null;
  inputRate: number | null;
  outputRate: number | null;
  ttft: number | null;
  e2e: number | null;
  queue: number | null;
};

const seriesOf = (sample: VllmSample, metric: VllmMetric, model: string) =>
  sample.series.filter((item) => item.metric === metric && item.model === model);

export function sumOf(sample: VllmSample, metric: VllmMetric, model: string): number | null {
  const found = seriesOf(sample, metric, model);
  return found.length ? found.reduce((sum, item) => sum + item.value, 0) : null;
}

/**
 * The increase since the last reading, or `null` when the two cannot be compared: another pod or
 * process, or any series that appeared, disappeared or went backwards. Unknown is never zero.
 */
export function counterDelta(
  previous: Reading | null,
  latest: Reading,
  metric: VllmMetric,
  model: string,
): number | null {
  if (
    !previous ||
    previous.identity !== latest.identity ||
    latest.sample.atMs <= previous.sample.atMs ||
    previous.sample.processStart !== latest.sample.processStart
  )
    return null;
  const now = seriesOf(latest.sample, metric, model);
  const before = seriesOf(previous.sample, metric, model);
  if (!now.length || before.length !== now.length) return null;
  let total = 0;
  for (const item of now) {
    const old = before.find((other) => other.labels === item.labels);
    if (!old || item.value < old.value) return null;
    total += item.value - old.value;
  }
  return total;
}

export function modelValues(previous: Reading | null, latest: Reading, model: string): ModelValues {
  const delta = (metric: VllmMetric) => counterDelta(previous, latest, metric, model);
  const seconds = previous ? (latest.sample.atMs - previous.sample.atMs) / 1000 : 0;
  const perSecond = (metric: VllmMetric) => {
    const amount = delta(metric);
    return amount === null || seconds <= 0 ? null : amount / seconds;
  };
  const mean = (sum: VllmMetric, count: VllmMetric) => {
    const [total, times] = [delta(sum), delta(count)];
    return total === null || times === null || times <= 0 ? null : total / times;
  };
  const kv = seriesOf(latest.sample, 'kv', model);
  const doneDelta = delta('done');
  return {
    run: sumOf(latest.sample, 'run', model),
    wait: sumOf(latest.sample, 'wait', model),
    kv: kv.length ? Math.max(...kv.map((item) => item.value)) * 100 : null,
    doneTotal: sumOf(latest.sample, 'done', model),
    doneDelta,
    donePerMinute: doneDelta === null || seconds <= 0 ? null : (doneDelta * 60) / seconds,
    inputRate: perSecond('input'),
    outputRate: perSecond('output'),
    ttft: mean('ttftSum', 'ttftCount'),
    e2e: mean('e2eSum', 'e2eCount'),
    queue: mean('queueSum', 'queueCount'),
  };
}

const known = (values: (number | null)[]) => values.filter((v): v is number => v !== null);
export const total = (values: (number | null)[]) => {
  const present = known(values);
  return present.length ? present.reduce((sum, v) => sum + v, 0) : null;
};
export const highest = (values: (number | null)[]) => {
  const present = known(values);
  return present.length ? Math.max(...present) : null;
};
const average = (values: (number | null)[]) => {
  const present = known(values);
  return present.length ? present.reduce((sum, v) => sum + v, 0) / present.length : null;
};

export function combine(all: ModelValues[]): ModelValues {
  const of = <K extends keyof ModelValues>(key: K) => all.map((item) => item[key]);
  return {
    run: total(of('run')),
    wait: total(of('wait')),
    kv: highest(of('kv')),
    doneTotal: total(of('doneTotal')),
    doneDelta: total(of('doneDelta')),
    donePerMinute: total(of('donePerMinute')),
    inputRate: total(of('inputRate')),
    outputRate: total(of('outputRate')),
    ttft: average(of('ttft')),
    e2e: average(of('e2e')),
    queue: average(of('queue')),
  };
}
