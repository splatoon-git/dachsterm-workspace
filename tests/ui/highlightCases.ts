import { expect, type Page } from '@playwright/test';
import { blankRule } from '../../src/features/terminal/highlightRules';
import { themes } from '../../src/themes/registry';
import type {} from './fixtures/terminal-pane';

const fromHex = (hex: string) => hex.match(/[a-f\d]{2}/gi)!.map((x) => parseInt(x, 16));

/** Color xterm painted for the cell holding `text`. Decorated cells are drawn one per span. */
async function painted(page: Page, text: string | RegExp) {
  const cell = page.locator('.xterm-rows span', { hasText: text }).first();
  let color = '';
  await expect
    .poll(async () => {
      color = await cell.evaluate((element) => getComputedStyle(element).color);
      return color;
    })
    .toMatch(/^rgb/);
  return color.match(/\d+/g)!.slice(0, 3).map(Number);
}

const write = (page: Page, text: string) =>
  page.evaluate(
    (value) =>
      new Promise<void>((done) => window.__terminalPane.session.terminal.write(value, done)),
    text,
  );

/** A rule colors matches with the theme token, in the page's real worker, and follows a theme change. */
export async function colorsFollowTheme(page: Page) {
  const [first, second] = [
    themes[0],
    themes.find((t) => t.terminal.red !== themes[0].terminal.red)!,
  ];
  await page.addInitScript((id) => localStorage.setItem('dachsterm.theme', id), first.id);
  await page.goto('/tests/ui/fixtures/terminal-pane.html');
  await expect(page.locator('.xterm-rows')).toBeVisible();
  await page.evaluate((rule) => window.__terminalPane.highlight([rule]), {
    ...blankRule(),
    name: '오류',
    pattern: 'ERROR',
    color: 'danger' as const,
  });
  // The worker module loads here: matching runs in the page's real worker.
  await write(page, 'plain line\r\nservice ERROR found\r\n');
  await expect
    .poll(() => painted(page, /^E$/), { timeout: 10_000 })
    .toEqual(fromHex(first.terminal.red));
  expect(await painted(page, 'service')).toEqual(fromHex(first.terminal.foreground));

  await page.evaluate((id) => window.__terminalPane.applyTheme(id), second.id);
  await expect.poll(() => painted(page, /^E$/)).toEqual(fromHex(second.terminal.red));
}
