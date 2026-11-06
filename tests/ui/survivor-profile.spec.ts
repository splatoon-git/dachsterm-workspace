import { expect, test } from '@playwright/test';
import type {} from './fixtures/survivor-profile';

const fixture = '/tests/ui/fixtures/survivor-profile.html';
const key = 'dachsterm.games.survivor.v1';

for (const width of [360, 560, 1280]) {
  test(`hub purchases, key repeat, refund and persisted preferences at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${fixture}?funded${width === 560 ? '&dark' : ''}`);
    const hp = page.getByRole('button', { name: '든든한 몸 강화', exact: true });
    await expect(hp).toBeEnabled();
    await hp.dblclick();
    await expect(page.getByTestId('survivor-balance')).toHaveText('1,970');
    await hp.focus();
    await hp.dispatchEvent('keydown', { key: 'Enter', repeat: true });
    await expect(page.getByTestId('survivor-balance')).toHaveText('1,970');
    await page.getByRole('button', { name: '발자국 장판 해금' }).click();
    await page.getByRole('button', { name: '한 번 더 고민 해금' }).click();
    await page.getByRole('checkbox', { name: '효과음 끄기' }).uncheck();
    await page.getByRole('combobox', { name: '모션' }).selectOption('reduced');
    await page.getByRole('button', { name: '영구 강화 전액 환불' }).click();
    await expect(page.getByRole('group', { name: '환불 확인' })).toContainText('실제 지불액 30');
    await page.getByRole('button', { name: '환불 확정' }).click();
    await expect(page.getByTestId('survivor-balance')).toHaveText('1,750');
    await page.reload();
    await expect(page.getByRole('button', { name: '새 도전 시작' })).toBeEnabled();
    await expect(page.getByTestId('survivor-balance')).toHaveText('1,750');
    await expect(page.getByRole('button', { name: '발자국 장판 해금' })).toBeDisabled();
    await expect(page.getByRole('checkbox', { name: '효과음 끄기' })).not.toBeChecked();
    await expect(page.getByRole('combobox', { name: '모션' })).toHaveValue('reduced');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: `target/verification/survivor-hub-${width}.png`,
      fullPage: true,
    });
  });
}

test('real Web Locks allow one owner, storage events update reader, tab closure enables recovery', async ({
  page,
  context,
}) => {
  await page.goto(`${fixture}?funded`);
  await expect(page.getByRole('button', { name: '새 도전 시작' })).toBeEnabled();
  const other = await context.newPage();
  await other.goto(fixture);
  await expect(other.getByText('다른 창에서 사용 중입니다.', { exact: false })).toBeVisible();
  await expect(other.getByRole('button', { name: '든든한 몸 강화' })).toBeDisabled();
  await page.getByRole('button', { name: '든든한 몸 강화' }).click();
  await expect(other.getByTestId('survivor-balance')).toHaveText('1,970');
  await page.getByRole('button', { name: '새 도전 시작' }).click();
  await page.evaluate(() => {
    const session = window.survivorTest.session,
      r = session.run!;
    r.gold = 5.75;
    r.tick = 10800;
    r.stage.index = 3;
    r.highestReachedStage = 3;
    r.highestCompletedStage = 3;
    r.bossesDefeated = 1;
    r.bossRewardGold = 40;
    r.lastRewardedBossStage = 3;
    r.phase = 'stageClear';
    if (!session.sync(true)) throw Error('checkpoint failed');
  });
  await page.close();
  await other.getByRole('button', { name: '소유권 다시 확인' }).click();
  await expect(other.getByRole('button', { name: '새 도전 시작' })).toBeEnabled();
  await expect(other.getByTestId('survivor-balance')).toHaveText('2,045');
  await other.reload();
  await expect(other.getByRole('button', { name: '새 도전 시작' })).toBeEnabled();
  await expect(other.getByTestId('survivor-balance')).toHaveText('2,045');
  expect(
    await other.evaluate(() => window.survivorTest.store.getSnapshot().profile.settlements.length),
  ).toBe(1);
});

test('write failure leaves purchase unchanged and permits explicit retry', async ({ page }) => {
  await page.goto(`${fixture}?funded`);
  await expect(page.getByRole('button', { name: '든든한 몸 강화' })).toBeEnabled();
  await page.evaluate(() => {
    window.survivorTest.failWrites = true;
  });
  await page.getByRole('button', { name: '든든한 몸 강화' }).click();
  await expect(page.getByRole('status')).toContainText('저장하지 못했습니다');
  await expect(page.getByTestId('survivor-balance')).toHaveText('2,000');
  await page.evaluate(() => {
    window.survivorTest.failWrites = false;
  });
  await page.getByRole('button', { name: '저장 재시도', exact: true }).click();
  await expect(page.getByTestId('survivor-balance')).toHaveText('1,970');
});

for (const raw of ['{bad', '{"schemaVersion":999}']) {
  test(`invalid saved profile preserved: ${raw}`, async ({ page }) => {
    await page.addInitScript(
      ({ key, raw }) => {
        localStorage.setItem(key, raw);
      },
      { key, raw },
    );
    await page.goto(fixture);
    await expect(page.getByRole('button', { name: '저장 없이 임시 플레이' })).toBeVisible();
    await expect(page.getByRole('button', { name: '새 도전 시작' })).toBeDisabled();
    await page.getByRole('button', { name: '저장 없이 임시 플레이' }).click();
    expect(await page.evaluate(() => window.survivorTest.session.temporary)).toBe(true);
    expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(raw);
  });
}

test('unsupported lock API uses temporary play and never mutates existing profile', async ({
  page,
}) => {
  await page.goto(`${fixture}?funded&noLocks`);
  await expect(page.getByRole('button', { name: '저장 없이 임시 플레이' })).toBeVisible();
  const before = await page.evaluate((key) => localStorage.getItem(key), key);
  await page.getByRole('button', { name: '저장 없이 임시 플레이' }).click();
  await page.evaluate(() => {
    const s = window.survivorTest.session;
    s.run!.gold = 123;
    s.finish('abandoned');
  });
  expect(await page.evaluate((key) => localStorage.getItem(key), key)).toBe(before);
});
