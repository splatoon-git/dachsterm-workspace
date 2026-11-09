// KV.2 and KV.3 acceptance against the real app, a real OpenSSH server and a real kind cluster:
// services and pods with their resources, polling that stops when the screen is hidden, data that
// stays with its age when the cluster goes away, and the dashboard. `--dashboard` runs only the
// dashboard's stages. Never print the fixture's passwords.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchNativeApp } from './lib/native-app.mjs';
import { docker, kubeFixture, kubeScreen } from './lib/kube-native.mjs';

const clusterArg = process.argv.find((arg) => arg.startsWith('--cluster='));
const cluster = clusterArg ? clusterArg.slice('--cluster='.length) : 'dachsterm-kv2';
const keep = process.argv.includes('--keep');
const dashboardOnly = process.argv.includes('--dashboard');
const executable = process.env.DACHSTERM_TEST_BINARY ?? 'target/debug/dachsterm.exe';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pass = (text) => console.log(`PASS ${text}`);
const fixture = (action) => kubeFixture(cluster, action);
const LOG = '/tmp/kubectl.log';
const namespace = 'kv2-tree';
/** Thrown after the dashboard's stages to end a `--dashboard` run through the normal clean-up. */
class ChecksDone extends Error {}

const manifest = `
apiVersion: v1
kind: Namespace
metadata: { name: ${namespace} }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: api, namespace: ${namespace} }
spec:
  replicas: 2
  selector: { matchLabels: { app: api } }
  template:
    metadata: { labels: { app: api } }
    spec:
      containers:
        - name: app
          image: registry.k8s.io/pause:3.9
          resources:
            requests: { cpu: 25m, memory: 16Mi }
            limits: { cpu: 50m, memory: 32Mi }
---
apiVersion: v1
kind: Service
metadata: { name: api, namespace: ${namespace} }
spec:
  selector: { app: api }
  ports: [{ port: 80 }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: batch, namespace: ${namespace} }
spec:
  replicas: 1
  selector: { matchLabels: { app: batch } }
  template:
    metadata: { labels: { app: batch } }
    spec:
      containers:
        - name: app
          image: registry.k8s.io/pause:3.9
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: broken, namespace: ${namespace} }
spec:
  replicas: 1
  selector: { matchLabels: { app: broken } }
  template:
    metadata: { labels: { app: broken } }
    spec:
      containers:
        - name: app
          image: registry.k8s.io/e2e-test-images/busybox:1.29-4
          command: ['false']
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: oom, namespace: ${namespace} }
spec:
  replicas: 1
  selector: { matchLabels: { app: oom } }
  template:
    metadata: { labels: { app: oom } }
    spec:
      containers:
        - name: app
          image: registry.k8s.io/e2e-test-images/busybox:1.29-4
          command: ['sh', '-c', 'x=aaaaaaaa; while true; do x=$x$x; done']
          resources:
            requests: { memory: 8Mi }
            limits: { memory: 16Mi }
`;

let stage = 'fixture';
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-kube-tree-'));
const env = fixture('up');
const container = env.SSH_CONTAINER;
const controlPlane = `${cluster}-control-plane`;
const inServer = (script) => docker(['exec', container, 'sh', '-c', script]);
let app;
let failed = false;
let paused = false;

/**
 * Writes one line when each kubectl starts and ends, so the server is the witness. Docker's VM
 * steps its wall clock about every 30 seconds, so the times come from the uptime counter.
 */
function watchKubectl() {
  inServer(`
    k=/opt/kube/bin/kubectl
    [ -e "$k.real" ] || mv "$k" "$k.real"
    cat > "$k" <<'SH'
#!/bin/sh
log=${LOG}
what=$(printf '%s ' "$@" | grep -oE '(get|top) [a-z,]+' | head -1)
printf '%s start %s %s\\n' "$(cut -d' ' -f1 /proc/uptime)" "$$" "$what" >> "$log"
/opt/kube/bin/kubectl.real "$@"
code=$?
printf '%s end %s %s\\n' "$(cut -d' ' -f1 /proc/uptime)" "$$" "$what" >> "$log"
exit $code
SH
    chmod 755 "$k"
    : > ${LOG}
    chmod 666 ${LOG}
  `);
}
function kubectlLog() {
  return inServer(`cat ${LOG}`)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [time, event, pid, ...what] = line.split(' ');
      return { time: Number(time), event, pid, what: what.join(' ').trim() };
    });
}
const logSize = () => Number(inServer(`wc -l < ${LOG}`));

try {
  stage = 'cluster objects';
  fixture('metrics-off');
  inServer('/opt/kube/bin/kubectl --kubeconfig /opt/kube/config version --client >/dev/null');
  const applied = docker([
    'exec',
    container,
    'sh',
    '-c',
    `cat > /tmp/kv2.yaml <<'YAML'\n${manifest}\nYAML\n/opt/kube/bin/kubectl --kubeconfig /opt/kube/config apply -f /tmp/kv2.yaml`,
  ]);
  assert(applied.includes('deployment.apps/api'), 'the manifest applied');
  for (const name of ['api', 'batch'])
    inServer(
      `/opt/kube/bin/kubectl --kubeconfig /opt/kube/config -n ${namespace} rollout status deployment/${name} --timeout=180s`,
    );
  watchKubectl();

  stage = 'launch';
  app = await launchNativeApp({ executable, directory });
  const { page } = app;
  page.setDefaultTimeout(20_000);
  await expect(page.getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
  const screen = kubeScreen(page, Number(env.SSH_PORT));
  const { pane, header, addSession, connect } = screen;
  const password = inServer('cat /run/probe/password');

  stage = 'open the tree';
  await addSession('kube-other', 'probe', undefined);
  await addSession('kube-tree', 'probe', 'kubernetes');
  await connect('kube-tree', password);
  await pane().getByLabel('context', { exact: true }).selectOption(`kind-${cluster}`);
  await pane().getByRole('button', { name: '시작', exact: true }).click();
  const tree = () => pane().getByRole('tree', { name: '클러스터 트리' });
  const row = (name) =>
    tree()
      .getByRole('treeitem')
      .filter({ has: page.getByText(name, { exact: true }) })
      .first();
  const podRow = (prefix) =>
    tree()
      .getByRole('treeitem')
      .filter({ has: page.getByText(new RegExp(`^${prefix}-[a-z0-9-]+$`)) })
      .first();
  await expect(tree()).toBeVisible();
  await expect(pane().getByLabel('묶기', { exact: true })).toHaveValue('workload');
  await expect(row('노드')).toContainText('1/1 준비', { timeout: 40_000 });
  await expect(row('Deployment/api')).toContainText('준비 2/2', { timeout: 40_000 });

  stage = 'dashboard without metrics-server';
  const dashboardTab = () => header().getByRole('tab', { name: '대시보드', exact: true });
  const area = (name) => pane().getByRole('region', { name, exact: true });
  const areaRow = (name, text) => area(name).getByRole('button').filter({ hasText: text }).first();
  await dashboardTab().click();
  await expect(area('전체 자원')).toContainText('metrics-server가 없어', { timeout: 40_000 });
  await expect(area('전체 자원')).toContainText(/요청 \d/);
  await expect(area('전체 자원')).toContainText('할당');
  await expect(area('전체 자원')).not.toContainText(/사용 \d/);
  await expect(area('현황')).toContainText('1/1 준비');
  await expect(area('자원 상위')).toContainText('요청량 기준입니다.');
  await expect(area('인그레스')).toContainText('아직 준비 중입니다.');
  await expect(area('워커')).toContainText('아직 준비 중입니다.');
  await page.screenshot({
    path: path.resolve('test-results-native', 'kube-dashboard-requests.png'),
  });
  pass('without metrics-server the dashboard shows requests and allocatable and says why');

  stage = 'dashboard with live usage';
  fixture('metrics-on');
  await expect(area('전체 자원')).toContainText(/사용 \d/, { timeout: 150_000 });
  await expect(area('전체 자원').getByRole('img', { name: /CPU 추세/ })).toBeVisible();
  await expect(area('자원 상위')).not.toContainText('요청량 기준입니다.', { timeout: 40_000 });
  await expect(area('자원 상위').locator('.kube-dash-row').first()).toContainText(/\d/, {
    timeout: 40_000,
  });
  pass('live usage, the trend and the top pods replace requests once metrics-server answers');

  stage = 'dashboard restarts and errors';
  await expect(areaRow('재시작·에러', 'broken-')).toContainText('Error (종료 코드 1)', {
    timeout: 120_000,
  });
  await expect(areaRow('재시작·에러', 'oom-')).toContainText('OOMKilled (종료 코드 137)', {
    timeout: 120_000,
  });
  await expect(areaRow('미달 워크로드', 'Deployment/broken')).toContainText('0/1 준비', {
    timeout: 40_000,
  });
  await expect(area('최근 경고')).toContainText('BackOff', { timeout: 40_000 });
  // Back-off doubles up to five minutes, so the next restart can be that far away.
  await expect(areaRow('재시작·에러', 'broken-')).toContainText(/\+\d+/, { timeout: 330_000 });
  await page.screenshot({ path: path.resolve('test-results-native', 'kube-dashboard-live.png') });
  pass('a crash and an OOM kill show their reason, exit code and increase since the tab opened');

  stage = 'dashboard items go to the tree';
  const treeTab = () => header().getByRole('tab', { name: '트리', exact: true });
  await areaRow('재시작·에러', 'broken-').click();
  await expect(treeTab()).toHaveAttribute('aria-selected', 'true');
  await expect(podRow('broken')).toHaveAttribute('aria-selected', 'true');
  await dashboardTab().click();
  await areaRow('미달 워크로드', 'Deployment/broken').click();
  await expect(row('Deployment/broken')).toHaveAttribute('aria-selected', 'true');
  await dashboardTab().click();
  await area('전체 자원')
    .getByRole('button', { name: new RegExp(controlPlane) })
    .click();
  await expect(row(controlPlane)).toHaveAttribute('aria-selected', 'true');
  await row('노드').locator('.kube-tree-fold').click();
  pass('a pod, a workload and a node on the dashboard each go to their row in the tree');

  stage = 'dashboard adds no query';
  await dashboardTab().click();
  await sleep(1500);
  const beforeDashboard = logSize();
  await sleep(17_000);
  const whileOpen = kubectlLog().slice(beforeDashboard);
  const polled = new Set([
    'get pods',
    'get deployments,statefulsets,daemonsets',
    'get services,endpoints',
    'get nodes',
    'top pods',
    'top nodes',
    'get events',
    'get persistentvolumeclaims',
    'get jobs',
    'get horizontalpodautoscalers',
  ]);
  const extra = whileOpen.filter((entry) => entry.what && !polled.has(entry.what));
  assert.deepEqual(extra, [], 'the dashboard ran only the kinds the tree polls');
  const podRuns = whileOpen.filter((e) => e.event === 'start' && e.what === 'get pods');
  const podGaps = podRuns.slice(1).map((entry, at) => entry.time - podRuns[at].time);
  assert(podGaps.length >= 2, 'pods kept being polled');
  assert(Math.min(...podGaps) >= 4.5, `pods wait about 5 seconds, gap ${Math.min(...podGaps)}`);
  await treeTab().click();
  pass('the server saw only the polled kinds, at the same pace, while the dashboard was open');

  if (dashboardOnly) throw new ChecksDone();
  fixture('metrics-off');
  await expect(pane().getByText('파드 사용량: metrics-server 없음')).toBeVisible({
    timeout: 60_000,
  });

  await pane().getByLabel('묶기', { exact: true }).selectOption('service');

  stage = 'services, pods and requests without metrics-server';
  await expect(row(namespace)).toBeVisible({ timeout: 40_000 });
  await expect(row('api')).toContainText('ClusterIP');
  await expect(row('api')).toContainText('2/2');
  await expect(podRow('api')).toContainText('Running');
  await expect(podRow('api')).toContainText('25m / 50m');
  await expect(podRow('api')).toContainText('16Mi / 32Mi');
  await expect(row('서비스 없음').first()).toBeVisible();
  await expect(podRow('batch')).toBeVisible();
  await expect(pane().getByText('파드 사용량: metrics-server 없음')).toBeVisible({
    timeout: 40_000,
  });
  await page.screenshot({ path: path.join(directory, 'tree-requests.png') });
  pass('services and pods are shown with requests and limits when there is no metrics-server');

  stage = 'live usage';
  fixture('metrics-on');
  await expect(pane().getByText('CPU', { exact: true })).toBeVisible({ timeout: 150_000 });
  // The cells' text runs together, so the CPU column is read on its own.
  await expect(podRow('api').locator(':scope > span').nth(4)).toHaveText(/^\d+m$/, {
    timeout: 40_000,
  });
  await expect(podRow('api')).not.toContainText('25m / 50m');
  // The pause image really uses nothing; system pods show that non-zero use reaches the rows.
  await expect(row('kube-dns')).toContainText(/\d+m/, { timeout: 40_000 });
  await expect(row('kube-dns')).toContainText(/\d+(\.\d)?Mi/, { timeout: 40_000 });
  await expect(row('kube-dns')).toContainText('엔드포인트 준비 2/2');
  pass('live CPU and memory replace them once metrics-server answers');

  stage = 'a crash loop';
  await expect(podRow('broken')).toContainText(/CrashLoopBackOff|Error/, { timeout: 90_000 });
  await pane().getByRole('checkbox', { name: '문제만' }).check();
  await expect(podRow('broken')).toBeVisible();
  await expect(podRow('api')).toHaveCount(0);
  await pane().getByRole('checkbox', { name: '문제만' }).uncheck();
  pass('a crash loop is shown and kept by the problems filter');

  stage = 'grouping and filter';
  await pane().getByLabel('묶기', { exact: true }).selectOption('workload');
  await expect(row('Deployment/api')).toContainText('2/2');
  await expect(podRow('api')).toContainText(controlPlane);
  await row('노드').locator('.kube-tree-fold').click();
  await expect(row(controlPlane)).toContainText('파드');
  await expect(row(controlPlane)).toContainText('Ready');
  await row('노드').locator('.kube-tree-fold').click();
  await tree().focus();
  await page.keyboard.press('g');
  await expect(pane().getByLabel('묶기', { exact: true })).toHaveValue('service');
  await page.keyboard.press('g');
  await expect(pane().getByLabel('묶기', { exact: true })).toHaveValue('node');
  await expect(row(controlPlane)).toContainText('Ready');
  await pane().getByLabel('파드 필터', { exact: true }).fill('api !batch');
  await expect(podRow('batch')).toHaveCount(0);
  await expect(podRow('api')).toBeVisible();
  await pane().getByLabel('파드 필터', { exact: true }).fill('');
  await pane().getByLabel('묶기', { exact: true }).selectOption('service');
  pass('every grouping and the filter work on real data');

  stage = 'polling measured on the server';
  await sleep(21_000);
  const log = kubectlLog();
  const concurrent = () => {
    let running = 0;
    let peak = 0;
    // Only the app's polling: this script's own kubectl calls have no `get` or `top` to name.
    for (const entry of log.filter((e) => e.what)) {
      running += entry.event === 'start' ? 1 : -1;
      peak = Math.max(peak, running);
    }
    return peak;
  };
  assert(concurrent() <= 3, `at most 3 kubectl at once, saw ${concurrent()}`);
  const podStarts = log.filter((e) => e.event === 'start' && e.what === 'get pods');
  const gaps = podStarts.slice(1).map((entry, at) => entry.time - podStarts[at].time);
  assert(gaps.length >= 3, 'pods were polled repeatedly');
  assert(Math.min(...gaps) >= 4.5, `pods wait about 5 seconds, smallest gap ${Math.min(...gaps)}`);
  const inFlightPerKind = (kind) => {
    let open = 0;
    for (const entry of log.filter((e) => e.what === kind)) {
      open += entry.event === 'start' ? 1 : -1;
      assert(open <= 1, `one ${kind} at a time`);
    }
  };
  ['get pods', 'get nodes', 'top pods', 'top nodes'].forEach(inFlightPerKind);
  console.log(
    `MEASURE polling: ${log.length / 2} kubectl runs, peak ${concurrent()} at once, pod gaps ${gaps.map((g) => g.toFixed(1)).join(', ')} s`,
  );
  pass('the server saw at most 3 kubectl at once and pods spaced by 5 seconds');

  stage = 'hidden screen stops polling';
  await header().getByRole('tab', { name: '서버 터미널', exact: true }).click();
  await sleep(1500);
  const hiddenAt = logSize();
  await sleep(11_000);
  assert.equal(logSize(), hiddenAt, 'no kubectl ran while the server terminal was showing');
  await header().getByRole('tab', { name: '트리', exact: true }).click();
  await expect.poll(logSize, { timeout: 3000 }).toBeGreaterThan(hiddenAt);
  pass('polling stops on the server terminal and refreshes at once when the tree returns');

  stage = 'another tab stops polling';
  await header().getByRole('tab', { name: '트리', exact: true }).click();
  const sessionTab = page
    .locator('.session-tab')
    .filter({ hasText: 'kube-tree' })
    .locator('[role="tab"]')
    .first();
  await connect('kube-other', password);
  await sleep(1500);
  const before = logSize();
  await sleep(11_000);
  assert.equal(logSize(), before, 'no kubectl ran while another tab was showing');
  await sessionTab.click();
  await expect.poll(logSize, { timeout: 3000 }).toBeGreaterThan(before);
  pass('polling stops while another tab is showing and refreshes when it returns');

  stage = 'cluster stops answering';
  await header().getByRole('tab', { name: '트리', exact: true }).click();
  await expect(podRow('api')).toBeVisible();
  docker(['pause', controlPlane]);
  paused = true;
  await expect(header().locator('em')).toBeVisible({ timeout: 40_000 });
  const warning = await header().locator('em').innerText();
  assert.match(warning, /연결 불가|시간 초과/);
  await expect(podRow('api')).toBeVisible();
  await expect(pane().getByText(/마지막으로 받은 데이터입니다/)).toBeVisible();
  const age = async () => Number((await header().innerText()).match(/(\d+)초 전/)?.[1] ?? -1);
  const first = await age();
  assert(first >= 0, 'the age is shown');
  await sleep(4000);
  const later = await age();
  assert(later >= first + 3, `the age grows while it is stale (${first} -> ${later})`);
  await page.screenshot({ path: path.join(directory, 'tree-stale.png') });
  pass(`a cluster that stops answering keeps the data and its growing age (${warning})`);

  stage = 'cluster answers again';
  docker(['unpause', controlPlane]);
  paused = false;
  await expect(header().locator('em')).toHaveCount(0, { timeout: 120_000 });
  await expect(pane().getByText(/마지막으로 받은 데이터입니다/)).toHaveCount(0);
  await expect.poll(age, { timeout: 15_000 }).toBeLessThan(20);
  pass('the tree refreshes by itself once the cluster answers again');
} catch (error) {
  if (!(error instanceof ChecksDone)) {
    failed = true;
    console.error(`FAILED at: ${stage}`);
    console.error(error instanceof assert.AssertionError ? error.message : error.constructor.name);
    try {
      await app?.page.screenshot({
        path: path.resolve('test-results-native', 'kube-tree-failure.png'),
      });
    } catch {
      // The window may already be gone; the stage name above is still reported.
    }
  }
} finally {
  try {
    inServer('k=/opt/kube/bin/kubectl; [ -e "$k.real" ] && mv -f "$k.real" "$k"; true');
  } catch {
    // The container may be gone; it is created again with the real kubectl.
  }
  if (paused) {
    try {
      docker(['unpause', controlPlane]);
    } catch {
      // The fixture is removed below unless --keep was asked for; the failure is already reported.
    }
  }
  await app?.stop();
  await sleep(200);
  await rm(directory, { recursive: true, force: true }).catch(() => {});
  if (!keep) fixture('down');
}
process.exit(failed ? 1 : 0);
