import type { KubeNode, KubeNodeUsage, KubePod, KubeWorkload } from './snapshotTypes';
import { severity, totalsOf, worse, type Health, type PodView, type Totals } from './treePods';
import type { TreeTarget } from './treeReveal';

export type Grouping = 'workload' | 'service' | 'node';
export const groupings: { id: Grouping; label: string }[] = [
  { id: 'workload', label: 'namespace > 워크로드 > 파드' },
  { id: 'service', label: 'namespace > 서비스 > 파드' },
  { id: 'node', label: '노드 > namespace > 파드' },
];
export const nextGrouping = (grouping: Grouping) =>
  groupings[(groupings.findIndex((item) => item.id === grouping) + 1) % groupings.length].id;

export type SortColumn =
  'name' | 'status' | 'ready' | 'restarts' | 'cpu' | 'memory' | 'node' | 'age';
export type TreeSort = { column: SortColumn; descending: boolean };
export const defaultSort: TreeSort = { column: 'name', descending: false };

/** What the screen must keep while it is swapped for the server terminal or another screen. */
export type TreeView = {
  query: string;
  problemsOnly: boolean;
  activeId: string;
  /** Where the selection was, for when its row disappears: a pod that was replaced. */
  activeIndex: number;
  sort: TreeSort;
  /** Asked for by another screen; the tree moves there once and clears it. */
  reveal: TreeTarget | null;
};
export const initialTreeView = (): TreeView => ({
  query: '',
  problemsOnly: false,
  activeId: '',
  activeIndex: 0,
  sort: defaultSort,
  reveal: null,
});

/** Measures read worst or largest first on the first click; names read A to Z. */
export function nextSort(sort: TreeSort, column: SortColumn): TreeSort {
  if (sort.column === column) return { column, descending: !sort.descending };
  return { column, descending: column !== 'name' && column !== 'node' };
}

export type TreeGroup = {
  id: string;
  label: string;
  /** What kind of thing this is, shown beside the name so the levels read apart. */
  type: string;
  note: string;
  health: Health;
  /** Catch-all groups stay at the end of their level whatever the sort. */
  last: boolean;
  groups: TreeGroup[];
  pods: PodView[];
  /** Unique pods below this group: a pod in two services counts once in its namespace. */
  count: number;
  totals: Totals;
};

/** One step of a pod's path through the tree. */
type Level = {
  id: string;
  label: string;
  type: string;
  last?: boolean;
  note?: string;
  health?: Health;
};
type Building = Level & { children: Map<string, Building>; pods: PodView[] };

const workloadLevelId = (kind: string, name: string) => `wl:${kind}/${name}`;
export const workloadGroupId = (namespace: string, kind: string, name: string) =>
  `ns:${namespace}/${workloadLevelId(kind, name)}`;
export const nodeGroupId = (name: string) => `node:${name}`;
export const podRowId = (groupId: string, name: string) => `${groupId}/pod:${name}`;
export const nodeRowId = (name: string) => `nodes/${name}`;

const namespaceLevel = (namespace: string): Level => ({
  id: `ns:${namespace}`,
  label: namespace,
  type: 'namespace',
});

function serviceLevels(view: PodView): Level[] {
  if (!view.services.length)
    return [{ id: 'no-service', label: '서비스 없음', type: '', last: true }];
  return view.services.map((service) => ({
    id: `svc:${service.name}`,
    label: service.name,
    type: service.serviceType || 'Service',
    note: `엔드포인트 준비 ${service.readyEndpoints}/${service.readyEndpoints + service.notReadyEndpoints}`,
    health: service.readyEndpoints === 0 ? 'warn' : 'ok',
  }));
}

/**
 * Grouped by owner so every cluster reads the same. A ReplicaSet's name is its Deployment's name
 * plus the pod's `pod-template-hash`. Without that label it stays a ReplicaSet.
 */
function ownerOf(pod: KubePod) {
  if (!pod.ownerKind) return null;
  const suffix = `-${pod.labels['pod-template-hash'] ?? ''}`;
  if (pod.ownerKind === 'ReplicaSet' && suffix.length > 1 && pod.ownerName.endsWith(suffix))
    return { kind: 'Deployment', name: pod.ownerName.slice(0, -suffix.length) };
  return { kind: pod.ownerKind, name: pod.ownerName };
}

function workloadLevel(view: PodView, known: Map<string, KubeWorkload>): Level {
  const owner = ownerOf(view.pod);
  if (!owner) return { id: 'no-workload', label: '단독 파드', type: '', last: true };
  const found = known.get(`${owner.kind}/${view.pod.namespace}/${owner.name}`);
  return {
    id: workloadLevelId(owner.kind, owner.name),
    label: `${owner.kind}/${owner.name}`,
    type: '',
    note: found ? `준비 ${found.ready}/${found.desired}` : undefined,
    health: found && found.ready < found.desired ? 'warn' : 'ok',
  };
}

function nodeState(node: KubeNode): { text: string; health: Health } {
  if (!node.ready) return { text: 'NotReady', health: 'error' };
  if (node.unschedulable) return { text: '스케줄 중지', health: 'warn' };
  return { text: 'Ready', health: 'ok' };
}

function nodeLevel(view: PodView, nodes: Map<string, KubeNode>): Level {
  const name = view.pod.node;
  if (!name) return { id: 'no-node', label: '노드 미배정', type: '', last: true };
  const node = nodes.get(name);
  const state = node && nodeState(node);
  return {
    id: nodeGroupId(name),
    label: name,
    type: 'Node',
    note: state?.text,
    health: state?.health,
  };
}

function finishGroup(building: Building, parentId: string): TreeGroup {
  const id = parentId ? `${parentId}/${building.id}` : building.id;
  const groups = finishChildren(building, id);
  const pods = [...building.pods].sort((a, b) => a.pod.name.localeCompare(b.pod.name));
  const unique = new Map<string, PodView>(pods.map((view) => [view.key, view]));
  const walk = (group: TreeGroup) => {
    group.pods.forEach((view) => unique.set(view.key, view));
    group.groups.forEach(walk);
  };
  groups.forEach(walk);
  const totals = totalsOf(unique.values());
  return {
    id,
    label: building.label,
    type: building.type,
    note: building.note ?? '',
    health: worse(totals.health, building.health ?? 'ok'),
    last: building.last ?? false,
    groups,
    pods,
    count: unique.size,
    totals,
  };
}

function finishChildren(building: Pick<Building, 'children'>, parentId: string) {
  return [...building.children.values()]
    .sort(
      (a, b) => Number(a.last ?? false) - Number(b.last ?? false) || a.label.localeCompare(b.label),
    )
    .map((child) => finishGroup(child, parentId));
}

export function buildForest(
  views: PodView[],
  grouping: Grouping,
  workloads: KubeWorkload[],
  nodes: KubeNode[],
): TreeGroup[] {
  const knownWorkloads = new Map(workloads.map((w) => [`${w.kind}/${w.namespace}/${w.name}`, w]));
  const knownNodes = new Map(nodes.map((node) => [node.name, node]));
  const paths = (view: PodView): Level[][] => {
    const namespace = namespaceLevel(view.pod.namespace);
    if (grouping === 'node') return [[nodeLevel(view, knownNodes), namespace]];
    if (grouping === 'workload') return [[namespace, workloadLevel(view, knownWorkloads)]];
    return serviceLevels(view).map((level) => [namespace, level]);
  };
  const root: Pick<Building, 'children'> = { children: new Map() };
  for (const view of views) {
    for (const path of paths(view)) {
      let at = root;
      let leaf: Building | null = null;
      for (const level of path) {
        let next = at.children.get(level.id);
        if (!next) {
          next = { ...level, children: new Map(), pods: [] };
          at.children.set(level.id, next);
        }
        at = next;
        leaf = next;
      }
      leaf?.pods.push(view);
    }
  }
  return finishChildren(root, '');
}

type Sortable = {
  name: string;
  status: number;
  ready: number;
  restarts: number;
  cpu: number | null;
  memory: number | null;
  node: string;
  age: number | null;
};

const ratio = (ready: number, total: number) => (total ? ready / total : 0);

function groupValues(group: TreeGroup): Sortable {
  const { totals } = group;
  return {
    name: group.label,
    status: severity[group.health],
    ready: ratio(totals.ready, totals.total),
    restarts: totals.restarts,
    cpu: totals.cpu ?? totals.cpuRequest,
    memory: totals.memory ?? totals.memoryRequest,
    node: '',
    age: null,
  };
}

function podValues(view: PodView): Sortable {
  const created = Date.parse(view.pod.created);
  return {
    name: view.pod.name,
    status: severity[view.health],
    ready: ratio(view.ready, view.total),
    restarts: view.restarts,
    cpu: view.cpu ?? view.pod.cpuRequest,
    memory: view.memory ?? view.pod.memoryRequest,
    node: view.pod.node,
    // Larger is older, so "descending" means oldest first like the other measures.
    age: Number.isFinite(created) ? -created : null,
  };
}

/** Unknown values stay at the bottom in both directions, and ties read in name order. */
function compare(a: Sortable, b: Sortable, sort: TreeSort) {
  const [left, right] = [a[sort.column], b[sort.column]];
  if (left === null || right === null || left === '' || right === '') {
    const missing = Number(left === null || left === '') - Number(right === null || right === '');
    if (missing) return missing;
  } else {
    const order =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right));
    if (order) return sort.descending ? -order : order;
  }
  return a.name.localeCompare(b.name);
}

export function sortForest(forest: TreeGroup[], sort: TreeSort): TreeGroup[] {
  if (sort.column === defaultSort.column && !sort.descending) return forest;
  return [...forest]
    .sort(
      (a, b) => Number(a.last) - Number(b.last) || compare(groupValues(a), groupValues(b), sort),
    )
    .map((group) => ({
      ...group,
      groups: sortForest(group.groups, sort),
      pods: [...group.pods].sort((a, b) => compare(podValues(a), podValues(b), sort)),
    }));
}

export type NodeView = {
  node: KubeNode;
  status: string;
  health: Health;
  pods: number;
  cpu: number | null;
  memory: number | null;
};
export type NodeSection = { ready: number; total: number; health: Health; nodes: NodeView[] };

/** `get nodes` and `top nodes` are polled anyway, so showing this adds no query. */
export function nodeSection(
  nodes: KubeNode[] | null,
  usage: KubeNodeUsage[],
  views: PodView[],
): NodeSection | null {
  if (!nodes?.length) return null;
  const used = new Map(usage.map((item) => [item.name, item]));
  const pods = new Map<string, number>();
  for (const view of views) pods.set(view.pod.node, (pods.get(view.pod.node) ?? 0) + 1);
  const list = [...nodes]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((node): NodeView => {
      const state = nodeState(node);
      return {
        node,
        status: state.text,
        health: state.health,
        pods: pods.get(node.name) ?? 0,
        cpu: used.get(node.name)?.cpu ?? null,
        memory: used.get(node.name)?.memory ?? null,
      };
    });
  return {
    ready: list.filter((item) => item.node.ready).length,
    total: list.length,
    health: list.reduce<Health>((health, item) => worse(health, item.health), 'ok'),
    nodes: list,
  };
}

export type GroupRow = {
  type: 'group';
  id: string;
  depth: number;
  group: TreeGroup;
  expanded: boolean;
  toggle: string;
};
export type PodRow = { type: 'pod'; id: string; depth: number; view: PodView };
export type NodeSectionRow = {
  type: 'nodes';
  id: string;
  depth: number;
  section: NodeSection;
  expanded: boolean;
  toggle: string;
};
export type NodeRow = { type: 'node'; id: string; depth: number; view: NodeView };
export type TreeRow = GroupRow | PodRow | NodeSectionRow | NodeRow;

const NODES_OPENED = 'nodes:opened';
const NODES_CLOSED = 'nodes:closed';

/**
 * The node list is folded while every node is fine and open while one is not. Each case has its
 * own remembered choice, so folding it once does not hide a node that breaks later.
 */
function nodesRow(section: NodeSection, folds: ReadonlySet<string>): NodeSectionRow {
  const broken = section.ready < section.total;
  const expanded = broken ? !folds.has(NODES_CLOSED) : folds.has(NODES_OPENED);
  return {
    type: 'nodes',
    id: 'nodes',
    depth: 0,
    section,
    expanded,
    toggle: broken ? NODES_CLOSED : NODES_OPENED,
  };
}

/** Folds with the node list open, whichever of its two remembered cases applies now. */
export function unfoldNodes(section: NodeSection, folds: ReadonlySet<string>) {
  const next = new Set(folds);
  if (section.ready < section.total) next.delete(NODES_CLOSED);
  else next.add(NODES_OPENED);
  return next;
}

/** `showAll` is for a filter: what matched must be visible even inside a folded group. */
export function treeRows(
  section: NodeSection | null,
  forest: TreeGroup[],
  folds: ReadonlySet<string>,
  showAll: boolean,
): TreeRow[] {
  const rows: TreeRow[] = [];
  if (section) {
    const row = nodesRow(section, folds);
    rows.push(row);
    if (row.expanded)
      for (const view of section.nodes)
        rows.push({ type: 'node', id: nodeRowId(view.node.name), depth: 1, view });
  }
  const visit = (group: TreeGroup, depth: number) => {
    const expanded = showAll || !folds.has(group.id);
    rows.push({ type: 'group', id: group.id, depth, group, expanded, toggle: group.id });
    if (!expanded) return;
    group.groups.forEach((child) => visit(child, depth + 1));
    for (const view of group.pods)
      rows.push({ type: 'pod', id: podRowId(group.id, view.pod.name), depth: depth + 1, view });
  };
  forest.forEach((group) => visit(group, 0));
  return rows;
}
