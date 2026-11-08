// Theme-only Windows WebView2 test. No server, user profile or credentials are used.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

if (process.platform !== 'win32') throw new Error('Windows WebView2 is required.');
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-themes-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app, browser;
async function launch() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  // DACHSTERM_EXE points at a build kept apart from a running `tauri dev`, which locks target/.
  app = spawn(path.resolve(process.env.DACHSTERM_EXE ?? 'target/debug/dachsterm.exe'), [], {
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
  let page = await launch();
  // The packaged app has no preview tab; a local shell gives a real terminal to theme.
  await page.locator('.local-targets').getByTitle('Windows PowerShell 새 터미널 열기').click();
  await expect(page.locator('.xterm-screen')).toBeVisible();
  await page.locator('.xterm-screen').evaluate((e) => e.setAttribute('data-lifetime', 'original'));
  await mkdir('test-results-native', { recursive: true });
  for (const [name, id] of [
    ['GitHub White', 'github-light'],
    ['GitHub Dark', 'github-dark'],
    ['Dracula', 'dracula'],
    ['Nord', 'nord'],
    ['Catppuccin Mocha', 'catppuccin-mocha'],
    ['Gruvbox Light', 'gruvbox-light'],
    ['Gruvbox Dark', 'gruvbox-dark'],
    ['Retro Light', 'retro-light'],
    ['Retro Dark', 'retro-dark'],
    ['Retro Blue Light', 'retro-blue-light'],
    ['Retro Blue Dark', 'retro-blue-dark'],
    ['Solarized Light', 'solarized-light'],
    ['Solarized Dark', 'solarized-dark'],
    ['Terminal Green', 'terminal-green'],
    ['Terminal Amber', 'terminal-amber'],
    ['DachsTerm Classic', 'pms-retro-light'],
  ]) {
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await expect(page.getByRole('radio')).toHaveCount(16);
    await page.getByRole('radio', { name, exact: true }).check();
    await expect(page.locator('html')).toHaveAttribute('data-theme', id);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: '설정', exact: true })).toBeFocused();
    await expect(page.locator('.xterm-screen')).toHaveAttribute('data-lifetime', 'original');
    const synced = await page.locator('.xterm-scrollable-element').evaluate((e) => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--terminal-background)';
      document.body.append(probe);
      const match = getComputedStyle(e).backgroundColor === getComputedStyle(probe).backgroundColor;
      probe.remove();
      return match;
    });
    if (!synced) throw new Error(`Terminal palette did not update for ${id}.`);
    await page.screenshot({ path: `test-results-native/theme-${id}.png` });
  }
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.getByRole('radio', { name: 'Dracula', exact: true }).check();
  await page.screenshot({ path: 'test-results-native/themes.png' });
  await shutdown();
  page = await launch();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dracula');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Dracula', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Dracula', exact: true })).toBeFocused();
  console.log(
    'PASS native themes: 16 palettes, existing xterm, close focus, full app restart persistence.',
  );
} finally {
  // Close only the process created by this script; keep isolated data for failure inspection.
  await shutdown();
}
