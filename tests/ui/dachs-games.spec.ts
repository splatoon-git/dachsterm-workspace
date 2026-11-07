import { expect, test, type Page } from '@playwright/test';
import { openGame as chooseGame } from './helpers';
import { openPreview } from './helpers';

async function openGame(page: Page, name: string) {
  await chooseGame(page, name);
  return page.getByRole('tabpanel', { name, exact: true });
}

for (const width of [1280, 560, 360]) {
  test(`Dachs games integrate, pause, jump, retain records and fit ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      Math.random = () => 0.5;
    });
    await page.goto('/');
    const snack = await openGame(page, '닥스의 간식 타임');
    const snackBoard = snack.getByRole('group', { name: '닥스의 간식 타임 게임판' });
    await expect(snackBoard).toBeVisible();
    await expect(snack.getByText('DACHS’S SNACK TIME', { exact: true })).toBeVisible();
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    await snack.getByRole('button', { name: '게임 시작', exact: true }).click();
    await expect(snackBoard).toBeFocused();
    await snackBoard.click();
    await page.clock.runFor(3000);
    expect(Number(await snack.getByTestId('game-score').textContent())).toBeGreaterThan(0);
    const initialX = Number(await snackBoard.getAttribute('data-x'));
    await page.keyboard.down('ArrowRight');
    await page.clock.runFor(200);
    await page.keyboard.up('ArrowRight');
    expect(Number(await snackBoard.getAttribute('data-x'))).toBeGreaterThan(initialX);
    await page.keyboard.press('p');
    const frozen = await snackBoard.innerHTML();
    await page.clock.runFor(2000);
    expect(await snackBoard.innerHTML()).toBe(frozen);
    const score = await snack.getByTestId('game-score').textContent();
    const adventure = await openGame(page, '닥스의 모험');
    const board = adventure.getByRole('group', { name: '닥스의 모험 게임판' });
    await adventure.getByRole('button', { name: '게임 시작', exact: true }).click();
    await expect(board).toBeFocused();
    await page.clock.runFor(300);
    await expect(board).toHaveAttribute('data-x', '100');
    await page.keyboard.down('ArrowRight');
    await page.clock.runFor(900);
    await page.keyboard.up('ArrowRight');
    const rightX = Number(await board.getAttribute('data-x'));
    expect(rightX).toBeGreaterThan(280);
    await page.keyboard.down('a');
    await page.clock.runFor(350);
    await page.keyboard.up('a');
    expect(Number(await board.getAttribute('data-x'))).toBeLessThan(rightX);
    await expect(board).toHaveAttribute('data-facing', '-1');
    await page.keyboard.press('ArrowUp');
    await page.clock.runFor(150);
    expect(Number(await board.getAttribute('data-y'))).toBeGreaterThan(45);
    await page.keyboard.press('Space');
    await page.clock.runFor(30);
    await expect(board).toHaveAttribute('data-motion', 'bite');
    await expect(adventure.locator('.adventure-bite')).toBeVisible();
    await page.screenshot({ path: `test-results/dachs-adventure-${width}.png` });
    await page.clock.runFor(700);
    await expect(board).toHaveAttribute('data-y', '0');
    await expect(adventure.getByRole('status')).toHaveText('플레이 중');
    await page.keyboard.press('p');
    const distance = await adventure.getByTestId('game-score').textContent();
    const pausedBoard = await board.innerHTML();
    await page.clock.runFor(2000);
    expect(await board.innerHTML()).toBe(pausedBoard);
    expect(await adventure.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    expect(await board.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await openGame(page, '닥스의 간식 타임');
    await expect(snack.getByTestId('game-score')).toHaveText(score!);
    await expect(snack.getByRole('button', { name: '계속하기', exact: true })).toBeVisible();
    await snack.getByRole('button', { name: '계속하기', exact: true }).click();
    await snackBoard.click();
    await page.clock.runFor(43000);
    await expect(snack.getByRole('status')).toContainText('45초 간식 사냥 완료');
    await page.screenshot({ path: `test-results/dachs-snack-${width}.png` });
    await page.keyboard.press('Escape');
    await page.clock.runFor(50);
    await expect(page.getByRole('tab', { name: '시작하기', exact: true })).toBeFocused();
    await page.getByRole('tab', { name: '닥스의 모험', exact: true }).click();
    await expect(adventure.getByTestId('game-score')).toHaveText(distance!);
    await adventure.getByRole('button', { name: '계속하기', exact: true }).click();
    await page.clock.runFor(500);
    await expect(adventure.getByRole('status')).toContainText('플레이 중');
    await adventure.getByRole('button', { name: '다시 시작', exact: true }).click();
    await expect(adventure.getByTestId('game-score')).toHaveText('0');
    await page.getByRole('button', { name: '닥스의 모험 탭 닫기', exact: true }).click();
    await expect(page.locator('#game-panel-adventure')).toHaveCount(0);
    await expect(page.locator('#game-panel-snack')).toHaveCount(1);
    await page.reload();
    expect(
      await page.evaluate(() => Number(localStorage.getItem('dachsterm.games.v1.snack'))),
    ).toBeGreaterThan(0);
    expect(
      await page.evaluate(() => Number(localStorage.getItem('dachsterm.games.v1.adventure'))),
    ).toBeGreaterThan(0);
  });
}

test('Dachs games follow theme, retain terminal instance, pause on blur and support touch', async ({
  page,
}) => {
  await page.goto('/');
  await openPreview(page);
  const terminal = page.locator('.xterm');
  await terminal.evaluate((e) => e.setAttribute('data-instance', 'kept'));
  const adventure = await openGame(page, '닥스의 모험');
  await adventure.getByRole('button', { name: '게임 시작', exact: true }).click();
  await expect(terminal).not.toBeVisible();
  await adventure.getByRole('button', { name: '↑ 점프', exact: true }).click();
  await expect
    .poll(async () =>
      Number(
        await adventure.getByRole('group', { name: '닥스의 모험 게임판' }).getAttribute('data-y'),
      ),
    )
    .toBeGreaterThan(35);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(adventure.getByRole('button', { name: '계속하기', exact: true })).toBeVisible();
  const frozen = await adventure.getByRole('group', { name: '닥스의 모험 게임판' }).innerHTML();
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.getByRole('radio', { name: 'GitHub Dark', exact: true }).check();
  await page.getByRole('button', { name: '대화상자 닫기', exact: true }).click();
  expect(await adventure.getByRole('group', { name: '닥스의 모험 게임판' }).innerHTML()).toBe(
    frozen,
  );
  expect(
    await adventure
      .locator('.adventure-board > svg')
      .evaluate(
        (e) => getComputedStyle(e).color === getComputedStyle(e.closest('.game-terminal')!).color,
      ),
  ).toBe(true);
  await page.screenshot({ path: 'test-results/dachs-dark.png' });
  await adventure.getByRole('group', { name: '닥스의 모험 게임판' }).focus();
  await page.keyboard.press('Escape');
  await expect(terminal).toBeVisible();
  await expect(terminal).toHaveAttribute('data-instance', 'kept');
});

test('adventure pointer movement combines with jump and bite, and clears on pause', async ({
  page,
}) => {
  await page.goto('/');
  const game = await openGame(page, '닥스의 모험');
  const board = game.getByRole('group', { name: '닥스의 모험 게임판' });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await game.getByRole('button', { name: '게임 시작', exact: true }).click();
  const right = game.getByRole('button', { name: '오른쪽으로', exact: true });
  const box = (await right.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.clock.runFor(450);
  expect(Number(await board.getAttribute('data-x'))).toBeGreaterThan(180);
  await page.keyboard.press('ArrowUp');
  await page.clock.runFor(150);
  expect(Number(await board.getAttribute('data-y'))).toBeGreaterThan(40);
  await page.keyboard.press('x');
  await page.clock.runFor(20);
  await expect(board).toHaveAttribute('data-motion', 'bite');
  await page.mouse.up();
  await page.keyboard.press('p');
  const frozen = await board.innerHTML();
  await page.clock.runFor(1000);
  expect(await board.innerHTML()).toBe(frozen);
  await game.getByRole('button', { name: '계속하기', exact: true }).click();
  await page.clock.runFor(500);
  const stopped = await board.getAttribute('data-x');
  await page.clock.runFor(500);
  await expect(board).toHaveAttribute('data-x', stopped!);
  await game.getByRole('button', { name: '다시 시작', exact: true }).click();
  await expect(board).toHaveAttribute('data-x', '100');
  await expect(game.getByTestId('adventure-health')).toHaveAttribute('aria-label', '체력 5 / 5');
});

test('adventure scrolls in both directions and defeats a monster with a timed bite', async ({
  page,
}) => {
  await page.setViewportSize({ width: 560, height: 900 });
  await page.goto('/');
  const game = await openGame(page, '닥스의 모험');
  const board = game.getByRole('group', { name: '닥스의 모험 게임판' });
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await game.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.keyboard.down('d');
  await page.clock.runFor(1180);
  await page.keyboard.press('Space');
  await page.clock.runFor(150);
  await page.keyboard.up('d');
  await expect(game.locator('.adventure-enemy')).toHaveCount(6);
  expect(Number(await game.getByTestId('game-score').textContent())).toBe(75);
  const camera = Number(await board.getAttribute('data-camera'));
  expect(camera).toBeGreaterThan(100);
  await page.keyboard.down('a');
  await page.clock.runFor(600);
  await page.keyboard.up('a');
  expect(Number(await board.getAttribute('data-camera'))).toBeLessThan(camera);
  await page.keyboard.press('p');
  await page.screenshot({ path: 'test-results/dachs-adventure-stage.png' });
});
