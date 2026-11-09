import { expect, test, type Page } from '@playwright/test';
import type { KubeHpa, KubeJob, KubeNode } from '../../src/features/kube/snapshotTypes';
import type {} from './fixtures/kube-workspace';
import { NOW, detection, failed, ok, pod } from './fixtures/kube-data';

type Answers = NonNullable<Window['__kube']['snapshots']>;

const node = (name: string, ready: boolean): KubeNode => ({
  name,
  ready,
  unschedulable: false,
  cpuAllocatable: 1000,
  memoryAllocatable: 2 ** 30,
});

const job: KubeJob = {
  namespace: 'web',
  name: 'migrate',
  created: '2026-11-08T11:00:00Z',
  ownerKind: '',
  ownerName: '',
  failed: true,
  failedAt: '2026-11-08T11:30:00Z',
  reason: 'BackoffLimitExceeded',
};

const hpa: KubeHpa = {
  namespace: 'web',
  name: 'api',
  targetKind: 'Deployment',
  targetName: 'api',
  max: 3,
  current: 3,
};

const healthyPods = [pod('api-1')];
const crashingPod = pod('api-1', {
  containers: [
    {
      name: 'app',
      ready: false,
      restarts: 2,
      waiting: 'CrashLoopBackOff',
      terminated: '',
      lastReason: 'OOMKilled',
      lastFinished: '2026-11-08T11:59:00Z',
      lastExitCode: 137,
    },
  ],
});

const answers = (at = NOW): Answers => ({
  pods: ok({ kind: 'pods', items: healthyPods }, at),
  workloads: ok(
    {
      kind: 'workloads',
      items: [{ kind: 'Deployment', namespace: 'web', name: 'api', desired: 2, ready: 1 }],
    },
    at,
  ),
  services: ok({ kind: 'services', items: [] }, at),
  nodes: ok({ kind: 'nodes', items: [node('n1', true), node('n2', false)] }, at),
  podUsage: failed({ kind: 'metricsMissing' }),
  nodeUsage: failed({ kind: 'metricsMissing' }),
  events: ok({ kind: 'events', items: [] }, at),
  pvcs: ok({ kind: 'pvcs', items: [{ namespace: 'web', name: 'data', phase: 'Pending' }] }, at),
  jobs: ok({ kind: 'jobs', items: [job] }, at),
  hpas: ok({ kind: 'hpas', items: [hpa] }, at),
});

const open = async (page: Page, snapshots: Answers = answers()) => {
  await page.clock.install({ time: NOW });
  await page.addInitScript(
    ([state]) => {
      window.__kube = state as Window['__kube'];
    },
    [
      {
        detections: [detection],
        copyResult: { typed: 'wait' },
        persist: true,
        snapshots,
        calls: [],
        copied: [],
        terminals: [],
      },
    ],
  );
  await page.goto('/tests/ui/fixtures/kube-workspace.html');
};

const tab = (page: Page, name: string | RegExp) => page.getByRole('tab', { name });
const panel = (page: Page, name: string) => page.getByRole('region', { name });
const setSnapshots = (page: Page, snapshots: Answers) =>
  page.evaluate((next) => (window.__kube.snapshots = next), snapshots);
const notifications = (page: Page) =>
  page.evaluate(() => window.__kube.calls.filter((c) => c.command === 'notification_show'));
const polledKinds = (page: Page) =>
  page.evaluate(() =>
    window.__kube.calls.filter((c) => c.command === 'kube_snapshot').map((c) => c.args.kind),
  );

test('the list shows each kind of problem and counts them on its tab', async ({ page }) => {
  await open(page);
  await tab(page, /문제 목록/).click();
  await expect(tab(page, '문제 목록 5')).toBeVisible();
  await expect(panel(page, 'NotReady 노드').getByRole('button', { name: /n2/ })).toBeVisible();
  await expect(panel(page, '미달 워크로드')).toContainText('준비 1/2');
  await expect(panel(page, '대기 PVC')).toContainText('web/data');
  await expect(panel(page, '실패 Job')).toContainText('BackoffLimitExceeded');
  await expect(panel(page, '최대치 HPA')).toContainText('최대치 3/3');
  await expect(panel(page, '문제 파드')).toContainText('문제 없음');
});

test('a refused kind says so instead of saying there is no problem', async ({ page }) => {
  await open(page, { ...answers(), jobs: failed({ kind: 'forbidden' }) });
  await tab(page, /문제 목록/).click();
  await expect(panel(page, '실패 Job')).toContainText('권한 없음');
  await expect(panel(page, '실패 Job')).not.toContainText('문제 없음');
});

test('the tree does not report on kinds only this screen reads', async ({ page }) => {
  await open(page, { ...answers(), pvcs: failed({ kind: 'forbidden' }) });
  await expect(page.getByText('PVC: 권한 없음')).toHaveCount(0);
});

test('a row goes to its place in the tree', async ({ page }) => {
  await open(page);
  await tab(page, /문제 목록/).click();
  await panel(page, 'NotReady 노드').getByRole('button', { name: /n2/ }).click();
  await expect(tab(page, '트리')).toHaveAttribute('aria-selected', 'true');
});

test('the change log starts empty and records what changed later', async ({ page }) => {
  await open(page);
  await tab(page, '변화 기록').click();
  await expect(page.getByText('아직 변화가 없습니다.')).toBeVisible();
  await setSnapshots(page, {
    ...answers(NOW + 6_000),
    pods: ok({ kind: 'pods', items: [crashingPod] }, NOW + 6_000),
  });
  await page.clock.runFor(6_000);
  const row = page.getByRole('button', { name: /재시작.*web\/api-1/ });
  await expect(row).toContainText('OOMKilled (종료 코드 137)');
  await expect(row).toContainText('+2');
});

test('the alert checkbox keeps its own size and its label stays on one line', async ({ page }) => {
  await open(page);
  await tab(page, /문제 목록/).click();
  const box = await page.getByRole('checkbox').boundingBox();
  expect(box?.width).toBeLessThan(32);
  const label = await page.locator('.kube-issues-bar label').boundingBox();
  expect(label?.height).toBeLessThan(40);
});

test('alerts are off by default and a hidden tab then stops polling', async ({ page }) => {
  await open(page);
  await tab(page, /문제 목록/).click();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await page.evaluate(() => window.__kube.setVisible?.(false));
  await page.clock.runFor(1_000);
  const before = (await polledKinds(page)).length;
  await page.clock.runFor(31_000);
  expect((await polledKinds(page)).length).toBe(before);
  expect(await notifications(page)).toEqual([]);
});

test('with alerts on, a hidden tab polls only problem kinds and notifies once', async ({
  page,
}) => {
  await open(page);
  await tab(page, /문제 목록/).click();
  await page.getByRole('checkbox').check();
  await page.evaluate(() => window.__kube.setVisible?.(false));
  await page.clock.runFor(1_000);
  const before = (await polledKinds(page)).length;

  await setSnapshots(page, {
    ...answers(NOW + 40_000),
    pods: ok({ kind: 'pods', items: [crashingPod] }, NOW + 40_000),
  });
  await page.clock.runFor(40_000);

  const kinds = new Set((await polledKinds(page)).slice(before));
  expect([...kinds].sort()).toEqual(['hpas', 'jobs', 'nodes', 'pods', 'pvcs', 'workloads']);
  await expect.poll(() => notifications(page)).toHaveLength(1);
  const [{ args }] = await notifications(page);
  expect(args.title).toBe('prod-bastion — 쿠버네티스 문제 1건');
  expect(args.body).toContain('web/api-1');

  await page.clock.runFor(20_000);
  expect(await notifications(page)).toHaveLength(1);
});

test('the alert setting belongs to the session and survives a reload', async ({ page }) => {
  await open(page);
  await tab(page, /문제 목록/).click();
  await page.getByRole('checkbox').check();
  expect(await page.evaluate(() => localStorage.getItem('dachsterm.kube.alerts.profile'))).toBe(
    '1',
  );
  await page.reload();
  await tab(page, /문제 목록/).click();
  await expect(page.getByRole('checkbox')).toBeChecked();
});
