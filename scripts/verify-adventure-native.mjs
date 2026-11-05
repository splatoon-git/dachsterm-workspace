import { expect } from '@playwright/test';
export async function verifyAdventureVariety(page, game) {
  const board = game.getByRole('group', { name: '닥스의 모험 게임판' });
  await game.locator('.adventure-map-options summary').click();
  await game.getByRole('textbox', { name: '맵 시드' }).fill('42');
  await game.getByRole('button', { name: '시드로 생성', exact: true }).click();
  for (const [name, biome] of [
    ['바람숲', 'forest'],
    ['물길 유적', 'ruins'],
    ['수정 동굴', 'cave'],
    ['눈바람 고개', 'snow'],
  ]) {
    await game.getByRole('button', { name, exact: true }).click();
    await expect(game.locator('.adventure-play')).toHaveAttribute('data-biome', biome);
    await expect(board).toHaveAttribute('data-seed', '42');
  }
  await game.getByRole('button', { name: '바람숲', exact: true }).click();
  await game.locator('.adventure-map-options summary').click();
  await game.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.keyboard.press('Space');
  await expect(board).toHaveAttribute('data-motion', 'bite');
  await expect(board).toHaveAttribute('data-y', '0');
  await page.keyboard.press('ArrowUp');
  await expect.poll(async () => Number(await board.getAttribute('data-y'))).toBeGreaterThan(70);
  await page.keyboard.press('ArrowDown');
  await expect(board).toHaveAttribute('data-motion', 'stomp');
  await expect(board).toHaveAttribute('data-y', '0');
  await page.keyboard.press('p');
  const frozen = await board.innerHTML();
  await page.waitForTimeout(150);
  expect(await board.innerHTML()).toBe(frozen);
  await page.screenshot({ path: 'target/verification/adventure-native.png' });
  console.log(
    'Native adventure: four seeded biomes, Space bite without jump, Up jump, Down fast stomp and pause passed.',
  );
}
