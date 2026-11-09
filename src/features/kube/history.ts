import { lastStop } from './dashboard';
import type { SnapshotStore } from './polling';
import {
  objectOf,
  problemSources,
  readProblems,
  sourceOf,
  type Problem,
  type ProblemSource,
  type Reading,
} from './problems';
import type { KubeNode, KubePod } from './snapshotTypes';
import { nodeState } from './tree';
import type { Health } from './treePods';
import type { TreeTarget } from './treeReveal';

export const MAX_CHANGES = 500;
/**
 * How long a warning must last to count, and how long a problem must stay away to count as over.
 * A rollout's new pods sit in ContainerCreating for seconds, and a crash loop is Running between
 * its failures. Neither should write a line each time or raise an alert.
 */
export const ISSUE_HOLD = 60_000;
const MAX_ALERTS = 64;

export type Change = {
  id: number;
  at: number;
  kind: 'node' | 'restart' | 'broke' | 'recovered' | 'gone';
  health: Health;
  object: string;
  detail: string;
  target: TreeTarget | null;
};

export type Alert = { id: number; problem: Problem };

type Tracked = { problem: Problem; firstSeen: number; lastSeen: number; confirmed: boolean };

/** Kept in memory while the tab is open and never saved (design KV.7). */
export type IssueLog = {
  /** When each kind was last read. A failed poll keeps old data and must not count as a new look. */
  readAt: Partial<Record<ProblemSource, number>>;
  tracked: ReadonlyMap<string, Tracked>;
  restarts: ReadonlyMap<string, ReadonlyMap<string, number>>;
  nodes: ReadonlyMap<string, string>;
  /** Newest first. */
  changes: Change[];
  /** Problems that became real, oldest first. A reader remembers the last `id` it has handled. */
  alerts: Alert[];
  nextId: number;
};

export const emptyIssues = (): IssueLog => ({
  readAt: {},
  tracked: new Map(),
  restarts: new Map(),
  nodes: new Map(),
  changes: [],
  alerts: [],
  nextId: 1,
});

type Draft = {
  tracked: Map<string, Tracked>;
  changes: Change[];
  alerts: Alert[];
  nextId: number;
};

function write(draft: Draft, change: Omit<Change, 'id'>) {
  draft.changes.push({ ...change, id: draft.nextId++ });
}

const containerCounts = (pod: KubePod) =>
  new Map(pod.containers.map((container) => [container.name, container.restarts]));

/** Returns the pods that restarted. A pod with a lower count is a new one under the same name. */
function diffRestarts(draft: Draft, log: IssueLog, pods: KubePod[], at: number) {
  const restarted = new Set<string>();
  const counts = new Map<string, ReadonlyMap<string, number>>();
  for (const pod of pods) {
    const key = `${pod.namespace}/${pod.name}`;
    const now = containerCounts(pod);
    counts.set(key, now);
    const before = log.restarts.get(key);
    if (!before) continue;
    let added = 0;
    for (const [name, restarts] of now)
      added += Math.max(0, restarts - (before.get(name) ?? restarts));
    if (added === 0) continue;
    restarted.add(key);
    const { reason } = lastStop(pod);
    write(draft, {
      at,
      kind: 'restart',
      health: 'warn',
      object: key,
      detail: reason ? `+${added} · ${reason}` : `+${added}`,
      target: { type: 'pod', namespace: pod.namespace, name: pod.name },
    });
  }
  return { restarted, counts };
}

function diffNodes(draft: Draft, log: IssueLog, nodes: KubeNode[], at: number) {
  const states = new Map<string, string>();
  for (const node of nodes) {
    const { text, health } = nodeState(node);
    states.set(node.name, text);
    const before = log.nodes.get(node.name);
    if (before === undefined || before === text) continue;
    write(draft, {
      at,
      kind: 'node',
      health,
      object: node.name,
      detail: `${before} → ${text}`,
      target: { type: 'node', name: node.name },
    });
  }
  for (const name of log.nodes.keys())
    if (!states.has(name))
      write(draft, {
        at,
        kind: 'gone',
        health: 'ok',
        object: name,
        detail: '노드 없어짐',
        target: null,
      });
  return states;
}

/** Nodes and restarts have their own lines, with what changed instead of only that it did. */
const hasOwnLines = (problem: Problem) => problem.kind === 'node' || problem.kind === 'restart';

function raise(draft: Draft, problem: Problem, at: number, restarted: ReadonlySet<string>) {
  draft.alerts.push({ id: draft.nextId++, problem });
  if (hasOwnLines(problem) || restarted.has(objectOf(problem))) return;
  write(draft, {
    at,
    kind: 'broke',
    health: problem.health,
    object: problem.object,
    detail: problem.detail,
    target: problem.target,
  });
}

function settle(draft: Draft, problem: Problem, at: number, reading: Reading) {
  if (hasOwnLines(problem)) return;
  write(draft, {
    at,
    kind: reading.objects.has(objectOf(problem)) ? 'recovered' : 'gone',
    health: 'ok',
    object: problem.object,
    detail: problem.detail,
    target: problem.target,
  });
}

/** The first look at a kind is the baseline: what was already wrong did not just happen. */
function track(
  draft: Draft,
  source: ProblemSource,
  reading: Reading,
  at: number,
  first: boolean,
  restarted: ReadonlySet<string>,
) {
  for (const problem of reading.problems) {
    const known = draft.tracked.get(problem.key);
    const firstSeen = known?.firstSeen ?? at;
    const confirmed =
      first ||
      (known?.confirmed ?? false) ||
      problem.health === 'error' ||
      at - firstSeen >= ISSUE_HOLD;
    if (confirmed && !known?.confirmed && !first) raise(draft, problem, at, restarted);
    draft.tracked.set(problem.key, { problem, firstSeen, lastSeen: at, confirmed });
  }
  const present = new Set(reading.problems.map((problem) => problem.key));
  for (const [key, item] of draft.tracked) {
    if (sourceOf(item.problem) !== source || present.has(key)) continue;
    if (at - item.lastSeen < ISSUE_HOLD) continue;
    draft.tracked.delete(key);
    if (item.confirmed) settle(draft, item.problem, at, reading);
  }
}

const noRestarts: ReadonlySet<string> = new Set();

/** Returns the same object when no kind brought new data, so a failed poll changes nothing. */
export function advanceIssues(log: IssueLog, store: SnapshotStore): IssueLog {
  const due = problemSources.flatMap((source) => {
    const at = store[source].collectedAt;
    if (at === null || log.readAt[source] === at) return [];
    const reading = readProblems(source, store);
    return reading ? [{ source, reading, at }] : [];
  });
  if (!due.length) return log;

  const draft: Draft = {
    tracked: new Map(log.tracked),
    changes: [],
    alerts: [],
    nextId: log.nextId,
  };
  const readAt = { ...log.readAt };
  let { restarts, nodes } = log;
  for (const { source, reading, at } of due) {
    let restarted = noRestarts;
    if (source === 'pods' && store.pods.data) {
      const diff = diffRestarts(draft, log, store.pods.data, at);
      restarted = diff.restarted;
      restarts = diff.counts;
    } else if (source === 'nodes' && store.nodes.data) {
      nodes = diffNodes(draft, log, store.nodes.data, at);
    }
    track(draft, source, reading, at, log.readAt[source] === undefined, restarted);
    readAt[source] = at;
  }
  return {
    readAt,
    tracked: draft.tracked,
    restarts,
    nodes,
    changes: [...draft.changes.reverse(), ...log.changes].slice(0, MAX_CHANGES),
    alerts: [...log.alerts, ...draft.alerts].slice(-MAX_ALERTS),
    nextId: draft.nextId,
  };
}
