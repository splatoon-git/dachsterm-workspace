import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/tool-source';
import { openTools } from './helpers';

const fixture = '/tests/ui/fixtures/tool-source.html';
const state = (page: Page) => page.evaluate(() => window.__toolSource);
const callsOf = async (page: Page, command: string) =>
  (await state(page)).calls.filter((call) => call.command === command);
const emit = (page: Page, event: Parameters<Window['__toolSource']['emit']>[0]) =>
  page.evaluate((e) => window.__toolSource.emit(e), event);
const connected = { type: 'state', status: 'connected', message: '연결됨 · web' } as const;

async function pickSession(page: Page, name: string) {
  await page.getByRole('radio', { name: '리모트', exact: true }).check();
  await page.getByRole('button', { name: '세션 선택', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(name) }).click();
}

test('the tools menu has the planned order and keeps the tunnel where it was', async ({ page }) => {
  await page.goto('/');
  await openTools(page);
  const items = page.locator('.toolbar-menu-items');
  const labels = await items.locator(':scope > button, .menu-label, nav button').allInnerTexts();
  expect(labels.slice(0, 8).map((text) => text.trim())).toEqual([
    '터널',
    'SSH 키 만들기',
    '문서 편집기',
    '네트워크',
    '포트 개통',
    '포트 사용 여부',
    '서비스 연결',
    '게임',
  ]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '터널', exact: true })).toBeVisible();
});

test('a network tool opens one tab, and closing it removes the tab', async ({ page }) => {
  await page.goto('/');
  const openTool = async () => {
    await openTools(page);
    await page
      .getByRole('navigation', { name: '네트워크 도구 목록' })
      .getByRole('button', { name: '포트 개통', exact: true })
      .click();
  };
  await openTool();
  await expect(page.getByRole('region', { name: '포트 개통', exact: true })).toBeVisible();
  await expect(page.locator('.terminal-pane')).toHaveCount(0);
  await openTool();
  const tabs = page.locator('.tab-strip').getByRole('tab', { name: '포트 개통', exact: true });
  await expect(tabs).toHaveCount(1);
  await page.getByRole('button', { name: '포트 개통 탭 닫기', exact: true }).click();
  await expect(tabs).toHaveCount(0);
  await expect(page.getByRole('region', { name: '포트 개통', exact: true })).toHaveCount(0);
});

test('local is the default source and asks the backend for nothing', async ({ page }) => {
  await page.goto(fixture);
  await expect(page.getByRole('radio', { name: '로컬', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: '점검', exact: true })).toBeEnabled();
  expect((await state(page)).calls).toEqual([]);
});

test('the session list shows SSH sessions with their state and can be searched', async ({
  page,
}) => {
  await page.goto(fixture);
  await page.getByRole('radio', { name: '리모트', exact: true }).check();
  await page.getByRole('button', { name: '세션 선택', exact: true }).click();
  const list = page.locator('.tool-session-list');
  await expect(list.getByRole('button')).toHaveCount(2);
  await expect(list.getByRole('button', { name: /웹 서버/ })).toContainText('연결됨');
  await expect(list.getByRole('button', { name: /DB 서버/ })).toContainText('미연결');
  await expect(list).not.toContainText('파일 서버');
  await list.getByRole('searchbox', { name: '세션 검색' }).fill('db.example');
  await expect(list.getByRole('button')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();
});

test('host key and login cards appear in the tab and answer the backend', async ({ page }) => {
  await page.goto(fixture);
  await pickSession(page, '웹 서버');
  await expect(page.getByRole('status')).toContainText('연결하는 중');
  const [{ args }] = await callsOf(page, 'net_connect');
  expect(args.profileId).toBe('web');

  await emit(page, {
    type: 'authPrompt',
    challenge: 'c1',
    name: '1홉 웹 · 세션 인증',
    instructions: '이번 연결에만 사용합니다.',
    prompts: [{ prompt: '비밀번호', echo: false }],
  });
  const form = page.getByRole('form', { name: '서버 추가 인증' });
  await form.getByLabel('비밀번호', { exact: true }).fill('fixture-only');
  await form.getByRole('button', { name: '인증 응답', exact: true }).click();
  expect((await callsOf(page, 'auth_reply'))[0].args).toEqual({
    id: args.id,
    challenge: 'c1',
    responses: ['fixture-only'],
  });

  await emit(page, {
    type: 'hostKey',
    challenge: 'h1',
    host: 'web.example',
    port: 22,
    algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:abc',
  });
  const card = page.getByRole('alert', { name: '최초 호스트키 확인' });
  await expect(card).toContainText('SHA256:abc');
  await card.getByRole('button', { name: '지문 확인 · 신뢰하고 연결', exact: true }).click();
  expect((await callsOf(page, 'trust_host'))[0].args).toEqual({
    id: args.id,
    accept: true,
    challenge: 'h1',
  });
  await expect(card).toBeHidden();

  await emit(page, connected);
  await expect(page.getByRole('button', { name: '점검', exact: true })).toBeEnabled();
});

test('an ended link offers to connect again, and local lets go of it', async ({ page }) => {
  await page.goto(fixture);
  await pickSession(page, '웹 서버');
  const first = (await callsOf(page, 'net_connect'))[0].args.id;
  await emit(page, { type: 'state', status: 'error', message: '접속 실패' });
  await page.getByRole('button', { name: '다시 연결', exact: true }).click();
  const calls = await callsOf(page, 'net_connect');
  expect(calls).toHaveLength(2);
  expect(calls[1].args.id).not.toBe(first);
  const second = calls[1].args.id;
  await page.getByRole('radio', { name: '로컬', exact: true }).check();
  expect((await callsOf(page, 'net_disconnect')).at(-1)!.args.id).toBe(second);
  await expect(page.getByRole('button', { name: '점검', exact: true })).toBeEnabled();
});

test('a locked vault holds the connection until it opens', async ({ page }) => {
  await page.goto(fixture);
  await page.evaluate(() => {
    window.__toolSource.locked = true;
  });
  await pickSession(page, 'DB 서버');
  await expect.poll(() => callsOf(page, 'net_connect')).toEqual([]);
  await page.evaluate(() => window.__toolSource.unlock());
  await expect.poll(async () => (await callsOf(page, 'net_connect')).length).toBe(1);
});
