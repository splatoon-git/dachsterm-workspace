import { changeLabel, changeMark } from './gitDiff';
import {
  graphRowHeight,
  graphX,
  laneColor,
  openLanes,
  rowPaths,
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

function DetailBody({ state }: { state: DetailState | undefined }) {
  if (!state || state.kind === 'loading') return <p className="git-view-note">조회 중…</p>;
  if (state.kind === 'failed') return <p className="git-view-note git-view-error">{state.error}</p>;
  const { detail } = state;
  return (
    <>
      <dl className="git-graph-meta">
        <dt>커밋</dt>
        <dd className="git-graph-hash">{detail.hash}</dd>
        <dt>작성자</dt>
        <dd>{detail.author}</dd>
        <dt>시각</dt>
        <dd>{new Date(detail.time * 1000).toLocaleString()}</dd>
        {detail.parents.length > 0 && (
          <>
            <dt>부모</dt>
            <dd className="git-graph-hash">
              {detail.parents.map((parent) => parent.slice(0, 7)).join(' ')}
            </dd>
          </>
        )}
      </dl>
      <p className="git-graph-message">{detail.message}</p>
      {detail.files.length > 0 && (
        <ul className="git-list">
          {detail.files.map((file) => {
            const { name, folder } = splitPath(file.path);
            return (
              <li
                key={file.path}
                className="git-row"
                title={`${file.oldPath ? `${file.oldPath} → ` : ''}${file.path} · ${changeLabel[file.change]}`}
              >
                <span className="git-row-name">{name}</span>
                {folder && <span className="git-row-folder">{folder}</span>}
                <span className="git-row-mark" data-change={file.change}>
                  {changeMark[file.change]}
                </span>
              </li>
            );
          })}
        </ul>
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
}: {
  row: GraphRow;
  columns: number;
  step: number;
  state: DetailState | undefined;
}) {
  return (
    <div className="git-graph-detail" style={{ paddingLeft: columns * step }}>
      <Rail row={row} columns={columns} step={step} />
      <DetailBody state={state} />
    </div>
  );
}
