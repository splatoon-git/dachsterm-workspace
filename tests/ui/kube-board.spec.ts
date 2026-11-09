import { expect, test, type Page } from '@playwright/test';
import type { IngressReport } from '../../src/features/kube/ingressTypes';
import type { StreamEvent } from '../../src/features/kube/logBoardModel';
import { detection, NOW, ok, pod } from './fixtures/kube-data';
import type {} from './fixtures/kube-workspace';

type Answers = NonNullable<Window['__kube']['snapshots']>;

const snapshots: Answers = {
  pods: ok({
    kind: 'pods',
    items: [pod('api-7f9c-a1'), pod('api-7f9c-b2', { node: 'n2' })],
  }),
  services: ok({
    kind: 'services',
    items: [
      {
        namespace: 'web',
        name: 'api',
        serviceType: 'ClusterIP',
        selector: { app: 'api' },
        readyEndpoints: 2,
        notReadyEndpoints: 0,
      },
    ],
  }),
  workloads: ok({ kind: 'workloads', items: [] }),
  nodes: ok({ kind: 'nodes', items: [] }),
  podUsage: ok({ kind: 'podUsage', items: [] }),
  nodeUsage: ok({ kind: 'nodeUsage', items: [] }),
  events: ok({ kind: 'events', items: [] }),
};

const ingress: IngressReport = {
  state: { kind: 'ready' },
  ingresses: [
    {
      namespace: 'web',
      name: 'front',
      className: 'nginx',
      addresses: ['10.0.0.5'],
      tls: [],
      rules: [
        {
          host: 'api.local',
          path: '/',
          pathType: 'Prefix',
          service: 'api',
          port: '80',
          isDefault: false,
          backend: 'ok',
          readyEndpoints: 2,
          notReadyEndpoints: 0,
        },
      ],
    },
  ],
  servicesState: { kind: 'ready' },
  secretsState: { kind: 'ready' },
  controllers: [{ namespace: 'ingress-nginx', name: 'controller-1', container: 'controller' }],
  traffic: { kind: 'off' },
  collectedAt: NOW,
  elapsedMs: 5,
};

async function open(page: Page) {
  await page.clock.install({ time: NOW });
  await page.addInitScript(
    ({ detection, snapshots, ingress }) => {
      window.__kube = {
        detections: [detection],
        persist: true,
        snapshots,
        ingress,
        copyResult: { typed: 'wait' },
        podAnswers: {
          detail: {
            overview: {
              state: { kind: 'ready' },
              data: {
                kind: 'overview',
                namespace: 'web',
                name: 'api-7f9c-a1',
                uid: 'uid-1',
                phase: 'Running',
                reason: '',
                message: '',
                qosClass: 'Burstable',
                node: 'n1',
                podIp: '10.0.0.1',
                hostIp: '10.0.0.2',
                created: '2026-11-08T11:00:00Z',
                deleting: false,
                ownerKind: 'ReplicaSet',
                ownerName: 'api-7f9c',
                labels: {},
                defaultContainer: '',
                initContainers: [],
                containers: [
                  {
                    name: 'app',
                    image: 'img:1',
                    ready: true,
                    restarts: 0,
                    state: 'running',
                    reason: '',
                    message: '',
                    exitCode: null,
                    startedAt: '',
                    finishedAt: '',
                    containerId: 'containerd://app',
                    last: null,
                    cpuRequest: null,
                    memoryRequest: null,
                    cpuLimit: null,
                    memoryLimit: null,
                  },
                ],
              },
            },
          },
          logs: {
            state: { kind: 'ready' },
            text: 'INFO fine\nERROR broken\n',
            previous: false,
            previousMissing: false,
            truncated: false,
          },
        },
        calls: [],
        copied: [],
        terminals: [],
      };
    },
    { detection, snapshots, ingress },
  );
  await page.goto('/tests/ui/fixtures/kube-workspace.html');
  await expect(page.getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
}

const tab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const treeRow = (page: Page, name: string) =>
  page
    .getByRole('treeitem')
    .filter({ has: page.getByText(name, { exact: true }) })
    .first();
const emit = (page: Page, event: StreamEvent) =>
  page.evaluate((event) => window.__kube.emitStream?.(event), event);
const streamCalls = (page: Page) =>
  page.evaluate(() => window.__kube.calls.filter((c) => c.command === 'kube_log_stream'));
const lastSources = async (page: Page) =>
  (await streamCalls(page)).at(-1)?.args.sources as { pod: string; filter: string | null }[];
const time = (second: number) => `2026-11-08T12:00:0${second}.000000001Z`;

async function openFlow(page: Page) {
  await tab(page, '인그레스').click();
  await expect(page.getByText('api.local')).toBeVisible();
  await page.getByText('api.local').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '요청 흐름 실시간 보기' }).click();
  await expect(page.getByRole('tabpanel', { name: '실시간 로그' })).toBeVisible();
  await expect.poll(async () => (await streamCalls(page)).length).toBe(1);
  await emit(page, { type: 'started' });
}

test('the pod panel can be dragged wider and narrower with the mouse', async ({ page }) => {
  await open(page);
  await treeRow(page, 'api-7f9c-a1').dblclick();
  const panel = page.locator('.kube-panel');
  await expect(panel).toBeVisible();
  const handle = page.getByRole('separator', { name: '로그 패널 크기' });
  const box = (await handle.boundingBox())!;
  expect(box.width).toBeGreaterThan(0);
  const before = (await panel.boundingBox())!.width;
  await page.mouse.move(box.x + box.width / 2, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x - 200, box.y + 100, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before + 150);
});

test('a panel can fill the screen and return', async ({ page }) => {
  await open(page);
  await treeRow(page, 'api-7f9c-a1').dblclick();
  await page.getByRole('button', { name: '패널 크게 보기' }).click();
  await expect(page.getByRole('tree', { name: '클러스터 트리' })).toBeHidden();
  await page.getByRole('button', { name: '패널 원래 크기' }).click();
  await expect(page.getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
});

test('an ingress row opens the controller above the service pods', async ({ page }) => {
  await open(page);
  await openFlow(page);
  expect((await lastSources(page)).map((s) => [s.pod, s.filter])).toEqual([
    ['controller-1', '[web-api-80]'],
    ['api-7f9c-a1', null],
    ['api-7f9c-b2', null],
  ]);
  await emit(page, {
    type: 'lines',
    dropped: 0,
    lines: [
      { source: 0, time: time(1), text: '[web-api-80] "GET / HTTP/1.1" 502 12' },
      { source: 1, time: time(2), text: 'first pod line' },
      { source: 2, time: time(3), text: 'second pod line' },
    ],
  });
  const log = (name: string) => page.getByRole('log', { name });
  await expect(log('인그레스 컨트롤러 로그')).toContainText('[web-api-80]');
  await expect(log('api-7f9c-a1 로그')).toContainText('first pod line');
  await expect(log('api-7f9c-a1 로그')).not.toContainText('second pod line');
  await expect(log('api-7f9c-b2 로그')).toContainText('second pod line');
  await expect(page.locator('.kube-line.error')).toContainText('502');
});

test('the controller can show every request, which restarts the stream unfiltered', async ({
  page,
}) => {
  await open(page);
  await openFlow(page);
  await page.getByRole('button', { name: '전체 요청' }).click();
  await expect.poll(async () => (await streamCalls(page)).length).toBe(2);
  expect((await lastSources(page))[0].filter).toBeNull();
  const cancels = await page.evaluate(
    () => window.__kube.calls.filter((c) => c.command === 'kube_log_cancel').length,
  );
  expect(cancels).toBe(1);
});

test('a pane can be enlarged, and the board can merge every pod into one timeline', async ({
  page,
}) => {
  await open(page);
  await openFlow(page);
  await emit(page, {
    type: 'lines',
    dropped: 0,
    lines: [
      { source: 2, time: time(3), text: 'later line' },
      { source: 1, time: time(2), text: 'earlier line' },
    ],
  });
  await expect(page.getByRole('log', { name: 'api-7f9c-a1 로그' })).toContainText('earlier');
  await page.getByRole('button', { name: 'api-7f9c-a1 크게 보기' }).click();
  await expect(page.getByRole('log')).toHaveCount(1);
  await page.getByRole('button', { name: 'api-7f9c-a1 원래 크기' }).click();
  await expect(page.getByRole('log')).toHaveCount(3);

  await page.getByRole('button', { name: '합쳐 보기' }).click();
  const merged = page.getByRole('log', { name: '합친 로그' });
  await expect(merged.locator('.kube-line-text')).toHaveText(['earlier line', 'later line']);
  await expect(merged.locator('.kube-line-tag').first()).toHaveText('7f9c-a1');
});

test('the filter, the errors switch and pause narrow what is drawn', async ({ page }) => {
  await open(page);
  await openFlow(page);
  await emit(page, {
    type: 'lines',
    dropped: 0,
    lines: [
      { source: 1, time: time(1), text: 'alpha fine' },
      { source: 1, time: time(2), text: 'ERROR beta' },
    ],
  });
  const log = page.getByRole('log', { name: 'api-7f9c-a1 로그' });
  await expect(log.locator('.kube-line-text')).toHaveCount(2);
  await page.getByRole('searchbox', { name: '로그 필터' }).fill('alpha');
  await expect(log.locator('.kube-line-text')).toHaveText(['alpha fine']);
  await page.getByRole('searchbox', { name: '로그 필터' }).fill('');
  await page.getByLabel('경고·오류만').check();
  await expect(log.locator('.kube-line-text')).toHaveText(['ERROR beta']);
  await page.getByLabel('경고·오류만').uncheck();

  await page.getByRole('button', { name: '일시정지' }).click();
  await emit(page, {
    type: 'lines',
    dropped: 0,
    lines: [{ source: 1, time: time(3), text: 'arrived while paused' }],
  });
  await page.clock.runFor(300);
  await expect(log).not.toContainText('arrived while paused');
  await page.getByRole('button', { name: '이어서 보기' }).click();
  await expect(log).toContainText('arrived while paused');
});

test('a pod that fails says why, and a finished stream can be reconnected', async ({ page }) => {
  await open(page);
  await openFlow(page);
  await emit(page, { type: 'sourceEnded', source: 1, state: { kind: 'forbidden' } });
  await expect(page.locator('.kube-board-pane-note')).toBeVisible();
  await emit(page, { type: 'finished', state: { kind: 'ready' } });
  await page.getByRole('button', { name: '다시 연결' }).click();
  await expect.poll(async () => (await streamCalls(page)).length).toBe(2);
});

test('a resumed stream continues from the last line it showed', async ({ page }) => {
  await open(page);
  await openFlow(page);
  await emit(page, {
    type: 'lines',
    dropped: 0,
    lines: [{ source: 1, time: time(1), text: 'kept line' }],
  });
  await expect(page.getByRole('log', { name: 'api-7f9c-a1 로그' })).toContainText('kept line');
  await page.getByRole('button', { name: 'api-7f9c-b2 빼기' }).click();
  await expect.poll(async () => (await streamCalls(page)).length).toBe(2);
  const sources = (await lastSources(page)) as unknown as { pod: string; since: string | null }[];
  expect(sources.map((s) => [s.pod, s.since])).toEqual([
    ['controller-1', null],
    ['api-7f9c-a1', time(1)],
  ]);
});

test('the empty board offers what can be followed', async ({ page }) => {
  await open(page);
  await tab(page, '실시간 로그').click();
  await expect(page.getByText('보고 싶은 대상을 고르세요')).toBeVisible();
  await page.getByRole('button', { name: 'web/api', exact: true }).click();
  await expect.poll(async () => (await streamCalls(page)).length).toBe(1);
  expect((await lastSources(page)).map((s) => s.pod)).toEqual(['api-7f9c-a1', 'api-7f9c-b2']);
});

test('a tree group opens on the board from its menu', async ({ page }) => {
  await open(page);
  await page.getByRole('treeitem').filter({ hasText: 'Deployment/api' }).click({
    button: 'right',
  });
  await page
    .getByRole('menu', { name: '그룹 메뉴' })
    .getByRole('menuitem', { name: '실시간 로그 보기' })
    .click();
  await expect.poll(async () => (await streamCalls(page)).length).toBe(1);
  expect((await lastSources(page)).map((s) => s.pod)).toEqual(['api-7f9c-a1', 'api-7f9c-b2']);
});

test('the pod log marks errors without changing its text', async ({ page }) => {
  await open(page);
  await treeRow(page, 'api-7f9c-a1').dblclick();
  await page.locator('.kube-panel').getByRole('tab', { name: '로그', exact: true }).click();
  const log = page.locator('.kube-panel').getByLabel('로그', { exact: true });
  await expect(log).toHaveText('INFO fine\nERROR broken\n');
  await expect(log.locator('.kube-log-line.error')).toHaveText('ERROR broken\n');
});
