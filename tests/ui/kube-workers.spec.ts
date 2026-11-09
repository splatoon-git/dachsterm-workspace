import { expect, test, type Page } from '@playwright/test';
import type { PodOverview } from '../../src/features/kube/detailTypes';
import type { MetricsRead, ProbeRead } from '../../src/features/kube/runtimeTypes';
import type { WorkerWatch } from '../../src/features/kube/workers';
import type {} from './fixtures/kube-workspace';
import { NOW, detection, ok, pod } from './fixtures/kube-data';

const snapshots: NonNullable<Window['__kube']['snapshots']> = {
  pods: ok({ kind: 'pods', items: [pod('api-1')] }),
  podUsage: ok({ kind: 'podUsage', items: [] }),
  services: ok({ kind: 'services', items: [] }),
  workloads: ok({
    kind: 'workloads',
    items: [{ kind: 'Deployment', namespace: 'web', name: 'api', desired: 1, ready: 1 }],
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

const overview: PodOverview = {
  namespace: 'web',
  name: 'api-1',
  uid: 'u',
  phase: 'Running',
  reason: '',
  message: '',
  node: 'n1',
  podIp: '',
  hostIp: '',
  qosClass: '',
  created: '2026-11-08T11:00:00Z',
  deleting: false,
  ownerKind: 'ReplicaSet',
  ownerName: 'api-7f9c',
  defaultContainer: 'app',
  labels: { 'pod-template-hash': '7f9c' },
  initContainers: [],
  containers: [
    {
      name: 'app',
      image: 'a',
      ready: true,
      restarts: 0,
      state: 'running',
      reason: '',
      message: '',
      exitCode: null,
      startedAt: '',
      finishedAt: '',
      containerId: '',
      last: null,
      cpuRequest: null,
      memoryRequest: null,
      cpuLimit: null,
      memoryLimit: null,
    },
  ],
};

const ready = (data: MetricsRead['data']): MetricsRead => ({
  state: { kind: 'ready' },
  data,
  elapsedMs: 1,
});

const stuck = ready({
  kind: 'series',
  total: 3,
  items: [
    { name: 'worker_busy', labels: '', value: 8 },
    { name: 'worker_total', labels: '', value: 8 },
    { name: 'requests_completed_total', labels: '', value: 120 },
  ],
});

const runtime: ProbeRead = {
  kind: 'ready',
  elapsedMs: 2,
  runtime: {
    processes: [
      { pid: 1, name: 'gunicorn', state: 'S', threads: 4, fds: 12, fdLimit: 1024, ageSeconds: 90 },
      { pid: 2, name: 'gunicorn', state: 'S', threads: 4, fds: 8, fdLimit: 1024, ageSeconds: 90 },
    ],
    truncated: false,
    tcp: {
      established: 3,
      synSent: 0,
      synRecv: 0,
      finWait1: 0,
      finWait2: 0,
      timeWait: 1,
      close: 0,
      closeWait: 2,
      lastAck: 0,
      listen: 1,
      closing: 0,
    },
    listen: [{ port: 8080, backlog: 128, queued: 0 }],
    counters: { listenOverflows: 0, listenDrops: 0, retransmitted: 7 },
  },
};

const watchOn: WorkerWatch = {
  key: 'web/Deployment/api',
  namespace: 'web',
  kind: 'Deployment',
  name: 'api',
  minutes: 1,
  metrics: {
    port: 8080,
    path: '/metrics',
    https: false,
    roles: { busy: 'worker_busy', total: 'worker_total', completed: 'requests_completed_total' },
  },
  probe: null,
};

type Runtime = NonNullable<Window['__kube']['runtime']>;

async function open(page: Page, runtimeAnswers: Runtime, stored: object | null = null) {
  await page.clock.install({ time: NOW });
  await page.addInitScript(
    ({ detection, snapshots, overview, runtimeAnswers, stored }) => {
      window.__kube = {
        detections: [detection],
        persist: true,
        snapshots,
        podAnswers: {
          detail: {
            overview: { state: { kind: 'ready' }, data: { kind: 'overview', ...overview } },
          },
        },
        runtime: runtimeAnswers,
        copyResult: { typed: 'wait' },
        calls: [],
        copied: [],
        terminals: [],
      };
      if (stored) localStorage.setItem('dachsterm.kube.workers.profile', JSON.stringify(stored));
    },
    { detection, snapshots, overview, runtimeAnswers, stored },
  );
  await page.goto('/tests/ui/fixtures/kube-workspace.html');
  await expect(page.getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
}

const groupRow = (page: Page, label: string) =>
  page
    .getByRole('treeitem')
    .filter({ has: page.getByText(label, { exact: true }) })
    .first();

const panelOf = (page: Page) => page.locator('.kube-panel');

async function openRuntime(page: Page) {
  await page
    .getByRole('treeitem')
    .filter({ has: page.getByText('api-1', { exact: true }) })
    .click({ button: 'right' });
  await page
    .getByRole('menu', { name: '파드 메뉴' })
    .getByRole('menuitem', { name: '런타임' })
    .click();
  await expect(panelOf(page).getByRole('tab', { name: '런타임', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
}

const assignRole = async (page: Page, metric: RegExp, role: string) => {
  await panelOf(page)
    .getByRole('list', { name: '메트릭 목록' })
    .getByRole('button', { name: metric })
    .click({ button: 'right' });
  await page
    .getByRole('menu', { name: '메트릭 메뉴' })
    .getByRole('menuitem', { name: role })
    .click();
};

test('a watched workload shows its workers on the tree row and turns suspect', async ({ page }) => {
  await open(page, { ports: { 8080: stuck } }, { watches: [watchOn], pins: {}, consent: [] });
  const cell = groupRow(page, 'Deployment/api').locator('.kube-worker-cell');
  await expect(cell).toHaveText('사용 8/8');
  await page.clock.runFor(80_000);
  await expect(cell).toContainText('사용 8/8');
  await expect(cell).toContainText('의심');
  await expect(cell).toHaveAttribute('title', /api-1: 반환 안 됨 의심/);

  await page.getByRole('tab', { name: '대시보드', exact: true }).click();
  const panel = page.getByRole('region', { name: '워커' });
  await expect(panel).toContainText('Deployment/api');
  await expect(panel).toContainText('사용 8/8');
  await expect(panel).toContainText('api-1');
  await expect(panel).toContainText('반환 안 됨 의심');
  await panel.getByRole('button', { name: /api-1 반환 안 됨/ }).click();
  await expect(panelOf(page).getByRole('tab', { name: '런타임', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('no permission for metrics reads as such and never as a value', async ({ page }) => {
  const forbidden: MetricsRead = { state: { kind: 'forbidden' }, data: null, elapsedMs: 1 };
  await open(page, { ports: { 8080: forbidden } }, { watches: [watchOn], pins: {}, consent: [] });
  await expect(groupRow(page, 'Deployment/api').locator('.kube-worker-cell')).toHaveText(
    '권한 없음 (pods/proxy)',
  );
});

test('metrics are found, assigned by the row menu, and start a watch', async ({ page }) => {
  await open(page, {
    candidates: ready({
      kind: 'candidates',
      items: [
        { port: 8080, path: '/metrics', https: false, annotated: true },
        { port: 9000, path: '/metrics', https: false, annotated: false },
        { port: 9001, path: '/metrics', https: false, annotated: false },
      ],
    }),
    ports: {
      8080: stuck,
      9000: ready({ kind: 'absent', reason: 'notFound' }),
      9001: ready({ kind: 'absent', reason: 'refused' }),
      7777: ready({
        kind: 'series',
        total: 1,
        items: [{ name: 'manual_only', labels: '', value: 5 }],
      }),
    },
    threads: { state: { kind: 'forbidden' }, data: null, elapsedMs: 1 },
    probe: runtime,
  });
  await openRuntime(page);
  const panel = panelOf(page);
  const candidates = panel.getByRole('list', { name: '메트릭 후보' });
  await expect(candidates).toContainText('지표 3개');
  await expect(candidates).toContainText('메트릭 없음 (404)');
  await expect(candidates).toContainText('메트릭 없음 (연결 거부)');

  await expect(panel.getByRole('button', { name: /worker_busy/ })).toBeVisible();
  await assignRole(page, /worker_busy/, '사용 중(으)로 지정');
  await assignRole(page, /worker_total/, '전체(으)로 지정');
  await assignRole(page, /requests_completed_total/, '완료 수(으)로 지정');
  await panel.getByLabel('판정 기준(분)').fill('1');
  await panel.getByRole('button', { name: '워커 감시 켜기', exact: true }).click();
  await expect(panel.getByRole('button', { name: '감시 끄기', exact: true })).toBeVisible();
  await expect(groupRow(page, 'Deployment/api').locator('.kube-worker-cell')).toHaveText(
    '사용 8/8',
  );

  await panel.getByLabel('메트릭 포트').fill('7777');
  await panel.getByRole('button', { name: '읽기', exact: true }).click();
  await expect(panel.getByRole('button', { name: /manual_only/ })).toBeVisible();
  await panel.getByLabel('메트릭 포트').fill('not-a-port');
  await panel.getByRole('button', { name: '읽기', exact: true }).click();
  await expect(panel.getByText('포트 번호를 확인하세요.')).toBeVisible();
});

test('a probe asks once per workload, and says plainly when it cannot run', async ({ page }) => {
  await open(page, {
    candidates: ready({ kind: 'candidates', items: [] }),
    threads: ready({ kind: 'threads', containers: [{ container: 'app', threads: 12 }] }),
    probe: runtime,
  });
  await openRuntime(page);
  const panel = panelOf(page);
  await expect(panel.getByRole('region', { name: '컨테이너 스레드' })).toContainText('12');
  await panel.getByRole('button', { name: '수집', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '런타임 읽기' });
  await expect(dialog).toContainText('파드 안에서 읽기 명령을 실행합니다');
  await dialog.getByRole('button', { name: '실행', exact: true }).click();
  await expect(panel.getByRole('cell', { name: 'gunicorn', exact: true }).first()).toBeVisible();
  const closeWait = panel.locator('.kube-rt-stat', { hasText: 'CLOSE_WAIT' });
  await expect(closeWait).toContainText('2');
  await expect(panel.getByRole('row', { name: '8080 0 / 128' })).toBeVisible();

  await page.evaluate(() => {
    const probe = window.__kube.runtime?.probe;
    if (probe?.kind === 'ready') probe.runtime.tcp.closeWait = 5;
  });
  await panel.getByRole('button', { name: '수집', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(closeWait).toContainText('+3');

  await page.evaluate(() => {
    window.__kube.runtime = { ...window.__kube.runtime, probe: { kind: 'noShell' } };
  });
  await panel.getByRole('button', { name: '수집', exact: true }).click();
  await expect(panel.getByText('이 컨테이너에서는 읽을 수 없음')).toBeVisible();

  await page.evaluate(() => {
    window.__kube.runtime = {
      ...window.__kube.runtime,
      probe: { kind: 'blocked', state: { kind: 'forbidden' } },
    };
  });
  await panel.getByRole('button', { name: '수집', exact: true }).click();
  await expect(panel.getByText('pods/exec 권한이 없어 읽을 수 없음')).toBeVisible();
});

test('no node permission falls through to the probe once it has been allowed', async ({ page }) => {
  await open(
    page,
    {
      candidates: ready({ kind: 'candidates', items: [] }),
      threads: { state: { kind: 'forbidden' }, data: null, elapsedMs: 1 },
      probe: runtime,
    },
    { watches: [], pins: {}, consent: ['web/Deployment/api'] },
  );
  await openRuntime(page);
  const panel = panelOf(page);
  await expect(panel.getByText(/nodes\/proxy 권한이 없어/)).toBeVisible();
  await expect(panel.getByRole('cell', { name: 'gunicorn', exact: true }).first()).toBeVisible();
});
