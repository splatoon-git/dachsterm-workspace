/**
 * Reads one file's unified diff (`git diff` with fixed a/ b/ prefixes) and lays it out as rows,
 * either one column (narrow) or old and new side by side. Pure, so the review view only renders.
 */
export type DiffLine =
  | { kind: 'context'; old: number; new: number; text: string }
  | { kind: 'add'; new: number; text: string }
  | { kind: 'del'; old: number; text: string }
  /** "\ No newline at end of file" after the line it describes. */
  | { kind: 'note'; text: string };
export type Hunk = { header: string; lines: DiffLine[] };
export type ParsedDiff = {
  binary: boolean;
  /** Mode and rename facts shown above the hunks. */
  meta: string[];
  hunks: Hunk[];
};

export const MAX_LINE = 4000;

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const shownMeta = [
  'new file mode',
  'deleted file mode',
  'old mode',
  'new mode',
  'similarity index',
  'rename from',
  'rename to',
  'copy from',
  'copy to',
];

export function parseUnifiedDiff(text: string): ParsedDiff {
  const result: ParsedDiff = { binary: false, meta: [], hunks: [] };
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++];
    const header = hunkHeader.exec(line);
    if (!header) {
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') result.binary = true;
      else if (shownMeta.some((prefix) => line.startsWith(prefix))) result.meta.push(line);
      continue;
    }
    let oldLine = Number(header[1]);
    let newLine = Number(header[3]);
    // A missing count means one line. The counts, not the prefixes, end a hunk, so a content
    // line that looks like a header is still content.
    let oldLeft = header[2] === undefined ? 1 : Number(header[2]);
    let newLeft = header[4] === undefined ? 1 : Number(header[4]);
    const hunk: Hunk = { header: line, lines: [] };
    while (i < lines.length && (oldLeft > 0 || newLeft > 0 || lines[i].startsWith('\\'))) {
      const body = lines[i++];
      const mark = body[0];
      const content = body.slice(1);
      if (mark === '\\') hunk.lines.push({ kind: 'note', text: content.trim() });
      else if (mark === '+' && newLeft > 0) {
        hunk.lines.push({ kind: 'add', new: newLine++, text: content });
        newLeft--;
      } else if (mark === '-' && oldLeft > 0) {
        hunk.lines.push({ kind: 'del', old: oldLine++, text: content });
        oldLeft--;
      } else if ((mark === ' ' || body === '') && oldLeft > 0 && newLeft > 0) {
        // diff.suppressBlankEmpty writes an empty context line without its space.
        hunk.lines.push({ kind: 'context', old: oldLine++, new: newLine++, text: content });
        oldLeft--;
        newLeft--;
      } else {
        i--;
        break;
      }
    }
    result.hunks.push(hunk);
  }
  return result;
}

/** A line over the limit is cut, and says how much was left out. */
export function clipLine(text: string, max = MAX_LINE) {
  return text.length <= max
    ? { text, cut: 0 }
    : { text: text.slice(0, max), cut: text.length - max };
}

export type Cell = { line: number; text: string; kind: 'context' | 'add' | 'del' } | null;
export type Row =
  | { kind: 'hunk'; text: string }
  | { kind: 'note'; text: string }
  /** One column: `old` or `new` is missing for an added or removed line. */
  | { kind: 'line'; type: 'context' | 'add' | 'del'; old?: number; new?: number; text: string }
  /** Side by side. */
  | { kind: 'pair'; left: Cell; right: Cell };

export function unifiedRows(diff: ParsedDiff): Row[] {
  return diff.hunks.flatMap((hunk) => [
    { kind: 'hunk', text: hunk.header } as Row,
    ...hunk.lines.map((line): Row => {
      if (line.kind === 'note') return line;
      if (line.kind === 'context')
        return { kind: 'line', type: 'context', old: line.old, new: line.new, text: line.text };
      if (line.kind === 'add') return { kind: 'line', type: 'add', new: line.new, text: line.text };
      return { kind: 'line', type: 'del', old: line.old, text: line.text };
    }),
  ]);
}

/** Removed lines pair with the added lines that follow them, so a changed line reads across. */
export function splitRows(diff: ParsedDiff): Row[] {
  const rows: Row[] = [];
  for (const hunk of diff.hunks) {
    rows.push({ kind: 'hunk', text: hunk.header });
    let dels: Cell[] = [];
    let adds: Cell[] = [];
    const flush = () => {
      for (let n = 0; n < Math.max(dels.length, adds.length); n++)
        rows.push({ kind: 'pair', left: dels[n] ?? null, right: adds[n] ?? null });
      dels = [];
      adds = [];
    };
    for (const line of hunk.lines) {
      if (line.kind === 'del') {
        if (adds.length) flush();
        dels.push({ line: line.old, text: line.text, kind: 'del' });
      } else if (line.kind === 'add') adds.push({ line: line.new, text: line.text, kind: 'add' });
      else {
        flush();
        if (line.kind === 'note') rows.push(line);
        else
          rows.push({
            kind: 'pair',
            left: { line: line.old, text: line.text, kind: 'context' },
            right: { line: line.new, text: line.text, kind: 'context' },
          });
      }
    }
    flush();
  }
  return rows;
}

/** The line numbers a row carries on each side. */
export function rowLines(row: Row): { old?: number; new?: number } {
  if (row.kind === 'line') return { old: row.old, new: row.new };
  if (row.kind === 'pair') return { old: row.left?.line, new: row.right?.line };
  return {};
}

export type LineRange = { side: 'new' | 'old'; start: number; end: number };

/**
 * The lines a selection of rows refers to. New-file numbers when the selection has any, since
 * that is the file the agent edits; otherwise the removed lines' old numbers.
 */
export function selectionRange(rows: Row[], from: number, to: number): LineRange | null {
  const picked = rows.slice(Math.min(from, to), Math.max(from, to) + 1).map(rowLines);
  for (const side of ['new', 'old'] as const) {
    const numbers = picked.map((lines) => lines[side]).filter((n): n is number => n !== undefined);
    if (numbers.length) return { side, start: Math.min(...numbers), end: Math.max(...numbers) };
  }
  return null;
}
