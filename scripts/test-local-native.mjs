// Local PTY integration in Windows WebView2. Isolated app data; no remote credentials.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

if (process.platform !== 'win32') throw new Error('Windows WebView2 is required.');
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-local-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app, browser;
async function launch() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  app = spawn(path.resolve('target/debug/dachsterm.exe'), [], {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      DACHSTERM_TEST_DATA_DIR: directory,
      DACHSTERM_TEST_CDP_PORT: String(port),
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview'),
    },
  });
  let endpoint;
  for (let i = 0; i < 80; i++) {
    try {
      endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!endpoint) throw new Error('Test app debugging endpoint unavailable.');
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  for (let i = 0; i < 40; i++) {
    const page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('tauri.localhost'));
    if (page) {
      await expect(page.getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
      return page;
    }
    await sleep(250);
  }
  throw new Error('Test app page unavailable.');
}
async function shutdown() {
  if (app?.pid && app.exitCode === null) {
    spawnSync('taskkill', ['/PID', String(app.pid)], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 40 && app.exitCode === null; i++) await sleep(100);
    if (app.exitCode === null) app.kill();
  }
  await browser?.close().catch(() => {});
  browser = undefined;
}
try {
  const page = await launch();
  await expect(
    page.locator('.local-targets').getByTitle('Windows PowerShell 새 터미널 열기'),
  ).toBeVisible({ timeout: 15000 });
  const names = await page.locator('.local-targets .local-target').allTextContents();
  console.log('Discovered local targets:', names);
  await page.locator('.local-targets').getByTitle('Windows PowerShell 새 터미널 열기').click();
  let pane = page.getByRole('region', { name: 'Windows PowerShell 터미널', exact: true });
  await expect(pane.locator('.connection-message')).toContainText('로컬 · Windows PowerShell');
  await expect(page.locator('.monitor-bar')).toHaveCount(0);
  await expect(page.locator('.files')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '새 창으로 분리 ↗' })).toBeDisabled();
  async function command(pane, text, expected) {
    const input = pane.locator('.xterm-helper-textarea');
    await input.focus();
    await expect(input).toBeFocused();
    await input.evaluate((element, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, text);
    await input.press('Enter');
    await expect(pane.locator('.xterm-accessibility-tree')).toContainText(
      expected === 'LOCALPID:' ? /LOCALPID:\d+/ : expected === 'SIZE:' ? /SIZE:\d+/ : expected,
      {
        timeout: 15000,
      },
    );
  }
  await expect(pane.locator('.xterm-accessibility-tree')).toContainText('PS C:', {
    timeout: 15000,
  });
  await command(pane, "Write-Output ('DACHSTERM' + 'LOCAL_OK')", 'DACHSTERMLOCAL_OK');
  await command(pane, 'Write-Output ([char]0xD55C + [string][char]0xAE00)', '한글');
  await command(pane, "Write-Output ('LOCAL' + 'PID:' + $PID)", 'LOCALPID:');
  const localPid = Number(
    (await pane.locator('.xterm-accessibility-tree').innerText()).match(/LOCALPID:(\d+)/)?.[1],
  );
  expect(localPid).toBeGreaterThan(0);
  const originalId = await pane.getAttribute('data-connection-id');
  await pane.locator('.xterm').evaluate((e) => e.setAttribute('data-instance', 'original'));
  await page.getByRole('tab', { name: '원격 파일', exact: true }).click();
  await expect(page.locator('#file-sidebar')).toContainText('로컬 터미널 사용 중');
  await page.getByRole('tab', { name: '연결', exact: true }).click();
  await expect(pane).toHaveAttribute('data-connection-id', originalId);
  await expect(pane.locator('.xterm')).toHaveAttribute('data-instance', 'original');
  const heights = await pane
    .locator('.terminal-tools button, .terminal-tools input')
    .evaluateAll((elements) => elements.map((e) => e.getBoundingClientRect().height));
  expect(heights.every((height) => height === 32)).toBe(true);
  await pane.getByRole('button', { name: '터미널 설정', exact: true }).click();
  await page
    .getByRole('dialog', { name: '터미널 설정' })
    .getByLabel('글꼴 크기')
    .selectOption('16');
  await page.keyboard.press('Escape');
  await expect(pane.getByRole('button', { name: '터미널 설정', exact: true })).toBeFocused();
  await pane.getByRole('button', { name: '터미널 설정', exact: true }).click();
  await page
    .getByRole('dialog', { name: '터미널 설정' })
    .getByLabel('글꼴 크기')
    .selectOption('14');
  await page.keyboard.press('Escape');
  await mkdir('test-results-native', { recursive: true });
  await page.screenshot({ path: path.resolve('test-results-native/unified-local.png') });
  await command(pane, "Write-Output ('SI' + 'ZE:' + $Host.UI.RawUI.WindowSize.Width)", 'SIZE:');
  const initialWidth = Number(
    (await pane.locator('.xterm-accessibility-tree').innerText()).match(/SIZE:(\d+)/)?.[1],
  );
  await page.setViewportSize({ width: 900, height: 650 });
  await command(
    pane,
    "Write-Output ('RESIZE' + ':' + $Host.UI.RawUI.WindowSize.Width)",
    /RESIZE:\d+/,
  );
  const widths = [
    ...(await pane.locator('.xterm-accessibility-tree').innerText()).matchAll(/RESIZE:(\d+)/g),
  ];
  expect(Number(widths.at(-1)?.[1])).toBeLessThan(initialWidth);
  await page.getByRole('button', { name: '로컬 터미널', exact: true }).click();
  await page
    .getByRole('dialog', { name: '로컬 터미널 열기' })
    .getByRole('button', { name: '명령 프롬프트 로컬 셸' })
    .click();
  const cmd = page.getByRole('region', { name: '명령 프롬프트 터미널', exact: true });
  await expect(cmd.locator('.xterm-accessibility-tree')).toContainText('>', { timeout: 15000 });
  await command(cmd, 'echo DACHSTERM^CMD_OK', 'DACHSTERMCMD_OK');
  await page.getByRole('button', { name: '좌우', exact: true }).click();
  await expect(pane).toBeVisible();
  await expect(cmd).toBeVisible();
  // A font change in one pane must reach the other pane in the same window.
  for (const size of ['18', '14']) {
    await pane.getByRole('button', { name: '터미널 설정', exact: true }).click();
    await page
      .getByRole('dialog', { name: '터미널 설정' })
      .getByLabel('글꼴 크기')
      .selectOption(size);
    await page.keyboard.press('Escape');
    await expect(cmd.locator('.xterm-rows')).toHaveCSS('font-size', `${size}px`);
  }
  await cmd.getByRole('button', { name: '연결 종료', exact: true }).click();
  await expect(cmd.locator('.connection-message')).toContainText('종료', { timeout: 15000 });
  await cmd.getByRole('button', { name: '재접속', exact: true }).click();
  await expect(cmd.locator('.connection-message')).toContainText('로컬 · 명령 프롬프트');
  await expect(cmd.locator('.xterm-accessibility-tree')).toContainText('>', { timeout: 15000 });
  await command(cmd, 'echo REOPEN^_OK', 'REOPEN_OK');
  await page.getByRole('button', { name: '명령 프롬프트 탭 닫기', exact: true }).click();
  await expect(cmd).toHaveCount(0);
  await page.screenshot({ path: path.resolve('test-results-native/local-split-before-input.png') });
  await command(pane, "Write-Output ('SURVIVE' + '_OK')", 'SURVIVE_OK');
  await page.getByRole('button', { name: '단일', exact: true }).click();
  await mkdir('test-results-native', { recursive: true });
  await page.screenshot({ path: 'test-results-native/local-terminal.png' });
  const wsl = page
    .locator('.local-targets .local-target')
    .filter({ hasText: 'WSL' })
    .filter({ hasNotText: 'docker-desktop' });
  if (await wsl.count()) {
    const title = await wsl.first().locator('span').textContent();
    await wsl.first().click();
    const linux = page.getByRole('region', { name: `${title} 터미널`, exact: true });
    await expect(linux.locator('.connection-message')).toContainText('로컬 ·');
    await expect(linux.locator('.xterm-accessibility-tree')).toContainText(/[$#]/, {
      timeout: 15000,
    });
    await command(linux, "printf 'DACHSTERM%s\\n' WSL_OK", 'DACHSTERMWSL_OK');
    await command(linux, 'exit', '');
    await expect(linux.locator('.connection-message')).toContainText('종료', { timeout: 15000 });
    await page.screenshot({ path: 'test-results-native/local-wsl.png' });
    console.log('WSL interactive PTY passed.');
  } else console.log('WSL user distribution absent: real WSL execution pending.');
  // Return to PowerShell before checking shortcuts do not reach the PTY.
  await page.getByRole('tab', { name: /Windows PowerShell/ }).click();
  await page.keyboard.press('Control+Shift+B');
  await expect(page.getByRole('complementary', { name: '세션 탐색' })).toBeHidden();
  await page.keyboard.press('Control+Shift+F');
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.getByRole('button', { name: 'Windows PowerShell 탭 닫기' }).click();
  await expect
    .poll(() =>
      spawnSync('tasklist', ['/FI', `PID eq ${localPid}`, '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      }).stdout.includes(` ${localPid} `),
    )
    .toBe(false);
  await page.locator('.local-targets').getByTitle('Windows PowerShell 새 터미널 열기').click();
  pane = page.getByRole('region', { name: 'Windows PowerShell 터미널', exact: true });
  await expect(pane.locator('.xterm-accessibility-tree')).toContainText('PS C:', {
    timeout: 15000,
  });
  await command(pane, "Write-Output ('LOCAL' + 'PID:' + $PID)", 'LOCALPID:');
  const shutdownPid = Number(
    (await pane.locator('.xterm-accessibility-tree').innerText()).match(/LOCALPID:(\d+)/)?.[1],
  );
  expect(shutdownPid).toBeGreaterThan(0);
  await command(
    pane,
    "1..500 | ForEach-Object { 'local-row' }; Write-Output ('FLOW' + '_OK')",
    'FLOW_OK',
  );
  await shutdown();
  expect(app.exitCode).toBe(0);
  await expect
    .poll(() =>
      spawnSync('tasklist', ['/FI', `PID eq ${shutdownPid}`, '/NH'], {
        encoding: 'utf8',
        windowsHide: true,
      }).stdout.includes(` ${shutdownPid} `),
    )
    .toBe(false);
  console.log(
    'Local PTY IO, Unicode, resize, split, isolated close/reopen, app shutdown, output flow and navigation passed.',
  );
} finally {
  await shutdown();
}
