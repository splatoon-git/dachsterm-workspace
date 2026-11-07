// Local PTY integration in Windows WebView2. Isolated app data; no remote credentials.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {
  arrangeTabs,
  chooseTabMenu,
  closeTerminalSettings,
  focusedTab,
  openTerminalSettings,
  showSidebarView,
} from './native-workspace.mjs';

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
  await expect(page.locator('.files')).toBeHidden();
  // A local terminal stays in this window, so its tab menu has no way out.
  await focusedTab(page).click({ button: 'right' });
  const tabMenu = page.getByRole('menu', { name: '탭 메뉴' });
  await expect(tabMenu.getByRole('menuitem', { name: /^터미널 검색/ })).toBeVisible();
  await expect(tabMenu.getByRole('menuitem', { name: /새 창으로 분리/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(tabMenu).toHaveCount(0);
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
  // Any text means the shell is up. A user's profile can replace the default "PS C:\>" prompt.
  await expect(pane.locator('.xterm-accessibility-tree')).toContainText(/\S/, {
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
  // Opening a local shell keeps the sidebar where it was; only a server connection switches it.
  await expect(page.getByRole('tab', { name: '연결', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await showSidebarView(page, '파일');
  const localFiles = page.getByRole('complementary', { name: '로컬 파일 탐색' });
  const localPath = localFiles.getByLabel('로컬 경로', { exact: true });
  await expect(localPath).toHaveValue(/^[A-Z]:\\/i, { timeout: 15000 });
  const scratch = await realpath(await mkdtemp(path.join(directory, 'files-')));
  await mkdir(path.join(scratch, 'inner'));
  await writeFile(path.join(scratch, 'seen.txt'), 'hello');
  await command(pane, `Set-Location '${scratch}'; Write-Output ('CD' + '_ONE')`, 'CD_ONE');
  await expect(localPath).toHaveValue(scratch);
  await expect(localFiles.getByRole('button', { name: /seen\.txt/ })).toBeVisible();
  const follow = localFiles.getByLabel('터미널 경로 따라가기', { exact: true });
  await expect(follow).toBeChecked();
  await follow.uncheck();
  await command(pane, "Set-Location inner; Write-Output ('CD' + '_TWO')", 'CD_TWO');
  await expect(localPath).toHaveValue(scratch);
  await follow.check();
  await expect(localPath).toHaveValue(path.join(scratch, 'inner'));
  await command(pane, "Set-Location ..; Write-Output ('CD' + '_THREE')", 'CD_THREE');
  await expect(localPath).toHaveValue(scratch);
  console.log('PASS PowerShell directory follow, off and on');
  await mkdir('test-results-native', { recursive: true });
  const fileDialog = page.getByRole('dialog');
  const answer = async (value) => {
    await fileDialog.getByLabel('이름 또는 경로', { exact: true }).fill(value);
    await fileDialog.getByRole('button', { name: /^(만들기|바꾸기)$/ }).click();
    await expect(fileDialog).toHaveCount(0);
  };
  await localFiles.getByRole('button', { name: '폴더', exact: true }).click();
  await answer('made');
  await expect(localFiles.getByRole('button', { name: /^made/ })).toBeVisible();
  await localFiles.getByRole('button', { name: '새 파일', exact: true }).click();
  await answer('created.txt');
  await expect(localFiles.getByRole('button', { name: /created\.txt/ })).toBeVisible();
  await localFiles.getByRole('button', { name: /seen\.txt/ }).click();
  // Item actions are in the row's right-click menu and on keys; rename uses the menu here.
  await localFiles.getByRole('button', { name: /seen\.txt/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^이름 바꾸기/ }).click();
  await answer('renamed.txt');
  await expect(localFiles.getByRole('button', { name: /renamed\.txt/ })).toBeVisible();
  // The tree is the panel: it keeps most of the height, and folders open in place.
  const panelHeight = (await localFiles.boundingBox()).height;
  const treeHeight = (await localFiles.locator('.file-list').boundingBox()).height;
  assert(treeHeight / panelHeight > 0.5, `Tree height ${treeHeight} of ${panelHeight}`);
  await writeFile(path.join(scratch, 'inner', 'nested.txt'), 'nested');
  await localFiles.getByRole('button', { name: '펼치기: inner', exact: true }).click();
  const nested = localFiles.locator('.file-tree-row').filter({ hasText: 'nested.txt' });
  await expect(nested).toBeVisible();
  await expect(localPath).toHaveValue(scratch);
  await nested.locator('.file-row').click();
  await page.screenshot({ path: path.resolve('test-results-native/local-files.png') });
  await page.keyboard.press('Delete');
  await expect(fileDialog).toContainText('nested.txt');
  await fileDialog.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(fileDialog).toHaveCount(0);
  await expect(nested).toHaveCount(0);
  await expect
    .poll(() => readFile(path.join(scratch, 'inner', 'nested.txt')).catch((e) => e.code))
    .toBe('ENOENT');
  await localFiles.getByRole('button', { name: '접기: inner', exact: true }).click();
  await localFiles.getByRole('button', { name: /renamed\.txt/ }).click();
  await page.keyboard.press('Control+c');
  await localFiles.getByRole('button', { name: /^inner/ }).dblclick();
  await expect(localPath).toHaveValue(path.join(scratch, 'inner'));
  await localFiles.getByRole('button', { name: '붙여넣기', exact: true }).click();
  await expect(localFiles.getByRole('button', { name: /renamed\.txt/ })).toBeVisible();
  expect(await readFile(path.join(scratch, 'inner', 'renamed.txt'), 'utf8')).toBe('hello');
  // Pasting over an existing name reports it and leaves the file alone.
  await writeFile(path.join(scratch, 'inner', 'renamed.txt'), 'changed');
  await localFiles.getByRole('button', { name: '붙여넣기', exact: true }).click();
  await expect(localFiles.getByRole('alert')).toContainText('이미 있습니다');
  expect(await readFile(path.join(scratch, 'inner', 'renamed.txt'), 'utf8')).toBe('changed');
  await localFiles.getByRole('button', { name: /renamed\.txt/ }).click();
  await page.keyboard.press('Delete');
  await fileDialog.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(fileDialog).toHaveCount(0);
  await expect(localFiles.getByRole('button', { name: /renamed\.txt/ })).toHaveCount(0);
  console.log('PASS local file create, rename, copy, no-overwrite paste and delete');
  await showSidebarView(page, '연결');
  await expect(pane).toHaveAttribute('data-connection-id', originalId);
  await expect(pane.locator('.xterm')).toHaveAttribute('data-instance', 'original');
  // No tool rows: a connected pane has nothing to press around its terminal.
  await expect(pane.locator('button, input:not(.xterm-helper-textarea)')).toHaveCount(0);
  let settings = await openTerminalSettings(page);
  await settings.getByLabel('글꼴 크기').selectOption('16');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  // The settings window opens again on the category used last.
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await expect(settings.getByRole('tab', { name: '터미널', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await settings.getByLabel('글꼴 크기').selectOption('14');
  await closeTerminalSettings(page);
  await page.screenshot({ path: path.resolve('test-results-native/unified-local.png') });
  await command(pane, "Write-Output ('SI' + 'ZE:' + $Host.UI.RawUI.WindowSize.Width)", 'SIZE:');
  const initialWidth = Number(
    (await pane.locator('.xterm-accessibility-tree').innerText()).match(/SIZE:(\d+)/)?.[1],
  );
  const screenWidth = () =>
    pane.locator('.xterm-screen').evaluate((e) => e.getBoundingClientRect().width);
  const wideScreen = await screenWidth();
  await page.setViewportSize({ width: 900, height: 650 });
  // The terminal refits on a short throttle; ask the shell only after it has.
  await expect.poll(screenWidth).toBeLessThan(wideScreen);
  await command(
    pane,
    "Write-Output ('RESIZE' + ':' + $Host.UI.RawUI.WindowSize.Width)",
    /RESIZE:\d+/,
  );
  const widths = [
    ...(await pane.locator('.xterm-accessibility-tree').innerText()).matchAll(/RESIZE:(\d+)/g),
  ];
  expect(Number(widths.at(-1)?.[1])).toBeLessThan(initialWidth);
  await page.keyboard.press('Control+Shift+L');
  await page
    .getByRole('dialog', { name: '로컬 터미널 열기' })
    .getByRole('button', { name: '명령 프롬프트 로컬 셸' })
    .click();
  const cmd = page.getByRole('region', { name: '명령 프롬프트 터미널', exact: true });
  await expect(cmd.locator('.xterm-accessibility-tree')).toContainText('>', { timeout: 15000 });
  await command(cmd, 'echo DACHSTERM^CMD_OK', 'DACHSTERMCMD_OK');
  await command(cmd, `cd /d "${scratch}" & echo CMD^_CD`, 'CMD_CD');
  await showSidebarView(page, '파일');
  await expect(localPath).toHaveValue(scratch);
  await showSidebarView(page, '연결');
  console.log('PASS cmd directory follow');
  await arrangeTabs(page, '좌우');
  await expect(pane).toBeVisible();
  await expect(cmd).toBeVisible();
  // A font change in one pane must reach the other pane in the same window.
  for (const size of ['18', '14']) {
    settings = await openTerminalSettings(page);
    await settings.getByLabel('글꼴 크기').selectOption(size);
    await closeTerminalSettings(page);
    await expect(cmd.locator('.xterm-rows')).toHaveCSS('font-size', `${size}px`);
  }
  await chooseTabMenu(page, '연결 종료', cmd);
  await expect(cmd.locator('.connection-message')).toContainText('종료', { timeout: 15000 });
  await cmd.getByRole('button', { name: '재접속', exact: true }).click();
  await expect(cmd.locator('.connection-message')).toContainText('로컬 · 명령 프롬프트');
  await expect(cmd.locator('.xterm-accessibility-tree')).toContainText('>', { timeout: 15000 });
  await command(cmd, 'echo REOPEN^_OK', 'REOPEN_OK');
  await page.getByRole('button', { name: '명령 프롬프트 탭 닫기', exact: true }).click();
  await expect(cmd).toHaveCount(0);
  await page.screenshot({ path: path.resolve('test-results-native/local-split-before-input.png') });
  await command(pane, "Write-Output ('SURVIVE' + '_OK')", 'SURVIVE_OK');
  await arrangeTabs(page, '하나로');
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
    await showSidebarView(page, '파일');
    await expect(localPath).toHaveValue(/^\//, { timeout: 15000 });
    await command(linux, "cd /usr/bin; printf 'WSL%s\\n' _CD", 'WSL_CD');
    await expect(localPath).toHaveValue('/usr/bin');
    await expect(localFiles.getByRole('button', { name: /^env/ }).first()).toBeVisible({
      timeout: 15000,
    });
    await command(linux, 'false', '');
    await command(linux, "printf 'EXIT:%s\\n' $?", 'EXIT:1');
    await showSidebarView(page, '연결');
    console.log('PASS WSL directory follow, Linux path listing and preserved exit status');
    await command(linux, 'exit', '');
    await expect(linux.locator('.connection-message')).toContainText('종료', { timeout: 15000 });
    await page.screenshot({ path: 'test-results-native/local-wsl.png' });
    console.log('WSL interactive PTY passed.');
  } else console.log('WSL user distribution absent: real WSL execution pending.');
  // Return to PowerShell before checking shortcuts do not reach the PTY.
  await page.getByRole('tab', { name: /Windows PowerShell/ }).click();
  await page.keyboard.press('Control+Shift+B');
  await expect(page.getByRole('complementary', { name: '세션 탐색' })).toBeHidden();
  await page.keyboard.press('Control+Shift+O');
  await expect(page.getByRole('searchbox')).toBeFocused();
  // The terminal search took over Ctrl+Shift+F and opens over the focused pane.
  await page.keyboard.press('Control+Shift+F');
  const terminalSearch = page.getByRole('textbox', { name: '터미널 검색', exact: true });
  await expect(terminalSearch).toBeFocused();
  await terminalSearch.press('Escape');
  await expect(terminalSearch).toHaveCount(0);
  // Ctrl+Shift+\ opens the same shell again on the right, without typing into the terminal.
  await page.keyboard.press('Control+Shift+Backslash');
  await expect(page.locator('.tab-strip')).toHaveCount(2);
  const splitShell = page.locator(
    `.pane-cell:not([hidden]) .terminal-pane:not([data-connection-id="${originalId}"])`,
  );
  await expect(splitShell.locator('.xterm-accessibility-tree')).toContainText(/\S/, {
    timeout: 15000,
  });
  expect(
    await page.locator('.pane-cell').evaluateAll((cells) => {
      const [left, right] = cells
        .filter((cell) => !cell.hidden)
        .map((cell) => cell.getBoundingClientRect());
      return Math.round(right.left) >= Math.round(left.right);
    }),
  ).toBe(true);
  await chooseTabMenu(page, '탭 닫기', splitShell);
  await expect(page.locator('.tab-strip')).toHaveCount(1);
  console.log('PASS Ctrl+Shift+Backslash splits the same shell to the right');
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
  await expect(pane.locator('.xterm-accessibility-tree')).toContainText(/\S/, {
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
  // Settings that moved out of the panes live with the app and survive a restart.
  const guideSetting = 'vi·vim·less·tail 실행 중 조작표 자동 표시';
  const followSetting = '새 파일 패널에서 터미널 경로 따라가기';
  settings = await openTerminalSettings(page);
  await expect(settings.getByLabel(guideSetting, { exact: true })).toBeChecked();
  await settings.getByLabel(guideSetting, { exact: true }).uncheck();
  await settings.getByLabel(followSetting, { exact: true }).uncheck();
  await closeTerminalSettings(page);
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
  const restarted = await launch();
  settings = await openTerminalSettings(restarted);
  await expect(settings.getByLabel(guideSetting, { exact: true })).not.toBeChecked();
  await expect(settings.getByLabel(followSetting, { exact: true })).not.toBeChecked();
  await expect(settings.getByLabel('마우스 선택 시 자동 복사', { exact: true })).toBeChecked();
  await closeTerminalSettings(restarted);
  console.log('PASS moved terminal settings survive a restart');
  console.log(
    'Local PTY IO, Unicode, resize, split, isolated close/reopen, app shutdown, output flow and navigation passed.',
  );
} finally {
  await shutdown();
}
