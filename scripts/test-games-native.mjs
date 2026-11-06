import { verifyAdventureVariety } from './verify-adventure-native.mjs';
// Game-only smoke test against the built Windows WebView2 app, using isolated local data.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

if (process.platform !== 'win32') throw new Error('This smoke test requires Windows WebView2.');
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-games-'));
const server = net.createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const app = spawn(
  process.env.DACHSTERM_TEST_BINARY ?? path.resolve('target/debug/dachsterm.exe'),
  [],
  {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      DACHSTERM_TEST_DATA_DIR: directory,
      DACHSTERM_TEST_CDP_PORT: String(port),
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview'),
    },
  },
);
let browser;
try {
  let endpoint;
  for (let i = 0; i < 80; i++) {
    try {
      endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (!endpoint)
    throw new Error('Test app debugging endpoint unavailable. Build the debug app first.');
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
  if (!page)
    throw new Error(
      'Test app page unavailable: ' +
        browser
          .contexts()
          .flatMap((c) => c.pages())
          .map((p) => p.url())
          .join(', '),
    );
  const launcher = page.locator('.sidebar-games summary');
  await launcher.click();
  const menu = page.getByRole('navigation', { name: '게임 목록' });
  await menu.getByRole('button', { name: '블록 퍼즐', exact: true }).click();
  const dialog = page.locator('.game-terminal:visible');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await dialog.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.keyboard.press('Space');
  await expect
    .poll(async () => Number(await dialog.getByTestId('game-score').textContent()))
    .toBeGreaterThan(0);
  await page.keyboard.press('p');
  await expect(dialog.getByRole('status')).toContainText('일시정지');
  await menu.getByRole('button', { name: '스네이크', exact: true }).click();
  await dialog.getByRole('button', { name: '게임 시작', exact: true }).click();
  await expect(dialog.getByRole('group', { name: '스네이크 게임판' })).toBeFocused();
  await page.keyboard.press('p');
  await menu.getByRole('button', { name: '2048', exact: true }).click();
  await dialog.getByRole('button', { name: '왼쪽으로', exact: true }).click();
  await expect(dialog.locator('.number-tile')).toHaveCount(16);
  await menu.getByRole('button', { name: '지뢰찾기', exact: true }).click();
  await dialog.getByRole('group', { name: '지뢰찾기 게임판' }).getByRole('button').first().click();
  await expect(dialog.getByTestId('game-score')).toHaveText('1');
  await menu.getByRole('button', { name: '닥스의 간식 타임', exact: true }).click();
  await page.evaluate(() => {
    Math.random = () => 0.5;
  });
  await dialog.getByRole('button', { name: '게임 시작', exact: true }).click();
  const snackBoard = dialog.getByRole('group', { name: '닥스의 간식 타임 게임판' });
  await expect(snackBoard).toBeFocused();
  await expect(snackBoard).toHaveAttribute('data-motion', 'eat', { timeout: 7000 });
  await expect(dialog.getByTestId('game-score')).not.toHaveText('0');
  await expect(snackBoard.locator('.snack-sprite')).toBeVisible();
  await mkdir('target/verification', { recursive: true });
  await page.screenshot({ path: 'target/verification/snack-native.png' });
  await page.bringToFront();
  if (await dialog.getByRole('button', { name: '계속하기', exact: true }).isVisible())
    await dialog.getByRole('button', { name: '계속하기', exact: true }).click();
  await snackBoard.focus();
  const snackX = Number(await snackBoard.getAttribute('data-x'));
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(200);
  await page.keyboard.up('ArrowRight');
  expect(Number(await snackBoard.getAttribute('data-x'))).toBeGreaterThan(snackX);
  await page.keyboard.press('p');
  const snackTime = await dialog.getByTestId('snack-time').textContent();
  await menu.getByRole('button', { name: '닥스의 모험', exact: true }).click();
  await dialog.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.keyboard.press('ArrowUp');
  await expect
    .poll(async () =>
      Number(
        await dialog.getByRole('group', { name: '닥스의 모험 게임판' }).getAttribute('data-y'),
      ),
    )
    .toBeGreaterThan(45);
  await page.keyboard.press('p');
  const adventureBoard = dialog.getByRole('group', { name: '닥스의 모험 게임판' });
  await dialog.getByRole('button', { name: '계속하기', exact: true }).click();
  await page.keyboard.down('d');
  await page.waitForTimeout(500);
  await page.keyboard.up('d');
  const rightX = Number(await adventureBoard.getAttribute('data-x'));
  expect(rightX).toBeGreaterThan(170);
  await page.keyboard.down('a');
  await page.waitForTimeout(350);
  await page.keyboard.up('a');
  expect(Number(await adventureBoard.getAttribute('data-x'))).toBeLessThan(rightX);
  await page.keyboard.press('Space');
  await expect(adventureBoard).toHaveAttribute('data-motion', 'bite');
  await page.keyboard.press('p');
  const adventureScore = await dialog.getByTestId('game-score').textContent();
  await menu.getByRole('button', { name: '닥스의 간식 타임', exact: true }).click();
  await expect(dialog.getByTestId('snack-time')).toHaveText(snackTime);
  await expect(dialog.getByRole('button', { name: '계속하기', exact: true })).toBeVisible();
  await menu.getByRole('button', { name: '닥스의 모험', exact: true }).click();
  await expect(dialog.getByTestId('game-score')).toHaveText(adventureScore);
  await verifyAdventureVariety(page, dialog);
  await mkdir('test-results-native', { recursive: true });
  await page.screenshot({ path: 'test-results-native/games.png' });
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('tab', { name: '시작하기', exact: true })).toBeFocused();
  await page.getByRole('tab', { name: '블록 퍼즐', exact: true }).click();
  await expect(dialog.getByRole('button', { name: '계속하기', exact: true })).toBeVisible();
  await expect
    .poll(async () => Number(await dialog.getByTestId('game-score').textContent()))
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: '블록 퍼즐 탭 닫기', exact: true }).click();
  await expect(page.locator('#game-panel-blocks')).toHaveCount(0);
  await page.reload();
  await expect(launcher).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => Number(localStorage.getItem('dachsterm.games.v1.blocks'))))
    .toBeGreaterThan(0);
  // Actual local PTY: the game keys must not be delivered to Read-Host.
  await page.locator('.local-targets').getByTitle('Windows PowerShell 새 터미널 열기').click();
  const terminal = page.getByRole('region', { name: 'Windows PowerShell 터미널', exact: true });
  const input = terminal.locator('.xterm-helper-textarea');
  await expect(terminal.locator('.xterm-accessibility-tree')).toContainText('PS C:', {
    timeout: 15000,
  });
  const connection = await terminal.getAttribute('data-connection-id');
  await input.focus();
  await input.evaluate((element) => {
    const data = new DataTransfer();
    data.setData(
      'text/plain',
      "$g = Read-Host 'GAME_WAIT'; Write-Output ('GAME'+'_INPUT<'+$g+'>')",
    );
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await input.press('Enter');
  await expect(terminal.locator('.xterm-accessibility-tree')).toContainText('GAME_WAIT:');
  await launcher.click();
  for (const name of ['닥스의 간식 타임', '닥스의 모험']) {
    await menu.getByRole('button', { name, exact: true }).click();
    await dialog.getByRole('button', { name: '게임 시작', exact: true }).click();
    for (const key of ['ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'a', 'd', 's', 'j', 'x'])
      await page.keyboard.press(key);
    await expect(terminal).not.toBeVisible();
    await page.keyboard.press('Escape');
    await expect(terminal).toHaveAttribute('data-connection-id', connection);
  }
  await input.focus();
  await input.press('Enter');
  await expect(terminal.locator('.xterm-accessibility-tree')).toContainText('GAME_INPUT<>');
  console.log(
    'Native games: six games, keyboard/jump, pause, close focus, persisted records and real local PTY input isolation passed.',
  );
} finally {
  // Only close this test-owned process. Keep its isolated data for failure inspection.
  if (app.pid && app.exitCode === null) {
    spawnSync('taskkill', ['/PID', String(app.pid)], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 30 && app.exitCode === null; i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (app.exitCode === null) app.kill();
  }
  await browser?.close().catch(() => {});
}
