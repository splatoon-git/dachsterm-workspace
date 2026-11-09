import type { TreeRow } from './tree';
import { formatAge, formatCpu, formatMemory, resourceCell, usedOfTotal } from './treeFormat';
import type { Health } from './treePods';

type Cell = { text: string; title?: string };
export type Cells = {
  label: string;
  tags: string[];
  health: Health;
  status: string;
  ready: string;
  restarts: string;
  recent: boolean;
  cpu: Cell;
  memory: Cell;
  node: string;
  age: string;
  title?: string;
};

export function cellsOf(row: TreeRow, metrics: boolean, now: number): Cells {
  const blank = { text: '' };
  const quiet = { restarts: '', recent: false, node: '', age: '' };
  switch (row.type) {
    case 'nodes': {
      const { section } = row;
      return {
        ...quiet,
        label: '노드',
        tags: [],
        health: section.health,
        status: `${section.ready}/${section.total} 준비`,
        ready: '',
        cpu: blank,
        memory: blank,
      };
    }
    case 'node': {
      const { view } = row;
      return {
        ...quiet,
        label: view.node.name,
        tags: [],
        health: view.health,
        status: view.status,
        ready: `파드 ${view.pods}`,
        cpu: usedOfTotal(view.cpu, view.node.cpuAllocatable, formatCpu),
        memory: usedOfTotal(view.memory, view.node.memoryAllocatable, formatMemory),
      };
    }
    case 'group': {
      const { group } = row;
      const { totals } = group;
      return {
        label: group.label,
        tags: [group.type, String(group.count)].filter(Boolean),
        health: group.health,
        status: group.note,
        ready: `${totals.ready}/${totals.total}`,
        restarts: String(totals.restarts),
        recent: totals.recentRestart,
        cpu: resourceCell(totals.cpu, totals.cpuRequest, totals.cpuLimit, formatCpu, metrics),
        memory: resourceCell(
          totals.memory,
          totals.memoryRequest,
          totals.memoryLimit,
          formatMemory,
          metrics,
        ),
        node: '',
        age: '',
        title: group.note || undefined,
      };
    }
    case 'pod': {
      const { view } = row;
      const { pod } = view;
      return {
        label: pod.name,
        tags: [],
        health: view.health,
        status: view.status,
        ready: `${view.ready}/${view.total}`,
        restarts: String(view.restarts),
        recent: view.recentRestart,
        cpu: resourceCell(view.cpu, pod.cpuRequest, pod.cpuLimit, formatCpu, metrics),
        memory: resourceCell(
          view.memory,
          pod.memoryRequest,
          pod.memoryLimit,
          formatMemory,
          metrics,
        ),
        node: pod.node,
        age: formatAge(now - Date.parse(pod.created)),
      };
    }
  }
}
