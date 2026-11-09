import { describe, expect, it, vi } from 'vitest';
import {
  blockedReason,
  nodeNameOfGroup,
  planDelete,
  planNode,
  planRollout,
  rolloutOfGroup,
} from './actionModel';
import type { KubePod } from './snapshotTypes';
import { nodeGroupId, workloadGroupId, type TreeRow } from './tree';
import { treeRowMenu, type RowMenuContext } from './treeRowMenu';

const pod = (patch: Partial<KubePod>): KubePod =>
  ({
    namespace: 'web',
    name: 'api-1',
    ownerKind: '',
    ownerName: '',
    labels: {},
    ...patch,
  }) as KubePod;

describe('what a delete says it will do', () => {
  it('warns that a pod without an owner is gone for good', () => {
    const plan = planDelete(pod({}));
    expect(plan.permanent).toBe(true);
    expect(plan.impact).toContain('복구되지 않습니다');
    expect(plan.action).toEqual({ kind: 'deletePod', namespace: 'web', pod: 'api-1' });
  });

  it('names the deployment behind a replica set', () => {
    const plan = planDelete(
      pod({
        ownerKind: 'ReplicaSet',
        ownerName: 'api-7f9c',
        labels: { 'pod-template-hash': '7f9c' },
      }),
    );
    expect(plan.permanent).toBe(false);
    expect(plan.impact).toContain('Deployment/api');
    expect(plan.impact).toContain('다시 만듭니다');
  });

  it('tells a static pod and a job apart from a controller that always replaces', () => {
    expect(planDelete(pod({ ownerKind: 'Node', ownerName: 'n1' })).impact).toContain('kubelet');
    expect(planDelete(pod({ ownerKind: 'Job', ownerName: 'once' })).impact).toContain('끝났다면');
  });
});

describe('rollouts', () => {
  it('reads the three kinds that have one from the group id', () => {
    expect(rolloutOfGroup(workloadGroupId('web', 'Deployment', 'api'))).toEqual({
      namespace: 'web',
      kind: 'Deployment',
      workload: 'deployment',
      name: 'api',
    });
    expect(rolloutOfGroup(workloadGroupId('web', 'StatefulSet', 'db'))?.workload).toBe(
      'statefulSet',
    );
    expect(rolloutOfGroup(workloadGroupId('web', 'DaemonSet', 'a'))?.workload).toBe('daemonSet');
  });

  it('has none for other owners, services or namespaces', () => {
    expect(rolloutOfGroup(workloadGroupId('web', 'ReplicaSet', 'x'))).toBeNull();
    expect(rolloutOfGroup(workloadGroupId('web', 'Job', 'x'))).toBeNull();
    expect(rolloutOfGroup('ns:web/svc:api')).toBeNull();
    expect(rolloutOfGroup('ns:web')).toBeNull();
    expect(rolloutOfGroup('ns:web/no-workload')).toBeNull();
  });

  it('says how many pods will be replaced', () => {
    const rollout = rolloutOfGroup(workloadGroupId('web', 'Deployment', 'api'))!;
    expect(planRollout(rollout, 3).impact).toContain('파드 3개');
  });
});

describe('nodes', () => {
  it('offers the one change that would do something', () => {
    expect(planNode({ name: 'n1', unschedulable: false }).action.kind).toBe('cordon');
    expect(planNode({ name: 'n1', unschedulable: true }).action.kind).toBe('uncordon');
  });

  it('reads only a node level, not the namespaces below it', () => {
    expect(nodeNameOfGroup(nodeGroupId('n1'))).toBe('n1');
    expect(nodeNameOfGroup(`${nodeGroupId('n1')}/ns:web`)).toBeNull();
    expect(nodeNameOfGroup('ns:web')).toBeNull();
  });
});

describe('blocked writes', () => {
  it('only operate mode leaves nothing to explain', () => {
    expect(blockedReason('on')).toBe('');
    for (const mode of ['off', 'unavailable', 'checking', 'failed'] as const)
      expect(blockedReason(mode)).not.toBe('');
  });

  const context = (blocked: string): RowMenuContext => ({
    nodes: [
      { name: 'n1', ready: true, unschedulable: true, cpuAllocatable: 1, memoryAllocatable: 1 },
    ],
    blocked,
    ask: vi.fn(),
    watchLogs: vi.fn(),
    searchLogs: vi.fn(),
  });
  const group = (id: string) => ({ type: 'group', group: { id, count: 2 } }) as unknown as TreeRow;

  it('stays in the menu, disabled, with the reason', () => {
    const menu = treeRowMenu(group(workloadGroupId('web', 'Deployment', 'api')), context('이유'));
    const item = menu?.items.find((entry) => entry.label === '롤아웃 재시작');
    expect(item).toMatchObject({ disabled: true, hint: '이유', danger: true });
  });

  it('asks before running when it can run', () => {
    const ctx = context('');
    const menu = treeRowMenu(group(workloadGroupId('web', 'Deployment', 'api')), ctx);
    const item = menu?.items.find((entry) => entry.label === '롤아웃 재시작');
    expect(item).toMatchObject({ disabled: false, hint: undefined });
    item?.run();
    expect(ctx.ask).toHaveBeenCalledOnce();
  });

  it('uses the node list, so a node group offers what its state allows', () => {
    const menu = treeRowMenu(group(nodeGroupId('n1')), context(''));
    expect(menu?.items.map((entry) => entry.label)).toEqual(['실시간 로그 보기', 'Uncordon']);
  });

  it('gives a node row its own menu, and the section row none', () => {
    const node = {
      type: 'node',
      view: { node: { name: 'n1', unschedulable: false } },
    } as unknown as TreeRow;
    expect(treeRowMenu(node, context(''))?.items[0].label).toBe('Cordon');
    expect(treeRowMenu({ type: 'nodes' } as unknown as TreeRow, context(''))).toBeNull();
  });
});
