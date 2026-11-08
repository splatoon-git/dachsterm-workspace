import { describe, expect, it } from 'vitest';
import {
  applyIngress,
  backendTarget,
  checkNotes,
  emptyIngress,
  filterHostGroups,
  hostGroups,
  hostKeyword,
  ingressProblems,
  trafficNote,
  upstreamKeyword,
  type IngressData,
} from './ingressModel';
import type { HostTraffic, IngressReport, IngressRule, KubeIngress, Traffic } from './ingressTypes';
import { emptySnapshots, type SnapshotStore } from './polling';
import type { KubePod, KubeService } from './snapshotTypes';

const rule = (patch: Partial<IngressRule> = {}): IngressRule => ({
  host: 'ok.local',
  path: '/',
  pathType: 'Prefix',
  service: 'web',
  port: '80',
  isDefault: false,
  backend: 'ok',
  readyEndpoints: 2,
  notReadyEndpoints: 0,
  ...patch,
});

const ingress = (patch: Partial<KubeIngress> = {}): KubeIngress => ({
  namespace: 'shop',
  name: 'front',
  className: 'nginx',
  addresses: ['10.0.0.5'],
  tls: [],
  rules: [rule()],
  ...patch,
});

const hostTraffic = (patch: Partial<HostTraffic> = {}): HostTraffic => ({
  host: 'ok.local',
  ok: 0,
  redirect: 0,
  clientError: 0,
  serverError: 0,
  other: 0,
  durationSum: 0,
  durationCount: 0,
  ...patch,
});

const ready = (hosts: HostTraffic[]): Traffic => ({
  kind: 'ready',
  controllers: 1,
  read: 1,
  hosts,
  connections: 1,
});

const report = (patch: Partial<IngressReport> = {}): IngressReport => ({
  state: { kind: 'ready' },
  ingresses: [ingress()],
  servicesState: { kind: 'ready' },
  secretsState: { kind: 'ready' },
  controllers: [{ namespace: 'ingress-nginx', name: 'c-1', container: 'controller' }],
  traffic: { kind: 'off' },
  collectedAt: 1_000,
  elapsedMs: 10,
  ...patch,
});

const after = (...reports: IngressReport[]): IngressData =>
  reports.reduce(applyIngress, emptyIngress);

describe('configuration findings', () => {
  it('names each thing that is wrong with a host', () => {
    const data = after(
      report({
        ingresses: [
          ingress({
            addresses: [],
            tls: [{ secret: 'cert', hosts: ['ok.local'], missing: true }],
            rules: [
              rule({ backend: 'noReady', readyEndpoints: 0 }),
              rule({ path: '/gone', service: 'ghost', backend: 'noService' }),
            ],
          }),
        ],
      }),
    );
    const [group] = hostGroups(data);
    expect(group.health).toBe('error');
    expect(group.problems).toEqual([
      '백엔드 준비 0: web',
      '주소 미할당',
      'TLS Secret 없음: cert',
      '백엔드 없음: ghost',
    ]);
  });

  it('counts a host only under the Tls entries that cover it', () => {
    const data = after(
      report({
        ingresses: [
          ingress({
            tls: [{ secret: 'cert', hosts: ['*.example.com'], missing: true }],
            rules: [rule({ host: 'a.example.com' }), rule({ host: 'other.local' })],
          }),
        ],
      }),
    );
    const groups = hostGroups(data);
    const byHost = (host: string) => groups.find((group) => group.host === host);
    expect(byHost('a.example.com')?.paths[0].tls).toBe(true);
    expect(byHost('a.example.com')?.problems).toEqual(['TLS Secret 없음: cert']);
    expect(byHost('other.local')?.paths[0].tls).toBe(false);
    expect(byHost('other.local')?.problems).toEqual([]);
  });

  it('puts failures first and joins the paths of a host across Ingresses', () => {
    const data = after(
      report({
        ingresses: [
          ingress({ rules: [rule({ host: 'a.local' })] }),
          ingress({ name: 'one', rules: [rule({ host: 'b.local' })] }),
          ingress({
            name: 'two',
            rules: [rule({ host: 'b.local', path: '/x', backend: 'noReady' })],
          }),
        ],
      }),
    );
    const groups = hostGroups(data);
    expect(groups.map((group) => group.host)).toEqual(['b.local', 'a.local']);
    expect(groups[0].paths).toHaveLength(2);
  });

  it('does not report what could not be checked', () => {
    const data = after(
      report({
        ingresses: [ingress({ rules: [rule({ backend: 'unchecked' })] })],
        servicesState: { kind: 'forbidden' },
        secretsState: { kind: 'timedOut' },
      }),
    );
    expect(hostGroups(data)[0].problems).toEqual([]);
    expect(checkNotes(data)).toEqual([
      '백엔드를 확인하지 못했습니다: 권한 없음',
      'TLS Secret을 확인하지 못했습니다: 조회 시간 초과, namespace를 좁히세요',
    ]);
  });

  it('caps what the dashboard lists', () => {
    const rules = Array.from({ length: 35 }, (_, at) =>
      rule({ host: `h${at}.local`, backend: 'noReady' }),
    );
    const list = ingressProblems(hostGroups(after(report({ ingresses: [ingress({ rules })] }))));
    expect(list.items).toHaveLength(30);
    expect(list.more).toBe(5);
    expect(ingressProblems(hostGroups(after(report()))).items).toEqual([]);
  });
});

describe('filter', () => {
  const groups = hostGroups(
    after(
      report({
        ingresses: [
          ingress({
            rules: [
              rule({ host: 'shop.local', path: '/api', service: 'api', backend: 'noReady' }),
              rule({ host: 'shop.local', path: '/static', service: 'files' }),
              rule({ host: 'blog.local', service: 'blog' }),
            ],
          }),
        ],
      }),
    ),
  );

  it('finds by any column and keeps only the paths that match', () => {
    const found = filterHostGroups(groups, 'static', false);
    expect(found.map((group) => group.host)).toEqual(['shop.local']);
    expect(found[0].paths.map((row) => row.rule.path)).toEqual(['/static']);
    expect(filterHostGroups(groups, 'BLOG', false)[0].host).toBe('blog.local');
  });

  it('narrows to what is wrong', () => {
    const found = filterHostGroups(groups, '', true);
    expect(found.map((group) => group.host)).toEqual(['shop.local']);
    expect(found[0].paths.map((row) => row.rule.path)).toEqual(['/api']);
  });
});

describe('traffic', () => {
  const first = hostTraffic({
    ok: 60,
    clientError: 20,
    serverError: 20,
    durationSum: 5,
    durationCount: 100,
  });
  const rateOf = (data: IngressData) => data.rates['ok.local'];

  it('shows totals until there are two samples to compare', () => {
    const rate = rateOf(after(report({ traffic: ready([first]) })));
    expect(rate).toEqual({
      perSecond: null,
      ok: 60,
      clientError: 20,
      serverError: 20,
      latencyMs: 50,
      basis: 'total',
    });
  });

  it('turns two samples into a rate and the shares of that interval', () => {
    const data = after(
      report({ traffic: ready([first]), collectedAt: 1_000 }),
      report({
        traffic: ready([
          hostTraffic({
            ok: 60,
            clientError: 20,
            serverError: 40,
            durationSum: 7,
            durationCount: 120,
          }),
        ]),
        collectedAt: 11_000,
      }),
    );
    expect(rateOf(data)).toEqual({
      perSecond: 2,
      ok: 0,
      clientError: 0,
      serverError: 100,
      latencyMs: 100,
      basis: 'recent',
    });
  });

  it('counts a quiet interval as zero and keeps the totals for the shares', () => {
    const data = after(
      report({ traffic: ready([first]), collectedAt: 1_000 }),
      report({ traffic: ready([first]), collectedAt: 31_000 }),
    );
    expect(rateOf(data).perSecond).toBe(0);
    expect(rateOf(data).basis).toBe('total');
    expect(rateOf(data).ok).toBe(60);
  });

  it('takes a counter that went down for a controller restart', () => {
    const data = after(
      report({ traffic: ready([first]), collectedAt: 1_000 }),
      report({ traffic: ready([hostTraffic({ ok: 5 })]), collectedAt: 31_000 }),
    );
    expect(rateOf(data).perSecond).toBeNull();
    expect(rateOf(data).ok).toBe(100);
  });

  it('does not compare samples from different numbers of controllers', () => {
    const data = after(
      report({ traffic: ready([first]), collectedAt: 1_000 }),
      report({
        traffic: {
          kind: 'ready',
          controllers: 2,
          read: 2,
          hosts: [hostTraffic({ ok: 200 })],
          connections: 2,
        },
        collectedAt: 31_000,
      }),
    );
    expect(rateOf(data).perSecond).toBeNull();
  });

  it('says a host has no requests yet rather than 0%', () => {
    const rate = rateOf(after(report({ traffic: ready([hostTraffic()]) })));
    expect(rate.basis).toBe('none');
    expect(rate.ok).toBeNull();
  });

  it('keeps the numbers on screen through a failed read and says so', () => {
    const data = after(
      report({ traffic: ready([first]) }),
      report({ traffic: { kind: 'failed', state: { kind: 'channelLimit' } } }),
    );
    expect(data.traffic.kind).toBe('ready');
    expect(rateOf(data).ok).toBe(60);
    expect(trafficNote(data)).toBe('지난 조회의 트래픽입니다: 서버의 동시 세션 한도에 걸림');
  });

  it('drops the numbers when traffic stops being readable', () => {
    const data = after(
      report({ traffic: ready([first]) }),
      report({ traffic: { kind: 'proxyForbidden' } }),
    );
    expect(data.rates).toEqual({});
    expect(data.sample).toBeNull();
  });

  it('gives one plain reason for each way traffic is absent', () => {
    const note = (traffic: Traffic) => trafficNote(after(report({ traffic })));
    expect(note({ kind: 'off' })).toContain('컨트롤러 메트릭이 꺼져 있어');
    expect(note({ kind: 'off' })).not.toContain('실패');
    expect(note({ kind: 'proxyForbidden' })).toBe(
      'pods/proxy 권한이 없어 트래픽을 표시하지 못합니다.',
    );
    expect(note({ kind: 'noController' })).toContain('ingress-nginx 컨트롤러가 없어');
    expect(note({ kind: 'failed', state: { kind: 'timedOut' } })).toContain('읽지 못했습니다');
    expect(note(ready([]))).toBe('');
    expect(note({ kind: 'ready', controllers: 3, read: 1, hosts: [], connections: 0 })).toBe(
      '컨트롤러 3개 중 1개만 읽었습니다.',
    );
  });
});

describe('polls that fail', () => {
  it('keeps the last list through a brief failure', () => {
    const data = after(
      report(),
      report({ state: { kind: 'unreachable' }, ingresses: null, traffic: { kind: 'notRead' } }),
    );
    expect(data.ingresses).toHaveLength(1);
    expect(data.state).toEqual({ kind: 'unreachable' });
    expect(data.traffic.kind).toBe('off');
  });

  it('empties the list when the account may not read it', () => {
    const data = after(
      report(),
      report({ state: { kind: 'forbidden' }, ingresses: null, traffic: { kind: 'notRead' } }),
    );
    expect(data.ingresses).toBeNull();
    expect(data.state).toEqual({ kind: 'forbidden' });
  });
});

describe('going from a path to what serves it', () => {
  const service: KubeService = {
    namespace: 'shop',
    name: 'web',
    serviceType: 'ClusterIP',
    selector: { app: 'web' },
    readyEndpoints: 1,
    notReadyEndpoints: 1,
  };
  const pod = (name: string, ready: boolean, labels = { app: 'web' }) =>
    ({
      namespace: 'shop',
      name,
      labels,
      containers: [{ ready }],
    }) as unknown as KubePod;
  const row = () => hostGroups(after(report()))[0].paths[0];
  const storeWith = (pods: KubePod[], services = [service]): SnapshotStore => ({
    ...emptySnapshots(),
    pods: { data: pods, collectedAt: 1, state: { kind: 'ready' } },
    services: { data: services, collectedAt: 1, state: { kind: 'ready' } },
  });

  it('goes to a failing pod when there is one', () => {
    const store = storeWith([
      pod('good', true),
      pod('bad', false),
      pod('other', false, { app: 'x' } as never),
    ]);
    expect(backendTarget(row(), store)).toEqual({ type: 'pod', namespace: 'shop', name: 'bad' });
  });

  it('goes to the first pod when all are fine', () => {
    expect(backendTarget(row(), storeWith([pod('a', true), pod('b', true)]))).toEqual({
      type: 'pod',
      namespace: 'shop',
      name: 'a',
    });
  });

  it('lands on the namespace when the backend has no pods', () => {
    expect(backendTarget(row(), storeWith([]))).toEqual({ type: 'namespace', namespace: 'shop' });
    expect(backendTarget(row(), storeWith([], []))).toEqual({
      type: 'namespace',
      namespace: 'shop',
    });
  });

  it('builds the keywords a controller log can be searched with', () => {
    expect(hostKeyword('ok.local')).toBe('ok.local');
    expect(hostKeyword('*.example.com')).toBe('example.com');
    expect(upstreamKeyword(row())).toBe('shop-web-80');
  });
});
