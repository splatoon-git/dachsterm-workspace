// @vitest-environment jsdom
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { parseXml } from './officeXml';
import {
  columnName,
  columnOf,
  formatNumber,
  formatOfCode,
  readWorkbook,
  sharedStrings,
  sheetLimits,
  sheetRows,
  styleFormats,
} from './sheetModel';

const main = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const relations = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const xml = (text: string) => parseXml(text)!;
const sheet = (rows: string) =>
  xml(`<worksheet ${main}><sheetData>${rows}</sheetData></worksheet>`);

describe('cell references', () => {
  it('turns column letters into an index and back', () => {
    expect(columnOf('A1')).toBe(0);
    expect(columnOf('Z9')).toBe(25);
    expect(columnOf('AA10')).toBe(26);
    expect(columnOf('bc12')).toBe(54);
    expect([0, 25, 26, 54, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'BC', 'ZZ', 'AAA']);
  });
});

describe('number formats', () => {
  it('tells dates, times and percentages from a format code', () => {
    expect(formatOfCode('yyyy-mm-dd')).toBe('date');
    expect(formatOfCode('yyyy"년" m"월" d"일"')).toBe('date');
    expect(formatOfCode('mmm-yy')).toBe('date');
    expect(formatOfCode('h:mm:ss')).toBe('time');
    expect(formatOfCode('[h]:mm')).toBe('time');
    expect(formatOfCode('yyyy/mm/dd hh:mm')).toBe('datetime');
    expect(formatOfCode('0.00%')).toEqual({ percent: 2 });
    expect(formatOfCode('0%')).toEqual({ percent: 0 });
    expect(formatOfCode('#,##0.00')).toBe('general');
    // Letters inside quotes or brackets are text, not date parts.
    expect(formatOfCode('0 "days"')).toBe('general');
    expect(formatOfCode('[Red]0')).toBe('general');
  });

  it('shows a stored number the way its format says', () => {
    expect(formatNumber('45292', 'date')).toBe('2024-01-01');
    expect(formatNumber('45292.5', 'datetime')).toBe('2024-01-01 12:00');
    expect(formatNumber('0.75', 'time')).toBe('18:00');
    expect(formatNumber('0.5000115740740741', 'time')).toBe('12:00:01');
    expect(formatNumber('0.125', { percent: 1 })).toBe('12.5%');
    expect(formatNumber('43830', 'date', true)).toBe('2024-01-01');
  });

  it('drops the tail a binary fraction leaves and keeps what is not a number', () => {
    expect(formatNumber('0.30000000000000004', 'general')).toBe('0.3');
    expect(formatNumber('1234567', 'general')).toBe('1234567');
    expect(formatNumber('', 'general')).toBe('');
    expect(formatNumber('n/a', 'date')).toBe('n/a');
  });

  it('reads each style: built-in ids, East Asian dates and custom codes', () => {
    const styles = xml(
      `<styleSheet ${main}><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy&quot;년&quot; m&quot;월&quot;"/></numFmts>` +
        '<cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="10"/><xf numFmtId="31"/><xf numFmtId="4"/></cellXfs></styleSheet>',
    );
    expect(styleFormats(styles)).toEqual([
      'general',
      'date',
      'date',
      { percent: 2 },
      'date',
      'general',
    ]);
    expect(styleFormats(null)).toEqual([]);
  });
});

describe('sheet contents', () => {
  it('joins the runs of a shared string and leaves the phonetic guide out', () => {
    const strings = xml(
      `<sst ${main}><si><t>이름</t></si><si><r><t>굵은 </t></r><r><t>글자</t></r></si>` +
        '<si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si></sst>',
    );
    expect(sharedStrings(strings)).toEqual(['이름', '굵은 글자', '東京']);
    expect(sharedStrings(null)).toEqual([]);
  });

  it('places cells by their reference and reads every cell type', () => {
    const { rows, columns, clipped } = sheetRows(
      sheet(
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>직접</t></is></c></row>' +
          '<row r="3"><c r="B3"><v>1.5</v></c><c r="C3" t="b"><v>1</v></c><c r="D3" t="str"><f>A1&amp;"!"</f><v>합계!</v></c>' +
          '<c r="E3" t="e"><v>#DIV/0!</v></c><c r="F3" s="1"><v>45292</v></c></row>',
      ),
      ['이름'],
      ['general', 'date'],
    );
    expect(rows).toEqual([
      ['이름', '', '직접'],
      [],
      ['', '1.5', 'TRUE', '합계!', '#DIV/0!', '2024-01-01'],
    ]);
    expect(columns).toBe(6);
    expect(clipped).toBe(false);
  });

  it('counts rows and cells that carry no reference', () => {
    const rows = '<row><c><v>1</v></c><c><v>2</v></c></row><row><c><v>3</v></c></row>';
    expect(sheetRows(sheet(rows), [], []).rows).toEqual([['1', '2'], ['3']]);
  });

  it('stops at the limits and says the sheet was clipped', () => {
    const past = columnName(sheetLimits.columns);
    const far = `<row r="1"><c r="A1"><v>1</v></c><c r="${past}1"><v>2</v></c></row>`;
    expect(sheetRows(sheet(far), [], [])).toMatchObject({ rows: [['1']], clipped: true });
    const last = sheetLimits.rows + 1;
    const deep = `<row r="1"><c r="A1"><v>1</v></c></row><row r="${last}"><c r="A${last}"><v>2</v></c></row>`;
    expect(sheetRows(sheet(deep), [], [])).toMatchObject({ rows: [['1']], clipped: true });
  });
});

describe('a whole workbook', () => {
  async function workbook(parts: Record<string, string>) {
    const zip = new JSZip();
    for (const [name, text] of Object.entries(parts)) zip.file(name, text);
    return zip.generateAsync({ type: 'uint8array' });
  }
  const rels = (items: string) =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
  const type = (name: string) =>
    `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${name}`;

  it('reads the sheets in workbook order through their relationships', async () => {
    const bytes = await workbook({
      'xl/workbook.xml': `<workbook ${main} ${relations}><sheets><sheet name="매출" sheetId="1" r:id="rId2"/><sheet name="그래프" sheetId="2" r:id="rId3"/><sheet name="빈 시트" sheetId="3" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': rels(
        `<Relationship Id="rId1" Type="${type('worksheet')}" Target="worksheets/sheet2.xml"/>` +
          `<Relationship Id="rId2" Type="${type('worksheet')}" Target="/xl/worksheets/sheet1.xml"/>` +
          `<Relationship Id="rId3" Type="${type('chartsheet')}" Target="chartsheets/sheet1.xml"/>` +
          `<Relationship Id="rId4" Type="${type('sharedStrings')}" Target="sharedStrings.xml"/>`,
      ),
      'xl/sharedStrings.xml': `<sst ${main}><si><t>품목</t></si></sst>`,
      'xl/worksheets/sheet1.xml': `<worksheet ${main}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12</v></c></row></sheetData></worksheet>`,
      'xl/worksheets/sheet2.xml': `<worksheet ${main}><sheetData/></worksheet>`,
      'xl/chartsheets/sheet1.xml': '<chartsheet/>',
    });
    expect(await readWorkbook(bytes)).toEqual([
      { name: '매출', rows: [['품목', '12']], columns: 2, clipped: false },
      { name: '그래프', rows: [], columns: 0, clipped: false },
      { name: '빈 시트', rows: [], columns: 0, clipped: false },
    ]);
  });

  it('refuses what is not a workbook', async () => {
    await expect(readWorkbook(await workbook({ 'word/document.xml': '<a/>' }))).rejects.toThrow();
    await expect(readWorkbook(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
