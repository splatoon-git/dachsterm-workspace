import { describe, expect, it } from 'vitest';
import {
  buildDashboard,
  LIST_LIMIT,
  podCounts,
  resources,
  share,
  TOP_LIMIT,
  topConsumers,
  troubles,
  underReady,
  workloadCounts,
} from './dashboard';
import { advanceHistory, emptyHistory, TREND_SAMPLES } from './dashboardHistory';
import { recentWarnings } from './dashboardWarnings';
import { applySnapshot, emptySnapshots, type SnapshotStore } from './polling';
import type {
  ContainerState,
  KubeEvent,
  KubeNode,
  KubePod,
  KubeWorkload,
  Snapshot,
  SnapshotData,
} from './snapshotTypes';
import { nodeSection } from './tree';
import { podViews } from './treePods';

const NOW = Date.parse('2026-11-08T12:00:00Z');
const MINUTE = 60_000;

const container = (patch: Partial<ContainerState> = {}): ContainerState => ({
  name: 'app',
  ready: true,
  restarts: 0,
  waiting: '',
  terminated: '',
  lastReason: '',
  lastFinished: '',
  lastExitCode: null,
  ...patch,
});

const pod = (name: string, patch: Partial<KubePod> = {}): KubePod => ({
  namespace: 'web',
  name,
  node: 'n1',
  phase: 'Running',
  reason: '',
  created: '2026-11-08T11:00:00Z',
  deleting: false,
  ownerKind: '',
  ownerName: '',
  labels: {},
  containerCount: 1,
  cpuRequest: null,
  memoryRequest: null,
  cpuLimit: null,
  memoryLimit: null,
  initContainers: [],
  containers: [container()],
  ...patch,
});

const node = (name: string, patch: Partial<KubeNode> = {}): KubeNode => ({
  name,
  ready: true,
  unschedulable: false,
  cpuAllocatable: 4000,
  memoryAllocatable: 8000,
  ...patch,
});

const views = (pods: KubePod[], usage: { name: string; cpu: number; memory: number }[] = []) =>
  podViews(
    pods,
    usage.map((item) => ({ namespace: 'web', ...item })),
    [],
    NOW,
  );

const answer = (data: SnapshotData, collectedAt = NOW): Snapshot => ({
  state: { kind: 'ready' },
  data,
  collectedAt,
  elapsedMs: 1,
});

function storeOf(...data: SnapshotData[]): SnapshotStore {
  return data.reduce<SnapshotStore>(
    (store, item) => applySnapshot(store, item.kind, answer(item)),
    emptySnapshots(),
  );
}

describe('resources', () => {
  const section = (nodes: KubeNode[], usage = [{ name: 'n1', cpu: 1000, memory: 2000 }]) =>
    nodeSection(nodes, usage, [])!;

  it('adds usage, requests and allocatable across nodes', () => {
    const result = resources(section([node('n1'), node('n2')]), [
      pod('a', { cpuRequest: 500, memoryRequest: 1000 }),
      pod('b', { node: 'n2', cpuRequest: 250 }),
    ]);
    expect(result.cpu).toEqual({ used: 1000, requested: 750, allocatable: 8000 });
    expect(result.memory).toEqual({ used: 2000, requested: 1000, allocatable: 16000 });
  });

  it('counts only requests that hold room on a node', () => {
    const result = resources(section([node('n1')]), [
      pod('running', { cpuRequest: 100 }),
      pod('done', { phase: 'Succeeded', cpuRequest: 1000 }),
      pod('failed', { phase: 'Failed', cpuRequest: 1000 }),
      pod('unscheduled', { node: '', phase: 'Pending', cpuRequest: 1000 }),
    ]);
    expect(result.cpu.requested).toBe(100);
  });

  it('leaves usage unknown without metrics and requests unknown without pods', () => {
    const noMetrics = resources(section([node('n1')], []), []);
    expect(noMetrics.cpu.used).toBeNull();
    expect(noMetrics.cpu.requested).toBe(0);
    expect(resources(section([node('n1')]), null).cpu.requested).toBeNull();
  });

  it('puts broken nodes first, then the fullest', () => {
    const usage = [
      { name: 'quiet', cpu: 100, memory: 1 },
      { name: 'busy', cpu: 3000, memory: 1 },
      { name: 'down', cpu: 0, memory: 0 },
    ];
    const result = resources(
      section([node('quiet'), node('busy'), node('down', { ready: false })], usage),
      [],
    );
    expect(result.nodes.items.map((bar) => bar.name)).toEqual(['down', 'busy', 'quiet']);
  });

  it('stops a long node list and says how many are left', () => {
    const many = Array.from({ length: LIST_LIMIT + 4 }, (_, at) => node(`n${at}`));
    const result = resources(section(many, []), []);
    expect(result.nodes.items).toHaveLength(LIST_LIMIT);
    expect(result.nodes.more).toBe(4);
  });
});

describe('share', () => {
  it('is empty when either side is unknown or the total is zero', () => {
    expect(share(null, 10)).toBeNull();
    expect(share(5, null)).toBeNull();
    expect(share(5, 0)).toBeNull();
    expect(share(5, 10)).toBe(50);
  });
});

describe('counts', () => {
  it('counts pods by status with the worst first', () => {
    const result = podCounts(
      views([
        pod('a'),
        pod('b'),
        pod('c', { containers: [container({ ready: false, waiting: 'CrashLoopBackOff' })] }),
        pod('d', { phase: 'Pending', containers: [] }),
      ]),
    );
    expect(result.total).toBe(4);
    expect(result.statuses.map((item) => item.status)).toEqual([
      'CrashLoopBackOff',
      'Pending',
      'Running',
    ]);
  });

  it('counts ready workloads by kind', () => {
    const workload = (kind: string, ready: number, desired: number): KubeWorkload => ({
      kind,
      namespace: 'web',
      name: `${kind}-${ready}`,
      desired,
      ready,
    });
    expect(
      workloadCounts([
        workload('Deployment', 2, 2),
        workload('Deployment', 1, 3),
        workload('StatefulSet', 0, 0),
      ]),
    ).toEqual([
      { kind: 'Deployment', ready: 1, total: 2 },
      { kind: 'StatefulSet', ready: 1, total: 1 },
    ]);
  });
});

describe('troubles', () => {
  const restarted = (name: string, minutesAgo: number, patch: Partial<ContainerState> = {}) =>
    pod(name, {
      containers: [
        container({
          restarts: 2,
          lastReason: 'Error',
          lastExitCode: 1,
          lastFinished: new Date(NOW - minutesAgo * MINUTE).toISOString(),
          ...patch,
        }),
      ],
    });

  it('leaves healthy pods out and names the reason and exit code', () => {
    const rows = troubles(
      views([pod('fine'), restarted('oom', 5, { lastReason: 'OOMKilled', lastExitCode: 137 })]),
      new Map(),
    );
    expect(rows.map((row) => row.name)).toEqual(['oom']);
    expect(rows[0].reason).toBe('OOMKilled (종료 코드 137)');
    expect(rows[0].lastAt).toBe(NOW - 5 * MINUTE);
    expect(rows[0].target).toEqual({ type: 'pod', namespace: 'web', name: 'oom' });
  });

  it('copes with a reason alone, a code alone, and neither', () => {
    const reasonOnly = troubles(
      views([restarted('a', 1, { lastExitCode: null, lastReason: 'Evicted' })]),
      new Map(),
    );
    expect(reasonOnly[0].reason).toBe('Evicted');
    const codeOnly = troubles(views([restarted('b', 1, { lastReason: '' })]), new Map());
    expect(codeOnly[0].reason).toBe('종료 코드 1');
    const neither = troubles(
      views([pod('c', { containers: [container({ ready: false, waiting: 'ImagePullBackOff' })] })]),
      new Map(),
    );
    expect(neither[0].reason).toBe('');
    expect(neither[0].status).toBe('ImagePullBackOff');
  });

  it('does not repeat a status that the reason already says', () => {
    const detail = (patch: Partial<ContainerState>) =>
      troubles(views([restarted('a', 1, { ready: false, ...patch })]), new Map())[0].detail;
    expect(detail({ terminated: 'OOMKilled', lastReason: 'OOMKilled', lastExitCode: 137 })).toBe(
      'OOMKilled (종료 코드 137)',
    );
    expect(detail({ waiting: 'CrashLoopBackOff' })).toBe('CrashLoopBackOff · Error (종료 코드 1)');
    expect(detail({ waiting: 'ImagePullBackOff', lastReason: '', lastExitCode: null })).toBe(
      'ImagePullBackOff',
    );
  });

  it('names the container when a pod has several and uses the newest stop', () => {
    const rows = troubles(
      views([
        pod('multi', {
          containers: [
            container({
              name: 'old',
              restarts: 1,
              lastReason: 'Error',
              lastFinished: new Date(NOW - 30 * MINUTE).toISOString(),
            }),
            container({
              name: 'new',
              restarts: 1,
              lastReason: 'OOMKilled',
              lastFinished: new Date(NOW - MINUTE).toISOString(),
            }),
          ],
        }),
      ]),
      new Map(),
    );
    expect(rows[0].reason).toBe('new: OOMKilled');
  });

  it('counts restarts since the base and never goes negative', () => {
    const list = views([restarted('more', 1, { restarts: 7 }), restarted('fewer', 1)]);
    const rows = troubles(
      list,
      new Map([
        ['web/more', 4],
        ['web/fewer', 9],
      ]),
    );
    const increase = Object.fromEntries(rows.map((row) => [row.name, row.increase]));
    expect(increase).toEqual({ more: 3, fewer: 0 });
  });

  it('keeps an old restart that grew since the tab opened and marks it a warning', () => {
    const old = pod('old', {
      containers: [
        container({
          restarts: 3,
          lastReason: 'Error',
          lastFinished: new Date(NOW - 5 * 60 * MINUTE).toISOString(),
        }),
      ],
    });
    expect(troubles(views([old]), new Map([['web/old', 3]]))).toHaveLength(0);
    const [row] = troubles(views([old]), new Map([['web/old', 2]]));
    expect(row.increase).toBe(1);
    expect(row.health).toBe('warn');
  });

  it('puts errors first, then the newest', () => {
    const rows = troubles(
      views([
        restarted('warn-new', 1),
        restarted('warn-old', 50),
        pod('err', { containers: [container({ ready: false, waiting: 'CrashLoopBackOff' })] }),
      ]),
      new Map(),
    );
    expect(rows.map((row) => row.name)).toEqual(['err', 'warn-new', 'warn-old']);
  });
});

describe('topConsumers', () => {
  const pods = [
    pod('small', { cpuRequest: 500, memoryRequest: 90, cpuLimit: 1000 }),
    pod('big', { cpuRequest: 100, memoryRequest: 100 }),
  ];
  const usage = [
    { name: 'small', cpu: 10, memory: 20 },
    { name: 'big', cpu: 300, memory: 200 },
  ];

  it('ranks by live use and compares with the limit', () => {
    const top = topConsumers(views(pods, usage), true);
    expect(top.basis).toBe('usage');
    expect(top.cpu.map((row) => row.name)).toEqual(['big', 'small']);
    expect(top.cpu[1].ofLimit).toBe(1);
    expect(top.cpu[0].ofLimit).toBeNull();
  });

  it('ranks by requests without metrics', () => {
    const top = topConsumers(views(pods), false);
    expect(top.basis).toBe('request');
    expect(top.cpu.map((row) => row.name)).toEqual(['small', 'big']);
    expect(top.memory.map((row) => row.name)).toEqual(['big', 'small']);
  });

  it('skips pods using nothing and stops at ten', () => {
    const many = Array.from({ length: TOP_LIMIT + 5 }, (_, at) => pod(`p${at}`));
    const used = many.map((item, at) => ({ name: item.name, cpu: at, memory: 0 }));
    const top = topConsumers(views(many, used), true);
    expect(top.cpu).toHaveLength(TOP_LIMIT);
    expect(top.cpu[0].name).toBe(`p${TOP_LIMIT + 4}`);
    expect(top.memory).toHaveLength(0);
  });
});

describe('underReady', () => {
  it('lists short workloads, the largest gap first', () => {
    const rows = underReady([
      { kind: 'Deployment', namespace: 'web', name: 'ok', desired: 2, ready: 2 },
      { kind: 'Deployment', namespace: 'web', name: 'one', desired: 3, ready: 2 },
      { kind: 'StatefulSet', namespace: 'db', name: 'two', desired: 2, ready: 0 },
    ]);
    expect(rows.map((row) => row.name)).toEqual(['two', 'one']);
    expect(rows[0].target).toEqual({
      type: 'workload',
      kind: 'StatefulSet',
      namespace: 'db',
      name: 'two',
    });
  });
});

describe('recentWarnings', () => {
  const event = (patch: Partial<KubeEvent>): KubeEvent => ({
    namespace: 'web',
    objectKind: 'Pod',
    objectName: 'api-1',
    reason: 'BackOff',
    time: new Date(NOW - MINUTE).toISOString(),
    message: 'text',
    ...patch,
  });

  it('keeps the last ten minutes, newest first', () => {
    const rows = recentWarnings(
      [
        event({ reason: 'older', time: new Date(NOW - 9 * MINUTE).toISOString() }),
        event({ reason: 'expired', time: new Date(NOW - 11 * MINUTE).toISOString() }),
        event({ reason: 'newest' }),
        event({ reason: 'no time', time: '' }),
      ],
      NOW,
    );
    expect(rows.map((row) => row.reason)).toEqual(['newest', 'older']);
  });

  it('points at the object the event is about', () => {
    const target = (patch: Partial<KubeEvent>) => recentWarnings([event(patch)], NOW)[0].target;
    expect(target({})).toEqual({ type: 'pod', namespace: 'web', name: 'api-1' });
    expect(target({ objectKind: 'Deployment', objectName: 'api' })).toEqual({
      type: 'workload',
      kind: 'Deployment',
      namespace: 'web',
      name: 'api',
    });
    expect(target({ objectKind: 'Node', objectName: 'n1', namespace: 'default' })).toEqual({
      type: 'node',
      name: 'n1',
    });
    expect(target({ objectKind: 'Ingress' })).toEqual({ type: 'namespace', namespace: 'web' });
    expect(target({ objectKind: 'PersistentVolume', namespace: '' })).toBeNull();
  });
});

describe('advanceHistory', () => {
  const restarts = (name: string, count: number) =>
    pod(name, { containers: [container({ restarts: count })] });
  const podsStore = (at: number, pods: KubePod[], base = emptySnapshots()) =>
    applySnapshot(base, 'pods', answer({ kind: 'pods', items: pods }, at));

  it('takes pods of the first snapshot as they are', () => {
    const history = advanceHistory(emptyHistory(), podsStore(1, [restarts('a', 5)]));
    expect(history.restartBase.get('web/a')).toBe(5);
  });

  it('counts every restart of a pod that appears later', () => {
    const first = advanceHistory(emptyHistory(), podsStore(1, []));
    const next = advanceHistory(first, podsStore(2, [restarts('new', 3)]));
    expect(next.restartBase.get('web/new')).toBe(0);
  });

  it('keeps the base as the count grows and resets for a replaced pod', () => {
    let history = advanceHistory(emptyHistory(), podsStore(1, [restarts('a', 5)]));
    history = advanceHistory(history, podsStore(2, [restarts('a', 9)]));
    expect(history.restartBase.get('web/a')).toBe(5);
    history = advanceHistory(history, podsStore(3, [restarts('a', 1)]));
    expect(history.restartBase.get('web/a')).toBe(0);
  });

  it('forgets pods that left, so the map follows the cluster', () => {
    let history = advanceHistory(emptyHistory(), podsStore(1, [restarts('a', 1)]));
    history = advanceHistory(history, podsStore(2, []));
    expect(history.restartBase.size).toBe(0);
  });

  it('is unchanged when nothing new arrived', () => {
    const store = podsStore(1, [restarts('a', 1)]);
    const history = advanceHistory(emptyHistory(), store);
    expect(advanceHistory(history, store)).toBe(history);
    const failed = applySnapshot(store, 'pods', {
      state: { kind: 'unreachable' },
      data: null,
      collectedAt: 9,
      elapsedMs: 1,
    });
    expect(advanceHistory(history, failed)).toBe(history);
  });

  const usageStore = (at: number) => {
    const store = applySnapshot(
      emptySnapshots(),
      'nodes',
      answer({ kind: 'nodes', items: [node('n1')] }, at),
    );
    return applySnapshot(
      store,
      'nodeUsage',
      answer({ kind: 'nodeUsage', items: [{ name: 'n1', cpu: 1000, memory: 2000 }] }, at),
    );
  };

  it('adds one percentage sample for each usage reading', () => {
    let history = advanceHistory(emptyHistory(), usageStore(1));
    history = advanceHistory(history, usageStore(1));
    expect(history.trend).toEqual([{ at: 1, cpu: 25, memory: 25 }]);
  });

  it('keeps at most the newest samples', () => {
    let history = emptyHistory();
    for (let at = 1; at <= TREND_SAMPLES + 3; at++)
      history = advanceHistory(history, usageStore(at));
    expect(history.trend).toHaveLength(TREND_SAMPLES);
    expect(history.trend[0].at).toBe(4);
  });

  it('adds no sample without metrics', () => {
    const store = applySnapshot(
      applySnapshot(emptySnapshots(), 'nodes', answer({ kind: 'nodes', items: [node('n1')] })),
      'nodeUsage',
      { state: { kind: 'metricsMissing' }, data: null, collectedAt: NOW, elapsedMs: 1 },
    );
    expect(advanceHistory(emptyHistory(), store).trend).toHaveLength(0);
  });
});

describe('buildDashboard', () => {
  it('waits, and then gives the reason instead of reading as no problem', () => {
    const waiting = buildDashboard(emptySnapshots(), emptyHistory());
    expect(waiting.troubles).toEqual({ state: 'waiting' });
    const forbidden = applySnapshot(emptySnapshots(), 'pods', {
      state: { kind: 'forbidden' },
      data: null,
      collectedAt: NOW,
      elapsedMs: 1,
    });
    expect(buildDashboard(forbidden, emptyHistory()).troubles).toEqual({
      state: 'missing',
      reason: '권한 없음',
    });
  });

  it('shows an empty result as data', () => {
    const board = buildDashboard(
      storeOf(
        { kind: 'pods', items: [] },
        { kind: 'workloads', items: [] },
        { kind: 'events', items: [] },
        { kind: 'nodes', items: [] },
      ),
      emptyHistory(),
    );
    expect(board.troubles).toEqual({ state: 'ready', value: { items: [], more: 0 } });
    expect(board.under).toEqual({ state: 'ready', value: { items: [], more: 0 } });
    expect(board.warnings).toEqual({ state: 'ready', value: { items: [], more: 0 } });
    expect(board.nodes).toEqual({ state: 'ready', value: { ready: 0, total: 0 } });
  });

  it('explains missing metrics and falls back to requests', () => {
    const store = applySnapshot(
      applySnapshot(storeOf({ kind: 'pods', items: [pod('a', { cpuRequest: 10 })] }), 'podUsage', {
        state: { kind: 'metricsMissing' },
        data: null,
        collectedAt: NOW,
        elapsedMs: 1,
      }),
      'nodeUsage',
      { state: { kind: 'metricsMissing' }, data: null, collectedAt: NOW, elapsedMs: 1 },
    );
    const board = buildDashboard(store, emptyHistory());
    expect(board.usageNote).toContain('metrics-server');
    expect(board.top).toMatchObject({ state: 'ready', value: { basis: 'request' } });
  });

  it('flags data kept after a failed poll', () => {
    const store = applySnapshot(storeOf({ kind: 'pods', items: [] }), 'pods', {
      state: { kind: 'unreachable' },
      data: null,
      collectedAt: NOW + 1,
      elapsedMs: 1,
    });
    expect(buildDashboard(store, emptyHistory()).stale).toBe('클러스터 연결 불가');
    expect(buildDashboard(storeOf({ kind: 'pods', items: [] }), emptyHistory()).stale).toBe('');
  });
});
