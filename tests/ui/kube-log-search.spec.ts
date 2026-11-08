import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/kube-workspace';
import { detection, ok, pod } from './fixtures/kube-data';

const pods = [pod('api-1'), pod('api-2')];
const snapshots = {
  pods: ok({ kind: 'pods', items: pods }),
  podUsage: ok({
    kind: 'podUsage',
    items: [{ namespace: 'web', name: 'api-1', cpu: 120, memory: 64 * 2 ** 20 }],
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
  workloads: ok({
    kind: 'workloads',
    items: [{ kind: 'Deployment', namespace: 'web', name: 'api', desired: 2, ready: 2 }],
  }),
  nodes: ok({
    kind: 'nodes',
    items: [
      { name: 'n1', ready: true, unschedulable: false, cpuAllocatable: 4000, memoryAllocatable: 8 },
    ],
  }),
  nodeUsage: ok({ kind: 'nodeUsage', items: [] }),
  events: ok({ kind: 'events', items: [] }),
};

const source = (name = 'api-1') => ({
  namespace: 'web',
  pod: name,
  container: 'app',
  previous: false,
});
const hit = (seconds: number, text: string) => ({
  time: `2026-11-08T12:00:0${seconds}.123456789Z`,
  text,
  clipped: false,
});

async function open(page: Page) {
  await page.addInitScript(
    ({ detection, snapshots }) => {
      window.__kube = {
        detections: [detection],
        persist: true,
        snapshots,
        copyResult: { typed: 'wait' },
        calls: [],
        copied: [],
        terminals: [],
      };
    },
    { detection, snapshots },
  );
  await page.goto('/tests/ui/fixtures/kube-workspace.html');
  await expect(page.getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
  await expect(page.getByRole('treeitem').filter({ hasText: 'api-1' })).toBeVisible();
}

const openSearch = (page: Page) =>
  page.getByRole('tab', { name: '로그 검색', exact: true }).click();
const emit = (page: Page, event: Parameters<NonNullable<Window['__kube']['emitSearch']>>[0]) =>
  page.evaluate((event) => window.__kube.emitSearch?.(event), event);
const calls = (page: Page, command: string) =>
  page.evaluate(
    (command) => window.__kube.calls.filter((call) => call.command === command),
    command,
  );
const results = (page: Page) => page.getByRole('table', { name: '로그 검색 결과' });
const dataRows = (page: Page) => results(page).locator('.kube-search-body [role="row"]');

/** Starts a search for `error` over everything, and waits for the fake backend to have it. */
async function search(page: Page, query = 'error') {
  await page.getByLabel('키워드', { exact: true }).fill(query);
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'kube_log_search')).length).toBeGreaterThan(0);
}

test('a search asks the backend for the pods in scope and shows results as they arrive', async ({
  page,
}) => {
  await open(page);
  await openSearch(page);
  await search(page, 'error !debug');
  const [call] = await calls(page, 'kube_log_search');
  expect(call.args).toMatchObject({
    id: 'connection',
    request: {
      since: '15m',
      query: 'error !debug',
      targets: [
        { namespace: 'web', pod: 'api-1', containers: ['app'], previous: [] },
        { namespace: 'web', pod: 'api-2', containers: ['app'], previous: [] },
      ],
    },
  });

  await emit(page, { type: 'started', jobs: 2, omittedPods: 0 });
  await emit(page, { type: 'lines', source: source('api-2'), lines: [hit(2, 'ERROR late')] });
  await expect(dataRows(page)).toHaveCount(1);
  await expect(page.getByRole('status')).toContainText('검색 중 0/2 · 1줄');
  await emit(page, { type: 'lines', source: source('api-1'), lines: [hit(1, 'error early')] });
  await emit(page, {
    type: 'jobDone',
    source: source('api-1'),
    state: { kind: 'ready' },
    matched: 1,
    truncated: false,
  });
  await expect(dataRows(page)).toHaveCount(2);
  await expect(dataRows(page).first()).toContainText('error early');
  await expect(dataRows(page).first().locator('mark')).toHaveText('error');
  await page.getByRole('columnheader', { name: /시각/ }).click();
  await expect(dataRows(page).first()).toContainText('ERROR late');
});

test('every limit that cut the results is stated', async ({ page }) => {
  await open(page);
  await openSearch(page);
  await search(page);
  await emit(page, { type: 'started', jobs: 3, omittedPods: 4 });
  await emit(page, {
    type: 'jobDone',
    source: source(),
    state: { kind: 'ready' },
    matched: 1000,
    truncated: true,
  });
  await emit(page, { type: 'finished', outcome: 'totalLimit', unstarted: 1 });
  const alert = page.getByRole('alert');
  await expect(alert).toContainText('결과가 잘렸습니다.');
  await expect(alert).toContainText('파드당 1,000줄');
  await expect(alert).toContainText('전체 5,000줄');
  await expect(alert).toContainText('파드 100개 상한으로 4개');
  await expect(alert).toContainText('1개 대상은 시작하지 못했습니다');
});

test('a time limit is stated, and a finished search with nothing cut says nothing', async ({
  page,
}) => {
  await open(page);
  await openSearch(page);
  await search(page);
  await emit(page, { type: 'started', jobs: 1, omittedPods: 0 });
  await emit(page, { type: 'finished', outcome: 'done', unstarted: 0 });
  await expect(page.getByRole('status')).toContainText('검색 완료');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('검색 결과가 없습니다.')).toBeVisible();
  await page.evaluate(() => window.__kube.endSearch?.());
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await emit(page, { type: 'started', jobs: 1, omittedPods: 0 });
  await emit(page, { type: 'finished', outcome: 'timedOut', unstarted: 0 });
  await expect(page.getByRole('alert')).toContainText('60초 상한');
});

test('cancelling closes the search and keeps what already arrived', async ({ page }) => {
  await open(page);
  await openSearch(page);
  await search(page);
  await emit(page, { type: 'started', jobs: 4, omittedPods: 0 });
  await emit(page, { type: 'lines', source: source(), lines: [hit(1, 'error kept')] });
  await page.getByRole('button', { name: '취소', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'kube_log_cancel')).length).toBe(1);
  const [started] = await calls(page, 'kube_log_search');
  const [cancelled] = await calls(page, 'kube_log_cancel');
  expect(cancelled.args).toEqual({ searchId: started.args.searchId });
  await emit(page, { type: 'finished', outcome: 'cancelled', unstarted: 2 });
  await expect(page.getByRole('status')).toContainText('취소됨 0/4 · 1줄');
  await expect(dataRows(page)).toContainText('error kept');
  await expect(page.getByRole('button', { name: '검색', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a refused channel and a failed pod are explained without stopping the search', async ({
  page,
}) => {
  await open(page);
  await openSearch(page);
  await search(page);
  await emit(page, { type: 'started', jobs: 2, omittedPods: 0 });
  await emit(page, { type: 'narrowed', concurrency: 2 });
  await emit(page, {
    type: 'jobDone',
    source: source('api-2'),
    state: { kind: 'forbidden' },
    matched: 0,
    truncated: false,
  });
  await emit(page, { type: 'lines', source: source(), lines: [hit(1, 'error still here')] });
  await expect(page.getByText('서버의 동시 세션 한도로 동시 검색을 2개로')).toBeVisible();
  await page.getByText('검색하지 못한 대상 1개').click();
  await expect(page.getByText('api-2/app: 권한 없음')).toBeVisible();
  await expect(dataRows(page)).toContainText('error still here');
});

test('right click on a result opens that pod’s logs and shell', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    const state = { kind: 'ready' as const };
    window.__kube.podAnswers = {
      logs: {
        state,
        text: 'alpha line\n',
        previous: false,
        previousMissing: false,
        truncated: false,
      },
      detail: {
        overview: {
          state,
          data: {
            kind: 'overview',
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
            created: '2026-11-08T10:00:00Z',
            deleting: false,
            ownerKind: '',
            ownerName: '',
            defaultContainer: '',
            labels: {},
            initContainers: [],
            containers: [
              {
                name: 'app',
                image: 'i',
                ready: true,
                restarts: 0,
                state: 'running',
                reason: '',
                message: '',
                exitCode: null,
                startedAt: '',
                finishedAt: '',
                containerId: 'c',
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
    } as unknown as Window['__kube']['podAnswers'];
  });
  await openSearch(page);
  await search(page, 'error');
  await emit(page, { type: 'started', jobs: 1, omittedPods: 0 });
  await emit(page, { type: 'lines', source: source(), lines: [hit(1, 'error one')] });

  const menu = page.getByRole('menu', { name: '결과 메뉴' });
  await dataRows(page).first().click({ button: 'right' });
  await expect(menu.getByRole('menuitem')).toHaveText([
    '로그',
    '셸',
    '이 키워드로 실시간 따라가기',
    '이 줄 복사',
    '결과 전체 복사',
  ]);
  await menu.getByRole('menuitem', { name: '셸', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => window.__kube.terminals.at(-1)?.launch.kind))
    .toBe('podShell');
  const probes = await calls(page, 'kube_terminal_probe');
  expect(probes[0].args).toMatchObject({
    target: { namespace: 'web', pod: 'api-1' },
    container: 'app',
  });

  await dataRows(page).first().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: '이 키워드로 실시간 따라가기' }).click();
  expect(await page.evaluate(() => window.__kube.terminals.at(-1)?.launch)).toMatchObject({
    kind: 'podLogs',
    pod: 'api-1',
    container: 'app',
    keywords: 'error',
  });

  await dataRows(page).first().click({ button: 'right' });
  await menu.getByRole('menuitem', { name: '로그', exact: true }).click();
  await expect(page.locator('.kube-panel').getByLabel('로그', { exact: true })).toContainText(
    'alpha line',
  );
});

test('clicking a result shows the log around it', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    window.__kube.podAnswers = {
      logs: {
        state: { kind: 'ready' },
        text: '2026-11-08T12:00:00.123456789Z before\n2026-11-08T12:00:01.123456789Z error one\n2026-11-08T12:00:02.123456789Z after\n',
        previous: false,
        previousMissing: false,
        truncated: false,
      },
    };
  });
  await openSearch(page);
  await search(page);
  await emit(page, { type: 'started', jobs: 1, omittedPods: 0 });
  await emit(page, { type: 'lines', source: source(), lines: [hit(1, 'error one')] });
  await dataRows(page).first().click();
  const around = page.getByRole('region', { name: '주변 로그' });
  await expect(around.locator('.kube-around-line.hit')).toContainText('error one');
  await expect(around.locator('.kube-around-line')).toHaveCount(3);
  const [read] = await calls(page, 'kube_logs');
  expect(read.args).toMatchObject({
    container: 'app',
    previous: false,
    sinceTime: '2026-11-08T11:59:01.123Z',
  });
  await around.getByRole('button', { name: '패널 닫기' }).click();
  await expect(around).toHaveCount(0);
});

test('a search starts from the tree and the dashboard with the scope filled in', async ({
  page,
}) => {
  await open(page);
  const scopeOf = async () => ({
    kind: await page.getByLabel('범위 종류', { exact: true }).inputValue(),
    value: await page.getByLabel('범위', { exact: true }).inputValue(),
  });

  await page.getByRole('treeitem').filter({ hasText: 'api-1' }).click({ button: 'right' });
  await page
    .getByRole('menu', { name: '파드 메뉴' })
    .getByRole('menuitem', { name: '로그 검색' })
    .click();
  expect(await scopeOf()).toEqual({ kind: 'pod', value: 'web/api-1' });
  await expect(page.getByLabel('키워드', { exact: true })).toBeFocused();

  await page.getByRole('tab', { name: '트리', exact: true }).click();
  await page.getByRole('treeitem').filter({ hasText: 'Deployment/api' }).click({ button: 'right' });
  await page
    .getByRole('menu', { name: '그룹 메뉴' })
    .getByRole('menuitem', { name: '로그 검색' })
    .click();
  expect(await scopeOf()).toEqual({ kind: 'workload', value: 'web/Deployment/api' });

  await page.getByRole('tab', { name: '대시보드', exact: true }).click();
  const row = page.locator('.kube-dash-row.top').first();
  await row.click({ button: 'right' });
  await page
    .getByRole('menu', { name: '대시보드 메뉴' })
    .getByRole('menuitem', { name: '로그 검색' })
    .click();
  expect((await scopeOf()).kind).toBe('pod');
});

test('results survive going to the tree and back', async ({ page }) => {
  await open(page);
  await openSearch(page);
  await search(page);
  await emit(page, { type: 'started', jobs: 1, omittedPods: 0 });
  await emit(page, { type: 'lines', source: source(), lines: [hit(1, 'error kept')] });
  await expect(dataRows(page)).toHaveCount(1);
  await page.getByRole('tab', { name: '트리', exact: true }).click();
  await openSearch(page);
  await expect(dataRows(page)).toContainText('error kept');
  await expect(page.getByLabel('키워드', { exact: true })).toHaveValue('error');
});
