import { expect, test } from '@playwright/test';

for (const width of [1280, 800, 560, 360]) {
  test(`unified left sidebar, shortcuts and restart view at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await page.goto('/');
    const toggle = page.getByRole('button', { name: '사이드바', exact: true });
    const sidebar = page.locator('#workspace-sidebar');
    if (width <= 700) {
      await expect(sidebar).toBeHidden();
      await toggle.click();
    }
    const connections = page.getByRole('tab', { name: '연결', exact: true });
    const files = page.getByRole('tab', { name: '파일', exact: true });
    await connections.focus();
    await page.keyboard.press('ArrowRight');
    await expect(files).toBeFocused();
    await expect(files).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('complementary', { name: '세션 탐색' })).toBeHidden();
    await expect(page.getByRole('complementary', { name: 'SFTP 파일 탐색' })).toBeVisible();
    const bounds = await sidebar.boundingBox();
    expect(bounds!.x).toBe(0);
    expect(bounds!.width).toBeGreaterThanOrEqual(280);
    expect(await sidebar.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    if (width > 700) {
      const main = await page.locator('main').boundingBox();
      expect(main!.x).toBeGreaterThan(bounds!.width);
      expect(main!.width).toBeGreaterThan(400);
      const handle = page.getByRole('separator', { name: '사이드바 너비' });
      await handle.focus();
      await page.keyboard.press('ArrowRight');
      await expect(handle).toHaveAttribute('aria-valuenow', '314');
    }
    await page.reload();
    if (width <= 700) await toggle.click();
    // No tab survives a restart, so the empty file view must not be what opens.
    await expect(connections).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Control+Shift+O');
    await expect(page.getByRole('searchbox')).toBeFocused();
    await page.getByRole('searchbox').fill('missing-server');
    await page.keyboard.press('Control+Shift+E');
    await expect(files).toHaveAttribute('aria-selected', 'true');
    await connections.click();
    await expect(page.getByRole('searchbox')).toHaveValue('missing-server');
    await page.screenshot({ path: `test-results/unified-sidebar-${width}.png` });
    if (width <= 700) {
      await page
        .getByRole('button', { name: '사이드바 닫기', exact: true })
        .click({ position: { x: width - 5, y: 40 } });
      await expect(sidebar).toBeHidden();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test('a game fits a split group, pauses without the keyboard and keeps the preview beside it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/');
  await page.locator('.toolbar-menu > summary').filter({ hasText: '보기' }).click();
  await page.getByRole('button', { name: '터미널 미리보기', exact: true }).click();
  await page.locator('.sidebar-games summary').click();
  await page
    .getByRole('navigation', { name: '게임 목록' })
    .getByRole('button', { name: '블록 퍼즐', exact: true })
    .click();
  await page.locator('.toolbar-menu > summary').filter({ hasText: '보기' }).click();
  await page.getByRole('button', { name: '모든 탭 좌우', exact: true }).click();
  const terminal = page.locator('.xterm');
  const game = page.getByRole('tabpanel', { name: '블록 퍼즐', exact: true });
  await expect(terminal).toBeVisible();
  await expect(game).toBeVisible();
  expect(await game.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/game-in-split.png' });
  await game.getByRole('button', { name: '게임 시작', exact: true }).click();
  await terminal.click();
  await expect(game).toBeVisible();
  await game.click({ position: { x: 5, y: 5 } });
  await expect(game.getByRole('button', { name: '계속하기', exact: true })).toBeVisible();
  await game.press('Escape');
  await expect(page.getByRole('tab', { name: '블록 퍼즐', exact: true })).toBeVisible();
});

test('the start page opens in a saved split and a preset menu closes after use', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('dachsterm.layout', 'grid'));
  await page.reload();
  await expect(page.getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
  await expect(page.locator('.tab-strip')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: '시작하기', exact: true })).toBeVisible();
  const menu = page.locator('.toolbar-menu').filter({ hasText: '보기' });
  await menu.locator('summary').click();
  await page.getByRole('button', { name: '터미널 미리보기', exact: true }).click();
  await expect(page.locator('.tab-strip')).toHaveCount(4);
  await expect(page.getByRole('tab', { name: '시작하기', exact: true })).toHaveCount(0);
  await expect(menu).not.toHaveAttribute('open');
  await menu.locator('summary').click();
  await page.getByRole('button', { name: '모든 탭 상하', exact: true }).click();
  await expect(menu).not.toHaveAttribute('open');
  await expect(page.locator('.tab-strip')).toHaveCount(2);
});

test('switching the sidebar preserves the existing terminal renderer', async ({ page }) => {
  await page.goto('/');
  await page.locator('.toolbar-menu > summary').filter({ hasText: '보기' }).click();
  await page.getByRole('button', { name: '터미널 미리보기', exact: true }).click();
  await page.keyboard.press('Escape');
  const terminal = page.locator('.xterm');
  await expect(terminal).toBeVisible();
  await terminal.evaluate((e) => e.setAttribute('data-instance', 'original'));
  await page.getByRole('tab', { name: '파일', exact: true }).click();
  await page.getByRole('tab', { name: '연결', exact: true }).click();
  await page.getByRole('button', { name: '사이드바', exact: true }).click();
  await expect(terminal).toHaveAttribute('data-instance', 'original');
  await expect(terminal).toBeVisible();
});

test('fullscreen focuses the workspace and restores the sidebar without replacing the terminal', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.toolbar-menu > summary').filter({ hasText: '보기' }).click();
  await page.getByRole('button', { name: '터미널 미리보기', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.locator('.xterm').evaluate((e) => e.setAttribute('data-instance', 'original'));
  await page.keyboard.press('F11');
  await expect(page.locator('.toolbar')).toBeHidden();
  await expect(page.locator('#workspace-sidebar')).toBeHidden();
  await expect(page.locator('.xterm')).toBeVisible();
  await page.getByRole('button', { name: '전체화면 종료 · F11' }).click();
  await expect(page.locator('.toolbar')).toBeVisible();
  await expect(page.locator('#workspace-sidebar')).toBeVisible();
  await expect(page.locator('.xterm')).toHaveAttribute('data-instance', 'original');
  await page.keyboard.press('F11');
  await expect(page.locator('footer')).toBeVisible();
  await page.keyboard.press('Control+Shift+O');
  await expect(page.locator('.toolbar')).toBeVisible();
  await expect(page.getByRole('searchbox')).toBeFocused();
});
