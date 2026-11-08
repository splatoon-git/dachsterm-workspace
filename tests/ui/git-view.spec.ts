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

type Setup = Partial<Omit<Window['__gitView'], 'calls' | 'reviewed' | 'sent'>>;
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
      buffer: 'normal',
      sent: [],
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
  await expect(page.locator('.git-view-error')).toHaveText(
    '커밋 작성자 이름·이메일이 없습니다. 설정 → Git에서 지정하세요. fatal: empty ident name',
  );
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
  await more(page).click();
  await choose(page, '브랜치 전환…');
  let dialog = page.getByRole('dialog', { name: '브랜치 전환' });
  // The current branch is not offered.
  await expect(dialog.getByRole('button', { name: 'feat', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'main', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'feat', exact: true }).click();
  await expect.poll(() => lastAction(page)).toEqual({ kind: 'checkout', branch: 'feat' });

  await more(page).click();
  await choose(page, '브랜치 전환…');
  dialog = page.getByRole('dialog', { name: '브랜치 전환' });
  await dialog.getByRole('button', { name: 'origin/only-remote' }).click();
  // No marks in this fixture: nothing reports the terminal, so the user is asked first.
  const ask = page.getByRole('dialog', { name: '터미널에 입력' });
  await expect(ask).toContainText('git checkout --track origin/only-remote');
  await ask.getByRole('button', { name: '입력', exact: true }).click();
  await expect
    .poll(async () => (await state(page)).sent)
    .toEqual(['git checkout --track origin/only-remote\r']);
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
