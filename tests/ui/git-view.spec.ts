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
    {
      hash: hash('c'),
      parents: [hash('b')],
      author: 'x',
      time: 1,
      subject: 'feature',
      refs: [
        { kind: 'remote', name: 'origin/feat/side', current: false },
        { kind: 'branch', name: 'feat/side', current: false },
      ],
    },
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

type Setup = Partial<Omit<Window['__gitView'], 'calls' | 'reviewed' | 'sent' | 'opens'>>;
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
      buffer: 'normal',
      sent: [],
      opens: [],
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

test.describe('opening a changed file', () => {
  const rowOf = (page: Page, groupName: string, name: string) =>
    group(page, groupName).locator('.git-row', { hasText: name });
  const menuItems = (page: Page) => page.getByRole('menuitem').allTextContents();
  const opens = async (page: Page) => (await state(page)).opens;

  test('a click previews the diff and a double click keeps it', async ({ page }) => {
    await open(page);
    await rowOf(page, '변경', 'both.ts').click();
    expect(await opens(page)).toEqual([['diff:changes:src/both.ts', false]]);
    await rowOf(page, '스테이지됨', 'both.ts').dblclick();
    expect((await opens(page)).at(-1)).toEqual(['diff:staged:src/both.ts', true]);
  });

  test('Enter opens the focused row', async ({ page }) => {
    await open(page);
    await rowOf(page, '추적 안 함', '메모.txt').focus();
    await page.keyboard.press('Enter');
    expect(await opens(page)).toEqual([['diff:untracked:notes/메모.txt', false]]);
  });

  test('a conflict opens as a file, since it has no single other side', async ({ page }) => {
    await open(page);
    await rowOf(page, '충돌', 'merge.txt').click();
    expect(await opens(page)).toEqual([['file:/srv/app/merge.txt', false]]);
  });

  test('a name that is not UTF-8 opens nothing', async ({ page }) => {
    await open(page, {
      result: {
        ...repo,
        entries: [entry('a\ufffd.txt', { worktree: 'modified', readable: false })],
      },
    } as Setup);
    await page.locator('.git-row').click();
    expect(await opens(page)).toEqual([]);
  });

  test('the menu of a changed file', async ({ page }) => {
    await open(page);
    await rowOf(page, '변경', 'both.ts').click({ button: 'right' });
    expect(await menuItems(page)).toEqual([
      '파일 열기',
      'diff 열기',
      '스테이지',
      '변경 버리기…',
      '경로 복사',
      '외부 편집기로 열기',
    ]);
    await page.getByRole('menuitem', { name: '파일 열기' }).click();
    expect(await opens(page)).toEqual([['file:/srv/app/src/both.ts', true]]);

    await rowOf(page, '변경', 'both.ts').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'diff 열기' }).click();
    expect((await opens(page)).at(-1)).toEqual(['diff:changes:src/both.ts', true]);
  });

  test('the menu of a staged file unstages, and a conflict has no diff', async ({ page }) => {
    await open(page);
    await rowOf(page, '스테이지됨', 'both.ts').click({ button: 'right' });
    expect(await menuItems(page)).toContain('스테이지 취소');
    await page.keyboard.press('Escape');
    await rowOf(page, '충돌', 'merge.txt').click({ button: 'right' });
    expect(await menuItems(page)).not.toContain('diff 열기');
  });

  test('a deleted file has nothing to open, but its diff still shows', async ({ page }) => {
    await open(page);
    await rowOf(page, '변경', 'README.md').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: '파일 열기' })).toBeDisabled();
    await expect(page.getByRole('menuitem', { name: '외부 편집기로 열기' })).toBeDisabled();
    await expect(page.getByRole('menuitem', { name: 'diff 열기' })).toBeEnabled();
  });

  test('a server file opens in the external editor through an edit session', async ({ page }) => {
    await open(page);
    await rowOf(page, '변경', 'both.ts').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: '탐색기에서 보기' })).toHaveCount(0);
    await page.getByRole('menuitem', { name: '외부 편집기로 열기' }).click();
    await expect
      .poll(async () => (await state(page)).calls.find((c) => c.command === 'edit_start')?.args)
      .toMatchObject({
        id: 'c1',
        path: '/srv/app/src/both.ts',
        program: 'code',
        uploadMode: 'ask',
      });
  });

  test('a local file can be shown in the file manager and edited directly', async ({ page }) => {
    await open(page, { tab: 'local' });
    await rowOf(page, '변경', 'both.ts').click({ button: 'right' });
    await page.getByRole('menuitem', { name: '외부 편집기로 열기' }).click();
    await expect
      .poll(
        async () => (await state(page)).calls.find((c) => c.command === 'local_files_edit')?.args,
      )
      .toMatchObject({ targetId: 'wsl:U', path: '/srv/app/src/both.ts', program: 'code' });

    await rowOf(page, '변경', 'both.ts').click({ button: 'right' });
    await page.getByRole('menuitem', { name: /에서 보기/ }).click();
    await expect
      .poll(async () => (await state(page)).calls.find((c) => c.command === 'files_reveal')?.args)
      .toMatchObject({ path: '/srv/app/src/both.ts' });
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
  // A branch and its remote branch at the same commit share one pill; tags stay icons.
  const refs = row(page, 'merge feature').locator('.git-graph-ref');
  await expect(refs).toHaveText(['main', '', '']);
  await expect(refs.nth(0)).toHaveAttribute('title', '브랜치 main · 원격 브랜치 origin/main');
  await expect(refs.nth(1)).toHaveAttribute('title', '태그 v1');
  // A branch that is not checked out here, such as another worktree's, keeps its name too.
  const side = row(page, 'feature').locator('.git-graph-ref');
  await expect(side).toHaveText(['feat/side']);
  await expect(side).toHaveAttribute('title', '브랜치 feat/side · 원격 브랜치 origin/feat/side');
  await expect(side.locator('svg')).toHaveCount(2);
  // The two lanes of the merge: a row is as wide as the widest one.
  await expect(row(page, 'merge feature').locator('.git-graph-dot')).toHaveAttribute(
    'data-merge',
    'true',
  );
  await expect(row(page, 'root').locator('svg')).toHaveAttribute('width', '24');
  expect(await graphCalls(page)).toEqual([
    {
      command: 'git_graph',
      args: {
        source: { kind: 'ssh', connectionId: 'c1' },
        folder: '/srv/app',
        limit: 100,
        scope: 'auto',
      },
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

test('clicking a commit opens its files once and the header refresh asks again', async ({
  page,
}) => {
  await open(page);
  await row(page, 'merge feature').click();
  const opened = page.locator('.git-graph-detail');
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
  await expect(opened.locator('.git-row-name')).toHaveText('new name.ts');
  expect((await detailCalls()).filter((c) => c.args.hash === hash('a'))).toHaveLength(1);
  await row(page, 'merge feature').click();
  await expect(opened).toHaveCount(0);

  await page.getByRole('button', { name: 'Git 새로 고침' }).click();
  await expect.poll(async () => (await graphCalls(page)).length).toBe(2);
});

test('a commit file previews its diff in a tab, and a double click keeps it', async ({ page }) => {
  await open(page);
  await row(page, 'merge feature').click();
  const file = page.locator('.git-graph-detail .git-row');
  await file.click();
  const origin = `commit:${hash('a')}:${hash('b')}:src/new name.ts`;
  expect((await state(page)).opens).toEqual([[origin, false]]);
  await file.dblclick();
  expect((await state(page)).opens.at(-1)).toEqual([origin, true]);
  await file.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '경로 복사' }).click();
  await expect
    .poll(async () => (await state(page)).calls.find((c) => c.command === 'clipboard_write_text'))
    .toEqual({
      command: 'clipboard_write_text',
      args: { text: '/srv/app/src/new name.ts' },
    });
});

test('a file in a commit whose name is not UTF-8 opens nothing', async ({ page }) => {
  await open(page, {
    detail: { ...detail, files: [{ ...detail.files[0]!, readable: false }] },
  });
  await row(page, 'merge feature').click();
  await page.locator('.git-graph-detail .git-row').click();
  expect((await state(page)).opens).toEqual([]);
});

test('hovering a commit shows the whole message beside the row, once', async ({ page }) => {
  await open(page, {
    detail: {
      ...detail,
      message: 'merge feature\n\n본문 줄\n\nCo-Authored-By: 동료 <a@b>',
      files: [{ ...detail.files[0]!, added: 12, removed: 3 }],
    },
  });
  await row(page, 'merge feature').hover();
  const card = page.getByRole('group', { name: '커밋 정보' });
  await expect(card.locator('.git-commit-card-message')).toHaveText('merge feature\n\n본문 줄');
  await expect(card).toContainText('작성자');
  await expect(card).toContainText('동료');
  await expect(card.locator('.git-commit-card-stat')).toHaveText('파일 1개 변경 +12 −3');
  await expect(card.locator('.git-graph-ref')).toHaveCount(4);
  await expect(card.locator('code')).toHaveText(hash('a').slice(0, 7));

  const rowBox = (await row(page, 'merge feature').boundingBox())!;
  const cardBox = (await card.boundingBox())!;
  expect(cardBox.x).toBeGreaterThanOrEqual(rowBox.x + rowBox.width);

  // The pointer can reach the card, and the copy button in it.
  await card.getByRole('button', { name: '해시 복사' }).click();
  await expect
    .poll(async () => (await state(page)).calls.find((c) => c.command === 'clipboard_write_text'))
    .toEqual({ command: 'clipboard_write_text', args: { text: hash('a') } });

  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await row(page, 'merge feature').hover();
  await expect(card).toBeVisible();
  const calls = (await state(page)).calls.filter((c) => c.command === 'git_commit_detail');
  expect(calls).toHaveLength(1);
});

test('the graph toolbar runs the network commands and switches what it shows', async ({ page }) => {
  await open(page);
  await expect(page.locator('.git-graph-row').first()).toBeVisible();
  const tools = page.getByRole('toolbar', { name: '이력 작업' });
  const ask = page.getByRole('dialog', { name: '터미널에 입력' });
  for (const [name, line] of [
    ['fetch', 'git fetch'],
    ['pull', 'git pull'],
    ['push', 'git push'],
  ]) {
    await tools.getByRole('button', { name, exact: true }).click();
    await ask.getByRole('button', { name: '입력', exact: true }).click();
    await expect.poll(async () => (await state(page)).sent.at(-1)).toBe(`${line}\r`);
  }

  await tools.getByRole('button', { name: '표시 범위 자동' }).click();
  await expect.poll(async () => (await graphCalls(page)).at(-1)?.args.scope).toBe('all');
  await expect(tools.getByRole('button', { name: '표시 범위 모두' })).toBeVisible();
  await page.reload();
  await expect.poll(async () => (await graphCalls(page))[0]?.args.scope).toBe('all');

  const before = (await graphCalls(page)).length;
  await tools.getByRole('button', { name: '이력 새로 고침' }).click();
  await expect.poll(async () => (await graphCalls(page)).length).toBe(before + 1);
});

test('the toolbar moves to the current commit', async ({ page }) => {
  await open(page);
  await expect(page.locator('.git-graph-row').first()).toBeVisible();
  await page
    .getByRole('toolbar', { name: '이력 작업' })
    .getByRole('button', { name: '현재 커밋으로 이동' })
    .click();
  await expect(row(page, 'merge feature')).toBeFocused();
});

test('the handle between the files and the graph resizes them and is remembered', async ({
  page,
}) => {
  await open(page);
  await expect(page.locator('.git-graph-row').first()).toBeVisible();
  const body = page.locator('.git-view-body');
  const handle = page.getByRole('separator', { name: '변경 목록과 그래프 크기' });
  const before = (await body.boundingBox())!.height;
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 1);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y - 40);
  await page.mouse.up();
  await expect.poll(async () => (await body.boundingBox())!.height).toBeLessThan(before - 30);
  const dragged = (await body.boundingBox())!.height;

  await page.reload();
  await expect
    .poll(async () => Math.round((await body.boundingBox())!.height))
    .toBe(Math.round(dragged));

  await handle.dblclick();
  await expect.poll(async () => (await body.boundingBox())!.height).toBeGreaterThan(dragged);

  // Folded, the files have the height to themselves.
  await page
    .getByRole('region', { name: '그래프' })
    .getByRole('button', { name: '그래프' })
    .click();
  await expect(handle).toHaveCount(0);
});

test('a row stages, unstages and discards from buttons that appear on hover', async ({ page }) => {
  await open(page);
  const changed = rowOf(page, '변경', 'both.ts');
  const button = (name: string) => changed.getByRole('button', { name, exact: true });
  await expect(button('스테이지')).toBeHidden();
  await changed.hover();
  await expect(button('파일 열기')).toBeVisible();
  await button('스테이지').click();
  await expect.poll(() => lastAction(page)).toEqual({ kind: 'stage', paths: ['src/both.ts'] });
  // The button is not also a click on the row.
  expect((await state(page)).opens).toEqual([]);

  await changed.hover();
  await button('변경 버리기…').click();
  await expect(page.getByRole('dialog', { name: '변경 버리기' })).toBeVisible();
  await page.keyboard.press('Escape');

  const staged = rowOf(page, '스테이지됨', 'new.ts');
  await staged.hover();
  await staged.getByRole('button', { name: '스테이지 취소', exact: true }).click();
  await expect.poll(() => lastAction(page)).toEqual({ kind: 'unstage', paths: ['src/app/new.ts'] });
});

test('a deleted file has no open button, and a group acts on all of its files', async ({
  page,
}) => {
  await open(page);
  const deleted = rowOf(page, '변경', 'README.md');
  await deleted.hover();
  await expect(deleted.getByRole('button', { name: '파일 열기' })).toHaveCount(0);
  await expect(deleted.getByRole('button', { name: '스테이지', exact: true })).toBeVisible();

  await group(page, '변경').locator('.git-group-bar').hover();
  await group(page, '변경').getByRole('button', { name: '모두 스테이지', exact: true }).click();
  await expect
    .poll(() => lastAction(page))
    .toEqual({ kind: 'stage', paths: ['src/both.ts', 'README.md'] });
  // Conflicts have no group action.
  await expect(group(page, '충돌').locator('.git-group-bar .git-row-actions')).toHaveCount(0);
});

test('each button says what it does, even when it cannot be pressed', async ({ page }) => {
  await open(page, {
    result: { ...repo, entries: [entry('a', { worktree: 'modified' })] } as GitViewResult,
  });
  await expect(page.locator('.git-graph-row').first()).toBeVisible();
  const tip = page.getByRole('tooltip');
  await expect(tip).toHaveCount(0);
  await page.getByRole('button', { name: 'Git 새로 고침' }).hover();
  await expect(tip).toHaveText('Git 상태와 이력 새로 고침');
  await page.getByRole('button', { name: 'fetch', exact: true }).hover();
  await expect(tip).toContainText('원격의 새 커밋을 받아 옵니다');
  // The commit button is disabled here, which is exactly when the reason is wanted.
  await page.locator('.git-commit-tip').hover();
  await expect(tip).toHaveText('스테이지된 변경이 없습니다');
  await page.locator('.git-view-sync').hover();
  await expect(tip).toHaveText('origin/main 대비 앞섬 2 · 뒤처짐 1');
  await page.mouse.move(700, 450);
  await expect(tip).toHaveCount(0);
});

test('the message box uses the interface font', async ({ page }) => {
  await open(page);
  const fonts = await page
    .getByRole('textbox', { name: '커밋 메시지' })
    .evaluate((box) => [
      getComputedStyle(box).fontFamily,
      getComputedStyle(document.body).fontFamily,
    ]);
  expect(fonts[0]).toBe(fonts[1]);
});

test('files show what kind they are in the list and in a commit', async ({ page }) => {
  await open(page);
  await expect(rowOf(page, '변경', 'both.ts').locator('[data-file-type]')).toHaveAttribute(
    'data-file-type',
    'ts',
  );
  await expect(rowOf(page, '변경', 'README.md').locator('[data-file-type]')).toHaveAttribute(
    'data-file-type',
    'markdown',
  );
  // The icon's letters are not part of the file's name.
  await expect(rowOf(page, '변경', 'both.ts').locator('.git-row-name')).toHaveText('both.ts');
  await row(page, 'merge feature').click();
  await expect(page.locator('.git-graph-detail [data-file-type]')).toHaveAttribute(
    'data-file-type',
    'ts',
  );
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

const applied = async (page: Page) =>
  (await state(page)).calls.filter((c) => c.command === 'git_apply').map((c) => c.args);
const lastAction = async (page: Page) => (await applied(page)).at(-1)?.action;
const more = (page: Page) => page.getByRole('button', { name: 'Git 더 보기' });
const choose = (page: Page, name: string) =>
  page.getByRole('menuitem', { name, exact: true }).click();
const rowOf = (page: Page, groupName: string, text: string) =>
  group(page, groupName).locator('.git-row').filter({ hasText: text });

test('stages, unstages and commits from the menus and the commit box', async ({ page }) => {
  await open(page);
  await rowOf(page, '변경', 'README.md').click({ button: 'right' });
  await choose(page, '스테이지');
  await expect
    .poll(() => applied(page))
    .toEqual([
      {
        source: { kind: 'ssh', connectionId: 'c1' },
        root: '/srv/app',
        action: { kind: 'stage', paths: ['README.md'] },
      },
    ]);
  await rowOf(page, '스테이지됨', 'new.ts').click({ button: 'right' });
  await choose(page, '스테이지 취소');
  await expect.poll(() => lastAction(page)).toEqual({ kind: 'unstage', paths: ['src/app/new.ts'] });

  const message = page.getByRole('textbox', { name: '커밋 메시지' });
  await message.fill('첫 커밋');
  await message.press('Control+Enter');
  await expect
    .poll(() => lastAction(page))
    .toEqual({ kind: 'commit', message: '첫 커밋', amend: false });
  await expect(message).toHaveValue('');

  await message.fill('고친 메시지');
  await page.getByRole('button', { name: '커밋 더 보기' }).click();
  await choose(page, '이전 커밋 고치기 (--amend)');
  await expect
    .poll(() => lastAction(page))
    .toEqual({ kind: 'commit', message: '고친 메시지', amend: true });

  // Each action is followed by a new listing, and shows in the output list.
  await expect
    .poll(async () => (await state(page)).calls.filter((c) => c.command === 'git_view').length)
    .toBeGreaterThan(1);
  await page.locator('.git-output summary').click();
  await expect(
    page.getByRole('list', { name: '실행한 Git 명령' }).getByRole('listitem').first(),
  ).toContainText('git add -A');
});

test('the commit box waits for staged files and a message', async ({ page }) => {
  await open(page, {
    result: { ...repo, entries: [entry('a', { worktree: 'modified' })] } as GitViewResult,
  });
  const commit = page.getByRole('button', { name: '커밋', exact: true });
  const message = page.getByRole('textbox', { name: '커밋 메시지' });
  await expect(commit).toBeDisabled();
  await message.fill('메시지');
  await expect(commit).toBeDisabled();
  await message.press('Control+Enter');
  expect(await applied(page)).toEqual([]);
});

test('a failed commit shows the line from Git, and the message stays', async ({ page }) => {
  await open(page, {
    applyResult: {
      kind: 'failed',
      commands: ['git commit -q -m …'],
      reason: 'identity',
      detail: 'fatal: empty ident name',
    },
  });
  const message = page.getByRole('textbox', { name: '커밋 메시지' });
  await message.fill('메시지');
  await page.getByRole('button', { name: '커밋', exact: true }).click();
  await expect(page.locator('.git-view-error')).toContainText(
    '커밋 작성자 이름·이메일이 없습니다. 설정 → Git에서 지정하세요. fatal: empty ident name',
  );
  await expect(page.locator('.git-view-error').getByRole('button')).toHaveText('설정 → Git');
  await expect(message).toHaveValue('메시지');
});

test('discarding needs a confirmation whose default is Cancel, and lists the files', async ({
  page,
}) => {
  await open(page);
  await rowOf(page, '변경', 'README.md').click({ button: 'right' });
  await choose(page, '변경 버리기…');
  const dialog = page.getByRole('dialog', { name: '변경 버리기' });
  await expect(dialog.getByRole('list', { name: '대상 파일' })).toHaveText('README.md');
  const cancel = dialog.getByRole('button', { name: '취소', exact: true });
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(await applied(page)).toEqual([]);

  await rowOf(page, '변경', 'README.md').click({ button: 'right' });
  await choose(page, '변경 버리기…');
  await dialog.getByRole('button', { name: '변경 버리기', exact: true }).click();
  await expect
    .poll(() => lastAction(page))
    .toEqual({ kind: 'discard', paths: ['README.md'], untracked: [] });
});

test('deleting untracked files is asked separately from discarding changes', async ({ page }) => {
  await open(page);
  await group(page, '추적 안 함').locator('.git-group-head').click({ button: 'right' });
  await choose(page, '추적 안 함 파일 모두 삭제…');
  const dialog = page.getByRole('dialog', { name: '추적 안 함 파일 삭제' });
  await expect(dialog).toContainText('되돌릴 수 없습니다');
  await expect(dialog.getByRole('button', { name: '취소', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: '삭제', exact: true }).click();
  await expect
    .poll(() => lastAction(page))
    .toEqual({ kind: 'discard', paths: [], untracked: ['notes/메모.txt'] });
});

test('branches, tags and stashes go through their dialogs', async ({ page }) => {
  await open(page);
  await more(page).click();
  await choose(page, '새 브랜치…');
  let dialog = page.getByRole('dialog', { name: '새 브랜치' });
  await dialog.getByRole('textbox', { name: '이름' }).fill('feat/x');
  await dialog.getByRole('button', { name: '만들고 전환' }).click();
  await expect.poll(() => lastAction(page)).toEqual({ kind: 'branchCreate', name: 'feat/x' });

  await more(page).click();
  await choose(page, '태그…');
  dialog = page.getByRole('dialog', { name: '태그' });
  await dialog.getByRole('textbox', { name: '이름' }).fill('v1');
  await dialog.getByRole('textbox', { name: '설명 (선택)' }).fill('릴리스');
  await dialog.getByRole('button', { name: '태그 만들기' }).click();
  await expect.poll(() => lastAction(page)).toEqual({ kind: 'tag', name: 'v1', message: '릴리스' });

  await more(page).click();
  await choose(page, 'stash 넣기…');
  dialog = page.getByRole('dialog', { name: 'stash 넣기' });
  await dialog.getByRole('checkbox', { name: '추적 안 함 파일 포함' }).check();
  await dialog.getByRole('button', { name: '넣기', exact: true }).click();
  await expect
    .poll(() => lastAction(page))
    .toEqual({ kind: 'stashPush', message: '', includeUntracked: true });

  await more(page).click();
  await choose(page, 'stash 꺼내기');
  await expect.poll(() => lastAction(page)).toEqual({ kind: 'stashPop' });
});

test('switching to a branch: local through the app, remote through the terminal', async ({
  page,
}) => {
  await open(page);
  await page.locator('.git-view-branch').click();
  let dialog = page.getByRole('dialog', { name: '브랜치 전환' });
  // The current branch is not offered.
  await expect(dialog.getByRole('option', { name: 'feat', exact: true })).toBeVisible();
  await expect(dialog.getByRole('option', { name: 'main', exact: true })).toHaveCount(0);
  await dialog.getByRole('option', { name: 'feat', exact: true }).click();
  await expect.poll(() => lastAction(page)).toEqual({ kind: 'checkout', branch: 'feat' });

  await more(page).click();
  await choose(page, '브랜치 전환…');
  dialog = page.getByRole('dialog', { name: '브랜치 전환' });
  await dialog.getByRole('option', { name: 'origin/only-remote' }).click();
  // No marks in this fixture: nothing reports the terminal, so the user is asked first.
  const ask = page.getByRole('dialog', { name: '터미널에 입력' });
  await expect(ask).toContainText('git checkout --track origin/only-remote');
  await ask.getByRole('button', { name: '입력', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).sent)
    .toEqual(['git checkout --track origin/only-remote\r']);
});

test('the branch picker narrows as you type and goes by keyboard', async ({ page }) => {
  await open(page);
  await page.locator('.git-view-branch').click();
  const dialog = page.getByRole('dialog', { name: '브랜치 전환' });
  const search = dialog.getByRole('combobox', { name: '브랜치 찾기' });
  await expect(search).toBeFocused();
  await expect(dialog.getByRole('option')).toHaveCount(3);
  // The options read from the left, unlike a centered button.
  await expect(dialog.getByRole('option').nth(1)).toHaveCSS('justify-content', 'normal');

  await search.fill('fe');
  await expect(dialog.getByRole('option')).toHaveText(['새 브랜치 만들기: fe', 'feat']);
  await page.keyboard.press('Enter');
  await expect.poll(() => lastAction(page)).toEqual({ kind: 'checkout', branch: 'feat' });
  await expect(dialog).toHaveCount(0);
});

test('what was typed in the branch picker starts a new branch', async ({ page }) => {
  await open(page);
  await page.locator('.git-view-branch').click();
  const picker = page.getByRole('dialog', { name: '브랜치 전환' });
  await picker.getByRole('combobox', { name: '브랜치 찾기' }).fill('feat/새 일');
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  const dialog = page.getByRole('dialog', { name: '새 브랜치' });
  await expect(dialog.getByRole('textbox', { name: '이름' })).toHaveValue('feat/새 일');
});

test('network actions are typed in the terminal and never sent to git_apply', async ({ page }) => {
  await open(page);
  await more(page).click();
  await choose(page, 'push');
  const ask = page.getByRole('dialog', { name: '터미널에 입력' });
  await expect(ask.getByRole('button', { name: '취소', exact: true })).toBeFocused();
  await ask.getByRole('button', { name: '취소', exact: true }).click();
  expect((await state(page)).sent).toEqual([]);

  for (const [item, line] of [
    ['fetch', 'git fetch'],
    ['pull', 'git pull'],
    ['push', 'git push'],
  ]) {
    await more(page).click();
    await choose(page, item);
    await ask.getByRole('button', { name: '입력', exact: true }).click();
    await expect.poll(async () => (await state(page)).sent.at(-1)).toBe(`${line}\r`);
  }
  expect(await applied(page)).toEqual([]);
  await page.locator('.git-output summary').click();
  await expect(page.locator('.git-output li').first()).toContainText('터미널에 입력');
});

test('force push is only --force-with-lease, behind a confirmation', async ({ page }) => {
  await open(page);
  await more(page).click();
  await expect(page.getByRole('menuitem', { name: /--force$/ })).toHaveCount(0);
  await choose(page, 'push 강제(안전)…');
  const dialog = page.getByRole('dialog', { name: '강제 push' });
  await expect(dialog).toContainText('--force-with-lease');
  await expect(dialog.getByRole('button', { name: '취소', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  expect((await state(page)).sent).toEqual([]);

  await more(page).click();
  await choose(page, 'push 강제(안전)…');
  await dialog.getByRole('button', { name: '강제 push', exact: true }).click();
  const ask = page.getByRole('dialog', { name: '터미널에 입력' });
  await ask.getByRole('button', { name: '입력', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).sent)
    .toEqual(['git push --force-with-lease\r']);
});

test('a busy terminal or one in another folder gets nothing typed', async ({ page, browser }) => {
  await open(page, { buffer: 'alternate' });
  await more(page).click();
  await choose(page, 'push');
  await expect(page.locator('.git-view-error')).toHaveText('터미널이 사용 중입니다.');
  expect((await state(page)).sent).toEqual([]);

  // The Git view can show another folder's repository than the shell is in.
  const context = await browser.newContext();
  const other = await context.newPage();
  await open(other, { directory: '/elsewhere' });
  await other.getByRole('button', { name: 'Git 더 보기' }).click();
  await choose(other, 'fetch');
  await expect(other.locator('.git-view-error')).toContainText('이 저장소 폴더에 있지 않습니다');
  await context.close();
});

test('a file whose name is not UTF-8 cannot be acted on', async ({ page }) => {
  await open(page, {
    result: {
      ...repo,
      entries: [entry('bad\ufffdname', { worktree: 'modified', readable: false })],
    } as GitViewResult,
  });
  await page.locator('.git-row').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: '스테이지', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: '변경 버리기…' })).toBeDisabled();
});
