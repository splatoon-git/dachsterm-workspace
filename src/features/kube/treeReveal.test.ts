import { describe, expect, it } from 'vitest';
import type { KubeNode, KubePod, KubeService, KubeWorkload } from './snapshotTypes';
import { nodeSection, type Grouping } from './tree';
import { parseFilter, podViews } from './treePods';
import { planReveal, type TreeTarget } from './treeReveal';

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
  cpuRequest: null,
  memoryRequest: null,
  cpuLimit: null,
  memoryLimit: null,
  initContainers: [],
  containers: [
    {
      name: 'app',
      ready: true,
      restarts: 0,
      waiting: '',
      terminated: '',
      lastReason: '',
      lastFinished: '',
      lastExitCode: null,
    },
  ],
  ...patch,
});

const service: KubeService = {
  namespace: 'web',
  name: 'api',
  serviceType: 'ClusterIP',
  selector: { app: 'api' },
  readyEndpoints: 1,
  notReadyEndpoints: 0,
};
const workload: KubeWorkload = {
  kind: 'Deployment',
  namespace: 'web',
  name: 'api',
  desired: 2,
  ready: 2,
};
const node: KubeNode = {
  name: 'n1',
  ready: true,
  unschedulable: false,
  cpuAllocatable: 1,
  memoryAllocatable: 1,
};
const idle: KubeNode = { ...node, name: 'idle' };

function plan(
  target: TreeTarget,
  options: {
    grouping?: Grouping;
    collapsed?: string[];
    query?: string;
    pods?: KubePod[];
    nodes?: KubeNode[];
  } = {},
) {
  const nodes = options.nodes ?? [node];
  const views = podViews(options.pods ?? [pod('api-1'), pod('api-2')], [], [service], 0);
  return planReveal(target, {
    views,
    workloads: [workload],
    nodes,
    section: nodeSection(nodes, [], views),
    grouping: options.grouping ?? 'workload',
    collapsed: new Set(options.collapsed ?? []),
    filter: parseFilter(options.query ?? '', false),
  });
}

const apiPod: TreeTarget = { type: 'pod', namespace: 'web', name: 'api-1' };
const apiGroup = 'ns:web/wl:Deployment/api';

describe('planReveal', () => {
  it('selects a pod under its workload and opens what folds it', () => {
    const result = plan(apiPod, { collapsed: ['ns:web', apiGroup, 'other'] });
    expect(result?.rowId).toBe(`${apiGroup}/pod:api-1`);
    expect([...(result?.collapsed ?? [])]).toEqual(['other']);
    expect(result?.clearFilter).toBe(false);
  });

  it('follows the grouping the user chose for a pod', () => {
    expect(plan(apiPod, { grouping: 'service' })?.rowId).toBe('ns:web/svc:api/pod:api-1');
    const byNode = plan(apiPod, { grouping: 'node' });
    expect(byNode?.rowId).toBe('node:n1/ns:web/pod:api-1');
    expect(byNode?.grouping).toBe('node');
  });

  it('switches to workload grouping for a workload', () => {
    const result = plan(
      { type: 'workload', kind: 'Deployment', namespace: 'web', name: 'api' },
      { grouping: 'service', collapsed: ['ns:web'] },
    );
    expect(result?.grouping).toBe('workload');
    expect(result?.rowId).toBe(apiGroup);
    expect(result?.collapsed.has('ns:web')).toBe(false);
  });

  it('keeps a filter that still shows the target and clears one that hides it', () => {
    expect(plan(apiPod, { query: 'api-1' })?.clearFilter).toBe(false);
    expect(plan(apiPod, { query: 'api-2' })?.clearFilter).toBe(true);
  });

  it('opens the node list for a node outside node grouping', () => {
    const result = plan({ type: 'node', name: 'n1' }, { query: 'api' });
    expect(result?.rowId).toBe('nodes/n1');
    expect(result?.clearFilter).toBe(true);
    expect(result?.collapsed.has('nodes:opened')).toBe(true);
  });

  it('uses the node group when grouped by node', () => {
    const result = plan({ type: 'node', name: 'n1' }, { grouping: 'node' });
    expect(result?.rowId).toBe('node:n1');
    expect(result?.grouping).toBe('node');
  });

  it('leaves node grouping for a node with no pods', () => {
    const result = plan({ type: 'node', name: 'idle' }, { grouping: 'node', nodes: [node, idle] });
    expect(result?.grouping).toBe('workload');
    expect(result?.rowId).toBe('nodes/idle');
  });

  it('lands on the namespace when the object has no row', () => {
    expect(plan({ ...apiPod, name: 'gone' })?.rowId).toBe('ns:web');
    expect(
      plan({ type: 'workload', kind: 'Deployment', namespace: 'web', name: 'no-pods' })?.rowId,
    ).toBe('ns:web');
    expect(plan({ ...apiPod, name: 'gone' }, { grouping: 'node' })?.rowId).toBe('node:n1/ns:web');
  });

  it('has nowhere to go for an unknown namespace or node', () => {
    expect(plan({ type: 'namespace', namespace: 'none' })).toBeNull();
    expect(plan({ type: 'node', name: 'none' })).toBeNull();
  });
});
