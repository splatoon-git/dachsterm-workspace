import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/paste-confirm';

async function open(page: Page, text: string) {
  await page.addInitScript((value) => (window.__pasteText = value), text);
  await page.goto('/tests/ui/fixtures/paste-confirm.html');
}

test('shows the clipboard text with line breaks and controls marked', async ({ page }) => {
  await open(page, 'ls -al\nrm -rf build\x1b[A\n');
  const preview = page.getByLabel('붙여넣을 내용', { exact: true });
  await expect(preview).toContainText('ls -al');
  await expect(preview).toContainText('rm -rf build');
  await expect(preview.locator('mark')).toHaveText(['↵', 'ESC', '↵']);
  await expect(page.getByText('줄바꿈 2개 · 제어·숨김 문자 1개')).toBeVisible();
  await page.getByRole('button', { name: '붙여넣기 실행', exact: true }).click();
  expect(await page.evaluate(() => window.__pasteResult)).toBe('confirm');
});

test('renders clipboard markup as plain text', async ({ page }) => {
  await open(page, '<img src=x onerror=alert(1)>\n');
  const preview = page.getByLabel('붙여넣을 내용', { exact: true });
  await expect(preview).toContainText('<img src=x onerror=alert(1)>');
  await expect(preview.locator('img')).toHaveCount(0);
});

test('keeps the actions reachable and says when a long paste is only partly shown', async ({
  page,
}) => {
  await open(page, 'line\n'.repeat(5000));
  const preview = page.getByLabel('붙여넣을 내용', { exact: true });
  expect((await preview.boundingBox())!.height).toBeLessThanOrEqual(200);
  await expect(page.getByText('줄바꿈 5,000개')).toBeVisible();
  for (const name of ['취소', '붙여넣기 실행'])
    await expect(page.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  expect((await page.locator('.live-terminal').boundingBox())!.height).toBeGreaterThanOrEqual(100);
});

test('says when a long paste is only partly shown', async ({ page }) => {
  await open(page, 'x\n' + 'y'.repeat(20_500));
  await expect(
    page.getByText('표시하지 않은 502자도 함께 전송됩니다.', { exact: false }),
  ).toBeVisible();
});
