// KV.9 acceptance against the real app, a real OpenSSH server and a real kind cluster: workers that
// never return turn into a "suspected" verdict on the tree row and the dashboard, a healthy workload
// stays clean, /metrics candidates that do not answer read as "no metrics", and an image with no
// shell and an account with no pods/exec each say so. Never print the fixture's passwords.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchNativeApp } from './lib/native-app.mjs';
import { docker, kubeFixture, kubeScreen } from './lib/kube-native.mjs';

const clusterArg = process.argv.find((arg) => arg.startsWith('--cluster='));
const cluster = clusterArg ? clusterArg.slice('--cluster='.length) : 'dachsterm-kv9';
const keep = process.argv.includes('--keep');
// Runs only the stage for a workload watched by the probe alone.
const onlyProbeRepeat = process.argv.includes('--only-probe-repeat');
const executable = process.env.DACHSTERM_TEST_BINARY ?? 'target/debug/dachsterm.exe';
const pass = (text) => console.log(`PASS ${text}`);
const fixture = (action) => kubeFixture(cluster, action);
const namespace = 'kv9-workers';
const BUSYBOX = 'busybox:1.36';

const metricsBody = (busy, total, completed) =>
  `# TYPE worker_busy gauge\\nworker_busy ${busy}\\nworker_total ${total}\\nrequests_completed_total ${completed}\\ngo_goroutines 7\\n`;

// Workers taken and never given back: the numbers do not move.
const stuckCommand = `mkdir -p /www; printf '${metricsBody(8, 8, 1234)}' > /www/metrics; exec httpd -f -p 8080 -h /www`;
// Work keeps completing.
const healthyCommand = `mkdir -p /www; i=1000; while true; do i=$((i+3)); printf "${metricsBody(2, 8, '$i')}" > /www/metrics.new; mv /www/metrics.new /www/metrics; sleep 5; done & exec httpd -f -p 8080 -h /www`;
// 8081 answers 404, 9999 refuses, and the real metrics are on a port the spec does not declare.
const undeclaredCommand = `mkdir -p /www /empty; printf '${metricsBody(1, 4, 9)}' > /www/metrics; httpd -p 8081 -h /empty; exec httpd -f -p 8082 -h /www`;

const manifest = `
apiVersion: v1
kind: Namespace
metadata: { name: ${namespace} }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: stuck, namespace: ${namespace} }
spec:
  replicas: 1
  selector: { matchLabels: { app: stuck } }
  template:
    metadata:
      labels: { app: stuck }
      annotations: { prometheus.io/scrape: "true", prometheus.io/port: "8080" }
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - name: app
          image: ${BUSYBOX}
          command: ['sh', '-c', ${JSON.stringify(stuckCommand)}]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: healthy, namespace: ${namespace} }
spec:
  replicas: 1
  selector: { matchLabels: { app: healthy } }
  template:
    metadata: { labels: { app: healthy } }
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - name: app
          image: ${BUSYBOX}
          ports: [{ containerPort: 8080 }]
          command: ['sh', '-c', ${JSON.stringify(healthyCommand)}]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: undeclared, namespace: ${namespace} }
spec:
  replicas: 1
  selector: { matchLabels: { app: undeclared } }
  template:
    metadata: { labels: { app: undeclared } }
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - name: app
          image: ${BUSYBOX}
          ports: [{ containerPort: 8081 }, { containerPort: 9999 }]
          command: ['sh', '-c', ${JSON.stringify(undeclaredCommand)}]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: noshell, namespace: ${namespace} }
spec:
  replicas: 1
  selector: { matchLabels: { app: noshell } }
  template:
    metadata: { labels: { app: noshell } }
    spec:
      containers:
        - { name: app, image: registry.k8s.io/pause:3.10 }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: limited, namespace: ${namespace} }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: kv9-limited }
rules:
  - apiGroups: ['', 'apps']
    resources: [namespaces, nodes, pods, pods/log, pods/proxy, services, endpoints, events, deployments, replicasets, statefulsets, daemonsets]
    verbs: [get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: kv9-limited }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: kv9-limited }
subjects: [{ kind: ServiceAccount, name: limited, namespace: ${namespace} }]
`;

let stage = 'fixture';
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-kube-workers-'));
const env = fixture('up');
const container = env.SSH_CONTAINER;
const inServer = (script) => docker(['exec', container, 'sh', '-c', script]);
const K = '/opt/kube/bin/kubectl --kubeconfig /opt/kube/config';
const context = `kind-${cluster}`;
let app;
let failed = false;

try {
  stage = 'cluster objects';
  docker([
    'exec',
    container,
    'sh',
    '-c',
    `cat > /tmp/kv9.yaml <<'YAML'\n${manifest}\nYAML\n${K} apply -f /tmp/kv9.yaml`,
  ]);
  for (const name of ['stuck', 'healthy', 'undeclared', 'noshell'])
    inServer(`${K} -n ${namespace} rollout status deployment/${name} --timeout=180s`);

  stage = 'launch';
  app = await launchNativeApp({ executable, directory });
  const { page } = app;
  page.setDefaultTimeout(20_000);
  await expect(page.getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
  const { pane, header, addSession, connect } = kubeScreen(page, Number(env.SSH_PORT));
  const password = inServer('cat /run/probe/password');

  stage = 'open the tree';
  await addSession('kube-workers', 'probe', 'kubernetes');
  await connect('kube-workers', password);
  await pane().getByLabel('context', { exact: true }).selectOption(context);
  await pane().getByLabel('namespace', { exact: true }).selectOption(namespace);
  await pane().getByRole('button', { name: '시작', exact: true }).click();

  const tree = () => pane().getByRole('tree', { name: '클러스터 트리' });
  const panel = () => pane().locator('.kube-panel');
  const namedPod = (prefix) =>
    tree()
      .getByRole('treeitem')
      .filter({ has: page.getByText(new RegExp(`^${prefix}-[a-z0-9]+-[a-z0-9]+$`)) })
      .first();
  const workloadCell = (name) =>
    tree()
      .getByRole('treeitem')
      .filter({ has: page.getByText(`Deployment/${name}`, { exact: true }) })
      .first()
      .locator('.kube-worker-cell');
  await expect(namedPod('stuck')).toContainText('Running', { timeout: 40_000 });
  await expect(namedPod('noshell')).toContainText('Running');

  const openRuntime = async (prefix) => {
    await page.keyboard.press('Escape');
    await namedPod(prefix).click({ button: 'right' });
    await page
      .getByRole('menu', { name: '파드 메뉴' })
      .getByRole('menuitem', { name: '런타임' })
      .click();
    await expect(panel().getByRole('tab', { name: '런타임', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  };
  const candidates = () => panel().getByRole('list', { name: '메트릭 후보' });
  const metricRow = (name) =>
    panel().getByRole('list', { name: '메트릭 목록' }).getByRole('button', { name });
  const assign = async (metric, role) => {
    await metricRow(metric).click({ button: 'right' });
    await page
      .getByRole('menu', { name: '메트릭 메뉴' })
      .getByRole('menuitem', { name: role })
      .click();
  };
  const watchWorkers = async () => {
    await assign(/^worker_busy/, '사용 중(으)로 지정');
    await assign(/^worker_total/, '전체(으)로 지정');
    await assign(/^requests_completed_total/, '완료 수(으)로 지정');
    await panel().getByLabel('판정 기준(분)').fill('1');
    await panel().getByRole('button', { name: '워커 감시 켜기', exact: true }).click();
    await expect(panel().getByRole('button', { name: '감시 끄기', exact: true })).toBeVisible();
  };

  if (!onlyProbeRepeat) {
    stage = 'metrics found through an annotation and watched';
    await openRuntime('stuck');
    await expect(candidates()).toContainText('지표 4개');
    await expect(candidates()).toContainText('annotation');
    await expect(metricRow(/^worker_busy/)).toBeVisible();
    assert.equal(await metricRow(/^go_goroutines/).count(), 0, 'runtime internals are left out');
    await watchWorkers();
    await expect(workloadCell('stuck')).toHaveText('사용 8/8', { timeout: 30_000 });
    pass('the annotated port is found, roles are assigned by the row menu, and the tree row fills');

    stage = 'container threads from the kubelet';
    const threadsTable = panel().locator('h3:has-text("컨테이너 스레드") + table');
    await expect(threadsTable).toContainText('app', { timeout: 30_000 });
    pass("container_threads reads the named container from the pod's own node");

    stage = 'a healthy workload is watched alongside';
    await openRuntime('healthy');
    await expect(candidates()).toContainText('지표 4개');
    await expect(metricRow(/^worker_busy/)).toBeVisible();
    await watchWorkers();
    await expect(workloadCell('healthy')).toHaveText('사용 2/8', { timeout: 30_000 });
    pass('a declared containerPort is a candidate too');

    stage = 'workers that never return are suspected';
    await expect(workloadCell('stuck')).toContainText('의심', { timeout: 120_000 });
    await expect(workloadCell('stuck')).toContainText('사용 8/8');
    await expect(workloadCell('stuck')).toHaveAttribute('title', /반환 안 됨 의심/);
    await expect(workloadCell('healthy')).toHaveText('사용 2/8');
    await page.screenshot({ path: path.join(directory, 'tree-suspect.png') });
    pass('completed staying flat for the window gives a suspected verdict on the tree row');

    stage = 'the dashboard shows the same';
    await header().getByRole('tab', { name: '대시보드', exact: true }).click();
    const board = pane().getByRole('region', { name: '워커' });
    await expect(board).toContainText('Deployment/stuck');
    await expect(board).toContainText('반환 안 됨 의심');
    await expect(board).toContainText('워커 포화 의심');
    await expect(board).toContainText('Deployment/healthy');
    await expect(board).toContainText('이상 없음');
    await page.screenshot({ path: path.join(directory, 'dashboard.png') });
    await board.getByRole('button', { name: /stuck-.*반환 안 됨/ }).click();
    await expect(panel().getByRole('tab', { name: '런타임', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(tree()).toBeVisible();
    pass("the dashboard lists the verdict and leads to that pod's runtime tab");

    stage = 'a probe asks once, then reads the pod';
    await panel().getByRole('button', { name: '수집', exact: true }).click();
    const consent = page.getByRole('dialog', { name: '런타임 읽기' });
    await expect(consent).toContainText('파드 안에서 읽기 명령을 실행합니다');
    await consent.getByRole('button', { name: '실행', exact: true }).click();
    await expect(panel().getByRole('heading', { name: '프로세스·워커' })).toBeVisible();
    await expect(panel().locator('.kube-table').filter({ hasText: 'httpd' }).first()).toBeVisible();
    await expect(panel()).toContainText('8080');
    await expect(panel()).toContainText('ESTABLISHED');
    await panel().getByRole('button', { name: '수집', exact: true }).click();
    await expect(consent).toHaveCount(0);
    pass('the probe confirms once per workload and shows processes, ports and connections');

    stage = 'candidates that do not answer, and a port typed by hand';
    await openRuntime('undeclared');
    await expect(candidates()).toContainText('메트릭 없음 (404)');
    await expect(candidates()).toContainText('메트릭 없음 (연결 거부)');
    await panel().getByLabel('메트릭 포트').fill('8082');
    await panel().getByRole('button', { name: '읽기', exact: true }).click();
    await expect(metricRow(/^worker_busy/)).toBeVisible();
    await expect(panel().getByRole('alert')).toHaveCount(0);
    pass('404 and connection refused read as no metrics, and an undeclared port can be typed');
  }

  stage = 'a workload watched by the probe alone';
  await openRuntime('undeclared');
  await panel().getByRole('checkbox', { name: '프로브도 30초마다 반복' }).check();
  await panel().getByRole('button', { name: '워커 감시 켜기', exact: true }).click();
  await page
    .getByRole('dialog', { name: '런타임 읽기' })
    .getByRole('button', { name: '실행', exact: true })
    .click();
  await expect(workloadCell('undeclared')).toHaveText(/^프로세스 \d+$/, { timeout: 30_000 });
  pass('a workload with no metrics can be watched by the repeating probe alone');

  if (!onlyProbeRepeat) {
    stage = 'an image with no shell';
    await openRuntime('noshell');
    await panel().getByRole('button', { name: '수집', exact: true }).click();
    const noShellConsent = page.getByRole('dialog', { name: '런타임 읽기' });
    await noShellConsent.getByRole('button', { name: '실행', exact: true }).click();
    await expect(panel().getByText('이 컨테이너에서는 읽을 수 없음')).toBeVisible();
    await page.screenshot({ path: path.join(directory, 'no-shell.png') });
    pass('a container with no sh says it cannot be read');

    stage = 'an account with no pods/exec or nodes/proxy';
    inServer(
      `token=$(${K} -n ${namespace} create token limited --duration=1h); ` +
        `${K} config set-credentials limited --token="$token" >/dev/null; ` +
        `${K} config set-context ${context} --user=limited >/dev/null`,
    );
    await openRuntime('stuck');
    await expect(panel().getByText(/nodes\/proxy 권한이 없어/)).toBeVisible({ timeout: 30_000 });
    await panel().getByRole('button', { name: '수집', exact: true }).click();
    await expect(panel().getByText('pods/exec 권한이 없어 읽을 수 없음')).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({ path: path.join(directory, 'no-exec.png') });
    pass('without pods/exec or nodes/proxy the tab says exactly that and nothing else changes');
  }
} catch (error) {
  failed = true;
  console.error(`FAILED at: ${stage}`);
  console.error(error instanceof assert.AssertionError ? error.message : error.constructor.name);
  console.error(String(error?.message ?? '').slice(0, 800));
  try {
    await app?.page.screenshot({
      path: path.resolve('test-results-native', 'kube-workers-failure.png'),
    });
  } catch {
    // The window may already be gone; the stage name above is still reported.
  }
} finally {
  await app?.stop();
  await rm(directory, { recursive: true, force: true }).catch(() => {});
  // A kept cluster must not stay on the restricted account, whichever stage stopped the run.
  try {
    inServer(`${K} config set-context ${context} --user=${context} >/dev/null`);
  } catch {
    // The cluster may never have come up; nothing to put back then.
  }
  if (!keep) fixture('down');
}
process.exit(failed ? 1 : 0);
