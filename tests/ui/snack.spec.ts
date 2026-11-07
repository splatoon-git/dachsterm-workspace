import { expect, test, type Page } from '@playwright/test';
import { openGame, openPreview } from './helpers';

async function setup(page: Page, kind: 'bone' | 'star' | 'onion' = 'bone') {
  await page.goto('/tests/ui/fixtures/snack.html');
  const board = page.getByRole('group', { name: '닥스의 간식 타임 게임판' });
  await expect(board).toBeVisible();
  await page.evaluate((kind) => {
    let call = 0;
    Math.random = () =>
      call++ % 3 === 0 ? (kind === 'star' ? 0.98 : kind === 'onion' ? 0.1 : 0.5) : 0.5;
  }, kind);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  return board;
}

for (const width of [360, 560, 1280]) {
  test(`snack motions, catch feedback, pause and scaled drag at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const board = await setup(page);
    await page.screenshot({ path: `target/verification/snack-ready-${width}.png` });
    await page.getByRole('button', { name: '게임 시작', exact: true }).click();
    await expect(board).toBeFocused();
    await page.clock.runFor(2700);
    await expect(page.getByTestId('game-score')).toHaveText('10');
    await expect(board).toHaveAttribute('data-motion', 'eat');
    await expect(board.locator('.snack-crumbs')).toBeVisible();
    await page.screenshot({ path: `target/verification/snack-eat-${width}.png` });
    await page.clock.runFor(900);
    await expect(page.getByTestId('snack-combo')).toHaveText('2개');
    const x = Number(await board.getAttribute('data-x'));
    await page.keyboard.down('a');
    await page.clock.runFor(150);
    await page.keyboard.up('a');
    expect(Number(await board.getAttribute('data-x'))).toBeLessThan(x);
    await expect(board).toHaveAttribute('data-facing', '-1');
    await page.clock.runFor(250);
    const box = (await board.boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6);
    await page.mouse.down();
    await page.clock.runFor(800);
    await page.mouse.up();
    const logicalWidth = Number(
      (await board.locator(':scope > svg').getAttribute('viewBox'))!.split(' ')[2],
    );
    expect(Math.abs(Number(await board.getAttribute('data-x')) / logicalWidth - 0.7)).toBeLessThan(
      0.02,
    );
    await page.keyboard.press('p');
    const frozen = await board.innerHTML();
    await page.clock.runFor(2000);
    expect(await board.innerHTML()).toBe(frozen);
    await page.getByRole('button', { name: '계속하기', exact: true }).click();
    await page.clock.runFor(250);
    const stoppedX = await board.getAttribute('data-x');
    await page.clock.runFor(300);
    expect(await board.getAttribute('data-x')).toBe(stoppedX);
    expect(await board.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    expect(await page.locator('main').evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    await page.getByRole('button', { name: '다시 시작', exact: true }).click();
    await expect(page.getByTestId('game-score')).toHaveText('0');
    await expect(page.getByTestId('snack-combo')).toHaveText('0개');
  });
}

test('star hop, reduced motion, resize, timer and round result', async ({ page }) => {
  test.setTimeout(60000);
  const board = await setup(page, 'star');
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.clock.runFor(2700);
  await expect(board).toHaveAttribute('data-motion', 'jump');
  await expect(page.getByTestId('game-score')).toHaveText('30');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(board.locator(':scope > svg')).toHaveAttribute('data-reduced-motion', 'true');
  await expect(board.locator('.snack-sparks')).toHaveCount(0);
  await page.keyboard.press('p');
  const score = await page.getByTestId('game-score').textContent();
  await page.setViewportSize({ width: 360, height: 900 });
  await page.clock.runFor(100);
  await expect(page.getByTestId('game-score')).toHaveText(score!);
  await expect(board).toHaveAttribute('data-x', '180');
  await page.getByRole('button', { name: '계속하기', exact: true }).click();
  await page.clock.runFor(43000);
  await expect(page.getByRole('status')).toContainText('45초 간식 사냥 완료');
  await expect(board).toContainText('잘 먹었습니다!');
  await expect(page.getByTestId('snack-time')).toHaveText('0초');
  const finished = await board.innerHTML();
  await page.clock.runFor(1000);
  expect(await board.innerHTML()).toBe(finished);
  await page.screenshot({ path: 'target/verification/snack-result-360.png' });
});

test('hurt response, shield, blur pause and life exhaustion', async ({ page }) => {
  const board = await setup(page, 'onion');
  await page.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.clock.runFor(2700);
  await expect(board).toHaveAttribute('data-motion', 'hurt');
  await expect(page.getByTestId('snack-lives')).toHaveAttribute('aria-label', '목숨 2 / 3');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByRole('button', { name: '계속하기', exact: true })).toBeVisible();
  const frozen = await board.innerHTML();
  await page.clock.runFor(1000);
  expect(await board.innerHTML()).toBe(frozen);
  await page.getByRole('button', { name: '계속하기', exact: true }).click();
  await page.clock.runFor(4000);
  await expect(page.getByRole('status')).toContainText('게임 종료');
  await expect(page.getByTestId('snack-lives')).toHaveAttribute('aria-label', '목숨 0 / 3');
  await expect(board).toContainText('잠깐, 배를 쉬어가요');
});

test('snack integrates with dark theme, tab preservation and the existing terminal', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Math.random = () => 0.5;
  });
  await page.goto('/');
  await openPreview(page);
  const terminal = page.locator('.xterm');
  await terminal.evaluate((e) => e.setAttribute('data-instance', 'snack-kept'));
  await openGame(page, '닥스의 간식 타임');
  const panel = page.getByRole('tabpanel', { name: '닥스의 간식 타임', exact: true });
  const board = panel.getByRole('group');
  await expect(board).toBeVisible();
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await panel.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.clock.runFor(2700);
  await expect(board).toHaveAttribute('data-motion', 'eat');
  await page.screenshot({ path: 'target/verification/snack-app-light.png' });
  await expect(terminal).not.toBeVisible();
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.getByRole('radio', { name: 'GitHub Dark', exact: true }).check();
  await page.getByRole('button', { name: '대화상자 닫기', exact: true }).click();
  await expect(panel.getByRole('button', { name: '계속하기', exact: true })).toBeVisible();
  const frozen = await board.innerHTML();
  await page.clock.runFor(1000);
  expect(await board.innerHTML()).toBe(frozen);
  expect(
    await board
      .locator(':scope > svg')
      .evaluate(
        (e) => getComputedStyle(e).color === getComputedStyle(e.closest('.game-terminal')!).color,
      ),
  ).toBe(true);
  await page.screenshot({ path: 'target/verification/snack-app-dark.png' });
  await board.focus();
  await page.keyboard.press('Escape');
  await expect(terminal).toBeVisible();
  await expect(terminal).toHaveAttribute('data-instance', 'snack-kept');
  await page.getByRole('tab', { name: '닥스의 간식 타임', exact: true }).click();
  expect(await board.innerHTML()).toBe(frozen);
  await expect(panel.getByTestId('game-score')).toHaveText('10');
});
