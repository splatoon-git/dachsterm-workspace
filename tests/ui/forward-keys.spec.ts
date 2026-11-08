import { expect, test } from '@playwright/test';
import type {} from './fixtures/forward-keys';

test('each key is one row with its menu on the right, and the menu removes it', async ({
  page,
}) => {
  await page.goto('/tests/ui/fixtures/forward-keys.html');
  const rows = page.getByRole('list', { name: '추가 키' }).getByRole('listitem');
  await expect(rows).toHaveCount(2);
  const git = rows.filter({ hasText: 'id_git' });
  await expect(git).toContainText('Passphrase 저장됨');
  await expect(rows.filter({ hasText: 'id_work' })).not.toContainText('저장됨');
  // Without the desktop app the details are the reason they could not be read.
  await expect(git).toContainText('데스크톱 앱');
  const more = git.getByRole('button', { name: 'id_git 작업', exact: true });
  const [row, button] = [(await git.boundingBox())!, (await more.boundingBox())!];
  expect(button.y).toBeLessThan(row.y + row.height / 2);
  expect(button.x + button.width).toBeGreaterThan(row.x + row.width - 4);
  await more.click();
  await page.getByRole('menuitem', { name: '빼기', exact: true }).click();
  await expect(rows).toHaveCount(1);
  expect(await page.evaluate(() => window.__forwardProfile.forwardKeys)).toEqual([
    { path: '/Users/me/.ssh/id_work' },
  ]);
  await rows.first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: '빼기', exact: true }).click();
  await expect(rows).toHaveCount(0);
});

test('a narrow form keeps every control inside', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto('/tests/ui/fixtures/forward-keys.html');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(360);
  await expect(page.getByRole('button', { name: '추가', exact: true })).toBeInViewport();
});
