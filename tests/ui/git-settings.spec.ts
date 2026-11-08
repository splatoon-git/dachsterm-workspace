import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/git-settings';

type Setup = Partial<Omit<Window['__gitSettings'], 'calls' | 'writes'>>;

async function open(page: Page, setup: Setup = {}, query = '') {
  await page.addInitScript(
    (value) => {
      window.__gitSettings = value as typeof window.__gitSettings;
    },
    {
      program: {
        chosen: null,
        found: 'C:\\Program Files\\Git\\cmd\\git.exe',
        version: 'git version 2.50.1',
        problem: null,
      },
      pick: null,
      refuse: null,
      entries: {
        'pwsh:global': [
          { key: 'user.name', values: ['Kim'], hidden: false },
          { key: 'pull.rebase', values: ['interactive'], hidden: false },
          { key: 'credential.helper', values: [], hidden: true },
          { key: 'safe.directory', values: ['/srv/a', '/srv/b'], hidden: false },
        ],
        'wsl:Ubuntu:global': [{ key: 'user.name', values: ['WSL 사용자'], hidden: false }],
      },
      readError: null,
      writeError: null,
      writes: [],
      calls: [],
      ...setup,
    } satisfies Window['__gitSettings'],
  );
  await page.goto(`/tests/ui/fixtures/git-settings.html${query}`);
}
const state = (page: Page) => page.evaluate(() => window.__gitSettings);
const editor = (page: Page) => page.getByRole('region', { name: 'Git 설정 편집', exact: true });
const name = (page: Page) => editor(page).getByLabel('이름 (user.name)', { exact: true });

test('reads each target from that target and keeps edits to the target they were made for', async ({
  page,
}) => {
  await open(page);
  await expect(name(page)).toHaveValue('Kim');
  await name(page).fill('Lee');
  await page.getByLabel('Git 설정 대상', { exact: true }).selectOption({ label: 'WSL · Ubuntu' });
  await expect(name(page)).toHaveValue('WSL 사용자');
  await expect(page.getByRole('button', { name: '변경 없음', exact: true })).toBeDisabled();
  const reads = (await state(page)).calls.filter((c) => c.command === 'git_config_read');
  expect(reads.map((c) => c.args.source)).toEqual([
    { kind: 'local', targetId: 'pwsh' },
    { kind: 'local', targetId: 'wsl:Ubuntu' },
  ]);
});

test('shows the final commands, and runs only what changed after they are confirmed', async ({
  page,
}) => {
  await open(page);
  await expect(name(page)).toHaveValue('Kim');
  await name(page).fill('Lee');
  await editor(page).getByLabel('충돌 표시 (merge.conflictStyle)').selectOption('zdiff3');
  await page.getByRole('button', { name: '변경 2개 검토…', exact: true }).click();
  const review = page.getByRole('group', { name: '실행할 명령 확인', exact: true });
  await expect(review.locator('pre')).toHaveText(
    'git config user.name Lee\ngit config merge.conflictStyle zdiff3',
  );
  expect((await state(page)).writes).toEqual([]);

  await review.getByRole('button', { name: '실행', exact: true }).click();
  await expect(editor(page).getByRole('status')).toHaveText('적용했습니다.');
  await expect(name(page)).toHaveValue('Lee');
  await expect(page.getByRole('button', { name: '변경 없음', exact: true })).toBeDisabled();
  const { writes } = await state(page);
  expect(writes).toEqual([
    {
      key: 'pwsh:global',
      changes: [
        { op: 'set', key: 'user.name', value: 'Lee', all: false },
        { op: 'set', key: 'merge.conflictStyle', value: 'zdiff3', all: false },
      ],
    },
  ]);
});

test('cancel writes nothing and keeps the edit', async ({ page }) => {
  await open(page);
  await name(page).fill('Lee');
  await page.getByRole('button', { name: '변경 1개 검토…', exact: true }).click();
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect(name(page)).toHaveValue('Lee');
  expect((await state(page)).writes).toEqual([]);
});

test('a failed write says why and keeps what was not applied', async ({ page }) => {
  await open(page, { writeError: '2개 중 0개만 적용했습니다. could not lock config file' });
  await name(page).fill('Lee');
  await page.getByRole('button', { name: '변경 1개 검토…', exact: true }).click();
  await page.getByRole('button', { name: '실행', exact: true }).click();
  await expect(editor(page).getByRole('alert')).toContainText('could not lock config file');
  await expect(name(page)).toHaveValue('Lee');
});

test('a read that fails is reported and offers nothing to apply', async ({ page }) => {
  await open(page, { readError: 'WSL 배포판에 git이 없습니다.' });
  await expect(editor(page).getByRole('alert')).toHaveText('WSL 배포판에 git이 없습니다.');
  await expect(page.getByRole('button', { name: '변경 없음', exact: true })).toBeDisabled();
});

test('hides a helper that may hold a secret and warns about trusting everything', async ({
  page,
}) => {
  await open(page);
  await expect(editor(page)).toContainText('비밀이 있을 수 있어 표시하지 않습니다.');
  await expect(editor(page)).toContainText('/srv/a, /srv/b');
  // A value the app has no name for still shows, and an unrelated edit leaves it alone.
  await expect(editor(page).getByLabel('pull 방식 (pull.rebase)')).toHaveValue('interactive');

  await editor(page).getByLabel('신뢰하는 폴더 (safe.directory)').fill('*');
  await page.getByRole('button', { name: '변경 1개 검토…', exact: true }).click();
  const review = page.getByRole('group', { name: '실행할 명령 확인', exact: true });
  await expect(review.getByRole('alert')).toContainText('모든 저장소');
  await expect(review.locator('pre')).toHaveText('git config --add safe.directory *');
});

test('a repository opens on its own settings, without the global-only list', async ({ page }) => {
  await open(page, {}, '?repo=C:/repo');
  await expect(page.getByLabel('Git 설정 대상', { exact: true })).toHaveValue('repo');
  await expect(
    editor(page).getByLabel('신뢰하는 폴더 (safe.directory)', { exact: true }),
  ).toHaveCount(0);
  const read = (await state(page)).calls.find((c) => c.command === 'git_config_read');
  expect(read?.args.scope).toEqual({ kind: 'local', folder: 'C:/repo' });
});

test('shows where Git is, sets a picked file and goes back to the search', async ({ page }) => {
  await open(page, { pick: 'D:\\tools\\git.exe' });
  const place = page.getByRole('region', { name: 'Git 위치', exact: true });
  await expect(place).toContainText('C:\\Program Files\\Git\\cmd\\git.exe');
  await expect(place).toContainText('git version 2.50.1');
  await expect(place).toContainText('(자동으로 찾음)');

  await place.getByRole('button', { name: '파일 선택…', exact: true }).click();
  await expect(place).toContainText('D:\\tools\\git.exe');
  await expect(place).toContainText('(직접 지정)');
  await place.getByRole('button', { name: '자동 찾기로 되돌리기', exact: true }).click();
  await expect(place).toContainText('(자동으로 찾음)');
  const sets = (await state(page)).calls.filter((c) => c.command === 'git_program_set');
  expect(sets.map((c) => c.args.path)).toEqual(['D:\\tools\\git.exe', null]);
});

test('reports a picked file that does not run without going back to the search', async ({
  page,
}) => {
  await open(page, { pick: 'D:\\x.exe', refuse: 'Git이 아닙니다: D:\\x.exe' });
  const place = page.getByRole('region', { name: 'Git 위치', exact: true });
  await place.getByRole('button', { name: '파일 선택…', exact: true }).click();
  await expect(place.getByRole('alert')).toHaveText('Git이 아닙니다: D:\\x.exe');
  await expect(place).toContainText('(자동으로 찾음)');
});

test('a saved file that is gone is shown as the problem, not replaced', async ({ page }) => {
  await open(page, {
    program: {
      chosen: 'D:\\gone\\git.exe',
      found: 'C:\\Git\\git.exe',
      version: null,
      problem: '지정한 Git 파일이 없습니다: D:\\gone\\git.exe',
    },
  });
  const place = page.getByRole('region', { name: 'Git 위치', exact: true });
  await expect(place.getByRole('alert')).toContainText('지정한 Git 파일이 없습니다');
  await expect(place).toContainText('(직접 지정)');
  await expect(place).toContainText('C:\\Git\\git.exe');
});

test('tells how to install Git when none is found', async ({ page }) => {
  await open(page, { program: { chosen: null, found: null, version: null, problem: null } });
  await expect(page.getByRole('region', { name: 'Git 위치', exact: true })).toContainText(
    '이 PC에서 git을 찾지 못했습니다.',
  );
});

test('the preview follows the display settings and they are saved', async ({ page }) => {
  await open(page);
  const preview = page.getByRole('group', { name: '표시 미리보기', exact: true });
  const badge = preview.getByTestId('preview-badge');
  const status = preview.getByTestId('preview-status');
  await expect(badge).toHaveText('⎇ main ●2');
  await expect(status).toHaveText('main ●2');
  await expect(preview.locator('.file-git-mark')).toHaveCount(3);
  await expect(preview.locator('[data-git-name]')).toHaveCount(0);

  await page.getByLabel('표시 내용', { exact: true }).selectOption('sync');
  await expect(badge).toHaveText('⎇ main ●2 ↑1 ↓2');
  await expect(status).toHaveText('main ●2 ↑1 ↓2');
  await page.getByLabel('표시 내용', { exact: true }).selectOption('branch');
  await expect(badge).toHaveText('⎇ main');
  await expect(status).toHaveText('main');

  await page.getByLabel('파일 트리', { exact: true }).selectOption('color');
  await expect(preview.locator('.file-git-mark')).toHaveCount(0);
  await expect(preview.locator('[data-git-name="M"]')).toHaveCount(1);

  await page.getByLabel('추적 안 함 파일', { exact: true }).selectOption('files');
  await expect(preview).toContainText('notes/회의.txt');

  await page.getByLabel('터미널 안 브랜치', { exact: true }).selectOption('off');
  await expect(badge).toHaveCount(0);
  await page.getByLabel('상태바 표시', { exact: true }).uncheck();
  await expect(status).toHaveText('상태바에 표시하지 않음');

  const saved = await page.evaluate(() => ({
    display: JSON.parse(localStorage.getItem('dachsterm.gitDisplay')!),
    terminal: JSON.parse(localStorage.getItem('dachsterm.terminalPreferences')!),
  }));
  expect(saved.display).toEqual({
    detail: 'branch',
    treeMarks: 'color',
    statusBar: false,
    untracked: 'files',
  });
  expect(saved.terminal.promptBranch).toBe('off');
});

test('the credentials moved here keep their controls', async ({ page }) => {
  await open(page);
  await expect(
    page.getByRole('region', { name: '저장한 Git 자격 증명', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel('WSL 탭에 이 PC의 HTTPS Git 자격 증명 제공', { exact: true }),
  ).not.toBeChecked();
  await expect(page.getByLabel('Git 상태 자동 조회', { exact: true })).toBeChecked();
});
