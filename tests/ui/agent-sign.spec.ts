import { expect, test, type Page } from '@playwright/test';
import type { PendingSign } from '../../src/features/terminal/agentSign';
import type {} from './fixtures/agent-sign';

const base: PendingSign = {
  type: 'agentSign',
  request: 'r1',
  connectionId: 'c1',
  session: '배포 서버',
  key: 'me@laptop',
  fingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  loginUser: 'git',
  namespace: null,
  hostKey: 'SHA256:HOSTKEYhostkeyHOSTKEYhostkeyHOSTKEYhostkey0',
  seconds: 60,
};

async function open(page: Page, request: Partial<PendingSign> = {}) {
  await page.addInitScript((value) => (window.__signRequest = value), { ...base, ...request });
  await page.goto('/tests/ui/fixtures/agent-sign.html');
  return page.getByRole('alertdialog', { name: '키 서명 요청', exact: true });
}

test('shows who asks, for what, with which key, and counts down', async ({ page }) => {
  const card = await open(page);
  await expect(card).toContainText('배포 서버');
  await expect(card).toContainText('다른 SSH 서버 로그인 · 사용자 git');
  await expect(card).toContainText(base.hostKey!);
  await expect(card).toContainText('me@laptop');
  await expect(card).toContainText(base.fingerprint);
  await expect(card.getByRole('timer')).toContainText('60초');
  await expect(card.getByRole('timer')).toContainText('59초', { timeout: 3000 });
  await expect(card).not.toBeFocused();
});

for (const [name, decision] of [
  ['거부', 'deny'],
  ['이번만 허용', 'once'],
  ['이 연결에서 10분 허용', 'connection'],
] as const)
  test(`"${name}" answers ${decision}`, async ({ page }) => {
    const card = await open(page);
    await card.getByRole('button', { name, exact: true }).click();
    expect(await page.evaluate(() => window.__signAnswer)).toBe(decision);
  });

test('a signature names its purpose, and server text stays text', async ({ page }) => {
  const card = await open(page, {
    loginUser: null,
    namespace: 'git',
    hostKey: null,
    key: '<img src=x onerror=alert(1)>',
  });
  await expect(card).toContainText('데이터 서명 · 용도 git');
  await expect(card).not.toContainText('로그인할 서버');
  await expect(card).toContainText('<img src=x onerror=alert(1)>');
  await expect(card.locator('img')).toHaveCount(0);
});

test('every answer stays reachable in a narrow pane', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const card = await open(page);
  for (const name of ['거부', '이번만 허용', '이 연결에서 10분 허용'])
    await expect(card.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  const box = (await card.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(360);
});
