import { expect, test } from '@playwright/test';
import type {} from './fixtures/transfer';

test('preview, missing user, selection, failure retry and cancellation do not lose state', async ({
  page,
}) => {
  await page.goto('/tests/ui/fixtures/transfer.html');
  await page.getByRole('button', { name: '파일 선택 · 미리보기' }).click();
  await expect(page.getByRole('button', { name: '2개 세션 추가' })).toBeDisabled();
  await page.getByRole('checkbox').nth(1).uncheck();
  await page.getByLabel('개발 서버 사용자명').fill('developer');
  await page.evaluate(() => {
    window.__transferTest.fail = true;
  });
  await page.getByRole('button', { name: '1개 세션 추가' }).click();
  await expect(page.getByRole('alert')).toContainText('가져오기 실패 테스트');
  await expect(page.getByLabel('개발 서버 사용자명')).toHaveValue('developer');
  await page.evaluate(() => {
    window.__transferTest.fail = false;
  });
  await page.getByRole('button', { name: '1개 세션 추가' }).click();
  await expect(page.getByRole('status')).toHaveText('1개 세션을 추가했습니다.');
  const applied = JSON.parse(await page.evaluate(() => window.__transferTest.applied[0]));
  expect(applied.profiles.map((p: { id: string }) => p.id)).toEqual(['one']);
  expect(applied.groups.map((g: { id: string }) => g.id)).toEqual(['g']);
  expect(applied.tunnels).toEqual([]);
  await page.evaluate(() => {
    window.__transferTest.cancel = true;
  });
  await page.getByRole('button', { name: '파일 선택 · 미리보기' }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  expect(await page.evaluate(() => window.__transferTest.applied.length)).toBe(1);
});
for (const width of [1280, 560, 360]) {
  test(`transfer preview wraps and scrolls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await page.goto('/tests/ui/fixtures/transfer.html');
    await page.getByRole('button', { name: '파일 선택 · 미리보기' }).click();
    for (const selector of ['dialog', '.transfer-options', '.transfer-rows']) {
      expect(await page.locator(selector).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
        true,
      );
    }
    await page.screenshot({ path: `target/verification/transfer-${width}.png` });
    await page.getByRole('button', { name: '가져오기 취소', exact: true }).click();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
  });
}
