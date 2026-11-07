import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { clipLine, type Cell, type Row } from './unifiedDiff';

export const ROW_HEIGHT = 20;
const OVERSCAN = 20;

export type RowSelection = { from: number; to: number };

const sign = { context: ' ', add: '+', del: '−' } as const;

function Text({ text }: { text: string }) {
  const { text: shown, cut } = clipLine(text);
  return (
    <span className="diff-text">
      {shown}
      {cut > 0 && <span className="diff-cut"> … {cut.toLocaleString()}자 생략</span>}
    </span>
  );
}

/** The line number doubles as the selection control. Shift extends the selection. */
function LineButton({
  line,
  side,
  pick,
}: {
  line?: number;
  side: 'old' | 'new';
  pick: (e: MouseEvent) => void;
}) {
  if (line === undefined) return <span className="diff-gutter" />;
  return (
    <button
      type="button"
      className="diff-gutter"
      aria-label={`${side === 'old' ? '이전' : '새'} ${line}행 선택`}
      onClick={pick}
    >
      {line}
    </button>
  );
}

function Side({
  cell,
  side,
  pick,
}: {
  cell: Cell;
  side: 'old' | 'new';
  pick: (e: MouseEvent) => void;
}) {
  return (
    <div
      className={`diff-side ${cell?.kind ?? 'empty'}`}
      title={cell ? clipLine(cell.text).text : undefined}
    >
      <LineButton line={cell?.line} side={side} pick={pick} />
      <span className="diff-sign" aria-hidden="true">
        {cell ? sign[cell.kind] : ''}
      </span>
      {cell && <Text text={cell.text} />}
    </div>
  );
}

/**
 * Only the rows in view are in the document, so a diff of thousands of lines scrolls like a short
 * one. Rows have one fixed height; a long line is cut, not wrapped.
 */
export function DiffView({
  rows,
  selection,
  select,
  label,
}: {
  rows: Row[];
  selection: RowSelection | null;
  select: (index: number, extend: boolean) => void;
  label: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const element = scroller.current!;
    const measure = () => setView({ top: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    // A new file starts at its top.
    if (scroller.current) scroller.current.scrollTop = 0;
  }, [rows]);
  const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN);
  const low = selection ? Math.min(selection.from, selection.to) : -1;
  const high = selection ? Math.max(selection.from, selection.to) : -1;
  return (
    <div
      className="diff-view"
      ref={scroller}
      role="region"
      aria-label={label}
      tabIndex={0}
      onScroll={(e) =>
        setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })
      }
    >
      <div style={{ height: first * ROW_HEIGHT }} />
      {rows.slice(first, last).map((row, offset) => {
        const index = first + offset;
        const pick = (e: MouseEvent) => select(index, e.shiftKey);
        const selected = index >= low && index <= high ? ' selected' : '';
        if (row.kind === 'hunk' || row.kind === 'note')
          return (
            <div key={index} className={`diff-row diff-${row.kind}`}>
              {row.text}
            </div>
          );
        if (row.kind === 'pair')
          return (
            <div key={index} className={`diff-row diff-pair${selected}`}>
              <Side cell={row.left} side="old" pick={pick} />
              <Side cell={row.right} side="new" pick={pick} />
            </div>
          );
        return (
          <div key={index} className={`diff-row diff-line ${row.type}${selected}`}>
            <LineButton line={row.old} side="old" pick={pick} />
            <LineButton line={row.new} side="new" pick={pick} />
            <span className="diff-sign" aria-hidden="true">
              {sign[row.type]}
            </span>
            <Text text={row.text} />
          </div>
        );
      })}
      <div style={{ height: (rows.length - last) * ROW_HEIGHT }} />
    </div>
  );
}
