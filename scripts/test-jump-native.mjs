// Real isolated WebView2 + OpenSSH + Windows credential store, using ephemeral fixture credentials.
// Never print assertion traces or capture authentication fields.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { openTerminalSearch } from './native-workspace.mjs';
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-jump-'));
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

const make = (name, port) => ({
  id: name,
  name,
  host: '127.0.0.1',
  port,
  username: 'probe',
  auth: 'password',
  protocol: 'ssh',
  tlsCaPath: '',
  encoding: 'utf-8',
  keyPath: '',
  groupId: 'child',
  favorite: false,
  timeout: 15,
  keepalive: 5,
  lastConnected: null,
  hasSecret: false,
  jumpIds: [],
  tags: ['prod'],
  sortOrder: 0,
});
const root = make('경유 서버', Number(process.env.DACHSTERM_PROBE_PORT));
const target = { ...make('최종 서버', 22), jumpIds: [root.id] };
const bundle = {
  format: 'dachsterm.sessions',
  version: 3,
  profiles: [root, target],
  groups: [
    { id: 'child', name: '서울', parentId: 'root', sortOrder: 1 },
    { id: 'root', name: '운영', parentId: null, sortOrder: 0 },
  ],
  tunnels: [],
  templates: [
    {
      id: 'template',
      name: '운영 기본',
      options: { jumpIds: [root.id], tags: ['prod'], port: 22 },
    },
  ],
};
const pane = () => page.locator('.pane-cell.focused .terminal-pane');
let pageErrors = 0;
try {
  await launch();
  page.on('pageerror', () => pageErrors++);
  stage = 'v3 import remaps references';
  assert.equal(await invoke('config_apply', { data: JSON.stringify(bundle) }), 2);
  let snapshot = await invoke('sessions');
  const savedRoot = snapshot.profiles.find((p) => p.name === root.name);
  const savedTarget = snapshot.profiles.find((p) => p.name === target.name);
  assert.deepEqual(savedTarget.jumpIds, [savedRoot.id]);
  assert.notEqual(savedRoot.id, root.id);
  assert.equal((await invoke('session_templates'))[0].options.jumpIds[0], savedRoot.id);
  await assert.rejects(invoke('delete_session', { id: savedRoot.id }));
  await page.reload();
  stage = 'native two independent trust prompts and hop authentication';
  await page.locator('.profile-target').filter({ hasText: target.name }).dblclick();
  const auth = page.getByRole('dialog', { name: `${target.name} 인증` });
  await auth.getByLabel('비밀번호', { exact: true }).fill(process.env.DACHSTERM_PROBE_PASSWORD);
  await auth.getByRole('button', { name: '연결', exact: true }).click();
  stage = 'hop authentication prompt';
  // The hop secret prompt happens before negotiation; answer it through the actual UI.
  await expect(page.getByRole('form', { name: '서버 추가 인증' })).toBeVisible();
  await page
    .getByRole('form', { name: '서버 추가 인증' })
    .locator('input')
    .fill(process.env.DACHSTERM_PROBE_PASSWORD);
  await page.getByRole('button', { name: '인증 응답', exact: true }).click();
  for (let i = 0; i < 2; i++) {
    stage = `host trust ${i + 1}`;
    await expect(page.getByRole('alert', { name: '최초 호스트키 확인' })).toBeVisible();
    await expect(page.getByRole('alert', { name: '최초 호스트키 확인' })).toContainText(
      `127.0.0.1:${i === 0 ? root.port : 22}`,
    );
    await page.getByRole('button', { name: '지문 확인 · 신뢰하고 연결', exact: true }).click();
  }
  stage = 'connected route and actual PTY';
  await expect(pane().locator('.connection-message')).toContainText('연결됨');
  stage = 'connected route label';
  await expect(pane().locator('.connection-message')).toContainText('경유 서버');
  stage = 'PTY paste';
  const terminal = pane().locator('.xterm-helper-textarea');
  await terminal.focus();
  await terminal.evaluate((element, value) => {
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', value);
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }),
    );
  }, "printf 'NATIVE_JUMP_OK\\n'");
  await terminal.press('Enter');
  stage = 'PTY search';
  const search = await openTerminalSearch(page, pane());
  await search.fill('NATIVE_JUMP_OK');
  await expect
    .poll(async () => {
      await search.press('Enter');
      return pane().locator('.xterm-accessibility-tree').innerText();
    })
    .toContain('NATIVE_JUMP_OK');
  await search.press('Escape');
  await page.getByRole('button', { name: `${target.name} 탭 닫기`, exact: true }).click();
  stage = 'batch preview through native UI';
  await page.getByRole('button', { name: '설정', exact: true }).click();
  const management = page.getByRole('region', { name: '고급 세션 관리' });
  await management.getByLabel('관리 대상 검색').fill('tag:prod group:서울');
  await management.getByRole('button', { name: '검색 결과 전체 선택' }).click();
  await management.getByLabel('태그 변경', { exact: true }).check();
  await management.getByLabel('일괄 태그', { exact: true }).fill('prod, verified');
  await management.getByRole('button', { name: '변경 미리보기' }).click();
  await expect(management.getByRole('heading', { name: '2개 세션 변경 확인' })).toBeVisible();
  await management.getByRole('button', { name: '복구본 생성 후 일괄 적용' }).click();
  await expect(management.getByRole('status')).toContainText('2개 변경 완료');
  snapshot = await invoke('sessions');
  assert(snapshot.profiles.every((p) => p.tags.includes('verified')));
  stage = 'template new form and route display';
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '서버 추가', exact: true }).click();
  stage = 'template select';
  await page.getByLabel('공통 설정 템플릿').selectOption({ label: '운영 기본' });
  stage = 'template route display';
  await expect(page.getByRole('dialog').getByRole('listitem')).toContainText('경유 서버');
  await page.keyboard.press('Escape');
  stage = 'secret-free actual exported recovery and restart';
  await invoke('recovery_create');
  const files = (await readdir(path.join(directory, 'recovery'))).filter((f) =>
    f.endsWith('.json'),
  );
  let newest;
  for (const file of files) {
    const data = await readFile(path.join(directory, 'recovery', file), 'utf8');
    assert(!data.includes(process.env.DACHSTERM_PROBE_PASSWORD));
    const b = JSON.parse(data);
    assert.equal(b.version, 3);
    assert(b.profiles.every((p) => !p.hasSecret));
    if (b.profiles.some((p) => p.tags.includes('verified'))) newest = b;
  }
  assert(newest);
  await mkdir('target/verification', { recursive: true });
  await writeFile('target/verification/session-v3-export.json', JSON.stringify(newest, null, 2));
  await stop();
  await launch();
  snapshot = await invoke('sessions');
  assert(snapshot.profiles.every((p) => p.tags.includes('verified')));
  assert.equal((await invoke('session_templates')).length, 1);
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.setViewportSize({ width: 560, height: 820 });
  await page.getByRole('region', { name: '고급 세션 관리' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'target/verification/session-management-native.png' });
  assert.equal(pageErrors, 0);
  const binary = process.env.DACHSTERM_TEST_BINARY ?? path.resolve('target/debug/dachsterm.exe');
  await writeFile(
    'target/verification/session-management-native.json',
    JSON.stringify(
      {
        passed: true,
        sha256: createHash('sha256')
          .update(await readFile(binary))
          .digest('hex'),
        pageErrors,
        checks: [
          'v3 remap',
          'hop secret UI',
          'two host trust UI',
          'actual PTY',
          'batch preview',
          'template form',
          'export recovery',
          'restart',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS 6.4/6.5 native WebView2 jump PTY, hop authentication/trust, v3 hierarchy/template/import, batch UI, recovery export/restart',
  );
} catch {
  if (stage === 'connected route and actual PTY') {
    const message = await pane()
      .locator('.connection-message')
      .textContent()
      .catch(() => 'unavailable');
    console.error(`Connection state: ${message}`);
  }
  console.error(`FAIL jump native stage: ${stage} (details suppressed to protect credentials)`);
  process.exitCode = 1;
} finally {
  await stop();
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
