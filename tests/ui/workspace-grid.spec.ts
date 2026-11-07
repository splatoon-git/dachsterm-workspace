import { expect, test, type Page } from '@playwright/test';

const url = '/tests/ui/fixtures/workspace-grid.html';
const preset = (page: Page, name: 'single' | 'columns' | 'rows' | 'grid') =>
  page.evaluate((value) => window.__grid.workspace.preset(value), name);
const cell = (page: Page, name: string) => page.getByTestId(`cell-${name}`);
const box = async (page: Page, name: string) =>
  (await page
    .locator('.pane-cell')
    .filter({ has: cell(page, name) })
    .boundingBox())!;
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(url);
  await expect(tab(page, 'a')).toBeVisible();
});

test('one group shows its active tab with the others in its tab bar', async ({ page }) => {
  await expect(page.getByRole('tablist')).toHaveCount(1);
  await expect(page.getByRole('tab')).toHaveCount(4);
  await expect(cell(page, 'd')).toBeVisible();
  await expect(cell(page, 'a')).toBeHidden();
  await expect(page.getByRole('separator')).toHaveCount(0);
  await tab(page, 'a').click();
  await expect(cell(page, 'a')).toBeVisible();
  await expect(cell(page, 'd')).toBeHidden();
  await expect(tab(page, 'a')).toHaveAttribute('aria-selected', 'true');
});

test('every group has its own tab bar and a 34px bar above its cell', async ({ page }) => {
  await preset(page, 'grid');
  await expect(page.getByRole('tablist')).toHaveCount(4);
  const bars = await page.getByRole('tablist').evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { height: rect.height, tabs: element.querySelectorAll('[role=tab]').length };
    }),
  );
  expect(bars).toEqual(Array.from({ length: 4 }, () => ({ height: 34, tabs: 1 })));
  for (const name of ['a', 'b', 'c', 'd']) await expect(cell(page, name)).toBeVisible();
  const a = await box(page, 'a');
  const b = await box(page, 'b');
  const c = await box(page, 'c');
  expect(b.x).toBeGreaterThan(a.x + a.width);
  expect(c.y).toBeGreaterThan(a.y + a.height);
  expect(a.y).toBe(30 + 34);
  await expect(page.getByRole('separator')).toHaveCount(3);
});

test('moving and rearranging tabs never remounts a cell and keeps its local state', async ({
  page,
}) => {
  const input = cell(page, 'a').getByRole('textbox');
  await tab(page, 'a').click();
  await input.fill('유지되는 입력');
  await cell(page, 'a').evaluate((element) => (element.dataset.instance = 'original'));
  for (const name of ['grid', 'rows', 'columns', 'single'] as const) await preset(page, name);
  await tab(page, 'a').click();
  await page.evaluate(() => {
    const { workspace } = window.__grid;
    workspace.drop('session:a', { zone: 'right', groupId: workspace.layout.focused });
  });
  await expect(page.getByRole('tablist')).toHaveCount(2);
  await expect(input).toHaveValue('유지되는 입력');
  await expect(cell(page, 'a')).toHaveAttribute('data-instance', 'original');
  expect(await page.evaluate(() => window.__grid.mounts)).toEqual({ a: 1, b: 1, c: 1, d: 1 });
});

test('dragging a divider resizes both sides, stops at the minimum and saves the size', async ({
  page,
}) => {
  await page.goto(`${url}?tabs=2`);
  await expect(tab(page, 'a')).toBeVisible();
  await preset(page, 'columns');
  const handle = page.getByRole('separator', { name: '칸 크기 조절' });
  const start = (await handle.boundingBox())!;
  const before = await box(page, 'a');
  await page.mouse.move(start.x + 3, start.y + 200);
  await page.mouse.down();
  await page.mouse.move(start.x + 103, start.y + 200, { steps: 4 });
  await page.mouse.up();
  const after = await box(page, 'a');
  expect(Math.round(after.width - before.width)).toBe(100);
  const right = await box(page, 'b');
  expect(Math.round(right.x - (after.x + after.width))).toBe(3);
  await page.mouse.move(start.x + 103, start.y + 200);
  await page.mouse.down();
  await page.mouse.move(start.x + 2000, start.y + 200, { steps: 4 });
  await page.mouse.up();
  expect(Math.round((await box(page, 'b')).width)).toBeGreaterThanOrEqual(238);
  expect(Math.round((await box(page, 'b')).width)).toBeLessThanOrEqual(240);
  await handle.dblclick();
  const equal = await box(page, 'a');
  expect(Math.abs(equal.width - before.width)).toBeLessThanOrEqual(1);
});

test('the keyboard resizes a focused divider and each split keeps its own size', async ({
  page,
}) => {
  await preset(page, 'grid');
  const handles = page.getByRole('separator', { name: '칸 크기 조절' });
  const value = async (index: number) =>
    Number(await handles.nth(index).getAttribute('aria-valuenow'));
  const first = await value(0);
  const second = await value(1);
  await handles.nth(0).focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => value(0)).toBe(first + 10);
  expect(await value(1)).toBe(second);
  await expect(handles.nth(0)).toBeFocused();
});

test('double clicking a blank tab bar zooms the group and again restores it', async ({ page }) => {
  await page.goto(`${url}?tabs=2`);
  await expect(tab(page, 'a')).toBeVisible();
  await preset(page, 'columns');
  await tab(page, 'a').click();
  const bar = page.getByRole('tablist').first();
  const rect = (await bar.boundingBox())!;
  await page.mouse.dblclick(rect.x + rect.width - 10, rect.y + 10);
  await expect(page.getByRole('tablist')).toHaveCount(1);
  await expect(cell(page, 'a')).toBeVisible();
  await expect(cell(page, 'b')).toBeHidden();
  const zoomed = await box(page, 'a');
  expect(zoomed.width).toBeGreaterThan(1100);
  const after = (await page.getByRole('tablist').boundingBox())!;
  await page.mouse.dblclick(after.x + after.width - 10, after.y + 10);
  await expect(page.getByRole('tablist')).toHaveCount(2);
  await expect(cell(page, 'b')).toBeVisible();
});

test('a saved shape returns after a restart with empty groups filling from the front', async ({
  page,
}) => {
  await preset(page, 'columns');
  const handle = page.getByRole('separator', { name: '칸 크기 조절' });
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  const saved = await page.evaluate(() => localStorage.getItem('dachsterm.layout'));
  expect(JSON.parse(saved!).root.type).toBe('split');
  expect(saved).not.toContain('session');
  const width = (await box(page, 'a')).width;
  await page.goto(`${url}?tabs=1`);
  await expect(tab(page, 'a')).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(2);
  expect((await box(page, 'a')).width).toBeCloseTo(width, 0);
  await expect(page.getByText('빈 칸입니다')).toBeVisible();
  await page.getByRole('button', { name: '칸 닫기', exact: true }).click();
  await expect(page.getByRole('tablist')).toHaveCount(1);
  expect((await box(page, 'a')).width).toBeGreaterThan(1100);
});

for (const [saved, groupCount] of [
  ['single', 1],
  ['columns', 2],
  ['rows', 2],
  ['grid', 4],
] as const)
  test(`converts the old ${saved} layout value`, async ({ page }) => {
    await page.evaluate((value) => localStorage.setItem('dachsterm.layout', value), saved);
    await page.reload();
    await expect(tab(page, 'a')).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(groupCount);
    const stored = await page.evaluate(() => localStorage.getItem('dachsterm.layout'));
    expect(JSON.parse(stored!).v).toBe(1);
  });

test('a damaged saved value starts with one group', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('dachsterm.layout', '{"v":1,"root":{"type":"x"'));
  await page.reload();
  await expect(tab(page, 'a')).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(1);
});

test('a narrow window shows the focused group and can reach the others', async ({ page }) => {
  await page.goto(`${url}?narrow`);
  await expect(tab(page, 'a')).toBeVisible();
  await preset(page, 'columns');
  await expect(page.getByRole('tablist')).toHaveCount(1);
  await expect(page.getByRole('separator')).toHaveCount(0);
  const shown = await page.getByRole('tab').allTextContents();
  await page.getByRole('button', { name: '다음 칸', exact: true }).click();
  await expect(page.getByRole('tablist')).toHaveCount(1);
  expect(await page.getByRole('tab').allTextContents()).not.toEqual(shown);
});

test('focus moves between groups by clicking a cell or its tab bar', async ({ page }) => {
  await page.goto(`${url}?tabs=2`);
  await expect(tab(page, 'a')).toBeVisible();
  await preset(page, 'columns');
  await tab(page, 'a').click();
  await expect(cell(page, 'a')).toHaveAttribute('data-focused', 'true');
  await cell(page, 'b').click();
  await expect(cell(page, 'b')).toHaveAttribute('data-focused', 'true');
  await expect(cell(page, 'a')).toHaveAttribute('data-focused', 'false');
  await expect(cell(page, 'a')).toHaveAttribute('data-visible', 'true');
  await cell(page, 'a').getByRole('textbox').focus();
  await expect(cell(page, 'a')).toHaveAttribute('data-focused', 'true');
  await expect(page.locator('.tab-strip[data-focused-group="true"]')).toHaveCount(1);
});
