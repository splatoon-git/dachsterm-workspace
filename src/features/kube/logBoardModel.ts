import type { PathRow } from './ingressModel';
import { upstreamKeyword } from './ingressModel';
import type { IngressController } from './ingressTypes';
import type { KubeState } from './kubeModel';
import {
  logTimeMs,
  podsInScope,
  scopeOfGroup,
  searchTargets,
  type SearchScope,
} from './logSearchModel';
import { lineMatcher } from './podPanel';
import type { KubePod, KubeService } from './snapshotTypes';

/** Mirrors `kube/log_stream.rs`. */
export type StreamLine = { source: number; time: string; text: string };
export type StreamEvent =
  | { type: 'started' }
  | { type: 'lines'; lines: StreamLine[]; dropped: number }
  | { type: 'sourceEnded'; source: number; state: KubeState }
  | { type: 'finished'; state: KubeState };
export type StreamRequest = {
  namespace: string;
  pod: string;
  container: string;
  tail: number;
  since: string | null;
  filter: string | null;
};

/** What the backend accepts on one stream. */
export const MAX_BOARD_SOURCES = 20;
export const INITIAL_TAIL = 200;
const MAX_LINES_PER_SOURCE = 2000;
const MAX_LINES_MERGED = 10_000;
/** Sources arrive a little out of step; further back than this is not worth the time. */
const MAX_REORDER_STEPS = 200;

export type BoardScope = SearchScope | { kind: 'node'; value: string };
/** Something the user asked to follow. Pods are worked out from it, so a rollout is followed too. */
export type BoardEntry = { id: string; label: string; scope: BoardScope; filter: string };

export type BoardLane = 'ingress' | 'pods';
export type BoardSource = {
  key: string;
  namespace: string;
  pod: string;
  container: string;
  node: string;
  lane: BoardLane;
  filter: string;
  /** Position in the palette of `sourceTones`. */
  tone: number;
};

/** The terminal's own colors: they are the ones chosen to read on the panes' background. */
export const sourceTones = [
  'bright-cyan',
  'bright-green',
  'bright-yellow',
  'bright-magenta',
  'bright-blue',
  'bright-red',
] as const;
export const toneColor = (tone: number) =>
  `var(--terminal-${sourceTones[tone % sourceTones.length]})`;

export const sourceKey = (namespace: string, pod: string, container: string) =>
  `${namespace}/${pod}/${container}`;

export function scopeEntry(scope: BoardScope): BoardEntry {
  const short = scope.value.split('/').at(-1) ?? scope.value;
  const labels: Record<BoardScope['kind'], string> = {
    all: '전체 파드',
    namespace: `namespace ${scope.value}`,
    workload: short,
    service: `서비스 ${short}`,
    pod: short,
    controller: '인그레스 컨트롤러',
    node: `노드 ${scope.value}`,
  };
  return {
    id: `${scope.kind}:${scope.value}`,
    label: labels[scope.kind],
    scope,
    filter: '',
  };
}

/** The tree's group ids, plus the node grouping that a log search has no use for. */
export function boardScopeOfGroup(id: string): BoardScope | null {
  const node = /^node:(.+)$/.exec(id);
  return node ? { kind: 'node', value: node[1] } : scopeOfGroup(id);
}

/**
 * What an ingress row opens: the controller's log above the service's pods. A controller log holds
 * every host, so it is narrowed to the upstream name when there is only one to name (KV.8: the
 * default access log has no host in it).
 */
export function flowEntries(rows: PathRow[]): BoardEntry[] {
  const backends = rows.filter((row) => row.rule.service);
  const upstreams = [...new Set(backends.map(upstreamKeyword))];
  const services = [...new Set(backends.map((row) => `${row.namespace}/${row.rule.service}`))];
  return [
    {
      ...scopeEntry({ kind: 'controller', value: '' }),
      filter: upstreams.length === 1 ? `[${upstreams[0]}]` : '',
    },
    ...services.map((value) => scopeEntry({ kind: 'service', value })),
  ];
}

const podsOf = (scope: BoardScope, pods: KubePod[], services: KubeService[]) =>
  scope.kind === 'node'
    ? pods.filter((pod) => pod.node === scope.value)
    : podsInScope(scope, pods, services);

export type Resolved = { sources: BoardSource[]; omitted: number };

/** The containers to follow now, controllers first so a long pod list cannot push them out. */
export function resolveSources(
  entries: BoardEntry[],
  pods: KubePod[],
  services: KubeService[],
  controllers: IngressController[],
  excluded: ReadonlySet<string>,
): Resolved {
  const found = new Map<string, Omit<BoardSource, 'tone'>>();
  const add = (source: Omit<BoardSource, 'tone'>) => {
    if (!excluded.has(source.key) && !found.has(source.key)) found.set(source.key, source);
  };
  for (const entry of entries) {
    if (entry.scope.kind !== 'controller') continue;
    for (const item of controllers)
      add({
        key: sourceKey(item.namespace, item.name, item.container),
        namespace: item.namespace,
        pod: item.name,
        container: item.container,
        node: '',
        lane: 'ingress',
        filter: entry.filter,
      });
  }
  for (const entry of entries) {
    if (entry.scope.kind === 'controller') continue;
    const inScope = podsOf(entry.scope, pods, services);
    const options = { allContainers: false, previous: false };
    for (const target of searchTargets(inScope, options)) {
      const pod = inScope.find(
        (item) => item.namespace === target.namespace && item.name === target.pod,
      );
      add({
        key: sourceKey(target.namespace, target.pod, target.containers[0]),
        namespace: target.namespace,
        pod: target.pod,
        container: target.containers[0],
        node: pod?.node ?? '',
        lane: 'pods',
        filter: entry.filter,
      });
    }
  }
  const all = [...found.values()];
  return {
    sources: all.slice(0, MAX_BOARD_SOURCES).map((source, tone) => ({ ...source, tone })),
    omitted: Math.max(0, all.length - MAX_BOARD_SOURCES),
  };
}

export type LogLevel = 'error' | 'warn' | 'normal';

const SEVERE_WORD = /\b(?:FATAL|PANIC|ERROR|ERR|CRITICAL|CRIT)\b|\b\w+Exception\b|^[EF]\d{4} /;
const WARN_WORD = /\b(?:WARN|WARNING)\b|^W\d{4} /;
/** `level=error`, `"level":"error"`, in the spellings structured loggers use. */
const FIELD_LEVEL = /["']?(?:level|severity|lvl)["']?\s*[:=]\s*["']?(\w+)/i;
/** The status after the quoted request in an access log. */
const ACCESS_STATUS = /" ([1-5])\d\d /;

/** A guess from the text, used only for color and the errors-only switch. */
export function levelOf(text: string, access: boolean): LogLevel {
  if (access) {
    const status = ACCESS_STATUS.exec(text)?.[1];
    if (status === '5') return 'error';
    if (status === '4') return 'warn';
    if (status) return 'normal';
  }
  const field = FIELD_LEVEL.exec(text)?.[1]?.toLowerCase();
  if (field) {
    if (/^(?:fatal|panic|error|err|critical|crit)$/.test(field)) return 'error';
    if (/^warn(?:ing)?$/.test(field)) return 'warn';
    return 'normal';
  }
  if (SEVERE_WORD.test(text)) return 'error';
  return WARN_WORD.test(text) ? 'warn' : 'normal';
}

export type BoardLine = {
  seq: number;
  key: string;
  time: string;
  at: number;
  text: string;
  level: LogLevel;
};

const trimmed = (lines: BoardLine[], limit: number) => {
  // Cutting a little past the limit at a time keeps an array shift off every single line.
  if (lines.length > limit * 1.25) lines.splice(0, lines.length - limit);
};

/** Log lines in memory only, and bounded: nothing here reaches a file or the session log. */
/** A log time's fraction digits, padded because Go drops trailing zeros. They compare as text. */
const fractionOf = (time: string) => (/\.(\d+)/.exec(time)?.[1] ?? '').padEnd(9, '0');

export class LineStore {
  private readonly bySource = new Map<string, BoardLine[]>();
  private readonly merged: BoardLine[] = [];
  private readonly last = new Map<string, { time: string; at: number }>();
  private readonly resuming = new Map<string, { time: string; at: number }>();
  private readonly errors = new Map<string, number>();
  private seq = 0;

  get lastSeq() {
    return this.seq;
  }
  lines(key: string) {
    return this.bySource.get(key) ?? [];
  }
  all() {
    return this.merged;
  }
  errorCount(key: string) {
    return this.errors.get(key) ?? 0;
  }
  lastTime(key: string) {
    return this.last.get(key)?.time ?? null;
  }

  /** A restarted stream asks from the last time it saw, so that time comes back and is skipped. */
  resume(key: string) {
    const seen = this.last.get(key);
    if (seen) this.resuming.set(key, seen);
  }

  add(source: Pick<BoardSource, 'key' | 'lane'>, time: string, text: string) {
    const at = logTimeMs(time);
    const from = this.resuming.get(source.key);
    if (from) {
      // `at` stops at the millisecond; lines inside the resume point's millisecond need the rest.
      if (at < from.at || (at === from.at && fractionOf(time) <= fractionOf(from.time))) return;
      this.resuming.delete(source.key);
    }
    const level = levelOf(text, source.lane === 'ingress');
    const line: BoardLine = { seq: ++this.seq, key: source.key, time, at, text, level };
    const own = this.bySource.get(source.key);
    if (own) own.push(line);
    else this.bySource.set(source.key, [line]);
    this.last.set(source.key, { time, at });
    if (level === 'error') this.errors.set(source.key, this.errorCount(source.key) + 1);
    if (own) trimmed(own, MAX_LINES_PER_SOURCE);
    this.insertMerged(line);
  }

  private insertMerged(line: BoardLine) {
    const { merged } = this;
    let at = merged.length - 1;
    merged.push(line);
    for (let step = 0; step < MAX_REORDER_STEPS && at >= 0 && merged[at].at > line.at; step++) {
      merged[at + 1] = merged[at];
      at--;
    }
    merged[at + 1] = line;
    trimmed(merged, MAX_LINES_MERGED);
  }

  /** Clears the screen. The last times stay, so a restart does not bring the lines back. */
  clear() {
    this.bySource.clear();
    this.merged.length = 0;
    this.errors.clear();
  }
}

export type LineView = { query: string; errorsOnly: boolean; upTo: number | null };

export function visibleLines(lines: BoardLine[], view: LineView): BoardLine[] {
  const matches = lineMatcher(view.query);
  if (!matches && !view.errorsOnly && view.upTo === null) return lines;
  return lines.filter(
    (line) =>
      (view.upTo === null || line.seq <= view.upTo) &&
      (!view.errorsOnly || line.level !== 'normal') &&
      (!matches || matches(line.text)),
  );
}

const two = (value: number) => String(value).padStart(2, '0');

/** Local time of day to the millisecond: the date is the same on nearly every line of a live log. */
export function clockTime(at: number) {
  if (!at) return '';
  const date = new Date(at);
  const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${milliseconds}`;
}

/** A pod's generated suffix tells panes apart better than its long shared prefix. */
export function shortPodName(pod: string) {
  const parts = pod.split('-');
  return parts.length > 2 ? parts.slice(-2).join('-') : pod;
}

export type BoardPrefs = { fontSize: number; wrap: boolean; ingressHeight: number };
export const FONT_SIZES = { min: 10, max: 20 };
const defaultPrefs: BoardPrefs = { fontSize: 12, wrap: false, ingressHeight: 240 };
const PREFS_KEY = 'dachsterm.kube.board';

export function readBoardPrefs(): BoardPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<BoardPrefs>;
    const fontSize = Number(saved.fontSize);
    const ingressHeight = Number(saved.ingressHeight);
    return {
      fontSize:
        fontSize >= FONT_SIZES.min && fontSize <= FONT_SIZES.max ? fontSize : defaultPrefs.fontSize,
      wrap: saved.wrap === true,
      ingressHeight: ingressHeight >= 80 ? ingressHeight : defaultPrefs.ingressHeight,
    };
  } catch {
    // A convenience only: a damaged or blocked store means the defaults.
    return defaultPrefs;
  }
}

export function writeBoardPrefs(prefs: BoardPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Choosing the size again next time is the only cost of a full or blocked store.
  }
}
