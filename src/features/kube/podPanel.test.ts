import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerDetail, PodEvent, PodOverview } from './detailTypes';
import {
  causeContainer,
  causeRows,
  chooseContainer,
  detailTab,
  filterLines,
  importantEvents,
  panelTabs,
  rememberContainer,
} from './podPanel';

const container = (name: string, patch: Partial<ContainerDetail> = {}): ContainerDetail => ({
  name,
  image: 'img',
  ready: true,
  restarts: 0,
  state: 'running',
  reason: '',
  message: '',
  exitCode: null,
  startedAt: '',
  finishedAt: '',
  containerId: '',
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
  uid: 'u',
  phase: 'Running',
  reason: '',
  message: '',
  node: '',
  podIp: '',
  hostIp: '',
  qosClass: '',
  created: '',
  deleting: false,
  ownerKind: 'ReplicaSet',
  ownerName: 'api-7f9c',
  defaultContainer: '',
  labels: { 'pod-template-hash': '7f9c' },
  initContainers: [],
  containers: [container('app')],
  ...patch,
});

describe('filterLines', () => {
  const text = 'GET /a ok\nPOST /b error\nGET /c error\n';

  it('keeps every line without a query and drops the trailing newline', () => {
    expect(filterLines(text, '')).toHaveLength(3);
    expect(filterLines('', '')).toEqual([]);
  });

  it('treats spaces as AND and !word as exclude, ignoring case', () => {
    expect(filterLines(text, 'get ERROR')).toEqual(['GET /c error']);
    expect(filterLines(text, 'error !post')).toEqual(['GET /c error']);
    expect(filterLines(text, '!')).toHaveLength(3);
  });
});

describe('the panel tabs', () => {
  it('shows the cause tab only for a problem pod', () => {
    expect(panelTabs(true).map((tab) => tab.id)).toContain('cause');
    expect(panelTabs(false).map((tab) => tab.id)).not.toContain('cause');
  });

  it('opens a problem pod on its cause', () => {
    expect(detailTab(true)).toBe('cause');
    expect(detailTab(false)).toBe('overview');
  });
});

describe('the cause of a failure', () => {
  it('shows the last termination of a container that is waiting to restart', () => {
    const crashing = container('app', {
      state: 'waiting',
      ready: false,
      reason: 'CrashLoopBackOff',
      restarts: 4,
      last: {
        reason: 'OOMKilled',
        message: 'killed',
        exitCode: 137,
        startedAt: '',
        finishedAt: '2026-11-08T10:00:00Z',
      },
    });
    const [row] = causeRows(overview({ containers: [crashing] }));
    expect(row).toMatchObject({
      container: 'app',
      current: 'CrashLoopBackOff',
      reason: 'OOMKilled',
      exitCode: 137,
      time: '2026-11-08T10:00:00Z',
    });
  });

  it('reports a container stopped between restarts from its own state', () => {
    const stopped = container('app', {
      state: 'terminated',
      ready: false,
      reason: 'Error',
      exitCode: 3,
      finishedAt: 'T',
    });
    expect(causeRows(overview({ containers: [stopped] }))[0]).toMatchObject({
      current: '종료됨',
      reason: 'Error',
      exitCode: 3,
      time: 'T',
    });
  });

  it('leaves out healthy containers and includes failed init containers', () => {
    const init = container('setup', {
      state: 'terminated',
      ready: false,
      reason: 'Error',
      exitCode: 1,
    });
    const rows = causeRows(overview({ initContainers: [init] }));
    expect(rows.map((row) => row.container)).toEqual(['setup']);
  });

  it('reads the logs of the container that restarted most', () => {
    const pod = overview({
      containers: [container('a'), container('b', { restarts: 5 }), container('c')],
    });
    expect(causeContainer(pod)).toBe('b');
    expect(causeContainer(overview({ containers: [] }))).toBe('');
  });

  it('puts warnings first within the limit', () => {
    const event = (eventType: string, reason: string): PodEvent => ({
      eventType,
      reason,
      count: 1,
      time: 't',
      message: '',
    });
    const events = [event('Normal', 'Pulled'), event('Warning', 'BackOff')];
    expect(importantEvents(events, 1).map((item) => item.reason)).toEqual(['BackOff']);
  });
});

describe('choosing a container', () => {
  beforeEach(() => {
    const items = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const two = (patch: Partial<PodOverview> = {}) =>
    overview({ containers: [container('main'), container('side')], ...patch });

  it('needs no choice with one container', () => {
    expect(chooseContainer(overview(), 's')).toBe('app');
  });

  it('follows the default-container annotation', () => {
    expect(chooseContainer(two({ defaultContainer: 'side' }), 's')).toBe('side');
  });

  it('asks when nothing decides, then remembers per workload', () => {
    expect(chooseContainer(two(), 's')).toBeNull();
    rememberContainer('s', two(), 'side');
    expect(chooseContainer(two(), 's')).toBe('side');
    expect(chooseContainer(two({ ownerName: 'other-1' }), 's')).toBeNull();
  });

  it('ignores a remembered name the pod no longer has', () => {
    rememberContainer('s', two(), 'gone');
    expect(chooseContainer(two(), 's')).toBeNull();
  });

  it('survives what another version may have stored', () => {
    localStorage.setItem('dachsterm.kube.container.s', '{broken');
    expect(chooseContainer(two(), 's')).toBeNull();
    localStorage.setItem('dachsterm.kube.container.s', '[1,2]');
    expect(chooseContainer(two(), 's')).toBeNull();
  });
});
