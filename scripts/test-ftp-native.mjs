import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { arrangeTabs, chooseTabMenu, dragTab } from './native-workspace.mjs';
const root = await mkdtemp(path.join(tmpdir(), 'dachsterm-ftp-native-'));
let app, browser, page;
let stage = 'launch';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function invoke(command, args = {}) {
  return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
}
async function cleanup() {
  if (
    path.dirname(root) !== path.resolve(tmpdir()) ||
    !path.basename(root).startsWith('dachsterm-ftp-native-')
  )
    throw new Error('unsafe cleanup path');
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
try {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  app = spawn(process.env.DACHSTERM_TEST_BINARY ?? path.resolve('target/debug/dachsterm.exe'), [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DACHSTERM_TEST_DATA_DIR: root,
      DACHSTERM_TEST_CDP_PORT: String(port),
      WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'),
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
  if (!endpoint) throw new Error('CDP unavailable');
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  for (let i = 0; i < 40; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('tauri.localhost'));
    if (page) break;
    await sleep(250);
  }
  page.setDefaultTimeout(15000);
  await expect(page.getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
  for (const protocol of ['ftp', 'ftps']) {
    stage = `${protocol} form`;
    await page.getByRole('button', { name: '＋ 새 연결', exact: true }).click();
    stage = `${protocol} profile fields`;
    const form = page.getByRole('dialog');
    await form.getByLabel('이름', { exact: true }).fill(`${protocol} UI fixture`);
    stage = `${protocol} protocol`;
    await form.getByLabel('프로토콜').selectOption(protocol);
    stage = `${protocol} host fields`;
    await form.getByLabel('호스트', { exact: true }).fill('127.0.0.1');
    await form
      .getByLabel('포트', { exact: true })
      .fill(process.env[protocol === 'ftp' ? 'DACHSTERM_FTP_PORT' : 'DACHSTERM_FTPS_PORT']);
    await form.getByLabel('사용자', { exact: true }).fill('fixture');
    await form.getByLabel('비밀번호', { exact: true }).fill(process.env.DACHSTERM_FTP_PASSWORD);
    await form.getByLabel('인증정보 보관', { exact: true }).selectOption('replace');
    if (protocol === 'ftps') {
      await form.locator('summary', { hasText: '고급 옵션' }).click();
      await form.getByLabel('추가 CA 인증서 경로 (선택)').fill(process.env.DACHSTERM_FTP_CA);
    }
    stage = `${protocol} submit`;
    await form.getByRole('button', { name: '저장 후 연결', exact: true }).click();
    stage = `${protocol} connected`;
    // By name: the previous tab's pane is still on screen until the new tab opens, and a
    // locator that matches it passes every check before going stale once it is hidden.
    const pane = page.getByRole('region', { name: `${protocol} UI fixture 파일`, exact: true });
    await expect(pane.getByRole('status')).toContainText('연결됨');
    stage = `${protocol} files`;
    await expect(pane.locator('.file-list')).toHaveAttribute('aria-busy', 'false');
    stage = `${protocol} mkdir open`;
    // WebView2 must finish laying out a newly shown tab before native hit testing.
    await pane.evaluate(async (element) => {
      element.getBoundingClientRect();
      await new Promise(requestAnimationFrame);
    });
    await pane.getByRole('button', { name: '폴더', exact: true }).click();
    stage = `${protocol} mkdir form`;
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('이름 또는 경로').fill(`${protocol}-ui`);
    await dialog.getByRole('button', { name: '적용', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    stage = `${protocol} enter directory`;
    await pane
      .locator('.file-row')
      .filter({ hasText: `${protocol}-ui` })
      .dblclick();
    await expect(pane.getByLabel('원격 경로')).toHaveValue(`/${protocol}-ui`);
    stage = `${protocol} create file`;
    await pane.getByRole('button', { name: '새 파일', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByLabel('이름 또는 경로').fill('한글 빈 파일.txt');
    await dialog.getByRole('button', { name: '적용', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const file = pane.locator('.file-row').filter({ hasText: '한글 빈 파일.txt' });
    await expect(file).toBeVisible();
    stage = `${protocol} clipboard`;
    await file.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^복사/ }).click();
    await pane.getByRole('button', { name: '붙여넣기', exact: true }).click();
    await expect(pane.locator('.file-row').filter({ hasText: '복사 1' })).toBeVisible();
    await pane.locator('.file-row').first().click();
    stage = `${protocol} multi delete`;
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('2개 항목');
    await dialog.getByRole('button', { name: '적용', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(pane.locator('.file-row')).toHaveCount(0);
    stage = `${protocol} upload`;
    const local = path.join(root, '한글 upload.bin');
    await writeFile(local, Buffer.from([239, 187, 191, 0, 255, 13, 10, 123, 42]));
    const id = await pane.getAttribute('data-connection-id');
    const [job] = await invoke('transfer_batch', {
      id,
      path: `/${protocol}-ui`,
      mode: 'drop',
      paths: [local],
      conflict: 'error',
    });
    await expect
      .poll(async () => (await invoke('transfer_list')).find((t) => t.id === job)?.status)
      .toBe('completed');
    await pane.getByRole('button', { name: '파일 새로 고침', exact: true }).click();
    await expect(pane.locator('.file-row').filter({ hasText: '한글 upload.bin' })).toBeVisible();
    await mkdir(path.resolve('test-results-native'), { recursive: true });
    await page.screenshot({ path: path.resolve(`test-results-native/${protocol}-files.png`) });
    await page.setViewportSize({ width: 800, height: 650 });
    await expect(pane.locator('.files')).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 800 });
    if (protocol === 'ftp') {
      stage = 'file panel in a small group';
      await arrangeTabs(page, '2 × 2');
      await expect(pane.locator('.file-row').first()).toBeVisible();
      await expect(pane.getByRole('button', { name: '파일 새로 고침', exact: true })).toBeVisible();
      await page.screenshot({ path: path.resolve('test-results-native/ftp-small-group.png') });
      await arrangeTabs(page, '하나로');
      await expect(pane.locator('.files')).toBeVisible();
    }
    console.log(
      `PASS native ${protocol} session form, connect, file view, Unicode mkdir/new file, context copy/paste, multi-delete, binary upload, narrow window and small group`,
    );
  }
  // Both tabs are open now. A file tab behaves as a tab: drag, split, merge, reconnect.
  // An attribute selector, which also finds a pane hidden behind another tab.
  const panes = {
    ftp: page.locator('.ftp-pane[aria-label="ftp UI fixture 파일"]'),
    ftps: page.locator('.ftp-pane[aria-label="ftps UI fixture 파일"]'),
  };
  const tabOf = (protocol) =>
    page
      .locator('.session-tab')
      .filter({ hasText: `${protocol} UI fixture` })
      .getByRole('tab');
  const idOf = (protocol) => panes[protocol].getAttribute('data-connection-id');
  const strips = page.locator('.tab-strip');
  async function uploadAndList(protocol, name) {
    const local = path.join(root, name);
    await writeFile(local, Buffer.from([0, 1, 2, 255, 13, 10]));
    const [job] = await invoke('transfer_batch', {
      id: await idOf(protocol),
      // Into the folder the pane shows, so its own refresh lists the file.
      path: await panes[protocol].getByLabel('원격 경로').inputValue(),
      mode: 'drop',
      paths: [local],
      conflict: 'error',
    });
    await expect
      .poll(async () => (await invoke('transfer_list')).find((t) => t.id === job)?.status)
      .toBe('completed');
    await panes[protocol].getByRole('button', { name: '파일 새로 고침', exact: true }).click();
    await expect(panes[protocol].locator('.file-row').filter({ hasText: name })).toBeVisible();
  }
  stage = 'file tab status bar and menu';
  await arrangeTabs(page, '하나로');
  const bar = page.locator('footer.status-bar');
  await tabOf('ftps').click();
  await expect(bar).toContainText('FTPS · TLS 인증서 검증');
  await tabOf('ftp').click();
  await expect(bar).toContainText('FTP · TLS 없음');
  await expect(bar.locator('.program-guide, .monitor-bar')).toHaveCount(0);
  await tabOf('ftp').click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '탭 메뉴' });
  // No terminal items on a file tab: search, logs, guides and splitting with a new shell.
  await expect(menu.getByRole('menuitem')).toHaveText([
    /^이 창 확대/,
    '연결 종료',
    '탭 닫기',
    '다른 탭 닫기',
  ]);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  const before = { ftp: await idOf('ftp'), ftps: await idOf('ftps') };

  stage = 'file tab drag to the right edge';
  const grid = await page.locator('.terminal-grid').boundingBox();
  await dragTab(page, tabOf('ftps'), grid.x + grid.width - 30, grid.y + grid.height / 2);
  await expect(strips).toHaveCount(2);
  for (const protocol of ['ftp', 'ftps']) {
    await expect(panes[protocol]).toBeVisible();
    await expect(panes[protocol].locator('.file-row').first()).toBeVisible();
    expect(await idOf(protocol)).toBe(before[protocol]);
  }
  // File tabs take no typed input, so two of them on screen offer no input scope.
  await expect(page.getByLabel('분할 입력 모드')).toBeHidden();
  stage = 'file transfer in a split';
  await uploadAndList('ftps', 'split upload.bin');
  await page.screenshot({ path: path.resolve('test-results-native/ftp-split.png') });

  stage = 'file tab merge and split down';
  let box = await panes.ftp.boundingBox();
  await dragTab(page, tabOf('ftps'), box.x + box.width / 2, box.y + box.height / 2);
  await expect(strips).toHaveCount(1);
  box = await panes.ftps.boundingBox();
  await dragTab(page, tabOf('ftps'), box.x + box.width / 2, box.y + box.height - 20);
  await expect(strips).toHaveCount(2);
  await expect(panes.ftp).toBeVisible();
  await expect(panes.ftps).toBeVisible();
  for (const protocol of ['ftp', 'ftps']) expect(await idOf(protocol)).toBe(before[protocol]);

  stage = 'file tab dragged out of the window stays';
  const windows = browser.contexts().flatMap((c) => c.pages()).length;
  await dragTab(page, tabOf('ftp'), -40, 200);
  await expect(strips).toHaveCount(2);
  await expect(panes.ftp).toBeVisible();
  expect(browser.contexts().flatMap((c) => c.pages()).length).toBe(windows);

  stage = 'file tab reconnect';
  await chooseTabMenu(page, '연결 종료', panes.ftp);
  const ended = panes.ftp.getByRole('group', { name: '연결 종료 안내' });
  await expect(ended).toBeVisible();
  await ended.getByRole('button', { name: '재접속', exact: true }).click();
  await expect(panes.ftp.getByRole('status')).toContainText('연결됨');
  await expect(ended).toHaveCount(0);
  expect(await idOf('ftp')).not.toBe(before.ftp);
  await uploadAndList('ftp', 'after reconnect.bin');
  await page.screenshot({ path: path.resolve('test-results-native/ftp-reconnected.png') });
  console.log(
    'PASS native FTP/FTPS tabs: status bar security, file-only tab menu, drag split/merge/split down without reconnecting, transfer in a split, drag out cancelled, reconnect and transfer after it',
  );
} catch (error) {
  console.error(`FAIL native FTP stage: ${stage} (${error.name}; details redacted)`);
  if (page) {
    console.error(
      'UI states:',
      await page
        .locator('.connection-message, [role=alert]')
        .allTextContents()
        .catch(() => []),
    );
    await mkdir(path.resolve('test-results-native'), { recursive: true });
    await page
      .screenshot({
        path: path.resolve('test-results-native/ftp-failure.png'),
        mask: [page.locator('input[type=password]')],
      })
      .catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (page) {
    try {
      for (const profile of (await invoke('sessions')).profiles)
        await invoke('delete_session', { id: profile.id });
    } catch {
      /* Best-effort cleanup after a failed UI probe. */
    }
  }
  if (app) {
    spawnSync('taskkill', ['/PID', String(app.pid)], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 40 && app.exitCode === null; i++) await sleep(100);
    if (app.exitCode === null) app.kill();
  }
  if (browser) await browser.close().catch(() => {});
  await cleanup();
}
