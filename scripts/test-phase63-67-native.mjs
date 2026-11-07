// Built app + real local PTY and ephemeral OpenSSH. Never print credential-bearing errors.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import { chooseTabMenu } from './native-workspace.mjs';
const binary = process.env.DACHSTERM_TEST_BINARY ?? path.resolve('target/debug/dachsterm.exe');
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-phase63-67-'));
const fixture = `dachsterm-podtree-${randomUUID()}`;
const docker = (args) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0) throw Error('Fixture operation failed');
  return r.stdout.trim();
};
let app,
  browser,
  page,
  created = false,
  stage = 'fixture';
const result = { binary, checks: [], errors: [] };
try {
  docker(['build', '-q', '-t', 'dachsterm-openssh-probe', 'tests/openssh']);
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    fixture,
    '--label',
    'app.dachsterm.purpose=podtree-log-verification',
    '-p',
    '127.0.0.1::22',
    '--tmpfs',
    '/run/probe:rw,noexec,nosuid,mode=0700',
    'dachsterm-openssh-probe',
  ]);
  created = true;
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (
      spawnSync('docker', ['exec', fixture, 'test', '-f', '/run/probe/ready'], {
        stdio: 'ignore',
        windowsHide: true,
      }).status === 0
    ) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) throw Error('Fixture startup timeout');
  const sshPort = docker(['port', fixture, '22/tcp']).split(':').at(-1);
  let password = docker(['exec', fixture, 'cat', '/run/probe/password']);
  const fingerprint = docker(['exec', fixture, 'ssh-keygen', '-lf', '/run/probe/host.pub']).split(
    /\s+/,
  )[1];
  const wsl = (command) => {
    const r = spawnSync('wsl', ['-d', 'Ubuntu', '--', 'bash', '-lc', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
    });
    if (r.status !== 0) throw Error('WSL fixture failed');
    return r.stdout.trim();
  };
  docker(['network', 'connect', 'kind', fixture]);
  wsl(
    `docker cp -L /usr/local/bin/kubectl ${fixture}:/usr/local/bin/kubectl && docker cp /tmp/dachsterm-podtree-check.config ${fixture}:/home/probe/fixture.config`,
  );
  docker([
    'exec',
    fixture,
    'bash',
    '-c',
    'mkdir -p /home/probe/.kube; mv /home/probe/fixture.config /home/probe/.kube/config; kubectl --kubeconfig /home/probe/.kube/config config set-cluster kind-dachsterm-podtree-check --server=https://dachsterm-podtree-check-control-plane:6443 --tls-server-name=127.0.0.1 >/dev/null; chown -R probe:probe /home/probe/.kube; chmod 600 /home/probe/.kube/config',
  ]);
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  app = spawn(binary, [], {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      KUBECONFIG: '/tmp/dachsterm-podtree-check.config',
      WSLENV: [process.env.WSLENV, 'KUBECONFIG'].filter(Boolean).join(':'),
      DACHSTERM_TEST_DATA_DIR: directory,
      DACHSTERM_TEST_CDP_PORT: String(port),
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview'),
    },
  });
  stage = 'launch';
  let endpoint;
  for (let i = 0; i < 100; i++) {
    try {
      endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!endpoint) throw Error('Endpoint unavailable');
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  for (let i = 0; i < 80; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('tauri.localhost'));
    if (page) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) throw Error('Page unavailable');
  page.on('pageerror', () => result.errors.push('pageerror'));
  page.setDefaultTimeout(15000);
  const paste = async (pane, text) => {
    const input = pane.locator('.xterm-helper-textarea');
    await input.focus();
    await input.evaluate((e, text) => {
      const c = new DataTransfer();
      c.setData('text/plain', text);
      e.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: c, bubbles: true, cancelable: true }),
      );
    }, text);
    await input.press('Enter');
  };

  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  const logs = path.join(directory, 'logs');
  await mkdir(logs);
  const options = {
    directory: logs,
    timestamps: false,
    maxBytes: 1048576,
    keepFiles: 2,
    daily: true,
  };
  stage = 'local-open';
  await page.getByRole('tab', { name: '연결', exact: true }).click();
  await page.locator('.local-targets').getByTitle('Windows PowerShell 새 터미널 열기').click();
  const local = page.getByRole('region', { name: 'Windows PowerShell 터미널', exact: true });
  await expect(local.locator('.xterm-accessibility-tree')).toContainText('PS C:');
  const localId = await local.getAttribute('data-connection-id');
  stage = 'local-log-ui';
  await chooseTabMenu(page, '세션 기록', local);
  let dialog = page.getByRole('dialog', { name: '세션 로그' });
  await dialog.getByLabel('저장 폴더', { exact: true }).fill(logs);
  await dialog
    .getByLabel('이번 기록에서 가릴 문자열 (줄당 하나)', { exact: true })
    .fill('MASK_FIXTURE');
  await dialog.getByRole('button', { name: '기록 시작', exact: true }).click();
  await expect
    .poll(async () => (await invoke('log_status', { id: localId })).state)
    .toBe('recording');
  await dialog.getByRole('button', { name: '대화상자 닫기' }).click();
  await paste(local, "Write-Output ('LOCAL_A_한글_'+'MASK_FIXTURE')");
  await expect(local.locator('.xterm-accessibility-tree')).toContainText(
    'LOCAL_A_한글_MASK_FIXTURE',
  );
  await invoke('log_action', { id: localId, action: 'pause' });
  await paste(local, "Write-Output ('PAUSED_'+'OUTPUT')");
  await expect(local.locator('.xterm-accessibility-tree')).toContainText('PAUSED_OUTPUT');
  await invoke('log_action', { id: localId, action: 'resume' });
  await paste(local, "Write-Output ('RESUMED_'+'OUTPUT')");
  await expect(local.locator('.xterm-accessibility-tree')).toContainText('RESUMED_OUTPUT');
  await invoke('log_action', { id: localId, action: 'stop' });
  await expect
    .poll(async () => (await invoke('log_status', { id: localId })).state)
    .toBe('stopped');
  const localText = await readFile((await invoke('log_status', { id: localId })).path, 'utf8');
  expect(localText).toContain('LOCAL_A_한글_[MASKED]');
  expect(localText).not.toContain('MASK_FIXTURE');
  expect(localText).not.toContain('PAUSED_OUTPUT');
  expect(localText).toContain('RESUMED_OUTPUT');
  expect(localText).not.toContain('\x1b');
  result.checks.push('Windows local PTY: UI start, UTF-8, masking, pause/resume, flush');
  stage = 'ssh-connect';
  await page.locator('header').getByRole('button', { name: '＋ 새 연결', exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('이름', { exact: true }).fill('로그 PodTree 검사');
  await form.getByLabel('호스트', { exact: true }).fill('127.0.0.1');
  await form.getByLabel('포트', { exact: true }).fill(sshPort);
  await form.getByLabel('사용자', { exact: true }).fill('probe');
  await form.getByLabel('비밀번호', { exact: true }).fill(password);
  password = '';
  await form.getByRole('button', { name: '저장 후 연결', exact: true }).click();
  await expect(page.locator('.trust-card code')).toHaveText(fingerprint);
  await page.getByRole('button', { name: '지문 확인 · 신뢰하고 연결', exact: true }).click();
  const ssh = page.getByRole('region', { name: '로그 PodTree 검사 터미널', exact: true });
  await expect(ssh.locator('.connection-message')).toContainText('연결됨');
  const sshId = await ssh.getAttribute('data-connection-id');
  await paste(ssh, 'stty -echo');
  stage = 'ssh-logs';
  await invoke('log_start', { id: sshId, options, masks: ['MASK_FIXTURE'] });
  await paste(
    ssh,
    "printf '\\033[31m한글_MASK_'; sleep .1; printf 'FIXTURE\\033[0m\\nSSH_ORDER_1\\nSSH_ORDER_2\\n'",
  );
  await expect(ssh.locator('.xterm-accessibility-tree')).toContainText('SSH_ORDER_2');
  await invoke('log_action', { id: sshId, action: 'stop' });
  await expect.poll(async () => (await invoke('log_status', { id: sshId })).state).toBe('stopped');
  let text = await readFile((await invoke('log_status', { id: sshId })).path, 'utf8');
  expect(text).toContain('한글_[MASKED]\nSSH_ORDER_1\nSSH_ORDER_2\n');
  expect(text).not.toContain('MASK_FIXTURE');
  expect(text).not.toContain('\x1b');
  result.checks.push('Actual OpenSSH: output order, fragmented mask/ANSI, UTF-8, flush');
  for (const location of [
    { kind: 'ssh', id: sshId },
    { kind: 'local', id: 'wsl:Ubuntu' },
  ]) {
    const context = location.kind === 'ssh' ? 'kind-dachsterm-podtree-check' : 'dachsterm-viewer';
    stage = `podtree-${location.kind}-inspect`;
    const inspection = await invoke('podtree_inspect', {
      location,
      context,
    });
    expect(inspection.contexts).toContain('kind-dachsterm-podtree-check');
    if (context === 'dachsterm-viewer') expect(inspection.warning).toBeTruthy();
    else expect(inspection.namespaces).toContain('dachsterm-check');
    stage = `podtree-${location.kind}-open`;
    await page
      .locator('summary')
      .filter({ hasText: /^도구$/ })
      .click();
    await page.getByRole('button', { name: 'PodTree 열기', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'PodTree 열기' });
    await dialog.getByLabel('실행 위치').selectOption(`${location.kind}:${location.id}`);
    await dialog.getByRole('button', { name: '의존성·context 확인', exact: true }).click();
    await expect(dialog.getByLabel('context')).toBeVisible();
    await dialog.getByLabel('context').selectOption(context);
    await expect(dialog.getByLabel('context')).toBeEnabled();
    await dialog.getByLabel('namespace (비우면 전체)').fill('dachsterm-check');
    await dialog.getByRole('button', { name: '전용 탭 열기 · 조회', exact: true }).click();
    const pod = page
      .getByRole('region', { name: `PodTree · ${context} 터미널`, exact: true })
      .last();
    await expect(pod.locator('.connection-message')).toContainText('조회 모드');
    const podId = await pod.getAttribute('data-connection-id');
    await expect(pod.locator('.xterm-accessibility-tree')).toContainText('log-demo', {
      timeout: 25000,
    });
    const message = await pod.locator('.connection-message').textContent();
    const temporary = message.match(/임시 경로 (\/[^\s]+)/)?.[1];
    expect(temporary).toBeTruthy();
    const group = await invoke('broadcast_status');
    expect(group.targets.map((t) => t.id)).not.toContain(podId);
    await page.waitForTimeout(1800);
    stage = `podtree-${location.kind}-read-only`;
    await pod.locator('.xterm-helper-textarea').focus();
    for (const key of ['s', 'P', 'T', 'N', 'Delete', 'R', 'X', 'V']) {
      stage = `podtree-${location.kind}-readonly-${key}`;
      await invoke('podtree_input', { id: podId, data: key === 'Delete' ? '\u001b[3~' : key });

      await expect(pod.locator('.xterm-accessibility-tree')).toContainText(/읽기 전용|read-only/);
    }
    stage = `podtree-${location.kind}-logs`;
    await pod.locator('.xterm-helper-textarea').focus();
    await invoke('podtree_input', { id: podId, data: '\u001b[F' });
    await expect(pod.locator('.xterm-accessibility-tree')).toContainText(
      'dachsterm-check/log-demo',
    );
    await invoke('podtree_input', { id: podId, data: '\r' });
    await expect(pod.locator('.xterm-accessibility-tree')).toContainText('DACHSTERM_POD_LOG');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    stage = `podtree-${location.kind}-resize`;
    await invoke('podtree_resize', { id: podId, cols: 95, rows: 28 });
    await page.screenshot({ path: `target/verification/podtree-${location.kind}.png` });
    stage = `podtree-${location.kind}-close`;
    await chooseTabMenu(page, '연결 종료', pod);
    await expect(pod.locator('.connection-message')).toContainText('PodTree 종료', {
      timeout: 10000,
    });
    if (location.kind === 'ssh')
      await expect
        .poll(
          () =>
            spawnSync('docker', ['exec', fixture, 'test', '!', '-e', temporary], {
              windowsHide: true,
            }).status,
        )
        .toBe(0);
    else
      await expect
        .poll(
          () =>
            spawnSync('wsl', ['-d', 'Ubuntu', '--', 'test', '!', '-e', temporary], {
              windowsHide: true,
            }).status,
        )
        .toBe(0);
    await page
      .getByRole('button', { name: `PodTree · ${context} 탭 닫기`, exact: true })
      .last()
      .click();
    result.checks.push(
      `Actual Kubernetes via ${location.kind}: context/namespace/tree/logs, read-only guards, broadcast exclusion, resize, close/stage cleanup`,
    );
  }

  async function extraPod(namespace, operational) {
    await page
      .locator('summary')
      .filter({ hasText: /^도구$/ })
      .click();
    await page.getByRole('button', { name: 'PodTree 열기', exact: true }).click();
    const d = page.getByRole('dialog', { name: 'PodTree 열기' });
    await d.getByLabel('실행 위치').selectOption(`ssh:${sshId}`);
    await d.getByRole('button', { name: '의존성·context 확인', exact: true }).click();
    await expect(d.getByLabel('context')).toBeEnabled();
    await d.getByLabel('namespace (비우면 전체)').fill(namespace);
    if (operational) await d.getByLabel('운영 모드 사용', { exact: true }).check();
    await d
      .getByRole('button', { name: `전용 탭 열기 · ${operational ? '운영' : '조회'}`, exact: true })
      .click();
    const pane = page
      .getByRole('region', { name: 'PodTree · kind-dachsterm-podtree-check 터미널', exact: true })
      .last();
    await expect(pane.locator('.connection-message')).toContainText('임시 경로');
    const id = await pane.getAttribute('data-connection-id');
    const temp = (await pane.locator('.connection-message').textContent()).match(
      /임시 경로 (\/[^\s]+)/,
    )[1];
    return { pane, id, temp };
  }
  async function closeExtra({ pane, temp }) {
    await chooseTabMenu(page, '연결 종료', pane);
    await expect(pane.locator('.connection-message')).toContainText('PodTree 종료', {
      timeout: 10000,
    });
    await expect
      .poll(
        () =>
          spawnSync('docker', ['exec', fixture, 'test', '!', '-e', temp], { windowsHide: true })
            .status,
      )
      .toBe(0);
    await page
      .getByRole('button', { name: 'PodTree · kind-dachsterm-podtree-check 탭 닫기', exact: true })
      .last()
      .click();
  }
  stage = 'podtree-empty';
  const empty = await extraPod('dachsterm-empty', false);
  await expect(empty.pane.locator('.xterm-accessibility-tree')).toContainText(/0 파드|파드 없음/, {
    timeout: 25000,
  });
  await closeExtra(empty);
  stage = 'podtree-operations';
  const operation = await extraPod('dachsterm-check', true);
  await expect(operation.pane.locator('.xterm-accessibility-tree')).toContainText('log-demo', {
    timeout: 25000,
  });
  await page.waitForTimeout(1800);
  await invoke('podtree_input', { id: operation.id, data: '\u001b[F' });
  await expect(operation.pane.locator('.xterm-accessibility-tree')).toContainText(
    'dachsterm-check/log-demo',
  );
  stage = 'podtree-events';
  await invoke('podtree_input', { id: operation.id, data: 'e' });
  await expect(operation.pane.locator('.xterm-accessibility-tree')).toContainText(
    /Scheduled|Created|Started/,
  );
  await invoke('podtree_input', { id: operation.id, data: '\r' });
  await expect(operation.pane.locator('.xterm-accessibility-tree')).toContainText(
    'ctx:kind-dachsterm-podtree-check',
  );
  stage = 'podtree-forward-confirm';
  await invoke('podtree_input', { id: operation.id, data: 'P' });
  await expect(operation.pane.locator('.xterm-accessibility-tree')).toContainText(
    'local port-forward:',
  );
  await invoke('podtree_input', { id: operation.id, data: 'y' });
  await expect(operation.pane.locator('.xterm-accessibility-tree')).toContainText(
    /local:remote|로컬:원격/,
  );
  await invoke('podtree_input', { id: operation.id, data: '43187:80\r' });
  await expect(operation.pane.locator('.xterm-accessibility-tree')).toContainText(
    'Forwarding from',
  );
  stage = 'podtree-forward-close';
  await closeExtra(operation);
  expect(
    spawnSync('docker', ['exec', fixture, 'pgrep', '-f', 'kubectl.*port-forward'], {
      windowsHide: true,
    }).status,
  ).toBe(1);
  result.checks.push(
    'Actual Kubernetes: empty namespace, events, operational target confirmation, port-forward stream terminated on tab close',
  );
  stage = 'podtree-missing-tool';
  docker([
    'exec',
    fixture,
    'mv',
    '/usr/local/bin/kubectl',
    '/usr/local/bin/kubectl.dachsterm-check',
  ]);
  try {
    await expect(
      invoke('podtree_inspect', { location: { kind: 'ssh', id: sshId }, context: null }),
    ).rejects.toBeTruthy();
  } finally {
    docker([
      'exec',
      fixture,
      'mv',
      '/usr/local/bin/kubectl.dachsterm-check',
      '/usr/local/bin/kubectl',
    ]);
  }
  result.checks.push('Actual SSH missing kubectl is reported; no automatic install');
  stage = 'podtree-unsupported';
  await expect(
    invoke('podtree_inspect', { location: { kind: 'local', id: 'powershell' }, context: null }),
  ).rejects.toBeTruthy();
  result.checks.push(
    'PowerShell rejected as a Bash execution target; restricted RBAC context namespace listing denial surfaced',
  );
  stage = 'ssh-bulk-rotation';
  await page
    .locator('.tab-strip')
    .getByRole('tab')
    .filter({ hasText: '로그 PodTree 검사' })
    .click();
  await invoke('log_start', { id: sshId, options, masks: [] });
  await paste(
    ssh,
    `python3 -c 'import sys; sys.stdout.write(("BULK_"+"x"*95+"\\n")*35000); print("BULK_DONE")'`,
  );
  await expect(ssh.locator('.xterm-accessibility-tree')).toContainText('BULK_DONE', {
    timeout: 30000,
  });
  await invoke('log_action', { id: sshId, action: 'stop' });
  await expect.poll(async () => (await invoke('log_status', { id: sshId })).state).toBe('stopped');
  const bulk = await invoke('log_status', { id: sshId });
  expect(bulk.bytes).toBeGreaterThan(3 * 1048576);
  expect((await readdir(path.dirname(bulk.path))).length).toBe(2);
  result.checks.push('Actual SSH: >3MiB output, 1MiB rotation, two-file retention');
  stage = 'cp949-connect';
  await page.locator('header').getByRole('button', { name: '＋ 새 연결', exact: true }).click();
  const cpform = page.getByRole('dialog');
  await cpform.getByLabel('이름', { exact: true }).fill('CP949 검사');
  await cpform.getByLabel('호스트', { exact: true }).fill('127.0.0.1');
  await cpform.getByLabel('포트', { exact: true }).fill(sshPort);
  await cpform.getByLabel('사용자', { exact: true }).fill('probe');
  await cpform.locator('summary', { hasText: '고급 옵션' }).click();
  await cpform.getByLabel('터미널 인코딩').selectOption('euc-kr');
  await cpform
    .getByLabel('비밀번호', { exact: true })
    .fill(docker(['exec', fixture, 'cat', '/run/probe/password']));
  await cpform.getByRole('button', { name: '저장 후 연결', exact: true }).click();
  const cp = page.getByRole('region', { name: 'CP949 검사 터미널', exact: true });
  await expect(cp.locator('.connection-message')).toContainText('연결됨');
  const cpId = await cp.getAttribute('data-connection-id');
  await paste(cp, 'stty -echo');
  stage = 'cp949-output';
  await invoke('log_start', { id: cpId, options, masks: [] });
  await paste(cp, "printf '\\307'; sleep .1; printf '\\321\\261\\333_CP949\\n'");
  await expect(cp.locator('.xterm-accessibility-tree')).toContainText('한글_CP949');
  await invoke('log_action', { id: cpId, action: 'stop' });
  await expect.poll(async () => (await invoke('log_status', { id: cpId })).state).toBe('stopped');
  expect(await readFile((await invoke('log_status', { id: cpId })).path, 'utf8')).toContain(
    '한글_CP949',
  );
  result.checks.push('Actual OpenSSH: split CP949 bytes decoded into UTF-8 log');
  stage = 'wsl-auto-log';
  await invoke('log_auto', { key: 'local:wsl:Ubuntu', options });
  await page.getByRole('tab', { name: '연결', exact: true }).click();
  await page.locator('.local-targets').getByTitle('Ubuntu 새 터미널 열기').click();
  const wslPane = page.getByRole('region', { name: 'Ubuntu 터미널', exact: true });
  await expect(wslPane.locator('.connection-message')).toContainText('로컬');
  const wslId = await wslPane.getAttribute('data-connection-id');
  await expect
    .poll(async () => (await invoke('log_status', { id: wslId })).state)
    .toBe('recording');
  await paste(wslPane, "printf 'WSL_LOG_한글\\n'");
  await expect(wslPane.locator('.xterm-accessibility-tree')).toContainText('WSL_LOG_한글');
  await chooseTabMenu(page, '연결 종료', wslPane);
  await expect.poll(async () => (await invoke('log_status', { id: wslId })).state).toBe('stopped');
  expect(await readFile((await invoke('log_status', { id: wslId })).path, 'utf8')).toContain(
    'WSL_LOG_한글',
  );
  await invoke('log_auto', { key: 'local:wsl:Ubuntu', options: null });
  result.checks.push('Actual WSL PTY: explicit auto-record, UTF-8, disconnect flush');
  stage = 'podtree-dependent';
  const dependent = await extraPod('dachsterm-check', false);
  await expect(dependent.pane.locator('.xterm-accessibility-tree')).toContainText('log-demo', {
    timeout: 25000,
  });
  stage = 'ssh-detach-log';
  await page
    .locator('.tab-strip')
    .getByRole('tab')
    .filter({ hasText: '로그 PodTree 검사' })
    .click();
  await invoke('log_start', { id: sshId, options, masks: [] });
  await paste(ssh, 'for i in $(seq 1 30); do printf "DETACH_%03d\\n" "$i"; sleep .1; done');
  await chooseTabMenu(page, '새 창으로 분리', ssh);
  await expect.poll(() => browser.contexts().flatMap((c) => c.pages()).length).toBeGreaterThan(1);
  await page.waitForTimeout(4500);
  await invoke('log_action', { id: sshId, action: 'stop' });
  await expect.poll(async () => (await invoke('log_status', { id: sshId })).state).toBe('stopped');
  text = await readFile((await invoke('log_status', { id: sshId })).path, 'utf8');
  expect(text.match(/DETACH_\d{3}/g)).toEqual(
    Array.from({ length: 30 }, (_, i) => `DETACH_${String(i + 1).padStart(3, '0')}`),
  );
  result.checks.push('Actual SSH window handoff: 30 ordered lines recorded exactly once');
  stage = 'podtree-parent-close';
  await invoke('disconnect', { id: sshId });
  await page
    .locator('.tab-strip')
    .getByRole('tab')
    .filter({ hasText: 'PodTree · kind-dachsterm-podtree-check' })
    .click();
  await expect(dependent.pane.locator('.connection-message')).toContainText(/종료|실패/, {
    timeout: 10000,
  });
  await expect
    .poll(
      () =>
        spawnSync('docker', ['exec', fixture, 'test', '!', '-e', dependent.temp], {
          windowsHide: true,
        }).status,
    )
    .toBe(0);
  expect(
    wsl('kubectl --kubeconfig /tmp/dachsterm-podtree-check.config config current-context'),
  ).toBe('kind-dachsterm-podtree-check');
  result.checks.push(
    'Closing SSH parent terminates its PodTree and removes staging; global current-context unchanged',
  );
  for (const p of browser
    .contexts()
    .flatMap((c) => c.pages())
    .filter((p) => p !== page))
    await p
      .evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', {}))
      .catch(() => {});
  await invoke('log_auto', { key: 'local:powershell', options });
  stage = 'normal-close';
  await invoke('plugin:window|close', { label: 'main' }).catch(() => {});
  await expect.poll(() => app.exitCode).toBe(0);

  stage = 'restart-auto-log';
  await browser.close();
  app = spawn(binary, [], {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      DACHSTERM_TEST_DATA_DIR: directory,
      DACHSTERM_TEST_CDP_PORT: String(port),
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview'),
    },
  });
  let restarted;
  for (let i = 0; i < 100; i++) {
    try {
      restarted = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  browser = await chromium.connectOverCDP(restarted.webSocketDebuggerUrl);
  for (let i = 0; i < 100; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('tauri.localhost'));
    if (page) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  page.setDefaultTimeout(15000);
  page.on('pageerror', () => result.errors.push('pageerror'));
  expect(await invoke('log_auto_get', { key: 'local:powershell' })).toEqual(options);
  await page.getByRole('tab', { name: '연결', exact: true }).click();
  await page.locator('.local-targets').getByTitle('Windows PowerShell 새 터미널 열기').click();
  const restartedPane = page.getByRole('region', {
    name: 'Windows PowerShell 터미널',
    exact: true,
  });
  await expect(restartedPane.locator('.connection-message')).toContainText('로컬');
  const restartedId = await restartedPane.getAttribute('data-connection-id');
  await expect
    .poll(async () => (await invoke('log_status', { id: restartedId })).state)
    .toBe('recording');
  await paste(restartedPane, "Write-Output ('RESTART_'+'RECORDED')");
  await expect(restartedPane.locator('.xterm-accessibility-tree')).toContainText(
    'RESTART_RECORDED',
  );
  await invoke('log_action', { id: restartedId, action: 'stop' });
  await expect
    .poll(async () => (await invoke('log_status', { id: restartedId })).state)
    .toBe('stopped');
  expect(await readFile((await invoke('log_status', { id: restartedId })).path, 'utf8')).toContain(
    'RESTART_RECORDED',
  );
  stage = 'log-narrow-dark';
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 560,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.evaluate(() => {
    localStorage.setItem('dachsterm.theme', 'github-dark');
    window.dispatchEvent(new StorageEvent('storage', { key: 'dachsterm.theme' }));
  });
  await page.getByRole('button', { name: '사이드바', exact: true }).click();
  await chooseTabMenu(page, '세션 기록', restartedPane);
  const logDialog = page.getByRole('dialog', { name: '세션 로그' });
  await expect(logDialog).toBeVisible();
  const bounds = await logDialog.boundingBox();
  expect(bounds.width).toBeLessThanOrEqual(560);
  await logDialog.getByRole('button', { name: '자동 기록 끄기', exact: true }).click();
  await expect(logDialog).toContainText('자동 기록: 꺼짐');
  await page.screenshot({ path: 'target/verification/session-log-narrow-dark.png' });
  await logDialog.getByRole('button', { name: '대화상자 닫기' }).click();
  result.checks.push(
    'Actual app restart restores explicit auto-log settings; fresh UTF-8 recording; 560px dark dialog and controls',
  );
  stage = 'restart-normal-close';
  await invoke('plugin:window|close', { label: 'main' }).catch(() => {});
  await expect.poll(() => app.exitCode).toBe(0);
  result.sha256 = createHash('sha256')
    .update(await readFile(binary))
    .digest('hex');
  result.normalExit = app.exitCode;
  expect(result.errors).toEqual([]);
  await mkdir('target/verification', { recursive: true });
  await writeFile('target/verification/phase63-67-native.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  if (stage.startsWith('podtree-')) console.error(String(error));
  console.error(`Phase 6.3/6.7 failed at ${stage}`);
  process.exitCode = 1;
  if (page && !['ssh-connect', 'cp949-connect', 'fixture'].includes(stage)) {
    await mkdir('target/verification', { recursive: true });
    await page.screenshot({ path: 'target/verification/phase63-67-failure.png' }).catch(() => {});
    console.error(
      JSON.stringify(
        await page
          .evaluate(() => ({
            messages: Array.from(document.querySelectorAll('.connection-message,[role=alert]')).map(
              (e) => e.textContent,
            ),
            dialogs: Array.from(document.querySelectorAll('dialog[open]')).map((e) =>
              e.textContent?.slice(-1500),
            ),
          }))
          .catch(() => ({})),
      ),
    );
  }
} finally {
  await browser?.close();
  if (app?.pid && app.exitCode === null)
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  if (created) docker(['rm', '-f', fixture]);
}
