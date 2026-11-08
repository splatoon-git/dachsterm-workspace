import { expect, test, type Page } from '@playwright/test';
import type { Detection } from '../../src/features/kube/kubeModel';
import type { KubeEvent, KubePod } from '../../src/features/kube/snapshotTypes';
import type {} from './fixtures/kube-workspace';
import { NOW, detection, failed, ok, pod } from './fixtures/kube-data';

type Answers = NonNullable<Window['__kube']['snapshots']>;

const stopped = (patch: Partial<KubePod['containers'][number]>) => [
  {
    name: 'app',
    ready: false,
    restarts: 7,
    waiting: 'CrashLoopBackOff',
    terminated: '',
    lastReason: 'OOMKilled',
    lastFinished: '2026-11-08T11:48:00Z',
    lastExitCode: 137,
    ...patch,
  },
];

const api1 = pod('api-1');
const crash = pod('crash-1', {
  labels: { app: 'lonely' },
  ownerKind: '',
  ownerName: '',
  containers: stopped({}),
});
const warning: KubeEvent = {
  namespace: 'web',
  objectKind: 'Pod',
  objectName: 'crash-1',
  reason: 'BackOff',
  time: '2026-11-08T11:58:00Z',
  message: 'Back-off restarting failed container',
};

const healthy: Answers = {
  pods: ok({ kind: 'pods', items: [api1, pod('api-2'), crash] }),
  podUsage: ok({
    kind: 'podUsage',
    items: [
      { namespace: 'web', name: 'api-1', cpu: 150, memory: 2 ** 20 },
      { namespace: 'web', name: 'api-2', cpu: 50, memory: 2 ** 19 },
    ],
  }),
  services: ok({ kind: 'services', items: [] }),
  workloads: ok({
    kind: 'workloads',
    items: [{ kind: 'Deployment', namespace: 'web', name: 'api', desired: 3, ready: 2 }],
  }),
  nodes: ok({
    kind: 'nodes',
    items: [
      {
        name: 'n1',
        ready: true,
        unschedulable: false,
        cpuAllocatable: 1000,
        memoryAllocatable: 2 ** 30,
      },
    ],
  }),
  nodeUsage: ok({ kind: 'nodeUsage', items: [{ name: 'n1', cpu: 250, memory: 2 ** 29 }] }),
  events: ok({ kind: 'events', items: [warning] }),
};

const quiet: Answers = {
  ...healthy,
  pods: ok({ kind: 'pods', items: [api1] }),
  workloads: ok({ kind: 'workloads', items: [] }),
  events: ok({ kind: 'events', items: [] }),
};

async function open(page: Page, snapshots: Answers = healthy, answer: Detection = detection) {
  await page.clock.install({ time: NOW });
  await page.addInitScript(
    ({ answer, snapshots }) => {
      window.__kube = {
        detections: [answer],
        persist: true,
        snapshots,
        copyResult: { typed: 'wait' },
        calls: [],
        copied: [],
      };
    },
    { answer, snapshots },
  );
  await page.goto('/tests/ui/fixtures/kube-workspace.html');
  await expect(page.getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
  await expect(page.getByRole('treeitem').first()).toBeVisible();
  await page.getByRole('tab', { name: '대시보드', exact: true }).click();
}

const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true });
const treeRow = (page: Page, name: string) =>
  page
    .getByRole('treeitem')
    .filter({ has: page.getByText(name, { exact: true }) })
    .first();
const screenTab = (page: Page, name: string) => page.getByRole('tab', { name, exact: true });
const snapshotCalls = (page: Page) =>
  page.evaluate(() => window.__kube.calls.filter((c) => c.command === 'kube_snapshot').length);

test('the tree stays the first screen and the dashboard sits beside it', async ({ page }) => {
  await open(page);
  const tabs = page.getByRole('tablist', { name: '쿠버네티스 화면' }).getByRole('tab');
  await expect(tabs.nth(0)).toHaveText('트리');
  await expect(tabs.nth(1)).toHaveText('대시보드');
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
});

test('the whole cluster, its counts and its top pods are shown', async ({ page }) => {
  await open(page);
  const total = region(page, '전체 자원');
  await expect(total).toContainText('사용 250m (25%)');
  await expect(total).toContainText('요청 300m (30%)');
  await expect(total).toContainText('할당 1');
  await expect(total).toContainText('n1');
  const now = region(page, '현황');
  await expect(now).toContainText('1/1 준비');
  await expect(now).toContainText('3개');
  await expect(now).toContainText('CrashLoopBackOff 1');
  await expect(now).toContainText('Running 2');
  await expect(now).toContainText('Deployment 0/1');
  const top = region(page, '자원 상위').locator('.kube-dash-row').first();
  await expect(top).toContainText('api-1');
  await expect(top).toContainText('150m');
  await expect(top).toContainText('75%');
});

test('restarts name the reason, the exit code and when', async ({ page }) => {
  await open(page);
  const row = region(page, '재시작·에러').getByRole('button').first();
  await expect(row).toContainText('crash-1');
  await expect(row).toContainText('CrashLoopBackOff · OOMKilled (종료 코드 137)');
  await expect(row).toContainText('재시작 7');
  await expect(row).toContainText('12분 전');
});

test('restarts since the tab opened are counted', async ({ page }) => {
  await open(page);
  const row = region(page, '재시작·에러').getByRole('button').first();
  await expect(row).not.toContainText('+');
  await page.evaluate(
    (pods) => {
      window.__kube.snapshots!.pods = pods;
    },
    ok(
      { kind: 'pods', items: [api1, { ...crash, containers: stopped({ restarts: 10 }) }] },
      NOW + 5000,
    ),
  );
  await page.clock.runFor(6000);
  await expect(row).toContainText('+3');
});

test('empty areas say there is no problem and stay on the screen', async ({ page }) => {
  await open(page, quiet);
  for (const name of ['재시작·에러', '미달 워크로드', '최근 경고'])
    await expect(region(page, name)).toContainText('문제 없음');
});

test('ingress and workers keep their place for later tasks', async ({ page }) => {
  await open(page);
  await expect(region(page, '인그레스')).toContainText('아직 준비 중입니다.');
  await expect(region(page, '워커')).toContainText('아직 준비 중입니다.');
});

test('a kind the account may not read gives its reason, not "no problem"', async ({ page }) => {
  await open(page, {
    ...healthy,
    workloads: failed({ kind: 'forbidden' }),
    events: failed({ kind: 'forbidden' }),
  });
  await expect(region(page, '미달 워크로드')).toContainText('권한 없음');
  await expect(region(page, '미달 워크로드')).not.toContainText('문제 없음');
  await expect(region(page, '최근 경고')).toContainText('권한 없음');
  await expect(region(page, '현황')).toContainText('권한 없음');
});

test('without metrics-server requests take over and it says why', async ({ page }) => {
  await open(page, {
    ...healthy,
    podUsage: failed({ kind: 'metricsMissing' }),
    nodeUsage: failed({ kind: 'metricsMissing' }),
  });
  const total = region(page, '전체 자원');
  await expect(total).toContainText('metrics-server가 없어');
  await expect(total).toContainText('요청 300m (30%)');
  await expect(total).toContainText('할당 1');
  await expect(total).not.toContainText(/사용 \d/);
  await expect(total.getByRole('img')).toHaveCount(0);
  const top = region(page, '자원 상위');
  await expect(top).toContainText('요청량 기준입니다.');
  await expect(top.locator('.kube-dash-row').first()).toContainText('100m');
});

test('a namespace session says requests cover only that namespace', async ({ page }) => {
  await open(page, healthy, { ...detection, saved: { ...detection.saved!, namespace: 'web' } });
  await expect(region(page, '전체 자원')).toContainText('요청량은 web namespace만 합산합니다.');
});

test('the usage trend grows with each reading', async ({ page }) => {
  await open(page);
  const chart = region(page, '전체 자원').getByRole('img', { name: /CPU 추세/ });
  await expect(chart).toHaveAttribute('aria-label', 'CPU 추세 최근 1개 샘플');
  await page.evaluate(
    (usage) => {
      window.__kube.snapshots!.nodeUsage = usage;
    },
    ok({ kind: 'nodeUsage', items: [{ name: 'n1', cpu: 500, memory: 2 ** 29 }] }, NOW + 20_000),
  );
  await page.clock.runFor(16_000);
  await expect(chart).toHaveAttribute('aria-label', 'CPU 추세 최근 2개 샘플');
  await expect(region(page, '전체 자원')).toContainText('50.0%');
});

test('the dashboard asks the cluster for nothing extra', async ({ page }) => {
  await open(page);
  await expect(region(page, '전체 자원')).toContainText('n1');
  await page.clock.runFor(1000);
  const before = await snapshotCalls(page);
  await screenTab(page, '트리').click();
  await screenTab(page, '대시보드').click();
  await expect(region(page, '전체 자원')).toContainText('n1');
  expect(await snapshotCalls(page)).toBe(before);
  const commands = await page.evaluate(() =>
    window.__kube.calls.filter((c) => c.command !== 'kube_detect').map((c) => c.command),
  );
  expect(new Set(commands)).toEqual(new Set(['kube_snapshot']));
});

test('a failed poll keeps the data and says it is old', async ({ page }) => {
  await open(page);
  await expect(region(page, '재시작·에러')).toContainText('crash-1');
  await page.evaluate(
    (snapshots) => {
      window.__kube.snapshots = snapshots;
    },
    { ...healthy, pods: failed({ kind: 'unreachable' }) },
  );
  await page.clock.runFor(30_000);
  await expect(page.getByText('마지막으로 받은 데이터입니다. 클러스터 연결 불가')).toBeVisible();
  await expect(region(page, '재시작·에러')).toContainText('crash-1');
});

test('a pod row goes to that pod in the tree', async ({ page }) => {
  await open(page);
  await region(page, '재시작·에러').getByRole('button').first().click();
  await expect(screenTab(page, '트리')).toHaveAttribute('aria-selected', 'true');
  await expect(treeRow(page, 'crash-1')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tree', { name: '클러스터 트리' })).toBeFocused();
});

test('a workload row switches the grouping and selects the workload', async ({ page }) => {
  await open(page);
  await screenTab(page, '트리').click();
  await page.getByLabel('묶기', { exact: true }).selectOption('service');
  await screenTab(page, '대시보드').click();
  await region(page, '미달 워크로드').getByRole('button').first().click();
  await expect(page.getByLabel('묶기', { exact: true })).toHaveValue('workload');
  await expect(treeRow(page, 'Deployment/api')).toHaveAttribute('aria-selected', 'true');
});

test('a node row opens the node list and selects the node', async ({ page }) => {
  await open(page);
  await region(page, '전체 자원').getByRole('button', { name: /n1/ }).click();
  await expect(treeRow(page, 'n1')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('treeitem').first()).toHaveAttribute('aria-expanded', 'true');
});

test('a warning goes to the object it is about', async ({ page }) => {
  await open(page);
  await region(page, '최근 경고').getByRole('button').first().click();
  await expect(treeRow(page, 'crash-1')).toHaveAttribute('aria-selected', 'true');
});

test('a filter that would hide the target is cleared', async ({ page }) => {
  await open(page);
  await screenTab(page, '트리').click();
  await page.getByLabel('파드 필터', { exact: true }).fill('api-2');
  await screenTab(page, '대시보드').click();
  await region(page, '재시작·에러').getByRole('button').first().click();
  await expect(page.getByLabel('파드 필터', { exact: true })).toHaveValue('');
  await expect(treeRow(page, 'crash-1')).toHaveAttribute('aria-selected', 'true');
});

test('a row far down the tree is scrolled into view', async ({ page }) => {
  const items = Array.from({ length: 3000 }, (_, at) => pod(`pod-${String(at).padStart(4, '0')}`));
  const last = pod('zz-crash', { containers: stopped({}) });
  await open(page, { ...healthy, pods: ok({ kind: 'pods', items: [...items, last] }) });
  await region(page, '재시작·에러').getByRole('button').first().click();
  await expect(treeRow(page, 'zz-crash')).toBeVisible();
  await expect(treeRow(page, 'zz-crash')).toHaveAttribute('aria-selected', 'true');
});

test('a long list stops and says how many are left', async ({ page }) => {
  const items = Array.from({ length: 35 }, (_, at) =>
    pod(`crash-${at}`, { containers: stopped({}) }),
  );
  await open(page, { ...healthy, pods: ok({ kind: 'pods', items }) });
  const panel = region(page, '재시작·에러');
  await expect(panel.getByRole('button')).toHaveCount(30);
  await expect(panel).toContainText('외 5개');
});

test('a narrow window keeps every area and is no wider than itself', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 700 });
  await open(page);
  await expect(region(page, '최근 경고')).toBeAttached();
  const overflow = await page
    .getByRole('tabpanel', { name: '대시보드' })
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
