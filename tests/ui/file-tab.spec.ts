import { expect, test, type Page } from '@playwright/test';
import type { FileRead } from '../../src/features/editor/fileRead';
import type { LocalTarget } from '../../src/features/terminal/sessionTypes';
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
type Answers = Window['__fileTab']['answers'];
async function open(
  page: Page,
  files: Files,
  status: 'connected' | 'closed' = 'connected',
  answers: Answers = [],
) {
  await page.addInitScript(
    (value) => {
      window.__fileTab = value as typeof window.__fileTab;
    },
    { files, status, calls: [], opened: [], writes: [], answers } satisfies Window['__fileTab'],
  );
  await page.goto('/tests/ui/fixtures/file-tab.html');
  await expect(page.getByRole('tab', { name: '터미널' })).toBeVisible();
}
const state = (page: Page) => page.evaluate(() => window.__fileTab);
const row = (page: Page, name: string) => page.locator(`[data-file-name="${name}"]`);
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const editor = (page: Page) => page.locator('.editor-host .view-lines:visible').first();
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

  test('a click on a folder row opens it, and a modifier only selects', async ({ page }) => {
    await open(page, { '/dir/': text('') });
    await row(page, 'dir/').click();
    expect((await state(page)).toggled).toEqual(['/dir/']);
    await row(page, 'dir/').click({ modifiers: ['ControlOrMeta'] });
    await row(page, 'dir/').click({ modifiers: ['Shift'] });
    expect((await state(page)).toggled).toEqual(['/dir/']);
    await page.getByRole('button', { name: '펼치기: dir/' }).click();
    expect((await state(page)).toggled).toEqual(['/dir/', '/dir/']);
  });

  test('a file shows its kind, a folder stays a folder', async ({ page }) => {
    await open(page, { '/a.ts': text(''), '/dir/': text('') });
    await expect(row(page, 'a.ts').locator('[data-file-type]')).toHaveAttribute(
      'data-file-type',
      'ts',
    );
    await expect(row(page, 'dir/').locator('[data-file-type]')).toHaveCount(0);
    // The name still takes the row's free space, not the icon.
    const icon = (await row(page, 'a.ts').locator('[data-file-type]').boundingBox())!;
    expect(icon.width).toBe(16);
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

test.describe('a document opened from the tools menu, with no terminal', () => {
  const note = 'C:\\문서\\한글 메모.txt';
  const noteName = '한글 메모.txt';
  const targets: LocalTarget[] = [
    { id: 'wsl:Ubuntu', name: 'Ubuntu', kind: 'wsl', follow: 'launch' },
    { id: 'powershell', name: 'Windows PowerShell', kind: 'shell', follow: 'launch' },
  ];
  type Picks = NonNullable<Window['__fileTab']['picks']>;

  async function openEmpty(page: Page, files: Files, picks: Picks, listed = targets) {
    await page.addInitScript(
      (value) => {
        window.__fileTab = value as typeof window.__fileTab;
      },
      {
        files,
        status: 'connected',
        calls: [],
        opened: [],
        writes: [],
        answers: [],
        noSession: true,
        picks,
        targets: listed,
        sources: [],
        failures: [],
      } satisfies Window['__fileTab'],
    );
    await page.goto('/tests/ui/fixtures/file-tab.html');
    await expect(tab(page, '시작하기')).toBeVisible();
  }
  const choose = async (page: Page) => {
    await page.getByText('도구', { exact: true }).click();
    await page.getByRole('button', { name: '문서 편집기', exact: true }).click();
  };

  test('the picked file opens pinned on the first shell of this PC, and saves', async ({
    page,
  }) => {
    await openEmpty(page, { [note]: text('메모 내용') }, [note]);
    await choose(page);
    await expect(tab(page, noteName)).toHaveCSS('font-style', 'normal');
    await expect(editor(page)).toContainText('메모');
    await expect(page.locator('.file-tab-banner')).toHaveCount(0);
    await expect(tab(page, '시작하기')).toBeVisible();

    await editor(page).click();
    await page.keyboard.type('추가');
    await expect(page.getByRole('tab', { name: `${noteName} 저장 안 됨` })).toBeVisible();
    await page.keyboard.press(modS);
    await expect(tab(page, noteName)).toBeVisible();
    const shell = { kind: 'local', targetId: 'powershell' };
    const after = await state(page);
    expect(after.calls.map((call) => call.path)).toEqual([note]);
    expect(after.sources).toEqual([shell, shell]);
    expect(after.writes).toHaveLength(1);
    expect(after.writes[0].path).toBe(note);
    expect(after.writes[0].content).toContain('추가');
  });

  test('closing an unsaved document asks first', async ({ page }) => {
    await openEmpty(page, { [note]: text('메모 내용') }, [note]);
    await choose(page);
    await expect(editor(page)).toContainText('메모');
    await editor(page).click();
    await page.keyboard.type('버림');
    const dirty = page.getByRole('tab', { name: `${noteName} 저장 안 됨` });
    await expect(dirty).toBeVisible();
    const closeTab = page.getByRole('button', { name: `${noteName} 탭 닫기` });
    const asked = page.getByRole('dialog', { name: `${noteName} 저장` });

    await closeTab.click();
    await asked.getByRole('button', { name: '취소', exact: true }).click();
    await expect(asked).toHaveCount(0);
    await expect(dirty).toBeVisible();

    await closeTab.click();
    await asked.getByRole('button', { name: '저장 안 함', exact: true }).click();
    await expect(dirty).toHaveCount(0);
    expect((await state(page)).writes).toHaveLength(0);
  });

  test('a closed picker opens nothing, and the same file keeps one tab', async ({ page }) => {
    await openEmpty(page, { [note]: text('메모 내용') }, [null, note, note]);
    await choose(page);
    await expect.poll(async () => (await state(page)).picks).toEqual([note, note]);
    await expect(page.locator('.file-tab')).toHaveCount(0);

    await choose(page);
    await expect(tab(page, noteName)).toBeVisible();
    await choose(page);
    await expect.poll(async () => (await state(page)).picks).toEqual([]);
    await expect(tab(page, noteName)).toHaveCount(1);
    expect((await state(page)).failures).toEqual([]);
  });

  test('a decomposed Korean name reads composed, and the real path is kept', async ({ page }) => {
    const decomposed = `/Users/me/${'한글.txt'.normalize('NFD')}`;
    await openEmpty(page, { [decomposed]: text('메모') }, [decomposed]);
    await choose(page);
    await expect(tab(page, '한글.txt')).toBeVisible();
    expect((await state(page)).calls[0].path).toBe(decomposed);
  });

  test('without a shell of this PC it says so and opens nothing', async ({ page }) => {
    await openEmpty(page, { [note]: text('메모') }, [note], [targets[0]]);
    await choose(page);
    await expect
      .poll(async () => (await state(page)).failures)
      .toEqual(['이 PC의 로컬 셸을 찾지 못해 파일을 열 수 없습니다.']);
    await expect(page.locator('.file-tab')).toHaveCount(0);
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

const dirtyTab = (page: Page, name: string) =>
  page.getByRole('tab', { name: `${name} 저장 안 됨` });
// The fixture page is Chromium on every OS, where the app takes Ctrl as well as Cmd.
const modS = 'Control+s';
const modShiftS = 'Control+Shift+s';
// Undo is the editor's own binding, which takes only Cmd on macOS.
const undo = 'ControlOrMeta+z';

/** Clicks into the editor, types at the very end of the text and waits for the unsaved mark. */
async function typeAtEnd(page: Page, value: string) {
  await editor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(value);
}
const closeButton = (page: Page, name: string) =>
  page.getByRole('button', { name: `${name} 탭 닫기` });

test.describe('editing and saving', () => {
  const files: Files = { '/a.txt': text('내용') };

  test('an edit marks the tab and pins a preview', async ({ page }) => {
    await open(page, files);
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await expect(dirtyTab(page, 'a.txt')).toBeVisible();
    await expect(dirtyTab(page, 'a.txt')).toHaveCSS('font-style', 'normal');
  });

  test('undoing every edit clears the mark', async ({ page }) => {
    await open(page, files);
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await expect(dirtyTab(page, 'a.txt')).toBeVisible();
    await page.keyboard.press(undo);
    await expect(tab(page, 'a.txt')).toBeVisible();
  });

  test('saving writes the text with the hash it read, then the hash it wrote', async ({ page }) => {
    await open(page, files);
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await page.keyboard.press(modS);
    await expect(tab(page, 'a.txt')).toBeVisible();
    await typeAtEnd(page, 'y');
    await page.keyboard.press(modS);
    await expect.poll(async () => (await state(page)).writes.length).toBe(2);
    const writes = (await state(page)).writes;
    expect(writes[0]).toMatchObject({
      path: '/a.txt',
      content: '내용x',
      encoding: 'utf-8',
      baseHash: 'a'.repeat(64) + 2,
    });
    expect(writes[1]).toMatchObject({ content: '내용xy', baseHash: 'saved-1' });
    await expect(tab(page, 'a.txt')).toBeVisible();
  });

  test('a save with nothing changed writes nothing', async ({ page }) => {
    await open(page, files);
    await row(page, 'a.txt').click();
    await editor(page).click();
    await page.keyboard.press(modS);
    await page.waitForTimeout(200);
    expect((await state(page)).writes).toHaveLength(0);
  });

  test('the file encoding goes with the write', async ({ page }) => {
    await open(page, { '/a.txt': text('한글', { encoding: 'euc-kr' }) });
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await page.keyboard.press(modS);
    await expect.poll(async () => (await state(page)).writes.length).toBe(1);
    expect((await state(page)).writes[0].encoding).toBe('euc-kr');
  });

  test('a failed save says why and keeps the edits', async ({ page }) => {
    await open(page, files, 'connected', [{ fail: '저장 공간이 부족합니다.' }]);
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await page.keyboard.press(modS);
    await expect(banner(page)).toContainText('저장 공간이 부족합니다.');
    await expect(dirtyTab(page, 'a.txt')).toBeVisible();
  });

  test('read-only files never reach the backend', async ({ page }) => {
    await open(page, {
      '/broken.txt': text('깨\uFFFD', { lossy: true }),
      '/big.log': text('큰 내용', { large: true }),
    });
    for (const name of ['broken.txt', 'big.log']) {
      await row(page, name).click();
      await editor(page).click();
      await page.keyboard.type('x');
      await page.keyboard.press(modS);
      await expect(editor(page)).not.toContainText('x', { timeout: 500 });
    }
    expect((await state(page)).writes).toHaveLength(0);
  });

  test('an ended connection blocks saving', async ({ page }) => {
    await open(page, files, 'closed');
    await row(page, 'a.txt').click();
    await editor(page).click();
    await page.keyboard.type('x');
    await page.keyboard.press(modS);
    await page.waitForTimeout(200);
    expect((await state(page)).writes).toHaveLength(0);
  });

  test('line ending and indent can be changed from the status bar', async ({ page }) => {
    await open(page, { '/a.txt': text('a\n    b\n') });
    await row(page, 'a.txt').click();
    await expect(status(page)).toContainText('공백 4');
    await status(page).getByRole('button', { name: 'LF' }).click();
    await page.getByRole('menuitem', { name: 'CRLF' }).click();
    await expect(status(page)).toContainText('CRLF');
    await expect(dirtyTab(page, 'a.txt')).toBeVisible();
    await status(page).getByRole('button', { name: '공백 4' }).click();
    await page.getByRole('menuitem', { name: '공백 2' }).click();
    await expect(status(page)).toContainText('공백 2');
    await editor(page).click();
    await page.keyboard.press(modS);
    await expect.poll(async () => (await state(page)).writes.length).toBe(1);
    expect((await state(page)).writes[0].content).toBe('a\r\n  b\r\n');
  });

  test('a Markdown edit survives the preview', async ({ page }) => {
    await open(page, { '/a.md': text('# 제목\n') });
    await row(page, 'a.md').click();
    await expect(page.getByRole('heading', { name: '제목' })).toBeVisible();
    await page.getByRole('button', { name: '원문' }).click();
    await typeAtEnd(page, '본문 추가');
    await page.getByRole('button', { name: '미리보기' }).click();
    await expect(page.locator('.markdown-preview').getByText('본문 추가')).toBeVisible();
    await page.getByRole('button', { name: '원문' }).click();
    await expect(editor(page)).toContainText('본문 추가');
  });
});

test.describe('save conflicts', () => {
  const files: Files = { '/a.txt': text('내용') };
  const card = (page: Page) => page.getByRole('alertdialog', { name: '저장 충돌' });

  test('a changed file shows the card and overwriting names the version warned about', async ({
    page,
  }) => {
    await open(page, files, 'connected', [{ status: 'conflict', hash: 'theirs' }]);
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await page.keyboard.press(modS);
    await expect(card(page)).toContainText('내용이 바뀌어 저장하지 않았습니다');
    await expect(dirtyTab(page, 'a.txt')).toBeVisible();
    await card(page).getByRole('button', { name: '덮어쓰기' }).click();
    // The default answer to overwriting is no.
    const confirm = page.getByRole('dialog', { name: '파일을 덮어씁니다' });
    await expect(confirm.getByRole('button', { name: '취소' })).toBeFocused();
    await confirm.getByRole('button', { name: '덮어쓰기' }).click();
    await expect(card(page)).toHaveCount(0);
    await expect(tab(page, 'a.txt')).toBeVisible();
    const writes = (await state(page)).writes;
    expect(writes).toHaveLength(2);
    expect(writes[1].baseHash).toBe('theirs');
  });

  test('the server version can be compared', async ({ page }) => {
    await open(page, files, 'connected', [{ status: 'conflict', hash: 'theirs' }]);
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await page.keyboard.press(modS);
    await card(page).getByRole('button', { name: '서버 내용 보기' }).click();
    await expect(page.getByText('서버 내용', { exact: true })).toBeVisible();
    await expect(page.locator('.editor-host .view-lines').nth(1)).toContainText('내용x');
    await card(page).getByRole('button', { name: '비교 닫기' }).click();
    await expect(editor(page)).toContainText('내용x');
  });

  test('canceling keeps the edits and writes nothing more', async ({ page }) => {
    await open(page, files, 'connected', [{ status: 'conflict', hash: 'theirs' }]);
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await page.keyboard.press(modS);
    await card(page).getByRole('button', { name: '취소' }).click();
    await expect(card(page)).toHaveCount(0);
    await expect(dirtyTab(page, 'a.txt')).toBeVisible();
    expect((await state(page)).writes).toHaveLength(1);
  });

  test('a vanished file offers to create it again', async ({ page }) => {
    await open(page, files, 'connected', [{ status: 'conflict', hash: null }]);
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await page.keyboard.press(modS);
    await expect(card(page)).toContainText('사라져');
    await card(page).getByRole('button', { name: '다시 만들기' }).click();
    await page
      .getByRole('dialog', { name: '파일을 덮어씁니다' })
      .getByRole('button', { name: '다시 만들기' })
      .click();
    await expect.poll(async () => (await state(page)).writes.length).toBe(2);
    expect((await state(page)).writes[1].baseHash).toBeNull();
  });
});

test.describe('save as', () => {
  test('the tab moves to the new file without reading it again', async ({ page }) => {
    await open(page, { '/a.txt': text('내용') });
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await page.keyboard.press(modS);
    await expect(tab(page, 'a.txt')).toBeVisible();
    const reads = (await state(page)).calls.length;
    await page.keyboard.press(modShiftS);
    const dialog = page.getByRole('dialog', { name: '다른 이름으로 저장' });
    await dialog.getByLabel('저장할 경로').fill('/copy.txt');
    await dialog.getByRole('button', { name: '저장' }).click();
    await expect(tab(page, 'copy.txt')).toBeVisible();
    await expect(tab(page, 'a.txt')).toHaveCount(0);
    const current = await state(page);
    expect(current.writes.at(-1)).toMatchObject({ path: '/copy.txt', baseHash: null });
    expect(current.calls).toHaveLength(reads);
    await expect(editor(page)).toContainText('내용x');
  });

  test('a taken name asks before replacing it', async ({ page }) => {
    await open(page, { '/a.txt': text('내용') }, 'connected', [
      { status: 'conflict', hash: 'other' },
    ]);
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await page.keyboard.press(modShiftS);
    const dialog = page.getByRole('dialog', { name: '다른 이름으로 저장' });
    await dialog.getByLabel('저장할 경로').fill('/taken.txt');
    await dialog.getByRole('button', { name: '저장' }).click();
    await expect(page.getByRole('alertdialog', { name: '저장 충돌' })).toContainText('이미 있어');
    await expect(tab(page, 'a.txt')).toHaveCount(0);
    await expect(dirtyTab(page, 'a.txt')).toBeVisible();
    await page.getByRole('button', { name: '덮어쓰기' }).click();
    await page
      .getByRole('dialog', { name: '파일을 덮어씁니다' })
      .getByRole('button', { name: '덮어쓰기' })
      .click();
    await expect(tab(page, 'taken.txt')).toBeVisible();
    expect((await state(page)).writes[1]).toMatchObject({ path: '/taken.txt', baseHash: 'other' });
  });
});

test.describe('closing with unsaved edits', () => {
  const files: Files = { '/a.txt': text('내용'), '/b.txt': text('둘째') };
  const dialog = (page: Page) => page.getByRole('dialog', { name: 'a.txt 저장' });

  test('a clean tab closes without asking', async ({ page }) => {
    await open(page, files);
    await row(page, 'a.txt').dblclick();
    await expect(editor(page)).toContainText('내용');
    await closeButton(page, 'a.txt').click();
    await expect(tab(page, 'a.txt')).toHaveCount(0);
  });

  test('cancel keeps the tab and the edits, and is the default', async ({ page }) => {
    await open(page, files);
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await closeButton(page, 'a.txt').click();
    await expect(dialog(page).getByRole('button', { name: '취소' })).toBeFocused();
    await dialog(page).getByRole('button', { name: '취소' }).click();
    await expect(dirtyTab(page, 'a.txt')).toBeVisible();
    await expect(editor(page)).toContainText('내용x');
  });

  test('do not save closes the tab without writing', async ({ page }) => {
    await open(page, files);
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await closeButton(page, 'a.txt').click();
    await dialog(page).getByRole('button', { name: '저장 안 함' }).click();
    await expect(dirtyTab(page, 'a.txt')).toHaveCount(0);
    expect((await state(page)).writes).toHaveLength(0);
  });

  test('save writes and then closes', async ({ page }) => {
    await open(page, files);
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await closeButton(page, 'a.txt').click();
    await dialog(page).getByRole('button', { name: '저장', exact: true }).click();
    await expect(dirtyTab(page, 'a.txt')).toHaveCount(0);
    expect((await state(page)).writes[0].content).toBe('내용x');
  });

  test('a save that hits a conflict keeps the tab open with the card', async ({ page }) => {
    await open(page, files, 'connected', [{ status: 'conflict', hash: 'theirs' }]);
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await closeButton(page, 'a.txt').click();
    await dialog(page).getByRole('button', { name: '저장', exact: true }).click();
    await expect(page.getByRole('alertdialog', { name: '저장 충돌' })).toBeVisible();
    await expect(dirtyTab(page, 'a.txt')).toBeVisible();
  });

  test('an unsaved file on an ended connection can only be discarded', async ({ page }) => {
    await open(page, { '/a.txt': text('내용') }, 'connected');
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await page.evaluate(() => window.__fileTabEnd?.());
    await closeButton(page, 'a.txt').click();
    await expect(dialog(page).getByRole('button', { name: '저장', exact: true })).toBeDisabled();
    await expect(dialog(page).getByRole('button', { name: '저장 안 함' })).toBeEnabled();
  });

  test('the window asks once for every unsaved file and answers yes only when settled', async ({
    page,
  }) => {
    await open(page, files);
    await row(page, 'a.txt').dblclick();
    await typeAtEnd(page, 'x');
    await row(page, 'b.txt').dblclick();
    await expect(page.locator('.pane-cell:not([hidden]) .view-lines')).toContainText('둘째');
    await typeAtEnd(page, 'y');
    const answered = page.evaluate(() => window.__fileTab.closeWindow!());
    const asked = page.getByRole('dialog', { name: '저장 안 된 파일 2개' });
    await expect(asked).toBeVisible();
    await asked.getByRole('button', { name: '취소' }).click();
    expect(await answered).toBe(false);
    await expect(dirtyTab(page, 'a.txt')).toBeVisible();

    const again = page.evaluate(() => window.__fileTab.closeWindow!());
    await asked.getByRole('button', { name: '저장', exact: true }).click();
    expect(await again).toBe(true);
    expect((await state(page)).writes).toHaveLength(2);
  });

  test('a window with nothing unsaved closes without asking', async ({ page }) => {
    await open(page, files);
    await row(page, 'a.txt').click();
    await expect(editor(page)).toContainText('내용');
    expect(await page.evaluate(() => window.__fileTab.closeWindow!())).toBe(true);
  });

  test('reading again asks before losing edits', async ({ page }) => {
    await open(page, {
      '/a.txt': text('한글', { encoding: 'utf-8' }),
      '/a.txt|euc-kr': text('다른 내용', { encoding: 'euc-kr' }),
    });
    await row(page, 'a.txt').click();
    await typeAtEnd(page, 'x');
    await status(page).getByRole('button', { name: 'UTF-8' }).click();
    await page.getByRole('menuitem', { name: 'CP949 / EUC-KR' }).click();
    const asked = page.getByRole('dialog', { name: '저장 안 한 내용을 버립니다' });
    await asked.getByRole('button', { name: '취소' }).click();
    await expect(editor(page)).toContainText('한글x');
    await status(page).getByRole('button', { name: 'UTF-8' }).click();
    await page.getByRole('menuitem', { name: 'CP949 / EUC-KR' }).click();
    await asked.getByRole('button', { name: '버리고 다시 읽기' }).click();
    await expect(editor(page)).toContainText('다른 내용');
    await expect(tab(page, 'a.txt')).toBeVisible();
  });
});
