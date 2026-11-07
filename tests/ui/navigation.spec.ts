import { test, expect } from '@playwright/test';

for (const width of [1280, 560, 360]) {
  test(`local entry, sidebar and menu keyboard at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await page.goto('/');
    const sidebar = page.getByRole('complementary', { name: '세션 탐색' });
    if (!(await sidebar.isVisible()))
      await page.getByRole('tab', { name: '연결', exact: true }).click();
    await expect(sidebar.getByRole('region', { name: '로컬 환경' })).toBeVisible();
    await page.keyboard.press('Control+Shift+L');
    const local = page.getByRole('dialog', { name: '로컬 터미널 열기' });
    await expect(local).toBeVisible();
    await expect(local).toContainText('데스크톱 앱');
    await page.keyboard.press('Control+Shift+N');
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await page.keyboard.press('Escape');
    // The icon of the open view folds the sidebar.
    await page.getByRole('tab', { name: '연결', exact: true }).click();
    await expect(sidebar).toBeHidden();
    await page.reload();
    await expect(sidebar).toBeHidden();
    await page.keyboard.press('Control+Shift+O');
    await expect(sidebar).toBeVisible();
    await expect(page.getByRole('searchbox')).toBeFocused();
    const view = page.locator('.toolbar-menu > summary').filter({ hasText: '보기' });
    await view.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: '키보드 단축키' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(view).toBeFocused();
    await expect(page.getByRole('button', { name: '키보드 단축키' })).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/navigation-${width}.png` });
  });
}
