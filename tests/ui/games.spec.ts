import { expect, test } from '@playwright/test';
import { openGame, openPreview } from './helpers';

for (const width of [1280, 560, 360]) {
  test(`four games, keyboard, pause and local records at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await openGame(page, '블록 퍼즐');
    const dialog = page.locator('.game-terminal:visible');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '게임 시작', exact: true }).click();
    const blocks = dialog.getByRole('group', { name: '블록 퍼즐 게임판', exact: true });
    await expect(blocks).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Space');
    await expect
      .poll(async () => Number(await dialog.getByTestId('game-score').textContent()))
      .toBeGreaterThan(0);
    await dialog.getByRole('button', { name: '일시정지', exact: true }).click();
    const frozen = await blocks.innerHTML();
    await page.waitForTimeout(800);
    expect(await blocks.innerHTML()).toBe(frozen);
    await dialog.getByRole('button', { name: '계속하기', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(dialog.getByRole('button', { name: '계속하기', exact: true })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => Number(localStorage.getItem('dachsterm.games.v1.blocks'))))
      .toBeGreaterThan(0);
    await page.screenshot({ path: `test-results/games-blocks-${width}.png` });

    await openGame(page, '스네이크');
    await dialog.getByRole('button', { name: '게임 시작', exact: true }).click();
    await page.keyboard.press('ArrowUp');
    await expect(dialog.getByRole('group', { name: '스네이크 게임판' })).toBeFocused();
    await page.keyboard.press('p');
    await expect(dialog.getByRole('status')).toContainText('일시정지');

    await openGame(page, '2048');
    const tiles = dialog.getByRole('group', { name: '2048 게임판' });
    await tiles.focus();
    for (const key of ['ArrowLeft', 'ArrowDown', 'ArrowRight', 'ArrowUp'])
      await page.keyboard.press(key);
    await expect(tiles.locator('.number-tile')).toHaveCount(16);
    await dialog.getByRole('button', { name: '다시 시작', exact: true }).click();
    await expect(tiles.locator('.number-tile').filter({ hasText: /^[24]$/ })).toHaveCount(2);

    await openGame(page, '지뢰찾기');
    const mines = dialog.getByRole('group', { name: '지뢰찾기 게임판' });
    const first = mines.getByRole('button').first();
    await first.click({ button: 'right' });
    await expect(first).toHaveAccessibleName('1행 1열 깃발');
    await first.press('f');
    await first.press('Enter');
    await expect(first).toHaveAccessibleName('1행 1열 빈칸');
    await first.press('ArrowRight');
    await expect(mines.getByRole('button').nth(1)).toBeFocused();
    await expect(dialog.getByTestId('game-score')).toHaveText('1');
    expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: `test-results/games-mines-${width}.png` });
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(page.getByRole('tab', { name: '시작하기', exact: true })).toBeFocused();
    await page.reload();
    expect(
      await page.evaluate(() => Number(localStorage.getItem('dachsterm.games.v1.blocks'))),
    ).toBeGreaterThan(0);
  });
}

test('workspace tabs preserve games and terminal, pause hidden rounds and close independently', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page.locator('header').getByRole('button', { name: '게임', exact: true }),
  ).toHaveCount(0);
  await openPreview(page);
  const terminal = page.locator('.xterm');
  await expect(terminal).toBeVisible();
  await terminal.evaluate((element) => element.setAttribute('data-instance', 'original'));
  await openGame(page, '블록 퍼즐');
  const blocks = page.getByRole('tabpanel', { name: '블록 퍼즐', exact: true });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(terminal).not.toBeVisible();
  await blocks.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.keyboard.press('Space');
  const score = await blocks.getByTestId('game-score').textContent();
  await openGame(page, '2048');
  const frozen = await page.locator('#game-panel-blocks .blocks-board').innerHTML();
  await page.waitForTimeout(900);
  expect(await page.locator('#game-panel-blocks .blocks-board').innerHTML()).toBe(frozen);
  await openGame(page, '블록 퍼즐');
  await expect(blocks.getByTestId('game-score')).toHaveText(score!);
  await expect(blocks.getByRole('button', { name: '계속하기', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '블록 퍼즐', exact: true })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(terminal).toBeVisible();
  await expect(terminal).toHaveAttribute('data-instance', 'original');
  await page.getByRole('tab', { name: '블록 퍼즐', exact: true }).click();
  await page.getByRole('button', { name: '2048 탭 닫기', exact: true }).click();
  await expect(blocks).toBeVisible();
  await page.getByRole('button', { name: '블록 퍼즐 탭 닫기', exact: true }).click();
  await expect(page.locator('#game-panel-blocks')).toHaveCount(0);
  await expect(terminal).toBeVisible();
  await expect(page.getByRole('tab', { name: '터미널 미리보기', exact: true })).toBeFocused();
  await openGame(page, '블록 퍼즐');
  await expect(blocks.getByTestId('game-score')).toHaveText('0');
});

test('game uses terminal theme tokens without resetting its board', async ({ page }) => {
  await page.goto('/');
  await openGame(page, '지뢰찾기');
  const panel = page.getByRole('tabpanel', { name: '지뢰찾기', exact: true });
  await panel.getByRole('group', { name: '지뢰찾기 게임판' }).getByRole('button').first().click();
  const board = await panel.locator('.mines-board').innerHTML();
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.getByRole('radio', { name: 'GitHub Dark', exact: true }).check();
  await page.getByRole('button', { name: '대화상자 닫기', exact: true }).click();
  expect(await panel.locator('.mines-board').innerHTML()).toBe(board);
  const colors = await panel.evaluate((element) => {
    const style = getComputedStyle(element);
    const probe = document.createElement('span');
    probe.style.backgroundColor = 'var(--terminal-background)';
    probe.style.color = 'var(--terminal-foreground)';
    element.append(probe);
    const expected = getComputedStyle(probe);
    const matches =
      style.backgroundColor === expected.backgroundColor && style.color === expected.color;
    probe.remove();
    return matches;
  });
  expect(colors).toBe(true);
  await page.screenshot({ path: 'test-results/games-dark.png' });
});
