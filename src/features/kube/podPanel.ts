import type { ContainerDetail, PodEvent, PodOverview } from './detailTypes';
import { ownerOf } from './tree';

export type PodPanelTab =
  'logs' | 'cause' | 'overview' | 'runtime' | 'events' | 'yaml' | 'relations';
export type PodPanelTarget = { namespace: string; name: string; tab: PodPanelTab };

const tabLabels: { id: PodPanelTab; label: string }[] = [
  { id: 'logs', label: '로그' },
  { id: 'cause', label: '장애 원인' },
  { id: 'overview', label: '개요' },
  { id: 'runtime', label: '런타임' },
  { id: 'events', label: '이벤트' },
  { id: 'yaml', label: 'YAML' },
  { id: 'relations', label: '관계' },
];

export const panelTabs = (problem: boolean) =>
  problem ? tabLabels : tabLabels.filter((tab) => tab.id !== 'cause');

/** What "상세" opens: a problem pod goes straight to its cause. */
export const detailTab = (problem: boolean): PodPanelTab => (problem ? 'cause' : 'overview');

/** Same language as the tree's filter: spaces are AND and `!word` excludes. `null` keeps all. */
export function lineMatcher(query: string): ((line: string) => boolean) | null {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const wanted = words.filter((word) => !word.startsWith('!'));
  const unwanted = words.filter((word) => word.startsWith('!') && word.length > 1);
  if (!wanted.length && !unwanted.length) return null;
  return (line) => {
    const lower = line.toLowerCase();
    return (
      wanted.every((word) => lower.includes(word)) &&
      !unwanted.some((word) => lower.includes(word.slice(1)))
    );
  };
}

export function filterLines(text: string, query: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const matches = lineMatcher(query);
  return matches ? lines.filter(matches) : lines;
}

export const formatTime = (iso: string) => {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : iso;
};

export type CauseRow = {
  container: string;
  /** What the container is doing now, such as `CrashLoopBackOff`. */
  current: string;
  /** The last time it ended, such as `OOMKilled`. */
  reason: string;
  exitCode: number | null;
  time: string;
  message: string;
};

const runningFine = (c: ContainerDetail) => c.state === 'running' && c.ready && !c.last;

function causeRow(c: ContainerDetail): CauseRow {
  const ended = c.state === 'terminated';
  const last = ended ? null : c.last;
  return {
    container: c.name,
    current:
      c.state === 'waiting' ? c.reason : ended ? '종료됨' : c.state === 'running' ? '실행 중' : '',
    reason: last?.reason ?? (ended ? c.reason : ''),
    exitCode: last?.exitCode ?? (ended ? c.exitCode : null),
    time: last?.finishedAt ?? (ended ? c.finishedAt : ''),
    message: last?.message || (c.state === 'waiting' || ended ? c.message : ''),
  };
}

/** The containers worth explaining, most broken first: init containers fail a pod just the same. */
export function causeRows(overview: PodOverview): CauseRow[] {
  return [...overview.initContainers, ...overview.containers]
    .filter((c) => !runningFine(c) && (c.state !== '' || c.last !== null))
    .sort((a, b) => Number(runningFine(a)) - Number(runningFine(b)) || b.restarts - a.restarts)
    .map(causeRow);
}

/** Whose previous log the cause view shows: the container that restarted most, then the first. */
export function causeContainer(overview: PodOverview): string {
  const [first, ...others] = overview.containers;
  if (!first) return '';
  return others.reduce((best, c) => (c.restarts > best.restarts ? c : best), first).name;
}

/** Warnings first, since the cause view has room for few. */
export function importantEvents(events: PodEvent[], limit: number): PodEvent[] {
  const rank = (event: PodEvent) => (event.eventType === 'Warning' ? 0 : 1);
  return [...events].sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

const STORE_PREFIX = 'dachsterm.kube.container.';
const MAX_REMEMBERED = 200;

/** `namespace/Kind/name`, or `namespace/pod` for a pod with no owner. */
export const workloadKey = (pod: PodOverview) => {
  const owner = ownerOf(pod);
  return `${pod.namespace}/${owner ? `${owner.kind}/${owner.name}` : pod.name}`;
};

function readRemembered(session: string): Record<string, string> {
  if (!session) return {};
  try {
    const value = JSON.parse(localStorage.getItem(STORE_PREFIX + session) ?? '{}') as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    // A convenience only: a damaged or blocked store means nothing was remembered.
    return {};
  }
}

export function rememberContainer(session: string, pod: PodOverview, container: string) {
  if (!session) return;
  const all = { ...readRemembered(session), [workloadKey(pod)]: container };
  const kept = Object.entries(all).slice(-MAX_REMEMBERED);
  try {
    localStorage.setItem(STORE_PREFIX + session, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Choosing again next time is the only cost of a full or blocked store.
  }
}

/** The annotation wins, then the last choice for this workload. `null` means the user must pick. */
export function chooseContainer(pod: PodOverview, session: string): string | null {
  const names = pod.containers.map((c) => c.name);
  if (names.length === 1) return names[0];
  if (names.includes(pod.defaultContainer)) return pod.defaultContainer;
  const remembered = readRemembered(session)[workloadKey(pod)];
  return remembered && names.includes(remembered) ? remembered : null;
}
