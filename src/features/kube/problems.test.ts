import { describe, expect, it } from 'vitest';
import { NOW, pod } from '../../../tests/ui/fixtures/kube-data';
import { storeOf } from '../../../tests/ui/fixtures/kube-store';
import { problemCount, problemSections, readProblems, type Problem } from './problems';
import type { KubeJob } from './snapshotTypes';

const HOUR = 3_600_000;

const job = (name: string, patch: Partial<KubeJob> = {}): KubeJob => ({
  namespace: 'web',
  name,
  created: '2026-11-08T11:00:00Z',
  ownerKind: '',
  ownerName: '',
  failed: true,
  failedAt: '2026-11-08T11:30:00Z',
  reason: 'BackoffLimitExceeded',
  ...patch,
});

const keys = (problems: Problem[] | undefined) => problems?.map((problem) => problem.key);

describe('reading problems', () => {
  it('reports NotReady nodes only, and a cordoned node is not one', () => {
    const store = storeOf({
      nodes: [
        { name: 'n1', ready: false, unschedulable: false, cpuAllocatable: 1, memoryAllocatable: 1 },
        { name: 'n2', ready: true, unschedulable: true, cpuAllocatable: 1, memoryAllocatable: 1 },
      ],
    });
    expect(keys(readProblems('nodes', store)?.problems)).toEqual(['node:n1']);
  });

  it('marks a workload with nothing ready as an error and a partial one as a warning', () => {
    const reading = readProblems(
      'workloads',
      storeOf({
        workloads: [
          { kind: 'Deployment', namespace: 'web', name: 'none', desired: 2, ready: 0 },
          { kind: 'Deployment', namespace: 'web', name: 'some', desired: 3, ready: 2 },
          { kind: 'Deployment', namespace: 'web', name: 'full', desired: 1, ready: 1 },
        ],
      }),
    );
    expect(reading?.problems.map((p) => [p.object, p.health])).toEqual([
      ['Deployment/web/none', 'error'],
      ['Deployment/web/some', 'warn'],
    ]);
  });

  it('reports a claim that is not bound, and Lost as an error', () => {
    const reading = readProblems(
      'pvcs',
      storeOf({
        pvcs: [
          { namespace: 'web', name: 'bound', phase: 'Bound' },
          { namespace: 'web', name: 'waiting', phase: 'Pending' },
          { namespace: 'web', name: 'lost', phase: 'Lost' },
        ],
      }),
    );
    expect(reading?.problems.map((p) => [p.object, p.health, p.detail])).toEqual([
      ['web/waiting', 'warn', 'Pending'],
      ['web/lost', 'error', 'Lost'],
    ]);
    expect(reading?.problems[0].target).toEqual({ type: 'namespace', namespace: 'web' });
  });

  it('lets a later CronJob success clear an older failure', () => {
    const reading = readProblems(
      'jobs',
      storeOf({
        jobs: [
          job('run-1', {
            ownerKind: 'CronJob',
            ownerName: 'nightly',
            created: '2026-11-07T03:00:00Z',
          }),
          job('run-2', {
            ownerKind: 'CronJob',
            ownerName: 'nightly',
            created: '2026-11-08T03:00:00Z',
            failed: false,
            failedAt: '',
            reason: '',
          }),
        ],
      }),
    );
    expect(reading?.problems).toEqual([]);
  });

  it('reports the newest CronJob run with its owner when that run failed', () => {
    const reading = readProblems(
      'jobs',
      storeOf({
        jobs: [
          job('run-1', {
            ownerKind: 'CronJob',
            ownerName: 'nightly',
            created: '2026-11-08T03:00:00Z',
          }),
        ],
      }),
    );
    expect(reading?.problems[0].detail).toBe('BackoffLimitExceeded · CronJob nightly');
    expect(reading?.problems[0].target).toEqual({
      type: 'workload',
      kind: 'Job',
      namespace: 'web',
      name: 'run-1',
    });
  });

  it('drops a Job on its own a day after it failed', () => {
    const reading = readProblems(
      'jobs',
      storeOf({
        jobs: [
          job('fresh', { failedAt: new Date(NOW - 23 * HOUR).toISOString() }),
          job('old', { failedAt: new Date(NOW - 25 * HOUR).toISOString() }),
          job('running', { failed: false, failedAt: '', reason: '' }),
        ],
      }),
    );
    expect(keys(reading?.problems)).toEqual(['job:web/fresh']);
  });

  it('reports an HPA at its maximum and goes to what it scales', () => {
    const reading = readProblems(
      'hpas',
      storeOf({
        hpas: [
          {
            namespace: 'web',
            name: 'full',
            targetKind: 'Deployment',
            targetName: 'api',
            max: 3,
            current: 3,
          },
          {
            namespace: 'web',
            name: 'room',
            targetKind: 'Deployment',
            targetName: 'api',
            max: 3,
            current: 2,
          },
          {
            namespace: 'web',
            name: 'other',
            targetKind: 'Rollout',
            targetName: 'x',
            max: 1,
            current: 1,
          },
        ],
      }),
    );
    expect(reading?.problems.map((p) => [p.key, p.detail, p.target])).toEqual([
      [
        'hpa:web/full',
        '최대치 3/3',
        { type: 'workload', kind: 'Deployment', namespace: 'web', name: 'api' },
      ],
      ['hpa:web/other', '최대치 1/1', { type: 'namespace', namespace: 'web' }],
    ]);
  });

  it('separates a broken pod from a healthy one that restarted lately', () => {
    const restarted = pod('restarted', {
      containers: [
        {
          ...pod('x').containers[0],
          restarts: 2,
          lastReason: 'Error',
          lastFinished: new Date(NOW - HOUR / 2).toISOString(),
          lastExitCode: 1,
        },
      ],
    });
    const broken = pod('broken', {
      containers: [{ ...pod('x').containers[0], ready: false, waiting: 'CrashLoopBackOff' }],
    });
    const reading = readProblems('pods', storeOf({ pods: [pod('fine'), restarted, broken] }));
    expect(reading?.problems.map((p) => [p.key, p.kind, p.health]).sort()).toEqual([
      ['pod:web/broken', 'pod', 'error'],
      ['restart:web/restarted', 'restart', 'warn'],
    ]);
    expect([...(reading?.objects ?? [])].sort()).toEqual([
      'web/broken',
      'web/fine',
      'web/restarted',
    ]);
  });
});

describe('sections', () => {
  it('keeps the designed order', () => {
    expect(problemSections(storeOf({})).map((s) => s.title)).toEqual([
      'NotReady 노드',
      '미달 워크로드',
      '대기 PVC',
      '실패 Job',
      '최대치 HPA',
      '문제 파드',
      '최근 재시작',
    ]);
  });

  it('never reads a refused kind as no problems', () => {
    const store = storeOf({ pvcs: [{ namespace: 'web', name: 'a', phase: 'Pending' }] });
    store.jobs = { data: null, collectedAt: null, state: { kind: 'forbidden' } };
    const sections = problemSections(store);
    const part = (kind: string) => sections.find((s) => s.kind === kind)?.part;
    expect(part('job')).toEqual({ state: 'missing', reason: '권한 없음' });
    expect(part('hpa')).toEqual({ state: 'waiting' });
    expect(part('pvc')?.state).toBe('ready');
    expect(problemCount(sections)).toBe(1);
  });

  it('counts what the long list left out', () => {
    const pvcs = Array.from({ length: 205 }, (_, i) => ({
      namespace: 'web',
      name: `c${i}`,
      phase: 'Pending',
    }));
    const sections = problemSections(storeOf({ pvcs }));
    const section = sections.find((s) => s.kind === 'pvc')?.part;
    expect(section?.state === 'ready' && section.value.items.length).toBe(200);
    expect(section?.state === 'ready' && section.value.more).toBe(5);
    expect(problemCount(sections)).toBe(205);
  });
});
