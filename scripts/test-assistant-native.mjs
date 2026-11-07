// Isolated real WebView2 + local PTY + disposable OpenSSH verification.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import { commands } from '../src/features/terminal/guideData.ts';
import {
  arrangeTabs,
  chooseTabMenu,
  inputScope,
  openNewConnectionForm,
  showSidebarView,
} from './native-workspace.mjs';
const binary = process.env.DACHSTERM_TEST_BINARY ?? path.resolve('target/debug/dachsterm.exe');
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-assistant-'));
const fixture = `dachsterm-assistant-${randomUUID()}`;
const result = { checks: [], pageErrors: 0 };
let app,
  browser,
  page,
  created = false,
  stage = 'fixture';
const docker = (args) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0) throw Error(`Docker ${args[0]} failed`);
  return r.stdout.trim();
};
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
async function launch() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  app = spawn(binary, [], {
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
  for (let i = 0; i < 100; i++) {
    try {
      endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  if (!endpoint) throw Error('CDP unavailable');
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  for (let i = 0; i < 80; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('tauri.localhost'));
    if (page) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!page) throw Error('app unavailable');
  page.setDefaultTimeout(15000);
  page.on('pageerror', () => result.pageErrors++);
  await expect(page.locator('.local-targets')).toBeVisible();
}
const text = (pane) => pane.locator('.xterm-accessibility-tree');
async function enter(pane, body) {
  const input = pane.locator('.xterm-helper-textarea');
  await input.focus();
  await input.evaluate((e, value) => {
    const d = new DataTransfer();
    d.setData('text/plain', value);
    e.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }),
    );
  }, body);
  await input.press('Enter');
}
/** The 명령 panel from its title bar button, in the main window or a detached one. */
async function openCommands(target = page) {
  await target.getByRole('button', { name: '명령', exact: true }).click();
  return target.getByRole('dialog', { name: '명령', exact: true });
}
/** Saves a new snippet in the panel; it is chosen and ready to send once saved. */
async function saveSnippet(dialog, name, body) {
  await dialog.getByRole('button', { name: '새 스니펫', exact: true }).first().click();
  await dialog.getByLabel('이름', { exact: true }).fill(name);
  await dialog.getByLabel('명령 본문', { exact: true }).fill(body);
  await dialog.getByLabel(/인증정보가 들어 있지 않습니다/).check();
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(
    dialog.locator('#command-list').getByRole('button', { name: new RegExp(name) }),
  ).toHaveAttribute('aria-current', 'true');
}
try {
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    fixture,
    '--label',
    'app.dachsterm.purpose=assistant-verification',
    '-p',
    '127.0.0.1::22',
    '--tmpfs',
    '/run/probe:rw,noexec,nosuid,mode=0700',
    'dachsterm-openssh-probe',
  ]);
  created = true;
  for (let i = 0; i < 80; i++) {
    if (
      spawnSync('docker', ['exec', fixture, 'test', '-f', '/run/probe/ready'], {
        stdio: 'ignore',
        windowsHide: true,
      }).status === 0
    )
      break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const port = docker(['port', fixture, '22/tcp']).split(':').at(-1);
  let password = docker(['exec', fixture, 'cat', '/run/probe/password']);
  const fingerprint = docker(['exec', fixture, 'ssh-keygen', '-lf', '/run/probe/host.pub']).split(
    /\s+/,
  )[1];
  await writeFile(path.join(directory, 'assistant-commands.json'), JSON.stringify(commands));
  docker([
    'cp',
    path.join(directory, 'assistant-commands.json'),
    `${fixture}:/tmp/assistant-commands.json`,
  ]);
  docker(['cp', 'tests/assistant-linux.py', `${fixture}:/tmp/assistant-linux.py`]);
  docker(['exec', fixture, 'ln', '-s', '/usr/bin/vim.tiny', '/usr/local/bin/vim']);
  docker(['exec', fixture, 'bash', '-c', 'seq 1 200 > /tmp/guide-pages']);
  // An alias made before the shell starts must keep working; only its name loses the guide.
  docker(['exec', fixture, 'sh', '-c', "echo 'alias vi=vim.tiny' >> /home/probe/.bashrc"]);
  docker(['exec', fixture, 'python3', '/tmp/assistant-linux.py']);
  result.checks.push('Linux real commands and filters including live buffering, rotation, SIGINT');
  stage = 'launch';
  await launch();
  await page.locator('.local-targets').getByTitle('Windows PowerShell 새 터미널 열기').click();
  const local = page.getByRole('region', { name: 'Windows PowerShell 터미널', exact: true });
  // The prompt depends on the user's PowerShell profile, so wait for any first output.
  await expect(text(local)).toContainText(/\S/, { timeout: 15000 });
  const localId = await local.getAttribute('data-connection-id');
  stage = 'local-snippet';
  let dialog = await openCommands();
  await saveSnippet(dialog, '검증 스니펫', "Write-Output ('LOCAL_{{value}}')");
  await dialog.getByLabel('value', { exact: true }).fill('한글');
  await dialog.getByRole('button', { name: '입력만 넣기', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('1개 터미널에 넣었습니다');
  await dialog.getByRole('button', { name: '대화상자 닫기' }).click();
  // The echoed command contains parentheses; output alone is a separate accessibility row.
  expect(await text(local).innerText()).not.toMatch(/(?:^|\n)LOCAL_한글(?:\n|$)/);
  await local.locator('.xterm-helper-textarea').press('Enter');
  await expect(text(local)).toContainText('LOCAL_한글');
  result.checks.push('Native snippet CRUD, literal variable, PowerShell input-only then Enter');
  stage = 'ssh-auth';
  await openNewConnectionForm(page);
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('이름', { exact: true }).fill('스니펫 SSH');
  await dialog.getByLabel('호스트', { exact: true }).fill('127.0.0.1');
  await dialog.getByLabel('포트', { exact: true }).fill(port);
  await dialog.getByLabel('사용자', { exact: true }).fill('probe');
  await dialog.getByLabel('비밀번호', { exact: true }).fill(password);
  password = '';
  await dialog.getByRole('button', { name: '저장 후 연결', exact: true }).click();
  await expect(page.locator('.trust-card code')).toHaveText(fingerprint);
  await page.getByRole('button', { name: '지문 확인 · 신뢰하고 연결', exact: true }).click();
  const ssh = page.getByRole('region', { name: '스니펫 SSH 터미널', exact: true });
  await expect(ssh.locator('.connection-message')).toContainText('연결됨');
  const sshId = await ssh.getAttribute('data-connection-id');
  await enter(ssh, 'stty -echo');
  stage = 'broadcast-isolation';
  await invoke('broadcast_set', { ids: [localId, sshId] });
  dialog = await openCommands();
  await saveSnippet(
    dialog,
    'SSH 한 번',
    "printf 'SSH_ONLY_%s\\n' '한글'; printf x >> /tmp/snippet-once",
  );
  // Only the focused terminal is chosen, whatever broadcast group it is in.
  const targets = dialog.getByRole('region', { name: '보낼 터미널' });
  await expect(targets.getByRole('checkbox', { name: /스니펫 SSH/ })).toBeChecked();
  await expect(targets.getByRole('checkbox', { name: /Windows PowerShell/ })).not.toBeChecked();
  await dialog.getByRole('button', { name: '실행', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('1개 터미널에 실행했습니다');
  await dialog.getByRole('button', { name: '대화상자 닫기' }).click();
  await expect(text(ssh)).toContainText('SSH_ONLY_한글');
  expect(docker(['exec', fixture, 'cat', '/tmp/snippet-once'])).toBe('x');
  await page.getByRole('tab', { name: /Windows PowerShell/ }).click();
  expect(await text(local).innerText()).not.toContain('SSH_ONLY');
  await page.getByRole('tab', { name: /스니펫 SSH/ }).click();
  const delivered = await invoke('snippet_send', {
    targets: [
      { id: sshId, bracketed: true },
      { id: localId, bracketed: false },
    ],
    body: 'echo GROUP_ONCE',
    execute: true,
  });
  expect(delivered.every((r) => !r.error)).toBe(true);
  await expect(text(ssh)).toContainText('GROUP_ONCE');
  await page.getByRole('tab', { name: /Windows PowerShell/ }).click();
  await expect(text(local)).toContainText('GROUP_ONCE');
  await page.getByRole('tab', { name: /스니펫 SSH/ }).click();
  const partial = await invoke('snippet_send', {
    targets: [
      { id: 'closed-fixture', bracketed: false },
      { id: sshId, bracketed: true },
    ],
    body: 'echo PARTIAL_OK',
    execute: true,
  });
  expect(partial[0].error).toBeTruthy();
  expect(partial[1].error).toBeNull();
  await expect(text(ssh)).toContainText('PARTIAL_OK');
  await invoke('broadcast_set', { ids: [] });
  await invoke('snippet_send', {
    targets: [{ id: sshId, bracketed: true }],
    body: "printf 'MULTI_A\\n'\nprintf 'MULTI_B_한글\\n'",
    execute: true,
  });
  await expect(text(ssh)).toContainText('MULTI_B_한글');
  result.checks.push(
    'Real SSH UTF-8, exactly once with broadcast on, selected SSH/local, per-target failure isolation',
  );
  stage = 'guide';
  // The hook went in by itself when the shell started: no opt-in and no copied code.
  const guide = page.locator('footer .program-guide');
  const shown = guide.locator('.guide-inline strong');
  const fullGuide = page.getByRole('region', { name: '조작표 전체 보기' });
  const general = '전체 화면 프로그램 실행 중';
  async function run(pane, command, expected, exit, process) {
    await enter(pane, command);
    await expect(shown).toHaveText(expected);
    expect(docker(['exec', fixture, 'pgrep', '-u', 'probe', '-x', process])).toMatch(/\d+/);
    const input = pane.locator('.xterm-helper-textarea');
    await input.focus();
    if (exit === null) await input.press('Control+c');
    else if (exit === 'q') await input.press('q');
    else {
      await input.press('Escape');
      await input.type(exit);
      await input.press('Enter');
    }
    await expect(shown).toHaveCount(0);
  }
  // `vi` is an alias in this account, so only that name is left to the general notice.
  await run(ssh, 'vi /tmp/guide-file', general, ':q!', 'vim.tiny');
  await run(ssh, 'vim /tmp/guide-file', 'vim', ':q!', 'vim');
  await run(ssh, 'less /tmp/guide-pages', 'less', 'q', 'less');
  await run(ssh, 'tail -f /etc/hostname', 'tail', null, 'tail');
  await run(ssh, 'command vim /tmp/guide-file', general, ':q!', 'vim');
  // `cat` ends at once and stays a manual pick.
  await enter(ssh, 'cat');
  expect(docker(['exec', fixture, 'pgrep', '-u', 'probe', '-x', 'cat'])).toMatch(/\d+/);
  await expect(guide.locator('.guide-inline')).toHaveCount(0);
  await ssh.locator('.xterm-helper-textarea').press('Control+c');
  // The same hook still reports the folder.
  await enter(ssh, 'cd /tmp');
  await showSidebarView(page, '파일');
  await expect(page.getByLabel('원격 경로')).toHaveValue('/tmp');
  await chooseTabMenu(page, '조작표 보기·고정', ssh);
  await fullGuide.getByLabel('조작표 선택·고정').selectOption('vim');
  await fullGuide.getByRole('button', { name: '조작표 닫기' }).click();
  await enter(ssh, 'cat /etc/hostname');
  await expect(shown).toHaveText('vim');
  await page.getByRole('tab', { name: /Windows PowerShell/ }).click();
  await expect(local).toBeVisible();
  await expect(shown).toHaveCount(0);
  await page.getByRole('tab', { name: /스니펫 SSH/ }).click();
  await expect(shown).toHaveText('vim');
  result.checks.push(
    'Real Bash guide without opt-in: vim/less/tail entry/exit including Ctrl+C, alias vi and command vim fall back to the general notice, cat manual only, folder follow kept, pin and tab isolation',
  );
  stage = 'guide-zsh';
  docker([
    'exec',
    fixture,
    'sh',
    '-c',
    'touch /home/probe/.zshrc && chown probe:probe /home/probe/.zshrc && chsh -s /usr/bin/zsh probe',
  ]);
  await openNewConnectionForm(page);
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('이름', { exact: true }).fill('Zsh SSH');
  await dialog.getByLabel('호스트', { exact: true }).fill('127.0.0.1');
  await dialog.getByLabel('포트', { exact: true }).fill(port);
  await dialog.getByLabel('사용자', { exact: true }).fill('probe');
  let zshPassword = docker(['exec', fixture, 'cat', '/run/probe/password']);
  await dialog.getByLabel('비밀번호', { exact: true }).fill(zshPassword);
  zshPassword = '';
  await dialog.getByRole('button', { name: '저장 후 연결', exact: true }).click();
  const zsh = page.getByRole('region', { name: 'Zsh SSH 터미널', exact: true });
  await expect(zsh.locator('.connection-message')).toContainText('연결됨');
  await enter(zsh, 'echo "ZSH_$ZSH_VERSION"');
  await expect(text(zsh)).toContainText(/ZSH_5\.\d/);
  // The hook goes in once the new shell has been quiet for a moment; the folder report shows it
  // is there, so the programs below do not race it.
  await enter(zsh, 'cd /var');
  await expect(page.getByLabel('원격 경로')).toHaveValue('/var', { timeout: 15000 });
  await run(zsh, 'vim /tmp/guide-file', 'vim', ':q!', 'vim');
  await run(zsh, 'less /tmp/guide-pages', 'less', 'q', 'less');
  await run(zsh, 'tail -f /etc/hostname', 'tail', null, 'tail');
  await run(zsh, 'command vim /tmp/guide-file', general, ':q!', 'vim');
  await chooseTabMenu(page, '탭 닫기', zsh);
  result.checks.push(
    'Real Zsh guide without opt-in: vim/less/tail entry/exit, command vim general notice, folder follow kept',
  );
  stage = 'input-scope';
  // Real SSH and a local shell side by side: everything typed or pasted reaches both.
  await arrangeTabs(page, '좌우');
  await expect(ssh).toBeVisible();
  await expect(local).toBeVisible();
  await inputScope(page, '전체').check();
  await expect.poll(async () => (await invoke('broadcast_status')).selected.length).toBe(2);
  await ssh.locator('.xterm-helper-textarea').evaluate((e) => {
    const d = new DataTransfer();
    d.setData(
      'text/plain',
      'echo SCOPE_ALL_A' + String.fromCharCode(13) + 'echo SCOPE_ALL_B' + String.fromCharCode(13),
    );
    e.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }),
    );
  });
  await expect(ssh.locator('.paste-reach')).toContainText('동시 입력 중 · 2개 창');
  await ssh.getByRole('button', { name: '붙여넣기 실행', exact: true }).click();
  // Bash takes a bracketed paste into the line and waits for Enter; PowerShell runs it at once.
  await ssh.locator('.xterm-helper-textarea').press('Enter');
  await expect(text(ssh)).toContainText('SCOPE_ALL_B');
  await expect(text(local)).toContainText('SCOPE_ALL_B');
  await page.getByRole('button', { name: '동시 입력 중지', exact: true }).click();
  await expect.poll(async () => (await invoke('broadcast_status')).selected.length).toBe(0);
  await enter(ssh, 'echo SCOPE_OFF_ONLY');
  await expect(text(ssh)).toContainText('SCOPE_OFF_ONLY');
  expect(await text(local).innerText()).not.toContain('SCOPE_OFF_ONLY');
  await arrangeTabs(page, '하나로');
  result.checks.push(
    'Real SSH and PowerShell input scope: all, multi-line paste names two panes and reaches both, stop isolates again',
  );
  stage = 'wsl';
  await showSidebarView(page, '연결');
  // The first user distribution, whatever its name on this PC.
  const distribution = page
    .locator('.local-targets .local-target')
    .filter({ hasText: 'WSL' })
    .filter({ hasNotText: 'docker-desktop' })
    .first();
  const distributionName = await distribution.locator('span').textContent();
  await distribution.click();
  const wsl = page.getByRole('region', { name: `${distributionName} 터미널`, exact: true });
  const wslId = await wsl.getAttribute('data-connection-id');
  await expect(wsl.locator('.connection-message')).toContainText('로컬');
  await invoke('snippet_send', {
    targets: [{ id: wslId, bracketed: true }],
    body: "printf 'WSL_한글\\n'",
    execute: true,
  });
  await expect(text(wsl)).toContainText('WSL_한글');
  // WSL takes only the folder hook at launch, so a pager gets the general notice.
  await enter(wsl, 'less /etc/os-release');
  await expect(shown).toHaveText(general);
  await wsl.locator('.xterm-helper-textarea').press('q');
  await expect(shown).toHaveCount(0);
  result.checks.push(
    'Actual local WSL snippet UTF-8 and the general notice for less without the hook',
  );
  stage = 'detached';
  await page.getByRole('tab', { name: /스니펫 SSH/ }).click();
  await chooseTabMenu(page, '새 창으로 분리');
  let detached;
  await expect
    .poll(() => {
      detached = browser
        .contexts()
        .flatMap((c) => c.pages())
        .find((p) => p !== page && p.url().includes('detached='));
      return !!detached;
    })
    .toBe(true);
  // The detached window keeps its tools in the title bar menu.
  await detached.locator('.toolbar-menu > summary').filter({ hasText: '메뉴' }).click();
  await detached.getByRole('button', { name: '명령', exact: true }).click();
  const detachedDialog = detached.getByRole('dialog', { name: '명령', exact: true });
  await saveSnippet(detachedDialog, '분리 창 확인', 'echo DETACHED_ONCE');
  await detachedDialog.getByRole('button', { name: '실행', exact: true }).click();
  await expect(detachedDialog.getByRole('status')).toContainText('1개 터미널에 실행했습니다');
  await detachedDialog.getByRole('button', { name: '대화상자 닫기' }).click();
  await expect(detached.locator('.xterm-accessibility-tree')).toContainText('DETACHED_ONCE');
  const denied = await invoke('snippet_send', {
    targets: [{ id: sshId, bracketed: true }],
    body: 'echo OWNER_DENIED',
    execute: true,
  });
  expect(denied[0].error).toBeTruthy();
  await detached
    .evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close'))
    .catch(() => {});
  result.checks.push(
    'Detached window snippet UI, exactly scoped delivery and main-window ownership rejection',
  );
  stage = 'theme';
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 560,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.evaluate(() => {
    localStorage.setItem('dachsterm.theme', 'github-dark');
    window.dispatchEvent(new StorageEvent('storage', { key: 'dachsterm.theme' }));
  });
  dialog = await openCommands();
  await dialog.getByRole('tab', { name: '기본 명령' }).click();
  await mkdir('target/verification', { recursive: true });
  await page.screenshot({ path: 'target/verification/assistant-native-dark.png' });
  await page.getByRole('button', { name: '대화상자 닫기' }).click();
  stage = 'restart';
  await invoke('plugin:window|close', { label: 'main' }).catch(() => {});
  await expect.poll(() => app.exitCode).toBe(0);
  await browser.close();
  await launch();
  dialog = await openCommands();
  await dialog.getByRole('tab', { name: '내 스니펫' }).click();
  await dialog
    .locator('#command-list')
    .getByRole('button', { name: /검증 스니펫/ })
    .click();
  await expect(dialog.getByTestId('snippet-preview')).toHaveText("Write-Output ('LOCAL_value')");
  await expect(dialog.getByLabel('value', { exact: true })).toHaveValue('');
  result.checks.push(
    'Actual app restart restores SQLite snippets without transient values or automatic execution',
  );
  await dialog.getByRole('button', { name: '대화상자 닫기' }).click();
  await invoke('plugin:window|close', { label: 'main' }).catch(() => {});
  await expect.poll(() => app.exitCode).toBe(0);
  expect(result.pageErrors).toBe(0);
  result.sha256 = createHash('sha256')
    .update(await readFile(binary))
    .digest('hex');
  await writeFile('target/verification/assistant-native.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`Assistant verification failed at ${stage}`);
  if (stage !== 'ssh-auth' && stage !== 'fixture') {
    console.error(String(error));
    await page
      ?.screenshot({ path: 'target/verification/assistant-native-failure.png' })
      .catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (app?.pid && app.exitCode === null)
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  if (created) docker(['rm', '-f', fixture]);
}
