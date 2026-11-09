import { expect, test, type Page } from '@playwright/test';
import type {} from './fixtures/kube-workspace';
import { NOW, detection, failed, ok, pod, saved } from './fixtures/kube-data';

const crash = pod('crash-1', {
  labels: { app: 'lonely' },
  ownerKind: '',
  ownerName: '',
  containers: [
    {
      name: 'app',
      ready: false,
      restarts: 7,
      waiting: 'CrashLoopBackOff',
      terminated: '',
      lastReason: 'Error',
      lastFinished: '2026-11-08T11:59:00Z',
      lastExitCode: 1,
    },
  ],
});
const healthy = {
  pods: ok({ kind: 'pods', items: [pod('api-1'), pod('api-2'), crash] }),
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
    items: [{ kind: 'Deployment', namespace: 'web', name: 'api', desired: 3, ready: 2 }],
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

type Answers = NonNullable<Window['__kube']['snapshots']>;

async function open(page: Page, snapshots: Answers = healthy) {
  await page.clock.install({ time: NOW });
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
}
const row = (page: Page, name: string) =>
  page
    .getByRole('treeitem')
    .filter({ has: page.getByText(name, { exact: true }) })
    .first();
const snapshotCalls = (page: Page) =>
  page.evaluate(() => window.__kube.calls.filter((c) => c.command === 'kube_snapshot').length);
const setAnswers = (page: Page, snapshots: Answers) =>
  page.evaluate((snapshots) => {
    window.__kube.snapshots = snapshots;
  }, snapshots);
const setVisible = (page: Page, visible: boolean) =>
  page.evaluate((visible) => window.__kube.setVisible?.(visible), visible);

const container = (name: string) => ({
  name,
  image: 'img:1',
  ready: true,
  restarts: 0,
  state: 'running' as const,
  reason: '',
  message: '',
  exitCode: null,
  startedAt: '',
  finishedAt: '',
  containerId: `containerd://${name}`,
  last: null,
  cpuRequest: null,
  memoryRequest: null,
  cpuLimit: null,
  memoryLimit: null,
});
const overviewAnswer = (patch = {}) => ({
  state: { kind: 'ready' as const },
  data: {
    kind: 'overview' as const,
    namespace: 'web',
    name: 'api-1',
    uid: 'u1',
    phase: 'Running',
    reason: '',
    message: '',
    node: 'n1',
    podIp: '10.0.0.1',
    hostIp: '10.0.0.2',
    qosClass: 'Burstable',
    created: '2026-11-08T10:00:00Z',
    deleting: false,
    ownerKind: 'ReplicaSet',
    ownerName: 'api-7f9c',
    defaultContainer: '',
    labels: { app: 'api' },
    initContainers: [],
    containers: [container('app')],
    ...patch,
  },
});
const logsAnswer = {
  state: { kind: 'ready' as const },
  text: 'alpha line\nbeta line\n',
  previous: false,
  previousMissing: false,
  truncated: false,
};
const setPodAnswers = (page: Page, answers: Window['__kube']['podAnswers']) =>
  page.evaluate((answers) => {
    window.__kube.podAnswers = answers;
  }, answers);
const podPanel = (page: Page) => page.locator('.kube-panel');

test('Enter opens the log panel beside the tree and Esc returns to the same pod', async ({
  page,
}) => {
  await open(page);
  await setPodAnswers(page, { detail: { overview: overviewAnswer() }, logs: logsAnswer });
  await row(page, 'api-1').click();
  await page.keyboard.press('Enter');
  await expect(podPanel(page).getByLabel('로그', { exact: true })).toContainText('beta line');
  await page.keyboard.press('Escape');
  await expect(podPanel(page)).toHaveCount(0);
  await expect(row(page, 'api-1')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tree', { name: '클러스터 트리' })).toBeFocused();
  const logs = await page.evaluate(() =>
    window.__kube.calls.filter((call) => call.command === 'kube_logs'),
  );
  expect(logs[0].args).toMatchObject({ container: 'app', tail: 500, previous: false });
});

test('a group row still folds on Enter and only pods have the menu', async ({ page }) => {
  await open(page);
  await row(page, 'Deployment/api').click();
  await page.keyboard.press('Enter');
  await expect(row(page, 'api-1')).toHaveCount(0);
  await expect(podPanel(page)).toHaveCount(0);
  await row(page, 'Deployment/api').click({ button: 'right' });
  await expect(page.getByRole('menu', { name: '파드 메뉴' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('copies the rows the tree is showing, with its cluster and filter', async ({ page }) => {
  await open(page);
  await page.getByLabel('파드 필터').fill('api');
  await expect(row(page, 'crash-1')).toHaveCount(0);
  await row(page, 'api-1').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '보이는 트리 복사' }).click();
  await expect(page.getByRole('alert')).toContainText('보이는 트리를 복사했습니다.');
  const copied = await page.evaluate(
    () => window.__kube.calls.find((c) => c.command === 'clipboard_write_text')?.args.text,
  );
  expect(copied).toContain('필터 api');
  expect(copied).toContain('api-1');
  expect(copied).not.toContain('crash-1');

  await row(page, 'Deployment/api').click({ button: 'right' });
  await expect(
    page
      .getByRole('menu', { name: '그룹 메뉴' })
      .getByRole('menuitem', { name: '보이는 트리 복사' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
});

test('the log panel filters by keyword and says when there is no previous instance', async ({
  page,
}) => {
  await open(page);
  await setPodAnswers(page, {
    detail: { overview: overviewAnswer() },
    logs: { ...logsAnswer, previousMissing: true },
  });
  await row(page, 'api-1').dblclick();
  const panel = podPanel(page);
  await expect(panel.getByRole('status')).toContainText('직전 인스턴스가 없어');
  await panel.getByLabel('로그 필터', { exact: true }).fill('alpha');
  await expect(panel.getByLabel('로그', { exact: true })).toContainText('alpha line');
  await expect(panel.getByLabel('로그', { exact: true })).not.toContainText('beta line');
  await panel.getByRole('button', { name: '따라가기', exact: true }).click();
  const launches = await page.evaluate(() => window.__kube.terminals.map((t) => t.launch));
  expect(launches[0]).toMatchObject({ kind: 'podLogs', pod: 'api-1', container: 'app' });
});

test('S opens a shell tab with the annotated container', async ({ page }) => {
  await open(page);
  await setPodAnswers(page, {
    detail: {
      overview: overviewAnswer({
        defaultContainer: 'main',
        containers: [container('side'), container('main')],
      }),
    },
    probe: { kind: 'ready' },
  });
  await row(page, 'api-1').click();
  await page.keyboard.press('s');
  await expect.poll(() => page.evaluate(() => window.__kube.terminals.length)).toBe(1);
  const [request] = await page.evaluate(() => window.__kube.terminals);
  expect(request.launch).toMatchObject({ kind: 'podShell', pod: 'api-1', container: 'main' });
  expect(request.title).toBe('prod · api-1');
});

test('a pod with several containers asks which one, once', async ({ page }) => {
  await open(page);
  await setPodAnswers(page, {
    detail: { overview: overviewAnswer({ containers: [container('a'), container('b')] }) },
  });
  await row(page, 'api-1').click();
  await page.keyboard.press('s');
  const picker = page.getByRole('menu', { name: '파드 메뉴' });
  await expect(picker.getByRole('menuitem')).toHaveText(['a', 'b']);
  await picker.getByRole('menuitem', { name: 'b' }).click();
  await expect.poll(() => page.evaluate(() => window.__kube.terminals.length)).toBe(1);
  await row(page, 'api-1').click();
  await page.keyboard.press('s');
  await expect.poll(() => page.evaluate(() => window.__kube.terminals.length)).toBe(2);
  await expect(picker).toHaveCount(0);
});

test('a shell that cannot start says why and opens nothing', async ({ page }) => {
  await open(page);
  await setPodAnswers(page, {
    detail: { overview: overviewAnswer() },
    probe: { kind: 'noShell' },
  });
  await row(page, 'api-1').click();
  await page.keyboard.press('s');
  await expect(page.getByRole('alert')).toContainText('셸(sh)이 없어');
  await setPodAnswers(page, {
    detail: { overview: overviewAnswer() },
    probe: { kind: 'blocked', state: { kind: 'channelLimit' } },
  });
  await page.keyboard.press('s');
  await expect(page.getByRole('alert')).toContainText('동시 세션 한도');
  expect(await page.evaluate(() => window.__kube.terminals.length)).toBe(0);
});

test('the context menu reaches events and a problem pod opens on its cause', async ({ page }) => {
  await open(page);
  await setPodAnswers(page, {
    detail: {
      overview: overviewAnswer({
        name: 'crash-1',
        ownerKind: '',
        ownerName: '',
        containers: [
          {
            ...container('app'),
            ready: false,
            state: 'waiting',
            reason: 'CrashLoopBackOff',
            restarts: 7,
            last: {
              reason: 'OOMKilled',
              message: '',
              exitCode: 137,
              startedAt: '',
              finishedAt: '2026-11-08T11:59:00Z',
            },
          },
        ],
      }),
      events: {
        state: { kind: 'ready' },
        data: {
          kind: 'events',
          items: [
            {
              eventType: 'Warning',
              reason: 'BackOff',
              count: 3,
              time: '2026-11-08T11:58:00Z',
              message: 'Back-off restarting failed container',
            },
          ],
        },
      },
    },
    logs: { ...logsAnswer, previous: true, text: 'dying words\n' },
  });
  await row(page, 'crash-1').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /이벤트/ }).click();
  await expect(podPanel(page)).toContainText('BackOff');
  await page.keyboard.press('Escape');
  await expect(podPanel(page)).toHaveCount(0);
  await row(page, 'crash-1').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /상세/ }).click();
  const cause = page.locator('.kube-cause');
  await expect(cause.locator('table')).toContainText('OOMKilled');
  await expect(cause.locator('table')).toContainText('137');
  await expect(cause).toContainText('Back-off restarting failed container');
  await expect(cause.getByLabel('장애 원인 로그', { exact: true })).toContainText('dying words');
  await expect(cause.getByRole('heading', { name: /직전 인스턴스 로그/ })).toBeVisible();
});

test('the tree opens first, grouped by workload', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('tab', { name: '트리', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('묶기', { exact: true })).toHaveValue('workload');
  await expect(row(page, 'Deployment/api')).toContainText('준비 2/3');
  await expect(row(page, '단독 파드')).toBeVisible();
});

test('services, pods and their resources are shown', async ({ page }) => {
  await open(page);
  await page.getByLabel('묶기', { exact: true }).selectOption('service');
  await expect(row(page, 'web')).toBeVisible();
  await expect(row(page, 'api')).toContainText('ClusterIP');
  await expect(row(page, 'api-1')).toContainText('120m');
  await expect(row(page, 'api-1')).toContainText('64Mi');
  await expect(row(page, 'api-1')).toContainText('Running');
  await expect(row(page, '서비스 없음')).toBeVisible();
  await expect(row(page, 'crash-1')).toContainText('CrashLoopBackOff');
  await expect(row(page, 'crash-1')).toContainText('7 ↑');
  await expect(row(page, 'api-1')).toContainText('n1');
  await expect(page.getByText('3 / 3개 · 경고 0')).toBeVisible();
  await expect(page.getByRole('tablist', { name: '쿠버네티스 화면' })).toContainText('0초 전');
});

test('group rows add up their pods', async ({ page }) => {
  await open(page);
  await page.getByLabel('묶기', { exact: true }).selectOption('service');
  const group = row(page, 'api');
  await expect(group).toContainText('2/2');
  await expect(group).toContainText('120m');
});

test('each grouping is available and is remembered for the session', async ({ page }) => {
  await open(page);
  const grouping = page.getByLabel('묶기', { exact: true });
  await grouping.selectOption('service');
  await expect(row(page, 'api')).toContainText('ClusterIP');
  await grouping.selectOption('node');
  await expect(row(page, 'n1')).toContainText('Node');
  await expect(row(page, 'n1')).toContainText('Ready');
  await page.reload();
  await expect(page.getByLabel('묶기', { exact: true })).toHaveValue('node');
});

test('one key switches the grouping', async ({ page }) => {
  await open(page);
  const grouping = page.getByLabel('묶기', { exact: true });
  await page.getByRole('tree', { name: '클러스터 트리' }).focus();
  await page.keyboard.press('g');
  await expect(grouping).toHaveValue('service');
  await page.keyboard.press('g');
  await expect(grouping).toHaveValue('node');
  await page.keyboard.press('g');
  await expect(grouping).toHaveValue('workload');
});

test('the node group sits on top, folded while every node is ready', async ({ page }) => {
  await open(page);
  const first = page.getByRole('treeitem').first();
  await expect(first).toContainText('노드');
  await expect(first).toContainText('1/1 준비');
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await first.locator('.kube-tree-fold').click();
  await expect(row(page, 'n1')).toContainText('파드 3');
  await expect(row(page, 'n1')).toContainText('- / 4');
});

test('a node that is not ready opens the node group by itself', async ({ page }) => {
  await open(page, {
    ...healthy,
    nodes: ok({
      kind: 'nodes',
      items: [
        {
          name: 'n1',
          ready: false,
          unschedulable: false,
          cpuAllocatable: 4000,
          memoryAllocatable: 8,
        },
      ],
    }),
  });
  await expect(page.getByRole('treeitem').first()).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'n1')).toContainText('NotReady');
});

test('the node group leaves when grouped by node or searching', async ({ page }) => {
  await open(page);
  const first = page.getByRole('treeitem').first();
  await expect(first).toContainText('1/1 준비');
  await page.getByLabel('묶기', { exact: true }).selectOption('node');
  await expect(first).not.toContainText('1/1 준비');
  await page.getByLabel('묶기', { exact: true }).selectOption('workload');
  await expect(first).toContainText('1/1 준비');
  await page.getByLabel('파드 필터', { exact: true }).fill('api');
  await expect(first).not.toContainText('1/1 준비');
});

test('the filter applies as you type, with AND and exclusion', async ({ page }) => {
  await open(page);
  const filter = page.getByLabel('파드 필터', { exact: true });
  await filter.fill('api-1');
  await expect(row(page, 'api-1')).toBeVisible();
  await expect(page.getByText('crash-1')).toHaveCount(0);
  await filter.fill('api !api-1');
  await expect(page.getByText('api-1', { exact: true })).toHaveCount(0);
  await expect(row(page, 'api-2')).toBeVisible();
  await filter.fill('없는이름');
  await expect(page.getByText('조건에 맞는 파드가 없습니다.')).toBeVisible();
});

test('problems only keeps the broken pods', async ({ page }) => {
  await open(page);
  await page.getByRole('checkbox', { name: '문제만' }).check();
  await expect(row(page, 'crash-1')).toBeVisible();
  await expect(page.getByText('api-1', { exact: true })).toHaveCount(0);
});

const activeText = (page: Page) =>
  page.getByRole('tree', { name: '클러스터 트리' }).evaluate((element) => {
    const id = element.getAttribute('aria-activedescendant');
    return id ? document.getElementById(id)?.textContent : null;
  });

test('folding works from the keyboard and is remembered', async ({ page }) => {
  await open(page);
  const tree = page.getByRole('tree', { name: '클러스터 트리' });
  await tree.focus();
  expect(await activeText(page)).toContain('노드');
  await page.keyboard.press('j');
  await page.keyboard.press('ArrowDown');
  expect(await activeText(page)).toContain('Deployment/api');
  await page.keyboard.press('h');
  await expect(page.getByText('api-1', { exact: true })).toHaveCount(0);
  await expect(row(page, 'Deployment/api')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('l');
  await expect(row(page, 'api-1')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  expect(await activeText(page)).toContain('api-1');
  await page.keyboard.press('k');
  expect(await activeText(page)).toContain('Deployment/api');
  await page.keyboard.press('Enter');
  await expect(page.getByText('api-1', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(row(page, 'Deployment/api')).toHaveAttribute('aria-expanded', 'false');
});

test('the keys work while the input language is Korean', async ({ page }) => {
  await open(page);
  const tree = page.getByRole('tree', { name: '클러스터 트리' });
  await tree.focus();
  await tree.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ㅓ', code: 'KeyJ', bubbles: true, cancelable: true }),
    ),
  );
  await expect.poll(() => activeText(page)).toContain('web');
});

test('the slash key opens the filter and Enter or down goes to the results', async ({ page }) => {
  await open(page);
  const tree = page.getByRole('tree', { name: '클러스터 트리' });
  const filter = page.getByLabel('파드 필터', { exact: true });
  await tree.focus();
  await page.keyboard.press('/');
  await expect(filter).toBeFocused();
  await expect(filter).toHaveValue('');
  await page.keyboard.type('crash');
  await page.keyboard.press('Enter');
  await expect(tree).toBeFocused();
  expect(await activeText(page)).toContain('crash-1');
  await page.keyboard.press('/');
  await page.keyboard.type('api-2');
  await page.keyboard.press('ArrowDown');
  await expect(tree).toBeFocused();
  expect(await activeText(page)).toContain('api-2');
});

test('a click selects, the arrow folds, and keys carry on from there', async ({ page }) => {
  await open(page);
  const group = row(page, 'Deployment/api');
  await group.locator('.kube-tree-label').click();
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(group).toHaveAttribute('aria-selected', 'true');
  await group.locator('.kube-tree-fold').click();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(group).toHaveAttribute('aria-selected', 'true');
  await group.locator('.kube-tree-fold').click();
  await page.keyboard.press('j');
  expect(await activeText(page)).toContain('api-1');
});

test('a column title sorts and rows carry no buttons', async ({ page }) => {
  await open(page);
  const heading = page.locator('.kube-tree-head .kube-tree-sort', { hasText: '재시작' });
  const pods = () =>
    page
      .locator('.kube-tree-row:not(.group):not(.kube-tree-head) .kube-tree-label')
      .allTextContents();
  await page.getByLabel('묶기', { exact: true }).selectOption('node');
  expect((await pods())[0]).toBe('api-1');
  await heading.click();
  await expect(heading).toContainText('↓');
  expect((await pods())[0]).toBe('crash-1');
  await heading.click();
  await expect(heading).toContainText('↑');
  expect((await pods())[0]).toBe('api-1');
  await expect(page.getByRole('treeitem').getByRole('button')).toHaveCount(0);
});

test('a long pod name does not push its row out of line', async ({ page }) => {
  const long = `kube-controller-manager-${'x'.repeat(80)}`;
  await open(page, { ...healthy, pods: ok({ kind: 'pods', items: [pod('api-1'), pod(long)] }) });
  const cpuColumn = (name: string) =>
    row(page, name)
      .locator(':scope > span')
      .nth(4)
      .evaluate((cell) => cell.getBoundingClientRect().left);
  expect(await cpuColumn(long)).toBe(await cpuColumn('api-1'));
});

test('the worker column waits empty for a later task', async ({ page }) => {
  await open(page);
  await expect(page.locator('.kube-tree-head')).toContainText('워커');
  const cells = row(page, 'Deployment/api').locator(':scope > span');
  await expect(cells).toHaveCount(9);
  await expect(cells.nth(7)).toHaveText('');
});

test('the filter and selection survive a look at the server terminal', async ({ page }) => {
  await open(page);
  await page.getByLabel('파드 필터', { exact: true }).fill('crash');
  await row(page, 'crash-1').click();
  await page.getByRole('tab', { name: '서버 터미널', exact: true }).click();
  await page.getByRole('tab', { name: '트리', exact: true }).click();
  await expect(page.getByLabel('파드 필터', { exact: true })).toHaveValue('crash');
  await expect(row(page, 'crash-1')).toHaveAttribute('aria-selected', 'true');
});

test('the last screen of a session comes back', async ({ page }) => {
  await open(page);
  await page.getByRole('tab', { name: '인그레스', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('tab', { name: '인그레스', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('five thousand pods stay light and every row can be reached', async ({ page }) => {
  const items = Array.from({ length: 5000 }, (_, at) => pod(`pod-${String(at).padStart(4, '0')}`));
  await open(page, { ...healthy, pods: ok({ kind: 'pods', items }) });
  expect(await page.getByRole('treeitem').count()).toBeLessThan(120);
  const tree = page.getByRole('tree', { name: '클러스터 트리' });
  await tree.focus();
  await page.keyboard.press('End');
  await expect(row(page, 'pod-4999')).toBeVisible();
  expect(await page.getByRole('treeitem').count()).toBeLessThan(120);
  const id = await tree.getAttribute('aria-activedescendant');
  await expect(page.locator(`[id="${id}"]`)).toContainText('pod-4999');
});

test('without metrics-server the columns say requests and limits', async ({ page }) => {
  await open(page, { ...healthy, podUsage: failed({ kind: 'metricsMissing' }) });
  await expect(page.getByText('CPU 요청/제한')).toBeVisible();
  await expect(row(page, 'api-1')).toContainText('100m / 200m');
  await expect(page.getByText('파드 사용량: metrics-server 없음')).toBeVisible();
});

test('a kind the account may not read is empty and says why', async ({ page }) => {
  await open(page, { ...healthy, workloads: failed({ kind: 'forbidden' }) });
  await expect(page.getByText('워크로드: 권한 없음')).toBeVisible();
  await expect(row(page, 'api-1')).toBeVisible();
});

test('pods that may not be read leave the reason in place of the tree', async ({ page }) => {
  await open(page, { ...healthy, pods: failed({ kind: 'forbidden' }) });
  await expect(page.locator('.kube-tree-empty')).toHaveText('권한 없음');
});

test('a failed poll keeps the data and the age keeps growing', async ({ page }) => {
  await open(page);
  await expect(row(page, 'api-1')).toBeVisible();
  await setAnswers(page, { ...healthy, pods: failed({ kind: 'unreachable' }) });
  await page.clock.runFor(30_000);
  const header = page.getByRole('tablist', { name: '쿠버네티스 화면' });
  await expect(header).toContainText('30초 전');
  await expect(header).toContainText('클러스터 연결 불가');
  await expect(row(page, 'api-1')).toBeVisible();
  await expect(page.getByText('마지막으로 받은 데이터입니다. 클러스터 연결 불가')).toBeVisible();
});

test('polling stops while the tab is hidden and refreshes when it returns', async ({ page }) => {
  await open(page);
  await expect(row(page, 'api-1')).toBeVisible();
  await setVisible(page, false);
  await page.clock.runFor(1000);
  const before = await snapshotCalls(page);
  await page.clock.runFor(60_000);
  expect(await snapshotCalls(page)).toBe(before);
  await setVisible(page, true);
  await expect.poll(() => snapshotCalls(page)).toBeGreaterThan(before);
  expect(await snapshotCalls(page)).toBe(before + 10);
});

test('polling stops on the server terminal too', async ({ page }) => {
  await open(page);
  await expect(row(page, 'api-1')).toBeVisible();
  await page.getByRole('tab', { name: '서버 터미널', exact: true }).click();
  await page.clock.runFor(1000);
  const before = await snapshotCalls(page);
  await page.clock.runFor(60_000);
  expect(await snapshotCalls(page)).toBe(before);
});

test('every snapshot call carries the settings and one request per kind runs', async ({ page }) => {
  await open(page);
  await expect(row(page, 'api-1')).toBeVisible();
  const calls = await page.evaluate(() =>
    window.__kube.calls.filter((c) => c.command === 'kube_snapshot'),
  );
  expect(new Set(calls.map((c) => c.args.kind)).size).toBe(calls.length);
  expect(calls[0].args.kube).toEqual(saved);
  expect(calls[0].args.id).toBe('connection');
});

test('nothing is polled before the setup is finished', async ({ page }) => {
  await page.addInitScript(
    ({ detection }) => {
      window.__kube = {
        detections: [detection],
        persist: true,
        copyResult: { typed: 'wait' },
        calls: [],
        copied: [],
        terminals: [],
      };
    },
    { detection: { ...detection, saved: null } },
  );
  await page.goto('/tests/ui/fixtures/kube-workspace.html');
  await expect(page.getByLabel('context', { exact: true })).toBeVisible();
  expect(await snapshotCalls(page)).toBe(0);
});
