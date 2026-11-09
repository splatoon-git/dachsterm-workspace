import { describe, expect, it } from 'vitest';
import type { PathRow } from './ingressModel';
import {
  boardScopeOfGroup,
  flowEntries,
  levelOf,
  LineStore,
  MAX_BOARD_SOURCES,
  resolveSources,
  scopeEntry,
  shortPodName,
  visibleLines,
} from './logBoardModel';
import type { KubePod, KubeService } from './snapshotTypes';

const pod = (name: string, patch: Partial<KubePod> = {}) =>
  ({
    namespace: 'web',
    name,
    node: 'n1',
    phase: 'Running',
    ownerKind: 'ReplicaSet',
    ownerName: 'api-7f9c',
    labels: { app: 'api' },
    defaultContainer: 'app',
    containers: [{ name: 'app', restarts: 0 }],
    ...patch,
  }) as KubePod;
const service = {
  namespace: 'web',
  name: 'api',
  selector: { app: 'api' },
} as unknown as KubeService;
const controller = { namespace: 'ingress-nginx', name: 'ctl-1', container: 'controller' };
const row = (name: string, port = '80') =>
  ({ namespace: 'web', rule: { service: name, port } }) as unknown as PathRow;
const none = new Set<string>();
const key = 'web/api-1/app';
const source = { key, lane: 'pods' as const };
const time = (second: number) => `2026-11-08T12:00:${String(second).padStart(2, '0')}.000000001Z`;

describe('resolveSources', () => {
  it('follows the pods a service selects now, so a rollout changes the list', () => {
    const entries = [scopeEntry({ kind: 'service', value: 'web/api' })];
    const before = resolveSources(entries, [pod('api-1')], [service], [], none);
    expect(before.sources.map((s) => s.pod)).toEqual(['api-1']);
    const after = resolveSources(entries, [pod('api-2')], [service], [], none);
    expect(after.sources.map((s) => s.pod)).toEqual(['api-2']);
  });

  it('follows every pod on a node and skips one that has not started', () => {
    const pods = [
      pod('a', { node: 'n1' }),
      pod('b', { node: 'n2' }),
      pod('c', { node: 'n1', phase: 'Pending' }),
    ];
    const { sources } = resolveSources(
      [scopeEntry({ kind: 'node', value: 'n1' })],
      pods,
      [],
      [],
      none,
    );
    expect(sources.map((s) => s.pod)).toEqual(['a']);
  });

  it('puts controllers first and in the ingress lane, with the entry filter', () => {
    const entries = flowEntries([row('api')]);
    const { sources } = resolveSources(entries, [pod('api-1')], [service], [controller], none);
    expect(sources.map((s) => [s.pod, s.lane, s.filter])).toEqual([
      ['ctl-1', 'ingress', '[web-api-80]'],
      ['api-1', 'pods', ''],
    ]);
  });

  it('counts a pod reached twice once and leaves out what the user removed', () => {
    const entries = [
      scopeEntry({ kind: 'service', value: 'web/api' }),
      scopeEntry({ kind: 'pod', value: 'web/api-1' }),
    ];
    const pods = [pod('api-1'), pod('api-2')];
    expect(resolveSources(entries, pods, [service], [], none).sources).toHaveLength(2);
    const removed = new Set([key]);
    expect(resolveSources(entries, pods, [service], [], removed).sources.map((s) => s.pod)).toEqual(
      ['api-2'],
    );
  });

  it('stops at the limit and says how many it left out', () => {
    const pods = Array.from({ length: MAX_BOARD_SOURCES + 3 }, (_, n) => pod(`p${n}`));
    const result = resolveSources([scopeEntry({ kind: 'all', value: '' })], pods, [], [], none);
    expect(result.sources).toHaveLength(MAX_BOARD_SOURCES);
    expect(result.omitted).toBe(3);
  });
});

describe('flowEntries', () => {
  it('leaves the controller unfiltered when several upstreams share the row', () => {
    const [first, ...rest] = flowEntries([row('api'), row('web')]);
    expect(first.filter).toBe('');
    expect(rest.map((entry) => entry.scope.value)).toEqual(['web/api', 'web/web']);
  });

  it('names one upstream however many paths lead to it', () => {
    expect(flowEntries([row('api'), row('api')])[0].filter).toBe('[web-api-80]');
  });
});

describe('boardScopeOfGroup', () => {
  it('reads node groups as well as the groups a search understands', () => {
    expect(boardScopeOfGroup('node:worker-1')).toEqual({ kind: 'node', value: 'worker-1' });
    expect(boardScopeOfGroup('ns:web/svc:api')).toEqual({ kind: 'service', value: 'web/api' });
    expect(boardScopeOfGroup('nodes')).toBeNull();
  });
});

describe('levelOf', () => {
  it.each([
    ['ERROR something broke', 'error'],
    ['2026 [WARN] slow', 'warn'],
    ['E1108 12:00:00 klog failure', 'error'],
    ['{"level":"error","msg":"x"}', 'error'],
    ['level=warning msg=x', 'warn'],
    ['level=info msg="an error happened"', 'normal'],
    ['java.lang.NullPointerException at x', 'error'],
    ['handled 3 errors fine', 'normal'],
  ])('%s is %s', (text, level) => {
    expect(levelOf(text, false)).toBe(level);
  });

  it('reads the status of an access log rather than its words', () => {
    expect(levelOf('1.2.3.4 "GET /error HTTP/1.1" 200 12 "-"', true)).toBe('normal');
    expect(levelOf('1.2.3.4 "GET / HTTP/1.1" 404 12 "-"', true)).toBe('warn');
    expect(levelOf('1.2.3.4 "GET / HTTP/1.1" 502 12 "-"', true)).toBe('error');
  });
});

describe('LineStore', () => {
  it('skips what a resumed stream repeats and keeps what is new', () => {
    const store = new LineStore();
    store.add(source, time(1), 'one');
    store.add(source, time(2), 'two');
    store.resume(key);
    store.add(source, time(2), 'two');
    store.add(source, time(3), 'three');
    expect(store.lines(key).map((line) => line.text)).toEqual(['one', 'two', 'three']);
  });

  it('keeps lines that share a time in a stream that was not resumed', () => {
    const store = new LineStore();
    store.add(source, time(1), 'a');
    store.add(source, time(1), 'b');
    expect(store.lines(key)).toHaveLength(2);
  });

  it('orders the merged view by log time across sources', () => {
    const store = new LineStore();
    const other = { key: 'web/api-2/app', lane: 'pods' as const };
    store.add(source, time(5), 'later');
    store.add(other, time(3), 'earlier');
    expect(store.all().map((line) => line.text)).toEqual(['earlier', 'later']);
  });

  it('stays bounded however long it runs', () => {
    const store = new LineStore();
    for (let n = 0; n < 5000; n++) store.add(source, `${time(1)}${n}`, `line ${n}`);
    expect(store.lines(key).length).toBeLessThanOrEqual(2500);
    expect(store.lines(key).at(-1)?.text).toBe('line 4999');
  });

  it('counts errors and a clear does not bring lines back on restart', () => {
    const store = new LineStore();
    store.add(source, time(1), 'ERROR x');
    expect(store.errorCount(key)).toBe(1);
    store.clear();
    expect(store.errorCount(key)).toBe(0);
    expect(store.lastTime(key)).toBe(time(1));
  });
});

describe('visibleLines', () => {
  const store = new LineStore();
  store.add(source, time(1), 'alpha ok');
  store.add(source, time(2), 'ERROR beta');
  store.add(source, time(3), 'alpha late');
  const lines = store.lines(key);

  it('returns the same array when nothing narrows it', () => {
    expect(visibleLines(lines, { query: '', errorsOnly: false, upTo: null })).toBe(lines);
  });

  it('applies the filter language, the errors switch and a pause together', () => {
    const texts = (view: Parameters<typeof visibleLines>[1]) =>
      visibleLines(lines, view).map((line) => line.text);
    expect(texts({ query: 'alpha !late', errorsOnly: false, upTo: null })).toEqual(['alpha ok']);
    expect(texts({ query: '', errorsOnly: true, upTo: null })).toEqual(['ERROR beta']);
    expect(texts({ query: '', errorsOnly: false, upTo: 2 })).toEqual(['alpha ok', 'ERROR beta']);
  });
});

it('shortens a generated pod name to what differs', () => {
  expect(shortPodName('api-7f9c-a1b2')).toBe('7f9c-a1b2');
  expect(shortPodName('solo')).toBe('solo');
});
