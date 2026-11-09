import { expect, test, type Page } from '@playwright/test';
import type { AiRead, GpuDevice, VllmSeries } from '../../src/features/kube/aiTypes';
import type {} from './fixtures/kube-workspace';
import { NOW, detection, ok, pod } from './fixtures/kube-data';

const owned = { ownerKind: 'StatefulSet', ownerName: 'serve' };

const snapshots: NonNullable<Window['__kube']['snapshots']> = {
  pods: ok({
    kind: 'pods',
    items: [
      pod('serve-0', { ...owned, namespace: 'ai' }),
      pod('serve-1', { ...owned, namespace: 'ai' }),
    ],
  }),
  podUsage: ok({ kind: 'podUsage', items: [] }),
  services: ok({ kind: 'services', items: [] }),
  workloads: ok({
    kind: 'workloads',
    items: [{ kind: 'StatefulSet', namespace: 'ai', name: 'serve', desired: 2, ready: 2 }],
  }),
  nodes: ok({
    kind: 'nodes',
    items: [
      { name: 'n1', ready: true, unschedulable: false, cpuAllocatable: 1000, memoryAllocatable: 8 },
    ],
  }),
  nodeUsage: ok({ kind: 'nodeUsage', items: [] }),
  events: ok({ kind: 'events', items: [] }),
};

/** Stand-in values for the screen. Nothing here came from a real engine. */
const stalledSeries: VllmSeries[] = [
  { metric: 'run', model: 'qwen', labels: 'm', value: 2 },
  { metric: 'wait', model: 'qwen', labels: 'm', value: 1 },
  { metric: 'kv', model: 'qwen', labels: 'm', value: 0.5 },
  { metric: 'output', model: 'qwen', labels: 'm', value: 500 },
];

const device: GpuDevice = {
  node: 'gpu-1',
  id: 'GPU-a',
  gpu: '0',
  model: 'A100',
  util: 87,
  used: 2048,
  total: 8192,
  temp: 61,
  power: 250,
  pods: ['ai/serve-0'],
};

function answer(atMs: number): AiRead {
  return {
    state: { kind: 'ready' },
    pods: [
      {
        namespace: 'ai',
        pod: 'serve-0',
        node: 'gpu-1',
        identity: 'u|0',
        status: 'ok',
        endpoint: '/x',
        sample: { atMs, processStart: 1, series: stalledSeries },
      },
      {
        namespace: 'ai',
        pod: 'serve-1',
        node: 'gpu-1',
        identity: 'v|0',
        status: 'forbidden',
        endpoint: '/y',
        sample: null,
      },
    ],
    exporters: [],
    gpus: [device],
    capped: 0,
    gpuRestricted: false,
    elapsedMs: 1,
  };
}

const none: AiRead = { ...answer(0), pods: [], gpus: [] };

async function open(page: Page, ai: 'none' | 'found' | 'failing') {
  await page.clock.install({ time: NOW });
  await page.addInitScript(
    ({ detection, snapshots, ai, sample, none, device }) => {
      window.__kube = {
        detections: [detection],
        persist: true,
        snapshots,
        copyResult: { typed: 'wait' },
        calls: [],
        copied: [],
        terminals: [],
      };
      window.__kube.aiAnswer = () => {
        if (ai === 'none') return none;
        if (ai === 'failing') return { ...none, state: { kind: 'forbidden' } };
        const at = Date.now();
        return {
          ...none,
          gpus: [device],
          pods: [{ ...sample[0], sample: { ...sample[0].sample!, atMs: at } }, { ...sample[1] }],
        };
      };
    },
    { detection, snapshots, ai, sample: answer(0).pods, none, device },
  );
  await page.goto('/tests/ui/fixtures/kube-workspace.html');
  await expect(page.getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
}

const tab = (page: Page) => page.getByRole('tab', { name: 'vLLM·GPU', exact: true });

test('no tab when nothing was detected', async ({ page }) => {
  await open(page, 'none');
  await page.clock.runFor(11_000);
  await expect(tab(page)).toHaveCount(0);
  const calls = await page.evaluate(() =>
    window.__kube.calls.filter((c) => c.command === 'kube_ai'),
  );
  expect(calls.length).toBeGreaterThan(0);
});

test('the web view cannot name what is read', async ({ page }) => {
  await open(page, 'found');
  await expect(tab(page)).toBeVisible();
  const calls = await page.evaluate(() =>
    window.__kube.calls.filter((c) => c.command === 'kube_ai'),
  );
  for (const call of calls) expect(Object.keys(call.args).sort()).toEqual(['id', 'kube']);
});

test('model, pods, cache and GPU are shown, and unknown is not zero', async ({ page }) => {
  await open(page, 'found');
  await tab(page).click();
  // The first read can come before the pod list that says which workload a pod belongs to.
  await page.clock.runFor(6_000);
  const screen = page.locator('.kube-ai');
  const model = screen.locator('tr.kube-ai-model').filter({ hasText: 'qwen' });
  await expect(model).toContainText('1/2');
  await expect(model.locator('td').nth(1)).toHaveText('2');
  await expect(model.locator('td').nth(2)).toHaveText('1');
  await expect(model.locator('td').nth(5)).toHaveText('50%');
  // Two samples, the same token count: an observed zero, not an unknown.
  await expect(model.locator('td').nth(6)).toHaveText('0');
  await expect(model.locator('td').nth(11)).toHaveText('87%');
  await expect(model.locator('td').nth(12)).toHaveText('2.0/8.0G');

  await expect(screen.getByRole('button', { name: 'serve-0' })).toBeVisible();
  await expect(screen.locator('tr').filter({ hasText: 'serve-1' })).toContainText('권한 없음');
  await expect(screen.getByRole('region', { name: 'GPU' })).toContainText('A100');
  await expect(screen.getByRole('region', { name: 'GPU' })).toContainText('ai/serve-0');

  await screen.getByRole('button', { name: /qwen/ }).click();
  await expect(screen.getByRole('button', { name: 'serve-0' })).toHaveCount(0);
});

test('a detection that was refused says so', async ({ page }) => {
  await open(page, 'found');
  await tab(page).click();
  await page.evaluate(() => {
    const previous = window.__kube.aiAnswer!;
    window.__kube.aiAnswer = () => ({ ...previous(), state: { kind: 'forbidden' } });
  });
  await page.clock.runFor(6_000);
  await expect(page.locator('.kube-ai')).toContainText('권한');
  await expect(page.locator('tr.kube-ai-model')).toHaveCount(0);
  await expect(tab(page)).toBeVisible();
});

test('running with no tokens for the window is a suspected stall everywhere', async ({ page }) => {
  await open(page, 'found');
  await expect(tab(page)).toBeVisible();
  for (let i = 0; i < 33; i++) await page.clock.runFor(10_000);

  await tab(page).click();
  const stalled = page.locator('.kube-ai-table tr.warn').filter({ hasText: 'serve-0' });
  await expect(stalled).toContainText('처리 정지 의심');

  await page.getByRole('tab', { name: '트리', exact: true }).click();
  const row = page
    .getByRole('treeitem')
    .filter({ has: page.getByText('StatefulSet/serve', { exact: true }) })
    .first();
  await expect(row.locator('.kube-worker-cell')).toContainText('실행 2 · 대기 1');
  await expect(row.locator('.kube-worker-cell')).toHaveAttribute(
    'title',
    /serve-0: 처리 정지 의심/,
  );

  await page.getByRole('tab', { name: '대시보드', exact: true }).click();
  const panel = page.getByRole('region', { name: '워커' });
  await expect(panel).toContainText('StatefulSet/serve');
  await expect(panel).toContainText('처리 정지 의심');
});

test('clicking a pod opens its runtime tab', async ({ page }) => {
  await open(page, 'found');
  await tab(page).click();
  await page.locator('.kube-ai').getByRole('button', { name: 'serve-0' }).click();
  await expect(page.getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
});
