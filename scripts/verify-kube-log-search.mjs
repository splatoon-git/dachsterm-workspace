// KV.5 acceptance against the real app, a real OpenSSH server and a real kind cluster: searching
// many pods, cancelling (and the remote process stopping), the limits being stated, the channel
// refusal path, and opening a result's logs and shell. Never print the fixture's passwords.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchNativeApp } from './lib/native-app.mjs';
import { docker, kubeFixture, kubeScreen } from './lib/kube-native.mjs';

const clusterArg = process.argv.find((arg) => arg.startsWith('--cluster='));
const cluster = clusterArg ? clusterArg.slice('--cluster='.length) : 'dachsterm-kv5';
const keep = process.argv.includes('--keep');
const executable = process.env.DACHSTERM_TEST_BINARY ?? 'target/debug/dachsterm.exe';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pass = (text) => console.log(`PASS ${text}`);
const fixture = (action) => kubeFixture(cluster, action);
const namespace = 'kv5-search';
const BUSYBOX = 'busybox:1.36';

const deployment = (name, replicas, command, extra = '') => `
apiVersion: apps/v1
kind: Deployment
metadata: { name: ${name}, namespace: ${namespace} }
spec:
  replicas: ${replicas}
  selector: { matchLabels: { app: ${name} } }
  template:
    metadata:
      labels: { app: ${name} }${extra}
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - name: main
          image: ${BUSYBOX}
          command: ['sh', '-c', ${JSON.stringify(command)}]
`;

const CHATTY = `for i in 1 2 3 4 5; do if [ $((i % 2)) = 0 ]; then level=debug; else level=info; fi; echo "KV5_MATCH $HOSTNAME line $i level=$level"; done; exec sleep 3600`;
const FLOOD = `seq 1 1500 | sed 's/^/FLOOD_LINE /'; exec sleep 3600`;
// Several megabytes of log with no keyword in it, so a search has work to do when it is cancelled.
const BULKY = `head -c 6000000 /dev/urandom | base64 | fold -w 120; exec sleep 3600`;

const manifest = `
apiVersion: v1
kind: Namespace
metadata: { name: ${namespace} }
---
${deployment('chatty', 3, CHATTY)}
---
${deployment('flood', 6, FLOOD)}
---
${deployment('bulky', 30, BULKY)}
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: multi, namespace: ${namespace} }
spec:
  replicas: 1
  selector: { matchLabels: { app: multi } }
  template:
    metadata:
      labels: { app: multi }
      annotations: { kubectl.kubernetes.io/default-container: two }
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - { name: one, image: '${BUSYBOX}', command: ['sh', '-c', 'echo MULTI_LINE from-one; exec sleep 3600'] }
        - { name: two, image: '${BUSYBOX}', command: ['sh', '-c', 'echo MULTI_LINE from-two; exec sleep 3600'] }
---
apiVersion: v1
kind: Pod
metadata: { name: restarted, namespace: ${namespace} }
spec:
  volumes: [{ name: mark, emptyDir: {} }]
  containers:
    - name: app
      image: ${BUSYBOX}
      volumeMounts: [{ name: mark, mountPath: /mark }]
      command:
        - sh
        - -c
        - 'if [ -f /mark/done ]; then echo KV5_RESTART second; exec sleep 3600; else touch /mark/done; echo KV5_RESTART first; exit 9; fi'
`;

let stage = 'fixture';
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-kube-log-search-'));
const env = fixture('up');
const container = env.SSH_CONTAINER;
const inServer = (script) => docker(['exec', container, 'sh', '-c', script]);
const K = '/opt/kube/bin/kubectl --kubeconfig /opt/kube/config';
const kubectlLogs = () =>
  Number(inServer(`ps -eo args | grep -c '[k]ubectl .* logs' || true`).trim());
let app;
let failed = false;

try {
  stage = 'cluster objects';
  inServer(`cat > /tmp/kv5.yaml <<'YAML'\n${manifest}\nYAML\n${K} apply -f /tmp/kv5.yaml`);
  for (const name of ['chatty', 'flood', 'bulky', 'multi'])
    inServer(`${K} -n ${namespace} rollout status deployment/${name} --timeout=300s`);
  inServer(
    `${K} -n ${namespace} wait pod/restarted --for=jsonpath='{.status.containerStatuses[0].restartCount}'=1 --timeout=120s`,
  );
  inServer(`${K} -n ${namespace} wait pod/restarted --for=condition=Ready --timeout=60s`);
  const pods = (name) =>
    inServer(`${K} -n ${namespace} get pods -l app=${name} -o jsonpath='{.items[*].metadata.name}'`)
      .split(' ')
      .filter(Boolean);
  const chattyPods = pods('chatty');
  const floodPods = pods('flood');
  assert.equal(chattyPods.length, 3);

  stage = 'launch';
  app = await launchNativeApp({ executable, directory });
  const { page } = app;
  page.setDefaultTimeout(20_000);
  await expect(page.getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
  const { pane, header, terminal, terminalText, addSession, connect } = kubeScreen(
    page,
    Number(env.SSH_PORT),
  );
  const password = inServer('cat /run/probe/password');

  stage = 'open the workspace';
  await addSession('kube-search', 'probe', 'kubernetes');
  await connect('kube-search', password);
  await pane().getByLabel('context', { exact: true }).selectOption(`kind-${cluster}`);
  await pane().getByLabel('namespace', { exact: true }).selectOption(namespace);
  await pane().getByRole('button', { name: '시작', exact: true }).click();
  await expect(
    pane().getByRole('tree', { name: '클러스터 트리' }).getByText(chattyPods[0], { exact: true }),
  ).toBeVisible({ timeout: 40_000 });

  const search = () => pane().getByRole('tabpanel', { name: '로그 검색' });
  const rows = () => search().locator('.kube-search-body [role="row"]');
  const status = () => search().getByRole('status');
  const alert = () => search().getByRole('alert');
  const scopeKind = () => search().getByLabel('범위 종류', { exact: true });
  const scopeValue = () => search().getByLabel('범위', { exact: true });
  const keywordBox = () => search().getByLabel('키워드', { exact: true });
  const searchButton = () => search().getByRole('button', { name: '검색', exact: true });

  async function run(kind, value, query) {
    await scopeKind().selectOption(kind);
    if (kind !== 'all') await scopeValue().fill(value);
    await keywordBox().fill(query);
    await expect(searchButton()).toBeEnabled({ timeout: 40_000 });
    await searchButton().click();
  }

  stage = 'several pods at once';
  await header().getByRole('tab', { name: '로그 검색', exact: true }).click();
  await run('workload', `${namespace}/Deployment/chatty`, 'KV5_MATCH');
  await expect(status()).toContainText('검색 완료 3/3 · 15줄');
  await expect(rows()).toHaveCount(15);
  for (const name of chattyPods) await expect(rows().filter({ hasText: name })).toHaveCount(5);
  await expect(rows().first().locator('mark').first()).toHaveText('KV5_MATCH');
  await page.screenshot({ path: path.join(directory, 'results.png') });
  pass('a workload search reads every pod and shows the matching lines, highlighted');

  stage = 'exclusion, case and a keyword that looks like a command';
  await run('workload', `${namespace}/Deployment/chatty`, 'kv5_match !level=debug');
  await expect(status()).toContainText('검색 완료 3/3 · 9줄');
  await expect(rows().filter({ hasText: 'level=debug' })).toHaveCount(0);
  await run('workload', `${namespace}/Deployment/chatty`, '$(touch${IFS}/tmp/kv5-injected)');
  await expect(status()).toContainText('검색 완료 3/3 · 0줄');
  assert.equal(inServer('test -e /tmp/kv5-injected && echo yes || echo no'), 'no');
  pass('!word excludes, case is ignored, and a keyword stays an argument');

  stage = 'containers';
  await run('pod', `${namespace}/${pods('multi')[0]}`, 'MULTI_LINE');
  await expect(status()).toContainText('검색 완료 1/1 · 1줄');
  await expect(rows().first()).toContainText('from-two');
  await search().getByRole('checkbox', { name: '컨테이너 전체' }).check();
  await keywordBox().fill('MULTI_LINE');
  await searchButton().click();
  await expect(status()).toContainText('검색 완료 2/2 · 2줄');
  await search().getByRole('checkbox', { name: '컨테이너 전체' }).uncheck();
  pass('the default container is read unless every container is asked for');

  stage = 'previous instance';
  await run('pod', `${namespace}/restarted`, 'KV5_RESTART');
  await expect(status()).toContainText('검색 완료 1/1 · 1줄');
  await search().getByRole('checkbox', { name: '이전 인스턴스 포함' }).check();
  await keywordBox().fill('KV5_RESTART');
  await searchButton().click();
  await expect(status()).toContainText('검색 완료 2/2 · 2줄');
  await expect(rows().filter({ hasText: 'first' })).toContainText('이전');
  await search().getByRole('checkbox', { name: '이전 인스턴스 포함' }).uncheck();
  pass('a restarted container is also searched in its previous instance');

  stage = 'the per-pod limit is stated';
  await run('pod', `${namespace}/${floodPods[0]}`, 'FLOOD_LINE');
  await expect(status()).toContainText('검색 완료 1/1 · 1,000줄');
  await expect(alert()).toContainText('파드당 1,000줄');
  pass('a pod past 1,000 matching lines stops there and says so');

  stage = 'the total limit is stated';
  await run('workload', `${namespace}/Deployment/flood`, 'FLOOD_LINE');
  await expect(alert()).toContainText('전체 5,000줄', { timeout: 30_000 });
  await expect(status()).toContainText('5,000줄');
  await page.screenshot({ path: path.join(directory, 'limits.png') });
  pass('a search past 5,000 lines stops there and says so');

  stage = 'a result opens the log around it, its pod log and its shell';
  await run('workload', `${namespace}/Deployment/chatty`, 'KV5_MATCH');
  await expect(status()).toContainText('검색 완료 3/3 · 15줄');
  await rows().first().click();
  const around = () => pane().getByRole('region', { name: '주변 로그' });
  await expect(around().locator('.kube-around-line.hit')).toContainText('KV5_MATCH');
  await around().getByRole('button', { name: '패널 닫기' }).click();

  const menu = () => page.getByRole('menu', { name: '결과 메뉴' });
  const sessionTabs = () => page.locator('.session-tab');
  await rows().first().click({ button: 'right' });
  await menu().getByRole('menuitem', { name: '로그', exact: true }).click();
  await expect(pane().locator('.kube-panel').getByLabel('로그', { exact: true })).toContainText(
    'KV5_MATCH',
  );
  await page.keyboard.press('Escape');
  pass('a result opens the lines around it and that pod’s log');

  await rows().first().click({ button: 'right' });
  await menu().getByRole('menuitem', { name: '셸', exact: true }).click();
  await expect(sessionTabs()).toHaveCount(2);
  await expect.poll(terminalText, { timeout: 20_000 }).toMatch(/[#$] /);
  await terminal().locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('hostname');
  await page.keyboard.press('Enter');
  await expect.poll(terminalText, { timeout: 10_000 }).toMatch(/chatty-/);
  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await expect(sessionTabs()).toHaveCount(1);
  pass('a result opens a shell in that pod and comes back when it ends');

  stage = 'following with the keywords';
  await expect(rows().first()).toBeVisible();
  await rows().first().click({ button: 'right' });
  await menu().getByRole('menuitem', { name: '이 키워드로 실시간 따라가기' }).click();
  await expect(sessionTabs()).toHaveCount(2);
  await expect.poll(terminalText, { timeout: 20_000 }).toContain('KV5_MATCH');
  await sessionTabs()
    .last()
    .getByRole('button', { name: /탭 닫기/ })
    .click();
  await expect(sessionTabs()).toHaveCount(1);
  pass('following keeps the keywords as a live filter in a terminal tab');

  stage = 'cancelling stops the search and the remote process';
  const tabButton = sessionTabs().locator('[role="tab"]').first();
  await tabButton.click();
  await run('workload', `${namespace}/Deployment/bulky`, 'KV5_NEVER_FOUND');
  await expect.poll(kubectlLogs, { timeout: 15_000 }).toBeGreaterThan(0);
  await search().getByRole('button', { name: '취소', exact: true }).click();
  await expect(status()).toContainText('취소됨', { timeout: 15_000 });
  await expect(searchButton()).toBeVisible();
  await expect.poll(kubectlLogs, { timeout: 15_000 }).toBe(0);
  await page.screenshot({ path: path.join(directory, 'cancelled.png') });
  pass('cancel ends the search, closes its channels and no kubectl keeps running on the server');

  stage = 'a refused channel narrows the search';
  await header().getByRole('tab', { name: '트리', exact: true }).click();
  const tree = () => pane().getByRole('tree', { name: '클러스터 트리' });
  const parent = () =>
    sessionTabs().filter({ hasText: 'kube-search' }).locator('[role="tab"]').first();
  const backToTree = async () => {
    await parent().click();
    await expect(tree()).toBeVisible();
    await tree().focus();
  };
  const chattyRow = () =>
    tree()
      .getByRole('treeitem')
      .filter({ has: page.getByText(chattyPods[0], { exact: true }) })
      .first();
  let refused = false;
  for (let at = 0; at < 14 && !refused; at++) {
    await backToTree();
    await chattyRow().click();
    await page.keyboard.press('s');
    const before = await sessionTabs().count();
    refused =
      (await Promise.race([
        expect(pane().getByRole('alert'))
          .toContainText('동시 세션 한도', { timeout: 15_000 })
          .then(() => 'refused'),
        expect
          .poll(() => sessionTabs().count(), { timeout: 15_000 })
          .toBeGreaterThan(before)
          .then(() => 'opened'),
      ])) === 'refused';
    await sleep(200);
  }
  assert(refused, 'the server should have refused a channel');
  // Leave two channels: one for polling to take at times, and at least one for the search.
  for (let at = 0; at < 2; at++)
    await sessionTabs()
      .last()
      .getByRole('button', { name: /탭 닫기/ })
      .click();
  await backToTree();
  await header().getByRole('tab', { name: '로그 검색', exact: true }).click();
  await run('workload', `${namespace}/Deployment/flood`, 'FLOOD_LINE');
  await expect(search().locator('.kube-search-narrowed')).toContainText('동시 검색을', {
    timeout: 30_000,
  });
  await expect(status()).toContainText('검색 완료', { timeout: 60_000 });
  await expect(search().locator('.kube-search-failures')).toHaveCount(0);
  await page.screenshot({ path: path.join(directory, 'narrowed.png') });
  pass('when the server refuses a channel the search narrows and still finishes');
} catch (error) {
  failed = true;
  console.error(`FAILED at: ${stage}`);
  console.error(error instanceof assert.AssertionError ? error.message : error.constructor.name);
  console.error(String(error?.message ?? '').slice(0, 800));
  try {
    await app?.page.screenshot({
      path: path.resolve('test-results-native', 'kube-log-search-failure.png'),
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
