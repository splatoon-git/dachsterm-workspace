import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/kube-workspace';
import { NOW, detection, ok, pod, saved } from './fixtures/kube-data';

const lone = pod('lone-1', { labels: { app: 'lone' }, ownerKind: '', ownerName: '' });
const snapshots = {
  pods: ok({ kind: 'pods', items: [pod('api-1'), pod('api-2'), lone] }),
  workloads: ok({
    kind: 'workloads',
    items: [{ kind: 'Deployment', namespace: 'web', name: 'api', desired: 2, ready: 2 }],
  }),
  services: ok({ kind: 'services', items: [] }),
  nodes: ok({
    kind: 'nodes',
    items: [
      { name: 'n1', ready: true, unschedulable: false, cpuAllocatable: 4000, memoryAllocatable: 8 },
    ],
  }),
  podUsage: ok({ kind: 'podUsage', items: [] }),
  nodeUsage: ok({ kind: 'nodeUsage', items: [] }),
  events: ok({ kind: 'events', items: [] }),
};

async function open(
  page: Page,
  {
    operate = 'off',
    actionError,
  }: { operate?: 'on' | 'off' | 'unavailable'; actionError?: string } = {},
) {
  await page.clock.install({ time: NOW });
  await page.addInitScript(
    ({ detection, snapshots, operate, actionError }) => {
      window.__kube = {
        detections: [detection],
        persist: true,
        snapshots,
        operate,
        actionError,
        copyResult: { typed: 'wait' },
        calls: [],
        copied: [],
        terminals: [],
      };
    },
    { detection: { ...detection, saved }, snapshots, operate, actionError },
  );
  await page.goto('/tests/ui/fixtures/kube-workspace.html');
  await expect(page.getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
}

const row = (page: Page, name: string) =>
  page
    .getByRole('treeitem')
    .filter({ has: page.getByText(name, { exact: true }) })
    .first();
const writes = (page: Page) =>
  page.evaluate(() => window.__kube.calls.filter((c) => c.command === 'kube_action'));
const modeButton = (page: Page, name: string) =>
  page.getByRole('tablist', { name: '쿠버네티스 화면' }).getByRole('button', { name });
const item = (page: Page, name: RegExp) => page.getByRole('menuitem', { name });

test('in read-only mode a write stays in the menu, disabled, and says why', async ({ page }) => {
  await open(page);
  await expect(modeButton(page, '조회 모드')).toBeEnabled();
  await row(page, 'api-1').click({ button: 'right' });
  const del = item(page, /파드 삭제/);
  await expect(del).toBeDisabled();
  await expect(del).toContainText('운영 모드로 바꾸세요');
  await page.keyboard.press('Escape');
  await row(page, 'Deployment/api').click({ button: 'right' });
  await expect(item(page, /롤아웃 재시작/)).toBeDisabled();
  expect(await writes(page)).toHaveLength(0);
});

test('a tab opened from a terminal session cannot switch and says so', async ({ page }) => {
  await open(page, { operate: 'unavailable' });
  await expect(modeButton(page, '조회 모드')).toBeDisabled();
  await row(page, 'api-1').click({ button: 'right' });
  await expect(item(page, /파드 삭제/)).toContainText('쿠버네티스 세션으로 접속하세요');
});

test('turning operate mode on asks first, with cancel as the default', async ({ page }) => {
  await open(page);
  await modeButton(page, '조회 모드').click();
  const dialog = page.getByRole('dialog', { name: '운영 모드 켜기' });
  await expect(dialog).toContainText('prod');
  await expect(dialog.getByRole('button', { name: '취소' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(modeButton(page, '조회 모드')).toBeVisible();

  await modeButton(page, '조회 모드').click();
  await page.getByRole('dialog').getByRole('button', { name: '운영 모드 켜기' }).click();
  await expect(modeButton(page, '운영 모드')).toBeVisible();
  await row(page, 'api-1').click({ button: 'right' });
  await expect(item(page, /파드 삭제/)).toBeEnabled();
  await page.keyboard.press('Escape');

  await modeButton(page, '운영 모드').click();
  await expect(modeButton(page, '조회 모드')).toBeVisible();
});

test('the confirmation names everything and cancel runs nothing', async ({ page }) => {
  await open(page, { operate: 'on' });
  await row(page, 'lone-1').click({ button: 'right' });
  await item(page, /파드 삭제/).click();
  const dialog = page.getByRole('dialog', { name: '파드 삭제' });
  await expect(dialog).toContainText('prod');
  await expect(dialog).toContainText('web');
  await expect(dialog).toContainText('pod/lone-1');
  await expect(dialog.locator('.kube-action-impact.permanent')).toContainText('복구되지 않습니다');
  await expect(dialog.getByRole('button', { name: '취소' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
  expect(await writes(page)).toHaveLength(0);
});

test('a confirmed delete sends one fixed action with the confirmed context', async ({ page }) => {
  await open(page, { operate: 'on' });
  await row(page, 'api-1').click({ button: 'right' });
  await item(page, /파드 삭제/).click();
  const dialog = page.getByRole('dialog', { name: '파드 삭제' });
  await expect(dialog).toContainText('Deployment/api');
  await expect(dialog.locator('.kube-action-impact.permanent')).toHaveCount(0);
  await dialog.getByRole('button', { name: '삭제' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('삭제를 요청했습니다');
  const sent = await writes(page);
  expect(sent).toHaveLength(1);
  expect(sent[0].args).toEqual({
    id: 'connection',
    context: 'prod',
    action: { kind: 'deletePod', namespace: 'web', pod: 'api-1' },
  });
});

test('a refusal stays on screen in the server words', async ({ page }) => {
  const words = 'Error from server (Forbidden): pods "api-1" is forbidden';
  await open(page, { operate: 'on', actionError: words });
  await row(page, 'api-1').click({ button: 'right' });
  await item(page, /파드 삭제/).click();
  const dialog = page.getByRole('dialog', { name: '파드 삭제' });
  await dialog.getByRole('button', { name: '삭제' }).click();
  await expect(dialog.getByRole('alert')).toHaveText(words);
  await expect(dialog.getByRole('button', { name: '삭제' })).toBeEnabled();
});

test('rollout, cordon and the keyboard all reach their rows', async ({ page }) => {
  await open(page, { operate: 'on' });
  await row(page, 'Deployment/api').click({ button: 'right' });
  await item(page, /롤아웃 재시작/).click();
  let dialog = page.getByRole('dialog', { name: '롤아웃 재시작' });
  await expect(dialog).toContainText('파드 2개');
  await dialog.getByRole('button', { name: '재시작' }).click();
  await expect(dialog).toHaveCount(0);

  await row(page, '노드').click();
  await page.keyboard.press('ArrowRight');
  await row(page, 'n1').click();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', { name: '노드 메뉴' })).toBeVisible();
  await item(page, /Cordon/).click();
  dialog = page.getByRole('dialog', { name: 'Cordon' });
  await expect(dialog).toContainText('node/n1');
  await dialog.getByRole('button', { name: 'Cordon' }).click();
  await expect(dialog).toHaveCount(0);

  const sent = await writes(page);
  expect(sent.map((call) => call.args.action)).toEqual([
    { kind: 'rolloutRestart', namespace: 'web', workload: 'deployment', name: 'api' },
    { kind: 'cordon', node: 'n1' },
  ]);
});
