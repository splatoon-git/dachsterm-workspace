import { expect, test } from '@playwright/test';
import type {} from './fixtures/local-files';

test('a local folder offers what the app adds for folders, and a file does not', async ({
  page,
}) => {
  await page.goto('/tests/ui/fixtures/local-files.html');
  await page.getByText('project', { exact: true }).click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: '여기서 채팅 열기' })).toBeVisible();
  await menu.getByRole('menuitem', { name: '여기서 채팅 열기' }).click();
  expect(await page.evaluate(() => window.__chatHere)).toEqual(['/home/u/project']);

  await page.getByText('notes.txt', { exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem', { name: '여기서 채팅 열기' })).toHaveCount(0);
});
