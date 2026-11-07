import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/terminal-pane';

const position = (page: Page) =>
  page.evaluate(() => {
    const { terminal } = window.__terminalPane.session;
    const buffer = terminal.buffer.active;
    return { top: buffer.viewportY, bottom: buffer.baseY, rows: terminal.rows };
  });
const write = (page: Page, text: string) =>
  page.evaluate(
    (value) =>
      new Promise<void>((done) => window.__terminalPane.session.terminal.write(value, done)),
    text,
  );
const box = (page: Page) => page.locator('#root > div');

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/ui/fixtures/terminal-pane.html');
  await expect(page.locator('.xterm-rows')).toBeVisible();
  // xterm starts at 24 rows; compare against the size after the first fit, not before it.
  await expect.poll(async () => (await position(page)).rows).not.toBe(24);
  await write(page, Array.from({ length: 120 }, (_, i) => `line ${i}\r\n`).join(''));
  await expect.poll(async () => (await position(page)).bottom).toBeGreaterThan(0);
});

for (const [name, height, width] of [
  ['shorter', 400, null],
  ['taller', 590, null],
  ['narrower', 520, 420],
  ['much smaller', 260, 300],
] as const) {
  test(`a terminal shown again ${name} stays at the end of its output`, async ({ page }) => {
    const before = await position(page);
    expect(before.top).toBe(before.bottom);
    await page.evaluate(() => window.__terminalPane.setActive(false));
    await expect(page.locator('.terminal-pane')).toBeHidden();
    await write(page, 'while hidden\r\n');
    await box(page).evaluate(
      (e, { height, width }) => {
        e.style.height = `${height}px`;
        if (width) e.style.width = `${width}px`;
      },
      { height, width },
    );
    await page.evaluate(() => window.__terminalPane.setActive(true));
    await expect.poll(async () => (await position(page)).rows).not.toBe(before.rows);
    await page.waitForTimeout(300);
    const after = await position(page);
    expect(after.top).toBe(after.bottom);
    await write(page, 'after showing\r\n');
    await page.waitForTimeout(100);
    const later = await position(page);
    expect(later.top).toBe(later.bottom);
    await expect(page.locator('.xterm-rows')).toContainText('after showing');
  });
}

test('a terminal scrolled back by the user keeps its place when resized', async ({ page }) => {
  await page.evaluate(() => window.__terminalPane.session.terminal.scrollLines(-40));
  const before = await position(page);
  expect(before.top).toBeLessThan(before.bottom);
  await box(page).evaluate((e) => (e.style.height = '400px'));
  await expect.poll(async () => (await position(page)).rows).not.toBe(before.rows);
  await page.waitForTimeout(300);
  const after = await position(page);
  expect(after.top).toBeLessThan(after.bottom);
});
