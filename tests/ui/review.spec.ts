import { expect, test, type Page } from '@playwright/test';
import type { DiffFile, DiffList, FileDiff, GitRefs } from '../../src/features/git/gitDiff';
import type { Delivery } from '../../src/features/git/review';
import type {} from './fixtures/review';

const file = (path: string, over: Partial<DiffFile> = {}): DiffFile => ({
  path,
  oldPath: null,
  change: 'modified',
  added: 1,
  removed: 1,
  binary: false,
  readable: true,
  ...over,
});
const long = 'x'.repeat(5000);
const big = Array.from({ length: 3000 }, (_, n) => ` line ${n + 100}`);
const patch = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,5 @@',
  ' one',
  '-two',
  '-three',
  '+TWO',
  '+THREE',
  '+added',
  ' four',
  '@@ -100,3001 +101,3001 @@',
  ` ${long}`,
  ...big,
  '',
].join('\n');
const refs: GitRefs = {
  root: '/srv/app',
  worktrees: [
    { path: '/srv/app', branch: 'refs/heads/main' },
    { path: '/srv/app-fix', branch: 'refs/heads/fix' },
  ],
  refs: ['refs/heads/fix', 'refs/heads/main', 'refs/remotes/origin/main'],
  truncated: false,
};
const list: DiffList = {
  kind: 'files',
  truncated: false,
  files: [
    file('src/a.ts', { added: 3, removed: 2 }),
    file('new file.txt', { change: 'added', added: 2, removed: 0 }),
    file('gone.txt', { change: 'deleted', added: 0, removed: 4 }),
    file('한글 이름.txt', { change: 'renamed', oldPath: 'old.txt' }),
    file('메모.md', { change: 'untracked', added: null, removed: null }),
    file('image.png', { added: null, removed: null, binary: true }),
    file('bad�.txt', { readable: false }),
    file('huge.log'),
  ],
};
const files: Record<string, FileDiff> = {
  'src/a.ts': { kind: 'text', text: patch },
  'image.png': {
    kind: 'text',
    text: 'diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n',
  },
  'huge.log': { kind: 'tooLarge', size: 3 * 1024 * 1024 },
  'gone.txt': {
    kind: 'text',
    text: 'diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-bye\n',
  },
  '한글 이름.txt': {
    kind: 'text',
    text: 'diff --git a/old.txt b/한글 이름.txt\nsimilarity index 100%\nrename from old.txt\nrename to 한글 이름.txt\n',
  },
};

async function load(page: Page, width: number, delivery: Delivery, failRefs?: string) {
  await page.addInitScript(
    (value) => {
      window.__review = value as typeof window.__review;
    },
    { width, refs, list, files, delivery, failRefs, sent: [], calls: [], copied: [] },
  );
  await page.goto('/tests/ui/fixtures/review.html');
}
async function open(page: Page, width: number, delivery: Delivery = 'sent') {
  await load(page, width, delivery);
  await expect(page.locator('.diff-row').first()).toBeVisible();
}
const state = (page: Page) => page.evaluate(() => window.__review);
const pick = (page: Page, name: string) =>
  page.getByRole('list', { name: '변경 파일' }).getByRole('button', { name, exact: false });

test('lists every kind of change and shows a wide diff side by side', async ({ page }) => {
  await open(page, 1100);
  const names = page.getByRole('list', { name: '변경 파일' }).locator('.review-path');
  await expect(names).toHaveText([
    'src/a.ts',
    'new file.txt',
    'gone.txt',
    'old.txt → 한글 이름.txt',
    '메모.md',
    'image.png',
    'bad�.txt',
    'huge.log',
  ]);
  await expect(page.locator('.review-mark')).toHaveText(['M', 'A', 'D', 'R', '?', 'M', 'M', 'M']);
  await expect(page.locator('.review-summary')).toHaveText('파일 8개 · +8 −9');
  await expect(page.locator('.diff-pair').first()).toBeVisible();
  await expect(page.locator('.diff-line')).toHaveCount(0);
  const changed = page.locator('.diff-pair').nth(1);
  await expect(changed.locator('.diff-side.del')).toContainText('two');
  await expect(changed.locator('.diff-side.add')).toContainText('TWO');
  // 3,000 lines scroll, but only the rows in view are in the document.
  expect(await page.locator('.diff-row').count()).toBeLessThan(120);
  await expect(page.locator('.diff-cut').first()).toContainText('1,000자 생략');
  await page.locator('.diff-view').evaluate((element) => (element.scrollTop = 1e7));
  await expect(page.locator('.diff-row').last()).toContainText('line 3099');
});

test('stacks old and new lines in a narrow pane with a file drop-down', async ({ page }) => {
  await open(page, 520);
  await expect(page.locator('.diff-pair')).toHaveCount(0);
  await expect(page.locator('.diff-line.del').first()).toContainText('two');
  await expect(page.locator('.diff-line.add').first()).toContainText('TWO');
  await page.getByRole('combobox', { name: '변경 파일' }).selectOption('gone.txt');
  await expect(page.locator('.review-meta')).toHaveText('deleted file mode 100644');
  await expect(page.locator('.diff-line.del')).toContainText('bye');
});

test('explains files it does not draw and offers the terminal command', async ({ page }) => {
  await open(page, 1100);
  await pick(page, 'image.png').click();
  await expect(page.getByText('바이너리 변경입니다. 내용은 표시하지 않습니다.')).toBeVisible();
  await expect(page.locator('.review-empty code')).toHaveText("git diff HEAD -- 'image.png'");
  await pick(page, 'huge.log').click();
  await expect(
    page.getByText('파일이 커서(3.0 MB) 표시하지 않습니다.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: '명령 복사' }).click();
  await expect
    .poll(async () => (await state(page)).copied)
    .toEqual(["git diff HEAD -- 'huge.log'"]);
  await pick(page, '한글 이름.txt').click();
  await expect(
    page.getByText('similarity index 100% · rename from old.txt', { exact: false }),
  ).toBeVisible();
  await pick(page, 'bad').click();
  await expect(
    page.getByText('이름을 UTF-8로 읽을 수 없는 파일이라 내용을 열지 않습니다.'),
  ).toBeVisible();
  const asked = (await state(page)).calls.filter((c) => c.command === 'git_diff_file');
  expect(asked.map((c) => c.args.path)).not.toContain('bad�.txt');
  const renamed = asked.find((c) => c.args.path === '한글 이름.txt');
  expect(renamed?.args).toMatchObject({ oldPath: 'old.txt', untracked: false, root: '/srv/app' });
});

test('compares with a listed branch and switches worktrees', async ({ page }) => {
  await open(page, 1100);
  const first = (await state(page)).calls[0];
  expect(first).toEqual({
    command: 'git_refs',
    args: { source: { kind: 'ssh', connectionId: 'c1' }, folder: '/srv/app/src' },
  });
  await page.getByRole('combobox', { name: '기준' }).selectOption('refs/heads/main');
  const lastList = async () =>
    (await state(page)).calls.filter((c) => c.command === 'git_diff_files').at(-1)?.args;
  await expect
    .poll(async () => (await lastList())?.base)
    .toEqual({ kind: 'branch', ref: 'refs/heads/main' });
  await page.getByRole('combobox', { name: '작업 폴더' }).selectOption('/srv/app-fix');
  await expect
    .poll(
      async () => (await state(page)).calls.filter((c) => c.command === 'git_refs').at(-1)?.args,
    )
    .toEqual({ source: { kind: 'ssh', connectionId: 'c1' }, folder: '/srv/app-fix' });
  await expect.poll(async () => (await lastList())?.root).toBe('/srv/app-fix');
  await expect(page.getByRole('combobox', { name: '작업 폴더' })).toHaveValue('/srv/app-fix');
});

test('collects comments on line ranges and pastes them without Enter', async ({ page }) => {
  await open(page, 1100);
  await page.getByRole('button', { name: '새 2행 선택', exact: true }).click();
  await page
    .getByRole('button', { name: '새 4행 선택', exact: true })
    .click({ modifiers: ['Shift'] });
  await expect(page.locator('.diff-pair.selected')).toHaveCount(3);
  await expect(page.locator('.review-composer strong')).toHaveText('src/a.ts:2-4');
  await page.getByRole('textbox', { name: '의견' }).fill('이름을 소문자로');
  await page.getByRole('textbox', { name: '의견' }).press('Enter');
  await page.getByRole('button', { name: '이전 3행 선택', exact: true }).click();
  await page.getByRole('textbox', { name: '의견' }).fill('여기도');
  await page.getByRole('button', { name: '목록에 추가' }).click();
  const notes = page.getByRole('region', { name: '검토 목록' });
  await expect(notes.locator('li')).toHaveCount(2);
  await expect(notes.locator('li code')).toHaveText(['src/a.ts:2-4', 'src/a.ts:3']);
  await notes.getByRole('button', { name: '프롬프트로 보내기 · 배포 서버' }).click();
  await expect(page.getByRole('status')).toHaveText(
    '프롬프트에 넣었습니다. 내용을 확인한 뒤 Enter를 누르세요.',
  );
  const sent = (await state(page)).sent;
  expect(sent).toEqual([
    {
      multiline: 'src/a.ts:2-4 이름을 소문자로\nsrc/a.ts:3 여기도',
      plain: 'src/a.ts:2-4 이름을 소문자로 / src/a.ts:3 여기도',
    },
  ]);
  await notes.getByRole('button', { name: 'src/a.ts:3 의견 삭제' }).click();
  await expect(notes.locator('li')).toHaveCount(1);
});

test('offers a copy instead when the target terminal changed', async ({ page }) => {
  await open(page, 1100, 'changed');
  await page.getByRole('button', { name: '새 1행 선택', exact: true }).click();
  await page.getByRole('textbox', { name: '의견' }).fill('확인');
  await page.getByRole('textbox', { name: '의견' }).press('Enter');
  await page.getByRole('button', { name: '프롬프트로 보내기 · 배포 서버' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    '대상 터미널이 다시 연결되어 넣지 않았습니다. 복사해서 붙여넣으세요.',
  );
  await page
    .getByRole('region', { name: '검토 목록' })
    .getByRole('button', { name: '복사' })
    .click();
  await expect.poll(async () => (await state(page)).copied).toEqual(['src/a.ts:1 확인']);
});

test('shows why a folder cannot be reviewed, and not an empty list', async ({ page }) => {
  await load(page, 1100, 'sent', 'Git 저장소를 읽을 수 없습니다. fatal: not a git repository');
  await expect(page.getByRole('alert')).toHaveText(
    'Git 저장소를 읽을 수 없습니다. fatal: not a git repository',
  );
  await expect(page.getByText('변경이 없습니다.')).toHaveCount(0);
  await expect(page.getByText('변경 목록을 읽는 중…')).toHaveCount(0);
});

test('fills a wide cell even when the diff is short', async ({ page }) => {
  // The cell is a flex row: a pane sized by its content turned narrow on short diffs.
  await open(page, 1100);
  await pick(page, 'gone.txt').click();
  await expect(page.locator('.diff-view')).toContainText('bye');
  await expect(page.getByRole('list', { name: '변경 파일' })).toBeVisible();
  const box = await page.locator('.review-pane').boundingBox();
  expect(box?.width).toBe(1100);
});
