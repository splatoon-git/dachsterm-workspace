import { test, expect } from '@playwright/test';
import { themes } from '../../src/themes/registry';
import { openPreview } from './helpers';

test('every theme applies to the existing terminal and persists across reload', async ({
  page,
}) => {
  await page.goto('/');
  await openPreview(page);
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await page
    .locator('.xterm-screen')
    .evaluate((element) => element.setAttribute('data-lifetime', 'original'));
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.getByRole('radio', { name: 'Terminal Amber', exact: true }).check();
  await page.getByRole('button', { name: '대화상자 닫기', exact: true }).click();
  for (const theme of themes) {
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('radio', { name: theme.name, exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme.colorScheme);
    expect(await page.evaluate(() => localStorage.getItem('dachsterm.theme'))).toBe(theme.id);
    await page.getByRole('button', { name: '대화상자 닫기', exact: true }).click();
    const values = await page.locator('.xterm-scrollable-element').evaluate((element) => ({
      terminal: getComputedStyle(element).backgroundColor,
      panel: getComputedStyle(document.querySelector('.toolbar')!).backgroundColor,
    }));
    const rgb = (hex: string) =>
      `rgb(${hex
        .match(/[a-f\d]{2}/gi)!
        .map((v) => parseInt(v, 16))
        .join(', ')})`;
    expect(values.terminal).toBe(rgb(theme.terminal.background));
    expect(values.panel).toBe(rgb(theme.color.surface.panel));
    const selectedView = page.locator('.sidebar-tabs [aria-selected="true"]');
    await selectedView.hover();
    await expect(selectedView).toHaveCSS('background-color', rgb(theme.color.action.primary));
    await expect(selectedView).toHaveCSS('color', rgb(theme.color.text.onAction));
    await expect(page.locator('.xterm-screen')).toHaveAttribute('data-lifetime', 'original');
    await page.screenshot({ path: `test-results/theme-${theme.id}.png` });
  }
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'terminal-amber');
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Terminal Amber', exact: true })).toBeChecked();
});

test('theme synchronizes across open windows, new windows and storage removal', async ({
  page,
  context,
}) => {
  await page.goto('/');
  const other = await context.newPage();
  await other.goto('/');
  await openPreview(other);
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.getByRole('radio', { name: 'Dracula', exact: true }).check();
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'dracula');
  await expect(other.locator('.xterm-scrollable-element')).toHaveCSS(
    'background-color',
    'rgb(40, 42, 54)',
  );
  const fresh = await context.newPage();
  await fresh.goto('/');
  await expect(fresh.locator('html')).toHaveAttribute('data-theme', 'dracula');
  await other.evaluate(() => localStorage.setItem('dachsterm.theme', 'removed-theme'));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'pms-retro-light');
  await page.getByRole('radio', { name: 'Nord', exact: true }).check();
  await expect(other.locator('html')).toHaveAttribute('data-theme', 'nord');
  await other.evaluate(() => localStorage.clear());
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'pms-retro-light');
  await other.close();
  await fresh.close();
});

for (const width of [1280, 560, 360]) {
  test(`theme picker keyboard navigation and layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '설정', exact: true });
    await expect(page.getByRole('radio', { name: 'DachsTerm Classic', exact: true })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('radio', { name: 'GitHub White', exact: true })).toBeChecked();
    expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/theme-picker-${width}.png` });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '설정', exact: true })).toBeFocused();
  });
}

test('storage write failure applies the theme and reports that it is not saved', async ({
  page,
}) => {
  await page.goto('/');
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('Unavailable', 'QuotaExceededError');
    };
  });
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.getByRole('radio', { name: 'Dracula', exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dracula');
  await expect(page.getByRole('alert')).toContainText('테마를 저장하지 못했습니다');
});
