// Helpers shared by the native scripts that arrange tabs in the workspace.
import { expect } from '@playwright/test';

/** label: 좌우, 상하, 2 × 2 or 하나로. */
export async function arrangeTabs(page, label) {
  await page.locator('.toolbar-menu > summary').filter({ hasText: '보기' }).click();
  await page.getByRole('button', { name: `모든 탭 ${label}`, exact: true }).click();
}

/** Drags a tab with the real mouse: past the threshold, then to the point, then releases. */
export async function dragTab(page, tab, x, y) {
  const box = await tab.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 12, { steps: 3 });
  await page.mouse.move(x, y, { steps: 6 });
  await page.mouse.up();
}

let sizeMarker = 0;
/**
 * Asks the shell for its PTY size and compares it with what the terminal actually draws. The rows
 * are the rendered row count and the columns come from the width of a measured cell, so a resize
 * that never reached the server fails here.
 */
export async function expectPtyMatchesTerminal(target, command) {
  const marker = `PTYSIZE${++sizeMarker}_`;
  await command(`printf '${marker}%s_END\\n' "$(stty size | tr ' ' x)"`, target);
  const rows = target.locator('.xterm-rows');
  await expect
    .poll(() => rows.innerText(), { timeout: 12000 })
    .toMatch(new RegExp(`${marker}\\d+x\\d+_END`));
  const measured = await rows.evaluate((element, wanted) => {
    const line = [...element.children].find((row) => row.textContent.includes(`${wanted}`));
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent.includes(wanted)) node = walker.nextNode();
    const start = node.textContent.indexOf(wanted);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + wanted.length);
    const cell = range.getBoundingClientRect().width / wanted.length;
    const reported = line.textContent.match(/(\d+)x(\d+)_END/);
    return {
      ptyRows: Number(reported[1]),
      ptyCols: Number(reported[2]),
      drawnRows: element.children.length,
      drawnCols: Math.round(element.getBoundingClientRect().width / cell),
    };
  }, marker);
  expect(measured.ptyRows, 'PTY rows match the terminal').toBe(measured.drawnRows);
  expect(measured.ptyCols, 'PTY columns match the terminal').toBe(measured.drawnCols);
  return { rows: measured.ptyRows, cols: measured.ptyCols };
}
