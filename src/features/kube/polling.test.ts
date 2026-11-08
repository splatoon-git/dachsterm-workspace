import { describe, expect, it } from 'vitest';
import {
  applySnapshot,
  delayAfter,
  dueKinds,
  emptySnapshots,
  failedSnapshot,
  finished,
  freshness,
  kindNotes,
  newSchedule,
  nextWakeIn,
  pollPeriods,
  resumed,
  snapshotKinds,
  started,
  stateNote,
} from './polling';
import type { KubeState } from './kubeModel';
import type { Snapshot } from './snapshotTypes';

const ready = { kind: 'ready' } as const;
const result = (state: KubeState, patch: Partial<Snapshot> = {}): Snapshot => ({
  state,
  data: null,
  collectedAt: 1000,
  elapsedMs: 10,
  ...patch,
});
const nodesData: Snapshot['data'] = {
  kind: 'nodes',
  items: [
    { name: 'n1', ready: true, unschedulable: false, cpuAllocatable: 1, memoryAllocatable: 1 },
  ],
};

describe('schedule', () => {
  it('uses the design periods', () => {
    expect(pollPeriods).toEqual({
      pods: 5000,
      workloads: 15000,
      services: 30000,
      nodes: 15000,
      podUsage: 15000,
      nodeUsage: 15000,
      events: 15000,
    });
  });

  it('starts with everything due and does not start a kind that is still running', () => {
    let schedule = newSchedule(100);
    expect(dueKinds(schedule, 100)).toEqual(snapshotKinds);
    schedule = started(schedule, 'pods');
    expect(dueKinds(schedule, 100)).not.toContain('pods');
    expect(dueKinds(schedule, 1_000_000)).not.toContain('pods');
  });

  it('waits five seconds after a quick run and three times a slow one', () => {
    expect(delayAfter('pods', 200, ready)).toBe(5000);
    expect(delayAfter('pods', 6000, ready)).toBe(18000);
    expect(delayAfter('services', 200, ready)).toBe(30000);
  });

  it('counts the wait from when the run ended', () => {
    const schedule = finished(started(newSchedule(0), 'pods'), 'pods', 9000, result(ready));
    expect(schedule.pods).toEqual({ inFlight: false, nextAt: 14000 });
  });

  it('tries a refused channel again on the normal period', () => {
    expect(delayAfter('pods', 5, { kind: 'channelLimit' })).toBe(5000);
  });

  it('polls a query that hit a limit less often, up to two minutes', () => {
    expect(delayAfter('pods', 20000, { kind: 'timedOut' })).toBe(60000);
    expect(delayAfter('pods', 10, { kind: 'tooLarge' })).toBe(20000);
    expect(delayAfter('services', 50000, { kind: 'tooLarge' })).toBe(120000);
  });

  it('refreshes at once when shown again, except what is still running', () => {
    let schedule = finished(started(newSchedule(0), 'pods'), 'pods', 0, result(ready));
    schedule = started(schedule, 'events');
    const shown = resumed(schedule, 700);
    expect(shown.pods.nextAt).toBe(700);
    expect(shown.events).toEqual(schedule.events);
    expect(dueKinds(shown, 700)).not.toContain('events');
  });

  it('wakes for the soonest kind and not at all when everything is running', () => {
    let schedule = finished(started(newSchedule(0), 'pods'), 'pods', 0, result(ready));
    for (const kind of snapshotKinds.filter((kind) => kind !== 'pods'))
      schedule = finished(started(schedule, kind), kind, 0, result(ready));
    expect(nextWakeIn(schedule, 1000)).toBe(4000);
    expect(nextWakeIn(schedule, 9000)).toBe(0);
    for (const kind of snapshotKinds) schedule = started(schedule, kind);
    expect(nextWakeIn(schedule, 0)).toBeNull();
  });
});

describe('store', () => {
  it('keeps the items and the time of a good poll', () => {
    const store = applySnapshot(emptySnapshots(), 'nodes', result(ready, { data: nodesData }));
    expect(store.nodes.data).toEqual(nodesData?.items);
    expect(store.nodes.collectedAt).toBe(1000);
  });

  it.each<KubeState>([
    { kind: 'unreachable' },
    { kind: 'timedOut' },
    { kind: 'channelLimit' },
    { kind: 'unknown', message: 'x' },
  ])('keeps the last data and its time through $kind', (state) => {
    const good = applySnapshot(emptySnapshots(), 'nodes', result(ready, { data: nodesData }));
    const after = applySnapshot(good, 'nodes', result(state, { collectedAt: 9000 }));
    expect(after.nodes.data).toEqual(nodesData?.items);
    expect(after.nodes.collectedAt).toBe(1000);
    expect(after.nodes.state).toEqual(state);
  });

  it.each<KubeState>([{ kind: 'forbidden' }, { kind: 'metricsMissing' }])(
    'empties only that kind for $kind',
    (state) => {
      let store = applySnapshot(emptySnapshots(), 'nodes', result(ready, { data: nodesData }));
      store = applySnapshot(store, 'pods', result(ready, { data: { kind: 'pods', items: [] } }));
      const after = applySnapshot(store, 'nodes', result(state));
      expect(after.nodes.data).toBeNull();
      expect(after.pods.data).toEqual([]);
    },
  );

  it('turns an error thrown in the app into a state', () => {
    expect(failedSnapshot('연결이 끊어졌습니다.').state).toEqual({
      kind: 'unknown',
      message: '연결이 끊어졌습니다.',
    });
  });
});

describe('what the user is told', () => {
  it('says how old the pods are and does not reset on a failure', () => {
    let store = applySnapshot(
      emptySnapshots(),
      'pods',
      result(ready, { collectedAt: 10_000, data: { kind: 'pods', items: [] } }),
    );
    expect(freshness(store, 12_900)).toEqual({ age: '2초 전', warning: null });
    store = applySnapshot(store, 'pods', result({ kind: 'unreachable' }, { collectedAt: 99_000 }));
    expect(freshness(store, 40_000)).toEqual({ age: '30초 전', warning: '클러스터 연결 불가' });
  });

  it('counts minutes and hours for old data and is silent before the first answer', () => {
    const store = applySnapshot(
      emptySnapshots(),
      'pods',
      result(ready, { collectedAt: 0, data: { kind: 'pods', items: [] } }),
    );
    expect(freshness(store, 125_000).age).toBe('2분 전');
    expect(freshness(store, 7_300_000).age).toBe('2시간 전');
    expect(freshness(emptySnapshots(), 5000)).toEqual({ age: null, warning: null });
  });

  it('says why a kind is missing and leaves pods to the header', () => {
    let store = applySnapshot(emptySnapshots(), 'workloads', result({ kind: 'forbidden' }));
    store = applySnapshot(store, 'podUsage', result({ kind: 'metricsMissing' }));
    store = applySnapshot(store, 'pods', result({ kind: 'unreachable' }));
    store = applySnapshot(store, 'nodes', result(ready, { data: nodesData }));
    expect(kindNotes(store)).toEqual(['워크로드: 권한 없음', '파드 사용량: metrics-server 없음']);
  });

  it('asks for a narrower namespace when a limit was hit', () => {
    expect(stateNote({ kind: 'tooLarge' })).toContain('namespace를 좁히세요');
    expect(stateNote({ kind: 'timedOut' })).toContain('namespace를 좁히세요');
    expect(stateNote({ kind: 'unknown', message: '그대로' })).toBe('그대로');
  });
});
