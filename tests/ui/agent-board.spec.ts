import { expect, test, type Page } from '@playwright/test';
import type { AgentRow } from '../../src/app/agentRows';
import type {} from './fixtures/agent-board';

const minute = 60_000;
const rows = (now: number): AgentRow[] => [
  {
    key: 'tab:done',
    name: '빌드 서버',
    state: 'done',
    since: now - 2 * minute,
    git: '',
    detail: '완료',
  },
  {
    key: 'tab:wait',
    name: '배포 서버',
    state: 'blocked',
    since: now - 5 * minute,
    git: 'main ●3',
    detail: '입력 대기 · 승인 필요 · 파일 수정 허용?',
  },
  {
    key: 'window:terminal-c2',
    window: 'terminal-c2',
    name: '분석 서버',
    state: 'working',
    since: now - 65 * minute,
    git: 'feat/x',
    detail: '작업 중',
  },
  {
    key: 'tab:wait2',
    name: '스테이징',
    state: 'blocked',
    since: now - 30_000,
    git: '',
    detail: '입력 대기 · 키 서명 승인 요청',
  },
];

async function open(page: Page) {
  await page.addInitScript((value) => (window.__agentRows = value), rows(Date.now()));
  await page.goto('/tests/ui/fixtures/agent-board.html');
  return page.locator('.status-bar .agent-board-toggle');
}

test('counts the reporting tabs in the status bar and lists them by urgency', async ({ page }) => {
  const toggle = await open(page);
  await expect(toggle).toHaveText('입력 대기 2 · 작업 중 1 · 완료 1');
  await expect(toggle).toHaveAttribute(
    'aria-label',
    '에이전트 현황 · 입력 대기 2 · 작업 중 1 · 완료 1',
  );
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  const list = page.getByRole('region', { name: '에이전트 현황' });
  const items = list.getByRole('button');
  await expect(items).toHaveCount(4);
  // Waiting tabs first, the one waiting longest on top; then running, then finished work.
  for (const part of ['입력 대기', '배포 서버', 'main ●3', '5분'])
    await expect(items.nth(0)).toContainText(part);
  await expect(items.nth(0)).toHaveAttribute(
    'title',
    '입력 대기 · 승인 필요 · 파일 수정 허용?\nGit main ●3',
  );
  await expect(items.nth(1)).toContainText('스테이징');
  await expect(items.nth(1)).toContainText('1분 미만');
  await expect(items.nth(2)).toContainText('분석 서버');
  await expect(items.nth(2)).toContainText('독립 창');
  await expect(items.nth(2)).toContainText('1시간 5분');
  await expect(items.nth(3)).toContainText('빌드 서버');
  await expect(list).toContainText(/다음 입력 대기로 이동 · (Ctrl\+Shift\+\.|⌘⇧\.)/);
});

test('a row goes to its tab and closes the list; Esc and an outside click close it too', async ({
  page,
}) => {
  const toggle = await open(page);
  const list = page.getByRole('region', { name: '에이전트 현황' });
  await toggle.click();
  await list.getByRole('button', { name: /분석 서버/ }).click();
  await expect(list).toHaveCount(0);
  expect(await page.evaluate(() => window.__activated)).toEqual(['window:terminal-c2']);

  await toggle.click();
  await list.getByRole('button').first().focus();
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(toggle).toBeFocused();

  await toggle.click();
  await page.getByRole('button', { name: '작업 영역' }).click();
  await expect(list).toHaveCount(0);
});

test('shows nothing while no tab reports, and follows the reports', async ({ page }) => {
  const toggle = await open(page);
  await page.evaluate(() => window.__setAgentRows([]));
  await expect(toggle).toHaveCount(0);
  await page.evaluate(() =>
    window.__setAgentRows([
      { key: 'tab:a', name: 'a', state: 'error', since: Date.now(), git: '', detail: '오류' },
    ]),
  );
  await expect(toggle).toHaveText('오류 1');
});

test('fits a narrow window', async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 640 });
  const toggle = await open(page);
  await toggle.click();
  const list = page.getByRole('region', { name: '에이전트 현황' });
  const box = (await list.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(380);
  await expect(list.locator('.agent-row-git').first()).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(380);
});
