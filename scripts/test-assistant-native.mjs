// Isolated real WebView2 + local PTY + disposable OpenSSH verification.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import { commands, guideHook } from '../src/features/terminal/guideData.ts';
const binary = process.env.DAXTERM_TEST_BINARY ?? path.resolve('target/debug/daxterm.exe');
const directory = await mkdtemp(path.join(tmpdir(), 'daxterm-assistant-'));
const fixture = `daxterm-assistant-${randomUUID()}`;
const result = { checks: [], pageErrors: 0 };
let app,
  browser,
  page,
  created = false,
  stage = 'fixture';
const docker = (args) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0) throw Error(`Docker ${args[0]} failed`);
  return r.stdout.trim();
};
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
async function launch() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  app = spawn(binary, [], {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      DAXTERM_TEST_DATA_DIR: directory,
      DAXTERM_TEST_CDP_PORT: String(port),
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview'),
    },
  });
  let endpoint;
  for (let i = 0; i < 100; i++) {
    try {
      endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!endpoint) throw Error('CDP unavailable');
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  for (let i = 0; i < 80; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('tauri.localhost'));
    if (page) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!page) throw Error('app unavailable');
  page.setDefaultTimeout(15000);
  page.on('pageerror', () => result.pageErrors++);
  await expect(page.locator('.local-targets')).toBeVisible();
}
const text = (pane) => pane.locator('.xterm-accessibility-tree');
async function enter(pane, body) {
  const input = pane.locator('.xterm-helper-textarea');
  await input.focus();
  await input.evaluate((e, value) => {
    const d = new DataTransfer();
    d.setData('text/plain', value);
    e.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }),
    );
  }, body);
  await input.press('Enter');
}
async function tools(name) {
  await page
    .locator('summary')
    .filter({ hasText: /^도구$/ })
    .click();
  await page.getByRole('button', { name, exact: true }).click();
}
try {
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    fixture,
    '--label',
    'app.daxterm.purpose=assistant-verification',
    '-p',
    '127.0.0.1::22',
    '--tmpfs',
    '/run/probe:rw,noexec,nosuid,mode=0700',
    'daxterm-openssh-probe',
  ]);
  created = true;
  for (let i = 0; i < 80; i++) {
    if (
      spawnSync('docker', ['exec', fixture, 'test', '-f', '/run/probe/ready'], {
        stdio: 'ignore',
        windowsHide: true,
      }).status === 0
    )
      break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const port = docker(['port', fixture, '22/tcp']).split(':').at(-1);
  let password = docker(['exec', fixture, 'cat', '/run/probe/password']);
  const fingerprint = docker(['exec', fixture, 'ssh-keygen', '-lf', '/run/probe/host.pub']).split(
    /\s+/,
  )[1];
  await writeFile(path.join(directory, 'guide-hook.sh'), guideHook + '\n');
  await writeFile(path.join(directory, 'assistant-commands.json'), JSON.stringify(commands));
  docker(['cp', path.join(directory, 'guide-hook.sh'), `${fixture}:/tmp/guide-hook.sh`]);
  docker([
    'cp',
    path.join(directory, 'assistant-commands.json'),
    `${fixture}:/tmp/assistant-commands.json`,
  ]);
  docker(['cp', 'tests/assistant-linux.py', `${fixture}:/tmp/assistant-linux.py`]);
  docker(['exec', fixture, 'ln', '-s', '/usr/bin/vim.tiny', '/usr/local/bin/vim']);
  docker(['exec', fixture, 'bash', '-c', 'seq 1 200 > /tmp/guide-pages']);
  docker(['exec', fixture, 'python3', '/tmp/assistant-linux.py']);
  result.checks.push('Linux real commands and filters including live buffering, rotation, SIGINT');
  stage = 'launch';
  await launch();
  await page.locator('.local-targets').getByTitle('Windows PowerShell 새 터미널 열기').click();
  const local = page.getByRole('region', { name: 'Windows PowerShell 터미널', exact: true });
  await expect(text(local)).toContainText('PS C:');
  const localId = await local.getAttribute('data-connection-id');
  stage = 'local-snippet';
  await tools('스니펫');
  let dialog = page.getByRole('dialog', { name: '스니펫', exact: true });
  await dialog.getByLabel('이름', { exact: true }).fill('검증 스니펫');
  await dialog.getByLabel('명령 본문', { exact: true }).fill("Write-Output ('LOCAL_{{value}}')");
  await dialog.getByLabel('저장 내용에 인증정보가 없습니다.').check();
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('저장했습니다');
  await dialog.getByLabel('value', { exact: true }).fill('한글');
  await dialog.getByRole('button', { name: '입력만 넣기 · 미리보기' }).click();
  await dialog.getByRole('button', { name: '확인 · 입력' }).click();
  await expect(dialog.getByRole('status')).toContainText('입력 전달됨');
  await dialog.getByRole('button', { name: '대화상자 닫기' }).click();
  // The echoed command contains parentheses; output alone is a separate accessibility row.
  expect(await text(local).innerText()).not.toMatch(/(?:^|\n)LOCAL_한글(?:\n|$)/);
  await local.locator('.xterm-helper-textarea').press('Enter');
  await expect(text(local)).toContainText('LOCAL_한글');
  result.checks.push('Native snippet CRUD, literal variable, PowerShell input-only then Enter');
  stage = 'ssh-auth';
  await page.locator('header').getByRole('button', { name: '＋ 새 연결', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('이름', { exact: true }).fill('스니펫 SSH');
  await dialog.getByLabel('호스트', { exact: true }).fill('127.0.0.1');
  await dialog.getByLabel('포트', { exact: true }).fill(port);
  await dialog.getByLabel('사용자', { exact: true }).fill('probe');
  await dialog.getByLabel('비밀번호', { exact: true }).fill(password);
  password = '';
  await dialog.getByRole('button', { name: '저장 후 연결', exact: true }).click();
  await expect(page.locator('.trust-card code')).toHaveText(fingerprint);
  await page.getByRole('button', { name: '지문 확인 · 신뢰하고 연결', exact: true }).click();
  const ssh = page.getByRole('region', { name: '스니펫 SSH 터미널', exact: true });
  await expect(ssh.locator('.connection-message')).toContainText('연결됨');
  const sshId = await ssh.getAttribute('data-connection-id');
  await enter(ssh, 'stty -echo');
  stage = 'broadcast-isolation';
  await invoke('broadcast_set', { ids: [localId, sshId] });
  await tools('스니펫');
  dialog = page.getByRole('dialog', { name: '스니펫', exact: true });
  await dialog
    .getByLabel('명령 본문', { exact: true })
    .fill("printf 'SSH_ONLY_%s\\n' '한글'; printf x >> /tmp/snippet-once");
  await dialog.getByRole('button', { name: 'Enter 포함 실행 · 미리보기' }).click();
  await dialog.getByRole('button', { name: '확인 · 실행' }).click();
  await expect(dialog.getByRole('status')).toContainText('입력 전달됨');
  await dialog.getByRole('button', { name: '대화상자 닫기' }).click();
  await expect(text(ssh)).toContainText('SSH_ONLY_한글');
  expect(docker(['exec', fixture, 'cat', '/tmp/snippet-once'])).toBe('x');
  await page.getByRole('tab', { name: /Windows PowerShell/ }).click();
  expect(await text(local).innerText()).not.toContain('SSH_ONLY');
  await page.getByRole('tab', { name: /스니펫 SSH/ }).click();
  const delivered = await invoke('snippet_send', {
    targets: [
      { id: sshId, bracketed: true },
      { id: localId, bracketed: false },
    ],
    body: 'echo GROUP_ONCE',
    execute: true,
  });
  expect(delivered.every((r) => !r.error)).toBe(true);
  await expect(text(ssh)).toContainText('GROUP_ONCE');
  await page.getByRole('tab', { name: /Windows PowerShell/ }).click();
  await expect(text(local)).toContainText('GROUP_ONCE');
  await page.getByRole('tab', { name: /스니펫 SSH/ }).click();
  const partial = await invoke('snippet_send', {
    targets: [
      { id: 'closed-fixture', bracketed: false },
      { id: sshId, bracketed: true },
    ],
    body: 'echo PARTIAL_OK',
    execute: true,
  });
  expect(partial[0].error).toBeTruthy();
  expect(partial[1].error).toBeNull();
  await expect(text(ssh)).toContainText('PARTIAL_OK');
  await invoke('broadcast_set', { ids: [] });
  await invoke('snippet_send', {
    targets: [{ id: sshId, bracketed: true }],
    body: "printf 'MULTI_A\\n'\nprintf 'MULTI_B_한글\\n'",
    execute: true,
  });
  await expect(text(ssh)).toContainText('MULTI_B_한글');
  result.checks.push(
    'Real SSH UTF-8, exactly once with broadcast on, selected SSH/local, per-target failure isolation',
  );
  stage = 'guide';
  await enter(ssh, 'source /tmp/guide-hook.sh');
  await ssh.getByRole('button', { name: /조작표 .*열기/ }).click();
  await ssh.getByLabel('실행 알림 사용').check();
  for (const [program, command, exit] of [
    ['vi', 'vi /tmp/guide-file', ':q!'],
    ['vim', 'vim /tmp/guide-file', ':q!'],
    ['less', 'less /tmp/guide-pages', 'q'],
    ['cat', 'cat', null],
    ['tail', 'tail -f /etc/hostname', null],
  ]) {
    await enter(ssh, command);
    await expect(
      ssh.getByRole('button', { name: new RegExp(`조작표 · ${program} 접기`) }),
    ).toBeVisible();
    expect(docker(['exec', fixture, 'pgrep', '-u', 'probe', '-x', program])).toMatch(/\d+/);
    const input = ssh.locator('.xterm-helper-textarea');
    await input.focus();
    if (exit === null) await input.press('Control+c');
    else if (exit === 'q') await input.press('q');
    else {
      await input.press('Escape');
      await input.type(exit);
      await input.press('Enter');
    }
    await expect(ssh.getByRole('button', { name: '조작표 접기', exact: true })).toBeVisible();
  }
  await ssh.getByLabel('조작표 선택·고정').selectOption('vim');
  await enter(ssh, 'cat /etc/hostname');
  await expect(ssh.getByRole('button', { name: '조작표 · vim 접기', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /Windows PowerShell/ }).click();
  await expect(local.getByRole('button', { name: '조작표 열기', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /스니펫 SSH/ }).click();
  result.checks.push(
    'Real Bash vi/vim/less/cat/tail entry/exit including Ctrl+C, manual pin survives, tab isolation',
  );
  stage = 'wsl';
  await page.locator('.local-targets').getByTitle('Ubuntu 새 터미널 열기').click();
  const wsl = page.getByRole('region', { name: 'Ubuntu 터미널', exact: true });
  const wslId = await wsl.getAttribute('data-connection-id');
  await expect(wsl.locator('.connection-message')).toContainText('로컬');
  const nativeHookPath = path.join(directory, 'guide-hook.sh').replaceAll('\\', '/');
  const linuxHookPath = '/mnt/' + nativeHookPath[0].toLowerCase() + nativeHookPath.slice(2);
  await enter(wsl, `source '${linuxHookPath}'`);
  await wsl.getByRole('button', { name: '조작표 열기', exact: true }).click();
  await wsl.getByLabel('실행 알림 사용').check();
  await invoke('snippet_send', {
    targets: [{ id: wslId, bracketed: true }],
    body: "printf 'WSL_한글\\n'",
    execute: true,
  });
  await expect(text(wsl)).toContainText('WSL_한글');
  await enter(wsl, 'cat');
  await expect(wsl.getByRole('button', { name: '조작표 · cat 접기', exact: true })).toBeVisible();
  await wsl.locator('.xterm-helper-textarea').press('Control+c');
  await expect(wsl.getByRole('button', { name: '조작표 접기', exact: true })).toBeVisible();
  result.checks.push('Actual local WSL snippet UTF-8 and Bash cat metadata/Ctrl+C');
  stage = 'detached';
  await page.getByRole('tab', { name: /스니펫 SSH/ }).click();
  await page.getByRole('button', { name: '새 창으로 분리 ↗', exact: true }).click();
  let detached;
  await expect
    .poll(() => {
      detached = browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p !== page && p.url().includes('detached='));
      return !!detached;
    })
    .toBe(true);
  await detached.getByRole('button', { name: '스니펫', exact: true }).click();
  const detachedDialog = detached.getByRole('dialog', { name: '스니펫', exact: true });
  await detachedDialog.getByLabel('명령 본문', { exact: true }).fill('echo DETACHED_ONCE');
  await detachedDialog.getByRole('button', { name: 'Enter 포함 실행 · 미리보기' }).click();
  await detachedDialog.getByRole('button', { name: '확인 · 실행' }).click();
  await expect(detachedDialog.getByRole('status')).toContainText('입력 전달됨');
  await detachedDialog.getByRole('button', { name: '대화상자 닫기' }).click();
  await expect(detached.locator('.xterm-accessibility-tree')).toContainText('DETACHED_ONCE');
  const denied = await invoke('snippet_send', {
    targets: [{ id: sshId, bracketed: true }],
    body: 'echo OWNER_DENIED',
    execute: true,
  });
  expect(denied[0].error).toBeTruthy();
  await detached
    .evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close'))
    .catch(() => {});
  result.checks.push(
    'Detached window snippet UI, exactly scoped delivery and main-window ownership rejection',
  );
  stage = 'theme';
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 560,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.evaluate(() => {
    localStorage.setItem('daxterm.theme', 'github-dark');
    window.dispatchEvent(new StorageEvent('storage', { key: 'daxterm.theme' }));
  });
  await tools('기본 명령·로그 필터');
  await mkdir('target/verification', { recursive: true });
  await page.screenshot({ path: 'target/verification/assistant-native-dark.png' });
  await page.getByRole('button', { name: '대화상자 닫기' }).click();
  stage = 'restart';
  await invoke('plugin:window|close', { label: 'main' }).catch(() => {});
  await expect.poll(() => app.exitCode).toBe(0);
  await browser.close();
  await launch();
  await tools('스니펫');
  dialog = page.getByRole('dialog', { name: '스니펫', exact: true });
  await dialog.getByRole('button', { name: '검증 스니펫' }).click();
  await expect(dialog.getByLabel('명령 본문', { exact: true })).toHaveValue(
    "Write-Output ('LOCAL_{{value}}')",
  );
  await expect(dialog.getByLabel('value', { exact: true })).toHaveValue('');
  result.checks.push(
    'Actual app restart restores SQLite snippets without transient values or automatic execution',
  );
  await dialog.getByRole('button', { name: '대화상자 닫기' }).click();
  await invoke('plugin:window|close', { label: 'main' }).catch(() => {});
  await expect.poll(() => app.exitCode).toBe(0);
  expect(result.pageErrors).toBe(0);
  result.sha256 = createHash('sha256')
    .update(await readFile(binary))
    .digest('hex');
  await writeFile('target/verification/assistant-native.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`Assistant verification failed at ${stage}`);
  if (stage !== 'ssh-auth' && stage !== 'fixture') {
    console.error(String(error));
    await page
      ?.screenshot({ path: 'target/verification/assistant-native-failure.png' })
      .catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (app?.pid && app.exitCode === null)
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  if (created) docker(['rm', '-f', fixture]);
}
