// FV: previews of real files in the real app, where the web view's content policy applies. The
// browser fixtures cannot show that the PDF worker, its character maps and the 한글 engine load
// under it. Called by test-local-native.mjs with a local PowerShell tab open.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import JSZip from 'jszip';
import { HwpDocument, initSync } from '@rhwp/core';
import { showSidebarView } from './native-workspace.mjs';

/** The file the stand-in program writes the path it was given to (`fileOpener`). */
const OPENED = 'opened.txt';

/**
 * A program to stand in for the desktop's, for DACHSTERM_TEST_OPENER: it records the file it was
 * started with, so the check opens no real viewer.
 */
export async function fileOpener(directory) {
  const program = path.join(directory, 'opener.cmd');
  await writeFile(program, `@echo off\r\n>"%~dp0${OPENED}" echo %~1\r\n`);
  return program;
}

/**
 * One page that says 한글 in a font the file does not carry, named by a predefined character map.
 * The viewer has to fetch that map before it can draw the page.
 */
function koreanPdf() {
  const stream = 'BT /F1 48 Tf 72 700 Td <D55CAE00> Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type0 /BaseFont /HYGoThic-Medium /Encoding /UniKS-UCS2-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYGoThic-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /FontDescriptor 7 0 R /DW 1000 >>',
    '<< /Type /FontDescriptor /FontName /HYGoThic-Medium /Flags 6 /FontBBox [0 -148 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -148 /CapHeight 880 /StemV 60 >>',
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
  return Buffer.from(body, 'latin1');
}

/** A 한글 document of one line, written by the same engine the app reads it with. */
async function hwpFiles(text) {
  const require = createRequire(import.meta.url);
  // Outside a web view the engine has no canvas to measure text with. Any width will do here.
  globalThis.measureTextWidth = (_font, value) => value.length * 12;
  initSync({ module: await readFile(require.resolve('@rhwp/core/rhwp_bg.wasm')) });
  const document = HwpDocument.createEmpty();
  document.insertText(0, 0, 0, text);
  const files = {
    hwp: Buffer.from(document.exportHwp()),
    hwpx: Buffer.from(document.exportHwpx()),
  };
  document.free();
  return files;
}

const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const relationships = (items) =>
  `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
const contentTypes =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';

async function packageOf(parts) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(parts)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function docx(text) {
  const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  return packageOf({
    '[Content_Types].xml': contentTypes,
    '_rels/.rels': relationships(
      `<Relationship Id="rId1" Type="${office}/officeDocument" Target="word/document.xml"/>`,
    ),
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${word}"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  });
}

function xlsx(text) {
  const main = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  return packageOf({
    '[Content_Types].xml': contentTypes,
    'xl/workbook.xml': `<workbook ${main} xmlns:r="${office}"><sheets><sheet name="시트" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relationships(
      `<Relationship Id="rId1" Type="${office}/worksheet" Target="worksheets/sheet1.xml"/>`,
    ),
    'xl/worksheets/sheet1.xml': `<worksheet ${main}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${text}</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>`,
  });
}

/** A 2 × 2 bitmap, the oldest picture format the tab shows. */
function bitmap() {
  const file = Buffer.alloc(70);
  file.write('BM');
  file.writeUInt32LE(70, 2);
  file.writeUInt32LE(54, 10);
  file.writeUInt32LE(40, 14);
  file.writeInt32LE(2, 18);
  file.writeInt32LE(2, 22);
  file.writeUInt16LE(1, 26);
  file.writeUInt16LE(24, 28);
  file.writeUInt32LE(16, 34);
  file.fill(0x40, 54);
  return file;
}

export async function checkFilePreview(page, command, pane, directory) {
  const folder = path.join(await realpath(directory), 'file preview');
  await mkdir(folder, { recursive: true });
  const { hwp, hwpx } = await hwpFiles('닥스텀 한글 문서');
  await writeFile(path.join(folder, 'korean.pdf'), koreanPdf());
  await writeFile(path.join(folder, 'notice.hwp'), hwp);
  await writeFile(path.join(folder, 'notice.hwpx'), hwpx);
  await writeFile(path.join(folder, 'memo.docx'), await docx('회의록 본문'));
  await writeFile(path.join(folder, 'sales.xlsx'), await xlsx('품목'));
  await writeFile(path.join(folder, 'dot.bmp'), bitmap());

  // What the web view refused under its content policy while the previews loaded.
  const refused = [];
  const onConsole = (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) refused.push(message.text());
  };
  page.on('console', onConsole);

  const files = page.getByRole('complementary', { name: '로컬 파일 탐색' });
  await showSidebarView(page, '파일');
  await command(pane, `Set-Location '${folder}'; Write-Output ('VIEW' + '_HERE')`, 'VIEW_HERE');
  const row = (name) => files.locator(`[data-file-name="${name}"]`);
  const shown = page.locator('.pane-cell:not([hidden]) .file-tab');
  const sheet = shown.getByRole('img', { name: '1쪽' });
  const inked = (canvas) =>
    canvas.evaluate((node) => {
      const { data } = node.getContext('2d').getImageData(0, 0, node.width, node.height);
      let dark = 0;
      for (let at = 0; at < data.length; at += 4) if (data[at] < 128 && data[at + 3] > 0) dark += 1;
      return dark;
    });

  await row('korean.pdf').click();
  await expect(sheet.locator('canvas')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => inked(sheet.locator('canvas')), { timeout: 30000 }).toBeGreaterThan(200);
  console.log('PASS a PDF draws Korean text that needs a fetched character map');

  for (const name of ['notice.hwp', 'notice.hwpx']) {
    await row(name).click();
    const drawn = sheet.locator('img');
    await expect(drawn).toBeVisible({ timeout: 60000 });
    await expect
      .poll(() => drawn.evaluate((node) => node.naturalWidth), { timeout: 30000 })
      .toBeGreaterThan(700);
    assert.match(decodeURIComponent(await drawn.getAttribute('src')), />닥<\/text>/);
  }
  console.log('PASS 한글 files (hwp, hwpx) are laid out by the engine under the real policy');

  await row('memo.docx').click();
  await expect(shown.locator('section.docx')).toContainText('회의록 본문', { timeout: 30000 });
  await row('sales.xlsx').click();
  await expect(shown.locator('.preview-sheet').getByRole('cell')).toHaveText(['품목', '42'], {
    timeout: 30000,
  });
  console.log('PASS a Word document and a workbook are read from real files');

  await row('dot.bmp').click();
  const picture = shown.getByRole('img', { name: 'dot.bmp' });
  await expect
    .poll(() => picture.evaluate((node) => node.naturalWidth), { timeout: 15000 })
    .toBe(2);
  console.log('PASS a bitmap shows as a picture');

  const opened = async () =>
    (await readFile(path.join(directory, OPENED), 'utf8').catch(() => '')).trim();
  await shown.getByRole('button', { name: '기본 프로그램으로 열기' }).click();
  await expect.poll(opened, { timeout: 15000 }).toBe(path.join(folder, 'dot.bmp'));
  await row('memo.docx').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '기본 프로그램으로 열기' }).click();
  await expect.poll(opened, { timeout: 15000 }).toBe(path.join(folder, 'memo.docx'));
  console.log('PASS the tab and the file menu hand a local file to the program for its type');

  page.off('console', onConsole);
  assert.deepEqual(refused, [], 'the content policy refused something a preview needed');
  console.log('PASS nothing a preview loaded was refused by the content policy');
}

/**
 * FV.2 against a real SFTP server: the file is fetched, marked as downloaded, handed to the
 * program for its type, and a save there asks before it is uploaded. Run through
 * `node scripts/run-phase1.mjs --native --edit-only`.
 */
export async function verifyServerOpenByDefault({
  pane,
  invoke,
  docker,
  probe,
  directory,
  setStage,
}) {
  setStage('FV.2 open a server file by default');
  const container = probe('CONTAINER');
  const remote = '/home/probe/보고서.docx';
  const cat = () => docker(['exec', container, 'cat', remote]);
  docker(['exec', '-u', 'probe', container, 'sh', '-c', `printf '%s' 'server copy' > '${remote}'`]);
  const edit = await invoke('edit_open_default', {
    id: await pane().getAttribute('data-connection-id'),
    profileId: (await invoke('sessions')).profiles[0].id,
    path: remote,
    uploadMode: 'ask',
  });
  assert.equal(edit.status, 'watching');
  assert.equal(path.basename(edit.local), 'working.docx');
  assert.equal(await readFile(edit.local, 'utf8'), 'server copy');
  const opened = async () =>
    (await readFile(path.join(directory, OPENED), 'utf8').catch(() => '')).trim();
  await expect.poll(opened, { timeout: 15000 }).toBe(edit.local);
  // The mark office programs read to open a download read-only until the user allows editing.
  assert.match(await readFile(`${edit.local}:Zone.Identifier`, 'utf8'), /ZoneId=3/);
  console.log('PASS FV.2 a server file is fetched, marked as downloaded and handed to its program');

  setStage('FV.2 a save in that program asks before uploading');
  await writeFile(edit.local, 'saved in the program', 'utf8');
  const card = pane().getByRole('alertdialog', { name: '외부 편집 저장 확인', exact: true });
  await expect(card).toContainText('서버 파일에 업로드할까요?', { timeout: 15000 });
  assert.equal(cat(), 'server copy', 'Nothing is uploaded before the answer');
  await card.getByRole('button', { name: '업로드', exact: true }).click();
  await expect.poll(cat, { timeout: 15000 }).toBe('saved in the program');
  await expect(card).toBeHidden();
  await expect
    .poll(async () => (await invoke('edit_list')).find((item) => item.id === edit.id)?.status)
    .toBe('watching');
  await invoke('edit_close', { id: edit.id });
  console.log(
    'PASS FV.2 saving the fetched copy asks on the tab, uploads, and the edit closes clean',
  );
}
