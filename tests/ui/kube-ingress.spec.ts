import { expect, test, type Page } from '@playwright/test';
import type {
  HostTraffic,
  IngressReport,
  KubeIngress,
  Traffic,
} from '../../src/features/kube/ingressTypes';
import { detection, ok, pod, NOW } from './fixtures/kube-data';
import type {} from './fixtures/kube-workspace';

type Answers = NonNullable<Window['__kube']['snapshots']>;

const ingress = (patch: Partial<KubeIngress> = {}): KubeIngress => ({
  namespace: 'web',
  name: 'front',
  className: 'nginx',
  addresses: ['10.0.0.5'],
  tls: [],
  rules: [
    {
      host: 'ok.local',
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
  ...patch,
});

const dead = ingress({
  name: 'stopped',
  rules: [
    {
      host: 'dead.local',
      path: '/',
      pathType: 'Prefix',
      service: 'down',
      port: '80',
      isDefault: false,
      backend: 'noReady',
      readyEndpoints: 0,
      notReadyEndpoints: 0,
    },
  ],
});

const traffic = (patch: Partial<HostTraffic>): HostTraffic => ({
  host: 'ok.local',
  ok: 0,
  redirect: 0,
  clientError: 0,
  serverError: 0,
  other: 0,
  durationSum: 0,
  durationCount: 0,
  ...patch,
});

const ready = (hosts: HostTraffic[]): Traffic => ({
  kind: 'ready',
  controllers: 1,
  read: 1,
  hosts,
  connections: 3,
});

const report = (patch: Partial<IngressReport> = {}): IngressReport => ({
  state: { kind: 'ready' },
  ingresses: [ingress(), dead],
  servicesState: { kind: 'ready' },
  secretsState: { kind: 'ready' },
  controllers: [{ namespace: 'ingress-nginx', name: 'controller-1', container: 'controller' }],
  traffic: { kind: 'off' },
  collectedAt: NOW,
  elapsedMs: 5,
  ...patch,
});

const snapshots: Answers = {
  pods: ok({ kind: 'pods', items: [pod('api-1', { labels: { app: 'api' } })] }),
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

async function open(page: Page, answer: IngressReport) {
  await page.clock.install({ time: NOW });
  await page.addInitScript(
    ({ detection, snapshots, answer }) => {
      window.__kube = {
        detections: [detection],
        persist: true,
        snapshots,
        ingress: answer,
        copyResult: { typed: 'wait' },
        calls: [],
        copied: [],
        terminals: [],
      };
    },
    { detection, snapshots, answer },
  );
  await page.goto('/tests/ui/fixtures/kube-workspace.html');
  await expect(page.getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
  await page.getByRole('tab', { name: '인그레스', exact: true }).click();
}

const screen = (page: Page) => page.getByRole('tabpanel', { name: '인그레스' });
const host = (page: Page, name: string) =>
  screen(page).locator('.kube-ingress-row.host').filter({ hasText: name });
const cell = (page: Page, name: string, column: number) =>
  host(page, name).locator(':scope > span').nth(column);
const callsOf = (page: Page, command: string) =>
  page.evaluate(
    (command) => window.__kube.calls.filter((c) => c.command === command).length,
    command,
  );

test('a host shows its failure and its path, failures first', async ({ page }) => {
  await open(page, report());
  await expect(host(page, 'dead.local')).toContainText('백엔드 준비 0: down');
  await expect(screen(page).locator('.kube-ingress-row.host:not(.head)').first()).toContainText(
    'dead.local',
  );
  await expect(screen(page).locator('.kube-ingress-row.path').first()).toContainText('down:80');
  await expect(screen(page).locator('.kube-ingress-row.path').first()).toContainText('준비 0');
});

test('metrics that are off are said plainly and are not an error', async ({ page }) => {
  await open(page, report());
  await expect(screen(page).getByRole('status')).toContainText('컨트롤러 메트릭이 꺼져 있어');
  await expect(screen(page).getByRole('alert')).toHaveCount(0);
  await expect(cell(page, 'ok.local', 2)).toHaveText('-');
});

test('without pods/proxy only that reason is given', async ({ page }) => {
  await open(page, report({ traffic: { kind: 'proxyForbidden' } }));
  await expect(screen(page).getByRole('status')).toHaveText(
    'pods/proxy 권한이 없어 트래픽을 표시하지 못합니다.',
  );
  await expect(host(page, 'dead.local')).toContainText('백엔드 준비 0');
});

test('per-host shares come from the counters', async ({ page }) => {
  await open(
    page,
    report({
      traffic: ready([
        traffic({ ok: 60, clientError: 20, serverError: 20, durationSum: 5, durationCount: 100 }),
      ]),
    }),
  );
  await expect(screen(page).getByRole('status')).toHaveCount(0);
  await expect(cell(page, 'ok.local', 2)).toHaveText('60%');
  await expect(cell(page, 'ok.local', 3)).toHaveText('20%');
  await expect(cell(page, 'ok.local', 4)).toHaveText('20%');
  await expect(cell(page, 'ok.local', 5)).toHaveText('50ms');
  await expect(cell(page, 'ok.local', 1)).toHaveText('-');
});

test('filter and problems-only narrow the list', async ({ page }) => {
  await open(page, report());
  await screen(page).getByLabel('인그레스 필터', { exact: true }).fill('ok.loc');
  await expect(host(page, 'ok.local')).toHaveCount(1);
  await expect(host(page, 'dead.local')).toHaveCount(0);
  await screen(page).getByLabel('인그레스 필터', { exact: true }).fill('');
  await screen(page).getByLabel('문제만').check();
  await expect(host(page, 'ok.local')).toHaveCount(0);
  await expect(host(page, 'dead.local')).toHaveCount(1);
});

test('a row goes to the backend pod in the tree', async ({ page }) => {
  await open(page, report());
  await host(page, 'ok.local').click();
  await expect(
    page.getByRole('treeitem').filter({ has: page.getByText('api-1', { exact: true }) }),
  ).toHaveAttribute('aria-selected', 'true');
});

test('the menu searches the controller log by host and by upstream', async ({ page }) => {
  await open(page, report());
  await screen(page).locator('.kube-ingress-row.path').filter({ hasText: 'api:80' }).click({
    button: 'right',
  });
  const menu = page.getByRole('menu', { name: '인그레스 메뉴' });
  await expect(menu.getByRole('menuitem', { name: '파드로 이동: api-1' })).toBeVisible();
  await menu.getByRole('menuitem', { name: '컨트롤러 로그 검색: web-api-80' }).click();
  const search = page.getByRole('tabpanel', { name: '로그 검색' });
  await expect(search.getByLabel('범위 종류', { exact: true })).toHaveValue('controller');
  await expect(search.getByLabel('범위', { exact: true })).toHaveCount(0);
  await expect(search.getByLabel('키워드', { exact: true })).toHaveValue('web-api-80');
  await search.getByRole('button', { name: '검색', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const call = window.__kube.calls.find((c) => c.command === 'kube_log_search');
        return call ? (call.args.request as { targets: unknown[] }).targets : null;
      }),
    )
    .toEqual([
      { namespace: 'ingress-nginx', pod: 'controller-1', containers: ['controller'], previous: [] },
    ]);
});

test('a host row also offers the upstream of its backend', async ({ page }) => {
  await open(page, report());
  await host(page, 'ok.local').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '인그레스 메뉴' });
  await expect(menu.getByRole('menuitem', { name: '컨트롤러 로그 검색: ok.local' })).toBeEnabled();
  await expect(
    menu.getByRole('menuitem', { name: '컨트롤러 로그 검색: web-api-80' }),
  ).toBeEnabled();
});

test('a host with no name cannot be searched for', async ({ page }) => {
  const rules = ingress().rules.map((rule) => ({ ...rule, host: '' }));
  await open(page, report({ ingresses: [ingress({ rules })] }));
  await host(page, '(호스트 없음)').click({ button: 'right' });
  await expect(
    page
      .getByRole('menu', { name: '인그레스 메뉴' })
      .getByRole('menuitem', { name: '컨트롤러 로그 검색: 호스트 없음' }),
  ).toBeDisabled();
});

test('a list the account may not read gives the reason', async ({ page }) => {
  await open(
    page,
    report({ state: { kind: 'forbidden' }, ingresses: null, traffic: { kind: 'notRead' } }),
  );
  await expect(screen(page)).toContainText('권한 없음');
});

test('no ingresses is said to be empty', async ({ page }) => {
  await open(page, report({ ingresses: [] }));
  await expect(screen(page)).toContainText('인그레스가 없습니다.');
});

test('the dashboard lists what is wrong and opens the screen on it', async ({ page }) => {
  await open(page, report());
  await page.getByRole('tab', { name: '대시보드', exact: true }).click();
  const panel = page.getByRole('region', { name: '인그레스', exact: true });
  await expect(panel).toContainText('dead.local');
  await expect(panel).toContainText('백엔드 준비 0: down');
  await expect(panel).not.toContainText('ok.local');
  await panel.getByRole('button').filter({ hasText: 'dead.local' }).click();
  await expect(screen(page).getByLabel('인그레스 필터', { exact: true })).toHaveValue('dead.local');
  await expect(host(page, 'ok.local')).toHaveCount(0);
});

test('the dashboard says when nothing is wrong', async ({ page }) => {
  await open(page, report({ ingresses: [ingress()] }));
  await page.getByRole('tab', { name: '대시보드', exact: true }).click();
  await expect(page.getByRole('region', { name: '인그레스', exact: true })).toContainText(
    '문제 없음',
  );
});

test('it is not polled on the tree and waits out its period', async ({ page }) => {
  await open(page, report());
  await expect.poll(() => callsOf(page, 'kube_ingress')).toBe(1);
  await page.getByRole('tab', { name: '트리', exact: true }).click();
  await page.clock.fastForward(61_000);
  expect(await callsOf(page, 'kube_ingress')).toBe(1);
  await page.getByRole('tab', { name: '인그레스', exact: true }).click();
  await expect.poll(() => callsOf(page, 'kube_ingress')).toBe(2);
  await page.getByRole('tab', { name: '대시보드', exact: true }).click();
  await page.clock.fastForward(5_000);
  expect(await callsOf(page, 'kube_ingress')).toBe(2);
});

test('a narrow window scrolls the table instead of crushing it', async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 600 });
  await open(page, report());
  const table = screen(page).locator('.kube-ingress-table');
  expect((await table.boundingBox())!.width).toBeGreaterThanOrEqual(720);
  await expect(host(page, 'dead.local')).toBeVisible();
});
