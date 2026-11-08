import type { TreeRow } from './tree';
import { formatAge, formatCpu, formatMemory, resourceCell, usedOfTotal } from './treeFormat';
import type { Health } from './treePods';

const statusMark: Record<Health, string> = { ok: '●', warn: '▲', error: '✕' };

type Cell = { text: string; title?: string };
type Cells = {
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

function cellsOf(row: TreeRow, metrics: boolean, now: number): Cells {
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

export function KubeTreeRow({
  row,
  domId,
  index,
  top,
  count,
  active,
  metrics,
  now,
  select,
  fold,
  open,
  menu,
}: {
  row: TreeRow;
  domId: string;
  index: number;
  top: number;
  count: number;
  active: boolean;
  metrics: boolean;
  now: number;
  select: () => void;
  fold: () => void;
  /** Double click on a pod. */
  open?: () => void;
  /** Right click on a pod. */
  menu?: (at: { x: number; y: number }) => void;
}) {
  const cells = cellsOf(row, metrics, now);
  const foldable = row.type === 'group' || row.type === 'nodes';
  return (
    <div
      id={domId}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-setsize={count}
      aria-posinset={index + 1}
      aria-selected={active}
      aria-expanded={foldable ? row.expanded : undefined}
      className={`kube-tree-row ${active ? 'active' : ''} ${foldable ? 'group' : ''}`}
      style={{ top }}
      onClick={select}
      onDoubleClick={open}
      onContextMenu={(event) => {
        if (!menu) return;
        event.preventDefault();
        menu({ x: event.clientX, y: event.clientY });
      }}
      title={cells.title}
    >
      <span className="kube-tree-name" style={{ paddingLeft: row.depth * 16 }}>
        {foldable && (
          <span
            className="kube-tree-fold"
            aria-hidden="true"
            onClick={(event) => {
              event.stopPropagation();
              select();
              fold();
            }}
          >
            {row.expanded ? '▾' : '▸'}
          </span>
        )}
        <span className="kube-tree-label">{cells.label}</span>
        {cells.tags.map((tag) => (
          <small key={tag}>{tag}</small>
        ))}
      </span>
      <span className={`kube-health ${cells.health}`}>
        <span aria-hidden="true">{statusMark[cells.health]} </span>
        {cells.status}
      </span>
      <span>{cells.ready}</span>
      <span className={cells.recent ? 'kube-restart-recent' : undefined}>
        {cells.restarts}
        {cells.recent ? ' ↑' : ''}
      </span>
      <span title={cells.cpu.title}>{cells.cpu.text}</span>
      <span title={cells.memory.title}>{cells.memory.text}</span>
      <span>{cells.node}</span>
      {/* KV.9 shows the app workers here for a workload being watched, such as "사용 8/8". */}
      <span />
      <span>{cells.age}</span>
    </div>
  );
}
