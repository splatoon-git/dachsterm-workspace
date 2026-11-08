// GE.8: the diff tab on real repositories, through this PC's git and a WSL distribution's. Run by
// `test-local-native.mjs --git-diff-only` (`npm run test:git-diff`) after building the app.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { showSidebarView } from './native-workspace.mjs';

const cell = '.pane-cell:not([hidden]) ';

function helpers(page) {
  const git = page.locator('#git-sidebar');
  const group = (name) => git.getByRole('region', { name, exact: true });
  return {
    group,
    rows: (name) => group(name).locator('.git-row'),
    tab: (name) => page.getByRole('tab', { name, exact: true }),
    dirty: (name) => page.getByRole('tab', { name: `${name} 저장 안 됨` }),
    left: page.locator(`${cell}.editor.original .view-lines`),
    // One column draws deleted lines inside the modified editor, in a `.view-lines` of their own.
    right: page.locator(`${cell}.editor.modified .view-lines:not(.line-delete)`),
    labels: page.locator(`${cell}[data-diff-labels] span`),
  };
}

async function typeAtEnd(page, right, value) {
  await right.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(value);
}

async function checkThisPc(page, command, pane, directory) {
  const repo = path.join(await realpath(directory), 'diff repo');
  await mkdir(repo, { recursive: true });
  const git = (...args) => {
    const done = spawnSync(
      'git',
      ['-C', repo, '-c', 'user.name=probe', '-c', 'user.email=probe@example.invalid', ...args],
      { encoding: 'utf8' },
    );
    assert.equal(done.status, 0, done.stderr);
  };
  git('init', '-q', '-b', 'ge8');
  const file = path.join(repo, 'a.txt');
  await writeFile(file, 'base\n');
  git('add', '.');
  git('commit', '-q', '--no-gpg-sign', '-m', 'one');
  await writeFile(file, 'staged\n');
  git('add', '.');
  await writeFile(file, 'working\n');
  await writeFile(path.join(repo, 'new.txt'), 'brandnew\n');

  await command(pane, `Set-Location '${repo}'; Write-Output ('DIFF' + '_HERE')`, 'DIFF_HERE');
  await showSidebarView(page, 'Git');
  const { group, rows, tab, dirty, left, right, labels } = helpers(page);
  await expect(group('스테이지됨').locator('.git-row-name')).toHaveText(['a.txt'], {
    timeout: 15000,
  });

  await rows('스테이지됨').click();
  await expect(tab('a.txt ↔ HEAD')).toHaveCSS('font-style', 'italic');
  await expect(labels).toHaveText(['HEAD', '인덱스']);
  await expect(left).toContainText('base', { timeout: 30000 });
  await expect(right).toContainText('staged');
  console.log('PASS this PC: a staged row compares HEAD with the index');

  await rows('변경').click();
  await expect(tab('a.txt ↔ 인덱스')).toBeVisible();
  await expect(tab('a.txt ↔ HEAD')).toHaveCount(0);
  await expect(labels).toHaveText(['인덱스', '작업 트리']);
  await expect(left).toContainText('staged');
  await expect(right).toContainText('working');
  console.log('PASS this PC: a changed row compares the index with the working tree, as a preview');

  await rows('추적 안 함').click();
  await expect(tab('new.txt (새 파일)')).toBeVisible();
  await expect(labels).toHaveText(['없음', '작업 트리']);
  await expect(right).toContainText('brandnew');
  console.log('PASS this PC: an untracked row shows the new file');

  await rows('변경').dblclick();
  const title = 'a.txt ↔ 인덱스';
  await expect(tab(title)).toHaveCSS('font-style', 'normal');
  await expect(right).toContainText('working');
  await typeAtEnd(page, right, 'EDIT');
  await expect(dirty(title)).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(dirty(title)).toHaveCount(0, { timeout: 15000 });
  await expect.poll(() => readFile(file, 'utf8')).toMatch(/working\r?\nEDIT/);
  console.log('PASS this PC: the working tree side saves into the real file');

  await rows('변경').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '스테이지', exact: true }).click();
  await expect(group('변경')).toHaveCount(0, { timeout: 15000 });
  await expect(left).toContainText('EDIT', { timeout: 15000 });
  console.log('PASS this PC: staging from the Git view moves the open diff to the new index');

  await typeAtEnd(page, right, 'MORE');
  await page.keyboard.press('Control+s');
  await expect(dirty(title)).toHaveCount(0, { timeout: 15000 });
  await expect(group('변경').locator('.git-row-name')).toHaveText(['a.txt'], { timeout: 15000 });
  console.log('PASS this PC: a save from the tab updates the Git view without a new prompt');

  const switcher = page.locator(cell).getByRole('group', { name: 'diff 보기 방식' });
  await switcher.getByText('한 줄').click();
  await expect(page.locator(`${cell}.monaco-diff-editor.side-by-side`)).toHaveCount(0);
  await expect(right).toContainText('MORE');
  await switcher.getByText('좌우').click();
  await expect(page.locator(`${cell}.monaco-diff-editor.side-by-side`)).toHaveCount(1);
  console.log('PASS this PC: side by side and one column');
  await page.getByRole('button', { name: `${title} 탭 닫기` }).click();
  await checkCommitFile(page, git);
}

/** GE.15: a commit opens to its files, and a file opens the commit's own two sides. */
async function checkCommitFile(page, git) {
  git('commit', '-q', '--no-gpg-sign', '-m', 'two');
  const view = page.locator('#git-sidebar');
  await view.getByRole('button', { name: 'Git 새로 고침' }).click();
  const { tab, left, right, labels } = helpers(page);
  const commit = view.locator('.git-graph-row', { hasText: 'two' });
  await expect(commit).toBeVisible({ timeout: 15000 });

  await commit.hover();
  const card = page.getByRole('group', { name: '커밋 정보' });
  await expect(card.locator('.git-commit-card-stat')).toContainText('파일 1개', { timeout: 15000 });
  await expect(card.locator('.git-commit-card-message')).toHaveText('two');
  console.log('PASS this PC: hovering a commit shows its card with the changed line counts');

  await commit.click();
  const file = view.locator('.git-graph-detail .git-row');
  await expect(file.locator('.git-row-name')).toHaveText('a.txt', { timeout: 15000 });
  await file.click();
  const title = /^a\.txt \([0-9a-f]{7}\)$/;
  await expect(page.getByRole('tab', { name: title })).toHaveCSS('font-style', 'italic');
  await expect(labels).toHaveText([/^[0-9a-f]{7}$/, /^[0-9a-f]{7}$/]);
  await expect(left).toContainText('base', { timeout: 30000 });
  await expect(right).toContainText('EDIT');
  console.log('PASS this PC: a file in the graph previews the commit against its parent');

  await view.getByRole('button', { name: '표시 범위 자동' }).click();
  await expect(view.getByRole('button', { name: '표시 범위 모두' })).toBeVisible();
  await expect(commit).toBeVisible({ timeout: 15000 });
  await view.getByRole('button', { name: '표시 범위 모두' }).click();
  console.log('PASS this PC: the graph can show every branch');

  const handle = view.getByRole('separator', { name: '변경 목록과 그래프 크기' });
  const box = await handle.boundingBox();
  const changes = view.locator('.git-view-body');
  const before = (await changes.boundingBox()).height;
  await page.mouse.move(box.x + 40, box.y + 1);
  await page.mouse.down();
  await page.mouse.move(box.x + 40, box.y - 30, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await changes.boundingBox()).height).toBeLessThan(before - 20);
  await handle.dblclick();
  console.log('PASS this PC: the handle resizes the files and the graph');

  await page.getByRole('button', { name: /a\.txt \([0-9a-f]{7}\) 탭 닫기/ }).click();
  await expect(tab('a.txt ↔ 인덱스')).toHaveCount(0);
}

async function checkWsl(page, command, { linux }) {
  await command(
    linux,
    `cd "$(mktemp -d)" && git init -q -b ge8 && printf 'wslbase\\n' > a.txt && git add . && ` +
      `git -c user.name=p -c user.email=p@example.invalid commit -q --no-gpg-sign -m one && ` +
      `printf 'wslwork\\n' > a.txt && printf 'DIFF%s\\n' _WSL`,
    'DIFF_WSL',
  );
  await showSidebarView(page, 'Git');
  const { rows, tab, dirty, left, right } = helpers(page);
  await expect(rows('변경')).toHaveCount(1, { timeout: 15000 });
  await rows('변경').click();
  const title = 'a.txt ↔ 인덱스';
  await expect(tab(title)).toBeVisible();
  await expect(left).toContainText('wslbase', { timeout: 30000 });
  await expect(right).toContainText('wslwork');
  console.log('PASS WSL: the index is read through the distribution, the file through its path');

  await typeAtEnd(page, right, 'WSLSAVED');
  await expect(dirty(title)).toBeVisible();
  await page.keyboard.press('Control+s');
  await expect(dirty(title)).toHaveCount(0, { timeout: 15000 });
  await page.getByRole('button', { name: `${title} 탭 닫기` }).click();
  await command(linux, `cat a.txt && printf 'CAT%s\\n' _DONE`, /WSLSAVED[^]*CAT_DONE/);
  console.log('PASS WSL: the working tree side saves into the distribution');
}

export async function checkGitDiff(page, command, pane, directory, openWsl) {
  await checkThisPc(page, command, pane, directory);
  await showSidebarView(page, '연결');
  const wsl = await openWsl();
  if (!wsl) {
    console.log('WSL user distribution absent: WSL diff tab pending.');
    return;
  }
  await checkWsl(page, command, wsl);
}
