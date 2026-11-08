import { describe, expect, it } from 'vitest';
import type { ContainerDetail, Detail, PodOverview } from './detailTypes';
import { endNotice, lookupAfterShell, replacementPod, shellEndAction, shellNote } from './podShell';
import type { KubePod } from './snapshotTypes';

const container = (patch: Partial<ContainerDetail> = {}): ContainerDetail => ({
  name: 'app',
  image: 'img',
  ready: true,
  restarts: 0,
  state: 'running',
  reason: '',
  message: '',
  exitCode: null,
  startedAt: '',
  finishedAt: '',
  containerId: 'containerd://a',
  last: null,
  cpuRequest: null,
  memoryRequest: null,
  cpuLimit: null,
  memoryLimit: null,
  ...patch,
});

const overview = (patch: Partial<PodOverview> = {}): PodOverview => ({
  namespace: 'web',
  name: 'api-1',
  uid: 'u1',
  phase: 'Running',
  reason: '',
  message: '',
  node: 'n1',
  podIp: '10.0.0.1',
  hostIp: '10.0.0.2',
  qosClass: 'Burstable',
  created: '2026-11-08T10:00:00Z',
  deleting: false,
  ownerKind: 'ReplicaSet',
  ownerName: 'api-7f9c',
  defaultContainer: '',
  labels: { 'pod-template-hash': '7f9c' },
  initContainers: [],
  containers: [container()],
  ...patch,
});

const found = (patch: Partial<PodOverview>): Detail => ({
  state: { kind: 'ready' },
  data: { kind: 'overview', ...overview(patch) },
});

describe('what ended a pod shell', () => {
  it('reads a live pod with the same container as the same pod', () => {
    expect(lookupAfterShell(overview(), 'app', found({}))).toBe('same');
  });

  it('reads a deleted or replaced pod as gone', () => {
    expect(lookupAfterShell(overview(), 'app', { state: { kind: 'notFound' }, data: null })).toBe(
      'gone',
    );
    expect(lookupAfterShell(overview(), 'app', found({ uid: 'u2' }))).toBe('gone');
    expect(lookupAfterShell(overview(), 'app', found({ deleting: true }))).toBe('gone');
  });

  it('reads a new container id as a restart of the same pod', () => {
    const restarted = found({ containers: [container({ containerId: 'containerd://b' })] });
    expect(lookupAfterShell(overview(), 'app', restarted)).toBe('restarted');
  });

  it('tells a connection that is gone from a cluster that did not answer', () => {
    expect(lookupAfterShell(overview(), 'app', null)).toBe('noConnection');
    expect(
      lookupAfterShell(overview(), 'app', { state: { kind: 'unreachable' }, data: null }),
    ).toBe('unknown');
  });
});

describe('what the tab does after its shell ends', () => {
  it('closes on exit with any code once the shell really ran', () => {
    expect(shellEndAction('closed', 'same', 60_000)).toBe('close');
    expect(shellEndAction('error', 'same', 60_000)).toBe('close');
  });

  it('keeps the message when the shell failed almost at once', () => {
    expect(shellEndAction('error', 'same', 300)).toBe('keep');
    expect(shellEndAction('error', 'unknown', 300)).toBe('keep');
  });

  it('asks before connecting to something else', () => {
    expect(shellEndAction('closed', 'gone', 60_000)).toBe('ask');
    expect(shellEndAction('error', 'gone', 60_000)).toBe('ask');
    expect(shellEndAction('error', 'restarted', 60_000)).toBe('ask');
  });

  it('cleans up when the parent connection is gone', () => {
    expect(shellEndAction('closed', 'noConnection', 60_000)).toBe('close');
    expect(shellEndAction('error', 'noConnection', 300)).toBe('close');
  });

  it('never promises a workload that does not exist', () => {
    expect(endNotice('gone', false)).toContain('소유 워크로드가 없어');
    expect(endNotice('gone', true)).toContain('새 파드로 접속');
    expect(endNotice('gone', true)).toContain('다시 실행하지 않습니다');
    expect(endNotice('restarted', true)).toContain('컨테이너가 다시 시작');
  });
});

describe('finding the replacement pod', () => {
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
    labels: { 'pod-template-hash': '7f9c' },
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

  it('takes the newest ready pod of the same workload', () => {
    const pods = [
      pod('api-2', { created: '2026-11-08T11:00:00Z' }),
      pod('api-3', { created: '2026-11-08T12:00:00Z' }),
    ];
    expect(replacementPod(pods, overview())?.name).toBe('api-3');
  });

  it('survives a rollout: a new ReplicaSet is still the same Deployment', () => {
    const newer = pod('api-9', {
      ownerName: 'api-aaaa',
      labels: { 'pod-template-hash': 'aaaa' },
    });
    expect(replacementPod([newer], overview())?.name).toBe('api-9');
  });

  it('skips the dead pod, pods being deleted and pods not ready', () => {
    const notReady = pod('api-3');
    notReady.containers[0].ready = false;
    const pods = [
      pod('api-1', { created: overview().created }),
      pod('api-2', { deleting: true }),
      notReady,
      pod('other', { ownerName: 'other-7f9c' }),
    ];
    expect(replacementPod(pods, overview())).toBeNull();
  });

  it('accepts a StatefulSet pod that came back under the same name', () => {
    const old = overview({ ownerKind: 'StatefulSet', ownerName: 'db', name: 'db-0', labels: {} });
    const back = pod('db-0', { ownerKind: 'StatefulSet', ownerName: 'db', labels: {} });
    expect(replacementPod([back], old)?.name).toBe('db-0');
  });

  it('has nothing to offer a pod without a workload', () => {
    expect(replacementPod([pod('x')], overview({ ownerKind: '', ownerName: '' }))).toBeNull();
  });
});

describe('why a shell did not open', () => {
  it('names each cause', () => {
    expect(shellNote({ kind: 'noShell' })).toContain('셸(sh)이 없어');
    expect(shellNote({ kind: 'notRunning' })).toContain('실행 중이 아니어서');
    expect(shellNote({ kind: 'blocked', state: { kind: 'channelLimit' } })).toContain(
      '동시 세션 한도',
    );
    expect(shellNote({ kind: 'blocked', state: { kind: 'forbidden' } })).toContain('pods/exec');
    expect(shellNote({ kind: 'blocked', state: { kind: 'unknown', message: 'odd' } })).toContain(
      'odd',
    );
  });
});
