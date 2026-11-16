import { expect, test } from '@playwright/test';
import { colorsFollowTheme } from './highlightCases';

test('a highlight rule colors matches with the theme token and follows a theme change', ({
  page,
}) => colorsFollowTheme(page));

test('a pattern that never ends is refused before it is saved', async ({ page }) => {
  await page.goto('/tests/ui/fixtures/terminal-pane.html');
  await page.getByRole('button', { name: '터미널 설정' }).click();
  await page.getByRole('button', { name: '규칙 추가' }).click();
  const form = page.getByRole('form', { name: '하이라이트 규칙' });
  await form.getByLabel('이름').fill('폭주');
  await form.getByLabel('패턴 (정규식)').fill('^(a+)+$');
  await form.getByRole('button', { name: '저장' }).click();
  await expect(form.getByRole('status')).toHaveText(/너무 오래/, { timeout: 10_000 });
});

test('typing answers is refused on a password prompt pattern', async ({ page }) => {
  await page.goto('/tests/ui/fixtures/terminal-pane.html');
  await page.getByRole('button', { name: '터미널 설정' }).click();
  await page.getByRole('button', { name: '규칙 추가' }).click();
  const form = page.getByRole('form', { name: '하이라이트 규칙' });
  await form.getByLabel('패턴 (정규식)').fill('[Pp]assword:');
  await expect(form.getByLabel('일치하면 입력 보내기')).toBeDisabled();
  await form.getByLabel('패턴 (정규식)').fill('Continue\\?');
  await form.getByLabel('일치하면 입력 보내기').check();
  await expect(form.getByRole('alert')).toContainText('의도하지 않은 명령');
  await form.getByRole('button', { name: '이해했고 켭니다' }).click();
  await expect(form.getByLabel('보낼 입력 (줄바꿈은 Enter)')).toBeVisible();
});
