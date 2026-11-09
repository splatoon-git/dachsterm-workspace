import { describe, expect, it } from 'vitest';
import { pod } from '../../../tests/ui/fixtures/kube-data';
import { storeOf } from '../../../tests/ui/fixtures/kube-store';
import { advanceIssues, emptyIssues, ISSUE_HOLD, MAX_CHANGES, type IssueLog } from './history';
import { emptySnapshots, type SnapshotStore } from './polling';
import type { KubeNode, KubePod, KubePvc, SnapshotItems } from './snapshotTypes';

const T0 = Date.parse('2026-11-08T12:00:00Z');

const node = (name: string, ready = true, unschedulable = false): KubeNode => ({
  name,
  ready,
  unschedulable,
  cpuAllocatable: 1,
  memoryAllocatable: 1,
});
const pvc = (name: string, phase = 'Pending'): KubePvc => ({ namespace: 'web', name, phase });
const crashing = (name: string, restarts = 0) =>
  pod(name, {
    containers: [
      { ...pod('x').containers[0], ready: false, waiting: 'CrashLoopBackOff', restarts },
    ],
  });
const running = (name: string, restarts: number, reason = '', code: number | null = null) =>
  pod(name, {
    containers: [
      {
        ...pod('x').containers[0],
        restarts,
        lastReason: reason,
        lastFinished: reason ? new Date(T0 - 7_200_000).toISOString() : '',
        lastExitCode: code,
      },
    ],
  });

/** Applies each step as a new poll, `seconds` after the start. */
function run(steps: [seconds: number, items: Partial<SnapshotItems>][], from = emptyIssues()) {
  return steps.reduce<IssueLog>(
    (log, [seconds, items]) => advanceIssues(log, storeOf(items, T0 + seconds * 1000)),
    from,
  );
}

const lines = (log: IssueLog) => log.changes.map((c) => [c.kind, c.object, c.detail]);
const alerted = (log: IssueLog) => log.alerts.map((a) => a.problem.key);

describe('the first look', () => {
  it('is a baseline: what was already wrong writes nothing and alerts nothing', () => {
    const log = run([
      [
        0,
        {
          pods: [crashing('old', 5)],
          nodes: [node('n1', false)],
          pvcs: [pvc('stuck')],
        },
      ],
    ]);
    expect(log.changes).toEqual([]);
    expect(log.alerts).toEqual([]);
  });

  it('is per kind, so a kind that arrives late is not news either', () => {
    const log = run([
      [0, { pods: [pod('a')] }],
      [30, { pods: [pod('a')], pvcs: [pvc('stuck')] }],
      [120, { pods: [pod('a')], pvcs: [pvc('stuck')] }],
    ]);
    expect(log.alerts).toEqual([]);
    expect(log.changes).toEqual([]);
  });
});

describe('breaking and recovering', () => {
  it('reports an error at once and its recovery only after it has stayed away', () => {
    const broken = run([
      [0, { pods: [pod('a')] }],
      [5, { pods: [crashing('a')] }],
    ]);
    expect(lines(broken)).toEqual([['broke', 'web/a', 'CrashLoopBackOff']]);
    expect(alerted(broken)).toEqual(['pod:web/a']);

    const soon = run([[10, { pods: [pod('a')] }]], broken);
    expect(lines(soon)).toHaveLength(1);

    const later = run([[10 + ISSUE_HOLD / 1000, { pods: [pod('a')] }]], soon);
    expect(lines(later)[0]).toEqual(['recovered', 'web/a', 'CrashLoopBackOff']);
  });

  it('writes one line for a crash loop that keeps coming back between polls', () => {
    const log = run([
      [0, { pods: [pod('a')] }],
      [5, { pods: [crashing('a')] }],
      [10, { pods: [pod('a')] }],
      [15, { pods: [crashing('a')] }],
      [20, { pods: [pod('a')] }],
      [25, { pods: [crashing('a')] }],
    ]);
    expect(log.changes.filter((c) => c.kind === 'broke')).toHaveLength(1);
    expect(log.changes.filter((c) => c.kind === 'recovered')).toHaveLength(0);
    expect(alerted(log)).toEqual(['pod:web/a']);
  });

  it('ignores a warning that ends before the hold', () => {
    const creating = pod('new', {
      containers: [{ ...pod('x').containers[0], ready: false, waiting: 'ContainerCreating' }],
    });
    const log = run([
      [0, { pods: [pod('a')] }],
      [5, { pods: [pod('a'), creating] }],
      [15, { pods: [pod('a'), pod('new')] }],
      [15 + ISSUE_HOLD / 1000, { pods: [pod('a'), pod('new')] }],
    ]);
    expect(log.changes).toEqual([]);
    expect(log.alerts).toEqual([]);
  });

  it('reports a warning that lasts', () => {
    const log = run([
      [0, { pvcs: [] }],
      [30, { pvcs: [pvc('stuck')] }],
      [60, { pvcs: [pvc('stuck')] }],
      [90, { pvcs: [pvc('stuck')] }],
    ]);
    expect(lines(log)).toEqual([['broke', 'web/stuck', 'Pending']]);
    expect(alerted(log)).toEqual(['pvc:web/stuck']);
  });

  it('calls a problem whose object is deleted gone, not recovered', () => {
    const log = run([
      [0, { pods: [pod('a')] }],
      [5, { pods: [crashing('a')] }],
      [10, { pods: [] }],
      [10 + ISSUE_HOLD / 1000, { pods: [] }],
    ]);
    expect(lines(log)[0]).toEqual(['gone', 'web/a', 'CrashLoopBackOff']);
  });
});

describe('restarts', () => {
  it('writes the reason and the increase', () => {
    const log = run([
      [0, { pods: [running('a', 1)] }],
      [5, { pods: [running('a', 3, 'OOMKilled', 137)] }],
    ]);
    expect(lines(log)).toEqual([['restart', 'web/a', '+2 · OOMKilled (종료 코드 137)']]);
  });

  it('does not count a new pod under the same name as a restart', () => {
    const log = run([
      [0, { pods: [running('a', 4)] }],
      [5, { pods: [running('a', 0)] }],
      [10, { pods: [running('a', 1)] }],
    ]);
    expect(lines(log)).toEqual([['restart', 'web/a', '+1']]);
  });

  it('does not write a broke line for the pod that just restarted', () => {
    const log = run([
      [0, { pods: [running('a', 0)] }],
      [5, { pods: [crashing('a', 1)] }],
    ]);
    expect(log.changes.map((c) => c.kind)).toEqual(['restart']);
    expect(alerted(log)).toEqual(['pod:web/a']);
  });

  it('alerts once for a restart, which stays on the list for an hour', () => {
    const restarted = pod('a', {
      containers: [
        {
          ...pod('x').containers[0],
          restarts: 1,
          lastReason: 'Error',
          lastFinished: new Date(T0 + 1000).toISOString(),
          lastExitCode: 1,
        },
      ],
    });
    const log = run([
      [0, { pods: [pod('a')] }],
      [5, { pods: [restarted] }],
      [70, { pods: [restarted] }],
      [130, { pods: [restarted] }],
    ]);
    expect(alerted(log)).toEqual(['restart:web/a']);
    expect(log.changes.map((c) => c.kind)).toEqual(['restart']);
  });
});

describe('nodes', () => {
  it('writes each transition once and no separate break line', () => {
    const log = run([
      [0, { nodes: [node('n1')] }],
      [15, { nodes: [node('n1', false)] }],
      [30, { nodes: [node('n1', false)] }],
      [45, { nodes: [node('n1', true, true)] }],
      [60, { nodes: [node('n1')] }],
    ]);
    expect(lines(log).reverse()).toEqual([
      ['node', 'n1', 'Ready → NotReady'],
      ['node', 'n1', 'NotReady → 스케줄 중지'],
      ['node', 'n1', '스케줄 중지 → Ready'],
    ]);
    expect(alerted(log)).toEqual(['node:n1']);
  });

  it('writes a node that left the cluster', () => {
    const log = run([
      [0, { nodes: [node('n1'), node('n2')] }],
      [15, { nodes: [node('n1')] }],
    ]);
    expect(lines(log)).toEqual([['gone', 'n2', '노드 없어짐']]);
  });
});

describe('the log itself', () => {
  it('stays within the limit, newest first', () => {
    let log = emptyIssues();
    const at = (i: number) => T0 + i * 5000;
    log = advanceIssues(log, storeOf({ pods: [running('a', 0)] }, at(0)));
    for (let i = 1; i <= MAX_CHANGES + 20; i++)
      log = advanceIssues(log, storeOf({ pods: [running('a', i)] }, at(i)));
    expect(log.changes).toHaveLength(MAX_CHANGES);
    expect(log.changes[0].at).toBe(at(MAX_CHANGES + 20));
    expect(log.changes.at(-1)?.at).toBe(at(21));
  });

  it('returns the same object when a failed poll brought nothing new', () => {
    const store: SnapshotStore = storeOf({ pods: [pod('a')] }, T0);
    const log = advanceIssues(emptyIssues(), store);
    expect(advanceIssues(log, store)).toBe(log);
    expect(advanceIssues(log, emptySnapshots())).toBe(log);
  });

  it('does not let old data from a failed poll age a warning into a problem', () => {
    const items = { pvcs: [] as KubePvc[] };
    const held = run([
      [0, items],
      [30, { pvcs: [pvc('stuck')] }],
    ]);
    const store = storeOf({ pvcs: [pvc('stuck')] }, T0 + 30_000);
    store.pvcs.state = { kind: 'unreachable' };
    const log = advanceIssues(held, store);
    expect(log).toBe(held);
    expect(log.alerts).toEqual([]);
  });

  it('keeps ids rising across changes and alerts', () => {
    const log = run([
      [0, { pods: [pod('a'), pod('b')] }],
      [5, { pods: [crashing('a'), crashing('b')] }],
    ]);
    expect(log.alerts.map((a) => a.id)).toEqual([...new Set(log.alerts.map((a) => a.id))]);
    expect(log.alerts).toHaveLength(2);
    const pods: KubePod[] = [pod('a')];
    expect(run([[10, { pods }]], log).nextId).toBeGreaterThanOrEqual(log.nextId);
  });
});
