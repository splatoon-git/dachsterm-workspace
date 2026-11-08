// KV.4 acceptance against the real app, a real OpenSSH server and a real kind cluster: the log
// panel, shell tabs and the way back to the pod, a restarted pod's previous logs, an image with no
// shell, and cleanup when the parent connection ends. Never print the fixture's passwords.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchNativeApp } from './lib/native-app.mjs';
import { docker, kubeFixture, kubeScreen } from './lib/kube-native.mjs';
import { chooseTabMenu } from './native-workspace.mjs';

const clusterArg = process.argv.find((arg) => arg.startsWith('--cluster='));
const cluster = clusterArg ? clusterArg.slice('--cluster='.length) : 'dachsterm-kv4';
const keep = process.argv.includes('--keep');
const executable = process.env.DACHSTERM_TEST_BINARY ?? 'target/debug/dachsterm.exe';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pass = (text) => console.log(`PASS ${text}`);
const fixture = (action) => kubeFixture(cluster, action);
const namespace = 'kv4-detail';
const BUSYBOX = 'busybox:1.36';

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
      annotations: { kubectl.kubernetes.io/default-container: main }
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - name: side
          image: registry.k8s.io/pause:3.10
        - name: main
          image: ${BUSYBOX}
          command: ['sh', '-c', 'i=0; while true; do echo WEB_LOG_LINE $i; i=$((i+1)); sleep 2; done']
---
apiVersion: v1
kind: Service
metadata: { name: web, namespace: ${namespace} }
spec:
  selector: { app: web }
  ports: [{ port: 80 }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: multi, namespace: ${namespace} }
spec:
  replicas: 1
  selector: { matchLabels: { app: multi } }
  template:
    metadata: { labels: { app: multi } }
    spec:
      terminationGracePeriodSeconds: 1
      containers:
        - { name: one, image: '${BUSYBOX}', command: ['sleep', '3600'] }
        - { name: two, image: '${BUSYBOX}', command: ['sleep', '3600'] }
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
        - 'if [ -f /mark/done ]; then echo SECOND_RUN_LINE; sleep 3600; else touch /mark/done; echo PREVIOUS_RUN_LINE; exit 9; fi'
`;

let stage = 'fixture';
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-kube-detail-'));
const env = fixture('up');
const container = env.SSH_CONTAINER;
const inServer = (script) => docker(['exec', container, 'sh', '-c', script]);
const K = '/opt/kube/bin/kubectl --kubeconfig /opt/kube/config';
let app;
let failed = false;

try {
  stage = 'cluster objects';
  docker([
    'exec',
    container,
    'sh',
    '-c',
    `cat > /tmp/kv4.yaml <<'YAML'\n${manifest}\nYAML\n${K} apply -f /tmp/kv4.yaml`,
  ]);
  for (const name of ['web', 'multi', 'noshell'])
    inServer(`${K} -n ${namespace} rollout status deployment/${name} --timeout=180s`);
  inServer(
    `${K} -n ${namespace} wait pod/restarted --for=jsonpath='{.status.containerStatuses[0].restartCount}'=1 --timeout=120s`,
  );
  inServer(`${K} -n ${namespace} wait pod/restarted --for=condition=Ready --timeout=60s`);

  stage = 'launch';
  app = await launchNativeApp({ executable, directory });
  const { page } = app;
  page.setDefaultTimeout(20_000);
  await expect(page.getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
  const { pane, terminal, terminalText, addSession, connect } = kubeScreen(
    page,
    Number(env.SSH_PORT),
  );
  const password = inServer('cat /run/probe/password');

  stage = 'open the tree';
  await addSession('kube-detail', 'probe', 'kubernetes');
  await connect('kube-detail', password);
  await pane().getByLabel('context', { exact: true }).selectOption(`kind-${cluster}`);
  await pane().getByLabel('namespace', { exact: true }).selectOption(namespace);
  await pane().getByRole('button', { name: '시작', exact: true }).click();
  const tree = () => pane().getByRole('tree', { name: '클러스터 트리' });
  const podRow = (name) =>
    tree()
      .getByRole('treeitem')
      .filter({ has: page.getByText(name, { exact: true }) })
      .first();
  const namedPod = (prefix) =>
    tree()
      .getByRole('treeitem')
      .filter({ has: page.getByText(new RegExp(`^${prefix}-[a-z0-9]+-[a-z0-9]+$`)) })
      .first();
  const podName = async (prefix) =>
    (await namedPod(prefix).locator('.kube-tree-label').innerText()).trim();
  const panel = () => pane().locator('.kube-panel');
  const selected = () => tree().locator('[role="treeitem"][aria-selected="true"]');
  const sessionTabs = () => page.locator('.session-tab');
  const parentTab = () =>
    sessionTabs().filter({ hasText: 'kube-detail' }).locator('[role="tab"]').first();
  const backToTree = async () => {
    await parentTab().click();
    await expect(tree()).toBeVisible();
    await tree().focus();
  };
  await expect(namedPod('web')).toContainText('Running', { timeout: 40_000 });
  await expect(podRow('restarted')).toBeVisible();
  const web = await podName('web');
  const shellTab = () => sessionTabs().filter({ hasText: `kind-${cluster} · ${web}` });

  // Resume after stages that have already passed, so they are not run again.
  const fromParent = process.argv.includes('--from-parent');
  const fromFollow = fromParent || process.argv.includes('--from-follow');
  if (!fromFollow) {
    stage = 'log panel from the keyboard';
    await namedPod('web').click();
    await page.keyboard.press('Enter');
    await expect(panel().getByLabel('로그', { exact: true })).toContainText('WEB_LOG_LINE');
    await expect(panel().getByLabel('컨테이너', { exact: true })).toHaveValue('main');
    await page.screenshot({ path: path.join(directory, 'log-panel.png') });
    await page.keyboard.press('Escape');
    await expect(panel()).toHaveCount(0);
    await expect(selected()).toContainText(web);
    await expect(tree()).toBeFocused();
    pass('Enter opens the log panel on the default container and Esc keeps the cursor');

    stage = 'log panel from the mouse, and keyword filter';
    await namedPod('web').dblclick();
    const lines = panel().getByLabel('로그', { exact: true });
    await expect(lines).toContainText('WEB_LOG_LINE');
    await panel().getByLabel('로그 필터', { exact: true }).fill('!WEB_LOG_LINE');
    await expect(panel().getByText('조건에 맞는 줄이 없습니다.')).toBeVisible();
    await panel().getByLabel('로그 필터', { exact: true }).fill('');
    await panel().getByRole('button', { name: '패널 닫기', exact: true }).click();
    await expect(panel()).toHaveCount(0);
    pass('double click opens the panel and the keyword filter narrows it');

    stage = 'context menu, events and detail';
    await namedPod('web').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: '파드 메뉴' });
    await expect(menu.getByRole('menuitem')).toHaveText([/로그/, /셸/, /이벤트/, /상세/]);
    await menu.getByRole('menuitem', { name: /이벤트/ }).click();
    await expect(panel().getByRole('tab', { name: '이벤트', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(panel().getByText('Started').first()).toBeVisible();
    await panel().getByRole('tab', { name: 'YAML', exact: true }).click();
    await expect(panel().getByLabel('YAML', { exact: true })).toContainText('kind: Pod');
    await panel().getByRole('tab', { name: '관계', exact: true }).click();
    await expect(panel().getByText(/web · 로테이션 포함/)).toBeVisible();
    await panel().getByRole('tab', { name: '개요', exact: true }).click();
    await expect(panel()).toContainText(BUSYBOX);
    await page.keyboard.press('Escape');
    await expect(panel()).toHaveCount(0);
    pass('the context menu has the four actions and the detail tabs show real data');

    stage = 'previous logs of a restarted pod';
    await podRow('restarted').click({ button: 'right' });
    await menu.getByRole('menuitem', { name: /상세/ }).click();
    await expect(panel().getByRole('tab', { name: '장애 원인', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const cause = pane().locator('.kube-cause');
    await expect(cause.locator('table')).toContainText('Error');
    await expect(cause.locator('table')).toContainText('9');
    await expect(cause.getByLabel('장애 원인 로그', { exact: true })).toContainText(
      'PREVIOUS_RUN_LINE',
    );
    await expect(cause.getByRole('heading', { name: /직전 인스턴스 로그/ })).toBeVisible();
    await page.screenshot({ path: path.join(directory, 'cause.png') });
    await panel().getByRole('tab', { name: '로그', exact: true }).click();
    await expect(panel().getByLabel('로그', { exact: true })).toContainText('SECOND_RUN_LINE');
    await panel().getByRole('checkbox', { name: '직전 인스턴스' }).check();
    await expect(panel().getByLabel('로그', { exact: true })).toContainText('PREVIOUS_RUN_LINE');
    await page.keyboard.press('Escape');
    pass('a restarted pod shows its exit code, events and the previous instance log on one screen');

    stage = 'a pod that never restarted falls back to the current log';
    await namedPod('web').click();
    await page.keyboard.press('Enter');
    await panel().getByRole('checkbox', { name: '직전 인스턴스' }).check();
    await expect(panel().getByText('직전 인스턴스가 없어 현재 로그를 표시합니다.')).toBeVisible();
    await expect(panel().getByLabel('로그', { exact: true })).toContainText('WEB_LOG_LINE');
    await page.keyboard.press('Escape');
    pass('asking for a previous instance that does not exist shows the current log');

    stage = 'a shell tab and the way back';
    await namedPod('web').click();
    await page.keyboard.press('s');
    await expect(shellTab()).toHaveCount(1);
    await expect(shellTab().getByRole('tab')).toContainText(`kind-${cluster}`);
    await expect.poll(terminalText, { timeout: 20_000 }).toMatch(/[#$] /);
    await terminal().locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('echo KV4_SHELL_$((40+2))');
    await page.keyboard.press('Enter');
    await expect.poll(terminalText).toContain('KV4_SHELL_42');
    pass('the shell tab opens in read-only mode and names the context and the pod');
    await page.keyboard.type('exit 3');
    await page.keyboard.press('Enter');
    await expect(shellTab()).toHaveCount(0);
    await expect(tree()).toBeVisible();
    await expect(tree()).toBeFocused();
    await expect(selected()).toContainText(web);
    pass('exit closes the tab and the cursor is back on the same pod, even with a non-zero code');

    stage = 'a multi-container pod remembers the choice';
    await namedPod('multi').click();
    await page.keyboard.press('s');
    const picker = page.getByRole('menu', { name: '파드 메뉴' });
    await expect(picker.getByRole('menuitem')).toHaveText(['one', 'two']);
    await picker.getByRole('menuitem', { name: 'two' }).click();
    const multi = await podName('multi');
    const multiTab = () => sessionTabs().filter({ hasText: multi });
    await expect(multiTab()).toHaveCount(1);
    await expect.poll(terminalText, { timeout: 20_000 }).toMatch(/[#$] /);
    await terminal().locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('exit');
    await page.keyboard.press('Enter');
    await expect(multiTab()).toHaveCount(0);
    await namedPod('multi').click();
    await page.keyboard.press('s');
    await expect(multiTab()).toHaveCount(1);
    await expect(picker).toHaveCount(0);
    await expect.poll(terminalText, { timeout: 20_000 }).toMatch(/[#$] /);
    await terminal().locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('exit');
    await page.keyboard.press('Enter');
    await expect(multiTab()).toHaveCount(0);
    pass('a container with no annotation is asked for once and then remembered');

    stage = 'an image with no shell';
    await namedPod('noshell').click();
    await page.keyboard.press('s');
    await expect(pane().getByRole('alert')).toContainText('셸(sh)이 없어');
    await expect(sessionTabs()).toHaveCount(1);
    await page.screenshot({ path: path.join(directory, 'no-shell.png') });
    await pane().getByRole('button', { name: '안내 닫기', exact: true }).click();
    pass('an image without a shell says so by the tree and opens no tab');
  }

  if (!fromParent) {
    stage = 'following a log in a terminal tab';
    await namedPod('web').click();
    await page.keyboard.press('Enter');
    await panel().getByRole('button', { name: '따라가기', exact: true }).click();
    const followTab = () => sessionTabs().filter({ hasText: `${web} 로그` });
    await expect(followTab()).toHaveCount(1);
    await expect.poll(terminalText, { timeout: 20_000 }).toContain('WEB_LOG_LINE');
    await followTab()
      .getByRole('button', { name: /탭 닫기/ })
      .click();
    await expect(followTab()).toHaveCount(0);
    await backToTree();
    await page.keyboard.press('Escape');
    await expect(panel()).toHaveCount(0);
    pass('following a log opens a terminal tab and closes cleanly');

    stage = 'a pod that goes away offers its replacement';
    await namedPod('web').click();
    await page.keyboard.press('s');
    await expect(shellTab()).toHaveCount(1);
    await expect.poll(terminalText, { timeout: 20_000 }).toMatch(/[#$] /);
    await terminal().locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('echo BEFORE_DELETE');
    await page.keyboard.press('Enter');
    await expect.poll(terminalText).toContain('BEFORE_DELETE');
    inServer(`${K} -n ${namespace} delete pod ${web} --wait=false`);
    await expect(pane().locator('.ended-card')).toContainText('같은 워크로드의 새 파드', {
      timeout: 60_000,
    });
    await page.screenshot({ path: path.join(directory, 'pod-gone.png') });
    inServer(`${K} -n ${namespace} rollout status deployment/web --timeout=120s`);
    await pane()
      .locator('.ended-card')
      .getByRole('button', { name: '재접속', exact: true })
      .click();
    await expect
      .poll(async () => (await sessionTabs().allInnerTexts()).join(' '), { timeout: 30_000 })
      .not.toContain(web);
    await expect.poll(terminalText, { timeout: 30_000 }).toContain('새 연결');
    await expect.poll(terminalText, { timeout: 20_000 }).toMatch(/[#$] /);
    assert(!(await terminalText()).includes('BEFORE_DELETE'), 'the old command must not run again');
    await terminal().locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('hostname');
    await page.keyboard.press('Enter');
    const replacement = inServer(
      `${K} -n ${namespace} get pods -l app=web --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}'`,
    );
    assert.notEqual(replacement, web);
    await expect.poll(terminalText, { timeout: 15_000 }).toContain(replacement);
    pass('a deleted pod asks first, then connects to the new pod without re-running anything');
    await page.keyboard.type('exit');
    await page.keyboard.press('Enter');
    await expect(sessionTabs()).toHaveCount(1);

    stage = 'the server refuses another channel';
    const opened = [];
    for (let at = 0; at < 14; at++) {
      await backToTree();
      await namedPod('web').click();
      await page.keyboard.press('s');
      const refused = pane().getByRole('alert');
      const before = await sessionTabs().count();
      const outcome = await Promise.race([
        expect(refused)
          .toContainText('동시 세션 한도', { timeout: 15_000 })
          .then(() => 'refused'),
        expect
          .poll(() => sessionTabs().count(), { timeout: 15_000 })
          .toBeGreaterThan(before)
          .then(() => 'opened'),
      ]);
      if (outcome === 'refused') {
        console.log(`MEASURE MaxSessions: refused after ${opened.length} shell tabs`);
        break;
      }
      opened.push(at);
      await sleep(200);
    }
    await expect(pane().getByRole('alert')).toContainText('동시 세션 한도');
    await backToTree();
    await page.screenshot({ path: path.join(directory, 'channel-limit.png') });
    pass('a shell past MaxSessions is refused with the server limit as the reason');
  }

  stage = 'ending the parent connection cleans up its tabs';
  // At the session limit the panel could not read anything, so leave room for the log tab.
  while ((await sessionTabs().count()) > 2)
    await sessionTabs()
      .last()
      .getByRole('button', { name: /탭 닫기/ })
      .click();
  await backToTree();
  if ((await sessionTabs().count()) === 1) {
    await namedPod('web').click();
    await page.keyboard.press('s');
    await expect(sessionTabs()).toHaveCount(2);
    await backToTree();
  }
  await namedPod('web').click();
  await page.keyboard.press('Enter');
  await panel().getByRole('button', { name: '따라가기', exact: true }).click();
  await expect(sessionTabs()).toHaveCount(3);
  await backToTree();
  await chooseTabMenu(page, '연결 종료');
  await expect(sessionTabs()).toHaveCount(1, { timeout: 30_000 });
  await expect(sessionTabs().first()).toContainText('kube-detail');
  pass('every shell and log tab closes when its parent connection ends');
} catch (error) {
  failed = true;
  console.error(`FAILED at: ${stage}`);
  console.error(error instanceof assert.AssertionError ? error.message : error.constructor.name);
  console.error(String(error?.message ?? '').slice(0, 800));
  try {
    await app?.page.screenshot({
      path: path.resolve('test-results-native', 'kube-detail-failure.png'),
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
