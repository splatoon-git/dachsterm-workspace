import { expect, test, type Locator, type Page } from '@playwright/test';
import type { FileRead } from '../../src/features/editor/fileRead';
import { docx, oversized, pdf, pptx, xlsx } from './fixtures/documents';
import { hwp, hwpText, hwpx } from './fixtures/hwpSamples';
import type {} from './fixtures/file-tab';

type Files = Window['__fileTab']['files'];
const facts = { size: 2048, modified: 1_700_000_000 };
const document_ = (format: string, data: string): FileRead => ({
  ...facts,
  kind: 'document',
  format,
  data,
  hash: 'h',
});
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
/** 40 × 20 pixels, so fitting and zooming have a size to work on. */
const wide = btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20"/></svg>',
);

async function open(page: Page, files: Files, extra: Partial<Window['__fileTab']> = {}) {
  await page.addInitScript(
    (value) => {
      window.__fileTab = value as typeof window.__fileTab;
    },
    { files, status: 'connected', calls: [], opened: [], writes: [], answers: [], ...extra },
  );
  await page.goto('/tests/ui/fixtures/file-tab.html');
  await expect(page.getByRole('tab', { name: '터미널' })).toBeVisible();
}
const row = (page: Page, name: string) => page.locator(`[data-file-name="${name}"]`);
const state = (page: Page) => page.evaluate(() => window.__fileTab);
const pageOf = (page: Page, number: number) => page.getByRole('img', { name: `${number}쪽` });
const zoom = (page: Page) => page.getByRole('group', { name: '확대와 축소' });
const openDefault = (page: Page) => page.getByRole('button', { name: '기본 프로그램으로 열기' });

/** Whether anything but the paper color was drawn: the share of pixels that are not white. */
const inked = (canvas: Locator) =>
  canvas.evaluate((node: HTMLCanvasElement) => {
    const { data } = node.getContext('2d')!.getImageData(0, 0, node.width, node.height);
    let dark = 0;
    for (let at = 0; at < data.length; at += 4) if (data[at] < 128 && data[at + 3] > 0) dark += 1;
    return dark;
  });

test.describe('a PDF', () => {
  test('is drawn page by page, and only the pages near the view', async ({ page }) => {
    await open(page, { '/report.pdf': document_('pdf', pdf('Quarterly report', 12)) });
    await row(page, 'report.pdf').click();
    await expect(page.getByText('12쪽', { exact: true })).toBeVisible();
    const first = pageOf(page, 1).locator('canvas');
    await expect(first).toBeVisible();
    await expect.poll(() => inked(first)).toBeGreaterThan(50);
    // The last page is far below, so it has its place but nothing has been drawn for it.
    await expect(pageOf(page, 12)).toBeAttached();
    await expect(pageOf(page, 12).locator('canvas')).toHaveCount(0);
    await pageOf(page, 12).scrollIntoViewIfNeeded();
    await expect.poll(() => inked(pageOf(page, 12).locator('canvas'))).toBeGreaterThan(50);
    await expect(page.locator('.editor-host')).toHaveCount(0);
  });

  test('zooms by steps and back to the width of the pane', async ({ page }) => {
    await open(page, { '/a.pdf': document_('pdf', pdf('Zoom')) });
    await row(page, 'a.pdf').click();
    const sheet = pageOf(page, 1);
    await expect(sheet.locator('canvas')).toBeVisible();
    const fit = page.getByRole('button', { name: '폭 맞춤' });
    await expect(fit).toHaveAttribute('aria-pressed', 'true');
    const width = async () => (await sheet.boundingBox())!.width;
    await zoom(page).getByTitle('100%로 보기').click();
    await expect(fit).toHaveAttribute('aria-pressed', 'false');
    // A US Letter page is 8.5 inches: 816 CSS pixels at 100%.
    await expect.poll(width).toBeCloseTo(816, 0);
    await zoom(page).getByRole('button', { name: '확대' }).click();
    await expect(zoom(page).getByText('125%')).toBeVisible();
    await expect.poll(width).toBeCloseTo(1020, 0);
    await expect.poll(() => inked(sheet.locator('canvas'))).toBeGreaterThan(50);
    await zoom(page).getByRole('button', { name: '축소' }).click();
    await zoom(page).getByRole('button', { name: '축소' }).click();
    await expect(zoom(page).getByText('90%')).toBeVisible();
    await fit.click();
    await expect(fit).toHaveAttribute('aria-pressed', 'true');
  });

  test('one that cannot be read says so and offers the program of this computer', async ({
    page,
  }) => {
    await open(page, { '/broken.pdf': document_('pdf', btoa('%PDF-1.4\nnot a real file')) });
    await row(page, 'broken.pdf').click();
    await expect(page.getByText('미리 볼 수 없습니다')).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('PDF를 읽지 못했습니다');
    await openDefault(page).click();
    await expect
      .poll(async () => (await state(page)).defaults)
      .toEqual([
        {
          command: 'edit_open_default',
          args: { id: 'c1', profileId: 'p1', path: '/broken.pdf', uploadMode: 'ask' },
        },
      ]);
    await expect(page.getByRole('status')).toContainText('거기서 저장하면 업로드 여부를 묻습니다');
  });
});

test.describe('office documents', () => {
  test('a Word document is laid out as pages, and its links do not leave the app', async ({
    page,
  }) => {
    await open(page, {
      '/memo.docx': document_('docx', await docx(['회의록', '첫째 안건입니다.', '링크로 가기'])),
    });
    await row(page, 'memo.docx').click();
    const sheet = page.locator('.preview-docx section.docx');
    await expect(sheet).toContainText('첫째 안건입니다.');
    // Paper stays white with dark text whatever the theme is.
    await expect(sheet).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(sheet).toHaveCSS('color', 'rgb(31, 35, 40)');
    const before = page.url();
    await page.getByText('링크로 가기').click();
    expect(page.url()).toBe(before);
    await expect(sheet).toBeVisible();
    expect((await state(page)).opened).toEqual([]);
  });

  test('a workbook shows stored values, formatted dates, and its other sheets', async ({
    page,
  }) => {
    await open(page, { '/sales.xlsx': document_('xlsx', await xlsx()) });
    await row(page, 'sales.xlsx').click();
    const grid = page.locator('.preview-sheet');
    await expect(grid.getByRole('columnheader')).toHaveText(['A', 'B', 'C']);
    await expect(grid.getByRole('row').nth(1).getByRole('cell')).toHaveText(['품목', '1200', '']);
    await expect(grid.getByRole('row').nth(2).getByRole('cell')).toHaveText([
      '2024-01-01',
      '',
      '12.50%',
    ]);
    const sheets = page.getByRole('tablist', { name: '시트' });
    await expect(sheets.getByRole('tab')).toHaveText(['매출', '메모']);
    await sheets.getByRole('tab', { name: '메모' }).click();
    await expect(grid.getByRole('cell')).toHaveText(['둘째 시트']);
  });

  test('a presentation is an outline of its slides with their pictures', async ({ page }) => {
    await open(page, { '/deck.pptx': document_('pptx', await pptx(png)) });
    await row(page, 'deck.pptx').click();
    await expect(page.getByText('슬라이드 2장 · 글과 그림만 표시')).toBeVisible();
    const first = page.getByRole('region', { name: '슬라이드 1' });
    await expect(first.getByRole('heading')).toHaveText('분기 보고');
    await expect(first.locator('.preview-slide-line')).toHaveText(['매출 증가', '국내 12%']);
    const picture = first.getByRole('img', { name: '매출 그래프' });
    await expect
      .poll(() => picture.evaluate((node: HTMLImageElement) => node.naturalWidth))
      .toBe(1);
    await expect(page.getByRole('region', { name: '슬라이드 2' }).getByRole('heading')).toHaveText(
      '다음 단계',
    );
  });

  test('a package that would unpack far too large is not opened', async ({ page }) => {
    await open(page, { '/bomb.docx': document_('docx', await oversized()) });
    await row(page, 'bomb.docx').click();
    await expect(page.getByRole('alert')).toHaveText('압축을 풀면 너무 커서 미리 보지 않습니다.');
    await expect(page.getByText('Word 문서')).toBeVisible();
  });

  test('a file that is a package in name only says it cannot be read', async ({ page }) => {
    await open(page, { '/empty.xlsx': document_('xlsx', await docx(['not a workbook'])) });
    await row(page, 'empty.xlsx').click();
    await expect(page.getByRole('alert')).toContainText('통합 문서를 읽지 못했습니다');
  });
});

test.describe('한글 documents', () => {
  for (const [name, data] of [
    ['notice.hwp', hwp],
    ['notice.hwpx', hwpx],
  ] as const) {
    test(`${name} is laid out as pages`, async ({ page }) => {
      await open(page, { [`/${name}`]: document_(name.split('.')[1], data) });
      await row(page, name).click();
      // The engine is large, so its first load is given more time than a test usually gets.
      await expect(page.getByText('1쪽', { exact: true })).toBeVisible({ timeout: 60_000 });
      const drawn = pageOf(page, 1).locator('img');
      await expect
        .poll(() => drawn.evaluate((node: HTMLImageElement) => node.naturalWidth))
        .toBeGreaterThan(700);
      // The page is a picture of the document, with each letter of the file's text placed in it.
      const source = await drawn.getAttribute('src');
      expect(decodeURIComponent(source!)).toContain(`>${hwpText[0]}</text>`);
      expect(source).toMatch(/^data:image\/svg\+xml/);
      await expect(page.locator('.preview-page svg')).toHaveCount(0);
    });
  }

  test('one that is not a 한글 file says it cannot be read', async ({ page }) => {
    const notHwp = btoa('\xD0\xCF\x11\xE0\xA1\xB1\x1A\xE1 but nothing after it');
    await open(page, { '/broken.hwp': document_('hwp', notHwp) });
    await row(page, 'broken.hwp').click();
    await expect(page.getByRole('alert')).toContainText('한글 문서를 읽지 못했습니다', {
      timeout: 60_000,
    });
    await expect(page.getByText('한글 문서', { exact: true })).toBeVisible();
  });
});

test.describe('pictures', () => {
  const picture: FileRead = {
    ...facts,
    kind: 'image',
    mime: 'image/svg+xml',
    data: wide,
    hash: 'h',
  };

  test('a small picture is shown at its own size, and zooming enlarges it', async ({ page }) => {
    await open(page, { '/a.svg': picture });
    await row(page, 'a.svg').click();
    const image = page.getByRole('img', { name: 'a.svg' });
    await expect(page.getByText('40 × 20')).toBeVisible();
    await expect(zoom(page).getByText('100%')).toBeVisible();
    const box = async () => {
      const found = (await image.boundingBox())!;
      return [Math.round(found.width), Math.round(found.height)];
    };
    await expect.poll(box).toEqual([40, 20]);
    await zoom(page).getByRole('button', { name: '확대' }).click();
    await zoom(page).getByRole('button', { name: '확대' }).click();
    await expect.poll(box).toEqual([60, 30]);
    await page.getByRole('button', { name: '폭 맞춤' }).click();
    await expect.poll(box).toEqual([40, 20]);
  });

  test('a picture that cannot be decoded says so instead of a broken icon', async ({ page }) => {
    const broken: FileRead = { ...picture, mime: 'image/png', data: btoa('not a picture') };
    await open(page, { '/a.png': broken });
    await row(page, 'a.png').click();
    await expect(page.getByRole('alert')).toContainText('이미지를 표시하지 못했습니다');
  });
});

test.describe('the program of this computer', () => {
  const zip: FileRead = { size: 2048, modified: null, kind: 'binary', format: 'ZIP 압축' };

  test('a binary file can be handed to it, and a failure is shown on the tab', async ({ page }) => {
    await open(page, { '/a.zip': zip }, { defaultFail: '파일 열기를 취소했습니다.' });
    await row(page, 'a.zip').click();
    await openDefault(page).click();
    await expect(page.locator('.file-tab-banner[role="alert"]')).toHaveText(
      '파일 열기를 취소했습니다.',
    );
    expect((await state(page)).defaults).toHaveLength(1);
  });

  test('a preview keeps the button in its bar', async ({ page }) => {
    await open(page, { '/a.pdf': document_('pdf', pdf('Bar')) });
    await row(page, 'a.pdf').click();
    await expect(pageOf(page, 1).locator('canvas')).toBeVisible();
    await page
      .locator('.file-tab-bar')
      .getByRole('button', { name: '기본 프로그램으로 열기' })
      .click();
    await expect
      .poll(async () => (await state(page)).defaults?.map((call) => call.args.path))
      .toEqual(['/a.pdf']);
  });

  test('a server file cannot be fetched once its connection has ended', async ({ page }) => {
    await open(page, { '/a.zip': zip }, { status: 'closed' });
    await row(page, 'a.zip').click();
    await expect(page.getByText('바이너리 파일이라 열지 않았습니다')).toBeVisible();
    await expect(openDefault(page)).toHaveCount(0);
  });
});
