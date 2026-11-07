import { test, expect } from '@playwright/test';
import { openTools } from './helpers';

for (const width of [1280, 560, 360]) {
  test(`local entry, sidebar and menu keyboard at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await page.goto('/');
    const sidebar = page.getByRole('complementary', { name: '세션 탐색' });
    const toggle = page.getByRole('button', { name: '사이드바', exact: true });
    if (!(await sidebar.isVisible())) await toggle.click();
    await expect(sidebar.getByRole('region', { name: '로컬' })).toBeVisible();
    await page.keyboard.press('Control+Shift+L');
    const local = page.getByRole('dialog', { name: '로컬 터미널 열기' });
    await expect(local).toBeVisible();
    await expect(local).toContainText('데스크톱 앱');
    await page.keyboard.press('Control+Shift+N');
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await page.keyboard.press('Escape');
    // The title bar button folds the sidebar.
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.click();
    await expect(sidebar).toBeHidden();
    await page.reload();
    await expect(sidebar).toBeHidden();
    await page.keyboard.press('Control+Shift+O');
    await expect(sidebar).toBeVisible();
    await expect(page.getByRole('searchbox')).toBeFocused();
    const tools = page.locator('.toolbar-menu > summary').filter({ hasText: '도구' });
    await tools.focus();
    await page.keyboard.press('Enter');
    const games = page.getByRole('navigation', { name: '게임 목록' });
    await expect(games).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(tools).toBeFocused();
    await expect(games).toBeHidden();
    // The header tools each have a button and a key.
    await page.keyboard.press('Control+Shift+Slash');
    await expect(page.getByRole('dialog', { name: '키보드 단축키' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '키보드 단축키', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '키보드 단축키' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+Comma');
    await expect(page.getByRole('dialog', { name: '설정', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await openTools(page);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/navigation-${width}.png` });
  });
}
