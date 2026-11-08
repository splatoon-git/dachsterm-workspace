import { expect, test, type Page } from '@playwright/test';
import type { FileRead } from '../../src/features/editor/fileRead';
import type {} from './fixtures/file-tab';

const facts = { size: 1234, modified: 1_700_000_000 };
const text = (
  value: string,
  over: Partial<Extract<FileRead, { kind: 'text' }>> = {},
): FileRead => ({
  ...facts,
  kind: 'text',
  text: value,
  encoding: 'utf-8',
  lossy: false,
  large: false,
  hash: 'a'.repeat(64) + value.length,
  ...over,
});
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const svg = btoa(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" onload="window.__pwned=true">' +
    '<script>window.__pwned=true</script><rect width="20" height="20"/></svg>',
);

type Files = Window['__fileTab']['files'];
async function open(page: Page, files: Files, status: 'connected' | 'closed' = 'connected') {
  await page.addInitScript(
    (value) => {
      window.__fileTab = value as typeof window.__fileTab;
    },
    { files, status, calls: [], opened: [] } satisfies Window['__fileTab'],
  );
  await page.goto('/tests/ui/fixtures/file-tab.html');
  await expect(page.getByRole('tab', { name: '터미널' })).toBeVisible();
}
const state = (page: Page) => page.evaluate(() => window.__fileTab);
const row = (page: Page, name: string) => page.locator(`[data-file-name="${name}"]`);
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const editor = (page: Page) => page.locator('.editor-host .view-lines').first();
const status = (page: Page) => page.getByLabel('파일 정보');
// The editor has role=alert regions of its own.
const banner = (page: Page) => page.locator('.file-tab-banner[role="alert"]');

test.describe('opening files', () => {
  const files: Files = {
    '/a.txt': text('첫 번째'),
    '/b.txt': text('두 번째'),
    '/c.txt': text('세 번째'),
  };

  test('a click previews a file and the next click replaces it', async ({ page }) => {
    await open(page, files);
    await row(page, 'a.txt').click();
    await expect(tab(page, 'a.txt')).toHaveCSS('font-style', 'italic');
    await expect(editor(page)).toContainText('첫');
    await row(page, 'b.txt').click();
    await expect(tab(page, 'b.txt')).toBeVisible();
    await expect(tab(page, 'a.txt')).toHaveCount(0);
    await expect(editor(page)).toContainText('두');
  });

  test('a double click pins, so the next file opens beside it', async ({ page }) => {
    await open(page, files);
    await row(page, 'a.txt').dblclick();
    await expect(tab(page, 'a.txt')).toHaveCSS('font-style', 'normal');
    await row(page, 'b.txt').click();
    await expect(tab(page, 'a.txt')).toBeVisible();
    await expect(tab(page, 'b.txt')).toHaveCSS('font-style', 'italic');
  });

  test('double-clicking the tab pins the preview', async ({ page }) => {
    await open(page, files);
    await row(page, 'a.txt').click();
    await expect(tab(page, 'a.txt')).toHaveCSS('font-style', 'italic');
    await tab(page, 'a.txt').dblclick();
    await expect(tab(page, 'a.txt')).toHaveCSS('font-style', 'normal');
    await row(page, 'b.txt').click();
    await expect(tab(page, 'a.txt')).toBeVisible();
  });

  test('a file already open is selected and not read again', async ({ page }) => {
    await open(page, files);
    await row(page, 'a.txt').dblclick();
    await expect(editor(page)).toContainText('첫');
    await tab(page, '터미널').click();
    await expect(page.getByText('터미널 화면')).toBeVisible();
    await row(page, 'a.txt').click();
    await expect(tab(page, 'a.txt')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab')).toHaveCount(2);
    expect((await state(page)).calls.filter((c) => c.path === '/a.txt')).toHaveLength(1);
  });

  test('a click with a modifier only selects', async ({ page }) => {
    await open(page, files);
    await row(page, 'a.txt').click({ modifiers: ['ControlOrMeta'] });
    await row(page, 'b.txt').click({ modifiers: ['Shift'] });
    await expect(page.getByRole('tab')).toHaveCount(1);
    expect((await state(page)).calls).toEqual([]);
  });

  test('closing a tab forgets it, so the file opens fresh', async ({ page }) => {
    await open(page, files);
    await row(page, 'a.txt').click();
    await expect(editor(page)).toContainText('첫');
    await page.getByRole('button', { name: 'a.txt 탭 닫기' }).click();
    await expect(page.getByRole('tab')).toHaveCount(1);
    await row(page, 'a.txt').click();
    await expect(tab(page, 'a.txt')).toBeVisible();
    expect((await state(page)).calls).toHaveLength(2);
  });

  test('folders and links keep the panel behaviour', async ({ page }) => {
    await open(page, { '/dir/': text(''), '/x.link': text('') });
    await row(page, 'dir/').click();
    await row(page, 'x.link').click();
    await expect(page.getByRole('tab')).toHaveCount(1);
    await row(page, 'dir/').dblclick();
    await expect(page.locator('body')).toHaveAttribute('data-panel-open', '/dir/');
    await row(page, 'x.link').dblclick();
    await expect(page.locator('body')).toHaveAttribute('data-panel-open', '/x.link');
    await expect(page.getByRole('tab')).toHaveCount(1);
  });
});

test.describe('showing formats', () => {
  test('code is highlighted and read-only, with its facts in the status bar', async ({ page }) => {
    await open(page, { '/app.ts': text('const a = 1;\r\nif (a) {\r\n  a;\r\n}\r\n') });
    await row(page, 'app.ts').click();
    await expect(editor(page)).toContainText('const');
    await expect
      .poll(() =>
        page
          .locator('.editor-host .view-line span span')
          .evaluateAll((spans) => new Set(spans.map((span) => span.className)).size),
      )
      .toBeGreaterThan(1);
    await expect(status(page)).toContainText('UTF-8');
    await expect(status(page)).toContainText('CRLF');
    await expect(status(page)).toContainText('공백 2');
    await expect(status(page)).toContainText('typescript');
    await page.locator('.editor-host').first().click();
    await page.keyboard.type('x');
    await expect(editor(page)).not.toContainText('xconst');
  });

  test('the status bar follows the focused tab', async ({ page }) => {
    await open(page, { '/a.txt': text('a') });
    await row(page, 'a.txt').click();
    await expect(status(page)).toBeVisible();
    await tab(page, '터미널').click();
    await expect(status(page)).toHaveCount(0);
  });

  test('Markdown renders safely and switches to its source', async ({ page }) => {
    const source = [
      '# 제목',
      '',
      '<script>window.__pwned=true</script>',
      '<img src="https://images.example/remote.png" onerror="window.__pwned=true">',
      '',
      '![원격](https://images.example/two.png)',
      '',
      '[누르기](https://example.com/page)',
    ].join('\n');
    await open(page, { '/README.md': text(source) });
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await row(page, 'README.md').click();
    const preview = page.locator('.markdown-preview');
    await expect(preview.getByRole('heading', { name: '제목' })).toBeVisible();
    await expect(preview.locator('img, script')).toHaveCount(0);
    await expect(preview.getByRole('link', { name: '원격 이미지 · 원격' })).toBeVisible();
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
    expect(requests.filter((url) => url.includes('example'))).toEqual([]);

    await page.getByRole('button', { name: '원문' }).click();
    await expect(preview).toHaveCount(0);
    await expect(editor(page)).toContainText('제목');
    await expect(page.getByRole('button', { name: '원문' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('a link asks before opening and cancel opens nothing', async ({ page }) => {
    await open(page, { '/a.md': text('[누르기](https://example.com/page)') });
    await row(page, 'a.md').click();
    const link = page.locator('.markdown-preview').getByRole('link', { name: '누르기' });
    await link.click();
    const dialog = page.getByRole('dialog', { name: '브라우저로 열까요?' });
    await expect(dialog).toContainText('https://example.com/page');
    await dialog.getByRole('button', { name: '취소' }).click();
    expect((await state(page)).opened).toEqual([]);

    await link.click();
    await page
      .getByRole('dialog', { name: '브라우저로 열까요?' })
      .getByRole('button', { name: '열기' })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect((await state(page)).opened).toEqual(['https://example.com/page']);
  });

  test('JSON stays as written until asked, and tidying keeps long numbers', async ({ page }) => {
    await open(page, { '/a.json': text('{"id":12345678901234567890,"b":[1]}') });
    await row(page, 'a.json').click();
    await expect(editor(page)).toContainText('{"id":12345678901234567890');
    await page.getByRole('button', { name: '정리해서 보기' }).click();
    await expect(editor(page)).toContainText('"id": 12345678901234567890,');
    await expect(editor(page)).not.toContainText('{"id"');
    await page.getByRole('button', { name: '원문' }).click();
    await expect(editor(page)).toContainText('{"id":12345678901234567890');
  });

  test('invalid JSON explains and keeps the text', async ({ page }) => {
    await open(page, { '/a.json': text('{broken') });
    await row(page, 'a.json').click();
    await page.getByRole('button', { name: '정리해서 보기' }).click();
    await expect(page.getByText('JSON 형식이 아니어서 정리할 수 없습니다')).toBeVisible();
    await expect(editor(page)).toContainText('{broken');
  });

  test('a picture is shown as an image', async ({ page }) => {
    const answer: FileRead = { ...facts, kind: 'image', mime: 'image/png', data: png, hash: 'h' };
    await open(page, { '/a.png': answer });
    await row(page, 'a.png').click();
    const image = page.getByRole('img', { name: 'a.png' });
    await expect(image).toBeVisible();
    expect(await image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(1);
  });

  test('an SVG is only an image and its script does not run', async ({ page }) => {
    const answer: FileRead = {
      ...facts,
      kind: 'image',
      mime: 'image/svg+xml',
      data: svg,
      hash: 'h',
    };
    await open(page, { '/a.svg': answer });
    await row(page, 'a.svg').click();
    const image = page.getByRole('img', { name: 'a.svg' });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
      .toBeGreaterThan(0);
    await expect(page.locator('.file-tab svg')).toHaveCount(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });
});

test.describe('files the tab will not open as they are', () => {
  test('a binary file shows its format and size and no editor', async ({ page }) => {
    await open(page, {
      '/a.zip': { size: 2048, modified: null, kind: 'binary', format: 'ZIP 압축' },
    });
    await row(page, 'a.zip').click();
    await expect(page.getByText('바이너리 파일이라 열지 않았습니다')).toBeVisible();
    await expect(page.getByText('ZIP 압축 · 2.0 KB')).toBeVisible();
    await expect(page.locator('.editor-host')).toHaveCount(0);
    await expect(status(page)).toHaveCount(0);
  });

  test('a large file asks, then opens plain and read-only', async ({ page }) => {
    await open(page, {
      '/big.ts': { size: 3 * 1024 * 1024, modified: null, kind: 'large' },
      '/big.ts|large': text('const big = 1;', { large: true }),
    });
    await row(page, 'big.ts').click();
    await expect(page.getByText('크기가 커서 바로 열지 않았습니다')).toBeVisible();
    await expect(page.getByText('3.0 MB')).toBeVisible();
    await expect(page.locator('.editor-host')).toHaveCount(0);
    await page.getByRole('button', { name: '크게 열기' }).click();
    await expect(page.getByText('큰 파일이라 읽기 전용으로 열고')).toBeVisible();
    await expect(editor(page)).toContainText('const big');
    await expect(status(page)).toContainText('일반 텍스트');
    const calls = (await state(page)).calls.map((c) => c.options.large);
    expect(calls).toEqual([false, true]);
  });

  test('a large Markdown file has no preview', async ({ page }) => {
    await open(page, {
      '/big.md': { size: 3 * 1024 * 1024, modified: null, kind: 'large' },
      '/big.md|large': text('# big', { large: true }),
    });
    await row(page, 'big.md').click();
    await page.getByRole('button', { name: '크게 열기' }).click();
    await expect(editor(page)).toContainText('# big');
    await expect(page.locator('.markdown-preview')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '미리보기' })).toHaveCount(0);
  });

  test('past the limit it points elsewhere and offers no way to force it', async ({ page }) => {
    await open(page, { '/huge.log': { size: 40 * 1024 * 1024, modified: null, kind: 'tooLarge' } });
    await row(page, 'huge.log').click();
    await expect(page.getByText('이 파일은 탭에서 열 수 없습니다')).toBeVisible();
    await expect(page.getByRole('button', { name: '크게 열기' })).toHaveCount(0);
  });

  test('broken bytes are reported and another encoding can be chosen', async ({ page }) => {
    await open(page, {
      '/a.txt': text('��', { lossy: true }),
      '/a.txt|euc-kr': text('한글', { encoding: 'euc-kr' }),
    });
    await row(page, 'a.txt').click();
    await expect(banner(page)).toContainText('편집을 막습니다');
    await status(page).getByRole('button', { name: 'UTF-8' }).click();
    await page.getByRole('menuitem', { name: 'CP949 / EUC-KR' }).click();
    await expect(editor(page)).toContainText('한글');
    await expect(banner(page)).toHaveCount(0);
    await expect(status(page)).toContainText('CP949');
    const options = (await state(page)).calls.at(-1)!.options;
    expect(options.encoding).toBe('euc-kr');
  });

  test('a read that fails says why and can be retried', async ({ page }) => {
    await open(page, { '/a.txt': { fail: '경로를 찾을 수 없습니다.' } });
    await row(page, 'a.txt').click();
    await expect(page.locator('.file-tab-notice [role="alert"]')).toContainText(
      '경로를 찾을 수 없습니다.',
    );
    await page.getByRole('button', { name: '다시 시도' }).click();
    await expect.poll(async () => (await state(page)).calls.length).toBe(2);
  });

  test('a file from an ended connection says it is read-only', async ({ page }) => {
    await open(page, { '/a.txt': text('내용') }, 'closed');
    await row(page, 'a.txt').click();
    await expect(page.getByText('연결이 끊겨 읽기 전용입니다')).toBeVisible();
    await expect(editor(page)).toContainText('내용');
  });
});
