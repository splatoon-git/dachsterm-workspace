import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/tool-source';
import type { CheckEvent, Outcome } from '../../src/features/tools/portCheck';
import type { Listener } from '../../src/features/tools/portUse';

const open = '/tests/ui/fixtures/tool-source.html?tool=portOpen';
const use = '/tests/ui/fixtures/tool-source.html?tool=portUse';
const callsOf = async (page: Page, command: string) =>
  (await page.evaluate(() => window.__toolSource.calls)).filter((c) => c.command === command);
const emit = (page: Page, events: CheckEvent[]) =>
  page.evaluate((list) => list.forEach((e) => window.__toolSource.emitCheck(e)), events);
const result = (host: string, port: number, outcome: Outcome = 'open'): CheckEvent => ({
  type: 'result',
  host,
  port,
  outcome,
  detail: null,
  method: 'direct',
});
const finished: CheckEvent = { type: 'finished', cancelled: false, message: null };

async function check(page: Page, targets: string, ports: string) {
  await page.getByLabel('대상', { exact: true }).fill(targets);
  await page.getByLabel('포트', { exact: true }).fill(ports);
  await page.getByRole('button', { name: '점검', exact: true }).click();
  await expect.poll(async () => (await callsOf(page, 'net_port_check')).length).toBeGreaterThan(0);
}

test('one host starts at once and each result is told apart', async ({ page }) => {
  await page.goto(open);
  await check(page, '10.0.0.5', '22,80');
  const [{ args }] = await callsOf(page, 'net_port_check');
  expect(args).toMatchObject({
    source: { kind: 'local' },
    targets: '10.0.0.5',
    ports: '22,80',
    timeoutSeconds: 3,
    confirmed: false,
  });
  await emit(page, [
    result('10.0.0.5', 22),
    result('10.0.0.5', 23, 'closed'),
    result('10.0.0.5', 24, 'noResponse'),
    result('10.0.0.5', 25, 'unreachable'),
    {
      ...result('10.0.0.5', 26, 'unknown'),
      detail: '서버가 알 수 없는 이유를 보냈습니다.',
    } as CheckEvent,
    finished,
  ]);
  const rows = page.locator('.tool-results tbody tr');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText('열림');
  await expect(rows.nth(1)).toContainText('닫힘');
  await expect(rows.nth(2)).toContainText('응답 없음');
  await expect(rows.nth(3)).toContainText('도달 불가');
  await expect(rows.nth(4)).toContainText('알 수 없는 이유');
  await expect(page.locator('.tool-summary')).toContainText('5개 중 1개 열림');
});

test('several hosts ask first, and only the confirmed call runs', async ({ page }) => {
  await page.goto(open);
  await page.evaluate(() => {
    window.__toolSource.checkStart = {
      state: 'needsConfirmation',
      hosts: 256,
      ports: 2,
      attempts: 512,
    };
  });
  await check(page, '10.0.0.0/24', '22,80');
  const dialog = page.getByRole('dialog', { name: '여러 대상 점검' });
  await expect(dialog).toContainText('512회');
  await expect(dialog).toContainText('허가된 망에서만');
  await page.evaluate(() => {
    window.__toolSource.checkStart = { state: 'running' };
  });
  await dialog.getByRole('button', { name: '512회 점검', exact: true }).click();
  await expect(dialog).toBeHidden();
  const calls = await callsOf(page, 'net_port_check');
  expect(calls.map((c) => c.args.confirmed)).toEqual([false, true]);
});

test('refusing the confirmation runs nothing', async ({ page }) => {
  await page.goto(open);
  await page.evaluate(() => {
    window.__toolSource.checkStart = {
      state: 'needsConfirmation',
      hosts: 2,
      ports: 1,
      attempts: 2,
    };
  });
  await check(page, 'a b', '22');
  await page
    .getByRole('dialog', { name: '여러 대상 점검' })
    .getByRole('button', { name: '취소', exact: true })
    .click();
  await expect(page.getByRole('button', { name: '점검', exact: true })).toBeEnabled();
  expect(await callsOf(page, 'net_port_check')).toHaveLength(1);
});

test('a bad input shows the backend error and no results', async ({ page }) => {
  await page.goto(open);
  await page.evaluate(() => {
    window.__toolSource.checkError = '대역이 너무 큽니다.';
  });
  await check(page, '10.0.0.0/8', '22');
  await expect(page.getByRole('alert')).toContainText('대역이 너무 큽니다.');
  await expect(page.locator('.tool-results')).toHaveCount(0);
});

test('a timeout out of range is stopped on the screen', async ({ page }) => {
  await page.goto(open);
  await page.getByLabel('시간 초과(초)').fill('31');
  await page.getByLabel('대상', { exact: true }).fill('a');
  await page.getByLabel('포트', { exact: true }).fill('1');
  await page.getByRole('button', { name: '점검', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('1~30초');
  expect(await callsOf(page, 'net_port_check')).toEqual([]);
});

test('a running check can be cancelled and keeps what it found', async ({ page }) => {
  await page.goto(open);
  await check(page, '10.0.0.5', '22');
  const [{ args }] = await callsOf(page, 'net_port_check');
  await emit(page, [{ type: 'progress', done: 1, total: 4, waiting: true, phase: 'probing' }]);
  await expect(page.locator('.tool-summary')).toContainText('서버 응답 대기 중');
  await page.getByRole('button', { name: '취소', exact: true }).click();
  expect((await callsOf(page, 'net_cancel'))[0].args.jobId).toBe(args.jobId);
  await emit(page, [
    result('10.0.0.5', 22),
    {
      type: 'finished',
      cancelled: true,
      message: '서버에 남은 시도 3개를 정리하려고 출발지 연결을 닫았습니다.',
    },
  ]);
  await expect(page.locator('.tool-summary')).toContainText('취소됨');
  await expect(page.locator('.tool-summary')).toContainText('정리하려고');
  await expect(page.locator('.tool-results tbody tr')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '점검', exact: true })).toBeEnabled();
});

test('many results open on the open ports and the rest can be shown', async ({ page }) => {
  await page.goto(open);
  await check(page, '10.0.0.5', '1-20');
  const events: CheckEvent[] = Array.from({ length: 20 }, (_, i) =>
    result('10.0.0.5', i + 1, i < 2 ? 'open' : 'closed'),
  );
  await emit(page, [...events, finished]);
  await expect(page.locator('.tool-summary')).toContainText('20개 중 2개 열림');
  await expect(page.locator('.tool-results tbody tr')).toHaveCount(2);
  await page.getByLabel('전체 결과 보기').check();
  await expect(page.locator('.tool-results tbody tr')).toHaveCount(20);
});

test('the row menu copies and checks that row again in place', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(open);
  await check(page, '10.0.0.5', '22,80');
  await emit(page, [result('10.0.0.5', 22, 'closed'), result('10.0.0.5', 80), finished]);
  const row = page.locator('.tool-results tbody tr').first();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '복사' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.split('\t').slice(0, 4)).toEqual(['이 PC', '10.0.0.5', '22', '닫힘']);

  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '다시 점검' }).click();
  await expect.poll(async () => (await callsOf(page, 'net_port_check')).length).toBe(2);
  expect((await callsOf(page, 'net_port_check'))[1].args).toMatchObject({
    targets: '10.0.0.5',
    ports: '22',
    confirmed: true,
  });
  await emit(page, [result('10.0.0.5', 22, 'open'), finished]);
  await expect(page.locator('.tool-results tbody tr')).toHaveCount(2);
  await expect(page.locator('.tool-summary')).toContainText('2개 중 2개 열림');
});

test('a remote source must be connected before checking', async ({ page }) => {
  await page.goto(open);
  await page.getByRole('radio', { name: '리모트', exact: true }).check();
  await expect(page.getByRole('button', { name: '점검', exact: true })).toBeDisabled();
  await expect(page.locator('.tool-pending')).toContainText('세션을 고르고');
});

const listeners: Listener[] = [
  {
    protocol: 'tcp',
    address: '0.0.0.0',
    port: 22,
    process: { kind: 'known', name: 'sshd', pid: 10 },
  },
  { protocol: 'tcp', address: '::', port: 80, process: { kind: 'denied' } },
  { protocol: 'udp', address: '0.0.0.0', port: 68, process: { kind: 'unavailable' } },
];
const setListeners = (page: Page, value: unknown) =>
  page.evaluate((v) => {
    window.__toolSource.listeners = v as typeof window.__toolSource.listeners;
  }, value);
const list = { method: 'procSs', listeners };

test('with no port the whole list appears and says how it was read', async ({ page }) => {
  await page.goto(use);
  await setListeners(page, list);
  await page.getByRole('button', { name: '확인', exact: true }).click();
  const rows = page.locator('.tool-results tbody tr');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('sshd (10)');
  await expect(rows.nth(1)).toContainText('권한 없음');
  await expect(rows.nth(2)).toContainText('UDP');
  await expect(page.locator('.tool-summary')).toContainText('/proc/net, ss');
  await expect(page.locator('.tool-notice')).toContainText('다른 계정');
  expect((await callsOf(page, 'net_listeners'))[0].args).toEqual({ source: { kind: 'local' } });
});

test('with a port it answers used or unused, and narrowing asks nothing more', async ({ page }) => {
  await page.goto(use);
  await setListeners(page, list);
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await expect(page.locator('.tool-results tbody tr')).toHaveCount(3);
  await page.getByLabel('포트(비우면 전체)').fill('22,443');
  await expect(page.locator('.tool-results tbody tr')).toHaveCount(1);
  await expect(page.locator('.tool-summary')).toContainText('사용 중 1개 · 사용 안 함 1개');
  await expect(page.locator('.tool-unused')).toContainText('443');
  expect(await callsOf(page, 'net_listeners')).toHaveLength(1);
});

async function failedLink(page: Page, ports: string) {
  await page.getByRole('radio', { name: '리모트', exact: true }).check();
  await page.getByRole('button', { name: '세션 선택', exact: true }).click();
  await page.getByRole('button', { name: /웹 서버/ }).click();
  await page.evaluate(() =>
    window.__toolSource.emit({ type: 'state', status: 'error', message: '인증 거부' }),
  );
  await page.getByLabel('포트(비우면 전체)').fill(ports);
}

test('when SSH fails the asked ports are tried from this PC and labelled so', async ({ page }) => {
  await page.goto(use);
  await failedLink(page, '22');
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await expect.poll(async () => (await callsOf(page, 'net_port_check')).length).toBe(1);
  expect((await callsOf(page, 'net_port_check'))[0].args).toMatchObject({
    source: { kind: 'local' },
    targets: 'web.example',
    ports: '22',
  });
  await expect(page.getByRole('heading', { name: '외부에서 확인한 결과' })).toBeVisible();
  await emit(page, [result('web.example', 22), finished]);
  await expect(page.locator('.tool-outside .tool-results tbody tr')).toContainText('열림');
  expect(await callsOf(page, 'net_listeners')).toEqual([]);
});

test('when SSH fails with no port asked there is nothing to run', async ({ page }) => {
  await page.goto(use);
  await failedLink(page, '');
  await expect(page.getByRole('button', { name: '확인', exact: true })).toBeDisabled();
});

test('a list that cannot be read falls back only when a port was asked', async ({ page }) => {
  await page.goto(use);
  await setListeners(page, '이 서버에서는 포트 목록을 읽을 수 없습니다.');
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('읽을 수 없습니다');
  await expect(page.getByRole('heading', { name: '외부에서 확인한 결과' })).toHaveCount(0);
});
