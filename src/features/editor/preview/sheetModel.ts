// A spreadsheet as rows of text for a read-only grid. It shows stored values: formulas are not
// worked out again, and only dates, times and percentages are formatted.
import {
  all,
  child,
  children,
  openPackage,
  partXml,
  relationAttribute,
  relationships,
} from './officeXml';

export type Sheet = {
  name: string;
  rows: string[][];
  columns: number;
  /** More rows or columns exist than the grid shows. */
  clipped: boolean;
};

/** What the grid draws. A sheet past this is shown from its top-left corner. */
export const sheetLimits = { rows: 1000, columns: 50 };

type NumberFormat = 'general' | 'date' | 'datetime' | 'time' | { percent: number };

const builtInDates = new Map<number, NumberFormat>([
  [14, 'date'],
  [15, 'date'],
  [16, 'date'],
  [17, 'date'],
  [18, 'time'],
  [19, 'time'],
  [20, 'time'],
  [21, 'time'],
  [22, 'datetime'],
  [45, 'time'],
  [46, 'time'],
  [47, 'time'],
]);
// East Asian date formats take these ids, with no format code stored in the file.
for (const id of [27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58])
  builtInDates.set(id, 'date');
for (const id of [32, 33]) builtInDates.set(id, 'time');

/** What a format code such as `yyyy-mm-dd` or `0.0%` shows. */
export function formatOfCode(code: string): NumberFormat {
  // Quoted text, escaped characters and `[...]` sections are not format letters. The one bracket
  // that is: elapsed time, as in `[h]:mm`.
  const bare = code
    .replace(/\[(?:h+|m+|s+)\]/gi, 'h')
    .replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '')
    .toLowerCase();
  if (bare.includes('%'))
    return { percent: (bare.split('.')[1]?.match(/^[0#]+/)?.[0] ?? '').length };
  const date = /[yd]/.test(bare);
  const time = /[hs]/.test(bare);
  // `m` alone is a month; beside hours or seconds it is minutes.
  if (date || (/m/.test(bare) && !time)) return time ? 'datetime' : 'date';
  return time ? 'time' : 'general';
}

/** The number format of each cell style, by the index a cell's `s` attribute gives. */
export function styleFormats(styles: Document | null): NumberFormat[] {
  if (!styles) return [];
  const custom = new Map<number, NumberFormat>();
  for (const format of all(styles, 'numFmt'))
    custom.set(
      Number(format.getAttribute('numFmtId')),
      formatOfCode(format.getAttribute('formatCode') ?? ''),
    );
  const cellStyles = all(styles, 'cellXfs')[0];
  if (!cellStyles) return [];
  return children(cellStyles, 'xf').map((style) => {
    const id = Number(style.getAttribute('numFmtId') ?? 0);
    if (id === 9) return { percent: 0 };
    if (id === 10) return { percent: 2 };
    return custom.get(id) ?? builtInDates.get(id) ?? 'general';
  });
}

const two = (value: number) => String(value).padStart(2, '0');

/** A stored number as the grid shows it. Dates are counted in days from the workbook's epoch. */
export function formatNumber(raw: string, format: NumberFormat, date1904 = false) {
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(value)) return raw;
  // 15 digits is what a spreadsheet keeps, and it drops the tail a binary fraction leaves.
  if (format === 'general') return String(Number(value.toPrecision(15)));
  if (typeof format === 'object') return `${(value * 100).toFixed(format.percent)}%`;
  const days = value + (date1904 ? 1462 : 0);
  const moment = new Date(Math.round((days - 25569) * 86_400_000));
  if (Number.isNaN(moment.getTime())) return raw;
  const date = `${moment.getUTCFullYear()}-${two(moment.getUTCMonth() + 1)}-${two(moment.getUTCDate())}`;
  const seconds = moment.getUTCSeconds();
  const time = `${two(moment.getUTCHours())}:${two(moment.getUTCMinutes())}${seconds ? `:${two(seconds)}` : ''}`;
  if (format === 'date') return date;
  return format === 'time' ? time : `${date} ${time}`;
}

/** The zero-based column of a cell reference such as `BC12`. */
export function columnOf(reference: string) {
  let column = 0;
  for (const letter of reference.toUpperCase()) {
    const code = letter.charCodeAt(0);
    if (code < 65 || code > 90) break;
    column = column * 26 + (code - 64);
  }
  return column - 1;
}

/** `A`, `B`, … `Z`, `AA`, … for a zero-based column. */
export function columnName(index: number) {
  let name = '';
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26))
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  return name;
}

/** Text of a string item: its runs joined, without the phonetic guide East Asian text may carry. */
const stringOf = (item: Element) =>
  all(item, 't')
    .filter((text) => text.parentElement?.localName !== 'rPh')
    .map((text) => text.textContent ?? '')
    .join('');

export const sharedStrings = (xml: Document | null) => (xml ? all(xml, 'si').map(stringOf) : []);

function cellText(cell: Element, shared: string[], formats: NumberFormat[], date1904: boolean) {
  const type = cell.getAttribute('t');
  if (type === 'inlineStr') return stringOf(cell);
  const raw = child(cell, 'v')?.textContent ?? '';
  if (type === 's') return shared[Number(raw)] ?? '';
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  if (type === 'str' || type === 'e') return raw;
  return formatNumber(raw, formats[Number(cell.getAttribute('s') ?? 0)] ?? 'general', date1904);
}

/** The cells of one sheet, up to `sheetLimits`. Rows and cells the file leaves out stay empty. */
export function sheetRows(
  xml: Document,
  shared: string[],
  formats: NumberFormat[],
  date1904 = false,
): Pick<Sheet, 'rows' | 'columns' | 'clipped'> {
  const rows: string[][] = [];
  let columns = 0;
  let clipped = false;
  let nextRow = 0;
  for (const row of all(xml, 'row')) {
    const at = row.hasAttribute('r') ? Number(row.getAttribute('r')) - 1 : nextRow;
    nextRow = at + 1;
    if (at >= sheetLimits.rows) {
      clipped = true;
      break;
    }
    const cells: string[] = [];
    let nextColumn = 0;
    for (const cell of children(row, 'c')) {
      const reference = cell.getAttribute('r');
      const column = reference ? columnOf(reference) : nextColumn;
      nextColumn = column + 1;
      if (column >= sheetLimits.columns) {
        clipped = true;
        break;
      }
      const text = cellText(cell, shared, formats, date1904);
      if (text !== '') cells[column] = text;
    }
    if (!cells.length) continue;
    rows[at] = Array.from(cells, (text) => text ?? '');
    columns = Math.max(columns, cells.length);
  }
  return { rows: Array.from(rows, (row) => row ?? []), columns, clipped };
}

export async function readWorkbook(bytes: Uint8Array): Promise<Sheet[]> {
  const source = await openPackage(bytes);
  const part = 'xl/workbook.xml';
  const workbook = await partXml(source, part);
  if (!workbook) throw new Error('no workbook');
  const relations = await relationships(source, part);
  const target = (type: string) =>
    [...relations.values()].find((relation) => relation.type === type)?.target;
  const shared = sharedStrings(
    await partXml(source, target('sharedStrings') ?? 'xl/sharedStrings.xml'),
  );
  const formats = styleFormats(await partXml(source, target('styles') ?? 'xl/styles.xml'));
  const date1904 = ['1', 'true'].includes(
    all(workbook, 'workbookPr')[0]?.getAttribute('date1904') ?? '',
  );
  const sheets: Sheet[] = [];
  for (const sheet of all(workbook, 'sheet')) {
    const name = sheet.getAttribute('name') ?? `시트 ${sheets.length + 1}`;
    const relation = relations.get(relationAttribute(sheet, 'id') ?? '');
    const xml = relation?.type === 'worksheet' ? await partXml(source, relation.target) : null;
    // A chart sheet, or a sheet too large to read, still shows its name.
    sheets.push(
      xml
        ? { name, ...sheetRows(xml, shared, formats, date1904) }
        : { name, rows: [], columns: 0, clipped: relation?.type === 'worksheet' },
    );
  }
  if (!sheets.length) throw new Error('no sheets');
  return sheets;
}
