import { expect, test, type Page } from '@playwright/test';
import type { GitRepo } from '../../src/features/git/gitStatus';
import type {} from './fixtures/status-bar';

const repo = (patch: Partial<GitRepo> = {}): GitRepo => ({
  kind: 'repo',
  root: '/srv/app',
  branch: 'main',
  oid: 'abcdef0123456789',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  entries: [],
  truncated: false,
  ...patch,
});
const changed = repo({
  entries: [
    { path: 'a.txt', mark: 'M' },
    { path: 'b.txt', mark: '?' },
  ],
});

type Options = Partial<Window['__statusBar']> & { auto?: boolean };

/** Opens the bar with the shell already in a folder, so the first query has run. */
async function open(page: Page, { auto = true, ...options }: Options = {}) {
  const value = { git: changed, detached: false, file: false, queries: 0, opened: 0, ...options };
  await page.addInitScript(
    ([bar, gitStatus]) => {
      window.__statusBar = bar as typeof window.__statusBar;
      localStorage.setItem('dachsterm.terminalPreferences', JSON.stringify({ gitStatus }));
    },
    [value, auto] as const,
  );
  await page.goto('/tests/ui/fixtures/status-bar.html');
  await expect(page.getByRole('contentinfo', { name: '작업 상태' })).toBeVisible();
  await page.evaluate(() => window.__cd('/srv/app'));
}
const item = (page: Page) => page.locator('.status-bar .status-git');
const state = (page: Page) => page.evaluate(() => window.__statusBar);
const setGit = (page: Page, git: GitRepo) =>
  page.evaluate((value) => {
    window.__statusBar.git = value;
  }, git);

test.describe('the Git item', () => {
  test('has a branch icon even when nothing changed', async ({ page }) => {
    await open(page, { git: repo() });
    await expect(item(page)).toHaveText('main');
    await expect(item(page).locator('svg')).toBeVisible();
    await expect(item(page)).toHaveAttribute('aria-label', 'Git main, 변경 없음. Git 보기 열기');
  });

  test('a click opens the Git view and asks again', async ({ page }) => {
    await open(page);
    await expect(item(page)).toHaveText('main ●2');
    await expect(item(page)).toHaveAttribute('title', /클릭하면 Git 보기를 엽니다/);
    await setGit(page, repo());
    await item(page).click();
    await expect(item(page)).toHaveText('main');
    expect((await state(page)).opened).toBe(1);
  });

  test('with automatic queries off, a click is still how the item updates', async ({ page }) => {
    await open(page, { auto: false });
    await expect(item(page)).toHaveText('Git');
    await expect(item(page).locator('svg')).toBeVisible();
    expect((await state(page)).queries).toBe(0);
    // Asking once is all this button promises: nothing is known about the folder yet.
    await item(page).click();
    await expect(item(page)).toHaveText('main ●2');
    expect((await state(page)).opened).toBe(0);
    await setGit(page, repo());
    await item(page).click();
    await expect(item(page)).toHaveText('main');
    expect((await state(page)).opened).toBe(1);
  });

  test('a detached window has no Git view, so a click only refreshes', async ({ page }) => {
    await open(page, { detached: true });
    await expect(item(page)).toHaveText('main ●2');
    await expect(item(page)).toHaveAttribute('aria-label', 'Git main, 변경 2개. 새로 고침');
    await expect(item(page)).toHaveAttribute('title', /클릭하면 새로 고칩니다/);
    await setGit(page, repo());
    await item(page).click();
    await expect(item(page)).toHaveText('main');
    expect((await state(page)).opened).toBe(0);
  });

  test('a stopped query retries instead of opening the view', async ({ page }) => {
    await open(page, { git: { kind: 'stopped', reason: 'timeout' } });
    await expect(item(page)).toHaveText('Git 조회 멈춤');
    await expect(item(page).locator('svg')).toBeVisible();
    await setGit(page, changed);
    await item(page).click();
    await expect(item(page)).toHaveText('main ●2');
    expect((await state(page)).opened).toBe(0);
  });
});

test.describe('the file tab facts', () => {
  const facts = (page: Page) => page.locator('.status-right').getByLabel('파일 정보');

  test('sit on the right with encoding, line ending, indentation and language', async ({
    page,
  }) => {
    await open(page, { file: true });
    await expect(facts(page).locator('.status-tag')).toHaveText([
      'UTF-8',
      'CRLF',
      '공백 2',
      'typescript',
    ]);
  });

  test('the encoding button matches the labels beside it', async ({ page }) => {
    await open(page, { file: true });
    const look = (name: string) =>
      facts(page)
        .getByText(name, { exact: true })
        .evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            fontSize: style.fontSize,
            padding: style.paddingLeft,
            background: style.backgroundColor,
            color: style.color,
            height: node.getBoundingClientRect().height,
          };
        });
    expect(await look('UTF-8')).toEqual(await look('CRLF'));
  });

  test('are absent without a file tab', async ({ page }) => {
    await open(page);
    await expect(item(page)).toHaveText('main ●2');
    await expect(facts(page)).toHaveCount(0);
  });

  for (const width of [1280, 800, 640]) {
    test(`stay inside a ${width}px window next to the monitor`, async ({ page }) => {
      await page.setViewportSize({ width, height: 400 });
      await open(page, { file: true });
      await expect(facts(page)).toBeVisible();
      await expect(page.locator('.status-bar .monitor')).toBeVisible();
      const overflow = await page.evaluate(() => {
        const bar = document.querySelector('.status-bar')!.getBoundingClientRect();
        const right = document.querySelector('.status-right')!.getBoundingClientRect();
        return {
          page: document.documentElement.scrollWidth - window.innerWidth,
          bar: bar.right - window.innerWidth,
          right: right.right - bar.right,
          left: bar.left - right.left,
        };
      });
      expect(overflow.page).toBeLessThanOrEqual(0);
      expect(overflow.bar).toBeLessThanOrEqual(0);
      expect(overflow.right).toBeLessThanOrEqual(0);
      expect(overflow.left).toBeLessThanOrEqual(0);
    });
  }
});
