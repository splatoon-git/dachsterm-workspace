// Built app + real local PTY and ephemeral OpenSSH. Never print credential-bearing errors.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import {
  chooseTabMenu,
  foldSidebar,
  openNewConnectionForm,
  showSidebarView,
} from './native-workspace.mjs';
const binary = process.env.DACHSTERM_TEST_BINARY ?? path.resolve('target/debug/dachsterm.exe');
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-session-log-'));
const fixture = `dachsterm-session-log-${randomUUID()}`;
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
    'app.dachsterm.purpose=session-log-verification',
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
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
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
  await showSidebarView(page, '연결');
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
  await openNewConnectionForm(page);
  const form = page.getByRole('dialog');
  await form.getByLabel('이름', { exact: true }).fill('세션 로그 검사');
  await form.getByLabel('호스트', { exact: true }).fill('127.0.0.1');
  await form.getByLabel('포트', { exact: true }).fill(sshPort);
  await form.getByLabel('사용자', { exact: true }).fill('probe');
  await form.getByLabel('비밀번호', { exact: true }).fill(password);
  password = '';
  await form.getByRole('button', { name: '저장 후 연결', exact: true }).click();
  await expect(page.locator('.trust-card code')).toHaveText(fingerprint);
  await page.getByRole('button', { name: '지문 확인 · 신뢰하고 연결', exact: true }).click();
  const ssh = page.getByRole('region', { name: '세션 로그 검사 터미널', exact: true });
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
  stage = 'ssh-bulk-rotation';
  await page.locator('.tab-strip').getByRole('tab').filter({ hasText: '세션 로그 검사' }).click();
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
  await openNewConnectionForm(page);
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
  await showSidebarView(page, '연결');
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
  stage = 'ssh-detach-log';
  await page.locator('.tab-strip').getByRole('tab').filter({ hasText: '세션 로그 검사' }).click();
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
  await showSidebarView(page, '연결');
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
  await foldSidebar(page);
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
  await writeFile('target/verification/session-log-native.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch {
  console.error(`Session log check failed at ${stage}`);
  process.exitCode = 1;
  if (page && !['ssh-connect', 'cp949-connect', 'fixture'].includes(stage)) {
    await mkdir('target/verification', { recursive: true });
    await page.screenshot({ path: 'target/verification/session-log-failure.png' }).catch(() => {});
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
