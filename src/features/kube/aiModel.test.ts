import { describe, expect, it } from 'vitest';
import { formatCount, formatMemory, formatSeconds } from './aiFormat';
import {
  ALL_MODELS,
  UNKNOWN_MODEL,
  applyAiRead,
  emptyAiData,
  mergeAiSummaries,
  type AiData,
} from './aiModel';
import { counterDelta, modelValues } from './aiValues';
import type { AiRead, GpuDevice, VllmMetric, VllmPod, VllmSeries } from './aiTypes';
import type { KubePod } from './snapshotTypes';
import { verdictLabels, type WorkerSummary } from './workers';

const series = (metric: VllmMetric, value: number, model = 'qwen', labels = model): VllmSeries => ({
  metric,
  model,
  labels,
  value,
});

const reading = (
  atMs: number,
  values: VllmSeries[],
  identity = 'u|0',
  processStart: number | null = 1,
) => ({
  identity,
  sample: { atMs, processStart, series: values },
});

const pod = (
  name: string,
  values: VllmSeries[] | null,
  atMs: number,
  status: VllmPod['status'] = 'ok',
): VllmPod => ({
  namespace: 'ai',
  pod: name,
  node: 'gpu-1',
  identity: 'u|0',
  status: values ? status : status === 'ok' ? 'unreachable' : status,
  endpoint: '/e',
  sample: values ? { atMs, processStart: 1, series: values } : null,
});

const read = (pods: VllmPod[], gpus: GpuDevice[] = []): AiRead => ({
  state: { kind: 'ready' },
  pods,
  exporters: [],
  gpus,
  capped: 0,
  gpuRestricted: false,
  elapsedMs: 5,
});

const kubePod = (name: string, owner = 'serve'): KubePod =>
  ({
    namespace: 'ai',
    name,
    ownerKind: 'StatefulSet',
    ownerName: owner,
    labels: {},
  }) as unknown as KubePod;

describe('counterDelta', () => {
  const before = reading(1000, [series('done', 5, 'qwen', 'a'), series('done', 2, 'qwen', 'b')]);

  it('adds the increase of every series', () => {
    const after = reading(2000, [series('done', 8, 'qwen', 'a'), series('done', 4, 'qwen', 'b')]);
    expect(counterDelta(before, after, 'done', 'qwen')).toBe(5);
  });

  it('does not treat what it cannot compare as zero', () => {
    const later = (values: VllmSeries[], identity?: string, start?: number | null) =>
      reading(2000, values, identity, start);
    const same = [series('done', 8, 'qwen', 'a'), series('done', 4, 'qwen', 'b')];
    expect(counterDelta(null, later(same), 'done', 'qwen')).toBeNull();
    expect(counterDelta(before, later(same, 'u|1'), 'done', 'qwen')).toBeNull();
    expect(counterDelta(before, later(same, 'u|0', 2), 'done', 'qwen')).toBeNull();
    expect(counterDelta(before, reading(1000, same), 'done', 'qwen')).toBeNull();
    // One series went back, one appeared, one vanished.
    expect(
      counterDelta(
        before,
        later([series('done', 1, 'qwen', 'a'), series('done', 4, 'qwen', 'b')]),
        'done',
        'qwen',
      ),
    ).toBeNull();
    expect(
      counterDelta(before, later([series('done', 9, 'qwen', 'a')]), 'done', 'qwen'),
    ).toBeNull();
    expect(
      counterDelta(
        before,
        later([series('done', 8, 'qwen', 'a'), series('done', 4, 'qwen', 'c')]),
        'done',
        'qwen',
      ),
    ).toBeNull();
    expect(counterDelta(before, later(same), 'input', 'qwen')).toBeNull();
  });
});

describe('modelValues', () => {
  it('reads gauges, rates and mean latencies', () => {
    const before = reading(0, [
      series('done', 10),
      series('output', 100),
      series('ttftSum', 1),
      series('ttftCount', 2),
    ]);
    const after = reading(10_000, [
      series('run', 2),
      series('wait', 0),
      series('kv', 0.25, 'qwen', 'x'),
      series('kv', 0.5, 'qwen', 'y'),
      series('done', 15),
      series('output', 600),
      series('ttftSum', 3),
      series('ttftCount', 6),
    ]);
    expect(modelValues(before, after, 'qwen')).toMatchObject({
      run: 2,
      wait: 0,
      kv: 50,
      doneTotal: 15,
      doneDelta: 5,
      donePerMinute: 30,
      outputRate: 50,
      ttft: 0.5,
      inputRate: null,
      e2e: null,
    });
  });

  it('has no rate on the first reading and no latency without completions', () => {
    const first = reading(0, [series('run', 1), series('output', 7)]);
    expect(modelValues(null, first, 'qwen').outputRate).toBeNull();
    const a = reading(0, [series('e2eSum', 5), series('e2eCount', 3)]);
    const b = reading(5000, [series('e2eSum', 5), series('e2eCount', 3)]);
    expect(modelValues(a, b, 'qwen').e2e).toBeNull();
  });
});

const MINUTE = 60_000;

function run(steps: { at: number; pods: VllmPod[] }[], kubePods: KubePod[], minutes = 5) {
  let data: AiData = emptyAiData();
  for (const step of steps) data = applyAiRead(data, read(step.pods), kubePods, step.at, minutes);
  return data;
}

const busy = (at: number, tokens: number, extra: VllmSeries[] = [], name = 'serve-0') => ({
  at,
  pods: [pod(name, [series('run', 1), series('output', tokens), ...extra], at)],
});

describe('stall verdict', () => {
  const pods = [kubePod('serve-0')];
  const minutes = (count: number) => Array.from({ length: count + 1 }, (_, i) => i * MINUTE);

  it('is raised when requests run and no token comes for the whole window', () => {
    const data = run(
      minutes(5).map((at) => busy(at, 500)),
      pods,
    );
    const row = data.view!.groups[0].rows[0];
    expect(row.stalled?.kind).toBe('stalled');
    expect(verdictLabels[row.stalled!.kind]).toBe('처리 정지 의심');
    expect(data.summaries[0].verdicts[0]).toMatchObject({ pod: 'serve-0', kind: 'stalled' });
  });

  it('is not raised before the window has passed', () => {
    const data = run(
      minutes(4).map((at) => busy(at, 500)),
      pods,
    );
    expect(data.view!.groups[0].rows[0].stalled).toBeNull();
  });

  it('is not raised while tokens keep coming, even if no request finishes', () => {
    const data = run(
      minutes(10).map((at, i) => busy(at, 500 + i, [series('done', 3)])),
      pods,
    );
    expect(data.view!.groups[0].rows[0].stalled).toBeNull();
  });

  it('needs running requests', () => {
    const idle = minutes(6).map((at) => ({
      at,
      pods: [pod('serve-0', [series('run', 0), series('output', 500)], at)],
    }));
    expect(run(idle, pods).view!.groups[0].rows[0].stalled).toBeNull();
  });

  it('needs the token counter: unknown is not zero', () => {
    const steps = minutes(6).map((at) => ({ at, pods: [pod('serve-0', [series('run', 1)], at)] }));
    expect(run(steps, pods).view!.groups[0].rows[0].stalled).toBeNull();
  });

  it('gives no verdict for a pod whose latest read failed', () => {
    const steps = minutes(5).map((at) => busy(at, 500));
    steps.push({ at: 6 * MINUTE, pods: [pod('serve-0', null, 6 * MINUTE)] });
    const data = run(steps, pods);
    expect(data.view!.groups[0].rows[0].stalled).toBeNull();
    expect(data.summaries[0].verdicts).toEqual([]);
  });

  it('resets once tokens move again', () => {
    const steps = minutes(5).map((at) => busy(at, 500));
    steps.push(busy(6 * MINUTE, 900));
    expect(run(steps, pods).view!.groups[0].rows[0].stalled).toBeNull();
  });
});

describe('applyAiRead', () => {
  it('groups pods under models, sums counts and keeps the highest KV', () => {
    const at = 1000;
    const data = run(
      [
        {
          at,
          pods: [
            pod('a-0', [series('run', 1), series('kv', 0.2)], at),
            pod('a-1', [series('run', 2), series('kv', 0.7)], at),
            pod('b-0', [series('run', 5, 'gemma')], at),
          ],
        },
      ],
      [],
    );
    const groups = data.view!.groups;
    expect(groups.map((g) => g.model)).toEqual(['gemma', 'qwen']);
    expect(groups[1].values).toMatchObject({ run: 3 });
    expect(groups[1].values.kv).toBeCloseTo(70);
    expect(groups[1].ok).toBe(2);
    expect(data.view!.all.run).toBe(8);
  });

  it('puts a failing pod under the model it served, then under its siblings', () => {
    const owner = [kubePod('a-0'), kubePod('a-1')];
    const first = { at: 1, pods: [pod('a-0', [series('run', 1)], 1), pod('a-1', null, 1)] };
    const data = run([first], owner);
    expect(data.view!.groups).toHaveLength(1);
    expect(data.view!.groups[0].model).toBe('qwen');
    expect(data.view!.groups[0].ok).toBe(1);
    expect(data.view!.groups[0].rows).toHaveLength(2);

    const second = { at: 2, pods: [pod('a-0', null, 2), pod('a-1', null, 2)] };
    expect(run([first, second], owner).view!.groups[0].model).toBe('qwen');

    const lone = run([{ at: 1, pods: [pod('z-0', null, 1)] }], []);
    expect(lone.view!.groups[0].model).toBe(UNKNOWN_MODEL);
  });

  it('adds a device to every pod using it, whole-device figures', () => {
    const gpu = (id: string, util: number, used: number): GpuDevice => ({
      node: 'gpu-1',
      id,
      gpu: id,
      model: 'A100',
      util,
      used,
      total: 1000,
      temp: 60,
      power: 100,
      pods: ['ai/a-0'],
    });
    const data = applyAiRead(
      emptyAiData(),
      read([pod('a-0', [series('run', 1)], 1)], [gpu('x', 30, 200), gpu('y', 80, 300)]),
      [],
      1,
    );
    expect(data.view!.groups[0].rows[0].gpu).toEqual({ util: 80, used: 500, total: 2000 });
    expect(data.view!.nodes[0]).toMatchObject({
      utilAverage: 55,
      utilMax: 80,
      used: 500,
      power: 200,
    });
  });

  it('keeps pods and the tab through a detection that failed, without showing old values', () => {
    const before = run([busy(MINUTE, 5)], [kubePod('serve-0')]);
    const failed: AiRead = { ...read([]), state: { kind: 'unreachable' } };
    const after = applyAiRead(before, failed, [], 2 * MINUTE);
    expect(after.available).toBe(true);
    expect(after.pods).toBe(before.pods);
    expect(after.view).toBeNull();
    expect(after.summaries).toEqual([]);
  });

  it('is not available when nothing was detected, and forgets pods that are gone', () => {
    const before = run([busy(1, 5)], []);
    const after = applyAiRead(before, read([]), [], 2);
    expect(after.available).toBe(false);
    expect(after.pods).toEqual({});
  });

  it('keeps a bounded trend per model and for all of them', () => {
    const steps = Array.from({ length: 50 }, (_, i) => busy(i * 1000 + 1, 5));
    const data = run(steps, []);
    expect(data.trends.qwen.run).toHaveLength(40);
    expect(data.trends[ALL_MODELS].run.at(-1)).toBe(1);
  });
});

describe('summaries', () => {
  const summary = (key: string, extra: Partial<WorkerSummary> = {}): WorkerSummary => ({
    key,
    namespace: 'ai',
    kind: 'StatefulSet',
    name: 'serve',
    usage: '',
    note: '',
    newestAt: 0,
    verdicts: [],
    ...extra,
  });

  it('summarizes a workload with running and waiting requests', () => {
    const at = 1;
    const data = run(
      [{ at, pods: [pod('serve-0', [series('run', 2), series('wait', 3)], at)] }],
      [kubePod('serve-0')],
    );
    expect(data.summaries[0]).toMatchObject({
      key: 'ai/StatefulSet/serve',
      usage: '실행 2 · 대기 3',
    });
  });

  it('leaves out pods with no workload, which have no row to mark', () => {
    expect(run([busy(1, 5)], []).summaries).toEqual([]);
  });

  it('says why a workload has no value', () => {
    const data = run(
      [{ at: 1, pods: [pod('serve-0', null, 1, 'forbidden')] }],
      [kubePod('serve-0')],
    );
    expect(data.summaries[0].usage).toBe('');
    expect(data.summaries[0].note).toContain('권한 없음');
  });

  it('joins a workload that is also being watched, once', () => {
    const verdict = { kind: 'stalled' as const, since: 1, pod: 'p' };
    const merged = mergeAiSummaries(
      [summary('a', { usage: '사용 1/2' })],
      [summary('a', { usage: '실행 1 · 대기 0', verdicts: [verdict] }), summary('b')],
    );
    expect(merged.map((item) => item.key)).toEqual(['a', 'b']);
    expect(merged[0].usage).toBe('사용 1/2');
    expect(merged[0].verdicts).toEqual([verdict]);
  });
});

describe('formats', () => {
  it('never shows unknown as zero', () => {
    expect(formatCount(null)).toBe('-');
    expect(formatSeconds(null)).toBe('-');
    expect(formatMemory(null, 10)).toBe('-');
    expect(formatCount(0)).toBe('0');
  });

  it('shortens large numbers', () => {
    expect(formatCount(1234)).toBe('1234');
    expect(formatCount(12300)).toBe('12.3k');
    expect(formatCount(4_500_000)).toBe('4.5M');
    expect(formatSeconds(0.812)).toBe('0.81s');
    expect(formatSeconds(123.4)).toBe('123s');
    expect(formatMemory(2048, 4096)).toBe('2.0/4.0G');
  });
});
