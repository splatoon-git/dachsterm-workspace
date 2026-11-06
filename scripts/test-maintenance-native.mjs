// Isolated, non-secret fixtures. Never open or change the user's application data.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-maintenance-'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app, browser, page;
let stage = 'launch';
async function launch() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  app = spawn(process.env.DACHSTERM_TEST_BINARY ?? path.resolve('target/debug/dachsterm.exe'), [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DACHSTERM_TEST_DATA_DIR: directory,
      DACHSTERM_TEST_CDP_PORT: String(port),
    },
  });
  let endpoint;
  for (let i = 0; i < 120; i++) {
    try {
      endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await delay(250);
    }
  }
  assert(endpoint, 'test app did not initialize');
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  for (let i = 0; i < 80; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('tauri.localhost'));
    if (page) break;
    await delay(250);
  }
  assert(page);
  page.setDefaultTimeout(15000);
  await expect(page.getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
}
async function invoke(command, args = {}) {
  return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
}
async function stop() {
  if (app?.exitCode === null) {
    spawnSync('taskkill', ['/PID', String(app.pid)], { windowsHide: true, stdio: 'ignore' });
    for (let i = 0; i < 100 && app.exitCode === null; i++) await delay(100);
    if (app.exitCode === null) app.kill();
  }
  if (browser) await browser.close().catch(() => {});
  browser = null;
}
try {
  await launch();
  stage = 'create fixture profile';
  const p = await invoke('save_session', {
    profile: {
      id: '',
      name: '복구 테스트',
      host: 'localhost',
      port: 22,
      username: 'fixture',
      auth: 'password',
      protocol: 'ssh',
      tlsCaPath: '',
      encoding: 'utf-8',
      keyPath: '',
      groupId: null,
      favorite: false,
      timeout: 15,
      keepalive: 15,
      lastConnected: null,
      hasSecret: false,
    },
    secretAction: 'keep',
    secret: null,
  });
  stage = 'settings recovery UI';
  await page.getByRole('button', { name: '설정', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '워크스페이스 설정' });
  const recovery = dialog.locator('section[aria-label="복구와 진단"]');
  await dialog.getByRole('button', { name: '설정 복구본 만들기', exact: true }).click();
  await expect(recovery.getByRole('status')).toHaveText('설정 복구본을 만들었습니다.');
  const list = await invoke('recovery_list');
  assert.equal(list.length, 1);
  const data = JSON.parse(
    await readFile(path.join(directory, 'recovery', `${list[0].id}.json`), 'utf8'),
  );
  assert.equal(data.profiles[0].hasSecret, false);
  assert.equal(data.format, 'dachsterm.sessions');
  assert.equal(data.version, 3);
  assert.deepEqual(Object.keys(data).sort(), [
    'format',
    'groups',
    'profiles',
    'templates',
    'tunnels',
    'version',
  ]);
  stage = 'delete and restore';
  await invoke('delete_session', { id: p.id });
  assert.equal((await invoke('sessions')).profiles.length, 0);
  await dialog.getByLabel('저장된 설정 복구본').selectOption(list[0].id);
  await dialog.getByRole('button', { name: '선택한 복구본 가져오기' }).click();
  await dialog.getByRole('button', { name: '세션 추가 확인' }).click();
  await expect(recovery.getByRole('status')).toContainText('1개 세션을 추가');
  let profiles = (await invoke('sessions')).profiles;
  assert.equal(profiles.length, 1);
  assert.notEqual(profiles[0].id, p.id);
  assert.equal(profiles[0].hasSecret, false);
  await mkdir('test-results-native', { recursive: true });
  await dialog.locator('section[aria-label="복구와 진단"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results-native/maintenance.png' });
  await page.setViewportSize({ width: 560, height: 820 });
  await recovery.scrollIntoViewIfNeeded();
  assert(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth));
  await expect(recovery.getByRole('button', { name: '설정 복구본 만들기' })).toBeVisible();
  await page.screenshot({ path: 'test-results-native/maintenance-narrow.png' });
  await assert.rejects(invoke('recovery_restore', { id: '../sessions.sqlite3' }));
  await page.keyboard.press('Escape');
  stage = 'restart';
  await stop();
  await launch();
  profiles = (await invoke('sessions')).profiles;
  assert.equal(profiles.length, 1);
  assert((await readdir(path.join(directory, 'recovery'))).length >= 2);
  console.log(
    'PASS native recovery UI / delete snapshot / new IDs / path rejection / restart persistence',
  );
} catch (error) {
  console.error(`FAIL isolated maintenance stage: ${stage}`);
  // This fixture never creates or inputs passwords, keys or credential references.
  console.error(String(error.message).slice(0, 2000));
  process.exitCode = 1;
} finally {
  await stop();
  if (
    path.dirname(directory) === path.resolve(tmpdir()) &&
    path.basename(directory).startsWith('dachsterm-maintenance-')
  ) {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
}
