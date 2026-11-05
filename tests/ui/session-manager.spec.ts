import { expect, test } from '@playwright/test';
import type {} from './fixtures/session-manager';
test('500 profiles, compound selection, explicit preview and exact field patch', async ({
  page,
}) => {
  await page.goto('/tests/ui/fixtures/session-manager.html');
  await page.getByLabel('관리 대상 검색').fill('tag:prod group:서울 user:app');
  await page.getByRole('button', { name: '검색 결과 전체 선택' }).click();
  await page.getByLabel('태그 변경', { exact: true }).check();
  await page.getByLabel('일괄 태그', { exact: true }).fill('prod, verified');
  await page.getByRole('button', { name: '변경 미리보기' }).click();
  await expect(page.getByRole('heading', { name: '2개 세션 변경 확인' })).toBeVisible();
  expect(await page.evaluate(() => window.__sessionBatch.length)).toBe(0);
  await page.getByRole('button', { name: '복구본 생성 후 일괄 적용' }).click();
  const batch = (await page.evaluate(() => window.__sessionBatch[0])) as {
    expected: { id: string }[];
    options: unknown;
  };
  expect(batch.expected.map((p) => p.id)).toEqual(['0', '1']);
  expect(batch.options).toEqual({ tags: ['prod', 'verified'] });
});
for (const width of [360, 560, 1280])
  test(`manager keyboard and layout ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 820 });
    await page.goto('/tests/ui/fixtures/session-manager.html');
    await page.getByLabel('관리 대상 검색').focus();
    await page.keyboard.type('tag:prod');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '검색 결과 전체 선택' })).toBeFocused();
    for (const selector of ['dialog', '.form-grid', '.transfer-rows'])
      expect(await page.locator(selector).evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
        true,
      );
    await page.screenshot({ path: `target/verification/session-manager-${width}.png` });
  });
