// Helpers shared by the native scripts that arrange tabs in the workspace.
import { expect } from '@playwright/test';

/**
 * label: 좌우, 상하, 2 × 2 or 하나로. Laying out every tab is in any tab's menu; the focused
 * group's selected tab is used, since pressing another tab would move the focus first.
 */
export async function arrangeTabs(page, label) {
  await page
    .locator('.tab-strip[data-focused-group="true"] [role="tab"][aria-selected="true"]')
    .click({ button: 'right' });
  const item = page.getByRole('menuitem', { name: `모든 탭 ${label}`, exact: true });
  await page.getByRole('menu').waitFor();
  // With nothing to lay out the menu leaves the items out (one tab) or disables them (one group).
  if ((await item.count()) && (await item.isEnabled())) await item.click();
  else await page.keyboard.press('Escape');
}

/** Opens a game from the title bar's tools menu. */
export async function openGame(page, name) {
  const menu = page.locator('details.toolbar-menu', {
    has: page.locator('summary', { hasText: '도구' }),
  });
  if ((await menu.getAttribute('open')) === null) await menu.locator('summary').click();
  await page
    .getByRole('navigation', { name: '게임 목록' })
    .getByRole('button', { name, exact: true })
    .click();
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

/** The selected tab of the focused group: the tab whose pane has the keyboard. */
export const focusedTab = (page) =>
  page.locator('.tab-strip[data-focused-group="true"] .session-tab.selected [role="tab"]');

/** Makes a pane's group the focused one without clicking into the terminal or file list. */
export async function focusPane(pane) {
  await pane.dispatchEvent('pointerdown');
}

/**
 * Chooses an item from a tab's header menu. Without a pane it uses the focused tab. Item names
 * match from the start, since an item may show its shortcut after the name.
 */
export async function chooseTabMenu(page, item, pane) {
  if (pane) await focusPane(pane);
  await focusedTab(page).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '탭 메뉴' });
  await menu.getByRole('menuitem', { name: new RegExp(`^${item}`) }).click();
  await expect(menu).toHaveCount(0);
}

/** Opens the search box over a terminal pane with its shortcut and returns it. */
export async function openTerminalSearch(page, pane) {
  await focusPane(pane);
  await page.keyboard.press('ControlOrMeta+Shift+F');
  const search = pane.getByRole('textbox', { name: '터미널 검색', exact: true });
  await expect(search).toBeVisible();
  return search;
}

/** Opens the settings window on one of its categories and returns the window. */
export async function openSettings(page, category) {
  await page.getByRole('button', { name: '설정', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '설정', exact: true });
  await settings.getByRole('tab', { name: category, exact: true }).click();
  return settings;
}

/** Opens the settings shared by every terminal: the settings window's terminal category. */
export function openTerminalSettings(page) {
  return openSettings(page, '터미널');
}

/** Closes the settings window. */
export async function closeTerminalSettings(page) {
  await page
    .getByRole('dialog', { name: '설정', exact: true })
    .getByRole('button', { name: '대화상자 닫기' })
    .click();
}

/** Chooses an item from a saved connection's right-click menu. */
export async function chooseProfileMenu(page, card, item) {
  await card.locator('.profile-target').click({ button: 'right' });
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: new RegExp(`^${item}`) })
    .click();
}

const sidebarToggle = (page) => page.getByRole('button', { name: '사이드바', exact: true });

/**
 * Chooses an item from a connection tree section's ⋯ menu: 새 연결… or 새 그룹… under 연결,
 * 로컬 터미널… under 로컬.
 */
export async function chooseSectionMenu(page, item) {
  await showSidebarView(page, '연결');
  const section = item.startsWith('로컬') ? '로컬' : '연결';
  await page.getByRole('button', { name: `${section} 작업`, exact: true }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${item}`) }).click();
}

/** Opens the new connection form from the 연결 section's menu. */
export async function openNewConnectionForm(page) {
  await chooseSectionMenu(page, '새 연결…');
}

/** Shows a sidebar view, opening the folded sidebar from the title bar first. */
export async function showSidebarView(page, name) {
  if ((await sidebarToggle(page).getAttribute('aria-expanded')) !== 'true')
    await sidebarToggle(page).click();
  const tab = page.getByRole('tab', { name, exact: true });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

/** Folds the sidebar with the title bar button. */
export async function foldSidebar(page) {
  if ((await sidebarToggle(page).getAttribute('aria-expanded')) === 'true')
    await sidebarToggle(page).click();
  await expect(page.locator('#workspace-sidebar')).toBeHidden();
}

/** The status bar's input scope: 개별, 전체 or 선택. */
export const inputScope = (page, name) =>
  page.getByRole('radiogroup', { name: '입력 범위' }).getByRole('radio', { name, exact: true });

/** The "입력 받기" box in the tab bar of the pane showing this connection, while picking. */
export const inputPick = (page, connectionId) =>
  page.locator(`.input-mark[data-connection-id="${connectionId}"] input`);
