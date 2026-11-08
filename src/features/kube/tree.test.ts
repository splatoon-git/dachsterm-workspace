import { describe, expect, it } from 'vitest';
import {
  buildForest,
  nextGrouping,
  nextSort,
  nodeSection,
  sortForest,
  treeRows,
  type TreeGroup,
} from './tree';
import {
  filterActive,
  matches,
  parseFilter,
  podStatus,
  podViews,
  totalsOf,
  type PodView,
} from './treePods';
import { formatAge, formatCpu, formatMemory, resourceCell, visibleRange } from './treeFormat';
import type { ContainerState, KubePod, KubeService } from './snapshotTypes';

const NOW = Date.parse('2026-11-08T12:00:00Z');

const container = (patch: Partial<ContainerState> = {}): ContainerState => ({
  name: 'app',
  ready: true,
  restarts: 0,
  waiting: '',
  terminated: '',
  lastReason: '',
  lastFinished: '',
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
  ownerKind: 'ReplicaSet',
  ownerName: 'api-7f9c',
  labels: { app: 'api', 'pod-template-hash': '7f9c' },
  containerCount: 1,
  cpuRequest: 100,
  memoryRequest: 1000,
  cpuLimit: 200,
  memoryLimit: 2000,
  initContainers: [],
  containers: [container()],
  ...patch,
});

const service = (name: string, selector: Record<string, string>): KubeService => ({
  namespace: 'web',
  name,
  serviceType: 'ClusterIP',
  selector,
  readyEndpoints: 1,
  notReadyEndpoints: 0,
});

const views = (pods: KubePod[], services: KubeService[] = []) => podViews(pods, [], services, NOW);
const view = (one: KubePod) => views([one])[0];
const names = (group: TreeGroup) => group.pods.map((item) => item.pod.name);

describe('status', () => {
  const statusOf = (patch: Partial<KubePod>) => podStatus(pod('p', patch));

  it('reads like kubectl', () => {
    expect(statusOf({})).toBe('Running');
    expect(statusOf({ deleting: true })).toBe('Terminating');
    expect(statusOf({ reason: 'Evicted', phase: 'Failed' })).toBe('Evicted');
    expect(statusOf({ phase: 'Succeeded', containers: [] })).toBe('Completed');
    expect(
      statusOf({ containers: [container({ ready: false, waiting: 'CrashLoopBackOff' })] }),
    ).toBe('CrashLoopBackOff');
    expect(statusOf({ containers: [container({ ready: false, terminated: 'Error' })] })).toBe(
      'Error',
    );
  });

  it('shows what an init container is doing', () => {
    const waiting = container({ ready: false, waiting: 'ImagePullBackOff' });
    expect(statusOf({ phase: 'Pending', initContainers: [waiting] })).toBe('Init:ImagePullBackOff');
    expect(
      statusOf({
        phase: 'Pending',
        initContainers: [container(), container({ ready: false })],
      }),
    ).toBe('Init:1/2');
  });

  it('does not call a finished sidecar or a completed container a failure', () => {
    expect(statusOf({ containers: [container({ ready: false, terminated: 'Completed' })] })).toBe(
      'Running',
    );
  });

  it('separates what is passing through from what is broken', () => {
    expect(view(pod('a')).health).toBe('ok');
    expect(view(pod('a', { phase: 'Succeeded', containers: [] })).health).toBe('ok');
    expect(view(pod('a', { containers: [container({ ready: false })] })).health).toBe('warn');
    expect(view(pod('a', { phase: 'Pending', containers: [] })).health).toBe('warn');
    expect(
      view(pod('a', { containers: [container({ ready: false, waiting: 'ContainerCreating' })] }))
        .health,
    ).toBe('warn');
    expect(
      view(pod('a', { containers: [container({ ready: false, waiting: 'ImagePullBackOff' })] }))
        .health,
    ).toBe('error');
  });
});

describe('pod values', () => {
  it('counts readiness and restarts across containers', () => {
    const result = view(
      pod('a', {
        containerCount: 3,
        containers: [container({ restarts: 2 }), container({ ready: false, restarts: 3 })],
      }),
    );
    expect([result.ready, result.total, result.restarts]).toEqual([1, 3, 5]);
  });

  it('calls a restart recent for one hour only', () => {
    const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
    const recent = (patch: Partial<ContainerState>) =>
      view(pod('a', { containers: [container(patch)] })).recentRestart;
    expect(recent({ restarts: 1, lastFinished: at(59) })).toBe(true);
    expect(recent({ restarts: 1, lastFinished: at(61) })).toBe(false);
    expect(recent({ restarts: 0, lastFinished: at(1) })).toBe(false);
    expect(recent({ restarts: 1, lastFinished: '' })).toBe(false);
  });

  it('finds OOMKilled in the last or current state', () => {
    expect(view(pod('a', { containers: [container({ lastReason: 'OOMKilled' })] })).oom).toBe(true);
    expect(view(pod('a', { containers: [container({ terminated: 'OOMKilled' })] })).oom).toBe(true);
    expect(view(pod('a')).oom).toBe(false);
  });

  it('uses the usage of the same namespace and name only', () => {
    const [same, other] = podViews(
      [pod('a'), pod('a', { namespace: 'other' })],
      [{ namespace: 'web', name: 'a', cpu: 7, memory: 9 }],
      [],
      NOW,
    );
    expect([same.cpu, same.memory]).toEqual([7, 9]);
    expect([other.cpu, other.memory]).toEqual([null, null]);
  });

  it('matches services by selector inside the namespace', () => {
    const [result] = views(
      [pod('a', { labels: { app: 'api', tier: 'front' } })],
      [
        service('api', { app: 'api' }),
        service('both', { app: 'api', tier: 'front' }),
        service('other', { app: 'web' }),
        service('no-selector', {}),
        { ...service('elsewhere', { app: 'api' }), namespace: 'other' },
      ],
    );
    expect(result.services.map((item) => item.name)).toEqual(['api', 'both']);
  });
});

describe('filter', () => {
  const sample = view(pod('api-1', { node: 'gpu-3', labels: { app: 'checkout' } }));
  const hit = (text: string, target: PodView = sample) => matches(target, parseFilter(text, false));

  it('treats spaces as AND', () => {
    expect(hit('api gpu')).toBe(true);
    expect(hit('api nope')).toBe(false);
  });

  it('excludes with an exclamation mark and ignores one still being typed', () => {
    expect(hit('!gpu')).toBe(false);
    expect(hit('api !zzz')).toBe(true);
    expect(hit('!')).toBe(true);
    expect(filterActive(parseFilter('!', false))).toBe(false);
  });

  it('ignores case and also searches labels, status and service names', () => {
    expect(hit('API CHECKOUT running')).toBe(true);
    const [withService] = views([pod('p')], [service('Payments', { app: 'api' })]);
    expect(hit('payments', withService)).toBe(true);
  });

  it('collects abnormal pods, recent restarts and OOMKilled for problems only', () => {
    const only = parseFilter('', true);
    expect(filterActive(only)).toBe(true);
    expect(matches(view(pod('ok')), only)).toBe(false);
    expect(matches(view(pod('bad', { phase: 'Pending', containers: [] })), only)).toBe(true);
    const restarted = new Date(NOW - 60_000).toISOString();
    expect(
      matches(
        view(pod('r', { containers: [container({ restarts: 1, lastFinished: restarted })] })),
        only,
      ),
    ).toBe(true);
    expect(
      matches(view(pod('o', { containers: [container({ lastReason: 'OOMKilled' })] })), only),
    ).toBe(true);
  });
});

describe('grouping', () => {
  it('groups by service and leaves the rest under the catch-all at the end', () => {
    const [ns] = buildForest(
      views(
        [pod('b'), pod('a'), pod('c', { labels: { app: 'none' } })],
        [service('zeta', { app: 'api' })],
      ),
      'service',
      [],
      [],
    );
    expect(ns.label).toBe('web');
    expect(ns.groups.map((group) => group.label)).toEqual(['zeta', '서비스 없음']);
    expect(names(ns.groups[0])).toEqual(['a', 'b']);
    expect(names(ns.groups[1])).toEqual(['c']);
  });

  it('lists a pod under each of its services and counts it once above them', () => {
    const [ns] = buildForest(
      views([pod('a')], [service('one', { app: 'api' }), service('two', { app: 'api' })]),
      'service',
      [],
      [],
    );
    expect(ns.groups.map(names)).toEqual([['a'], ['a']]);
    expect(ns.count).toBe(1);
    expect(ns.totals.cpuRequest).toBe(100);
  });

  it('warns on a service with no ready endpoint', () => {
    const [ns] = buildForest(
      views([pod('a')], [{ ...service('s', { app: 'api' }), readyEndpoints: 0 }]),
      'service',
      [],
      [],
    );
    expect(ns.groups[0].health).toBe('warn');
    expect(ns.groups[0].note).toBe('엔드포인트 준비 0/0');
  });

  it('resolves a ReplicaSet to its Deployment and keeps other owners as they are', () => {
    const [ns] = buildForest(
      views([
        pod('a'),
        pod('s-0', { ownerKind: 'StatefulSet', ownerName: 's' }),
        pod('bare', { ownerKind: '', ownerName: '' }),
      ]),
      'workload',
      [
        { kind: 'Deployment', namespace: 'web', name: 'api', desired: 3, ready: 1 },
        { kind: 'StatefulSet', namespace: 'web', name: 's', desired: 1, ready: 1 },
      ],
      [],
    );
    expect(ns.groups.map((group) => group.label)).toEqual([
      'Deployment/api',
      'StatefulSet/s',
      '단독 파드',
    ]);
    expect(ns.groups[0].note).toBe('준비 1/3');
    expect(ns.groups[0].health).toBe('warn');
    expect(ns.groups[1].health).toBe('ok');
  });

  it('names the Deployment from the hash label, before the workload list has arrived', () => {
    const [ns] = buildForest(views([pod('a')]), 'workload', [], []);
    expect(ns.groups[0].label).toBe('Deployment/api');
  });

  it('keeps a ReplicaSet whose pods have no hash label', () => {
    const [ns] = buildForest(views([pod('a', { labels: {} })]), 'workload', [], []);
    expect(ns.groups[0].label).toBe('ReplicaSet/api-7f9c');
  });

  it('cycles through the groupings', () => {
    expect(nextGrouping('workload')).toBe('service');
    expect(nextGrouping('service')).toBe('node');
    expect(nextGrouping('node')).toBe('workload');
  });

  it('groups by node, then namespace, with unscheduled pods last', () => {
    const forest = buildForest(
      views([pod('a'), pod('b', { node: 'n2', namespace: 'kube' }), pod('c', { node: '' })]),
      'node',
      [],
      [
        { name: 'n1', ready: false, unschedulable: false, cpuAllocatable: 1, memoryAllocatable: 1 },
        { name: 'n2', ready: true, unschedulable: true, cpuAllocatable: 1, memoryAllocatable: 1 },
      ],
    );
    expect(forest.map((group) => group.label)).toEqual(['n1', 'n2', '노드 미배정']);
    expect(forest[0].groups[0].label).toBe('web');
    expect(names(forest[0].groups[0])).toEqual(['a']);
    expect([forest[0].note, forest[0].health]).toEqual(['NotReady', 'error']);
    expect([forest[1].note, forest[1].health]).toEqual(['스케줄 중지', 'warn']);
  });
});

describe('totals', () => {
  it('sums pod values and takes the worst health', () => {
    const totals = totalsOf(
      podViews(
        [pod('a'), pod('b', { phase: 'Pending', containers: [], cpuRequest: null })],
        [{ namespace: 'web', name: 'a', cpu: 7, memory: 9 }],
        [],
        NOW,
      ),
    );
    expect(totals.health).toBe('warn');
    expect([totals.ready, totals.total]).toEqual([1, 2]);
    expect([totals.cpu, totals.memory]).toEqual([7, 9]);
    expect(totals.cpuRequest).toBe(100);
    expect(totals.memoryRequest).toBe(2000);
  });

  it('stays unknown rather than zero when nothing is known', () => {
    const totals = totalsOf(views([pod('a', { cpuRequest: null })]));
    expect(totals.cpu).toBeNull();
    expect(totals.cpuRequest).toBeNull();
  });
});

describe('rows', () => {
  const forest = () =>
    buildForest(views([pod('a'), pod('b')], [service('s', { app: 'api' })]), 'service', [], []);

  it('flattens depth first with ids that stay the same between polls', () => {
    const rows = treeRows(null, forest(), new Set(), false);
    expect(rows.map((row) => [row.id, row.depth])).toEqual([
      ['ns:web', 0],
      ['ns:web/svc:s', 1],
      ['ns:web/svc:s/pod:a', 2],
      ['ns:web/svc:s/pod:b', 2],
    ]);
  });

  it('hides what is folded unless a filter is showing it', () => {
    const folded = new Set(['ns:web/svc:s']);
    expect(treeRows(null, forest(), folded, false)).toHaveLength(2);
    expect(treeRows(null, forest(), folded, true)).toHaveLength(4);
  });
});

describe('node group', () => {
  const node = (name: string, ready = true) => ({
    name,
    ready,
    unschedulable: false,
    cpuAllocatable: 4000,
    memoryAllocatable: 2 ** 30,
  });
  const usage = [{ name: 'n1', cpu: 250, memory: 2 ** 20 }];

  it('counts ready nodes and the pods and use of each', () => {
    const section = nodeSection(
      [node('n2', false), node('n1')],
      usage,
      views([pod('a'), pod('b')]),
    );
    expect([section?.ready, section?.total, section?.health]).toEqual([1, 2, 'error']);
    expect(section?.nodes.map((item) => item.node.name)).toEqual(['n1', 'n2']);
    expect(section?.nodes[0]).toMatchObject({ status: 'Ready', pods: 2, cpu: 250 });
    expect(section?.nodes[1]).toMatchObject({ status: 'NotReady', pods: 0, cpu: null });
  });

  it('is absent when no node list arrived', () => {
    expect(nodeSection(null, [], [])).toBeNull();
    expect(nodeSection([], [], [])).toBeNull();
  });

  const expandedRows = (section: ReturnType<typeof nodeSection>, folds: string[] = []) =>
    treeRows(section, [], new Set(folds), false).map((row) => row.id);

  it('starts folded while all is well and opens by choice', () => {
    const section = nodeSection([node('n1')], [], []);
    expect(expandedRows(section)).toEqual(['nodes']);
    const row = treeRows(section, [], new Set(), false)[0];
    expect(row.type === 'nodes' && row.toggle).toBe('nodes:opened');
    expect(expandedRows(section, ['nodes:opened'])).toEqual(['nodes', 'nodes/n1']);
  });

  it('starts open when a node is not ready, even if it was folded while healthy', () => {
    const section = nodeSection([node('n1', false)], [], []);
    expect(expandedRows(section)).toEqual(['nodes', 'nodes/n1']);
    expect(expandedRows(section, ['nodes:opened'])).toEqual(['nodes', 'nodes/n1']);
    expect(expandedRows(section, ['nodes:closed'])).toEqual(['nodes']);
  });
});

describe('sorting', () => {
  const sorted = (column: Parameters<typeof nextSort>[1], descending: boolean) => {
    const [ns] = sortForest(
      buildForest(
        podViews(
          [
            pod('a', { node: 'n2', created: '2026-11-08T10:00:00Z' }),
            pod('b', { node: 'n1', created: '2026-11-08T11:00:00Z', cpuRequest: null }),
            pod('c', { node: 'n3', created: '2026-11-08T09:00:00Z' }),
          ],
          [
            { namespace: 'web', name: 'a', cpu: 5, memory: 1 },
            { namespace: 'web', name: 'c', cpu: 9, memory: 1 },
          ],
          [],
          NOW,
        ),
        'workload',
        [],
        [],
      ),
      { column, descending },
    );
    return ns.groups[0].pods.map((item) => item.pod.name);
  };

  it('starts measures largest first and names A to Z, then reverses', () => {
    const first = nextSort({ column: 'name', descending: false }, 'cpu');
    expect(first).toEqual({ column: 'cpu', descending: true });
    expect(nextSort(first, 'cpu')).toEqual({ column: 'cpu', descending: false });
    expect(nextSort(first, 'node')).toEqual({ column: 'node', descending: false });
  });

  it('sorts pods by the column and keeps unknown values last both ways', () => {
    expect(sorted('cpu', true)).toEqual(['c', 'a', 'b']);
    expect(sorted('cpu', false)).toEqual(['a', 'c', 'b']);
    expect(sorted('node', false)).toEqual(['b', 'a', 'c']);
    expect(sorted('age', true)).toEqual(['c', 'a', 'b']);
  });

  it('falls back to the requested amount without live use', () => {
    const [ns] = sortForest(
      buildForest(
        views([pod('small', { cpuRequest: 10 }), pod('large', { cpuRequest: 90 })]),
        'workload',
        [],
        [],
      ),
      { column: 'cpu', descending: true },
    );
    expect(names(ns.groups[0])).toEqual(['large', 'small']);
  });

  it('keeps catch-all groups last whatever the sort', () => {
    const [ns] = sortForest(
      buildForest(
        views([pod('a'), pod('bare', { ownerKind: '', ownerName: '', cpuRequest: 9000 })]),
        'workload',
        [],
        [],
      ),
      { column: 'cpu', descending: true },
    );
    expect(ns.groups.map((group) => group.label)).toEqual(['Deployment/api', '단독 파드']);
  });

  it('leaves the default order alone', () => {
    const forest = buildForest(views([pod('a')]), 'workload', [], []);
    expect(sortForest(forest, { column: 'name', descending: false })).toBe(forest);
  });
});

describe('virtual range', () => {
  it('covers the viewport with a margin and stays inside the list', () => {
    expect(visibleRange(0, 260, 26, 5000)).toEqual({ first: 0, last: 20 });
    expect(visibleRange(2600, 260, 26, 5000)).toEqual({ first: 90, last: 120 });
    expect(visibleRange(129_740, 260, 26, 5000)).toEqual({ first: 4980, last: 5000 });
    expect(visibleRange(0, 260, 26, 3)).toEqual({ first: 0, last: 3 });
    expect(visibleRange(9000, 260, 26, 0)).toEqual({ first: 336, last: 336 });
  });
});

describe('formats', () => {
  it('prints quantities the way kubectl top does', () => {
    expect(formatCpu(250)).toBe('250m');
    expect(formatCpu(2000)).toBe('2');
    expect(formatCpu(1500)).toBe('1.50');
    expect(formatMemory(512)).toBe('512B');
    expect(formatMemory(1536)).toBe('1.5Ki');
    expect(formatMemory(64 * 2 ** 20)).toBe('64Mi');
    expect(formatMemory(2 ** 30)).toBe('1.0Gi');
  });

  it('prints ages briefly and nothing for a date it cannot read', () => {
    expect(formatAge(5_000)).toBe('5s');
    expect(formatAge(180_000)).toBe('3m');
    expect(formatAge(3 * 3_600_000)).toBe('3h');
    expect(formatAge(3 * 86_400_000)).toBe('3d');
    expect(formatAge(Number.NaN)).toBe('');
  });

  it('shows use, or requests and limits when there is no metrics-server', () => {
    expect(resourceCell(120, 100, 200, formatCpu, true)).toEqual({
      text: '120m',
      title: '요청 100m · 제한 200m',
    });
    expect(resourceCell(null, 100, null, formatCpu, false).text).toBe('100m / -');
    expect(resourceCell(null, 100, 200, formatCpu, true).text).toBe('-');
  });
});
