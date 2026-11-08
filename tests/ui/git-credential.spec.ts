import { expect, test, type Page } from '@playwright/test';
import type { CredentialReply, PendingCredential } from '../../src/features/terminal/agentSign';
import type {} from './fixtures/git-credential';

const base: PendingCredential = {
  type: 'gitCredential',
  request: 'r1',
  owner: 'c1',
  session: '배포 서버',
  host: 'git.example.com',
  path: null,
  username: null,
  serverHelpers: [],
  seconds: 60,
};

async function open(
  page: Page,
  request: Partial<PendingCredential> = {},
  replies: CredentialReply[] = [],
) {
  await page.addInitScript(
    ({ value, replies }) => {
      window.__credentialRequest = value;
      window.__credentialReplies = replies;
    },
    { value: { ...base, ...request }, replies },
  );
  await page.goto('/tests/ui/fixtures/git-credential.html');
  return page.getByRole('alertdialog', { name: 'Git 자격 증명 요청', exact: true });
}
const answers = (page: Page) => page.evaluate(() => window.__credentialAnswers);

test('says the value goes to the server, names the server and counts down', async ({ page }) => {
  const card = await open(page, { path: 'team/app.git', username: 'me' });
  await expect(card.getByText('서버로 전달됩니다', { exact: true })).toBeVisible();
  await expect(card).toContainText('배포 서버');
  await expect(card).toContainText('https://git.example.com');
  await expect(card).toContainText('team/app.git');
  await expect(card).toContainText('me');
  await expect(card.getByRole('note')).toHaveCount(0);
  await expect(card.getByRole('timer')).toContainText('60초');
  await expect(card.getByRole('timer')).toContainText('59초', { timeout: 3000 });
  await expect(card).not.toBeFocused();
});

test("warns when the server user's own helper may keep the value", async ({ page }) => {
  const card = await open(page, { serverHelpers: ['store', 'cache --timeout=900'] });
  await expect(card.getByRole('note')).toHaveText(
    '서버의 Git helper(store, cache --timeout=900)가 이 값을 서버에 저장할 수 있습니다.',
  );
});

for (const [name, decision] of [
  ['거부', 'deny'],
  ['이번만 허용', 'once'],
  ['이 연결에서 10분 허용', 'connection'],
] as const)
  test(`"${name}" answers ${decision}`, async ({ page }) => {
    const card = await open(page);
    await card.getByRole('button', { name, exact: true }).click();
    expect(await answers(page)).toEqual([{ decision }]);
  });

test('with nothing saved, allowing turns the card into fields with fresh time', async ({
  page,
}) => {
  const card = await open(page, { username: 'me' }, [
    { kind: 'input', reason: 'notFound', seconds: 120 },
  ]);
  await card.getByRole('button', { name: '이번만 허용', exact: true }).click();
  await expect(card.getByRole('status')).toContainText('저장된 값이 없습니다');
  await expect(card.getByRole('timer')).toContainText('120초');
  await expect(card.getByLabel('사용자 이름', { exact: true })).toHaveValue('me');
  const token = card.getByLabel('토큰 또는 암호', { exact: true });
  await expect(token).toBeFocused();
  await expect(card.getByRole('button', { name: '확인', exact: true })).toBeDisabled();
  await token.fill('typed-value');
  await card.getByLabel('이 PC에 저장', { exact: true }).check();
  await token.press('Enter');
  expect(await answers(page)).toEqual([
    { decision: 'once' },
    { decision: 'once', username: 'me', password: 'typed-value', remember: true },
  ]);
});

test('typing it directly asks for both fields and refuses a second line', async ({ page }) => {
  const card = await open(page, {}, [{ kind: 'input', reason: 'chosen', seconds: 120 }]);
  await card.getByRole('button', { name: '직접 입력', exact: true }).click();
  const user = card.getByLabel('사용자 이름', { exact: true });
  await expect(user).toBeFocused();
  await user.fill('me');
  const confirm = card.getByRole('button', { name: '확인', exact: true });
  await expect(confirm).toBeDisabled();
  await card.getByLabel('토큰 또는 암호', { exact: true }).fill('t');
  await expect(confirm).toBeEnabled();
  await user.fill('me\u0085x');
  await expect(confirm).toBeDisabled();
  await card.getByRole('button', { name: '거부', exact: true }).click();
  expect(await answers(page)).toEqual([{ decision: 'input' }, { decision: 'deny' }]);
});

test('server text stays text', async ({ page }) => {
  const card = await open(page, { path: '<img src=x onerror=alert(1)>' });
  await expect(card).toContainText('<img src=x onerror=alert(1)>');
  await expect(card.locator('img')).toHaveCount(0);
});

test('every answer stays reachable in a narrow pane', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  const card = await open(page, { serverHelpers: ['store'], path: 'a/b.git', username: 'me' });
  for (const name of ['거부', '직접 입력', '이번만 허용', '이 연결에서 10분 허용'])
    await expect(card.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 });
  const box = (await card.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(360);
});
