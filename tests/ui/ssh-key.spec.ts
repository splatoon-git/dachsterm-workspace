import { expect, test, type Locator, type Page } from '@playwright/test';
import type {} from './fixtures/ssh-key';
import { openTools } from './helpers';

const fixture = '/tests/ui/fixtures/ssh-key.html';
const state = (page: Page) => page.evaluate(() => window.__sshKey);
const callsOf = async (page: Page, command: string) =>
  (await state(page)).calls.filter((call) => call.command === command);

async function openDialog(page: Page, from: Locator) {
  await from.getByRole('button', { name: '새 키…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'SSH 키 만들기', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('저장 폴더', { exact: true })).toHaveValue('C:\\Users\\me\\.ssh');
  return dialog;
}

test('the tools menu opens the key dialog', async ({ page }) => {
  await page.goto('/');
  await openTools(page);
  await page
    .locator('.toolbar-menu-items')
    .getByRole('button', { name: 'SSH 키 만들기', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'SSH 키 만들기', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.locator('.toolbar-menu')).not.toHaveAttribute('open');
  await expect(dialog.getByLabel('파일 이름', { exact: true })).toHaveValue('id_ed25519');
  // Without the desktop app the defaults cannot be read, and the reason is shown.
  await expect(dialog.getByRole('alert')).toContainText('데스크톱 앱');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('a key made in a form fills the login path without submitting the form', async ({ page }) => {
  await page.goto(fixture);
  const dialog = await openDialog(page, page.locator('.login-key-field'));
  await expect(dialog.getByLabel('주석', { exact: true })).toHaveValue('me@pc');
  await dialog.getByLabel('파일 이름', { exact: true }).fill('id_new');
  await dialog.getByLabel('Passphrase (선택)', { exact: true }).fill('one');
  await dialog.getByLabel('Passphrase 확인', { exact: true }).fill('two');
  await dialog.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('서로 다릅니다');
  expect(await callsOf(page, 'ssh_key_generate')).toEqual([]);

  await dialog.getByLabel('Passphrase 확인', { exact: true }).fill('one');
  await dialog.getByRole('button', { name: '찾아보기…', exact: true }).click();
  await expect(dialog.getByLabel('저장 폴더', { exact: true })).toHaveValue('D:\\keys');
  await dialog.getByRole('button', { name: '만들기', exact: true }).click();
  // By role: `getByLabel` counts a textarea's own text as part of its label.
  await expect(dialog.getByRole('textbox', { name: '공개키', exact: true })).toHaveValue(
    'ssh-ed25519 AAAAC3Nza me@pc',
  );
  await expect(dialog).toContainText('C:\\Users\\me\\.ssh\\id_new');
  await expect(dialog).toContainText('SHA256:abcdef');
  expect((await callsOf(page, 'ssh_key_generate'))[0].args).toEqual({
    name: 'id_new',
    comment: 'me@pc',
    passphrase: 'one',
    folder: 'D:\\keys',
  });
  await dialog.getByRole('button', { name: '공개키 복사', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '복사했습니다', exact: true })).toBeVisible();
  expect((await callsOf(page, 'clipboard_write_text'))[0].args).toEqual({
    text: 'ssh-ed25519 AAAAC3Nza me@pc',
  });
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  const final = await state(page);
  expect(final.keyPath).toBe('C:\\Users\\me\\.ssh\\id_new');
  expect(final.submits).toBe(0);
});

test('a key made beside the key list joins the list', async ({ page }) => {
  await page.goto(fixture);
  const dialog = await openDialog(page, page.locator('.key-file-add'));
  await dialog.getByRole('button', { name: '만들기', exact: true }).click();
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  const row = page.getByRole('list', { name: '추가 키' }).getByRole('listitem');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('id_new');
  await expect(row).toContainText('SHA256:abcdef');
  expect((await state(page)).keys).toEqual([{ path: 'C:\\Users\\me\\.ssh\\id_new' }]);
});

test('a refused key stays on the form with the reason', async ({ page }) => {
  await page.goto(fixture);
  await page.evaluate(() => {
    window.__sshKey.failure = '같은 이름의 키 파일이 있습니다.';
  });
  const dialog = await openDialog(page, page.locator('.login-key-field'));
  await dialog.getByRole('button', { name: '만들기', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('같은 이름');
  await expect(dialog.getByLabel('파일 이름', { exact: true })).toBeVisible();
  expect((await state(page)).keyPath).toBe('');
});

test('the dialog fits a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto(fixture);
  const dialog = await openDialog(page, page.locator('.login-key-field'));
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const browse = dialog.getByRole('button', { name: '찾아보기…', exact: true });
  await browse.scrollIntoViewIfNeeded();
  await expect(browse).toBeInViewport();
});
