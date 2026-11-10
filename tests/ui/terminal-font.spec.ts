import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/terminal-pane';

async function ctrlWheel(page: Page, deltaY: number) {
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, deltaY);
  await page.keyboard.up('Control');
  // A pause ends the gesture, so the next call is a separate notch (fontWheel.ts).
  await page.waitForTimeout(200);
}
const fontSize = (page: Page) =>
  page.evaluate(() => window.__terminalPane.session.terminal.options.fontSize);
const cols = (page: Page) => page.evaluate(() => window.__terminalPane.session.terminal.cols);
const write = (page: Page, text: string) =>
  page.evaluate(
    (value) =>
      new Promise<void>((done) => window.__terminalPane.session.terminal.write(value, done)),
    text,
  );

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/ui/fixtures/terminal-pane.html');
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await page.locator('.live-terminal').hover();
});

test('Ctrl+wheel resizes the font, refits, persists and shows the size in settings', async ({
  page,
}) => {
  expect(await fontSize(page)).toBe(14);
  const before = await cols(page);
  await ctrlWheel(page, -100);
  await expect.poll(() => fontSize(page)).toBe(15);
  await expect.poll(() => cols(page)).toBeLessThan(before);
  await ctrlWheel(page, 100);
  await ctrlWheel(page, 100);
  await expect.poll(() => fontSize(page)).toBe(13);
  await expect.poll(() => cols(page)).toBeGreaterThan(before);

  await page.getByRole('button', { name: '터미널 설정' }).click();
  await expect(page.getByLabel('글꼴 크기')).toHaveValue('13');
  await page.reload();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  expect(await fontSize(page)).toBe(13);
});

test('Ctrl+wheel neither scrolls the buffer nor reaches a mouse-reporting TUI', async ({
  page,
}) => {
  await write(page, Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\r\n'));
  await ctrlWheel(page, -100);
  await expect.poll(() => fontSize(page)).toBe(15);
  const atBottom = () =>
    page.evaluate(() => {
      const buffer = window.__terminalPane.session.terminal.buffer.active;
      return buffer.viewportY === buffer.baseY;
    });
  expect(await atBottom()).toBe(true);
  await page.mouse.wheel(0, -300);
  await expect.poll(atBottom).toBe(false);

  // SGR encoding, as vim and tmux request. The default encoding reports through onBinary instead.
  await write(page, '\x1b[?1000h\x1b[?1006h');
  await page.evaluate(() => (window.__terminalPane.sent.length = 0));
  await ctrlWheel(page, -100);
  await expect.poll(() => fontSize(page)).toBe(16);
  expect(await page.evaluate(() => window.__terminalPane.sent.length)).toBe(0);
  await page.mouse.wheel(0, -100);
  await expect
    .poll(() => page.evaluate(() => window.__terminalPane.sent.length))
    .toBeGreaterThan(0);
});

test('Ctrl+wheel leaves keyboard focus where it was', async ({ page }) => {
  const outside = page.getByLabel('터미널 밖 입력');
  await outside.focus();
  await ctrlWheel(page, -100);
  await expect.poll(() => fontSize(page)).toBe(15);
  await expect(outside).toBeFocused();
});

test('a burst of Ctrl+wheel events from one notch changes the size once', async ({ page }) => {
  // Dispatched in one go: `mouse.wheel` waits for each event, which can leave gaps of a gesture's end.
  await page.evaluate(() => {
    const target = document.querySelector('.xterm-screen')!;
    for (let i = 0; i < 8; i++)
      target.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -40 }),
      );
  });
  await expect.poll(() => fontSize(page)).toBe(15);
  await page.waitForTimeout(300);
  expect(await fontSize(page)).toBe(15);
});

test('plain wheel does not change the font size', async ({ page }) => {
  await page.mouse.wheel(0, -100);
  await page.mouse.wheel(0, 100);
  expect(await fontSize(page)).toBe(14);
});
