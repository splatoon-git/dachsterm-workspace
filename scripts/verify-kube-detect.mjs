// KV.1 acceptance against the real app, a real OpenSSH server and a real kind cluster.
// Never print Playwright errors or the fixture's passwords. Windows only, like every native check.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchNativeApp } from './lib/native-app.mjs';
import { docker, kubeFixture, kubeScreen } from './lib/kube-native.mjs';
import { chooseTabMenu, openNewConnectionForm } from './native-workspace.mjs';

const clusterArg = process.argv.find((arg) => arg.startsWith('--cluster='));
const cluster = clusterArg ? clusterArg.slice('--cluster='.length) : 'dachsterm-kv1';
const keep = process.argv.includes('--keep');
const executable = process.env.DACHSTERM_TEST_BINARY ?? 'target/debug/dachsterm.exe';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fixture = (action) => kubeFixture(cluster, action);

let stage = 'fixture';
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-kube-'));
let app;
let failed = false;
const env = fixture('up');
const container = env.SSH_CONTAINER;
const sshPort = Number(env.SSH_PORT);
const inServer = (script) => docker(['exec', container, 'sh', '-c', script]);
const pass = (text) => console.log(`PASS ${text}`);

try {
  stage = 'launch';
  app = await launchNativeApp({ executable, directory });
  const { page } = app;
  page.setDefaultTimeout(20_000);
  await expect(page.getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
  const {
    invoke,
    pane,
    terminal,
    terminalText,
    header,
    savedProfile,
    connectionId,
    addSession,
    connect,
    answerLogin,
  } = kubeScreen(page, sshPort);
  /** Through the real form, once, so its field is exercised with the backend behind it. */
  async function addSessionByForm(name, username) {
    await openNewConnectionForm(page);
    const form = page.getByRole('dialog');
    await form.getByLabel('이름', { exact: true }).fill(name);
    await form.getByLabel('호스트', { exact: true }).fill('127.0.0.1');
    await form.getByLabel('포트', { exact: true }).fill(String(sshPort));
    await form.getByLabel('사용자', { exact: true }).fill(username);
    await form.getByLabel('접속 후 화면', { exact: true }).selectOption('kubernetes');
    await form.getByRole('button', { name: '저장', exact: true }).click();
    await expect(form).toHaveCount(0);
  }
  const probePassword = inServer('cat /run/probe/password');
  const rkePassword = inServer('cat /run/probe/rke_password');

  stage = 'bashrc only: first connection';
  await addSessionByForm('kube-bashrc', 'probe');
  await connect('kube-bashrc', probePassword);
  await expect(header()).toBeVisible();
  await expect(pane().getByLabel('context', { exact: true })).toBeVisible();
  await expect(pane().locator('.kube-setup-found')).toContainText('/opt/kube/bin/kubectl');
  await expect(pane().locator('.kube-setup-found')).toContainText('/opt/kube/config');
  await expect(pane().getByLabel('context', { exact: true })).toHaveValue(`kind-${cluster}`);
  await page.screenshot({ path: path.join(directory, 'setup.png') });
  pass('kubectl and KUBECONFIG set only in .bashrc are found');

  stage = 'context choice';
  await pane().getByLabel('context', { exact: true }).selectOption('second');
  await expect(pane().getByLabel('namespace', { exact: true }).locator('option')).toContainText([
    '전체',
    'default',
    'kube-system',
  ]);
  await pane().getByLabel('namespace', { exact: true }).selectOption('kube-system');
  await pane().getByRole('button', { name: '시작', exact: true }).click();
  await expect(pane().getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
  await expect(header()).toContainText('second');
  await expect(header()).toContainText('kube-system');
  const saved = await savedProfile('kube-bashrc');
  assert.equal(saved.workspace, 'kubernetes');
  assert.deepEqual(saved.kube, {
    context: 'second',
    namespace: 'kube-system',
    kubectl: '/opt/kube/bin/kubectl',
    kubeconfig: '/opt/kube/config',
    operate: false,
  });
  pass('the context and namespace choice is saved with absolute paths');

  stage = 'hidden shell';
  await header().getByRole('tab', { name: '서버 터미널', exact: true }).click();
  await expect(terminal()).toBeVisible();
  await terminal().locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('printf "KV1_SHELL_%s\\n" alive');
  await page.keyboard.press('Enter');
  await expect.poll(terminalText).toContain('KV1_SHELL_alive');
  assert(!(await terminalText()).includes('__dachsterm_'), 'no directory hook was typed');
  await header().getByRole('tab', { name: '트리', exact: true }).click();
  await expect(pane().getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
  await header().getByRole('tab', { name: '서버 터미널', exact: true }).click();
  await expect.poll(terminalText).toContain('KV1_SHELL_alive');
  await header().getByRole('tab', { name: '트리', exact: true }).click();
  pass('the server terminal keeps its shell while the workspace is shown');

  stage = 'next connection opens directly';
  await chooseTabMenu(page, '연결 종료');
  await expect(pane().locator('.ended-card')).toBeVisible();
  await chooseTabMenu(page, '재접속');
  await answerLogin(probePassword);
  await expect(pane().getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
  await expect(pane().getByLabel('context', { exact: true })).toHaveCount(0);
  pass('a configured session opens its workspace on the next connection');

  stage = 'MaxSessions on the app channels';
  await pane().getByRole('tab', { name: '서버 터미널', exact: true }).waitFor();
  const id = await connectionId();
  inServer(
    "touch /home/probe/.slow-rc && chown probe /home/probe/.slow-rc && grep -q slow-rc /home/probe/.bashrc || printf '[ -f ~/.slow-rc ] && sleep 4\\n' >> /home/probe/.bashrc",
  );
  const results = await page.evaluate(
    ({ id }) => {
      const started = performance.now();
      const elapsed = () => Math.round(performance.now() - started);
      return Promise.all(
        Array.from({ length: 14 }, () =>
          window.__TAURI_INTERNALS__
            .invoke('kube_detect', { id, request: { mode: 'scan' }, context: null })
            .then(
              (detection) => ({ kind: detection.state.kind, ms: elapsed() }),
              () => ({ kind: 'threw', ms: elapsed() }),
            ),
        ),
      );
    },
    { id },
  );
  const counts = results.reduce((all, { kind }) => ({ ...all, [kind]: (all[kind] ?? 0) + 1 }), {});
  const timing = (kind) => results.filter((r) => r.kind === kind).map((r) => r.ms);
  console.log(
    `MEASURE MaxSessions: 14 concurrent scans ${JSON.stringify(counts)}, refused at ${timing('channelLimit')} ms, ready at ${timing('ready')} ms`,
  );
  assert(counts.channelLimit > 0, 'the server must refuse some channels');
  assert(counts.ready > 0, 'the channels the server accepted must finish');
  assert.equal(counts.threw, undefined);
  inServer('rm -f /home/probe/.slow-rc');
  const recovered = await invoke('kube_detect', { id, request: { mode: 'scan' }, context: null });
  assert.equal(recovered.state.kind, 'ready');
  await header().getByRole('tab', { name: '서버 터미널', exact: true }).click();
  await terminal().locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('printf "KV1_AFTER_%s\\n" limit');
  await page.keyboard.press('Enter');
  await expect.poll(terminalText).toContain('KV1_AFTER_limit');
  pass('channels past MaxSessions are refused as a state and the connection keeps working');

  stage = 'root-only kubeconfig';
  await addSession('kube-rke', 'rkeuser', 'kubernetes');
  await connect('kube-rke', rkePassword);
  await expect(
    pane().getByRole('heading', { name: '이 계정은 쿠버네티스 설정을 읽을 수 없습니다' }),
  ).toBeVisible();
  await expect(pane().locator('.kube-setup-found')).toContainText(
    '/var/lib/rancher/rke2/bin/kubectl',
  );
  await expect(pane().locator('.kube-setup-found')).toContainText('/etc/rancher/rke2/rke2.yaml');
  await page.screenshot({ path: path.join(directory, 'unreadable.png') });
  await pane().getByRole('button', { name: '터미널에서 설정 복사', exact: true }).click();
  await expect(terminal()).toBeVisible();
  await expect.poll(terminalText).toContain('sudo install -m 600');
  await expect(header()).toContainText('Enter를 누르고');
  await terminal().locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Enter');
  await expect.poll(terminalText, { timeout: 15_000 }).toContain('[sudo] password');
  await page.keyboard.type(rkePassword);
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      inServer('stat -c "%a %U" /home/rkeuser/.kube/dachsterm.config 2>/dev/null || true'),
    )
    .toBe('600 rkeuser');
  await header().getByRole('button', { name: '다시 확인', exact: true }).click();
  await expect(pane().getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
  await expect(header()).toContainText(`kind-${cluster}`);
  assert.equal(
    (await savedProfile('kube-rke')).kube.kubeconfig,
    '/home/rkeuser/.kube/dachsterm.config',
  );
  pass('copy and recheck take a root-only server to the workspace');

  stage = 'root-only: next connection';
  await chooseTabMenu(page, '연결 종료');
  await chooseTabMenu(page, '재접속');
  await answerLogin(rkePassword);
  await expect(pane().getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
  pass('the copied config opens directly on the next connection');

  stage = 'stale copy';
  inServer(
    "sed -i -e '/client-certificate-data:/d' -e 's/client-key-data:.*/token: stale-token-for-check/' /home/rkeuser/.kube/dachsterm.config",
  );
  await chooseTabMenu(page, '연결 종료');
  await chooseTabMenu(page, '재접속');
  await answerLogin(rkePassword);
  await expect(pane().getByRole('heading', { name: '클러스터 인증에 실패했습니다' })).toBeVisible();
  await expect(
    pane().getByRole('button', { name: '터미널에서 설정 복사', exact: true }),
  ).toBeEnabled();
  inServer('rm -f /home/rkeuser/.kube/dachsterm.config');
  pass('a stale copy is told apart as an authentication failure');

  stage = 'tab menu on a terminal session';
  await addSession('kube-terminal', 'probe', undefined);
  await connect('kube-terminal', probePassword);
  await expect(header()).toHaveCount(0);
  await expect(terminal()).toBeVisible();
  const idBefore = await connectionId();
  await chooseTabMenu(page, '쿠버네티스 화면 열기');
  await expect(pane().getByLabel('context', { exact: true })).toBeVisible();
  assert.equal(await connectionId(), idBefore, 'the connection stays the same');
  await pane().getByRole('button', { name: '시작', exact: true }).click();
  await expect(pane().getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
  const untouched = await savedProfile('kube-terminal');
  assert.equal(untouched.workspace, undefined);
  assert.equal(untouched.kube, undefined);
  await chooseTabMenu(page, '쿠버네티스 화면 닫기');
  await expect(header()).toHaveCount(0);
  await expect(terminal()).toBeVisible();
  pass('the tab menu opens the workspace on the same connection without changing the session');

  stage = 'copy runs by itself where the shell reports its prompt';
  await addSession('kube-rke-terminal', 'rkeuser', undefined);
  await connect('kube-rke-terminal', rkePassword);
  // Prompt reports start once the terminal's own hook has been installed.
  await expect.poll(terminalText).toContain('rkeuser@');
  await sleep(2500);
  await chooseTabMenu(page, '쿠버네티스 화면 열기');
  await pane().getByRole('button', { name: '터미널에서 설정 복사', exact: true }).click();
  await expect(terminal()).toBeVisible();
  await expect.poll(terminalText, { timeout: 15_000 }).toContain('[sudo] password');
  await page.keyboard.type(rkePassword);
  await page.keyboard.press('Enter');
  await expect
    .poll(() => inServer('stat -c "%a" /home/rkeuser/.kube/dachsterm.config 2>/dev/null || true'))
    .toBe('600');
  await header().getByRole('button', { name: '다시 확인', exact: true }).click();
  await expect(pane().getByRole('tree', { name: '클러스터 트리' })).toBeVisible();
  assert.equal((await savedProfile('kube-rke-terminal')).kube, undefined);
  inServer('rm -f /home/rkeuser/.kube/dachsterm.config');
  pass('the copy is typed and run at a shell that reports its prompt');
} catch (error) {
  failed = true;
  console.error(`FAILED at: ${stage}`);
  console.error(error instanceof assert.AssertionError ? error.message : error.constructor.name);
  try {
    await app?.page.screenshot({
      path: path.resolve('test-results-native', 'kube-detect-failure.png'),
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
