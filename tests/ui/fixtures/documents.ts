// Documents for the preview tests, as the base64 `file_read` sends. The PDF and the office
// packages are built here, so a test can see exactly what is in them.
import JSZip from 'jszip';

const base64 = (bytes: Uint8Array) => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

async function packageOf(parts: Record<string, string | Uint8Array>) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return base64(await zip.generateAsync({ type: 'uint8array' }));
}

/** A PDF that says `text` on each of `pages` pages in a standard font. */
export function pdf(text: string, pages = 1) {
  const stream = `BT /F1 24 Tf 72 720 Td (${text}) Tj ET`;
  const kids = Array.from({ length: pages }, (_, index) => `${index + 5} 0 R`).join(' ');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...Array.from(
      { length: pages },
      () =>
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 3 0 R ' +
        '/Resources << /Font << /F1 4 0 R >> >> >>',
    ),
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const at = body.length;
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return at;
  });
  const start = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) body += `${String(at).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return btoa(body);
}

const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const relationships = (items: string) =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
const contentTypes = (overrides: string) =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  `<Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`;

/** A Word document of these paragraphs. The last one links to a web page. */
export function docx(paragraphs: string[]) {
  const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const run = (value: string) => `<w:r><w:t>${value}</w:t></w:r>`;
  const body = paragraphs
    .map((value, index) =>
      index === paragraphs.length - 1
        ? `<w:p><w:hyperlink r:id="rId1">${run(value)}</w:hyperlink></w:p>`
        : `<w:p>${run(value)}</w:p>`,
    )
    .join('');
  return packageOf({
    '[Content_Types].xml': contentTypes(
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    ),
    '_rels/.rels': relationships(
      `<Relationship Id="rId1" Type="${office}/officeDocument" Target="word/document.xml"/>`,
    ),
    'word/_rels/document.xml.rels': relationships(
      `<Relationship Id="rId1" Type="${office}/hyperlink" Target="https://example.com/away" TargetMode="External"/>`,
    ),
    'word/document.xml':
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${word}" xmlns:r="${office}"><w:body>${body}` +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>',
  });
}

/** A workbook: text, a number, a date and a percentage on the first sheet, and a second sheet. */
export function xlsx() {
  const main = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  return packageOf({
    '[Content_Types].xml': contentTypes(''),
    'xl/workbook.xml':
      `<workbook ${main} xmlns:r="${office}"><sheets><sheet name="매출" sheetId="1" r:id="rId1"/>` +
      '<sheet name="메모" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': relationships(
      `<Relationship Id="rId1" Type="${office}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${office}/worksheet" Target="worksheets/sheet2.xml"/>` +
        `<Relationship Id="rId3" Type="${office}/sharedStrings" Target="sharedStrings.xml"/>` +
        `<Relationship Id="rId4" Type="${office}/styles" Target="styles.xml"/>`,
    ),
    'xl/sharedStrings.xml': `<sst ${main}><si><t>품목</t></si><si><t>둘째 시트</t></si></sst>`,
    'xl/styles.xml': `<styleSheet ${main}><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="10"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml':
      `<worksheet ${main}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>1200</v></c></row>` +
      '<row r="2"><c r="A2" s="1"><v>45292</v></c><c r="C2" s="2"><v>0.125</v></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': `<worksheet ${main}><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c></row></sheetData></worksheet>`,
  });
}

/** A presentation of two slides. The first has a title, two lines and a picture. */
export function pptx(picture: string) {
  const spaces =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${office}"`;
  const shape = (text: string, placeholder = '') =>
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="x"/><p:nvPr>${placeholder}</p:nvPr></p:nvSpPr><p:txBody>${text}</p:txBody></p:sp>`;
  const line = (text: string, level = 0) =>
    `<a:p><a:pPr lvl="${level}"/><a:r><a:t>${text}</a:t></a:r></a:p>`;
  const slide = (shapes: string) =>
    `<p:sld ${spaces}><p:cSld><p:spTree>${shapes}</p:spTree></p:cSld></p:sld>`;
  const title = '<p:ph type="title"/>';
  return packageOf({
    '[Content_Types].xml': contentTypes(''),
    'ppt/presentation.xml':
      `<p:presentation ${spaces}><p:sldIdLst><p:sldId id="256" r:id="rId1"/>` +
      '<p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': relationships(
      `<Relationship Id="rId1" Type="${office}/slide" Target="slides/slide1.xml"/>` +
        `<Relationship Id="rId2" Type="${office}/slide" Target="slides/slide2.xml"/>`,
    ),
    'ppt/slides/slide1.xml': slide(
      shape(line('분기 보고'), title) +
        shape(line('매출 증가') + line('국내 12%', 1)) +
        '<p:pic><p:nvPicPr><p:cNvPr id="4" name="그림" descr="매출 그래프"/></p:nvPicPr>' +
        '<p:blipFill><a:blip r:embed="rId1"/></p:blipFill></p:pic>',
    ),
    'ppt/slides/_rels/slide1.xml.rels': relationships(
      `<Relationship Id="rId1" Type="${office}/image" Target="../media/image1.png"/>`,
    ),
    'ppt/slides/slide2.xml': slide(shape(line('다음 단계'), title)),
    'ppt/media/image1.png': Uint8Array.from(atob(picture), (letter) => letter.charCodeAt(0)),
  });
}

/** A package that says it unpacks to far more than a preview will hold. */
export async function oversized() {
  const zip = new JSZip();
  zip.file('word/document.xml', 'x');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + 46 <= bytes.length; at += 1)
    if (view.getUint32(at, true) === 0x02014b50) view.setUint32(at + 24, 0xf0000000, true);
  return base64(bytes);
}
