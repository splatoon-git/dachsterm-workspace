import { describe, expect, it } from 'vitest';
import {
  applySearchEvents,
  aroundLines,
  aroundSince,
  displayRows,
  failureText,
  highlightParts,
  idleSearch,
  includedWords,
  logTimeMs,
  podsInScope,
  scopeOfGroup,
  scopeOfTarget,
  scopeOptions,
  searchTargets,
  statusText,
  truncationNotes,
  type SearchRow,
  type SearchSource,
} from './logSearchModel';
import type { KubePod, KubeService } from './snapshotTypes';
import { workloadGroupId } from './tree';

const container = (name: string, restarts = 0) => ({
  name,
  ready: true,
  restarts,
  waiting: '',
  terminated: '',
  lastReason: '',
  lastFinished: '',
  lastExitCode: null,
});
const pod = (name: string, patch: Partial<KubePod> = {}): KubePod => ({
  namespace: 'web',
  name,
  node: 'n',
  phase: 'Running',
  reason: '',
  created: '2026-11-08T11:00:00Z',
  deleting: false,
  ownerKind: 'ReplicaSet',
  ownerName: 'api-7f9c',
  labels: { app: 'api', 'pod-template-hash': '7f9c' },
  defaultContainer: 'app',
  containerCount: 1,
  cpuRequest: null,
  memoryRequest: null,
  cpuLimit: null,
  memoryLimit: null,
  initContainers: [],
  containers: [container('app')],
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
const source: SearchSource = { namespace: 'web', pod: 'api-1', container: 'app', previous: false };

function row(id: number, time: string, patch: Partial<SearchRow> = {}): SearchRow {
  return { ...source, time, text: `line ${id}`, clipped: false, id, at: logTimeMs(time), ...patch };
}

describe('events become results', () => {
  it('collects rows as they arrive and counts finished jobs', () => {
    const state = applySearchEvents(idleSearch, [
      { type: 'started', jobs: 2, omittedPods: 0 },
      {
        type: 'lines',
        source,
        lines: [{ time: '2026-11-08T12:00:00.123456789Z', text: 'hit', clipped: false }],
      },
      { type: 'jobDone', source, state: { kind: 'ready' }, matched: 1, truncated: false },
    ]);
    expect(state.phase).toBe('running');
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0].pod).toBe('api-1');
    expect(state.rows[0].at).toBe(Date.UTC(2026, 10, 8, 12, 0, 0, 123));
    expect(statusText(state)).toBe('검색 중 1/2 · 1줄');
  });

  it('a pod that failed is listed and does not stop the search', () => {
    const state = applySearchEvents(idleSearch, [
      { type: 'started', jobs: 2, omittedPods: 0 },
      { type: 'jobDone', source, state: { kind: 'forbidden' }, matched: 0, truncated: false },
      { type: 'jobDone', source, state: { kind: 'ready' }, matched: 3, truncated: false },
      { type: 'finished', outcome: 'done', unstarted: 0 },
    ]);
    expect(state.failures).toHaveLength(1);
    expect(failureText(state.failures[0])).toBe('api-1/app: 권한 없음');
    expect(statusText(state)).toBe('검색 완료 2/2 · 0줄');
  });

  it('every limit that was hit says so', () => {
    const state = applySearchEvents(idleSearch, [
      { type: 'started', jobs: 1, omittedPods: 7 },
      { type: 'jobDone', source, state: { kind: 'ready' }, matched: 1000, truncated: true },
      { type: 'finished', outcome: 'totalLimit', unstarted: 2 },
    ]);
    expect(truncationNotes(state)).toEqual([
      '파드 1개가 파드당 1,000줄 상한에 걸렸습니다.',
      '전체 5,000줄 상한에 걸렸습니다.',
      '파드 100개 상한으로 7개는 검색하지 않았습니다.',
      '2개 대상은 시작하지 못했습니다.',
    ]);
    expect(truncationNotes({ ...idleSearch, phase: 'finished', outcome: 'timedOut' })).toEqual([
      '전체 시간 60초 상한에 걸렸습니다.',
    ]);
  });

  it('a search that ran to the end has nothing to warn about, and a cancel says so', () => {
    expect(truncationNotes({ ...idleSearch, phase: 'finished', outcome: 'done' })).toEqual([]);
    const cancelled = { ...idleSearch, phase: 'finished' as const, outcome: 'cancelled' as const };
    expect(truncationNotes({ ...cancelled, unstarted: 3 })).toEqual([]);
    expect(statusText({ ...cancelled, jobs: 4, jobsDone: 1 })).toBe('취소됨 1/4 · 0줄');
  });

  it('remembers how far the server made the search narrow', () => {
    const state = applySearchEvents(idleSearch, [
      { type: 'started', jobs: 1, omittedPods: 0 },
      { type: 'narrowed', concurrency: 2 },
    ]);
    expect(state.concurrency).toBe(2);
  });
});

describe('scope', () => {
  const pods = [
    pod('api-1'),
    pod('api-2'),
    pod('solo', { ownerKind: '', ownerName: '', labels: {} }),
    pod('db-0', {
      ownerKind: 'StatefulSet',
      ownerName: 'db',
      labels: { app: 'db' },
      namespace: 'data',
    }),
  ];
  const services = [service('api', { app: 'api' }), service('external', {})];

  it('every kind of scope picks its pods', () => {
    const names = (kind: Parameters<typeof podsInScope>[0]['kind'], value: string) =>
      podsInScope({ kind, value }, pods, services).map((item) => item.name);
    expect(names('all', '')).toHaveLength(4);
    expect(names('namespace', 'data')).toEqual(['db-0']);
    expect(names('workload', 'web/Deployment/api')).toEqual(['api-1', 'api-2']);
    expect(names('workload', 'data/StatefulSet/db')).toEqual(['db-0']);
    expect(names('service', 'web/api')).toEqual(['api-1', 'api-2']);
    expect(names('pod', 'web/solo')).toEqual(['solo']);
    expect(names('pod', 'web/none')).toEqual([]);
  });

  it('the box offers what the cluster has, without services that select nothing', () => {
    expect(scopeOptions('namespace', pods, services)).toEqual(['data', 'web']);
    expect(scopeOptions('workload', pods, services)).toEqual([
      'data/StatefulSet/db',
      'web/Deployment/api',
    ]);
    expect(scopeOptions('service', pods, services)).toEqual(['web/api']);
    expect(scopeOptions('all', pods, services)).toEqual([]);
  });

  it('starting from another screen maps to the same scopes', () => {
    expect(scopeOfTarget({ type: 'pod', namespace: 'web', name: 'a' })).toEqual({
      kind: 'pod',
      value: 'web/a',
    });
    expect(
      scopeOfTarget({ type: 'workload', kind: 'Deployment', namespace: 'w', name: 'a' }),
    ).toEqual({ kind: 'workload', value: 'w/Deployment/a' });
    expect(scopeOfTarget({ type: 'namespace', namespace: 'w' })).toEqual({
      kind: 'namespace',
      value: 'w',
    });
    expect(scopeOfTarget({ type: 'node', name: 'n' })).toBeNull();
  });

  it('a tree group id gives the scope it was built from', () => {
    expect(scopeOfGroup(workloadGroupId('web', 'Deployment', 'api'))).toEqual({
      kind: 'workload',
      value: 'web/Deployment/api',
    });
    expect(scopeOfGroup('ns:web')).toEqual({ kind: 'namespace', value: 'web' });
    expect(scopeOfGroup('ns:web/svc:api')).toEqual({ kind: 'service', value: 'web/api' });
    expect(scopeOfGroup('node:n1')).toBeNull();
    expect(scopeOfGroup('ns:web/no-workload')).toBeNull();
  });
});

describe('what is searched in each pod', () => {
  it('takes the default container unless all are asked for', () => {
    const multi = pod('m', {
      defaultContainer: 'main',
      containers: [container('main'), container('sidecar')],
    });
    expect(searchTargets([multi], { allContainers: false, previous: false })[0].containers).toEqual(
      ['main'],
    );
    expect(searchTargets([multi], { allContainers: true, previous: false })[0].containers).toEqual([
      'main',
      'sidecar',
    ]);
  });

  it('falls back to the first container when the default is not reported', () => {
    const odd = pod('o', { defaultContainer: 'gone', containers: [container('x')] });
    expect(searchTargets([odd], { allContainers: false, previous: false })[0].containers).toEqual([
      'x',
    ]);
  });

  it('only a container that restarted has a previous instance to read', () => {
    const restarted = pod('r', {
      containers: [container('app', 2), container('side')],
    });
    expect(searchTargets([restarted], { allContainers: true, previous: true })[0].previous).toEqual(
      ['app'],
    );
    expect(
      searchTargets([restarted], { allContainers: true, previous: false })[0].previous,
    ).toEqual([]);
  });

  it('a pod that has not started is left out', () => {
    expect(
      searchTargets([pod('p', { phase: 'Pending' })], { allContainers: false, previous: false }),
    ).toEqual([]);
    expect(
      searchTargets([pod('c', { containers: [] })], { allContainers: false, previous: false }),
    ).toEqual([]);
  });
});

describe('the result table', () => {
  const rows = [
    row(0, '2026-11-08T12:00:02Z'),
    row(1, '2026-11-08T12:00:01Z', { pod: 'b-1' }),
    row(2, '2026-11-08T12:00:01Z', { pod: 'a-1' }),
  ];

  it('sorts by time either way, keeping arrival order for equal times', () => {
    const ids = (descending: boolean) =>
      displayRows(rows, descending, false).map((item) => (item.type === 'line' ? item.row.id : -1));
    expect(ids(false)).toEqual([1, 2, 0]);
    expect(ids(true)).toEqual([0, 2, 1]);
  });

  it('groups by pod and keeps time order inside each', () => {
    const shown = displayRows(rows, false, true).map((item) =>
      item.type === 'group' ? `${item.label}:${item.count}` : item.row.id,
    );
    expect(shown).toEqual(['web/a-1:1', 2, 'web/api-1:1', 0, 'web/b-1:1', 1]);
  });

  it('marks only the words that were searched for', () => {
    expect(includedWords('error !debug  timeout')).toEqual(['error', 'timeout']);
    expect(highlightParts('An ERROR and a timeout.', ['error', 'timeout'])).toEqual([
      { text: 'An ', hit: false },
      { text: 'ERROR', hit: true },
      { text: ' and a ', hit: false },
      { text: 'timeout', hit: true },
      { text: '.', hit: false },
    ]);
    expect(highlightParts('a.b', ['.'])).toEqual([
      { text: 'a', hit: false },
      { text: '.', hit: true },
      { text: 'b', hit: false },
    ]);
    expect(highlightParts('plain', [])).toEqual([{ text: 'plain', hit: false }]);
  });
});

describe('the lines around a result', () => {
  const log = [
    '2026-11-08T12:00:00Z one',
    '2026-11-08T12:00:01Z two',
    '2026-11-08T12:00:02Z three',
    '2026-11-08T12:00:03Z four',
    '',
  ].join('\n');

  it('are read from a minute earlier', () => {
    expect(aroundSince({ at: Date.UTC(2026, 10, 8, 12, 0, 0) })).toBe('2026-11-08T11:59:00.000Z');
  });

  it('finds the hit and keeps the requested number on each side', () => {
    const { lines, marked } = aroundLines(
      log,
      { time: '2026-11-08T12:00:02Z', text: 'three', clipped: false },
      1,
    );
    expect(lines.map((line) => line.text)).toEqual(['two', 'three', 'four']);
    expect(marked).toBe(1);
  });

  it('a clipped hit is matched by its beginning', () => {
    const { marked } = aroundLines(
      log,
      { time: '2026-11-08T12:00:03Z', text: 'fo', clipped: true },
      5,
    );
    expect(marked).toBe(3);
  });

  it('a hit that is gone leaves the nearest lines and no mark', () => {
    const { lines, marked } = aroundLines(
      log,
      { time: '2026-11-08T12:00:02Z', text: 'rotated away', clipped: false },
      0,
    );
    expect(lines.map((line) => line.text)).toEqual(['three']);
    expect(marked).toBe(-1);
  });
});
