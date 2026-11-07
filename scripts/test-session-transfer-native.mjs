// Real isolated WebView2 + OpenSSH + Windows credential store, using ephemeral fixture credentials.
// Never print assertion traces or capture authentication fields.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-transfer-'));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
let app, browser, page;
let stage = 'launch';
async function launch() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  app = spawn(process.env.DACHSTERM_TEST_BINARY ?? path.resolve('target/debug/dachsterm.exe'), [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      DACHSTERM_TEST_DATA_DIR: directory,
      DACHSTERM_TEST_CDP_PORT: String(port),
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview'),
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
  assert(endpoint);
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
  await browser?.close().catch(() => {});
  browser = null;
}
const make = (name) => ({
  id: name,
  name,
  host: '127.0.0.1',
  port: Number(process.env.DACHSTERM_PROBE_PORT),
  username: 'probe',
  auth: 'password',
  protocol: 'ssh',
  tlsCaPath: '',
  encoding: 'utf-8',
  keyPath: '',
  groupId: 'import-group',
  favorite: false,
  timeout: 15,
  keepalive: 5,
  lastConnected: null,
  hasSecret: false,
});
const bundle = {
  format: 'dachsterm.sessions',
  version: 2,
  profiles: ['저장 동의', '이번만', '실패 암호', '신뢰 취소'].map(make),
  groups: [{ id: 'import-group', name: '가져온 세션' }],
  tunnels: [],
};
async function open(name, remember, value) {
  await page.locator('.profile-target').filter({ hasText: name }).dblclick();
  const dialog = page.getByRole('dialog', { name: `${name} 인증` });
  await expect(dialog.getByRole('checkbox')).not.toBeChecked();
  await dialog.getByLabel('비밀번호', { exact: true }).fill(value);
  if (remember) await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '연결', exact: true }).click();
}
const pane = () => page.locator('.pane-cell.focused .terminal-pane');
async function close(name) {
  await page.getByRole('button', { name: `${name} 탭 닫기`, exact: true }).click();
}
try {
  await launch();
  stage = 'v2 import transaction';
  assert.equal(await invoke('config_apply', { data: JSON.stringify(bundle) }), 4);
  const first = (await invoke('sessions')).profiles;
  assert.equal(first.length, 4);
  assert(first.every((p) => !p.hasSecret && !bundle.profiles.some((q) => p.id === q.id)));
  await assert.rejects(
    invoke('config_apply', { data: JSON.stringify({ ...bundle, password: 'not-allowed' }) }),
  );
  assert.equal((await invoke('sessions')).profiles.length, 4);
  await page.reload();
  stage = 'host trust rejection does not save';
  await open('신뢰 취소', true, process.env.DACHSTERM_PROBE_PASSWORD);
  await expect(page.getByRole('alert', { name: '최초 호스트키 확인' })).toBeVisible();
  await page.getByRole('button', { name: '거부', exact: true }).click();
  await expect(pane().locator('.connection-message')).toContainText(/거부|취소|종료/);
  assert.equal(
    (await invoke('sessions')).profiles.find((p) => p.name === '신뢰 취소').hasSecret,
    false,
  );
  await close('신뢰 취소');
  stage = 'wrong password never saved';
  await open('실패 암호', true, 'deliberately-invalid');
  await expect(page.getByRole('alert', { name: '최초 호스트키 확인' })).toBeVisible();
  await page.getByRole('button', { name: '지문 확인 · 신뢰하고 연결', exact: true }).click();
  await expect(pane().locator('.connection-message')).toContainText('인증이 거부');
  assert.equal(
    (await invoke('sessions')).profiles.find((p) => p.name === '실패 암호').hasSecret,
    false,
  );
  await close('실패 암호');
  stage = 'successful one-time password stays unsaved';
  await open('이번만', false, process.env.DACHSTERM_PROBE_PASSWORD);
  await expect(pane().locator('.connection-message')).toContainText('연결됨');
  assert.equal(
    (await invoke('sessions')).profiles.find((p) => p.name === '이번만').hasSecret,
    false,
  );
  await close('이번만');
  stage = 'successful consent saves credential';
  await open('저장 동의', true, process.env.DACHSTERM_PROBE_PASSWORD);
  await expect(pane().locator('.connection-message')).toContainText('암호를 보안 저장소에 저장');
  assert.equal(
    (await invoke('sessions')).profiles.find((p) => p.name === '저장 동의').hasSecret,
    true,
  );
  await close('저장 동의');
  await invoke('recovery_create');
  const recoveryFiles = await readdir(path.join(directory, 'recovery'));
  for (const file of recoveryFiles.filter((s) => s.endsWith('.json'))) {
    const data = await readFile(path.join(directory, 'recovery', file), 'utf8');
    assert(!data.includes(process.env.DACHSTERM_PROBE_PASSWORD));
    const parsed = JSON.parse(data);
    assert.equal(parsed.version, 3);
    assert(parsed.profiles.every((p) => !p.hasSecret));
  }
  stage = 'restart reuses saved credential';
  await stop();
  await launch();
  await page.locator('.profile-target').filter({ hasText: '저장 동의' }).dblclick();
  await expect(pane().locator('.connection-message')).toContainText('연결됨');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await close('저장 동의');
  stage = 'native transfer settings layout';
  await invoke('vault_action', {
    action: 'configure',
    password: '',
    newPassword: randomBytes(32).toString('base64url'),
    profileId: null,
  });
  await invoke('vault_lock');
  stage = 'locked vault reports save failure without dropping connection';
  await open('이번만', true, process.env.DACHSTERM_PROBE_PASSWORD);
  await expect(pane().locator('.connection-message')).toContainText('암호 저장에 실패');
  assert.equal(
    (await invoke('sessions')).profiles.find((p) => p.name === '이번만').hasSecret,
    false,
  );
  await expect(pane().locator('.xterm-helper-textarea')).toBeVisible();
  await close('이번만');
  stage = 'native transfer settings layout';
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await expect(page.getByRole('region', { name: '세션 가져오기와 내보내기' })).toBeVisible();
  await page.setViewportSize({ width: 560, height: 820 });
  await page.getByRole('button', { name: '파일 선택 · 미리보기' }).scrollIntoViewIfNeeded();
  await mkdir('test-results-native', { recursive: true });
  await page.screenshot({ path: 'test-results-native/session-transfer.png' });
  await page.keyboard.press('Escape');
  stage = 'credential cleanup and persistence';
  for (const p of (await invoke('sessions')).profiles) await invoke('delete_session', { id: p.id });
  assert.equal((await invoke('sessions')).profiles.length, 0);
  const db = await readFile(path.join(directory, 'sessions.sqlite3'));
  assert(!db.includes(Buffer.from(process.env.DACHSTERM_PROBE_PASSWORD)));
  console.log(
    'PASS I.1 real WebView2: v2 import/rollback, trust rejection, wrong password, one-time use, consent after login, OS credential reuse after restart, locked-vault save failure, secret-free recovery and cleanup',
  );
} catch {
  console.error(`FAIL I.1 native stage: ${stage} (details suppressed to protect credentials)`);
  process.exitCode = 1;
} finally {
  if (page && browser) {
    try {
      for (const p of (await invoke('sessions')).profiles)
        await invoke('delete_session', { id: p.id });
    } catch {
      /* only isolated test data */
    }
  }
  await stop();
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
