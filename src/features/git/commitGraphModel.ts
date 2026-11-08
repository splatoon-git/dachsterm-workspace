import type { DiffFile } from './gitDiff';

/** Replies of `git_graph` and `git_commit_detail` (`git_graph.rs`). */
export type GraphRefKind = 'head' | 'branch' | 'remote' | 'tag';
export type GraphRef = { kind: GraphRefKind; name: string; current: boolean };
export type GraphCommit = {
  hash: string;
  parents: string[];
  author: string;
  /** Seconds since the epoch. */
  time: number;
  refs: GraphRef[];
  subject: string;
};
/** Which commits `git_graph` walks. */
export type GraphScope = 'auto' | 'all';
/** The commit a file in the graph was changed by, and the side it is compared with. */
export type CommitFileOrigin = { hash: string; parent: string | null };
export type GitGraphResult =
  | { kind: 'graph'; commits: GraphCommit[]; hasMore: boolean }
  | { kind: 'empty' }
  | { kind: 'notRepo'; detail: string }
  | { kind: 'noGit'; detail: string }
  | { kind: 'stopped'; reason: 'timeout' | 'tooLarge' };
export type CommitDetail = {
  hash: string;
  parents: string[];
  author: string;
  time: number;
  message: string;
  files: DiffFile[];
  truncated: boolean;
};

/** How many commits one load adds, and the most the view asks for (`MAX_COMMITS` in Rust). */
export const graphPage = 100;
export const graphMax = 1000;

export const graphStopped = {
  timeout: '이력이 길어 조회를 멈췄습니다.',
  tooLarge: '이력이 너무 커서 조회를 멈췄습니다.',
};

/** Part of a lane inside one row. Columns count from the left; `color` is never reused for a lane. */
export type GraphLine = { from: number; to: number; color: number };
export type GraphRow = {
  column: number;
  color: number;
  merge: boolean;
  /** Lanes that were waiting for this commit: top edge to the commit. */
  into: GraphLine[];
  /** Lanes passing by: top edge to bottom edge. */
  through: GraphLine[];
  /** One per parent: the commit to the bottom edge. */
  out: GraphLine[];
};
export type GraphLayout = { rows: GraphRow[]; columns: number };

/** A lane is a column waiting for the commit it will reach next. */
type Lane = { hash: string; color: number };

/**
 * Where each commit and line goes, for commits listed children first (`--topo-order`). A parent past
 * the end of the list leaves its lane open at the bottom, which reads as "the history continues".
 */
export function layoutGraph(
  commits: readonly Pick<GraphCommit, 'hash' | 'parents'>[],
): GraphLayout {
  let lanes: Lane[] = [];
  let nextColor = 0;
  let columns = 0;
  const rows = commits.map((commit): GraphRow => {
    const first = lanes.findIndex((lane) => lane.hash === commit.hash);
    const column = first < 0 ? lanes.length : first;
    const color = first < 0 ? nextColor++ : lanes[first]!.color;
    const [firstParent, ...otherParents] = commit.parents;
    const output: Lane[] = [];
    const into: GraphLine[] = [];
    const through: GraphLine[] = [];
    const out: GraphLine[] = [];
    const openFirstParent = () => {
      if (firstParent === undefined) return;
      out.push({ from: column, to: output.length, color });
      output.push({ hash: firstParent, color });
    };
    lanes.forEach((lane, at) => {
      if (lane.hash === commit.hash) {
        into.push({ from: at, to: column, color: lane.color });
        if (at === first) openFirstParent();
        return;
      }
      through.push({ from: at, to: output.length, color: lane.color });
      output.push(lane);
    });
    if (first < 0) openFirstParent();
    for (const parent of otherParents) {
      const opened = nextColor++;
      out.push({ from: column, to: output.length, color: opened });
      output.push({ hash: parent, color: opened });
    }
    columns = Math.max(columns, column + 1, lanes.length, output.length);
    lanes = output;
    return { column, color, merge: otherParents.length > 0, into, through, out };
  });
  return { rows, columns };
}

/** The columns a row hands to the next row, for lines drawn under an opened commit. */
export function openLanes(row: GraphRow): { column: number; color: number }[] {
  return [...row.through, ...row.out]
    .map((line) => ({ column: line.to, color: line.color }))
    .sort((a, b) => a.column - b.column);
}

/** The most the graph takes of a narrow sidebar. */
export const maxGraphWidth = 96;
const preferredStep = 12;
const smallestStep = 4;

/** A narrow sidebar keeps the subject readable: lanes get thinner rather than wider. */
export function graphStep(columns: number) {
  if (columns <= 0) return preferredStep;
  return Math.max(smallestStep, Math.min(preferredStep, Math.floor(maxGraphWidth / columns)));
}

export const graphRowHeight = 22;

const center = (column: number, step: number) => step * column + step / 2;

/** A vertical line or a curve between two points, for an SVG path. */
function curve(fromX: number, fromY: number, toX: number, toY: number) {
  if (fromX === toX) return `M${fromX} ${fromY}V${toY}`;
  const bend = (fromY + toY) / 2;
  return `M${fromX} ${fromY}C${fromX} ${bend} ${toX} ${bend} ${toX} ${toY}`;
}

/** The SVG paths of one row, as `d` strings with the lane each belongs to. */
export function rowPaths(row: GraphRow, step: number, height = graphRowHeight) {
  const middle = height / 2;
  const x = (column: number) => center(column, step);
  return [
    ...row.through.map((line) => ({
      d: curve(x(line.from), 0, x(line.to), height),
      color: line.color,
    })),
    ...row.into.map((line) => ({
      d: curve(x(line.from), 0, x(line.to), middle),
      color: line.color,
    })),
    ...row.out.map((line) => ({
      d: curve(x(line.from), middle, x(line.to), height),
      color: line.color,
    })),
  ];
}

export const graphX = center;

/** Four series colors exist in every theme's contract; the lanes cycle through them. */
export const laneColor = (color: number) => `var(--chart-series-${color % 4})`;
