import type { MenuItem } from '../../components/ContextMenu';
import {
  nodeNameOfGroup,
  planNode,
  planRollout,
  rolloutOfGroup,
  type ActionPlan,
} from './actionModel';
import { boardScopeOfGroup, type BoardScope } from './logBoardModel';
import { scopeOfGroup, type SearchScope } from './logSearchModel';
import type { KubeNode } from './snapshotTypes';
import type { TreeRow } from './tree';

/** A write stays in the menu when it cannot run, and says why (design KV.6). */
export function actionItem(
  plan: ActionPlan,
  blocked: string,
  ask: (plan: ActionPlan) => void,
): MenuItem {
  return {
    label: plan.title,
    danger: true,
    separated: true,
    disabled: blocked !== '',
    hint: blocked || undefined,
    run: () => ask(plan),
  };
}

export type RowMenuContext = {
  nodes: KubeNode[] | null;
  blocked: string;
  ask: (plan: ActionPlan) => void;
  watchLogs: (scope: BoardScope) => void;
  searchLogs: (scope: SearchScope) => void;
  copyTree: () => void;
};

/** What a row other than a pod offers. Pods have the longer menu in `KubeTreeScreen`. */
export function treeRowMenu(
  row: TreeRow,
  context: RowMenuContext,
): { label: string; items: MenuItem[] } | null {
  const { nodes, blocked, ask, watchLogs, searchLogs, copyTree } = context;
  const copy = { label: '보이는 트리 복사', run: copyTree };
  if (row.type === 'node')
    return { label: '노드 메뉴', items: [copy, actionItem(planNode(row.view.node), blocked, ask)] };
  if (row.type !== 'group') return null;

  const { group } = row;
  const watch = boardScopeOfGroup(group.id);
  const search = scopeOfGroup(group.id);
  const items: MenuItem[] = [
    ...(watch ? [{ label: '실시간 로그 보기', run: () => watchLogs(watch) }] : []),
    ...(search ? [{ label: '로그 검색', run: () => searchLogs(search) }] : []),
  ];
  items.push({ ...copy, separated: items.length > 0 });
  const rollout = rolloutOfGroup(group.id);
  if (rollout) items.push(actionItem(planRollout(rollout, group.count), blocked, ask));
  const node = nodes?.find((item) => item.name === nodeNameOfGroup(group.id));
  if (node) items.push(actionItem(planNode(node), blocked, ask));
  return { label: '그룹 메뉴', items };
}
