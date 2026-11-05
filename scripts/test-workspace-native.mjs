// Local PTY integration in Windows WebView2. Isolated app data; no remote credentials.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

if (process.platform !== 'win32') throw new Error('Windows WebView2 is required.');
const directory = await mkdtemp(path.join(tmpdir(), 'daxterm-workspace-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app, browser;
async function launch() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  app = spawn(path.resolve('target/debug/daxterm.exe'), [], {
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
let page;
try {
  page = await launch();
  const invoke = (command, args = {}) =>
    page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
      command,
      args,
    });
  for (let i = 0; i < 3; i++) {
    await page.locator('.local-targets').getByTitle('명령 프롬프트 새 터미널 열기').click();
    await expect(page.locator('.terminal-pane:not([hidden]) .connection-message')).toContainText(
      '로컬 · 명령 프롬프트',
    );
    await expect(
      page.locator('.terminal-pane:not([hidden]) .xterm-accessibility-tree'),
    ).toContainText('>');
  }
  const ids = await page
    .locator('.terminal-pane')
    .evaluateAll((elements) => elements.map((e) => e.getAttribute('data-connection-id')));
  const pane = (id) => page.locator(`.terminal-pane[data-connection-id="${id}"]`);
  for (const id of ids)
    await pane(id)
      .locator('.xterm')
      .evaluate((e) => (e.dataset.instance = 'original'));
  await page.getByRole('button', { name: '2 × 2', exact: true }).click();
  const inputMode = page.getByLabel('분할 입력 모드');
  await expect.poll(async () => (await invoke('broadcast_status')).targets.length).toBe(3);
  await expect(inputMode.locator('option[value="all"]')).toBeEnabled();
  await inputMode.selectOption('all');
  await expect.poll(async () => (await invoke('broadcast_status')).selected.length).toBe(3);
  async function command(id, marker) {
    const input = pane(id).locator('.xterm-helper-textarea');
    await input.focus();
    await input.evaluate((e, marker) => {
      const data = new DataTransfer();
      data.setData('text/plain', `echo DAX^${marker}`);
      e.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, marker);
    await input.press('Enter');
    await expect(pane(id).locator('.xterm-accessibility-tree')).toContainText(`DAX${marker}`);
  }
  await command(ids[0], 'ALL_OK');
  for (const id of ids)
    await expect(pane(id).locator('.xterm-accessibility-tree')).toContainText('DAXALL_OK');
  await inputMode.selectOption('selected');
  const dialog = page.getByRole('dialog', { name: '멀티 입력 대상' });
  await dialog
    .locator('label')
    .filter({ hasText: ids[2].slice(0, 8) })
    .getByRole('checkbox')
    .uncheck();
  await dialog.getByRole('button', { name: '선택한 2개에 입력 전달' }).click();
  await expect(dialog).not.toBeVisible();
  await command(ids[0], 'SOME_OK');
  await expect(pane(ids[1]).locator('.xterm-accessibility-tree')).toContainText('DAXSOME_OK');
  await expect(pane(ids[2]).locator('.xterm-accessibility-tree')).not.toContainText('DAXSOME_OK');
  await command(ids[2], 'OUTSIDE_OK');
  for (const id of ids.slice(0, 2))
    await expect(pane(id).locator('.xterm-accessibility-tree')).not.toContainText('DAXOUTSIDE_OK');
  const handle = page.getByRole('separator', { name: '사이드바 너비' });
  const rect = await handle.boundingBox();
  await page.mouse.move(rect.x + 2, rect.y + 80);
  await page.mouse.down();
  await page.mouse.move(rect.x + 42, rect.y + 80, { steps: 8 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow', '344');
  await page.keyboard.press('F11');
  await expect.poll(() => invoke('plugin:window|is_fullscreen', { label: 'main' })).toBe(true);
  await expect(page.locator('.toolbar')).toBeHidden();
  await expect(page.locator('#workspace-sidebar')).toBeHidden();
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(3);
  await page.keyboard.press('Control+Shift+Enter');
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(1);
  await expect(pane(ids[2])).toBeVisible();
  await page.keyboard.press('Control+Shift+Enter');
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(3);
  await mkdir('test-results-native', { recursive: true });
  await page.screenshot({ path: path.resolve('test-results-native/unified-fullscreen-multi.png') });
  await page.getByRole('button', { name: '전체화면 종료', exact: true }).click();
  await expect.poll(() => invoke('plugin:window|is_fullscreen', { label: 'main' })).toBe(false);
  await expect(handle).toHaveAttribute('aria-valuenow', '344');
  for (const id of ids)
    await expect(pane(id).locator('.xterm')).toHaveAttribute('data-instance', 'original');
  await page.getByRole('button', { name: '단일', exact: true }).click();
  await expect.poll(async () => (await invoke('broadcast_status')).selected.length).toBe(0);
  await expect(inputMode).toHaveValue('off');
  await expect(inputMode).toBeDisabled();
  await page.getByRole('button', { name: '전체화면', exact: true }).click();
  await expect(page.locator('.terminal-pane:visible')).toHaveCount(1);
  await page.keyboard.press('F11');
  await page.getByRole('button', { name: '좌우', exact: true }).click();
  await inputMode.selectOption('all');
  await expect.poll(async () => (await invoke('broadcast_status')).selected.length).toBe(2);
  await pane(ids[0]).getByRole('button', { name: '연결 종료', exact: true }).click();
  await expect.poll(async () => (await invoke('broadcast_status')).selected.length).toBe(0);
  await shutdown();
  expect(app.exitCode).toBe(0);
  console.log(
    'PASS real local all/subset/outsider input, scope/close reset, mouse resize, native fullscreen single/multi, zoom and renderer preservation.',
  );
} catch (e) {
  if (page)
    await page
      .screenshot({ path: path.resolve('test-results-native/workspace-failure.png') })
      .catch(() => {});
  throw e;
} finally {
  await shutdown();
}
