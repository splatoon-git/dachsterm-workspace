// Settings → Git in the real app (GE.10). Every write goes to a file the caller made safe to
// change: a scratch global file for this PC and WSL, or the OpenSSH fixture's own home.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { openSettings, showSidebarView } from './native-workspace.mjs';

const editorOf = (settings) => settings.getByRole('region', { name: 'Git 설정 편집', exact: true });
const close = (settings) => settings.getByRole('button', { name: '대화상자 닫기' }).click();

/** The target must offer what `read` looks at, and the write must reach only what changed. */
export async function checkGitConfigTarget(page, { match, read, marker, style = 'zdiff3' }) {
  const settings = await openSettings(page, 'Git');
  const editor = editorOf(settings);
  const select = editor.getByLabel('Git 설정 대상', { exact: true });
  await expect
    .poll(() => select.locator('option').allTextContents(), { timeout: 15000 })
    .toContainEqual(expect.stringMatching(match));
  const label = (await select.locator('option').allTextContents()).find((t) => match.test(t));
  await select.selectOption({ label });
  const name = editor.getByLabel('이름 (user.name)', { exact: true });
  await expect(name).toBeEnabled({ timeout: 15000 });
  const before = read('user.name');
  assert.notEqual(before, marker);

  await name.fill(marker);
  await editor.getByLabel('충돌 표시 (merge.conflictStyle)', { exact: true }).selectOption(style);
  await editor.getByRole('button', { name: '변경 2개 검토…', exact: true }).click();
  const review = editor.getByRole('group', { name: '실행할 명령 확인', exact: true });
  const commands = (await review.locator('pre').innerText()).split('\n');
  assert.equal(commands.length, 2, commands.join('\n'));
  assert.ok(commands[0].startsWith('git config --global user.name '), commands[0]);
  assert.ok(commands[0].includes(marker), commands[0]);
  assert.equal(commands[1], `git config --global merge.conflictStyle ${style}`);
  assert.equal(read('user.name'), before, 'nothing runs before the confirmation');

  await review.getByRole('button', { name: '실행', exact: true }).click();
  await expect(editor.getByRole('status')).toHaveText('적용했습니다.', { timeout: 15000 });
  assert.equal(read('user.name'), marker);
  assert.equal(read('merge.conflictstyle'), style);
  await expect(name).toHaveValue(marker);
  await close(settings);
  console.log(`PASS Git settings read and write: ${label}`);
}

/** Git location: the found one, a file that is no git, a picked one, and back. */
export async function checkGitProgram(page, invoke) {
  const attempt = (args) =>
    page.evaluate(
      (args) =>
        window.__TAURI_INTERNALS__
          .invoke('git_program_set', args)
          .then((info) => ({ info }))
          .catch((error) => ({ error: String(error) })),
      args,
    );
  const auto = await invoke('git_program_info');
  assert.ok(auto.found, 'this PC has a git to find');
  assert.match(auto.version, /^git version/);
  assert.equal(auto.chosen, null);
  let settings = await openSettings(page, 'Git');
  let place = settings.getByRole('region', { name: 'Git 위치', exact: true });
  await expect(place).toContainText(auto.version);
  await expect(place).toContainText('(자동으로 찾음)');
  await close(settings);

  const notGit = path.join(process.env.SystemRoot, 'System32', 'hostname.exe');
  const refused = await attempt({ path: notGit });
  assert.match(refused.error ?? '', /Git이 아닙니다/);
  const missing = await attempt({ path: 'C:\\no-such-folder\\git.exe' });
  assert.match(missing.error ?? '', /지정한 Git 파일이 없습니다/);
  assert.equal((await invoke('git_program_info')).chosen, null, 'a refused file changes nothing');

  const inner = path.resolve(path.dirname(auto.found), '..', 'mingw64', 'bin', 'git.exe');
  const picked = existsSync(inner) ? inner : auto.found;
  const set = await attempt({ path: picked });
  assert.equal(set.info?.chosen, picked, set.error);
  assert.match(set.info.version, /^git version/);
  settings = await openSettings(page, 'Git');
  place = settings.getByRole('region', { name: 'Git 위치', exact: true });
  await expect(place).toContainText('(직접 지정)');
  await expect(place).toContainText(picked);
  await place.getByRole('button', { name: '자동 찾기로 되돌리기', exact: true }).click();
  await expect(place).toContainText('(자동으로 찾음)');
  await close(settings);
  assert.equal((await invoke('git_program_info')).chosen, null);
  console.log(`PASS Git location: found, refused, picked ${picked}, automatic again`);
}

/** The settings moved here leave only a link where they were. */
export async function checkMovedSettings(page) {
  const settings = await openSettings(page, '터미널');
  const git = settings.getByRole('tab', { name: 'Git', exact: true });
  await expect(settings.getByLabel('Git 상태 자동 조회', { exact: true })).toHaveCount(0);
  await settings.getByRole('button', { name: '설정 → Git', exact: true }).click();
  await expect(git).toHaveAttribute('aria-selected', 'true');
  await expect(settings.getByLabel('Git 상태 자동 조회', { exact: true })).toBeChecked();
  await settings.getByRole('tab', { name: '에이전트', exact: true }).click();
  await expect(settings.getByRole('region', { name: '저장한 Git 자격 증명' })).toHaveCount(0);
  await settings.getByRole('button', { name: '설정 → Git', exact: true }).click();
  await expect(settings.getByRole('region', { name: '저장한 Git 자격 증명' })).toBeVisible();
  await close(settings);
  console.log('PASS the settings that moved leave only a link');
}

/** The Git view's menu opens this repository's own settings. */
export async function checkRepositorySettings(page, { read, marker }) {
  await showSidebarView(page, 'Git');
  const view = page.locator('#git-sidebar');
  // The menu offers this only once the repository is known.
  await expect(view.locator('.git-view-branch')).toContainText('ge10', { timeout: 15000 });
  await view.getByRole('button', { name: 'Git 더 보기', exact: true }).click();
  await page.getByRole('menuitem', { name: '이 저장소의 Git 설정…', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  const editor = editorOf(settings);
  const select = editor.getByLabel('Git 설정 대상', { exact: true });
  await expect(select).toHaveValue('repo');
  const name = editor.getByLabel('이름 (user.name)', { exact: true });
  await expect(name).toBeEnabled({ timeout: 15000 });
  await expect(editor.getByLabel('신뢰하는 폴더 (safe.directory)', { exact: true })).toHaveCount(0);
  await name.fill(marker);
  await editor.getByRole('button', { name: '변경 1개 검토…', exact: true }).click();
  const review = editor.getByRole('group', { name: '실행할 명령 확인', exact: true });
  await expect(review.locator('pre')).toContainText('git config --local user.name');
  await review.getByRole('button', { name: '실행', exact: true }).click();
  await expect(editor.getByRole('status')).toHaveText('적용했습니다.', { timeout: 15000 });
  assert.equal(read('user.name'), marker);
  await close(settings);
  console.log('PASS the Git view opens the repository scope and writes only there');
}

/** What the display settings change outside the settings window. */
export async function checkDisplaySettings(page) {
  const status = page.locator('.status-bar .status-git');
  await expect(status).toHaveText('ge10 ●1', { timeout: 15000 });
  const settings = await openSettings(page, 'Git');
  await settings.getByLabel('추적 안 함 파일', { exact: true }).selectOption('files');
  await settings.getByLabel('표시 내용', { exact: true }).selectOption('branch');
  await close(settings);
  await expect(status).toHaveText('ge10');
  const reopened = await openSettings(page, 'Git');
  await reopened.getByLabel('표시 내용', { exact: true }).selectOption('changes');
  await close(reopened);
  await status.click();
  await expect(status).toHaveText('ge10 ●2', { timeout: 15000 });
  const last = await openSettings(page, 'Git');
  await last.getByLabel('상태바 표시', { exact: true }).uncheck();
  await close(last);
  await expect(status).toHaveCount(0);
  const again = await openSettings(page, 'Git');
  await again.getByLabel('상태바 표시', { exact: true }).check();
  await close(again);
  await expect(status).toHaveText('ge10 ●2');
  console.log('PASS display settings: detail, untracked files, status bar');
}
