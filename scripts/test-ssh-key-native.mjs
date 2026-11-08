// SSH key maker (TL.3) in the built app, checked by the real OpenSSH tools and a real sshd.
// Keys and Passphrases are made per run in a folder that is removed afterwards and never logged.
import { expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launchNativeApp } from './lib/native-app.mjs';
import { openNewConnectionForm } from './native-workspace.mjs';

const executable =
  process.env.DACHSTERM_EXE ??
  path.resolve(process.env.CARGO_TARGET_DIR ?? 'target', 'debug', 'dachsterm.exe');
const image = 'dachsterm-tl3-openssh';
const container = `dachsterm-tl3-ssh-key-${randomUUID()}`;
const openssh = (tool) => `C:\\Windows\\System32\\OpenSSH\\${tool}.exe`;

// Under the repository on purpose: this drive grants other accounts access by inheritance, which
// is the case Windows OpenSSH refuses. A folder in the user profile would prove nothing.
mkdirSync('target', { recursive: true });
const work = mkdtempSync(path.resolve('target', 'ssh-key-native-'));
const keys = path.join(work, 'keys');
mkdirSync(keys);

function tool(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    ...options,
  });
  // Never print `args`: they can hold a Passphrase.
  if (result.error) throw new Error(`${path.basename(command)} did not run`);
  return result;
}
function checked(command, args, options) {
  const result = tool(command, args, options);
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed: ${result.stderr}`);
  return result.stdout;
}
const docker = (args, options) => checked('docker', args, options);
const keyBody = (line) => line.trim().split(/\s+/).slice(0, 2).join(' ');
const accessEntries = (file) =>
  checked('C:\\Windows\\System32\\icacls.exe', [file])
    .split(/\r?\n/)
    .filter((line) => line.includes(':('));

function startServer() {
  docker(['build', '-q', '-t', image, 'tests/openssh'], { timeout: 300000 });
  docker(['run', '-d', '--name', container, '-p', '127.0.0.1::22', image]);
  for (let i = 0; i < 120; i++) {
    if (tool('docker', ['exec', container, 'test', '-f', '/run/probe/ready']).status === 0)
      return docker(['port', container, '22/tcp']).trim().split(':').pop();
    spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500'], {
      windowsHide: true,
    });
  }
  throw new Error('OpenSSH fixture did not start');
}
function authorize(line) {
  docker(['exec', '-i', container, 'sh', '-c', 'cat >> /home/probe/.ssh/authorized_keys'], {
    input: `${line}\n`,
  });
}
function systemLogin(port, key, env = {}, batch = true) {
  return tool(
    openssh('ssh'),
    [
      '-F',
      'none',
      '-i',
      key,
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityAgent=none',
      '-o',
      `BatchMode=${batch ? 'yes' : 'no'}`,
      '-o',
      'PreferredAuthentications=publickey',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      `UserKnownHostsFile=${path.join(work, 'known_hosts')}`,
      '-o',
      'ConnectTimeout=15',
      '-p',
      port,
      'probe@127.0.0.1',
      'echo DACHSTERM_TL3_LOGIN',
    ],
    { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

async function fillAndMake(page, dialog, { name, comment, passphrase = '' }) {
  // The defaults land asynchronously and move the caret; typing must start after them.
  await expect(dialog.getByLabel('저장 폴더', { exact: true })).not.toHaveValue('');
  await dialog.getByLabel('파일 이름', { exact: true }).fill(name);
  if (comment) await dialog.getByLabel('주석', { exact: true }).fill(comment);
  await dialog.getByLabel('Passphrase (선택)', { exact: true }).fill(passphrase);
  await dialog.getByLabel('Passphrase 확인', { exact: true }).fill(passphrase);
  await dialog.getByLabel('저장 폴더', { exact: true }).fill(keys);
  await dialog.getByRole('button', { name: '만들기', exact: true }).click();
}
async function readResult(dialog) {
  const line = dialog.getByRole('textbox', { name: '공개키', exact: true });
  await expect(line).toBeVisible({ timeout: 60000 });
  const facts = dialog.locator('.ssh-key-result dd');
  return {
    file: await facts.nth(0).innerText(),
    fingerprint: await facts.nth(1).innerText(),
    line: await line.inputValue(),
  };
}
const toolsDialog = async (page) => {
  await page.locator('.toolbar-menu summary', { hasText: '도구' }).click();
  await page
    .locator('.toolbar-menu-items')
    .getByRole('button', { name: 'SSH 키 만들기', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'SSH 키 만들기', exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
};
async function makeFromMenu(page, options) {
  const dialog = await toolsDialog(page);
  await fillAndMake(page, dialog, options);
  const result = await readResult(dialog);
  await dialog.getByRole('button', { name: '닫기', exact: true }).click();
  await expect(dialog).toBeHidden();
  return result;
}

function checkFiles(made, name, passphrase) {
  assert.equal(made.file, path.join(keys, name));
  const derived = checked(openssh('ssh-keygen'), ['-y', '-P', passphrase, '-f', made.file]);
  assert.equal(keyBody(derived), keyBody(made.line));
  assert.equal(readFileSync(`${made.file}.pub`, 'utf8'), `${made.line}\n`);
  const listed = checked(openssh('ssh-keygen'), ['-l', '-E', 'sha256', '-f', made.file]);
  assert.equal(listed.trim().split(/\s+/)[1], made.fingerprint);
  const entries = accessEntries(made.file);
  assert.equal(entries.length, 1, 'only the current user has access');
  assert.ok(!entries[0].includes('(I)'), 'nothing inherited');
}

async function loginInApp(page, { name, port, keyPath, passphrase }) {
  await openNewConnectionForm(page);
  const form = page.getByRole('dialog', { name: '새 연결', exact: true });
  await form.getByLabel('이름', { exact: true }).fill(name);
  await form.getByLabel('호스트', { exact: true }).fill('127.0.0.1');
  await form.getByLabel('포트', { exact: true }).fill(port);
  await form.getByLabel('사용자', { exact: true }).fill('probe');
  await form.getByLabel('인증 방식').selectOption('key');
  let result = null;
  if (keyPath) await form.getByLabel('개인키 파일 경로', { exact: true }).fill(keyPath);
  else {
    await form.locator('.login-key-field').getByRole('button', { name: '새 키…' }).click();
    const dialog = page.getByRole('dialog', { name: 'SSH 키 만들기', exact: true });
    await fillAndMake(page, dialog, { name: 'tl3_form' });
    result = await readResult(dialog);
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await expect(form.getByLabel('개인키 파일 경로', { exact: true })).toHaveValue(result.file);
    authorize(result.line);
  }
  if (passphrase)
    await form
      .getByLabel('Passphrase (암호화되지 않은 키는 비워 두세요)', { exact: true })
      .fill(passphrase);
  await form.getByRole('button', { name: '저장 후 연결', exact: true }).click();
  // By name: an empty workspace already counts one placeholder tab.
  await expect(page.locator('.tab-strip').getByRole('tab').filter({ hasText: name })).toHaveCount(
    1,
    { timeout: 20000 },
  );
  return result;
}
const focused = (page) =>
  page.locator('.pane-cell.focused .terminal-pane:not([hidden]) .connection-message');

let opened;
let serverStarted = false;
let stage = 'startup';
try {
  stage = 'OpenSSH fixture';
  const port = startServer();
  serverStarted = true;
  stage = 'app start';
  opened = await launchNativeApp({ executable, directory: path.join(work, 'data') });
  const { page } = opened;
  const invoke = (command, args) =>
    page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [command, args]);

  stage = 'defaults';
  const first = await toolsDialog(page);
  await expect(first.getByLabel('파일 이름', { exact: true })).toHaveValue('id_ed25519');
  await expect(first.getByLabel('저장 폴더', { exact: true })).toHaveValue(/[\\/]\.ssh$/);
  await expect(first.getByLabel('주석', { exact: true })).toHaveValue(/.+@.+/);
  await first.getByRole('button', { name: '취소', exact: true }).click();
  await expect(first).toBeHidden();
  console.log('PASS tools menu opens the dialog with the defaults');

  stage = 'plain key';
  const plain = await makeFromMenu(page, { name: 'tl3_plain', comment: 'tl3@native' });
  assert.equal(plain.line.split(/\s+/).slice(2).join(' '), 'tl3@native');
  checkFiles(plain, 'tl3_plain', '');
  stage = 'encrypted key';
  const passphrase = randomBytes(18).toString('hex');
  const locked = await makeFromMenu(page, {
    name: 'tl3_locked',
    comment: 'tl3@native',
    passphrase,
  });
  checkFiles(locked, 'tl3_locked', passphrase);
  assert.notEqual(
    tool(openssh('ssh-keygen'), ['-y', '-P', 'wrong', '-f', locked.file]).status,
    0,
    'a wrong Passphrase is refused',
  );
  console.log('PASS ssh-keygen reads both keys, fingerprints match, ACL is the current user only');

  stage = 'ssh_key_info';
  for (const [made, encrypted] of [
    [plain, false],
    [locked, true],
  ]) {
    const info = await invoke('ssh_key_info', { path: made.file });
    assert.equal(info.fingerprint, made.fingerprint);
    assert.equal(info.algorithm, 'ssh-ed25519');
    assert.equal(info.encrypted, encrypted);
  }
  console.log('PASS the app reads the same fingerprints');

  stage = 'existing file';
  const before = readFileSync(plain.file);
  const refused = await toolsDialog(page);
  await fillAndMake(page, refused, { name: 'tl3_plain' });
  await expect(refused.getByRole('alert')).toContainText('덮어쓰지 않으니', { timeout: 20000 });
  await refused.getByRole('button', { name: '취소', exact: true }).click();
  assert.deepEqual(readFileSync(plain.file), before);
  console.log('PASS an existing key is refused and unchanged');

  stage = 'system ssh';
  authorize(plain.line);
  authorize(locked.line);
  const login = systemLogin(port, plain.file);
  assert.equal(login.status, 0, `system ssh refused the plain key: ${login.stderr}`);
  assert.ok(login.stdout.includes('DACHSTERM_TL3_LOGIN'));

  const askpass = path.join(work, 'askpass.cmd');
  const phraseFile = path.join(work, 'phrase.txt');
  writeFileSync(phraseFile, passphrase);
  writeFileSync(askpass, `@type "${phraseFile}"\r\n`);
  const lockedLogin = systemLogin(
    port,
    locked.file,
    { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force' },
    false,
  );
  assert.equal(lockedLogin.status, 0, `system ssh refused the locked key: ${lockedLogin.stderr}`);
  assert.ok(lockedLogin.stdout.includes('DACHSTERM_TL3_LOGIN'));
  console.log('PASS real ssh.exe logs in to OpenSSH with both keys');

  stage = 'ACL control';
  // The same key with the folder's inherited access: shows that the ACL above is what passed.
  const control = path.join(keys, 'tl3_control');
  writeFileSync(control, readFileSync(plain.file));
  const inherited = accessEntries(control);
  assert.ok(inherited.length > 1, 'the folder grants more than one account');
  const refusedLogin = systemLogin(port, control);
  assert.notEqual(refusedLogin.status, 0);
  assert.match(refusedLogin.stderr, /UNPROTECTED PRIVATE KEY FILE|bad permissions/i);
  rmSync(control);
  console.log(`PASS control copy with ${inherited.length} inherited entries is refused by ssh.exe`);

  stage = 'app login, key made in the form';
  const formMade = await loginInApp(page, { name: 'TL3 form', port });
  await expect(page.getByRole('alert', { name: '최초 호스트키 확인' })).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole('button', { name: '지문 확인 · 신뢰하고 연결', exact: true }).click();
  await expect(focused(page)).toContainText('연결됨', { timeout: 20000 });
  checkFiles(formMade, 'tl3_form', '');
  console.log('PASS a key made in the session form logs in through the app');

  stage = 'app login, encrypted key';
  await loginInApp(page, {
    name: 'TL3 locked',
    port,
    keyPath: locked.file,
    passphrase,
  });
  await expect(focused(page)).toContainText('연결됨', { timeout: 30000 });
  assert.equal(
    (await docker(['exec', container, 'pgrep', '-c', '-u', 'probe', 'bash'])).trim(),
    '2',
    'one server shell for each app session',
  );
  console.log('PASS an encrypted key logs in through the app');
  console.log('PASS TL.3 SSH key maker');
} catch (error) {
  console.error(`FAILED at: ${stage}`);
  const failure = process.env.DACHSTERM_FAILURE_SCREENSHOT;
  if (failure) await opened?.page.screenshot({ path: failure }).catch(() => {});
  throw error;
} finally {
  await opened?.stop();
  if (serverStarted || tool('docker', ['ps', '-aq', '-f', `name=${container}`]).stdout.trim())
    tool('docker', ['rm', '-f', container]);
  rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
