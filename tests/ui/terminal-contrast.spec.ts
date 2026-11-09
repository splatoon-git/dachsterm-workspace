import { expect, test, type Page } from '@playwright/test';
import { themes } from '../../src/themes/registry';
import type {} from './fixtures/terminal-pane';

function contrast(a: number[], b: number[]) {
  const luminance = (rgb: number[]) =>
    rgb
      .map((x) => x / 255)
      .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
      .reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0);
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const fromHex = (hex: string) => hex.match(/[a-f\d]{2}/gi)!.map((x) => parseInt(x, 16));

/** Color xterm actually painted for the cell holding `text`. */
async function painted(page: Page, text: string) {
  const cell = page.locator('.xterm-rows span', { hasText: text }).first();
  let color = '';
  // The first fit redraws the row, and a cell caught mid-swap has no computed style yet.
  await expect
    .poll(async () => {
      color = await cell.evaluate((element) => getComputedStyle(element).color);
      return color;
    })
    .toMatch(/^rgb/);
  return color.match(/\d+/g)!.slice(0, 3).map(Number);
}

for (const theme of themes) {
  test(`${theme.name}: prompt text stays readable on an ANSI black segment`, async ({ page }) => {
    await page.addInitScript((id) => localStorage.setItem('dachsterm.theme', id), theme.id);
    await page.goto('/tests/ui/fixtures/terminal-pane.html');
    await expect(page.locator('.xterm-rows')).toBeVisible();
    // Same colors a Powerline-style prompt sends: default text on black, then a black arrow.
    const line = '\x1b[40m onblack \x1b[30;44m\uE0B0\x1b[0m plaintext \x1b[31mredtext\x1b[0m';
    await page.evaluate(
      (value) =>
        new Promise<void>((done) => window.__terminalPane.session.terminal.write(value, done)),
      line,
    );
    await expect(page.locator('.xterm-rows')).toContainText('redtext');

    const { terminal } = theme;
    expect(
      contrast(await painted(page, 'onblack'), fromHex(terminal.black)),
    ).toBeGreaterThanOrEqual(4.5);
    // Colors that were already readable keep their theme value, and the arrow still joins segments.
    expect(await painted(page, 'plaintext')).toEqual(fromHex(terminal.foreground));
    expect(await painted(page, 'redtext')).toEqual(fromHex(terminal.red));
    expect(await painted(page, '\uE0B0')).toEqual(fromHex(terminal.black));
  });
}
