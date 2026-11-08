import type { MouseEvent } from 'react';
import { isMenuKey, type MenuPoint } from '../../components/ContextMenu';
import { Icon, type IconName } from '../../components/Icon';
import { changeLabel, changeMark, type DiffFile } from './gitDiff';
import {
  graphRowHeight,
  graphX,
  laneColor,
  openLanes,
  rowPaths,
  type GraphRef,
  type GraphRow,
} from './commitGraphModel';
import { splitPath } from './gitViewModel';
import type { DetailState } from './useCommitGraph';

const laneStyle = (color: number) => ({ stroke: laneColor(color) });
const dotRadius = 3;

/** One row's slice of the graph. The rows line up into the whole picture. */
export function CommitGraphLanes({
  row,
  columns,
  step,
  current,
}: {
  row: GraphRow;
  columns: number;
  step: number;
  /** HEAD is here: drawn as a ring so it does not depend on color. */
  current: boolean;
}) {
  const x = graphX(row.column, step);
  const y = graphRowHeight / 2;
  return (
    <svg
      className="git-graph-lanes"
      width={columns * step}
      height={graphRowHeight}
      aria-hidden="true"
    >
      {rowPaths(row, step).map((path, index) => (
        <path key={index} d={path.d} style={laneStyle(path.color)} />
      ))}
      <circle
        className="git-graph-dot"
        data-merge={row.merge || undefined}
        data-current={current || undefined}
        cx={x}
        cy={y}
        r={dotRadius}
        style={{ '--git-lane': laneColor(row.color) } as React.CSSProperties}
      />
    </svg>
  );
}

const refLabel: Record<GraphRef['kind'], string> = {
  head: '분리된 HEAD',
  branch: '브랜치',
  remote: '원격 브랜치',
  tag: '태그',
};
const refIcon: Record<GraphRef['kind'], IconName> = {
  head: 'target',
  branch: 'branch',
  remote: 'cloud',
  tag: 'tag',
};

/** A reference as a pill. In a narrow row only the current one spends room on its name. */
export function CommitRefPill({ item, named }: { item: GraphRef; named: boolean }) {
  const label = `${refLabel[item.kind]} ${item.name}`;
  return (
    <span
      className="git-graph-ref"
      data-kind={item.kind}
      data-current={item.current || undefined}
      title={label}
      aria-label={label}
    >
      <Icon name={item.current ? 'target' : refIcon[item.kind]} size={11} />
      {named && <span className="git-graph-ref-name">{item.name}</span>}
    </span>
  );
}

/** The lanes that continue past an opened commit, so the graph is not cut there. */
function Rail({ row, columns, step }: { row: GraphRow; columns: number; step: number }) {
  return (
    <svg className="git-graph-rail" width={columns * step} height="100%" aria-hidden="true">
      {openLanes(row).map((lane) => (
        <line
          key={`${lane.column}:${lane.color}`}
          x1={graphX(lane.column, step)}
          x2={graphX(lane.column, step)}
          y1="0"
          y2="100%"
          style={laneStyle(lane.color)}
        />
      ))}
    </svg>
  );
}

function CommitFile({
  file,
  open,
  menu,
}: {
  file: DiffFile;
  open: (file: DiffFile, pinned: boolean) => void;
  menu: (file: DiffFile, at: MenuPoint | HTMLElement) => void;
}) {
  const { name, folder } = splitPath(file.path);
  const openIt = (pinned: boolean) => {
    if (file.readable) open(file, pinned);
  };
  return (
    <li
      className="git-row"
      data-git-row=""
      tabIndex={-1}
      title={`${file.oldPath ? `${file.oldPath} → ` : ''}${file.path} · ${changeLabel[file.change]}`}
      onClick={() => openIt(false)}
      onDoubleClick={() => openIt(true)}
      onContextMenu={(event: MouseEvent) => {
        event.preventDefault();
        menu(file, { x: event.clientX, y: event.clientY });
      }}
      onKeyDown={(event) => {
        if (isMenuKey(event)) {
          event.preventDefault();
          menu(file, event.currentTarget);
        } else if (event.key === 'Enter') {
          event.preventDefault();
          openIt(false);
        }
      }}
    >
      <span className="git-row-name">{name}</span>
      {folder && <span className="git-row-folder">{folder}</span>}
      <span className="git-row-mark" data-change={file.change}>
        {changeMark[file.change]}
      </span>
    </li>
  );
}

function DetailBody({
  state,
  open,
  menu,
}: {
  state: DetailState | undefined;
  open: (file: DiffFile, pinned: boolean) => void;
  menu: (file: DiffFile, at: MenuPoint | HTMLElement) => void;
}) {
  if (!state || state.kind === 'loading') return <p className="git-view-note">조회 중…</p>;
  if (state.kind === 'failed') return <p className="git-view-note git-view-error">{state.error}</p>;
  const { detail } = state;
  return (
    <>
      {detail.files.length > 0 ? (
        <ul className="git-list">
          {detail.files.map((file) => (
            <CommitFile key={file.path} file={file} open={open} menu={menu} />
          ))}
        </ul>
      ) : (
        !detail.truncated && <p className="git-view-note">바뀐 파일이 없습니다.</p>
      )}
      {detail.truncated && <p className="git-view-note">변경 파일이 많아 목록이 잘렸습니다.</p>}
    </>
  );
}

export function CommitGraphDetail({
  row,
  columns,
  step,
  state,
  open,
  menu,
}: {
  row: GraphRow;
  columns: number;
  step: number;
  state: DetailState | undefined;
  open: (file: DiffFile, pinned: boolean) => void;
  menu: (file: DiffFile, at: MenuPoint | HTMLElement) => void;
}) {
  return (
    <div className="git-graph-detail" style={{ paddingLeft: columns * step }}>
      <Rail row={row} columns={columns} step={step} />
      <DetailBody state={state} open={open} menu={menu} />
    </div>
  );
}
