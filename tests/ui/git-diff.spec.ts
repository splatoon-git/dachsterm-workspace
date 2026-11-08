import { expect, test, type Page } from '@playwright/test';
import type { DiffSide, GitFileDiff } from '../../src/features/editor/gitFileDiff';
import type { GitRow } from '../../src/features/git/gitViewModel';
import type {} from './fixtures/file-tab';

const text = (
  value: string,
  over: Partial<Extract<DiffSide, { kind: 'text' }>> = {},
): DiffSide => ({
  kind: 'text',
  text: value,
  encoding: 'utf-8',
  lossy: false,
  hash: `hash-${value}`,
  ...over,
});
const absent: DiffSide = { kind: 'absent' };

type Diffs = Record<string, GitFileDiff | { fail: string }>;
type Answers = Window['__fileTab']['answers'];
async function open(page: Page, diffs: Diffs, answers: Answers = []) {
  await page.addInitScript(
    (value) => {
      window.__fileTab = value as typeof window.__fileTab;
    },
    {
      files: {
        '/srv/app/a.ts': {
          size: 1,
          modified: 1,
          kind: 'text',
          text: 'onserver',
          encoding: 'utf-8',
          lossy: false,
          large: false,
          hash: 'hash-server',
        },
      },
      status: 'connected',
      calls: [],
      opened: [],
      writes: [],
      answers,
      diffs,
      diffCalls: [],
    } satisfies Window['__fileTab'],
  );
  await page.goto('/tests/ui/fixtures/file-tab.html');
  await expect(page.getByRole('tab', { name: '터미널' })).toBeVisible();
}

const row = (over: Partial<GitRow>): GitRow => ({
  key: 'k',
  group: 'changes',
  path: 'a.ts',
  oldPath: null,
  change: 'modified',
  readable: true,
  ...over,
});
const openRow = (page: Page, value: GitRow, pinned = false) =>
  page.evaluate(([r, p]) => window.__fileTab.openDiff!(r, p), [value, pinned] as const);
const state = (page: Page) => page.evaluate(() => window.__fileTab);
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const dirtyTab = (page: Page, name: string) =>
  page.getByRole('tab', { name: `${name} 저장 안 됨` });
const left = (page: Page) => page.locator('.editor.original .view-lines');
// One column draws deleted lines inside the modified editor, in a `.view-lines` of their own.
const right = (page: Page) => page.locator('.editor.modified .view-lines:not(.line-delete)');
const labels = (page: Page) => page.locator('[data-diff-labels] span');
const banner = (page: Page) => page.locator('.file-tab-banner[role="alert"]');
const dialog = (page: Page) => page.getByRole('dialog');

async function typeAtEnd(page: Page, value: string, title: string) {
  await right(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(value);
  await expect(dirtyTab(page, title)).toBeVisible();
}

const changed: Diffs = {
  'indexWorktree:a.ts': { original: text('inindex'), modified: text('inworktree') },
};
const worktreeTitle = 'a.ts ↔ 인덱스';

test.describe('the three comparisons', () => {
  test('a staged file compares HEAD with the index and cannot be edited', async ({ page }) => {
    await open(page, { 'headIndex:a.ts': { original: text('inhead'), modified: text('staged') } });
    await openRow(page, row({ group: 'staged' }));
    await expect(tab(page, 'a.ts ↔ HEAD')).toBeVisible();
    await expect(labels(page)).toHaveText(['HEAD', '인덱스']);
    await expect(left(page)).toContainText('inhead');
    await expect(right(page)).toContainText('staged');
    expect((await state(page)).diffCalls).toEqual([
      {
        source: { kind: 'ssh', connectionId: 'c1' },
        folder: '/srv/app',
        path: 'a.ts',
        oldPath: null,
        compare: { kind: 'headIndex' },
      },
    ]);

    await right(page).click();
    await page.keyboard.type('x');
    await expect(right(page)).not.toContainText('x');
    await expect(dirtyTab(page, 'a.ts ↔ HEAD')).toHaveCount(0);
    await page.keyboard.press('Control+s');
    expect((await state(page)).writes).toEqual([]);
  });

  test('a changed file compares the index with the working tree', async ({ page }) => {
    await open(page, changed);
    await openRow(page, row({}));
    await expect(tab(page, worktreeTitle)).toBeVisible();
    await expect(labels(page)).toHaveText(['인덱스', '작업 트리']);
    await expect(left(page)).toContainText('inindex');
    await expect(right(page)).toContainText('inworktree');
  });

  test('an untracked file is new, with an empty left side', async ({ page }) => {
    await open(page, { 'untracked:a.ts': { original: absent, modified: text('brandnew') } });
    await openRow(page, row({ group: 'untracked', change: 'untracked' }));
    await expect(tab(page, 'a.ts (새 파일)')).toBeVisible();
    await expect(labels(page)).toHaveText(['없음', '작업 트리']);
    await expect(right(page)).toContainText('brandnew');
    await expect(left(page)).not.toContainText('brandnew');
  });

  test('a file deleted from the working tree has nothing to edit on the right', async ({
    page,
  }) => {
    await open(page, { 'indexWorktree:a.ts': { original: text('wasthere'), modified: absent } });
    await openRow(page, row({ change: 'deleted' }));
    await expect(left(page)).toContainText('wasthere');
    await right(page).click();
    await page.keyboard.type('x');
    await expect(dirtyTab(page, worktreeTitle)).toHaveCount(0);
    expect((await state(page)).diffCalls?.[0].compare).toEqual({
      kind: 'indexWorktree',
      deleted: true,
    });
  });

  test('a staged rename asks for the old name', async ({ page }) => {
    await open(page, { 'headIndex:a.ts': { original: text('same'), modified: text('same') } });
    await openRow(page, row({ group: 'staged', change: 'renamed', oldPath: 'old.ts' }));
    await expect(left(page)).toContainText('same');
    expect((await state(page)).diffCalls?.[0].oldPath).toBe('old.ts');
  });
});

test.describe('the two layouts', () => {
  test('switches between side by side and one column, and remembers it', async ({ page }) => {
    await open(page, changed);
    await openRow(page, row({}));
    const sideBySide = page.locator('.monaco-diff-editor.side-by-side');
    await expect(sideBySide).toHaveCount(1);

    await page.getByRole('group', { name: 'diff 보기 방식' }).getByText('한 줄').click();
    await expect(sideBySide).toHaveCount(0);
    await expect(labels(page)).toHaveText(['인덱스 ↔ 작업 트리']);
    await expect(right(page)).toContainText('inworktree');
    expect(await page.evaluate(() => localStorage.getItem('dachsterm.gitDiff.layout'))).toBe(
      'inline',
    );

    await page.getByRole('group', { name: 'diff 보기 방식' }).getByText('좌우').click();
    await expect(sideBySide).toHaveCount(1);
  });

  test('opens in the remembered layout', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('dachsterm.gitDiff.layout', 'inline'));
    await open(page, changed);
    await openRow(page, row({}));
    await expect(right(page)).toContainText('inworktree');
    await expect(page.locator('.monaco-diff-editor.side-by-side')).toHaveCount(0);
  });
});

test.describe('preview tabs', () => {
  const two: Diffs = {
    ...changed,
    'indexWorktree:b.ts': { original: text('b-left'), modified: text('bright') },
  };
  const b = row({ path: 'b.ts' });

  test('the next click replaces a preview', async ({ page }) => {
    await open(page, two);
    await openRow(page, row({}));
    await expect(tab(page, worktreeTitle)).toHaveCSS('font-style', 'italic');
    await openRow(page, b);
    await expect(tab(page, 'b.ts ↔ 인덱스')).toBeVisible();
    await expect(tab(page, worktreeTitle)).toHaveCount(0);
  });

  test('a pinned diff stays, and opening it again adds no tab', async ({ page }) => {
    await open(page, two);
    await openRow(page, row({}), true);
    await expect(tab(page, worktreeTitle)).toHaveCSS('font-style', 'normal');
    await openRow(page, b);
    await expect(tab(page, worktreeTitle)).toBeVisible();
    await openRow(page, row({}));
    await expect(tab(page, worktreeTitle)).toHaveCount(1);
    expect((await state(page)).diffCalls).toHaveLength(2);
  });

  test('the first edit keeps a preview', async ({ page }) => {
    await open(page, two);
    await openRow(page, row({}));
    await expect(right(page)).toContainText('inworktree');
    await typeAtEnd(page, 'x', worktreeTitle);
    await expect(dirtyTab(page, worktreeTitle)).toHaveCSS('font-style', 'normal');
    await openRow(page, b);
    await expect(dirtyTab(page, worktreeTitle)).toBeVisible();
  });
});

test.describe('editing the working tree side', () => {
  test('saves into the file with the hash it read', async ({ page }) => {
    await open(page, changed);
    await openRow(page, row({}));
    await expect(right(page)).toContainText('inworktree');
    await typeAtEnd(page, 'Z', worktreeTitle);
    await page.keyboard.press('Control+s');
    await expect(dirtyTab(page, worktreeTitle)).toHaveCount(0);
    expect((await state(page)).writes).toEqual([
      {
        source: { kind: 'ssh', connectionId: 'c1' },
        path: '/srv/app/a.ts',
        content: 'inworktreeZ',
        encoding: 'utf-8',
        baseHash: 'hash-inworktree',
      },
    ]);
    // The next save compares against what this one wrote.
    await typeAtEnd(page, 'Y', worktreeTitle);
    await page.keyboard.press('Control+s');
    await expect(dirtyTab(page, worktreeTitle)).toHaveCount(0);
    expect((await state(page)).writes[1].baseHash).toBe('saved-1');
  });

  test('undoing every edit clears the unsaved mark', async ({ page }) => {
    await open(page, changed);
    await openRow(page, row({}));
    await expect(right(page)).toContainText('inworktree');
    await typeAtEnd(page, 'x', worktreeTitle);
    // Undo is the editor's own binding, which takes only Cmd on macOS.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(dirtyTab(page, worktreeTitle)).toHaveCount(0);
  });

  test('a file changed elsewhere stops the save, shows the difference and can be replaced', async ({
    page,
  }) => {
    await open(page, changed, [{ status: 'conflict', hash: 'hash-server' }]);
    await openRow(page, row({}));
    await expect(right(page)).toContainText('inworktree');
    await typeAtEnd(page, 'Z', worktreeTitle);
    await page.keyboard.press('Control+s');
    const card = page.getByRole('alertdialog', { name: '저장 충돌' });
    await expect(card).toBeVisible();
    await expect(dirtyTab(page, worktreeTitle)).toBeVisible();

    await card.getByRole('button', { name: '서버 내용 보기' }).click();
    await expect(left(page)).toContainText('onserver');
    await expect(labels(page)).toHaveText(['서버 내용', '지금 편집본']);
    await expect(right(page)).toContainText('inworktreeZ');
    await card.getByRole('button', { name: '비교 닫기' }).click();
    await expect(left(page)).toContainText('inindex');

    await card.getByRole('button', { name: '덮어쓰기' }).click();
    await dialog(page).getByRole('button', { name: '덮어쓰기' }).click();
    await expect(dirtyTab(page, worktreeTitle)).toHaveCount(0);
    const { writes } = await state(page);
    expect(writes.map((write) => write.baseHash)).toEqual(['hash-inworktree', 'hash-server']);
  });

  test('closing an edited diff asks first', async ({ page }) => {
    await open(page, changed);
    await openRow(page, row({}));
    await expect(right(page)).toContainText('inworktree');
    await typeAtEnd(page, 'x', worktreeTitle);
    await page.getByRole('button', { name: `${worktreeTitle} 탭 닫기` }).click();
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole('button', { name: '취소' }).click();
    await expect(dirtyTab(page, worktreeTitle)).toBeVisible();

    await page.getByRole('button', { name: `${worktreeTitle} 탭 닫기` }).click();
    await dialog(page).getByRole('button', { name: '저장 안 함' }).click();
    await expect(tab(page, worktreeTitle)).toHaveCount(0);
    expect((await state(page)).writes).toEqual([]);
  });

  test('closing the window counts an edited diff', async ({ page }) => {
    await open(page, changed);
    await openRow(page, row({}));
    await expect(right(page)).toContainText('inworktree');
    await typeAtEnd(page, 'x', worktreeTitle);
    const closed = page.evaluate(() => window.__fileTab.closeWindow!());
    await dialog(page).getByRole('button', { name: '취소' }).click();
    expect(await closed).toBe(false);
  });

  test('a file that cannot be read back exactly is not editable', async ({ page }) => {
    await open(page, {
      'indexWorktree:a.ts': { original: text('ok'), modified: text('broken', { lossy: true }) },
    });
    await openRow(page, row({}));
    await expect(banner(page)).toContainText('편집을 막습니다');
    await right(page).click();
    await page.keyboard.type('x');
    await expect(dirtyTab(page, worktreeTitle)).toHaveCount(0);
  });
});

test.describe('when the Git view changes the repository', () => {
  const replaceDiff = (page: Page, value: GitFileDiff) =>
    page.evaluate((diff) => {
      window.__fileTab.diffs!['indexWorktree:a.ts'] = diff;
      window.__fileTab.notifyIndex!();
    }, value);

  test('the left side follows', async ({ page }) => {
    await open(page, changed);
    await openRow(page, row({}));
    await expect(left(page)).toContainText('inindex');
    await replaceDiff(page, { original: text('nowstaged'), modified: text('inworktree') });
    await expect(left(page)).toContainText('nowstaged');
    await expect(right(page)).toContainText('inworktree');
  });

  test('unsaved edits stay and still compare with the new left side', async ({ page }) => {
    await open(page, changed);
    await openRow(page, row({}));
    await expect(right(page)).toContainText('inworktree');
    await typeAtEnd(page, 'Q', worktreeTitle);
    await replaceDiff(page, { original: text('nowstaged'), modified: text('other') });
    await expect(left(page)).toContainText('nowstaged');
    await expect(right(page)).toContainText('inworktreeQ');
    await expect(dirtyTab(page, worktreeTitle)).toBeVisible();
  });

  test('a working tree that really changed is shown when nothing is unsaved', async ({ page }) => {
    await open(page, changed);
    await openRow(page, row({}));
    await expect(right(page)).toContainText('inworktree');
    await replaceDiff(page, { original: text('inindex'), modified: text('discarded') });
    await expect(right(page)).toContainText('discarded');
    await expect(dirtyTab(page, worktreeTitle)).toHaveCount(0);
  });
});

test.describe('what cannot be compared', () => {
  test('binary and oversized files say so', async ({ page }) => {
    await open(page, {
      'indexWorktree:a.ts': { original: { kind: 'binary', format: 'PNG' }, modified: text('x') },
      'indexWorktree:b.ts': { original: text('x'), modified: { kind: 'tooLarge' } },
    });
    await openRow(page, row({}));
    await expect(page.getByRole('heading', { name: /바이너리 파일이라/ })).toBeVisible();
    await openRow(page, row({ path: 'b.ts' }));
    await expect(page.getByRole('heading', { name: /크기가 커서/ })).toBeVisible();
  });

  test('a failed read can be retried', async ({ page }) => {
    await open(page, { 'indexWorktree:a.ts': { fail: '서버에 git이 없습니다.' } });
    await openRow(page, row({}));
    await expect(page.getByRole('alert')).toContainText('서버에 git이 없습니다.');
    await page.evaluate(() => {
      window.__fileTab.diffs!['indexWorktree:a.ts'] = {
        original: { kind: 'absent' },
        modified: {
          kind: 'text',
          text: 'recovered',
          encoding: 'utf-8',
          lossy: false,
          hash: 'h',
        },
      };
    });
    await page.getByRole('button', { name: '다시 시도' }).click();
    await expect(right(page)).toContainText('recovered');
  });
});
