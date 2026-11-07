import { test, expect } from '@playwright/test';
for (const width of [1280, 560])
  test(`session editor labels, focus and transient secret at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await page.goto('/');
    await page.locator('header').getByRole('button', { name: '＋ 새 연결', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '새 연결' });
    await expect(dialog.getByLabel('이름', { exact: true })).toBeFocused();
    const actionHeights = await dialog
      .locator('form > .form-actions button')
      .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
    expect(actionHeights).toEqual([32, 32, 32]);
    await dialog.getByLabel('이름', { exact: true }).fill('테스트');
    await dialog.getByLabel('호스트', { exact: true }).fill('localhost');
    await dialog.getByLabel('사용자', { exact: true }).fill('test');
    await dialog.getByLabel('인증정보 보관', { exact: true }).selectOption('keep');
    await dialog.getByLabel('비밀번호', { exact: true }).fill('not-a-real-credential');
    await dialog.getByRole('button', { name: '저장', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('데스크톱 앱');
    await expect(dialog.getByLabel('비밀번호', { exact: true })).toHaveValue('');
    expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });
for (const width of [1280, 800, 560])
  test(`layout and keyboard at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: '작업 영역으로 이동' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
    await page.locator('.toolbar-menu > summary').filter({ hasText: '보기' }).click();
    await page
      .locator('header')
      .getByRole('button', { name: '터미널 미리보기', exact: true })
      .click();
    await expect(page.locator('.xterm-screen')).toBeVisible();
    await page.screenshot({ path: `test-results/terminal-${width}.png` });
    // A chosen menu item closes the menu, so open it again.
    await page.locator('.toolbar-menu > summary').filter({ hasText: '보기' }).click();
    await page.getByRole('button', { name: '작업 화면', exact: true }).click();
    await page.screenshot({ path: `test-results/welcome-${width}.png` });
  });
test('replacement theme updates existing UI and terminal without component changes', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.toolbar-menu > summary').filter({ hasText: '보기' }).click();
  await page
    .locator('header')
    .getByRole('button', { name: '터미널 미리보기', exact: true })
    .click();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await page.evaluate(async () => {
    // A new definition needs no component changes, including after mounting a terminal.
    const modulePath = '/src/themes/registry.ts';
    const { themes } = await import(modulePath);
    const theme = structuredClone(themes[0]);
    theme.id = 'test-only';
    theme.color.surface.panel = '#E0F1E5';
    theme.terminal.background = '#D5E4F0';
    themes.push(theme);
    localStorage.setItem('dachsterm.theme', theme.id);
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'dachsterm.theme', newValue: theme.id }),
    );
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'test-only');
  await expect(page.locator('.toolbar')).toHaveCSS('background-color', 'rgb(224, 241, 229)');
  await expect(page.locator('.xterm-scrollable-element')).toHaveCSS(
    'background-color',
    'rgb(213, 228, 240)',
  );
});
