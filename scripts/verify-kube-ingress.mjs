// KV.8 acceptance against the real app, a real OpenSSH server and a real kind cluster with
// ingress-nginx: backends that are down, metrics off and on, per-host status shares, and an
// account without pods/proxy. Never print the fixture's passwords or the limited account's token.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchNativeApp } from './lib/native-app.mjs';
import { docker, kubeFixture, kubeScreen } from './lib/kube-native.mjs';

const clusterArg = process.argv.find((arg) => arg.startsWith('--cluster='));
const cluster = clusterArg ? clusterArg.slice('--cluster='.length) : 'dachsterm-kv8';
const keep = process.argv.includes('--keep');
const executable = process.env.DACHSTERM_TEST_BINARY ?? 'target/debug/dachsterm.exe';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pass = (text) => console.log(`PASS ${text}`);
const fixture = (action) => kubeFixture(cluster, action);
const namespace = 'kv8-ingress';
const BUSYBOX = 'busybox:1.36';
// A poll is every 30 seconds, and a rollout's new pod has to answer before one can see it.
const NEXT_POLL = 75_000;

// busybox httpd passes a CGI's status line through when it starts with HTTP.
const SERVER = [
  'mkdir -p /www/cgi-bin',
  'echo hello > /www/index.html',
  `printf '#!/bin/sh\\nprintf "HTTP/1.1 500 Internal Server Error\\\\r\\\\n\\\\r\\\\nfail\\\\n"\\n' > /www/cgi-bin/fail`,
  'chmod +x /www/cgi-bin/fail',
  'exec httpd -f -p 8080 -h /www',
].join('; ');

const route = (name, host, service, tls = '') => `
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: ${name}, namespace: ${namespace} }
spec:
  ingressClassName: nginx${tls}
  rules:
    - host: ${host}
      http:
        paths:
          - { path: /, pathType: Prefix, backend: { service: { name: ${service}, port: { number: 80 } } } }
`;

const service = (name) => `
apiVersion: v1
kind: Service
metadata: { name: ${name}, namespace: ${namespace} }
spec:
  selector: { app: ${name} }
  ports: [{ port: 80, targetPort: 8080 }]
`;

const manifest = `
apiVersion: v1
kind: Namespace
metadata: { name: ${namespace} }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: ${namespace} }
spec:
  replicas: 1
  selector: { matchLabels: { app: web } }
  template:
    metadata:
      labels: { app: web }
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - name: main
          image: ${BUSYBOX}
          command: ['sh', '-c', ${JSON.stringify(SERVER)}]
---
${service('web')}
---
${service('down')}
---
${route('front', 'ok.local', 'web')}
---
${route('stopped', 'dead.local', 'down')}
---
${route('nothing', 'ghost.local', 'nowhere')}
---
${route(
  'secure',
  'tls.local',
  'web',
  `
  tls:
    - hosts: [tls.local]
      secretName: no-such-cert`,
)}
`;

// Everything the screens read, and on purpose not pods/proxy.
const limitedAccount = `
apiVersion: v1
kind: ServiceAccount
metadata: { name: kv8-limited, namespace: default }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: kv8-limited }
rules:
  - apiGroups: ['']
    resources: [namespaces, nodes, pods, services, endpoints, events, secrets]
    verbs: [get, list]
  - apiGroups: [apps]
    resources: [deployments, statefulsets, daemonsets]
    verbs: [get, list]
  - apiGroups: [networking.k8s.io]
    resources: [ingresses]
    verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: kv8-limited }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: kv8-limited }
subjects: [{ kind: ServiceAccount, name: kv8-limited, namespace: default }]
`;

let stage = 'fixture';
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-kube-ingress-'));
const env = fixture('up');
fixture('ingress-up');
fixture('ingress-metrics-off');
const container = env.SSH_CONTAINER;
const inServer = (script) => docker(['exec', container, 'sh', '-c', script]);
const K = '/opt/kube/bin/kubectl --kubeconfig /opt/kube/config';
let app;
let failed = false;

async function applyManifest() {
  // The controller's admission webhook takes a few seconds to answer after a rollout.
  for (let at = 0; ; at++) {
    try {
      inServer(`cat > /tmp/kv8.yaml <<'YAML'\n${manifest}\nYAML\n${K} apply -f /tmp/kv8.yaml`);
      return;
    } catch (error) {
      if (at === 20) throw error;
      await sleep(3000);
    }
  }
}

const webPod = () =>
  inServer(`${K} -n ${namespace} get pods -l app=web -o jsonpath='{.items[0].metadata.name}'`);

/** Sent from inside the cluster to the controller's Service, with the host in the header. */
function send(host, target, count) {
  const url = `http://ingress-nginx-controller.ingress-nginx.svc${target}`;
  inServer(
    `${K} -n ${namespace} exec ${webPod()} -- sh -c 'for i in $(seq 1 ${count}); do wget -q -O /dev/null --header "Host: ${host}" ${url} || true; done'`,
  );
}

try {
  stage = 'cluster objects';
  await applyManifest();
  inServer(`${K} -n ${namespace} rollout status deployment/web --timeout=180s`);

  stage = 'launch';
  app = await launchNativeApp({ executable, directory });
  const { page } = app;
  page.setDefaultTimeout(20_000);
  await expect(page.getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
  const { pane, header, addSession, connect } = kubeScreen(page, Number(env.SSH_PORT));
  const password = inServer('cat /run/probe/password');

  const openWorkspace = async (name, context) => {
    await addSession(name, 'probe', 'kubernetes');
    await connect(name, password);
    await pane().getByLabel('context', { exact: true }).selectOption(context);
    await pane().getByLabel('namespace', { exact: true }).selectOption(namespace);
    await pane().getByRole('button', { name: '시작', exact: true }).click();
    await expect(pane().getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
  };
  const showScreen = (name) => header().getByRole('tab', { name, exact: true }).click();
  const screen = () => pane().getByRole('tabpanel', { name: '인그레스' });
  const host = (name) => screen().locator('.kube-ingress-row.host').filter({ hasText: name });
  const hostCell = (name, column) => host(name).locator(':scope > span').nth(column);
  const note = () => screen().getByRole('status');
  const [SHARE_2XX, SHARE_4XX, SHARE_5XX, RATE] = [2, 3, 4, 1];

  stage = 'backends that are down';
  await openWorkspace('kube-ingress', `kind-${cluster}`);
  await showScreen('인그레스');
  await expect(host('dead.local')).toContainText('백엔드 준비 0: down', { timeout: 40_000 });
  await expect(host('ghost.local')).toContainText('백엔드 없음: nowhere');
  await expect(host('tls.local')).toContainText('TLS Secret 없음: no-such-cert');
  // The controller fills in status.loadBalancer on its own sync, up to a minute after creation.
  await expect(host('ok.local').locator('.kube-ingress-problem')).toHaveText('', {
    timeout: 120_000,
  });
  await page.screenshot({ path: path.join(directory, 'config.png') });
  pass('a missing service, no ready endpoint and a missing TLS secret are each named');

  stage = 'metrics off';
  await expect(note()).toContainText('컨트롤러 메트릭이 꺼져 있어');
  await expect(hostCell('ok.local', SHARE_2XX)).toHaveText('-');
  await expect(screen().getByRole('alert')).toHaveCount(0);
  pass('a controller with metrics off is reported as off, not as an error');

  stage = 'the dashboard lists what is wrong';
  await showScreen('대시보드');
  const panel = () => pane().getByRole('region', { name: '인그레스', exact: true });
  await expect(panel()).toContainText('dead.local');
  await expect(panel()).toContainText('ghost.local');
  await expect(panel()).not.toContainText('ok.local');
  await panel().getByRole('button').filter({ hasText: 'dead.local' }).click();
  await expect(screen().getByLabel('인그레스 필터', { exact: true })).toHaveValue('dead.local');
  await expect(host('ok.local')).toHaveCount(0);
  await screen().getByLabel('인그레스 필터', { exact: true }).fill('');
  pass('the dashboard lists failing hosts and opens the ingress screen on one');

  stage = 'going to the backend pod';
  const backend = webPod();
  await host('ok.local').click();
  const selected = () =>
    pane()
      .getByRole('tree', { name: '클러스터 트리' })
      .getByRole('treeitem')
      .filter({ has: page.getByText(backend, { exact: true }) });
  await expect(selected()).toHaveAttribute('aria-selected', 'true');
  await showScreen('인그레스');
  pass('a row goes to its backend pod in the tree');

  stage = 'metrics on';
  fixture('ingress-metrics-on');
  await expect
    .poll(
      async () => (await note().count()) === 0 || !(await note().innerText()).includes('꺼져'),
      {
        timeout: NEXT_POLL,
      },
    )
    .toBe(true);
  pass('turning the controller metrics on removes the notice');

  stage = 'per-host status shares';
  send('ok.local', '/', 60);
  send('ok.local', '/missing', 20);
  send('ok.local', '/cgi-bin/fail', 20);
  send('dead.local', '/', 5);
  await expect(hostCell('ok.local', SHARE_2XX)).toHaveText('60%', { timeout: NEXT_POLL });
  await expect(hostCell('ok.local', SHARE_4XX)).toHaveText('20%');
  await expect(hostCell('ok.local', SHARE_5XX)).toHaveText('20%');
  await expect(hostCell('dead.local', SHARE_5XX)).toHaveText('100%');
  await page.screenshot({ path: path.join(directory, 'traffic.png') });
  pass('2xx, 4xx and 5xx shares are shown for each host');

  stage = 'a second sample becomes a rate';
  await expect(hostCell('ok.local', RATE)).not.toHaveText('-', { timeout: NEXT_POLL });
  send('ok.local', '/', 30);
  await expect(hostCell('ok.local', SHARE_2XX)).toHaveText('100%', { timeout: NEXT_POLL });
  await expect(hostCell('ok.local', SHARE_5XX)).toHaveText('0%');
  const rate = Number(await hostCell('ok.local', RATE).innerText());
  assert(rate > 0, `expected a positive request rate, got ${rate}`);
  console.log(`INFO ok.local request rate ${rate}/s after 30 requests in one poll interval`);
  pass('two polls give a request rate and the shares of that interval');

  stage = 'searching the controller log';
  const search = () => pane().getByRole('tabpanel', { name: '로그 검색' });
  const status = () => search().getByRole('status');
  const searchButton = () => search().getByRole('button', { name: '검색', exact: true });
  const menu = () => page.getByRole('menu', { name: '인그레스 메뉴' });
  await host('ok.local').click({ button: 'right' });
  await menu().getByRole('menuitem', { name: '컨트롤러 로그 검색: ok.local' }).click();
  await expect(search().getByLabel('범위 종류', { exact: true })).toHaveValue('controller');
  await expect(search().getByLabel('키워드', { exact: true })).toHaveValue('ok.local');
  await expect(searchButton()).toBeEnabled({ timeout: 40_000 });
  await searchButton().click();
  await expect(status()).toContainText('검색 완료 1/1', { timeout: 30_000 });
  console.log(`INFO controller log search by host: ${await status().innerText()}`);
  pass('a host opens the search over the controller, which is outside this namespace');

  stage = 'searching the controller log by upstream';
  await showScreen('인그레스');
  await screen().locator('.kube-ingress-row.path').filter({ hasText: 'web:80' }).first().click({
    button: 'right',
  });
  await menu()
    .getByRole('menuitem', { name: `컨트롤러 로그 검색: ${namespace}-web-80` })
    .click();
  await expect(searchButton()).toBeEnabled({ timeout: 40_000 });
  await searchButton().click();
  await expect(status()).toContainText('검색 완료 1/1', { timeout: 30_000 });
  await expect(search().locator('.kube-search-body [role="row"]').first()).toContainText(
    `${namespace}-web-80`,
  );
  console.log(`INFO controller log search by upstream: ${await status().innerText()}`);
  pass('a path searches the controller log by its upstream name');

  stage = 'metrics off again';
  await showScreen('인그레스');
  fixture('ingress-metrics-off');
  await expect(note()).toContainText('컨트롤러 메트릭이 꺼져 있어', { timeout: NEXT_POLL });
  await expect(hostCell('ok.local', SHARE_2XX)).toHaveText('-');
  pass('turning the metrics off goes back to configuration only');

  stage = 'no pods/proxy';
  fixture('ingress-metrics-on');
  inServer(
    `cat > /tmp/kv8-rbac.yaml <<'YAML'\n${limitedAccount}\nYAML\n${K} apply -f /tmp/kv8-rbac.yaml`,
  );
  inServer(
    `T=$(${K} -n default create token kv8-limited --duration=1h) && ` +
      `${K} config set-credentials kv8-limited --token="$T" >/dev/null && ` +
      `${K} config set-context kv8-limited --cluster=kind-${cluster} --user=kv8-limited >/dev/null && ` +
      `chown probe:probe /opt/kube/config`,
  );
  await openWorkspace('kube-limited', 'kv8-limited');
  await showScreen('인그레스');
  await expect(host('dead.local')).toContainText('백엔드 준비 0: down', { timeout: 40_000 });
  await expect(note()).toHaveText('pods/proxy 권한이 없어 트래픽을 표시하지 못합니다.', {
    timeout: 40_000,
  });
  await expect(hostCell('ok.local', SHARE_2XX)).toHaveText('-');
  await page.screenshot({ path: path.join(directory, 'no-proxy.png') });
  pass('without pods/proxy only that reason is shown and the configuration check still works');
} catch (error) {
  failed = true;
  console.error(`FAILED at: ${stage}`);
  console.error(error instanceof assert.AssertionError ? error.message : error.constructor.name);
  console.error(String(error?.message ?? '').slice(0, 800));
  try {
    await app?.page.screenshot({
      path: path.resolve('test-results-native', 'kube-ingress-failure.png'),
    });
  } catch {
    // The window may already be gone; the stage name above is still reported.
  }
} finally {
  await app?.stop();
  await sleep(200);
  await rm(directory, { recursive: true, force: true }).catch(() => {});
  if (!keep) fixture('down');
}
process.exit(failed ? 1 : 0);
