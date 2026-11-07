import { test, expect, type Page } from '@playwright/test';
async function openAdventure(page: Page) {
  await page.goto('/');
  if (!(await page.locator('.sidebar-games summary').isVisible()))
    await page.getByRole('tab', { name: '연결', exact: true }).click();
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
  await expect(board).toBeFocused();
  await page.keyboard.press('Space');
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

test('keyboard-only play defeats the boss and Space starts the next biome', async ({ page }) => {
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
  await board.focus();
  await page.keyboard.press('Space');
  let direction = 0;
  let captured = false;
  for (let i = 0; i < 1000; i++) {
    if (await game.locator('.adventure-next').count()) break;
    const x = Number(await board.getAttribute('data-x'));
    const y = Number(await board.getAttribute('data-y'));
    const bossAlive = Number(await board.getAttribute('data-boss-health')) > 0;
    const inArena = (await board.getAttribute('data-boss')) !== 'dormant' && bossAlive;
    const bossX = Number(await board.getAttribute('data-boss-x'));
    const desired = inArena ? (Math.abs(bossX - x) > 15 ? Math.sign(bossX - x) : 0) : 1;
    if (desired !== direction) {
      if (direction) await page.keyboard.up(direction > 0 ? 'd' : 'a');
      if (desired) await page.keyboard.down(desired > 0 ? 'd' : 'a');
      direction = desired;
    }
    if (inArena && !captured) {
      await expect(game.locator('.adventure-boss-hud')).toContainText('이끼숲 수호자');
      await page.screenshot({ path: 'target/verification/adventure-boss.png' });
      captured = true;
    }
    if (
      y === 0 &&
      ((inArena && Math.abs(bossX - x) < 230) ||
        level.spikes.some((p) => p.x - x > 0 && p.x - x < 72) ||
        level.gaps.some((g) => g.x - x > 0 && g.x - x < 40))
    )
      await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Space');
    await page.clock.runFor(64);
  }
  if (direction) await page.keyboard.up(direction > 0 ? 'd' : 'a');
  expect(captured).toBe(true);
  await expect(board).toHaveAttribute('data-boss-health', '0');
  await expect(game.getByRole('status')).toContainText('구간 완료');
  const score = await game.getByTestId('game-score').textContent();
  const frozen = await board.innerHTML();
  await page.clock.runFor(1000);
  expect(await board.innerHTML()).toBe(frozen);
  await page.keyboard.press('Space');
  await expect(board).toHaveAttribute('data-level', '1');
  await expect(board).toHaveAttribute('data-seed', '42');
  await expect(board).toHaveAttribute('data-x', '100');
  await expect(game.getByTestId('game-score')).toHaveText(score!);
  await expect(game.getByRole('button', { name: '일시정지', exact: true })).toBeVisible();
  await expect(board).toHaveAttribute('data-motion', 'idle');
  await page.keyboard.down('d');
  await page.clock.runFor(300);
  await page.keyboard.up('d');
  expect(Number(await board.getAttribute('data-x'))).toBeGreaterThan(140);
  await page.screenshot({ path: 'target/verification/adventure-next-stage.png' });
});

test('Space and P handle start, repeat suppression and pause/resume without mouse input', async ({
  page,
}) => {
  const game = await openAdventure(page);
  const board = game.getByRole('group', { name: '닥스의 모험 게임판' });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await expect(board).toBeFocused();
  await page.keyboard.down('Space');
  await page.keyboard.down('Space');
  await page.clock.runFor(80);
  await expect(board).toHaveAttribute('data-motion', 'idle');
  await page.keyboard.up('Space');
  await page.keyboard.press('Space');
  await page.clock.runFor(32);
  await expect(board).toHaveAttribute('data-motion', 'bite');
  await page.keyboard.press('p');
  const paused = await board.innerHTML();
  await page.clock.runFor(500);
  expect(await board.innerHTML()).toBe(paused);
  await page.keyboard.press('Space');
  await expect(game.getByRole('button', { name: '일시정지', exact: true })).toBeVisible();
  await page.keyboard.press('p');
  await page.keyboard.press('p');
  await expect(game.getByRole('button', { name: '일시정지', exact: true })).toBeVisible();
  await page.keyboard.press('m');
  await expect(game.getByRole('button', { name: '효과음 꺼짐 · M' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(game.locator('.adventure-impact-camera')).toHaveCSS('transform', 'none');
});

test('Space retries after defeat from the latest shelter with no mouse interaction', async ({
  page,
}) => {
  test.setTimeout(90000);
  const game = await openAdventure(page);
  const board = game.getByRole('group', { name: '닥스의 모험 게임판' });
  await expect(board).toBeFocused();
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.keyboard.press('Space');
  await page.keyboard.down('d');
  const retry = game.getByRole('button', { name: 'Space 쉼터에서 재도전', exact: true });
  for (let i = 0; i < 80 && !(await retry.count()); i++) await page.clock.runFor(1000);
  await page.keyboard.up('d');
  await expect(retry).toBeVisible();
  const checkpoint = await board.getAttribute('data-checkpoint');
  const seed = await board.getAttribute('data-seed');
  const score = await game.getByTestId('game-score').textContent();
  await page.keyboard.press('Space');
  await expect(board).toHaveAttribute('data-x', checkpoint!);
  await expect(board).toHaveAttribute('data-seed', seed!);
  await expect(game.getByTestId('adventure-health')).toHaveAttribute('aria-label', '체력 5 / 5');
  await expect(game.getByTestId('game-score')).toHaveText(score!);
  await expect(game.getByRole('button', { name: '일시정지', exact: true })).toBeVisible();
  await page.clock.runFor(100);
  await expect(board).toHaveAttribute('data-motion', 'idle');
});
