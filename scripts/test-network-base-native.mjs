// A network tool's remote source (TL.5) in the built app against a real OpenSSH server.
// The fixture password is read from the container per run and is never printed.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchNativeApp } from './lib/native-app.mjs';

const executable =
  process.env.DACHSTERM_EXE ??
  path.resolve(process.env.CARGO_TARGET_DIR ?? 'target', 'debug', 'dachsterm.exe');
const image = 'dachsterm-tl5-openssh';
const container = `dachsterm-tl5-network-${randomUUID()}`;
const directory = mkdtempSync(path.join(tmpdir(), 'dachsterm-tl5-'));
const TOOL = '포트 개통';

function tool(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    ...options,
  });
  if (result.error) throw new Error(`${path.basename(command)} did not run`);
  return result;
}
function docker(args, options) {
  const result = tool('docker', args, options);
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed`);
  return result.stdout;
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer() {
  docker(['build', '-q', '-t', image, 'tests/openssh'], { timeout: 300000 });
  docker(['run', '-d', '--name', container, '-p', '127.0.0.1::22', image]);
  for (let i = 0; i < 120; i++) {
    if (tool('docker', ['exec', container, 'test', '-f', '/run/probe/ready']).status === 0)
      return Number(docker(['port', container, '22/tcp']).trim().split(':').pop());
    await wait(500);
  }
  throw new Error('OpenSSH fixture did not start');
}
/** The server's own view of the login: one line per logged-in connection. */
const logins = () =>
  docker(['exec', container, 'ps', '-eo', 'args'])
    .split('\n')
    .filter((line) => line.startsWith('sshd: probe') && !line.includes('[priv]'));
const shells = () =>
  Number(tool('docker', ['exec', container, 'pgrep', '-c', '-u', 'probe', 'bash']).stdout.trim());
const expectLogins = (count) => expect.poll(() => logins().length, { timeout: 15000 }).toBe(count);

function profile(name, port, over = {}) {
  return {
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
    groupId: null,
    favorite: false,
    timeout: 15,
    keepalive: 5,
    lastConnected: null,
    hasSecret: false,
    jumpIds: [],
    tags: [],
    sortOrder: 0,
    ...over,
  };
}

let opened;
let serverStarted = false;
let savedId;
let stage = 'startup';
const pageOf = () => opened.page;
const invoke = (command, args = {}) =>
  pageOf().evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);
const region = () => pageOf().getByRole('region', { name: TOOL, exact: true });
const status = () => region().getByRole('status');
const prompt = () => region().getByRole('form', { name: '서버 추가 인증' });
const trustCard = () => region().getByRole('alert', { name: '최초 호스트키 확인' });

async function openTool() {
  const page = pageOf();
  await page.locator('.toolbar-menu summary', { hasText: '도구' }).click();
  await page
    .getByRole('navigation', { name: '네트워크 도구 목록' })
    .getByRole('button', { name: TOOL, exact: true })
    .click();
  await expect(region()).toBeVisible();
}
const closeTool = async () => {
  await pageOf()
    .getByRole('button', { name: `${TOOL} 탭 닫기`, exact: true })
    .click();
  await expect(region()).toHaveCount(0);
};
async function pick(name) {
  await region().getByRole('radio', { name: '리모트', exact: true }).check();
  await region().locator('.tool-session > button').click();
  await region().locator('.tool-session-list button').filter({ hasText: name }).click();
}
async function answerPrompt(secret, expected) {
  await expect(prompt()).toBeVisible({ timeout: 20000 });
  await expect(prompt()).toContainText(expected);
  await prompt().locator('input').fill(secret);
  await prompt().getByRole('button', { name: '인증 응답', exact: true }).click();
  await expect(prompt()).toBeHidden({ timeout: 20000 });
}
const trust = async (host, accept = true) => {
  await expect(trustCard()).toBeVisible({ timeout: 20000 });
  await expect(trustCard()).toContainText(host);
  await trustCard()
    .getByRole('button', { name: accept ? '지문 확인 · 신뢰하고 연결' : '거부', exact: true })
    .click();
};
const connected = () => expect(status()).toContainText('연결됨', { timeout: 30000 });
const again = () => region().getByRole('button', { name: '다시 연결', exact: true }).click();

async function launch() {
  opened = await launchNativeApp({ executable, directory });
  pageOf().setDefaultTimeout(15000);
  await expect(pageOf().getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
}

async function connectTerminal(name, password) {
  const page = pageOf();
  await page.locator('.profile-target').filter({ hasText: name }).dblclick();
  const dialog = page.getByRole('dialog', { name: `${name} 인증` });
  await dialog.getByLabel('비밀번호', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: '연결', exact: true }).click();
  await expect(
    page.locator('.pane-cell.focused .terminal-pane:not([hidden]) .connection-message'),
  ).toContainText('연결됨', { timeout: 30000 });
}

try {
  stage = 'OpenSSH fixture';
  const port = await startServer();
  serverStarted = true;
  const password = docker(['exec', container, 'cat', '/run/probe/password']).trim();

  stage = 'app start and sessions';
  await launch();
  const direct = profile('TL5 direct', port);
  const hop = profile('TL5 hop', port);
  const target = profile('TL5 target', 22, { jumpIds: [hop.id] });
  const imported = await invoke('config_apply', {
    data: JSON.stringify({
      format: 'dachsterm.sessions',
      version: 3,
      profiles: [direct, hop, target],
      groups: [],
      tunnels: [],
      templates: [],
    }),
  });
  assert.equal(imported, 3);
  // Saved here because an import always turns auto-start off.
  const directId = (await invoke('sessions')).profiles.find((p) => p.name === direct.name).id;
  await invoke('tunnel_save', {
    configs: [
      {
        id: randomUUID(),
        profileId: directId,
        name: 'TL5 auto',
        kind: 'local',
        port: 40000 + Math.floor(Math.random() * 20000),
        host: '127.0.0.1',
        targetPort: 22,
        autoStart: true,
      },
    ],
  });
  await pageOf().reload();
  await expect(pageOf().getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();

  stage = 'a refused host key, a wrong password, then a login';
  await openTool();
  await pick(direct.name);
  await answerPrompt(password, '세션 인증');
  await trust(`127.0.0.1:${port}`, false);
  await expect(status()).toContainText('거부', { timeout: 20000 });
  await expectLogins(0);
  await again();
  await answerPrompt('not-the-password', '세션 인증');
  await trust(`127.0.0.1:${port}`);
  await expect(status()).toContainText('인증', { timeout: 30000 });
  await expect(region().getByRole('button', { name: '다시 연결', exact: true })).toBeVisible({
    timeout: 30000,
  });
  await again();
  await answerPrompt(password, '세션 인증');
  await connected();
  console.log('PASS the login and host key cards appear in the tool tab and answer the server');

  stage = 'no shell, no terminal, no tunnel';
  await expect(pageOf().locator('.terminal-pane')).toHaveCount(0);
  await expectLogins(1);
  assert.ok(!logins()[0].includes('@pts'), `a PTY was opened: ${logins()[0]}`);
  assert.equal(shells(), 0, 'the tool opened a shell');
  assert.deepEqual(await invoke('tunnel_list'), [], 'a tunnel started with the tool connection');
  console.log('PASS the connection stops after login: no PTY, shell or auto-start tunnel');

  stage = 'closing the tab ends the connection';
  await closeTool();
  await expectLogins(0);
  console.log('PASS closing the tool tab disconnects from the server');

  stage = 'a saved secret needs no card';
  const stored = await invoke('sessions');
  const savedProfile = stored.profiles.find((p) => p.name === direct.name);
  const saved = await invoke('save_session', {
    profile: { ...savedProfile, id: '', name: 'TL5 saved' },
    secretAction: 'replace',
    secret: password,
  });
  savedId = saved.id;
  await pageOf().reload();
  await expect(pageOf().getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
  await openTool();
  await pick('TL5 saved');
  await connected();
  await expect(prompt()).toHaveCount(0);
  await expect(trustCard()).toHaveCount(0);
  await closeTool();
  await expectLogins(0);
  console.log('PASS a session with a saved password connects with no card');

  stage = 'reuse a connected terminal';
  await connectTerminal(direct.name, password);
  await expect.poll(() => shells()).toBe(1);
  await expectLogins(1);
  await expect.poll(async () => (await invoke('tunnel_list')).length, { timeout: 15000 }).toBe(1);
  await openTool();
  await region().getByRole('radio', { name: '리모트', exact: true }).check();
  await region().locator('.tool-session > button').click();
  await expect(
    region().locator('.tool-session-list button').filter({ hasText: direct.name }),
  ).toContainText('연결됨');
  await region().locator('.tool-session-list button').filter({ hasText: direct.name }).click();
  await expect(status()).toContainText('터미널 연결을 함께', { timeout: 20000 });
  await expect(prompt()).toHaveCount(0);
  await expectLogins(1);
  assert.equal(shells(), 1);
  console.log('PASS a connected terminal is reused: one login, one shell, no prompt');

  stage = 'letting go of a reused connection leaves the terminal';
  await closeTool();
  await wait(1500);
  await expectLogins(1);
  assert.equal(shells(), 1);
  const terminalTab = pageOf().getByRole('button', { name: `${direct.name} 탭 닫기`, exact: true });
  await expect(terminalTab).toBeVisible();
  console.log('PASS closing the tool tab leaves the reused terminal connected');

  stage = 'the terminal ending ends the reused source';
  await openTool();
  await pick(direct.name);
  await expect(status()).toContainText('터미널 연결을 함께', { timeout: 20000 });
  await terminalTab.click();
  await expect(status()).toContainText('함께 쓰던 터미널', { timeout: 20000 });
  await expect(region().getByRole('button', { name: '다시 연결', exact: true })).toBeVisible();
  await expectLogins(0);
  await closeTool();
  console.log('PASS a reused source reports the end of its terminal');

  stage = 'a jump route';
  await openTool();
  await pick(target.name);
  await answerPrompt(password, '경유지 인증');
  await answerPrompt(password, '세션 인증');
  await trust('127.0.0.1:22');
  await connected();
  await expect(status()).toContainText(hop.name);
  await expectLogins(2);
  assert.ok(
    logins().every((line) => !line.includes('@pts')),
    'a PTY was opened on the route',
  );
  assert.equal(shells(), 0, 'a shell was opened on the route');
  await closeTool();
  await expectLogins(0);
  console.log('PASS a jump route logs in at both hops with no shell and ends with its tab');

  stage = 'idle timeout';
  await opened.stop();
  process.env.DACHSTERM_TEST_NET_IDLE_SECONDS = '6';
  await launch();
  await openTool();
  await pick('TL5 saved');
  await connected();
  await expectLogins(1);
  await wait(4000);
  await pick('TL5 saved');
  await wait(4000);
  await expectLogins(1);
  await expect(status()).toContainText('연결됨');
  console.log('PASS choosing the session again restarts the idle clock');
  await expect(status()).toContainText('쓰지 않아', { timeout: 20000 });
  await expectLogins(0);
  await expect(region().getByRole('button', { name: '다시 연결', exact: true })).toBeVisible();
  console.log('PASS an unused connection closes after the idle limit');
  console.log('PASS TL.5 network tool remote source');
} catch (error) {
  console.error(`FAILED at: ${stage}`);
  const failure = process.env.DACHSTERM_FAILURE_SCREENSHOT;
  if (failure) await opened?.page.screenshot({ path: failure }).catch(() => {});
  // Only the assertion and its place: a call log could echo what was typed into a card.
  const lines = error instanceof Error ? (error.stack ?? '').split('\n') : [];
  console.error(lines[0] ?? 'failed');
  console.error(lines.filter((line) => /^\s*(Expected|Received):/.test(line)).join(' '));
  console.error(lines.find((line) => line.includes('test-network-base-native')) ?? '');
  process.exitCode = 1;
} finally {
  // The saved password sits in the OS credential store, which outlives the app's own folder.
  if (savedId && opened)
    await invoke('delete_session', { id: savedId }).catch(() => {
      console.error('WARNING the fixture credential was not removed');
    });
  await opened?.stop();
  if (serverStarted || tool('docker', ['ps', '-aq', '-f', `name=${container}`]).stdout.trim())
    tool('docker', ['rm', '-f', container]);
  rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
