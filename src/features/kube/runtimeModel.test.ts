import { describe, expect, it } from 'vitest';
import {
  candidateLabel,
  formatAgeSeconds,
  formatMetric,
  groupProcesses,
  isNearLimit,
  metricRows,
  parsePort,
  percentOf,
  processStateLabel,
  runtimeGrowth,
  shownMetricRows,
} from './runtimeModel';
import type { ProbeProcess, Runtime } from './runtimeTypes';

const process = (over: Partial<ProbeProcess>): ProbeProcess => ({
  pid: 1,
  name: 'w',
  state: 'S',
  threads: 1,
  fds: 2,
  fdLimit: 1024,
  ageSeconds: 10,
  ...over,
});

const series = (name: string, value = 1, labels = '') => ({ name, value, labels });

describe('process groups', () => {
  it('counts a worker pool as one line, largest first', () => {
    const groups = groupProcesses([
      process({ pid: 1, name: 'nginx: master', threads: 1 }),
      process({ pid: 2, name: 'nginx: worker', threads: 4, fds: 10, ageSeconds: 50 }),
      process({ pid: 3, name: 'nginx: worker', threads: 4, fds: 20, fdLimit: 512, ageSeconds: 5 }),
    ]);
    expect(groups.map((g) => [g.name, g.count])).toEqual([
      ['nginx: worker', 2],
      ['nginx: master', 1],
    ]);
    expect(groups[0]).toMatchObject({
      threads: 8,
      fds: 30,
      fullest: { fds: 20, limit: 512 },
      oldestSeconds: 50,
    });
  });

  it('keeps an unreadable count apart from zero', () => {
    const [group] = groupProcesses([process({ fds: null, fdLimit: null, ageSeconds: null })]);
    expect(group).toMatchObject({ fds: null, fullest: null, oldestSeconds: null });
    const [mixed] = groupProcesses([process({ fds: null }), process({ pid: 2, fds: 3 })]);
    expect(mixed.fds).toBe(3);
  });
});

describe('runtime warnings', () => {
  const runtime = (closeWait: number, overflows: number | null): Runtime => ({
    processes: [],
    truncated: false,
    tcp: {
      established: 0,
      synSent: 0,
      synRecv: 0,
      finWait1: 0,
      finWait2: 0,
      timeWait: 0,
      close: 0,
      closeWait,
      lastAck: 0,
      listen: 0,
      closing: 0,
    },
    listen: [],
    counters: { listenOverflows: overflows, listenDrops: 0, retransmitted: 0 },
  });

  it('judges descriptors per process, so a large pool is not over its limit by adding up', () => {
    const [group] = groupProcesses([
      process({ pid: 1, fds: 600, fdLimit: 1024 }),
      process({ pid: 2, fds: 700, fdLimit: 1024 }),
    ]);
    expect(group.fds).toBe(1300);
    expect(group.fullest).toEqual({ fds: 700, limit: 1024 });
    expect(isNearLimit(700, 1024)).toBe(false);
    expect(percentOf(700, 1024)).toBe('68%');
  });

  it('calls a limit near from four fifths and never for a missing limit', () => {
    expect(isNearLimit(79, 100)).toBe(false);
    expect(isNearLimit(80, 100)).toBe(true);
    expect(isNearLimit(5, 0)).toBe(false);
  });

  it('counts only what rose since the last collection', () => {
    expect(runtimeGrowth(runtime(9, 12), runtime(4, 10))).toMatchObject({
      closeWait: 5,
      listenOverflows: 2,
    });
    expect(runtimeGrowth(runtime(9, 12), null).closeWait).toBe(0);
    expect(runtimeGrowth(runtime(1, 0), runtime(4, 10))).toMatchObject({
      closeWait: 0,
      listenOverflows: 0,
    });
    expect(runtimeGrowth(runtime(1, null), runtime(1, 10)).listenOverflows).toBe(0);
  });

  it('names the process states and keeps a letter it does not know', () => {
    expect(processStateLabel('Z')).toBe('좀비');
    expect(processStateLabel('X')).toBe('X');
  });
});

describe('metric list', () => {
  it('leaves out runtime internals and histogram buckets', () => {
    const rows = metricRows([
      series('go_goroutines'),
      series('process_cpu_seconds_total'),
      series('http_seconds_bucket', 1, 'le="1"'),
      series('worker_busy', 8),
    ]);
    expect(rows.map((row) => row.selector)).toEqual(['worker_busy']);
  });

  it('adds a total row for a name with several series', () => {
    const rows = metricRows([
      series('requests', 3, 'code="200"'),
      series('requests', 2, 'code="500"'),
    ]);
    expect(rows.map((row) => [row.selector, row.value, row.series])).toEqual([
      ['requests', 5, 2],
      ['requests{code="200"}', 3, 1],
      ['requests{code="500"}', 2, 1],
    ]);
  });

  it('filters the way the tree does and keeps pins on top even if filtered out', () => {
    const rows = metricRows([series('a_busy'), series('b_total'), series('c_done')]);
    const filtered = shownMetricRows(rows, 'busy', []);
    expect(filtered.rows.map((row) => row.selector)).toEqual(['a_busy']);
    expect(shownMetricRows(rows, '!busy', []).rows.map((r) => r.selector)).toEqual([
      'b_total',
      'c_done',
    ]);
    const pinned = shownMetricRows(rows, 'busy', ['c_done']);
    expect(pinned.rows.map((row) => row.selector)).toEqual(['c_done', 'a_busy']);
  });

  it('bounds what it draws and says how much is left', () => {
    const rows = metricRows(Array.from({ length: 205 }, (_, n) => series(`m${n}`)));
    const shown = shownMetricRows(rows, '', []);
    expect(shown.rows).toHaveLength(200);
    expect(shown.more).toBe(5);
  });
});

describe('inputs and formats', () => {
  it('accepts only a real port', () => {
    expect(parsePort(' 8080 ')).toBe(8080);
    for (const bad of ['', '0', '65536', '80a', '-1', '1.5']) expect(parsePort(bad)).toBeNull();
  });

  it('labels a candidate', () => {
    const base = { port: 80, path: '/metrics', https: false, annotated: false };
    expect(candidateLabel(base)).toBe(':80/metrics');
    expect(candidateLabel({ ...base, https: true })).toBe('https :80/metrics');
  });

  it('prints whole numbers whole and fractions short', () => {
    expect(formatMetric(8)).toBe('8');
    expect(formatMetric(0.12345)).toBe('0.123');
  });

  it('prints an age in its largest unit', () => {
    expect(formatAgeSeconds(null)).toBe('');
    expect(formatAgeSeconds(5)).toBe('5초');
    expect(formatAgeSeconds(120)).toBe('2분');
    expect(formatAgeSeconds(7200)).toBe('2시간');
    expect(formatAgeSeconds(172800)).toBe('2일');
  });
});
