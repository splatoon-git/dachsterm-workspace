import { expect, test } from '@playwright/test';

test('settings have an update category that needs the desktop app', async ({ page }) => {
  await page.goto('/');
  // Without a backend nothing is checked, so the title bar has no update notice.
  await expect(page.locator('.update-badge')).toHaveCount(0);
  await page.keyboard.press('Control+Comma');
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  await settings.getByRole('tab', { name: '업데이트' }).click();
  const panel = settings.getByRole('tabpanel');
  await expect(panel.getByRole('heading', { name: '업데이트' })).toBeVisible();
  await expect(panel).toContainText('데스크톱 앱에서 새 버전을 확인하고 설치합니다.');
  await expect(panel.getByRole('button', { name: '지금 확인' })).toHaveCount(0);
});
