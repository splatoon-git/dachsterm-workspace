// Windows WebView2 check of the connection and terminal additions (CG.1~CG.5, CG.7) in the real
// app against `npm run connect:fixture -- up`: an HTTP CONNECT proxy, a SOCKS5 proxy with a user
// certificate, a ProxyCommand through Windows OpenSSH `ssh -W`, a Telnet tab and a highlight rule.
// The fixture's throwaway secrets are typed into the app's own prompts and never printed.
//
//   npm run test:connect          after `npm run test:native` built target/debug/dachsterm.exe
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchNativeApp } from './lib/native-app.mjs';

const secrets = path.join(tmpdir(), 'dachsterm-connect-fixture');
if (!existsSync(path.join(secrets, 'proxy.password'))) {
  console.error('The connect fixture is not up. Run: npm run connect:fixture -- up');
  process.exit(2);
}
const secret = (name) => readFileSync(path.join(secrets, name), 'utf8').trim();
// The fixture's tinyproxy took 18-37 s per CONNECT under load (CG.1), so connections wait long.
const CONNECT_WAIT = 150_000;
const sshClient = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'OpenSSH',
  'ssh.exe',
);
const executable = process.env.DACHSTERM_TEST_BINARY ?? path.resolve('target/debug/dachsterm.exe');
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-connect-'));

const base = {
  id: '',
  port: 22,
  username: 'probe',
  tlsCaPath: '',
  encoding: 'utf-8',
  keyPath: '',
  groupId: null,
  favorite: false,
  timeout: 120,
  keepalive: 15,
  lastConnected: null,
  hasSecret: false,
  jumpIds: [],
  tags: [],
  sortOrder: 0,
};
const proxy = (kind, port) => ({ kind, host: '127.0.0.1', port, username: 'probe' });
const sessions = [
  {
    ...base,
    name: 'CG HTTP 프록시',
    host: 'target',
    auth: 'password',
    protocol: 'ssh',
    proxy: proxy('http', 43128),
  },
  {
    ...base,
    name: 'CG SOCKS5 인증서',
    host: 'target',
    auth: 'key',
    protocol: 'ssh',
    keyPath: path.join(secrets, 'cert_ed25519'),
    proxy: proxy('socks5', 41080),
  },
  {
    ...base,
    name: 'CG 명령 프록시',
    host: 'target',
    auth: 'password',
    protocol: 'ssh',
    proxy: {
      kind: 'command',
      command: `"${sshClient}" -i "${path.join(secrets, 'plain')}" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o LogLevel=ERROR -p 42222 -W %h:%p probe@127.0.0.1`,
    },
  },
  {
    ...base,
    name: 'CG Telnet',
    host: '127.0.0.1',
    port: 42323,
    username: '',
    auth: 'interactive',
    protocol: 'telnet',
  },
];

let launched;
let page;
let stage = 'launch';
let pageErrors = 0;
const pane = () => page.locator('.pane-cell.focused .terminal-pane');
const rows = () => pane().locator('.xterm-rows');
async function invoke(command, args = {}) {
  return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
}
/** Types into the focused terminal. A password typed here is never echoed or logged. */
async function type(text) {
  await pane().locator('.xterm-helper-textarea').focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}
async function seen(text, timeout = 20_000) {
  await expect.poll(() => rows().innerText(), { timeout }).toContain(text);
}
async function open(name) {
  stage = `${name}: open`;
  await page.locator('.profile-target').filter({ hasText: name }).dblclick();
}
async function answerPasswordDialog(name, value) {
  stage = `${name}: login dialog`;
  const dialog = page.getByRole('dialog', { name: `${name} 인증` });
  await dialog.locator('input[type="password"]').fill(value);
  await dialog.getByRole('button', { name: '연결', exact: true }).click();
}
async function answerProxyPassword(name) {
  stage = `${name}: proxy password prompt`;
  const form = page.getByRole('form', { name: '서버 추가 인증' });
  await expect(form).toBeVisible({ timeout: 30_000 });
  await expect(form).toContainText('프록시 암호');
  await form.locator('input').fill(secret('proxy.password'));
  await form.getByRole('button', { name: '인증 응답', exact: true }).click();
}
async function trustAndConnect(name, endpoint) {
  stage = `${name}: host key`;
  const trust = page.getByRole('alert', { name: '최초 호스트키 확인' });
  await expect(trust).toBeVisible({ timeout: CONNECT_WAIT });
  await expect(trust).toContainText(endpoint);
  await page.getByRole('button', { name: '지문 확인 · 신뢰하고 연결', exact: true }).click();
  stage = `${name}: connected`;
  await expect(pane().locator('.connection-message')).toContainText('연결됨', {
    timeout: CONNECT_WAIT,
  });
}
async function hostIs(name, host) {
  stage = `${name}: shell on ${host}`;
  await type(`printf 'CG10_HOST_%s_END\\n' "$(hostname)"`);
  await seen(`CG10_HOST_${host}_END`);
}
async function close(name) {
  await page.getByRole('button', { name: `${name} 탭 닫기`, exact: true }).click();
}

try {
  launched = await launchNativeApp({ executable, directory });
  page = launched.page;
  page.setDefaultTimeout(15_000);
  page.on('pageerror', () => pageErrors++);
  await expect(page.getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();

  stage = 'save sessions';
  for (const profile of sessions) {
    await invoke('save_session', { profile, secretAction: 'keep', secret: null });
  }
  stage = 'save highlight rule';
  const library = await invoke('highlight_rules');
  await invoke('highlight_rules_save', {
    revision: library.revision,
    items: [
      {
        id: 'cg10-hit',
        name: 'CG10 표식',
        pattern: 'CG10HIT',
        ignoreCase: false,
        scope: { kind: 'all' },
        color: 'danger',
        notify: false,
        send: null,
        enabled: true,
      },
    ],
  });
  await page.reload();

  // CG.1: an HTTP CONNECT proxy whose password is asked for at connect time, not stored.
  const http = sessions[0].name;
  await open(http);
  await answerPasswordDialog(http, secret('user.password'));
  await answerProxyPassword(http);
  await trustAndConnect(http, 'target:22');
  await hostIs(http, 'target');

  // CG.7: the rule colors a match in the real WebView2 renderer and leaves the next line alone.
  stage = 'highlight paints the match';
  await type(`printf 'CG10%s\\nCG10%s\\n' HIT MISS`);
  await seen('CG10MISS');
  const firstCell = (text) =>
    rows()
      .locator('div', { hasText: new RegExp(`^${text}\\s*$`) })
      .first()
      .locator('span')
      .first()
      .evaluate((element) => getComputedStyle(element).color);
  await expect
    .poll(async () => (await firstCell('CG10HIT')) !== (await firstCell('CG10MISS')), {
      timeout: 10_000,
    })
    .toBe(true);
  await close(http);

  // CG.1 + CG.3: SOCKS5 with a user certificate found beside the key (`-cert.pub`).
  const socks = sessions[1].name;
  await open(socks);
  await answerPasswordDialog(socks, '');
  await answerProxyPassword(socks);
  await trustAndConnect(socks, 'target:22');
  await hostIs(socks, 'target');
  await close(socks);

  // CG.2: ProxyCommand on Windows, the program started without cmd.exe and no console window.
  const command = sessions[2].name;
  await open(command);
  await answerPasswordDialog(command, secret('user.password'));
  await trustAndConnect(command, 'target:22');
  await hostIs(command, 'target');
  await close(command);

  // CG.4: Telnet logs in through the terminal itself; the status bar says it is unencrypted.
  const telnet = sessions[3].name;
  await open(telnet);
  stage = 'telnet: login prompt';
  await seen('login:', CONNECT_WAIT);
  await expect(page.getByText('Telnet · 암호화 없음', { exact: false })).toBeVisible();
  await type('probe');
  stage = 'telnet: password prompt';
  await seen('assword:');
  await type(secret('user.password'));
  stage = 'telnet: shell';
  await type(`printf 'CG10_TELNET_%s_END\\n' "$TERM"`);
  await seen('CG10_TELNET_xterm-256color_END');
  assert(!(await rows().innerText()).includes(secret('user.password')));
  await close(telnet);

  stage = 'page errors';
  assert.equal(pageErrors, 0);
  console.log(
    'PASS connect native: HTTP proxy with prompted password, highlight paint, SOCKS5 with certificate, Windows ProxyCommand ssh -W, Telnet login',
  );
} catch {
  // Assertion details may carry what was typed, so only the stage is printed.
  console.error(`FAIL connect native stage: ${stage} (details suppressed to protect credentials)`);
  process.exitCode = 1;
} finally {
  await launched?.stop();
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}
