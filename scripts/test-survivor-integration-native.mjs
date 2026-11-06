// Built app + real local PTY and ephemeral OpenSSH. Never print credential-bearing errors.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
const binary = process.env.DACHSTERM_TEST_BINARY ?? path.resolve('target/debug/dachsterm.exe');
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-survivor-integration-'));
const fixture = `dachsterm-survivor-${randomUUID()}`;
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
    'app.dachsterm.purpose=survivor-isolation',
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
  const openGame = async () => {
    const launcher = page.locator('.sidebar-games');
    if ((await launcher.getAttribute('open')) === null) await launcher.locator('summary').click();
    await page
      .getByRole('navigation', { name: '게임 목록' })
      .getByRole('button', { name: '닥스의 서바이버', exact: true })
      .click();
    await expect(page.locator('.survivor-game')).toBeVisible();
  };
  stage = 'local-open';
  await page.locator('.local-targets').getByTitle('Windows PowerShell 새 터미널 열기').click();
  const local = page.getByRole('region', { name: 'Windows PowerShell 터미널', exact: true });
  await expect(local.locator('.xterm-accessibility-tree')).toContainText('PS C:');
  const localId = await local.getAttribute('data-connection-id');
  stage = 'ssh-connect';
  await page.locator('header').getByRole('button', { name: '＋ 새 연결', exact: true }).click();
  const form = page.getByRole('dialog');
  await form.getByLabel('이름', { exact: true }).fill('서바이버 격리 검사');
  await form.getByLabel('호스트', { exact: true }).fill('127.0.0.1');
  await form.getByLabel('포트', { exact: true }).fill(sshPort);
  await form.getByLabel('사용자', { exact: true }).fill('probe');
  await form.getByLabel('비밀번호', { exact: true }).fill(password);
  password = '';
  await form.getByRole('button', { name: '저장 후 연결', exact: true }).click();
  await expect(page.locator('.trust-card code')).toHaveText(fingerprint);
  await page.getByRole('button', { name: '지문 확인 · 신뢰하고 연결', exact: true }).click();
  const ssh = page.getByRole('region', { name: '서바이버 격리 검사 터미널', exact: true });
  await expect(ssh.locator('.connection-message')).toContainText('연결됨');
  const sshId = await ssh.getAttribute('data-connection-id');
  await paste(ssh, 'stty -echo');
  for (const [name, pane, command, marker] of [
    [
      'ssh',
      ssh,
      `printf 'ISOLATION_READY\\n'; IFS= read -r v; printf 'SURVIVOR_INPUT<%s>\\n' "$v"`,
      'ISOLATION_READY',
    ],
    [
      'local',
      local,
      `$v = Read-Host 'ISOLATION_READY'; Write-Output ('SURVIVOR'+'_INPUT<'+$v+'>')`,
      'ISOLATION_READY:',
    ],
  ]) {
    stage = `${name}-isolation`;
    await page
      .locator('.tab-strip')
      .getByRole('tab')
      .filter({ hasText: name === 'ssh' ? '서바이버 격리 검사' : 'Windows PowerShell' })
      .click();
    stage = `${name}-read-command`;
    await paste(pane, command);
    await expect(pane.locator('.xterm-accessibility-tree')).toContainText(marker);
    await openGame();
    stage = `${name}-game-start`;
    if ((await page.locator('.survivor-game').getAttribute('data-phase')) === 'hub')
      await page.getByRole('button', { name: '새 도전 시작', exact: true }).click();
    else if (await page.getByRole('button', { name: '계속하기', exact: true }).isVisible())
      await page.getByRole('button', { name: '계속하기', exact: true }).click();
    const game = page.locator('.survivor-game');
    await expect(game).toHaveAttribute('data-phase', 'playing');
    for (const key of [
      'w',
      'a',
      's',
      'd',
      'ArrowLeft',
      'ArrowRight',
      '1',
      '2',
      '3',
      'r',
      'm',
      'Space',
      'Enter',
      'p',
      'p',
    ])
      await page.keyboard.press(key);
    stage = `${name}-natural-card`;
    // A natural card screen is also exercised; no engine/state injection.
    await expect(game).toHaveAttribute('data-phase', 'choosing', { timeout: 35000 });
    await page.keyboard.press('r');
    await page.keyboard.press('2');
    stage = `${name}-pause`;
    await page.keyboard.press('p');
    await expect(game).toHaveAttribute('data-phase', 'paused');
    const frozen = await game.locator('canvas').getAttribute('data-tick');
    await page.waitForTimeout(1100);
    expect(await game.locator('canvas').getAttribute('data-tick')).toBe(frozen);
    await page.keyboard.press('Escape');
    stage = `${name}-empty-input`;
    await expect(pane).toHaveAttribute('data-connection-id', name === 'ssh' ? sshId : localId);
    await pane.locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Enter');
    await expect(pane.locator('.xterm-accessibility-tree')).toContainText('SURVIVOR_INPUT<>');
    await paste(
      pane,
      name === 'ssh' ? `printf 'AFTER_SURVIVOR_OK\\n'` : `Write-Output ('AFTER_SURVIVOR'+'_OK')`,
    );
    await expect(pane.locator('.xterm-accessibility-tree')).toContainText('AFTER_SURVIVOR_OK');
    result.checks.push(
      `${name}: empty pending input, unchanged connection, post-game output, natural card, pause`,
    );
  }
  stage = 'ten-tab-lifecycles';
  const cdp = await page.context().newCDPSession(page);
  result.lifecycleHeaps = [];
  // Each round really mounts, acquires its profile lock, starts, pauses, settles,
  // unmounts and releases the lock. These are short rounds, not ten full boss runs.
  await page.getByRole('button', { name: '닥스의 서바이버 탭 닫기', exact: true }).click();
  for (let i = 0; i < 11; i++) {
    await openGame();
    await page.getByRole('button', { name: '새 도전 시작', exact: true }).click();
    await page.keyboard.down('d');
    await page.waitForTimeout(300);
    await page.keyboard.up('d');
    await page.keyboard.press('p');
    await expect(page.locator('.survivor-game')).toHaveAttribute('data-phase', 'paused');
    await page.getByRole('button', { name: '닥스의 서바이버 탭 닫기', exact: true }).click();
    await expect(page.locator('.survivor-game')).toHaveCount(0);
    await page.waitForTimeout(100);
    await cdp.send('HeapProfiler.collectGarbage');
    result.lifecycleHeaps.push({
      round: i,
      usedBytes: (await cdp.send('Runtime.getHeapUsage')).usedSize,
      dom: await cdp.send('Memory.getDOMCounters'),
    });
  }
  stage = 'normal-close';
  await openGame();
  await page
    .evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }))
    .catch(() => {});
  await expect.poll(() => app.exitCode).toBe(0);
  result.sha256 = createHash('sha256')
    .update(await readFile(binary))
    .digest('hex');
  result.normalExit = app.exitCode;
  expect(result.errors).toEqual([]);
  await mkdir('target/verification', { recursive: true });
  await writeFile(
    'target/verification/survivor-integration-native.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch {
  // Locator traces may contain secrets. Only report the fixed stage name.
  console.error(`Survivor integration failed at ${stage}`);
  process.exitCode = 1;
  if (
    page &&
    /^(ssh|local)-(read-command|game-start|natural-card|pause|empty-input)$/.test(stage)
  ) {
    await mkdir('target/verification', { recursive: true });
    await page.screenshot({ path: 'target/verification/survivor-isolation-failure.png' });
    console.error(
      JSON.stringify(
        await page.evaluate(() => ({
          phase: document.querySelector('.survivor-game')?.getAttribute('data-phase'),
          tabs: Array.from(document.querySelectorAll('[role=tab]')).map((e) => e.textContent),
          game: document.querySelector('.survivor-game')?.textContent?.slice(-1000),
        })),
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
