import { expect, test, type Page } from '@playwright/test';

const url = '/tests/ui/fixtures/workspace-grid.html';
const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const cell = (page: Page, name: string) => page.getByTestId(`cell-${name}`);
const preset = (page: Page, name: 'single' | 'columns' | 'rows' | 'grid') =>
  page.evaluate((value) => window.__grid.workspace.preset(value), name);
const bars = (page: Page) =>
  page
    .getByRole('tablist')
    .evaluateAll((elements) =>
      elements.map((element) =>
        Array.from(element.querySelectorAll('[role=tab]'), (t) => t.textContent),
      ),
    );
const cellBox = async (page: Page, name: string) =>
  (await page
    .locator('.pane-cell')
    .filter({ has: cell(page, name) })
    .boundingBox())!;

async function open(page: Page, tabs: number, extra = '') {
  await page.goto(`${url}?tabs=${tabs}${extra}`);
  await expect(tab(page, 'a')).toBeVisible();
}
/** Presses a tab and moves past the threshold, leaving the button down. */
async function grab(page: Page, name: string) {
  // A preset gives every group a new tab bar, so wait for the tab before reading its position.
  await expect(tab(page, name)).toBeVisible();
  const box = (await tab(page, name).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 12, { steps: 3 });
}
async function dropAt(page: Page, x: number, y: number) {
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
}
/** A point inside the body of the cell showing `name`, as fractions of that body. */
async function inCell(page: Page, name: string, u: number, v: number) {
  const box = await cellBox(page, name);
  return { x: box.x + box.width * u, y: box.y + box.height * v };
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
});

for (const [zone, u, v, expected, half] of [
  ['left', 0.1, 0.5, [['b'], ['a']], 'width'],
  ['right', 0.9, 0.5, [['a'], ['b']], 'width'],
  ['top', 0.5, 0.1, [['b'], ['a']], 'height'],
  ['bottom', 0.5, 0.9, [['a'], ['b']], 'height'],
] as const) {
  test(`dropping on the ${zone} quarter splits that way with a half highlighted`, async ({
    page,
  }) => {
    await open(page, 2);
    await tab(page, 'a').click();
    const whole = await cellBox(page, 'a');
    await grab(page, 'b');
    const { x, y } = await inCell(page, 'a', u, v);
    await page.mouse.move(x, y, { steps: 4 });
    const preview = page.locator('.drop-preview');
    await expect(preview).toHaveAttribute('data-zone', zone);
    const box = (await preview.boundingBox())!;
    if (half === 'width') expect(box.width).toBeCloseTo(whole.width / 2, -1);
    else expect(box.height).toBeCloseTo((whole.height + 34) / 2, -1);
    await page.mouse.up();
    await expect(preview).toHaveCount(0);
    expect(await bars(page)).toEqual(expected);
    await expect(cell(page, 'a')).toBeVisible();
    await expect(cell(page, 'b')).toBeVisible();
    await expect(cell(page, 'b')).toHaveAttribute('data-focused', 'true');
    const a = await cellBox(page, 'a');
    const b = await cellBox(page, 'b');
    if (zone === 'left') expect(b.x).toBeLessThan(a.x);
    if (zone === 'right') expect(b.x).toBeGreaterThan(a.x);
    if (zone === 'top') expect(b.y).toBeLessThan(a.y);
    if (zone === 'bottom') expect(b.y).toBeGreaterThan(a.y);
  });
}

test('dropping in the middle of another group merges and shows the tab', async ({ page }) => {
  await open(page, 3);
  await preset(page, 'columns');
  expect(await bars(page)).toEqual([['a', 'c'], ['b']]);
  await grab(page, 'c');
  const { x, y } = await inCell(page, 'b', 0.5, 0.5);
  await page.mouse.move(x, y, { steps: 4 });
  await expect(page.locator('.drop-preview')).toHaveAttribute('data-zone', 'center');
  await page.mouse.up();
  expect(await bars(page)).toEqual([['a'], ['b', 'c']]);
  await expect(cell(page, 'c')).toBeVisible();
  await expect(cell(page, 'b')).toBeHidden();
});

test('dropping on a tab bar reorders with an insertion bar and crosses groups', async ({
  page,
}) => {
  await open(page, 3);
  await grab(page, 'c');
  const first = (await tab(page, 'a').boundingBox())!;
  await page.mouse.move(first.x + 2, first.y + 10, { steps: 4 });
  const bar = page.locator('.drop-insert');
  await expect(bar).toBeVisible();
  expect(Math.abs((await bar.boundingBox())!.x - first.x)).toBeLessThan(20);
  await expect(page.locator('.drop-preview')).toHaveCount(0);
  await page.mouse.up();
  expect(await bars(page)).toEqual([['c', 'a', 'b']]);
  await preset(page, 'columns');
  const before = await bars(page);
  expect(before[0]).toContain('b');
  await grab(page, 'b');
  await expect(page.getByRole('tablist')).toHaveCount(2);
  const target = (await page.getByRole('tablist').nth(1).boundingBox())!;
  await dropAt(page, target.x + target.width - 20, target.y + 12);
  const after = await bars(page);
  expect(after).toHaveLength(2);
  expect(after[1].at(-1)).toBe('b');
});

test('the last tab leaving removes its group and keeps every cell mounted', async ({ page }) => {
  await open(page, 2);
  await preset(page, 'columns');
  await cell(page, 'a').getByRole('textbox').fill('드래그 후에도 유지');
  await cell(page, 'a').evaluate((element) => (element.dataset.instance = 'original'));
  await grab(page, 'a');
  const { x, y } = await inCell(page, 'b', 0.5, 0.5);
  await dropAt(page, x, y);
  expect(await bars(page)).toEqual([['b', 'a']]);
  await expect(page.getByRole('separator')).toHaveCount(0);
  expect((await cellBox(page, 'a')).width).toBeGreaterThan(1100);
  await expect(cell(page, 'a')).toHaveAttribute('data-instance', 'original');
  await expect(cell(page, 'a').getByRole('textbox')).toHaveValue('드래그 후에도 유지');
  expect(await page.evaluate(() => window.__grid.mounts)).toEqual({ a: 1, b: 1 });
});

test('Escape cancels without changing the layout, selecting the tab or reaching the page', async ({
  page,
}) => {
  await open(page, 3);
  await page.evaluate(() => {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') document.body.dataset.escape = 'reached';
    });
  });
  await grab(page, 'a');
  const { x, y } = await inCell(page, 'c', 0.9, 0.5);
  await page.mouse.move(x, y, { steps: 4 });
  await expect(page.locator('.drop-preview')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.drop-preview')).toHaveCount(0);
  await expect(page.locator('.tab-drag-label')).toHaveCount(0);
  await page.mouse.up();
  expect(await bars(page)).toEqual([['a', 'b', 'c']]);
  await expect(cell(page, 'c')).toBeVisible();
  await expect(tab(page, 'a')).toHaveAttribute('aria-selected', 'false');
  expect(await page.evaluate(() => document.body.dataset.escape)).toBeUndefined();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => document.body.dataset.escape)).toBe('reached');
});

test('a press under the threshold stays a click and starts no drag', async ({ page }) => {
  await open(page, 2);
  const box = (await tab(page, 'a').boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 13, box.y + 11);
  await expect(page.locator('.tab-drag-label')).toHaveCount(0);
  await page.mouse.up();
  await expect(cell(page, 'a')).toBeVisible();
});

test('a drag releases without a stray click selecting the tab underneath', async ({ page }) => {
  await open(page, 3);
  await grab(page, 'a');
  await page.mouse.move((await tab(page, 'b').boundingBox())!.x + 2, 40, { steps: 3 });
  await page.keyboard.press('Escape');
  const b = (await tab(page, 'b').boundingBox())!;
  await page.mouse.move(b.x + 5, b.y + 5);
  await page.mouse.up();
  await expect(tab(page, 'c')).toHaveAttribute('aria-selected', 'true');
});

test('the close button and other mouse buttons never start a drag', async ({ page }) => {
  await open(page, 2);
  const close = page.getByRole('button', { name: 'a 탭 닫기', exact: true });
  const box = (await close.boundingBox())!;
  await page.mouse.move(box.x + 4, box.y + 4);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 200, { steps: 4 });
  await expect(page.locator('.tab-drag-label')).toHaveCount(0);
  await page.mouse.up();
  const a = (await tab(page, 'a').boundingBox())!;
  await page.mouse.move(a.x + 5, a.y + 5);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(a.x + 60, a.y + 200, { steps: 4 });
  await expect(page.locator('.tab-drag-label')).toHaveCount(0);
  await page.mouse.up({ button: 'right' });
  expect(await bars(page)).toEqual([['a', 'b']]);
});

test('a group holding only the dragged tab offers no drop on itself', async ({ page }) => {
  await open(page, 2);
  await preset(page, 'columns');
  await grab(page, 'a');
  for (const [u, v] of [
    [0.5, 0.5],
    [0.05, 0.5],
    [0.5, 0.95],
  ]) {
    const { x, y } = await inCell(page, 'a', u, v);
    await page.mouse.move(x, y, { steps: 2 });
    await expect(page.locator('.drop-preview')).toHaveCount(0);
  }
  await page.mouse.up();
  expect(await bars(page)).toEqual([['a'], ['b']]);
});

test('a group with several tabs can split itself but not merge into itself', async ({ page }) => {
  await open(page, 2);
  await grab(page, 'a');
  const middle = await inCell(page, 'b', 0.5, 0.5);
  await page.mouse.move(middle.x, middle.y, { steps: 2 });
  await expect(page.locator('.drop-preview')).toHaveCount(0);
  const edge = await inCell(page, 'b', 0.95, 0.5);
  await dropAt(page, edge.x, edge.y);
  expect(await bars(page)).toEqual([['b'], ['a']]);
});

test('an edge that would leave a group under the minimum size becomes a merge', async ({
  page,
}) => {
  await page.setViewportSize({ width: 560, height: 800 });
  await open(page, 3);
  await preset(page, 'columns');
  await grab(page, 'c');
  const { x, y } = await inCell(page, 'b', 0.95, 0.5);
  await page.mouse.move(x, y, { steps: 3 });
  await expect(page.locator('.drop-preview')).toHaveAttribute('data-zone', 'center');
  await page.mouse.up();
  expect(await bars(page)).toEqual([['a'], ['b', 'c']]);
});

test('beyond the window a tab is detached, leaving the layout to the app', async ({ page }) => {
  await open(page, 2);
  await grab(page, 'a');
  await page.mouse.move(-30, 200, { steps: 4 });
  await expect(page.locator('.drop-preview')).toHaveCount(0);
  await page.mouse.up();
  expect(await page.evaluate(() => window.__grid.detached)).toEqual(['session:a']);
  expect(await bars(page)).toEqual([['a', 'b']]);
});

test('over the app but outside the workspace a drop is cancelled', async ({ page }) => {
  await open(page, 2);
  await grab(page, 'a');
  await dropAt(page, 15, 200);
  expect(await page.evaluate(() => window.__grid.detached)).toEqual([]);
  expect(await bars(page)).toEqual([['a', 'b']]);
});

test('a narrow window reorders but does not split', async ({ page }) => {
  await open(page, 3, '&narrow');
  await grab(page, 'a');
  const { x, y } = await inCell(page, 'c', 0.95, 0.5);
  await page.mouse.move(x, y, { steps: 3 });
  await expect(page.locator('.drop-preview')).toHaveCount(0);
  const bar = (await page.getByRole('tablist').boundingBox())!;
  await dropAt(page, bar.x + bar.width - 20, bar.y + 10);
  expect(await bars(page)).toEqual([['b', 'c', 'a']]);
});

test('while zoomed a reorder keeps the zoom and a split ends it', async ({ page }) => {
  await open(page, 3);
  await preset(page, 'columns');
  await tab(page, 'a').click();
  await page.evaluate(() => window.__grid.workspace.toggleZoom());
  await expect(page.getByRole('tablist')).toHaveCount(1);
  await grab(page, 'c');
  const first = (await tab(page, 'a').boundingBox())!;
  await dropAt(page, first.x + 2, first.y + 10);
  await expect(page.getByRole('tablist')).toHaveCount(1);
  expect(await bars(page)).toEqual([['c', 'a']]);
  await grab(page, 'c');
  const { x, y } = await inCell(page, 'c', 0.95, 0.5);
  await dropAt(page, x, y);
  expect(await bars(page)).toEqual([['a'], ['c'], ['b']]);
});

test('a dragged tab fades and a label follows the pointer', async ({ page }) => {
  await open(page, 2);
  await grab(page, 'a');
  await expect(page.locator('.session-tab.dragged')).toHaveCount(1);
  await expect(page.locator('.tab-drag-label')).toHaveText('a');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(page.locator('.session-tab.dragged')).toHaveCount(0);
  expect(await page.evaluate(() => document.body.classList.contains('tab-dragging'))).toBe(false);
});
