import { test, expect, type Page } from '@playwright/test';
async function openAdventure(page: Page) {
  await page.goto('/');
  if (!(await page.locator('.sidebar-games summary').isVisible()))
    await page.getByRole('button', { name: '사이드바', exact: true }).click();
  await page.locator('.sidebar-games summary').click();
  await page
    .getByRole('navigation', { name: '게임 목록' })
    .getByRole('button', { name: '닥스의 모험', exact: true })
    .click();
  return page.getByRole('tabpanel', { name: '닥스의 모험', exact: true });
}
for (const width of [1280, 360])
  test(`seeded biomes, mechanics and replay controls fit ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const game = await openAdventure(page);
    const board = game.getByRole('group', { name: '닥스의 모험 게임판' });
    await game.locator('.adventure-map-options summary').click();
    const seed = game.getByRole('textbox', { name: '맵 시드' });
    await seed.fill('42');
    await game.getByRole('button', { name: '시드로 생성', exact: true }).click();
    await expect(board).toHaveAttribute('data-seed', '42');
    for (const [name, biome] of [
      ['바람숲', 'forest'],
      ['물길 유적', 'ruins'],
      ['수정 동굴', 'cave'],
      ['눈바람 고개', 'snow'],
    ]) {
      await game.getByRole('button', { name, exact: true }).click();
      await expect(game.locator('.adventure-play')).toHaveAttribute('data-biome', biome);
      const scene = await board.innerHTML();
      await game.getByRole('button', { name: '시드로 생성', exact: true }).click();
      expect(await board.innerHTML()).toBe(scene);
      if (biome === 'forest') await expect(game.locator('.adventure-spring').first()).toBeVisible();
      if (biome === 'ruins') {
        await expect(game.locator('.adventure-platform.moving').first()).toBeAttached();
        await expect(game.locator('.adventure-gate').first()).toHaveAttribute('data-open', 'false');
      }
      if (biome === 'cave') {
        await expect(game.locator('.adventure-vent').first()).toBeAttached();
        await expect(game.locator('.adventure-platform.crumble').first()).toBeAttached();
      }
      if (biome === 'snow') {
        await expect(game.locator('.adventure-ice').first()).toBeAttached();
        await expect(game.locator('.adventure-enemy.boar').first()).toBeAttached();
      }
      await game.locator('.adventure-map-options summary').click();
      await page.screenshot({ path: `target/verification/adventure-${biome}-${width}.png` });
      expect(await game.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
      await game.locator('.adventure-map-options summary').click();
    }
    const before = await board.innerHTML();
    await seed.fill('43');
    await game.getByRole('button', { name: '시드로 생성', exact: true }).click();
    expect(await board.innerHTML()).not.toBe(before);
    await seed.fill('4294967296');
    await expect(game.getByRole('button', { name: '시드로 생성', exact: true })).toBeDisabled();
    await game.getByRole('button', { name: '게임 시작', exact: true }).click();
    await expect(seed).toBeDisabled();
    await expect(game.getByRole('button', { name: '새 랜덤 맵', exact: true })).toBeDisabled();
    await page.keyboard.press('p');
    await game.getByRole('button', { name: '새 랜덤 맵', exact: true }).click();
    expect(await board.getAttribute('data-seed')).not.toBe('43');
    await expect(board).toHaveAttribute('data-x', '100');
  });

test('Space bites without jumping and Down stomps an enemy then bounces', async ({ page }) => {
  const game = await openAdventure(page);
  const board = game.getByRole('group', { name: '닥스의 모험 게임판' });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await game.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.keyboard.press('Space');
  await page.clock.runFor(30);
  await expect(board).toHaveAttribute('data-motion', 'bite');
  await expect(board).toHaveAttribute('data-y', '0');
  await page.keyboard.down('d');
  await page.clock.runFor(900);
  await page.keyboard.press('ArrowUp');
  await page.clock.runFor(450);
  await page.keyboard.press('ArrowDown');
  await page.clock.runFor(16);
  await expect(board).toHaveAttribute('data-motion', 'stomp');
  await page.clock.runFor(90);
  await page.keyboard.up('d');
  await expect(game.getByTestId('game-score')).toHaveText('100');
  await expect(game.getByTestId('adventure-health')).toHaveAttribute('aria-label', '체력 5 / 5');
  await expect(game.locator('.adventure-enemy')).toHaveCount(6);
  expect(Number(await board.getAttribute('data-y'))).toBeGreaterThan(34);
  await page.screenshot({ path: 'target/verification/adventure-stomp.png' });
  await page.keyboard.press('p');
  const paused = await board.innerHTML();
  await page.clock.runFor(1000);
  expect(await board.innerHTML()).toBe(paused);
  await game.getByRole('button', { name: '다시 시작', exact: true }).click();
  await expect(board).toHaveAttribute('data-x', '100');
  await expect(game.locator('.adventure-enemy')).toHaveCount(7);
});

test('a generated stage clears and the next biome starts only on request', async ({ page }) => {
  test.setTimeout(60000);
  const { generateLevel } = await import('../../src/features/games/adventureLevels');
  const level = generateLevel(42, 0);
  const game = await openAdventure(page);
  const board = game.getByRole('group', { name: '닥스의 모험 게임판' });
  await game.locator('.adventure-map-options summary').click();
  await game.getByRole('textbox', { name: '맵 시드' }).fill('42');
  await game.getByRole('button', { name: '시드로 생성', exact: true }).click();
  await game.locator('.adventure-map-options summary').click();
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await game.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.keyboard.down('d');
  for (let i = 0; i < 500; i++) {
    if (await game.locator('.adventure-next').count()) break;
    const x = Number(await board.getAttribute('data-x'));
    const y = Number(await board.getAttribute('data-y'));
    if (
      y === 0 &&
      (level.spikes.some((p) => p.x - x > 0 && p.x - x < 72) ||
        level.gaps.some((g) => g.x - x > 0 && g.x - x < 40))
    )
      await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Space');
    await page.clock.runFor(64);
  }
  await page.keyboard.up('d');
  await expect(game.getByRole('status')).toContainText('구간 완료');
  const score = await game.getByTestId('game-score').textContent();
  const frozen = await board.innerHTML();
  await page.clock.runFor(1000);
  expect(await board.innerHTML()).toBe(frozen);
  await game.getByRole('button', { name: '다음 구간 → 물길 유적', exact: true }).click();
  await expect(board).toHaveAttribute('data-level', '1');
  await expect(board).toHaveAttribute('data-seed', '42');
  await expect(board).toHaveAttribute('data-x', '100');
  await expect(game.getByTestId('game-score')).toHaveText(score!);
  await expect(game.getByRole('button', { name: '게임 시작', exact: true })).toBeVisible();
  const ready = await board.innerHTML();
  await page.clock.runFor(1000);
  expect(await board.innerHTML()).toBe(ready);
  await page.screenshot({ path: 'target/verification/adventure-next-stage.png' });
});
