import {
  buildForest,
  nodeGroupId,
  nodeRowId,
  podRowId,
  unfoldNodes,
  workloadGroupId,
  type Grouping,
  type NodeSection,
  type TreeGroup,
} from './tree';
import { filterActive, matches, type Filter, type PodView } from './treePods';
import type { KubeNode, KubeWorkload } from './snapshotTypes';

/** A place in the tree that another screen can send the user to. */
export type TreeTarget =
  | { type: 'pod'; namespace: string; name: string }
  | { type: 'workload'; kind: string; namespace: string; name: string }
  | { type: 'node'; name: string }
  | { type: 'namespace'; namespace: string };

type Found = { rowId: string; ancestors: string[] };

function search(
  groups: TreeGroup[],
  parents: string[],
  hit: (group: TreeGroup, parents: string[]) => Found | null,
): Found | null {
  for (const group of groups) {
    const found = hit(group, parents) ?? search(group.groups, [...parents, group.id], hit);
    if (found) return found;
  }
  return null;
}

const groupHit =
  (matchesGroup: (group: TreeGroup) => boolean) => (group: TreeGroup, parents: string[]) =>
    matchesGroup(group) ? { rowId: group.id, ancestors: parents } : null;

const namespaceHit = (namespace: string) =>
  groupHit((group) => group.type === 'namespace' && group.label === namespace);

/** How to find the target's own row under the current grouping. */
function hitFor(target: TreeTarget) {
  switch (target.type) {
    case 'pod': {
      const key = `${target.namespace}/${target.name}`;
      return (group: TreeGroup, parents: string[]) =>
        group.pods.some((view) => view.key === key)
          ? { rowId: podRowId(group.id, target.name), ancestors: [...parents, group.id] }
          : null;
    }
    case 'workload': {
      const id = workloadGroupId(target.namespace, target.kind, target.name);
      return groupHit((group) => group.id === id);
    }
    case 'node': {
      const id = nodeGroupId(target.name);
      return groupHit((group) => group.id === id);
    }
    case 'namespace':
      return namespaceHit(target.namespace);
  }
}

export type RevealPlan = {
  grouping: Grouping;
  collapsed: Set<string>;
  clearFilter: boolean;
  rowId: string;
};

type TreeNow = {
  views: PodView[];
  workloads: KubeWorkload[];
  nodes: KubeNode[];
  section: NodeSection | null;
  grouping: Grouping;
  collapsed: ReadonlySet<string>;
  filter: Filter;
};

const withoutAncestors = (collapsed: ReadonlySet<string>, ancestors: string[]) => {
  const next = new Set(collapsed);
  ancestors.forEach((id) => next.delete(id));
  return next;
};

/**
 * Keeps the user's grouping and filter unless they would hide the target. A workload only exists
 * as a row when grouped by workload. What has no row of its own (a pod already replaced, a
 * workload with no pods) lands on its namespace. `null` means there is nowhere to go.
 */
export function planReveal(target: TreeTarget, tree: TreeNow): RevealPlan | null {
  const grouping: Grouping = target.type === 'workload' ? 'workload' : tree.grouping;
  const forestOf = (views: PodView[]) => buildForest(views, grouping, tree.workloads, tree.nodes);
  const all = forestOf(tree.views);
  const hit = hitFor(target);
  const found =
    search(all, [], hit) ??
    ('namespace' in target ? search(all, [], namespaceHit(target.namespace)) : null);

  if (!found) {
    // The node list above the forest covers a node with no pods, or any node outside node grouping.
    if (target.type !== 'node' || !tree.section?.nodes.some((v) => v.node.name === target.name))
      return null;
    return {
      grouping: grouping === 'node' ? 'workload' : grouping,
      collapsed: unfoldNodes(tree.section, tree.collapsed),
      clearFilter: filterActive(tree.filter),
      rowId: nodeRowId(target.name),
    };
  }
  const kept = search(forestOf(tree.views.filter((view) => matches(view, tree.filter))), [], hit);
  return {
    grouping,
    collapsed: withoutAncestors(tree.collapsed, found.ancestors),
    clearFilter: filterActive(tree.filter) && kept?.rowId !== found.rowId,
    rowId: found.rowId,
  };
}
