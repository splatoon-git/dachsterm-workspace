import type { MetricCandidate, MetricSeries, ProbeProcess, TcpStates } from './runtimeTypes';
import { seriesSelector } from './workers';

const MAX_SHOWN_SERIES = 200;

export type ProcessGroup = {
  name: string;
  count: number;
  threads: number;
  /** Sum of the descriptors this account could read; `null` when it could read none. */
  fds: number | null;
  /** The tightest limit among them. */
  fdLimit: number | null;
  oldestSeconds: number | null;
};

/** Worker pools read as one line: `gunicorn ×8`, with nginx's master and workers kept apart. */
export function groupProcesses(processes: ProbeProcess[]): ProcessGroup[] {
  const groups = new Map<string, ProcessGroup>();
  for (const item of processes) {
    const group = groups.get(item.name) ?? {
      name: item.name,
      count: 0,
      threads: 0,
      fds: null,
      fdLimit: null,
      oldestSeconds: null,
    };
    group.count += 1;
    group.threads += item.threads;
    if (item.fds !== null) group.fds = (group.fds ?? 0) + item.fds;
    if (item.fdLimit !== null)
      group.fdLimit = group.fdLimit === null ? item.fdLimit : Math.min(group.fdLimit, item.fdLimit);
    if (item.ageSeconds !== null)
      group.oldestSeconds = Math.max(group.oldestSeconds ?? 0, item.ageSeconds);
    groups.set(item.name, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export const tcpRows = (tcp: TcpStates): [string, number][] => [
  ['ESTABLISHED', tcp.established],
  ['SYN_RECV', tcp.synRecv],
  ['SYN_SENT', tcp.synSent],
  ['TIME_WAIT', tcp.timeWait],
  ['CLOSE_WAIT', tcp.closeWait],
  ['FIN_WAIT', tcp.finWait1 + tcp.finWait2],
  ['LAST_ACK', tcp.lastAck],
  ['LISTEN', tcp.listen],
];

const NOISE = [/^go_/, /^process_/, /^promhttp_/, /^python_gc_/, /^python_info$/, /^scrape_/];
const isNoise = (name: string) =>
  NOISE.some((pattern) => pattern.test(name)) || /_(bucket|created)$/.test(name);

export type MetricRow = {
  selector: string;
  name: string;
  /** Empty for a sum over several series. */
  labels: string;
  value: number;
  /** The number of series a sum covers; 1 for an ordinary row. */
  series: number;
};

/**
 * The series worth choosing from: runtime internals and histogram buckets are left out, and a name
 * with several series also gets a row that adds them up.
 */
export function metricRows(series: MetricSeries[]): MetricRow[] {
  const useful = series.filter((item) => !isNoise(item.name));
  const byName = new Map<string, MetricSeries[]>();
  for (const item of useful) byName.set(item.name, [...(byName.get(item.name) ?? []), item]);
  return [...byName.entries()].flatMap(([name, items]) => {
    const rows = items.map((item): MetricRow => ({
      selector: seriesSelector(item),
      name,
      labels: item.labels,
      value: item.value,
      series: 1,
    }));
    if (items.length === 1) return rows;
    const sum: MetricRow = {
      selector: name,
      name,
      labels: '',
      value: items.reduce((total, item) => total + item.value, 0),
      series: items.length,
    };
    return [sum, ...rows];
  });
}

/** Same language as the tree's filter: spaces are AND and `!word` excludes. Pins stay on top. */
export function shownMetricRows(rows: MetricRow[], query: string, pins: string[]) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const wanted = words.filter((word) => !word.startsWith('!'));
  const unwanted = words.filter((word) => word.startsWith('!') && word.length > 1);
  const pinned = (row: MetricRow) => pins.includes(row.selector);
  const matching = rows
    .filter((row) => {
      const text = row.selector.toLowerCase();
      return (
        pinned(row) ||
        (wanted.every((word) => text.includes(word)) &&
          !unwanted.some((word) => text.includes(word.slice(1))))
      );
    })
    .sort((a, b) => Number(pinned(b)) - Number(pinned(a)));
  return {
    rows: matching.slice(0, MAX_SHOWN_SERIES),
    more: Math.max(0, matching.length - MAX_SHOWN_SERIES),
  };
}

export type RoleName = 'busy' | 'total' | 'completed';
export const roleLabels: Record<RoleName, string> = {
  busy: '사용 중',
  total: '전체',
  completed: '완료 수',
};
export const roleNames = Object.keys(roleLabels) as RoleName[];

/** The number the user typed for a port, or `null` for anything else. */
export function parsePort(text: string): number | null {
  if (!/^[0-9]{1,5}$/.test(text.trim())) return null;
  const port = Number(text.trim());
  return port >= 1 && port <= 65535 ? port : null;
}

export const candidateLabel = (candidate: MetricCandidate) =>
  `${candidate.https ? 'https ' : ''}:${candidate.port}${candidate.path}`;

export const formatMetric = (value: number) =>
  Number.isInteger(value)
    ? String(value)
    : value.toLocaleString('en-US', { maximumFractionDigits: 3, useGrouping: false });

export function formatAgeSeconds(seconds: number | null) {
  if (seconds === null) return '';
  if (seconds < 60) return `${seconds}초`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}시간`;
  return `${Math.floor(seconds / 86400)}일`;
}
