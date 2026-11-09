import { useContext } from 'react';
import type { TreeRow } from './tree';
import { cellsOf } from './treeCells';
import { statusMark } from './treeFormat';
import { WorkersContext } from './workerContext';

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
  const worker = useContext(WorkersContext).cells.get(row.type === 'group' ? row.group.id : '');
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
      <span className="kube-worker-cell" title={worker?.title || undefined}>
        {worker?.text}
        {worker?.suspect && <b> ⚠ 의심</b>}
      </span>
      <span>{cells.age}</span>
    </div>
  );
}
