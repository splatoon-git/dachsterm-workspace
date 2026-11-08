import { expect, test, type Page } from '@playwright/test';
import type { PendingSign, SignReply } from '../../src/features/terminal/agentSign';
import type {} from './fixtures/agent-sign';

const base: PendingSign = {
  type: 'agentSign',
  request: 'r1',
  owner: 'c1',
  session: '배포 서버',
  key: 'me@laptop',
  fingerprint: 'SHA256:abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  loginUser: 'git',
  namespace: null,
  hostKey: 'SHA256:HOSTKEYhostkeyHOSTKEYhostkeyHOSTKEYhostkey0',
  source: 'system',
  local: false,
  passphrase: false,
  seconds: 60,
};

async function open(page: Page, request: Partial<PendingSign> = {}, replies: SignReply[] = []) {
  await page.addInitScript(
    ({ value, replies }) => {
      window.__signRequest = value;
      window.__signReplies = replies;
    },
    { value: { ...base, ...request }, replies },
  );
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
  await expect(card).toContainText('이 PC의 SSH agent');
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
    expect(await page.evaluate(() => window.__signAnswer)).toEqual({ decision });
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

test('a local tab names the tab, not a server', async ({ page }) => {
  const card = await open(page, { session: 'Windows PowerShell', local: true, source: 'app' });
  await expect(card.getByRole('heading')).toHaveText(
    '이 탭의 프로그램이 앱의 키로 서명하려고 합니다',
  );
  await expect(card).toContainText('Windows PowerShell');
  await expect(card).toContainText('이 앱의 키 파일');
  await card.getByRole('button', { name: '이 탭에서 10분 허용', exact: true }).click();
  expect(await page.evaluate(() => window.__signAnswer)).toEqual({ decision: 'connection' });
});

test('every answer stays reachable in a narrow pane', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const card = await open(page);
  for (const name of ['거부', '이번만 허용', '이 연결에서 10분 허용'])
    await expect(card.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  const box = (await card.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(360);
});

test('a locked app key asks for its Passphrase only after it is allowed', async ({ page }) => {
  const card = await open(page, { source: 'app', passphrase: true, seconds: 120 }, [
    { kind: 'passphrase', reason: 'needed' },
    { kind: 'passphrase', reason: 'wrong' },
  ]);
  await expect(card).toContainText('이 앱의 키 파일');
  await expect(card.getByLabel('Passphrase', { exact: true })).toHaveCount(0);
  await expect(card).not.toBeFocused();
  await card.getByRole('button', { name: '이 연결에서 10분 허용', exact: true }).click();
  const field = card.getByLabel('Passphrase', { exact: true });
  await expect(card.getByRole('status')).toHaveText(
    '암호화된 키 파일입니다. Passphrase를 입력하세요.',
  );
  await expect(field).toBeFocused();
  await expect(card.getByRole('button', { name: '확인', exact: true })).toBeDisabled();
  await field.fill('first');
  await page.keyboard.press('Enter');
  await expect(card.getByRole('status')).toContainText('맞지 않습니다');
  await expect(field).toHaveValue('');
  await field.fill('second');
  await card.getByLabel('이 PC에 저장', { exact: true }).check();
  await card.getByRole('button', { name: '확인', exact: true }).click();
  expect(await page.evaluate(() => window.__signAnswer)).toEqual({
    decision: 'connection',
    passphrase: 'second',
    remember: true,
  });
});
