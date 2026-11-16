import type { IBuffer, IBufferCell, IBufferLine } from '@xterm/xterm';

/** Where each UTF-16 unit of a logical line sits: the row from the scan's first row, and cells. */
export type LineCells = { row: Uint16Array; col: Uint16Array; width: Uint8Array };
export type LogicalLine = { text: string; cells: LineCells };
/** A run of cells on one row, the shape an xterm decoration takes. */
export type CellSpan = { row: number; x: number; width: number };

type BufferLike = Pick<IBuffer, 'getLine' | 'getNullCell'>;
type LineLike = Pick<IBufferLine, 'isWrapped' | 'length' | 'getCell' | 'translateToString'>;

/** Printable ASCII fills one cell per character, so the row's text maps straight onto its cells. */
const plainAscii = /^[\x20-\x7e]*$/;

function appendRow(
  line: LineLike,
  row: number,
  cell: IBufferCell,
  text: string[],
  rows: number[],
  cols: number[],
  widths: number[],
) {
  const plain = line.translateToString(false);
  if (plain.length === line.length && plainAscii.test(plain)) {
    for (let x = 0; x < plain.length; x++) {
      text.push(plain[x]);
      rows.push(row);
      cols.push(x);
      widths.push(1);
    }
    return;
  }
  for (let x = 0; x < line.length; x++) {
    const current = line.getCell(x, cell);
    if (!current) break;
    const width = current.getWidth();
    // The second cell of a wide character carries nothing of its own.
    if (width === 0) continue;
    const chars = current.getChars() || ' ';
    for (const unit of chars.split('')) {
      text.push(unit);
      rows.push(row);
      cols.push(x);
      widths.push(width);
    }
  }
}

/**
 * The logical lines from `first` to `last` (buffer rows, inclusive), joining rows the terminal
 * wrapped. `first` must start a logical line. Trailing blanks are dropped, as a copy would.
 */
export function logicalLines(buffer: BufferLike, first: number, last: number): LogicalLine[] {
  const cell = buffer.getNullCell();
  const lines: LogicalLine[] = [];
  let text: string[] = [];
  let rows: number[] = [];
  let cols: number[] = [];
  let widths: number[] = [];
  const flush = () => {
    let end = text.length;
    while (end > 0 && text[end - 1] === ' ') end--;
    lines.push({
      text: text.slice(0, end).join(''),
      cells: {
        row: Uint16Array.from(rows.slice(0, end)),
        col: Uint16Array.from(cols.slice(0, end)),
        width: Uint8Array.from(widths.slice(0, end)),
      },
    });
    text = [];
    rows = [];
    cols = [];
    widths = [];
  };
  for (let y = first; y <= last; y++) {
    const line = buffer.getLine(y) as LineLike | undefined;
    if (!line) break;
    if (y > first && !line.isWrapped) flush();
    appendRow(line, y - first, cell, text, rows, cols, widths);
  }
  if (last >= first) flush();
  return lines;
}

/** The first row of the logical line that holds `row`. */
export function logicalStart(buffer: Pick<IBuffer, 'getLine'>, row: number) {
  let y = row;
  while (y > 0 && buffer.getLine(y)?.isWrapped) y--;
  return y;
}

/** A match's cells, one span per row it covers. */
export function matchSpans(cells: LineCells, start: number, end: number): CellSpan[] {
  const spans: CellSpan[] = [];
  for (let i = start; i < end && i < cells.row.length; i++) {
    const row = cells.row[i];
    const x = cells.col[i];
    const right = x + cells.width[i];
    const last = spans[spans.length - 1];
    if (last && last.row === row) last.width = Math.max(last.width, right - last.x);
    else spans.push({ row, x, width: right - x });
  }
  return spans;
}
