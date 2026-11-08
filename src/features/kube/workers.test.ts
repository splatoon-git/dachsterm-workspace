import { describe, expect, it } from 'vitest';
import type { MetricsRead, ProbeRead, Runtime } from './runtimeTypes';
import type { KubePod } from './snapshotTypes';
import {
  MAX_WATCHED_PODS,
  dueTasks,
  nextTaskIn,
  taskDelay,
  taskFinished,
  taskStarted,
  watchTargets,
} from './workerSchedule';
import {
  addMetricPoint,
  applyMetricRead,
  applyProbeRead,
  emptyPodState,
  metricPoint,
  metricReadNote,
  metricVerdicts,
  probeReadNote,
  probeVerdicts,
  selectorValue,
  seriesSelector,
  summarize,
  verdictLine,
  workerCells,
  type MetricPoint,
  type ProbePoint,
  type WorkerWatch,
} from './workers';

const MIN = 60_000;
const start = 1_000_000;

const point = (minute: number, busy: number, completed: number, total = 8): MetricPoint => ({
  at: start + minute * MIN,
  busy,
  total,
  completed,
});

const probe = (index: number, closeWait: number, fds = 10, threads = 4): ProbePoint => ({
  at: start + index * 30_000,
  processes: 2,
  closeWait,
  fds,
  threads,
});

const watch = (over: Partial<WorkerWatch> = {}): WorkerWatch => ({
  key: 'web/Deployment/api',
  namespace: 'web',
  kind: 'Deployment',
  name: 'api',
  minutes: 5,
  metrics: {
    port: 8080,
    path: '/metrics',
    https: false,
    roles: { busy: 'busy', total: 'total', completed: 'done' },
  },
  probe: null,
  ...over,
});

const series = (items: [string, number, string?][]) =>
  items.map(([name, value, labels]) => ({ name, value, labels: labels ?? '' }));

describe('selectors', () => {
  const list = series([
    ['requests', 3, 'code="200"'],
    ['requests', 2, 'code="500"'],
    ['busy', 8],
  ]);

  it('adds up a bare name and reads one exact labelled series', () => {
    expect(selectorValue(list, 'requests')).toBe(5);
    expect(selectorValue(list, 'requests{code="500"}')).toBe(2);
    expect(selectorValue(list, 'busy')).toBe(8);
    expect(selectorValue(list, seriesSelector(list[0]))).toBe(3);
  });

  it('knows when a metric is missing, which is different from zero', () => {
    expect(selectorValue(list, 'nope')).toBeNull();
    expect(selectorValue(list, 'requests{code="404"}')).toBeNull();
    expect(selectorValue(series([['busy', 0]]), 'busy')).toBe(0);
  });

  it('needs the metric for "in use" and tolerates the others missing', () => {
    const roles = { busy: 'busy', total: 'gone', completed: 'also_gone' };
    expect(metricPoint(list, roles, 5)).toEqual({ at: 5, busy: 8, total: null, completed: null });
    expect(metricPoint(list, { ...roles, busy: 'gone' }, 5)).toBeNull();
  });
});

describe('workers that do not return', () => {
  it('suspects a pod whose workers stay busy while nothing completes for N minutes', () => {
    const points = [0, 1, 2, 3, 4, 5].map((minute) => point(minute, 3, 100));
    expect(metricVerdicts(points, 5)).toEqual([{ kind: 'stuck', since: start }]);
  });

  it('waits until the whole window has been seen', () => {
    const points = [0, 1, 2, 3, 4].map((minute) => point(minute, 3, 100));
    expect(metricVerdicts(points, 5)).toEqual([]);
  });

  it('says nothing while requests keep completing', () => {
    const points = [0, 1, 2, 3, 4, 5].map((minute) => point(minute, 3, 100 + minute));
    expect(metricVerdicts(points, 5)).toEqual([]);
  });

  it('says nothing when no worker is in use', () => {
    const points = [0, 1, 2, 3, 4, 5].map((minute) => point(minute, 0, 100));
    expect(metricVerdicts(points, 5)).toEqual([]);
  });

  it('starts again from a restart, when the counter goes back', () => {
    const points = [
      ...[0, 1, 2, 3].map((minute) => point(minute, 3, 100)),
      ...[4, 5, 6].map((minute) => point(minute, 3, 7)),
    ];
    expect(metricVerdicts(points, 5)).toEqual([]);
    expect(metricVerdicts(points, 2)[0]).toEqual({ kind: 'stuck', since: start + 4 * MIN });
  });

  it('does not count time nobody watched, such as a hidden tab', () => {
    const points = [point(0, 3, 100), point(1, 3, 100), point(20, 3, 100), point(21, 3, 100)];
    expect(metricVerdicts(points, 5)).toEqual([]);
  });

  it('cannot judge without a completed counter', () => {
    const points = [0, 1, 2, 3, 4, 5].map((minute) => ({
      ...point(minute, 3, 0),
      completed: null,
    }));
    expect(metricVerdicts(points, 5)).toEqual([]);
  });

  it('has nothing to say about no samples', () => {
    expect(metricVerdicts([], 5)).toEqual([]);
    expect(probeVerdicts([])).toEqual([]);
  });
});

describe('saturation', () => {
  it('suspects every worker in use for N minutes even while work completes', () => {
    const points = [0, 1, 2, 3, 4, 5].map((minute) => point(minute, 8, 100 + minute));
    expect(metricVerdicts(points, 5)).toEqual([{ kind: 'saturated', since: start }]);
  });

  it('reports both when workers are all in use and nothing completes', () => {
    const kinds = metricVerdicts(
      [0, 1, 2, 3, 4, 5].map((minute) => point(minute, 8, 100)),
      5,
    ).map((v) => v.kind);
    expect(kinds).toEqual(['stuck', 'saturated']);
  });

  it('is not saturated with one worker free, and cannot tell without a total', () => {
    const free = [0, 1, 2, 3, 4, 5].map((minute) => point(minute, 7, 100 + minute));
    expect(metricVerdicts(free, 5)).toEqual([]);
    const noTotal = free.map((item) => ({ ...item, busy: 8, total: null }));
    expect(metricVerdicts(noTotal, 5)).toEqual([]);
  });

  it('breaks the streak the moment a worker frees up', () => {
    const points = [point(0, 8, 1), point(1, 8, 2), point(2, 7, 3), point(3, 8, 4), point(8, 8, 9)];
    expect(metricVerdicts(points, 5)).toEqual([]);
  });
});

describe('probe verdicts', () => {
  it('suspects CLOSE_WAIT that rises at every sample', () => {
    const points = [1, 2, 3, 4, 5].map((value, index) => probe(index, value));
    expect(probeVerdicts(points)).toEqual([{ kind: 'connections', since: start }]);
  });

  it('forgives a flat sample or too few samples', () => {
    expect(probeVerdicts([1, 2, 2, 4, 5].map((v, i) => probe(i, v)))).toEqual([]);
    expect(probeVerdicts([1, 2, 3, 4].map((v, i) => probe(i, v)))).toEqual([]);
  });

  it('suspects a leak in file descriptors or threads', () => {
    const fds = [10, 20, 30, 40, 50].map((v, i) => probe(i, 0, v));
    expect(probeVerdicts(fds).map((v) => v.kind)).toEqual(['leak']);
    const threads = [1, 2, 3, 4, 5].map((v, i) => probe(i, 0, 10, v));
    expect(probeVerdicts(threads).map((v) => v.kind)).toEqual(['leak']);
  });

  it('judges only the latest samples', () => {
    const points = [9, 1, 2, 3, 4, 5].map((v, i) => probe(i, v));
    expect(probeVerdicts(points)).toHaveLength(1);
    const settled = [1, 2, 3, 4, 5, 5].map((v, i) => probe(i, v));
    expect(probeVerdicts(settled)).toEqual([]);
  });

  it('does not treat samples a long way apart as continuous', () => {
    const points = [1, 2, 3, 4, 5].map((v, i) => ({ ...probe(i, v), at: start + i * 10 * MIN }));
    expect(probeVerdicts(points)).toEqual([]);
  });
});

describe('sample history', () => {
  it('keeps the window and a little more', () => {
    let points: MetricPoint[] = [];
    for (let minute = 0; minute <= 30; minute++)
      points = addMetricPoint(points, point(minute, 1, 1), 5);
    expect(points[0].at).toBeGreaterThanOrEqual(start + 22 * MIN);
    expect(points.at(-1)?.at).toBe(start + 30 * MIN);
  });
});

const ok = (items: MetricsRead['data']): MetricsRead => ({
  state: { kind: 'ready' },
  data: items,
  elapsedMs: 5,
});

const runtime = (closeWait: number): Runtime => ({
  processes: [
    { pid: 1, name: 'w', state: 'S', threads: 4, fds: 9, fdLimit: 10, ageSeconds: 1 },
    { pid: 2, name: 'w', state: 'S', threads: 2, fds: null, fdLimit: null, ageSeconds: 1 },
  ],
  truncated: false,
  tcp: {
    established: 0,
    synSent: 0,
    synRecv: 0,
    finWait1: 0,
    finWait2: 0,
    timeWait: 0,
    close: 0,
    closeWait,
    lastAck: 0,
    listen: 0,
    closing: 0,
  },
  listen: [],
  counters: { listenOverflows: null, listenDrops: null, retransmitted: null },
});

describe('reading an answer', () => {
  const answer = series([
    ['busy', 8],
    ['total', 8],
    ['done', 100],
  ]);

  it('turns series into a sample and clears an earlier failure', () => {
    const before = { ...emptyPodState(), metricNote: '이전 실패' };
    const after = applyMetricRead(
      before,
      ok({ kind: 'series', items: answer, total: 3 }),
      watch(),
      7,
    );
    expect(after.metricNote).toBe('');
    expect(after.metrics).toEqual([{ at: 7, busy: 8, total: 8, completed: 100 }]);
  });

  it('treats a port without metrics as an answer, not an error', () => {
    const note = metricReadNote(ok({ kind: 'absent', reason: 'refused' }));
    expect(note).toBe('메트릭 없음 (연결 거부)');
    expect(metricReadNote(ok({ kind: 'absent', reason: 'notFound' }))).toBe('메트릭 없음 (404)');
  });

  it('keeps the last samples but marks them when a read fails', () => {
    const before = { ...emptyPodState(), metrics: [point(0, 1, 1)] };
    const forbidden: MetricsRead = { state: { kind: 'forbidden' }, data: null, elapsedMs: 1 };
    const after = applyMetricRead(before, forbidden, watch(), 7);
    expect(after.metricNote).toBe('권한 없음 (pods/proxy)');
    expect(after.metrics).toHaveLength(1);
  });

  it('says when the chosen metric is not in the answer', () => {
    const other = series([['unrelated', 1]]);
    const after = applyMetricRead(
      emptyPodState(),
      ok({ kind: 'series', items: other, total: 1 }),
      watch(),
      7,
    );
    expect(after.metricNote).toBe('지정한 메트릭이 응답에 없음');
  });

  it('adds probe samples and names each way a probe cannot run', () => {
    const ready: ProbeRead = { kind: 'ready', runtime: runtime(3), elapsedMs: 1 };
    const after = applyProbeRead(emptyPodState(), ready, 7);
    expect(after.probes).toEqual([{ at: 7, processes: 2, closeWait: 3, fds: 9, threads: 6 }]);
    expect(probeReadNote({ kind: 'noShell' })).toBe('이 컨테이너에서는 읽을 수 없음');
    expect(probeReadNote({ kind: 'blocked', state: { kind: 'forbidden' } })).toBe(
      'pods/exec 권한이 없어 읽을 수 없음',
    );
    expect(probeReadNote({ kind: 'notRunning' })).toBe('컨테이너가 실행 중이 아님');
  });
});

describe('summaries', () => {
  const stuck = [0, 1, 2, 3, 4, 5].map((minute) => point(minute, 8, 100));
  const healthy = [0, 1, 2, 3, 4, 5].map((minute) => point(minute, 2, 100 + minute));

  it('adds up the pods and says which one is suspected', () => {
    const states = {
      'web/a': { ...emptyPodState(), metrics: stuck },
      'web/b': { ...emptyPodState(), metrics: healthy },
    };
    const summary = summarize(watch(), ['a', 'b'], states);
    expect(summary.usage).toBe('사용 10/16');
    expect(summary.verdicts.map((v) => [v.pod, v.kind])).toEqual([
      ['a', 'stuck'],
      ['a', 'saturated'],
    ]);
    expect(summary.note).toBe('');
  });

  it('does not show an old value or a verdict for a pod whose read failed', () => {
    const states = { 'web/a': { ...emptyPodState(), metrics: stuck, metricNote: '메트릭 없음' } };
    const summary = summarize(watch(), ['a'], states);
    expect(summary.usage).toBe('');
    expect(summary.verdicts).toEqual([]);
    expect(summary.note).toBe('메트릭 없음');
  });

  it('keeps counting the pods that still answer', () => {
    const states = {
      'web/a': { ...emptyPodState(), metrics: stuck, metricNote: '시간 초과' },
      'web/b': { ...emptyPodState(), metrics: healthy },
    };
    const summary = summarize(watch(), ['a', 'b'], states);
    expect(summary.usage).toBe('사용 2/8');
    expect(summary.note).toBe('시간 초과');
  });

  it('tells apart nothing collected yet, no pods, and a workload watched by probe alone', () => {
    expect(summarize(watch(), ['a'], {}).note).toBe('수집 중');
    expect(summarize(watch(), [], {}).note).toBe('실행 중인 파드 없음');
    const probeOnly = watch({ metrics: null, probe: { container: 'app' } });
    const states = { 'web/a': { ...emptyPodState(), probes: [probe(0, 0)] } };
    expect(summarize(probeOnly, ['a'], states).usage).toBe('프로세스 2');
  });

  it('does not show an old process count for a pod whose probe failed', () => {
    const probeOnly = watch({ metrics: null, probe: { container: 'app' } });
    const states = {
      'web/a': { ...emptyPodState(), probes: [probe(0, 0)], probeNote: '권한 없음' },
    };
    const summary = summarize(probeOnly, ['a'], states);
    expect(summary.usage).toBe('');
    expect(summary.note).toBe('권한 없음');
  });

  it('puts a note in the cell title, since the column can cut it off', () => {
    const states = { 'web/a': { ...emptyPodState(), metricNote: '메트릭 없음 (연결 거부)' } };
    const cell = workerCells([summarize(watch(), ['a'], states)]).get('ns:web/wl:Deployment/api');
    expect(cell?.text).toBe('메트릭 없음 (연결 거부)');
    expect(cell?.title).toBe('메트릭 없음 (연결 거부)');
  });

  it('shows the total as unknown when it is missing', () => {
    const states = {
      'web/a': { ...emptyPodState(), metrics: [{ ...point(0, 3, 1), total: null }] },
    };
    expect(summarize(watch(), ['a'], states).usage).toBe('사용 3');
  });

  it('fills the tree cell under the workload row', () => {
    const states = { 'web/a': { ...emptyPodState(), metrics: stuck } };
    const cells = workerCells([summarize(watch(), ['a'], states)]);
    const cell = cells.get('ns:web/wl:Deployment/api');
    expect(cell?.text).toBe('사용 8/8');
    expect(cell?.suspect).toBe(true);
    expect(cell?.title).toContain('a: 반환 안 됨 의심');
  });

  it('words the verdict with how long it has lasted', () => {
    const now = start + 12 * MIN;
    expect(verdictLine({ kind: 'stuck', since: start }, now)).toBe('반환 안 됨 의심 · 12분째');
    expect(verdictLine({ kind: 'leak', since: start }, now)).toBe('누수 의심');
  });
});

const kubePod = (name: string, over: Partial<KubePod> = {}): KubePod => ({
  namespace: 'web',
  name,
  node: 'n1',
  phase: 'Running',
  reason: '',
  created: '',
  deleting: false,
  ownerKind: 'ReplicaSet',
  ownerName: 'api-abc',
  labels: { 'pod-template-hash': 'abc' },
  defaultContainer: '',
  containerCount: 1,
  cpuRequest: null,
  memoryRequest: null,
  cpuLimit: null,
  memoryLimit: null,
  initContainers: [],
  containers: [],
  ...over,
});

describe('what gets read', () => {
  it('reads only the running pods of watched workloads', () => {
    const pods = [
      kubePod('api-1'),
      kubePod('api-2', { phase: 'Pending' }),
      kubePod('api-3', { deleting: true }),
      kubePod('other-1', { ownerName: 'other-abc' }),
      kubePod('bare', { ownerKind: '', ownerName: '' }),
    ];
    const { tasks, podsByWatch, capped } = watchTargets([watch()], pods);
    expect(tasks.map((task) => task.pod)).toEqual(['api-1']);
    expect(podsByWatch.get('web/Deployment/api')).toEqual(['api-1']);
    expect(capped).toBe(0);
  });

  it('reads nothing when nothing is watched', () => {
    expect(watchTargets([], [kubePod('api-1')]).tasks).toEqual([]);
  });

  it('makes a task for each way the workload is watched', () => {
    const both = watch({ probe: { container: 'app' } });
    expect(watchTargets([both], [kubePod('api-1')]).tasks.map((task) => task.kind)).toEqual([
      'metrics',
      'probe',
    ]);
  });

  it('stops at the pod limit and counts what it left out', () => {
    const pods = Array.from({ length: MAX_WATCHED_PODS + 7 }, (_, n) => kubePod(`api-${n}`));
    const { tasks, capped } = watchTargets([watch()], pods);
    expect(tasks).toHaveLength(MAX_WATCHED_PODS);
    expect(capped).toBe(7);
  });

  it('leaves later watches without room once the limit is reached', () => {
    const first = Array.from({ length: MAX_WATCHED_PODS }, (_, n) => kubePod(`api-${n}`));
    const later = kubePod('z-1', { ownerName: 'z-abc' });
    const second = watch({ key: 'web/Deployment/z', name: 'z' });
    const result = watchTargets([watch(), second], [...first, later]);
    expect(result.podsByWatch.get('web/Deployment/z')).toEqual([]);
    expect(result.capped).toBe(1);
  });
});

describe('the read schedule', () => {
  const { tasks } = watchTargets(
    [watch()],
    Array.from({ length: 6 }, (_, n) => kubePod(`api-${n}`)),
  );

  it('starts new tasks at once, four at a time', () => {
    expect(dueTasks(tasks, {}, 0, 4)).toHaveLength(4);
  });

  it('never starts a task that is still running or goes past the limit', () => {
    let schedule = {};
    for (const task of tasks.slice(0, 3)) schedule = taskStarted(schedule, task.id);
    const due = dueTasks(tasks, schedule, 0, 4);
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe(tasks[3].id);
  });

  it('waits a period after each finished read', () => {
    const task = tasks[0];
    const schedule = taskFinished(taskStarted({}, task.id), task, 1000, 10, { kind: 'ready' });
    expect(dueTasks([task], schedule, 15_999, 4)).toEqual([]);
    expect(dueTasks([task], schedule, 16_000, 4)).toEqual([task]);
    expect(nextTaskIn([task], schedule, 6000)).toBe(10_000);
  });

  it('repeats a probe no faster than every 30 seconds', () => {
    expect(taskDelay('probe', 0, { kind: 'ready' })).toBe(30_000);
    expect(taskDelay('metrics', 0, { kind: 'ready' })).toBe(15_000);
  });

  it('stretches for a slow cluster and backs off at a limit', () => {
    expect(taskDelay('metrics', 10_000, { kind: 'ready' })).toBe(30_000);
    expect(taskDelay('metrics', 1, { kind: 'timedOut' })).toBe(60_000);
    expect(taskDelay('probe', 1, { kind: 'tooLarge' })).toBe(120_000);
    expect(taskDelay('probe', 100_000, { kind: 'timedOut' })).toBe(120_000);
  });

  it('has nothing to wait for without tasks', () => {
    expect(nextTaskIn([], {}, 0)).toBeNull();
  });
});
