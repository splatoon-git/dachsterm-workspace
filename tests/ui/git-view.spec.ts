import { expect, test, type Page } from '@playwright/test';
import type { GitViewEntry, GitViewResult } from '../../src/features/git/gitViewModel';
import type { CommitDetail, GitGraphResult } from '../../src/features/git/commitGraphModel';
import type {} from './fixtures/git-view';

const hash = (letter: string) => letter.repeat(40);
const graph: GitGraphResult = {
  kind: 'graph',
  hasMore: false,
  commits: [
    {
      hash: hash('a'),
      parents: [hash('b'), hash('c')],
      author: '작성자',
      time: 1700000000,
      subject: 'merge feature',
      refs: [
        { kind: 'branch', name: 'main', current: true },
        { kind: 'remote', name: 'origin/main', current: false },
        { kind: 'tag', name: 'v1', current: false },
        { kind: 'tag', name: 'v2', current: false },
      ],
    },
    { hash: hash('c'), parents: [hash('b')], author: 'x', time: 1, subject: 'feature', refs: [] },
    { hash: hash('b'), parents: [], author: 'x', time: 1, subject: 'root', refs: [] },
  ],
};
const detail: CommitDetail = {
  hash: hash('a'),
  parents: [hash('b'), hash('c')],
  author: '작성자',
  time: 1700000000,
  message: 'merge feature\n\n본문 줄',
  truncated: false,
  files: [
    {
      path: 'src/new name.ts',
      oldPath: 'src/old.ts',
      change: 'renamed',
      added: null,
      removed: null,
      binary: false,
      readable: true,
    },
  ],
};

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
      graph,
      detail,
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
  await expect(page.locator('.git-groups .git-group-head')).toHaveText([
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

const graphCalls = async (page: Page) =>
  (await state(page)).calls.filter((c) => c.command === 'git_graph');
const row = (page: Page, subject: string) =>
  page.locator('.git-graph-row').filter({ has: page.getByText(subject, { exact: true }) });

test('the graph lists the history for the tab and draws its lanes', async ({ page }) => {
  await open(page);
  await expect(page.locator('.git-graph-subject')).toHaveText(['merge feature', 'feature', 'root']);
  await expect(row(page, 'merge feature').locator('.git-graph-ref')).toHaveText([
    'main',
    'origin/main',
    'v1',
    '+1',
  ]);
  // The two lanes of the merge: a row is as wide as the widest one.
  await expect(row(page, 'merge feature').locator('.git-graph-dot')).toHaveAttribute(
    'data-merge',
    'true',
  );
  await expect(row(page, 'root').locator('svg')).toHaveAttribute('width', '24');
  expect(await graphCalls(page)).toEqual([
    {
      command: 'git_graph',
      args: { source: { kind: 'ssh', connectionId: 'c1' }, folder: '/srv/app', limit: 100 },
    },
  ]);
});

test('after a reconnect the graph asks with the new connection', async ({ page }) => {
  await open(page);
  await expect(page.locator('.git-graph-row').first()).toBeVisible();
  await page.evaluate(() => window.__gitReconnect());
  await expect
    .poll(async () => (await graphCalls(page)).at(-1)?.args.source)
    .toEqual({ kind: 'ssh', connectionId: 'c2' });
});

test('a WSL tab asks for the graph with its target', async ({ page }) => {
  await open(page, { tab: 'local', directory: '/home/a' });
  await expect(page.locator('.git-graph-subject').first()).toBeVisible();
  expect((await graphCalls(page))[0]?.args.source).toEqual({ kind: 'local', targetId: 'wsl:U' });
});

test('clicking a commit opens its detail once and the header refresh asks again', async ({
  page,
}) => {
  await open(page);
  await row(page, 'merge feature').click();
  const opened = page.locator('.git-graph-detail');
  await expect(opened).toContainText(hash('a'));
  await expect(opened).toContainText('작성자');
  await expect(opened.locator('.git-graph-message')).toHaveText('merge feature\n\n본문 줄');
  await expect(opened.locator('.git-row-name')).toHaveText('new name.ts');
  await expect(opened.locator('.git-row-mark')).toHaveText('R');
  await expect(row(page, 'merge feature')).toHaveAttribute('aria-expanded', 'true');
  const detailCalls = async () =>
    (await state(page)).calls.filter((c) => c.command === 'git_commit_detail');
  expect((await detailCalls())[0]?.args).toEqual({
    source: { kind: 'ssh', connectionId: 'c1' },
    folder: '/srv/app',
    hash: hash('a'),
  });

  // One commit opens at a time, and a detail already read is not asked for again.
  await row(page, 'feature').click();
  await expect(row(page, 'merge feature')).toHaveAttribute('aria-expanded', 'false');
  await row(page, 'merge feature').click();
  await expect(opened).toContainText(hash('a'));
  expect((await detailCalls()).filter((c) => c.args.hash === hash('a'))).toHaveLength(1);
  await row(page, 'merge feature').click();
  await expect(opened).toHaveCount(0);

  await page.getByRole('button', { name: 'Git 새로 고침' }).click();
  await expect.poll(async () => (await graphCalls(page)).length).toBe(2);
});

test('a commit copies its hash and subject, and the keyboard opens it', async ({ page }) => {
  await open(page);
  await row(page, 'root').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '해시 복사' }).click();
  await expect
    .poll(async () => (await state(page)).calls.find((c) => c.command === 'clipboard_write_text'))
    .toEqual({ command: 'clipboard_write_text', args: { text: hash('b') } });
  // No menu item changes the repository.
  await row(page, 'root').click({ button: 'right' });
  await expect(page.getByRole('menuitem')).toHaveText(['해시 복사', '제목 복사']);
  await page.keyboard.press('Escape');

  await row(page, 'merge feature').focus();
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'feature')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.git-graph-detail')).toBeVisible();
});

test('a failed detail says why and is asked for again on the next open', async ({ page }) => {
  await open(page, { detail: '커밋을 읽을 수 없습니다.' });
  await row(page, 'root').click();
  await expect(page.locator('.git-graph-detail')).toContainText('커밋을 읽을 수 없습니다.');
  await row(page, 'root').click();
  await row(page, 'root').click();
  await expect
    .poll(async () => {
      const calls = (await state(page)).calls;
      return calls.filter((c) => c.command === 'git_commit_detail').length;
    })
    .toBe(2);
});

test('more history loads by a page and the limit is announced', async ({ page }) => {
  await open(page, { graph: { ...graph, hasMore: true } as GitGraphResult });
  await page.getByRole('button', { name: '더 불러오기' }).click();
  await expect.poll(async () => (await graphCalls(page)).at(-1)?.args.limit).toBe(200);

  for (let limit = 300; limit <= 1000; limit += 100) {
    await page.getByRole('button', { name: '더 불러오기' }).click();
    await expect.poll(async () => (await graphCalls(page)).at(-1)?.args.limit).toBe(limit);
  }
  await expect(page.getByRole('button', { name: '더 불러오기' })).toHaveCount(0);
  await expect(page.getByText('최근 1,000개까지만 표시합니다.')).toBeVisible();
});

test('a folded graph does not ask, and stays folded', async ({ page }) => {
  await open(page);
  await expect(page.locator('.git-graph-row').first()).toBeVisible();
  const head = page.getByRole('region', { name: '그래프' }).getByRole('button', { name: '그래프' });
  await head.click();
  await expect(page.locator('.git-graph-row')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.git-row').first()).toBeVisible();
  await expect(head).toHaveAttribute('aria-expanded', 'false');
  expect(await graphCalls(page)).toEqual([]);
  await head.click();
  await expect(page.locator('.git-graph-row').first()).toBeVisible();
});

test('the graph says why it has no commits', async ({ browser }) => {
  const cases: [GitGraphResult, string][] = [
    [{ kind: 'empty' }, '아직 커밋이 없습니다.'],
    [{ kind: 'stopped', reason: 'timeout' }, '이력이 길어 조회를 멈췄습니다.'],
    [{ kind: 'stopped', reason: 'tooLarge' }, '이력이 너무 커서 조회를 멈췄습니다.'],
    [{ kind: 'noGit', detail: '서버에 git이 없습니다.' }, '서버에 git이 없습니다.'],
  ];
  for (const [result, text] of cases) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await open(page, { graph: result });
    await expect(page.locator('.git-graph-body')).toContainText(text);
    await context.close();
  }
});

test('a stopped graph can be asked again', async ({ page }) => {
  await open(page, { graph: { kind: 'stopped', reason: 'timeout' } });
  await page.getByRole('button', { name: '다시 조회' }).click();
  await expect.poll(async () => (await graphCalls(page)).length).toBe(2);
});

test('a stopped or missing Git can be asked again', async ({ page }) => {
  await open(page, { result: { kind: 'noGit', detail: '서버에 git이 없습니다.' } });
  await expect(page.getByRole('button', { name: '설정 → Git', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '다시 조회' }).click();
  await expect
    .poll(async () => (await state(page)).calls.filter((c) => c.command === 'git_view').length)
    .toBe(2);
});
