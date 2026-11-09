import type { Grouping, TreeRow } from './tree';
import { groupings } from './tree';
import { cellsOf } from './treeCells';
import { statusMark } from './treeFormat';
import type { WorkerCell } from './workers';

/** The tree as it stood when a row's menu opened: every row not folded away, not just those drawn. */
export type ShownTree = {
  rows: TreeRow[];
  metrics: boolean;
  grouping: Grouping;
  collectedAt: number;
};

export type TreeScope = {
  context: string;
  namespace: string;
  query: string;
  problemsOnly: boolean;
};

// Korean status words and names are two columns wide, so `padEnd` alone would not line up.
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠]/u;
const widthOf = (text: string) => [...text].reduce((sum, c) => sum + (WIDE.test(c) ? 2 : 1), 0);
const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - widthOf(text)));

const twoDigits = (value: number) => String(value).padStart(2, '0');
function stamp(at: number) {
  const d = new Date(at);
  const day = `${d.getFullYear()}-${twoDigits(d.getMonth() + 1)}-${twoDigits(d.getDate())}`;
  return `${day} ${twoDigits(d.getHours())}:${twoDigits(d.getMinutes())}:${twoDigits(d.getSeconds())}`;
}

function workerText(row: TreeRow, cells: Map<string, WorkerCell>) {
  const cell = cells.get(row.type === 'group' ? row.group.id : '');
  return cell ? `${cell.text}${cell.suspect ? ' 의심' : ''}` : '';
}

/** Plain text for a chat or an issue: what the tree shows, and which cluster and filter it is. */
export function treeText(shown: ShownTree, scope: TreeScope, cells: Map<string, WorkerCell>) {
  const { rows, metrics, grouping, collectedAt } = shown;
  const group = groupings.find((item) => item.id === grouping)?.label ?? grouping;
  const facts = [
    `context ${scope.context}`,
    `namespace ${scope.namespace || '전체'}`,
    `묶기 ${group}`,
    ...(scope.query ? [`필터 ${scope.query}`] : []),
    ...(scope.problemsOnly ? ['문제만'] : []),
  ];
  const table = [
    [
      '이름',
      '상태',
      '준비',
      '재시작',
      metrics ? 'CPU' : 'CPU 요청/제한',
      metrics ? '메모리' : '메모리 요청/제한',
      '노드',
      '워커',
      '나이',
    ],
    ...rows.map((row) => {
      const cell = cellsOf(row, metrics, collectedAt);
      return [
        '  '.repeat(row.depth) + [cell.label, ...cell.tags].join(' '),
        `${statusMark[cell.health]} ${cell.status}`.trimEnd(),
        cell.ready,
        cell.restarts + (cell.recent ? ' ↑' : ''),
        cell.cpu.text,
        cell.memory.text,
        cell.node,
        workerText(row, cells),
        cell.age,
      ];
    }),
  ];
  const widths = table[0].map((_, column) =>
    Math.max(...table.map((line) => widthOf(line[column]))),
  );
  const lines = table.map((line) =>
    line
      .map((text, column) => pad(text, widths[column]))
      .join('  ')
      .trimEnd(),
  );
  return [`${stamp(collectedAt)}  ${facts.join('  ')}`, ...lines].join('\n');
}
