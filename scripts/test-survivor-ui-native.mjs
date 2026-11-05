// Built product, real Windows WebView2. Only storage failure is injected; no engine state hooks.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

if (process.platform !== 'win32') throw Error('Windows WebView2 required.');
const directory = await mkdtemp(path.join(tmpdir(), 'daxterm-survivor-ui-'));
const binary = process.env.DAXTERM_TEST_BINARY ?? path.resolve('target/debug/daxterm.exe');
let app, browser;
const errors = [];
async function launch() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
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
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!endpoint) throw Error('Native debug endpoint unavailable.');
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  let page;
  for (let i = 0; i < 40; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('tauri.localhost'));
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!page) throw Error('Native app origin unavailable.');
  page.on('pageerror', (error) => errors.push(error.message));
  await page.locator('.sidebar-games summary').click();
  await page
    .getByRole('navigation', { name: '게임 목록' })
    .getByRole('button', { name: '닥스의 서바이버', exact: true })
    .click();
  return page;
}
async function nativeClose(page) {
  await page
    .evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }))
    .catch((error) => {
      if (!/closed|destroyed|Target|context/i.test(String(error))) throw error;
    });
}
async function waitForExit() {
  await expect.poll(() => app.exitCode, { timeout: 10000 }).toBe(0);
  await browser?.close();
  browser = null;
  app = null;
}
try {
  let page = await launch();
  await page.getByRole('button', { name: '새 도전 시작', exact: true }).click();
  const game = page.locator('.survivor-game'),
    field = game.locator('canvas');
  await expect(game).toHaveAttribute('data-phase', 'playing');
  await expect(field).toBeFocused();
  const x = Number(await field.getAttribute('data-x'));
  await page.keyboard.down('d');
  await page.waitForTimeout(250);
  await page.keyboard.up('d');
  await expect.poll(async () => Number(await field.getAttribute('data-x'))).toBeGreaterThan(x);
  // Normal stationary auto-attacks earn the first choice; no seed or state manipulation.
  await expect(game).toHaveAttribute('data-phase', 'choosing', { timeout: 35000 });
  await expect(page.locator('.survivor-card').first()).toBeFocused();
  const offer = await page.locator('.survivor-cards').innerText();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: '닥스의 서바이버', exact: true }).click();
  await expect(game).toHaveAttribute('data-phase', 'paused');
  await page.getByRole('button', { name: '계속하기', exact: true }).click();
  expect(await page.locator('.survivor-cards').innerText()).toBe(offer);
  await mkdir('target/verification', { recursive: true });
  await page.screenshot({ path: 'target/verification/survivor-ui-native.png' });
  await page.keyboard.press('1');
  await expect(game).toHaveAttribute('data-phase', 'playing');
  await page.keyboard.press('p');
  const frozenTick = await field.getAttribute('data-tick');
  await page.waitForTimeout(300);
  expect(await field.getAttribute('data-tick')).toBe(frozenTick);
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    window.restoreSurvivorWrites = () => {
      Storage.prototype.setItem = setItem;
    };
    Storage.prototype.setItem = function (key, value) {
      if (key === 'daxterm.games.survivor.v1') throw Error('Native test write failure');
      setItem.call(this, key, value);
    };
  });
  await nativeClose(page);
  await expect(game).toHaveAttribute('data-phase', 'result');
  await expect(page.getByRole('alert')).toBeVisible();
  expect(app.exitCode).toBe(null);
  await page.evaluate(() => window.restoreSurvivorWrites());
  await page.getByRole('button', { name: '저장 재시도', exact: true }).click();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('daxterm.games.survivor.v1')),
  );
  expect(saved.checkpoint).toBe(null);
  expect(saved.settlements).toHaveLength(1);
  expect(saved.settlements[0].reason).toBe('abandoned');
  await nativeClose(page);
  await waitForExit();
  page = await launch();
  await expect(page.getByRole('button', { name: '새 도전 시작', exact: true })).toBeEnabled();
  const recovered = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('daxterm.games.survivor.v1')),
  );
  expect(recovered).toEqual(saved);
  await nativeClose(page);
  await waitForExit();
  expect(errors).toEqual([]);
  const result = {
    binary,
    sha256: createHash('sha256')
      .update(await readFile(binary))
      .digest('hex'),
    normalInputFirstChoice: true,
    choicePauseResume: true,
    movement: true,
    failedNativeClosePrevented: true,
    retrySettledOnce: true,
    normalCloseReloadExact: true,
    settlements: saved.settlements.length,
    highestLevel: saved.records.highestLevel,
    errors,
  };
  await writeFile('target/verification/survivor-ui-native.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  if (app?.pid && app.exitCode === null)
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
}
