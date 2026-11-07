import type { Page } from '@playwright/test';

/** Opens the title bar's tools menu unless it is open already. */
export async function openTools(page: Page) {
  const menu = page.locator('details.toolbar-menu', {
    has: page.locator('summary', { hasText: '도구' }),
  });
  if ((await menu.getAttribute('open')) === null) await menu.locator('summary').click();
}

/** Opens a game from the tools menu. The menu closes again once a game is chosen. */
export async function openGame(page: Page, name: string) {
  await openTools(page);
  await page
    .getByRole('navigation', { name: '게임 목록' })
    .getByRole('button', { name, exact: true })
    .click();
}

/** Opens the terminal preview, which the browser run without a backend offers in the tools menu. */
export async function openPreview(page: Page) {
  await openTools(page);
  await page.getByRole('button', { name: '터미널 미리보기', exact: true }).click();
}

/** Opens the new connection form from the 연결 section's ⋯ menu, showing the sidebar first. */
export async function openNewConnection(page: Page) {
  const toggle = page.getByRole('button', { name: '사이드바', exact: true });
  // The toggle is there once the app has drawn, so the check below sees the real sidebar state.
  await toggle.waitFor();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.getByRole('button', { name: '연결 작업', exact: true }).click();
  await page.getByRole('menuitem', { name: /^새 연결…/ }).click();
}
