import { expect, test, type Page } from '@playwright/test';
import type { GitViewEntry, GitViewResult } from '../../src/features/git/gitViewModel';
import type {} from './fixtures/git-view';

const entry = (path: string, over: Partial<GitViewEntry>): GitViewEntry => ({
  path,
  oldPath: null,
  index: null,
  worktree: null,
  readable: true,
  ...over,
});
const repo: GitViewResult = {
  kind: 'repo',
  root: '/srv/app',
  branch: 'main',
  oid: 'abc',
  upstream: 'origin/main',
  ahead: 2,
  behind: 1,
  truncated: false,
  entries: [
    entry('src/both.ts', { index: 'modified', worktree: 'modified' }),
    entry('src/app/new.ts', { index: 'added' }),
    entry('README.md', { worktree: 'deleted' }),
    entry('notes/메모.txt', { worktree: 'untracked' }),
    entry('merge.txt', { index: 'conflict', worktree: 'conflict' }),
  ],
};

type Setup = Partial<Omit<Window['__gitView'], 'calls' | 'reviewed'>>;
async function open(page: Page, setup: Setup = {}) {
  await page.addInitScript(
    (value) => {
      window.__gitView = value as typeof window.__gitView;
    },
    {
      result: repo,
      tab: 'ssh',
      status: 'connected',
      directory: '/srv/app/src',
      reviewable: true,
      reviewed: 0,
      calls: [],
      ...setup,
    } satisfies Window['__gitView'],
  );
  await page.goto('/tests/ui/fixtures/git-view.html');
}
const state = (page: Page) => page.evaluate(() => window.__gitView);
const group = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test('shows the branch and the changed files by group, asking once for the tab folder', async ({
  page,
}) => {
  await open(page);
  await expect(page.locator('.git-view-branch')).toContainText('main');
  await expect(page.locator('.git-view-sync')).toHaveText('↑2 ↓1');
  await expect(page.locator('.git-group-head')).toHaveText([
    /스테이지됨\s*2/,
    /변경\s*2/,
    /추적 안 함\s*1/,
    /충돌\s*1/,
  ]);
  // A file changed on both sides is listed in both groups, with its own letter.
  await expect(group(page, '스테이지됨').locator('.git-row')).toContainText(['both.ts', 'new.ts']);
  await expect(group(page, '스테이지됨').locator('.git-row-mark')).toHaveText(['M', 'A']);
  await expect(group(page, '변경').locator('.git-row-mark')).toHaveText(['M', 'D']);
  await expect(group(page, '추적 안 함').locator('.git-row-mark')).toHaveText(['?']);
  await expect(group(page, '충돌').locator('.git-row-mark')).toHaveText(['U']);
  await expect(group(page, '스테이지됨').locator('.git-row-folder').first()).toHaveText('src');

  const queries = (await state(page)).calls.filter((c) => c.command === 'git_view');
  expect(queries).toEqual([
    {
      command: 'git_view',
      args: { source: { kind: 'ssh', connectionId: 'c1' }, folder: '/srv/app/src' },
    },
  ]);
});

test('a WSL tab asks with its target, and a change review is only offered where it exists', async ({
  page,
}) => {
  await open(page, { tab: 'local', directory: '/home/a', reviewable: false });
  await expect(page.locator('.git-row').first()).toBeVisible();
  const query = (await state(page)).calls.find((c) => c.command === 'git_view');
  expect(query?.args.source).toEqual({ kind: 'local', targetId: 'wsl:U' });
  await page.getByRole('button', { name: 'Git 더 보기' }).click();
  await expect(page.getByRole('menuitem', { name: '변경 검토' })).toHaveCount(0);
});

test('the more menu refreshes, opens the review, and switches to folders', async ({ page }) => {
  await open(page);
  await expect(page.locator('.git-row').first()).toBeVisible();
  const more = page.getByRole('button', { name: 'Git 더 보기' });

  await more.click();
  await page.getByRole('menuitem', { name: '변경 검토' }).click();
  expect((await state(page)).reviewed).toBe(1);

  await more.click();
  await page.getByRole('menuitem', { name: '새로 고침' }).click();
  await expect
    .poll(async () => (await state(page)).calls.filter((c) => c.command === 'git_view').length)
    .toBe(2);

  await more.click();
  await page.getByRole('menuitem', { name: '폴더로 묶어 보기' }).click();
  const staged = group(page, '스테이지됨');
  await expect(staged.locator('.git-row-folder-row').first()).toHaveText('src');
  await expect(staged.locator('.git-row-name')).toHaveText(['src', 'app', 'new.ts', 'both.ts']);
  await staged.locator('.git-row-folder-row').first().click();
  await expect(staged.locator('.git-row-name')).toHaveText(['src']);

  // The layout is remembered.
  await page.reload();
  await expect(group(page, '변경').locator('.git-row-name')).toContainText(['README.md']);
  await expect(group(page, '스테이지됨').locator('.git-row-folder-row').first()).toHaveText('src');
});

test('a group folds and a row copies its full path from the right-click menu', async ({ page }) => {
  await open(page);
  await group(page, '변경').getByRole('button', { name: /변경/ }).click();
  await expect(group(page, '변경').locator('.git-row')).toHaveCount(0);

  await group(page, '추적 안 함').locator('.git-row').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '경로 복사' }).click();
  await expect
    .poll(async () => (await state(page)).calls.find((c) => c.command === 'clipboard_write_text'))
    .toEqual({
      command: 'clipboard_write_text',
      args: { text: '/srv/app/notes/메모.txt' },
    });
});

test('explains every state that has no list', async ({ page, browser }) => {
  await open(page, { result: { kind: 'notRepo', detail: '' } });
  await expect(page.getByText('Git 저장소가 아닙니다')).toBeVisible();
  await expect(page.locator('.git-row')).toHaveCount(0);

  const cases: [Setup, string][] = [
    [{ result: { kind: 'noGit', detail: '서버에 git이 없습니다.' } }, '서버에 git이 없습니다.'],
    [{ result: { ...repo, entries: [] } as GitViewResult }, '변경 사항이 없습니다'],
    [{ result: { kind: 'stopped', reason: 'tooLarge' } }, '변경이 너무 많아'],
    [{ tab: 'ftp' }, 'FTP 연결에서는 Git을 쓸 수 없습니다'],
    [{ tab: 'none' }, '연 탭이 없습니다'],
    [{ status: 'closed' }, '연결되면 Git 상태를 표시합니다'],
    [{ directory: null }, '폴더를 아직 모릅니다'],
  ];
  for (const [setup, text] of cases) {
    const context = await browser.newContext();
    const other = await context.newPage();
    await open(other, setup);
    await expect(other.getByText(text)).toBeVisible();
    await context.close();
  }
});

test('a stopped or missing Git can be asked again', async ({ page }) => {
  await open(page, { result: { kind: 'noGit', detail: '서버에 git이 없습니다.' } });
  await expect(page.getByRole('button', { name: '설정 → Git', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '다시 조회' }).click();
  await expect
    .poll(async () => (await state(page)).calls.filter((c) => c.command === 'git_view').length)
    .toBe(2);
});
