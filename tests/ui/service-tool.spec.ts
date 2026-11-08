import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/tool-source';
import type { ServiceReport } from '../../src/features/tools/serviceCheck';
import type { TraceEvent, TraceHop } from '../../src/features/tools/routeTrace';

const url = '/tests/ui/fixtures/tool-source.html?tool=service';
const callsOf = async (page: Page, command: string) =>
  (await page.evaluate(() => window.__toolSource.calls)).filter((c) => c.command === command);
const answer = (page: Page, value: ServiceReport | string | null) =>
  page.evaluate((v) => window.__toolSource.answerService(v), value);
const emit = (page: Page, events: TraceEvent[]) =>
  page.evaluate((list) => list.forEach((e) => window.__toolSource.emitTrace(e)), events);
const hop = (number: number, over: Partial<TraceHop> = {}): TraceEvent => ({
  type: 'hop',
  hop: {
    hop: number,
    address: `10.0.0.${number}`,
    rttMs: 2,
    reached: false,
    unreachable: false,
    ...over,
  },
});

const https: ServiceReport = {
  host: 'api.example.com',
  port: 443,
  outcome: 'open',
  detail: null,
  service: 'https',
  elapsedMs: 42,
  resolve: { kind: 'measured', addresses: ['203.0.113.40'], ms: 3 },
  connectMs: 12,
  tls: {
    version: '1.3',
    trust: 'selfSigned',
    failure: null,
    certificate: {
      subject: 'api.example.com',
      issuer: 'api.example.com',
      notBefore: '2026-01-01',
      notAfter: '2027-01-31',
      names: [],
      moreNames: 0,
      selfSigned: true,
    },
  },
  http: { version: '1.1', status: 200, reason: 'OK', server: 'nginx', location: null },
  banner: [],
  attempts: 2,
};

async function check(page: Page, target: string) {
  await page.getByLabel('대상', { exact: true }).fill(target);
  await page.getByRole('button', { name: '점검', exact: true }).click();
  await expect
    .poll(async () => (await callsOf(page, 'net_service_check')).length)
    .toBeGreaterThan(0);
}
const result = (page: Page) => page.locator('.service-result');
const open = (page: Page) => result(page).locator('summary').click();

test('the result is one line and the detail opens below it', async ({ page }) => {
  await page.goto(url);
  await check(page, 'api.example.com:443');
  const [{ args }] = await callsOf(page, 'net_service_check');
  expect(args).toMatchObject({
    source: { kind: 'local' },
    target: 'api.example.com:443',
    format: 'auto',
  });
  await expect(page.getByRole('button', { name: '취소', exact: true })).toBeVisible();
  await answer(page, https);
  await expect(result(page).locator('summary')).toContainText('이 PC → api.example.com:443');
  await expect(result(page).locator('summary')).toContainText('연결됨 · HTTPS 200 · 42ms');
  await expect(result(page).locator('.service-steps')).toBeHidden();
  await open(page);
  const steps = result(page).locator('.service-steps');
  await expect(steps).toContainText('203.0.113.40 · 3ms');
  await expect(steps).toContainText('1.3 · 인증서 2027-01-31 만료 · 자체 서명(신뢰 안 됨)');
  await expect(steps).toContainText('HTTP/1.1 200 OK · Server: nginx');
});

test('the chosen format is sent', async ({ page }) => {
  await page.goto(url);
  await page.locator('.tool-format select').selectOption('banner');
  await check(page, 'mail.example:25');
  const [{ args }] = await callsOf(page, 'net_service_check');
  expect(args).toMatchObject({ format: 'banner' });
});

test('an error is shown and a cancel says so', async ({ page }) => {
  await page.goto(url);
  await check(page, 'bad target');
  await answer(page, '대상 형식이 잘못되었습니다: bad');
  await expect(page.getByRole('alert')).toContainText('대상 형식');
  await check(page, 'a.example:80');
  await answer(page, null);
  await expect(page.locator('.tool-pending')).toContainText('취소됨');
  await expect(result(page)).toHaveCount(0);
});

test('a service text from a server stays plain text', async ({ page }) => {
  await page.goto(url);
  await check(page, 'a.example:25');
  await answer(page, {
    ...https,
    service: 'banner',
    http: null,
    tls: null,
    banner: ['<img src=x onerror=alert(1)>'],
  });
  await open(page);
  await expect(result(page).locator('.service-steps')).toContainText('<img src=x');
  await expect(result(page).locator('.service-steps img')).toHaveCount(0);
});

test('the trace runs only when asked, and concludes without blaming anyone', async ({ page }) => {
  await page.goto(url);
  await check(page, 'api.example.com:443');
  await answer(page, https);
  expect(await callsOf(page, 'net_trace')).toHaveLength(0);
  await open(page);
  const trace = result(page).locator('.service-trace');
  await trace.getByRole('button', { name: '실행', exact: true }).click();
  await expect.poll(async () => (await callsOf(page, 'net_trace')).length).toBe(1);
  const [{ args }] = await callsOf(page, 'net_trace');
  expect(args).toMatchObject({
    source: { kind: 'local' },
    host: 'api.example.com',
    port: 443,
  });
  await expect(trace.getByRole('button', { name: '취소', exact: true })).toBeVisible();
  await emit(page, [
    { type: 'method', method: 'icmp' },
    hop(1),
    hop(2),
    hop(3, { address: null, rttMs: null }),
    {
      type: 'finished',
      cancelled: false,
      conclusion: { kind: 'lastResponder', address: '10.0.0.2' },
      note: null,
    },
  ]);
  await expect(trace).toContainText('참고용 ICMP');
  await expect(trace).toContainText('무관');
  await expect(trace.locator('tbody tr')).toHaveCount(3);
  await expect(trace.locator('tbody tr').nth(2)).toContainText('응답 없음');
  await expect(trace.getByRole('status')).toHaveText(
    '마지막 응답 장비는 10.0.0.2, 그 다음 구간에서 끊김',
  );
  await expect(trace.getByRole('button', { name: '실행', exact: true })).toBeVisible();
});

test('a server without a tool and a cancelled trace are stated', async ({ page }) => {
  await page.goto(url);
  await check(page, 'api.example.com:443');
  await answer(page, https);
  await open(page);
  const trace = result(page).locator('.service-trace');
  await trace.getByRole('button', { name: '실행', exact: true }).click();
  await expect.poll(async () => (await callsOf(page, 'net_trace')).length).toBe(1);
  await emit(page, [
    { type: 'finished', cancelled: false, conclusion: { kind: 'unavailable' }, note: null },
  ]);
  await expect(trace.getByRole('status')).toHaveText('이 서버에서는 경로 추적을 할 수 없습니다');
  await trace.getByRole('button', { name: '실행', exact: true }).click();
  await expect.poll(async () => (await callsOf(page, 'net_trace')).length).toBe(2);
  await emit(page, [{ type: 'finished', cancelled: true, conclusion: null, note: null }]);
  await expect(trace.locator('.tool-pending')).toHaveText('취소됨');
  await expect(trace.getByRole('status')).toHaveCount(0);
});
