// Local PTY integration in Windows WebView2. Isolated app data; no remote credentials.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import https from 'node:https';
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
import {
  appWindow,
  arrange,
  closeFolder,
  dragBetween,
  folderWindow,
  openFolder,
  releaseWindow,
  screenPoint,
  selectedInFolder,
} from './native-mouse.mjs';

if (process.platform !== 'win32') throw new Error('Windows WebView2 is required.');
// `--agent-only` runs only the DX.13 local agent steps after the first PowerShell tab,
// `--credentials-only` only the DX.14 WSL HTTPS credential steps, and `--git-only` only the
// DX.15 Git status steps, `--drop-only` only the GE.2 file drop steps, `--drag-only` only the GE.3
// drag out to the file manager, which moves the real pointer for a few seconds.
const agentOnly = process.argv.includes('--agent-only');
const dropOnly = process.argv.includes('--drop-only');
const dragOnly = process.argv.includes('--drag-only');
const credentialsOnly = process.argv.includes('--credentials-only');
const gitOnly = process.argv.includes('--git-only');
const finished = Symbol('agent-only');
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-local-'));
// The app's own git (DX.14 "this PC's credentials") reads only this file: no system or user
// settings, and a `store` helper the checks fill and empty. The real credential manager is never
// asked. Programs in the tabs inherit it; WSL's Linux git does not.
const gitStore = path.join(directory, 'git-store');
await writeFile(gitStore, '');
await writeFile(
  path.join(directory, 'gitconfig'),
  `[credential]\n\thelper = "store --file '${gitStore.replaceAll('\\', '/')}'"\n`,
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app, browser;
async function launch() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  app = spawn(path.resolve('target/debug/dachsterm.exe'), [], {
    stdio: 'ignore',
    // The real pointer can only reach a window that is on screen.
    windowsHide: !dragOnly,
    env: {
      ...process.env,
      DACHSTERM_TEST_DATA_DIR: directory,
      DACHSTERM_TEST_CDP_PORT: String(port),
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(directory, 'gitconfig'),
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
// DX.13: the app's agent in local tabs, against the OpenSSH fixture used by run-phase1 as an SSH
// Git server. The key is made here and deleted with the scratch folder. This PC's ssh-agent
// service, git configuration and ~/.ssh files are left as they are: Windows ssh.exe gets an empty
// config and a scratch known_hosts on the command line, except for one push that only shows the
// first-host question and is answered "no".
const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const openssh = (name) => path.join(system32, 'OpenSSH', name);
const gitServer = `dachsterm-local-agent-${randomUUID()}`;
let gitServerUp = false;
function docker(args, input) {
  const result = spawnSync('docker', args, { encoding: 'utf8', input, timeout: 300_000 });
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
async function startGitServer(publicKey) {
  docker(['build', '-q', '-t', 'dachsterm-openssh-probe', 'tests/openssh']);
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    gitServer,
    '--label',
    'app.dachsterm.purpose=local-agent-native',
    '-p',
    '127.0.0.1::22',
    '--tmpfs',
    '/run/probe:rw,noexec,nosuid,mode=0700',
    'dachsterm-openssh-probe',
  ]);
  gitServerUp = true;
  for (let i = 0; i < 60; i++) {
    if (spawnSync('docker', ['exec', gitServer, 'test', '-f', '/run/probe/ready']).status === 0) {
      docker(
        ['exec', '-i', gitServer, 'sh', '-c', 'cat >> /home/probe/.ssh/authorized_keys'],
        publicKey,
      );
      docker([
        'exec',
        '-u',
        'probe',
        gitServer,
        'git',
        'init',
        '-q',
        '--bare',
        '/home/probe/local.git',
      ]);
      return Number(docker(['port', gitServer, '22/tcp']).split(':').at(-1));
    }
    await sleep(500);
  }
  throw new Error('OpenSSH fixture startup timeout');
}
const remoteRefs = () =>
  docker([
    'exec',
    '-u',
    'probe',
    gitServer,
    'git',
    '--git-dir',
    '/home/probe/local.git',
    'show-ref',
  ]);
/** Whether the named pipe still accepts a connection. */
const pipeOpen = (name) =>
  new Promise((resolve) => {
    const socket = net.connect(name);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

/** DX.15: a local or WSL tab in a repository folder shows its branch, changes and file marks. */
async function checkLocalGit(page, command, pane) {
  const repo = path.join(await realpath(directory), 'git repo');
  await mkdir(path.join(repo, 'src'), { recursive: true });
  const init = spawnSync('git', ['-C', repo, 'init', '-q', '-b', 'dx15'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  await writeFile(path.join(repo, 'src', 'new.txt'), 'x');
  const status = page.locator('.status-bar .status-git');
  const inner = path.join(repo, 'src');
  await command(pane, `Set-Location '${inner}'; Write-Output ('GIT' + '_IN')`, 'GIT_IN');
  await expect(status).toHaveText('dx15 ●1', { timeout: 15000 });
  await showSidebarView(page, '파일');
  const files = page.getByRole('complementary', { name: '로컬 파일 탐색' });
  await expect(files.getByLabel('로컬 경로', { exact: true })).toHaveValue(inner);
  // Git reports a new folder as one untracked entry, so the mark is on the folder's row.
  await command(pane, `Set-Location ..; Write-Output ('GIT' + '_ROOT')`, 'GIT_ROOT');
  await expect(files.getByLabel('로컬 경로', { exact: true })).toHaveValue(repo);
  await expect(
    files.getByRole('button', { name: /^src/ }).locator('.file-git-mark'),
  ).toHaveAttribute('data-mark', '?', { timeout: 15000 });
  // GE.7: the Git view lists the same repository, this time file by file.
  const gitRows = () =>
    page
      .locator('#git-sidebar')
      .getByRole('region', { name: '추적 안 함', exact: true })
      .locator('.git-row-name');
  await showSidebarView(page, 'Git');
  await expect(gitRows()).toHaveText(['new.txt'], { timeout: 15000 });
  console.log('PASS PowerShell tab: the Git view lists the untracked file');
  // GE.14: the commit graph, before and after there is a history, and a commit's detail.
  const graph = page.locator('#git-sidebar .git-graph');
  await expect(graph).toContainText('아직 커밋이 없습니다.', { timeout: 15000 });
  for (const subject of ['첫 커밋', '둘째 커밋']) {
    const made = spawnSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=probe',
        '-c',
        'user.email=probe@example.invalid',
        'commit',
        '-q',
        '--allow-empty',
        '--no-gpg-sign',
        '-m',
        subject,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(made.status, 0, made.stderr);
  }
  await page.locator('#git-sidebar').getByRole('button', { name: 'Git 새로 고침' }).click();
  await expect(graph.locator('.git-graph-subject')).toHaveText(['둘째 커밋', '첫 커밋'], {
    timeout: 15000,
  });
  await expect(graph.locator('.git-graph-ref')).toHaveText(['dx15']);
  await graph.locator('.git-graph-row').first().click();
  await expect(graph.locator('.git-graph-hash').first()).toHaveText(/^[0-9a-f]{40}$/, {
    timeout: 15000,
  });
  await graph.locator('.git-graph-row').first().click();
  console.log('PASS PowerShell tab: the commit graph and a commit detail from the real history');
  await showSidebarView(page, '연결');
  await command(pane, `Set-Location '${directory}'; Write-Output ('GIT' + '_OUT')`, 'GIT_OUT');
  await expect(status).toHaveCount(0, { timeout: 15000 });
  console.log('PASS PowerShell tab: Git branch, change count and file mark; none outside');
  const wsl = page
    .locator('.local-targets .local-target')
    .filter({ hasText: 'WSL' })
    .filter({ hasNotText: 'docker-desktop' });
  if (!(await wsl.count())) {
    console.log('WSL user distribution absent: WSL Git status pending.');
    return;
  }
  const title = await wsl.first().locator('span').textContent();
  await wsl.first().click();
  const linux = page.getByRole('region', { name: `${title} 터미널`, exact: true });
  await expect(linux.locator('.xterm-accessibility-tree')).toContainText(/[$#]/, {
    timeout: 15000,
  });
  await command(
    linux,
    `cd "$(mktemp -d)" && git init -q -b dx15-wsl && touch a b && ` +
      `git -c user.name=p -c user.email=p@example.invalid commit -q --allow-empty --no-gpg-sign -m wsl-one && ` +
      `git -c user.name=p -c user.email=p@example.invalid commit -q --allow-empty --no-gpg-sign -m wsl-two && ` +
      `printf 'GIT%s\\n' _WSL`,
    'GIT_WSL',
  );
  await expect(status).toHaveText('dx15-wsl ●2', { timeout: 15000 });
  await showSidebarView(page, 'Git');
  await expect(gitRows()).toHaveText(['a', 'b'], { timeout: 15000 });
  console.log('PASS WSL tab: the Git view lists the files through the distribution');
  await expect(page.locator('#git-sidebar .git-graph-subject')).toHaveText(['wsl-two', 'wsl-one'], {
    timeout: 15000,
  });
  console.log('PASS WSL tab: the commit graph reads through the distribution');
  await showSidebarView(page, '연결');
  // GE.11: ConPTY repaints the screen, so the badge must still land on the line being typed on.
  const badge = linux.locator('.prompt-branch');
  await expect(badge).toHaveText('⎇ dx15-wsl ●2', { timeout: 15000 });
  await command(linux, "git checkout -q -b ge11-wsl; printf 'GIT%s\\n' _CHECKOUT", 'GIT_CHECKOUT');
  await expect(badge).toContainText('⎇ ge11-wsl', { timeout: 3000 });
  const [mark, cursor] = await Promise.all([
    badge.boundingBox(),
    linux.locator('.xterm-rows .xterm-cursor').first().boundingBox(),
  ]);
  assert(mark && cursor && Math.abs(mark.y - cursor.y) < 3, 'WSL badge is on the cursor line');
  console.log('PASS WSL tab: prompt branch badge on the cursor line, first prompt after checkout');
  await command(linux, "cd / && printf 'GIT%s\\n' _ROOT", 'GIT_ROOT');
  await expect(status).toHaveCount(0, { timeout: 15000 });
  console.log("PASS WSL tab: the distribution's git status; none outside");
  await command(linux, 'exit', '');
}

/** GE.2: files dropped from the OS are copied into the folder the local or WSL panel shows. */
// GE.3: real drags to a real file manager window. The folders are scratch folders.
async function checkDragOut(page, command, pane) {
  const files = page.getByRole('complementary', { name: '로컬 파일 탐색' });
  const scale = await page.evaluate(() => window.devicePixelRatio);
  const base = await realpath(directory);
  const from = path.join(base, 'drag from');
  const into = path.join(base, 'drag into');
  await mkdir(path.join(from, '폴더째'), { recursive: true });
  await mkdir(into, { recursive: true });
  await writeFile(path.join(from, '끌어내기 한글.txt'), 'one');
  await writeFile(path.join(from, 'second.txt'), 'two');
  await writeFile(path.join(from, '폴더째', 'inside.txt'), 'three');
  const appHandle = await appWindow(app.pid);
  const manager = await openFolder(into);
  arrange(appHandle, manager);
  await sleep(800);
  const row = (name) => files.getByRole('button', { name: new RegExp(name) });
  const centre = async (locator) => {
    const box = await locator.boundingBox();
    return screenPoint(appHandle, box.x + box.width / 2, box.y + box.height / 2, scale);
  };
  const managerTop = screenPoint(manager, 0, 0, 1);
  const dropAt = { x: managerTop.x + 500, y: managerTop.y + 500 };
  const dragToManager = async (name) =>
    dragBetween(appHandle, await centre(row(name)), manager, dropAt);
  const waitFor = async (file, text) => {
    for (let i = 0; i < 40; i++) {
      if ((await readFile(file, 'utf8').catch(() => null)) === text) return;
      await sleep(250);
    }
    throw new Error(`Not copied by the drag: ${file}`);
  };
  const reveal = async (name) => {
    await row(name).click({ button: 'right' });
    await page.getByRole('menuitem', { name: '탐색기에서 보기' }).click();
  };
  try {
    await showSidebarView(page, '파일');
    await command(pane, `Set-Location '${from}'; Write-Output ('DRAG' + '_HERE')`, 'DRAG_HERE');
    await expect(files.getByLabel('로컬 경로', { exact: true })).toHaveValue(from);
    await expect(row('second\\.txt')).toBeVisible({ timeout: 15000 });

    await dragToManager('끌어내기 한글\\.txt');
    await waitFor(path.join(into, '끌어내기 한글.txt'), 'one');
    assert.equal(await readFile(path.join(from, '끌어내기 한글.txt'), 'utf8'), 'one');
    console.log('PASS file manager: a dragged file is copied and the original stays');

    // The page must not be left thinking the button is still down.
    await row('second\\.txt').click();
    await expect(row('second\\.txt')).toHaveAttribute('aria-pressed', 'true');
    await row('폴더째').click({ modifiers: ['Control'] });
    await dragToManager('second\\.txt');
    await waitFor(path.join(into, 'second.txt'), 'two');
    await waitFor(path.join(into, '폴더째', 'inside.txt'), 'three');
    console.log('PASS file manager: the selection, a folder included, is dragged together');

    const before = await files.locator('.file-row').count();
    const list = await files.locator('.file-list').boundingBox();
    const inside = screenPoint(appHandle, list.x + list.width / 2, list.y + list.height - 8, scale);
    dragBetween(appHandle, await centre(row('second\\.txt')), appHandle, inside);
    await sleep(1500);
    await files.getByRole('button', { name: '파일 새로 고침' }).click();
    await sleep(500);
    await expect(files.locator('.file-row')).toHaveCount(before);
    console.log('PASS app: letting go over its own panel copies nothing');

    await reveal('second\\.txt');
    await folderWindow(from);
    for (let i = 0; selectedInFolder(from)[0] !== path.join(from, 'second.txt'); i++) {
      assert.ok(i < 40, 'The revealed file is not selected.');
      await sleep(250);
    }
    closeFolder(from);
    console.log('PASS file manager: "show" selects the item');

    const wsl = page
      .locator('.local-targets .local-target')
      .filter({ hasText: 'WSL' })
      .filter({ hasNotText: 'docker-desktop' });
    await showSidebarView(page, '연결');
    if (!(await wsl.count())) {
      console.log('WSL user distribution absent: WSL drag pending.');
      return;
    }
    const title = await wsl.first().locator('span').textContent();
    await wsl.first().click();
    const linux = page.getByRole('region', { name: `${title} 터미널`, exact: true });
    await expect(linux.locator('.xterm-accessibility-tree')).toContainText(/[$#]/, {
      timeout: 15000,
    });
    await command(
      linux,
      `cd "$(mktemp -d)" && printf wsl > 'from wsl.txt' && printf 'WSL%s\\n' _DRAG`,
      'WSL_DRAG',
    );
    await showSidebarView(page, '파일');
    const shown = files.getByLabel('로컬 경로', { exact: true });
    await expect(shown).toHaveValue(/^\/tmp\//);
    await expect(row('from wsl\\.txt')).toBeVisible({ timeout: 15000 });
    await dragToManager('from wsl\\.txt');
    await waitFor(path.join(into, 'from wsl.txt'), 'wsl');
    console.log('PASS file manager: a WSL file is copied through its network path');

    await reveal('from wsl\\.txt');
    const names = spawnSync('wsl.exe', ['--list', '--quiet'], { windowsHide: true })
      .stdout.toString('utf16le')
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter(Boolean);
    const distribution = names.find((name) => title.includes(name));
    assert.ok(distribution, `No WSL distribution in "${title}".`);
    const folder = `\\\\wsl.localhost\\${distribution}${(await shown.inputValue()).replaceAll('/', '\\')}`;
    await folderWindow(folder);
    closeFolder(folder);
    console.log('PASS file manager: "show" opens the WSL folder');
  } finally {
    releaseWindow(appHandle);
    releaseWindow(manager);
    closeFolder(into);
  }
}
async function checkLocalDrop(page, command, pane) {
  const invoke = (cmd, args) =>
    page.evaluate(({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args });
  const files = page.getByRole('complementary', { name: '로컬 파일 탐색' });
  const emit = async (event, payload) => {
    const box = await files.boundingBox();
    const scale = await page.evaluate(() => window.devicePixelRatio);
    const position = { x: (box.x + box.width / 2) * scale, y: (box.y + box.height / 2) * scale };
    await invoke('plugin:event|emit', { event, payload: { ...payload, position } });
  };
  const source = path.join(await realpath(directory), 'drop source');
  await mkdir(source, { recursive: true });
  const dropped = path.join(source, '끌어 놓기.txt');
  await writeFile(dropped, 'dropped');
  const into = path.join(await realpath(directory), 'drop into');
  await mkdir(into, { recursive: true });
  await showSidebarView(page, '파일');
  await command(pane, `Set-Location '${into}'; Write-Output ('DROP' + '_HERE')`, 'DROP_HERE');
  await expect(files.getByLabel('로컬 경로', { exact: true })).toHaveValue(into);
  await emit('tauri://drag-over', {});
  await expect(files).toHaveClass(/drop-over/);
  await emit('tauri://drag-drop', { paths: [dropped] });
  await expect(files).not.toHaveClass(/drop-over/);
  await expect(files.getByRole('button', { name: /끌어 놓기\.txt/ })).toBeVisible({
    timeout: 15000,
  });
  assert.equal(await readFile(path.join(into, '끌어 놓기.txt'), 'utf8'), 'dropped');
  assert.equal(await readFile(dropped, 'utf8'), 'dropped');
  console.log('PASS PowerShell panel: a dropped Windows file is copied into its folder');
  const wsl = page
    .locator('.local-targets .local-target')
    .filter({ hasText: 'WSL' })
    .filter({ hasNotText: 'docker-desktop' });
  if (!(await wsl.count())) {
    console.log('WSL user distribution absent: WSL drop pending.');
    return;
  }
  await showSidebarView(page, '연결');
  const title = await wsl.first().locator('span').textContent();
  await wsl.first().click();
  const linux = page.getByRole('region', { name: `${title} 터미널`, exact: true });
  await expect(linux.locator('.xterm-accessibility-tree')).toContainText(/[$#]/, {
    timeout: 15000,
  });
  await command(linux, `cd "$(mktemp -d)" && printf 'DROP%s\\n' _WSL`, 'DROP_WSL');
  await showSidebarView(page, '파일');
  await expect(files.getByLabel('로컬 경로', { exact: true })).toHaveValue(/^\/tmp\//);
  await emit('tauri://drag-drop', { paths: [dropped] });
  await expect(files.getByRole('button', { name: /끌어 놓기\.txt/ })).toBeVisible({
    timeout: 15000,
  });
  await command(linux, "cat '끌어 놓기.txt'; printf '%s\\n' _CAT", 'dropped_CAT');
  console.log('PASS WSL panel: a dropped Windows file is copied into the Linux folder');
  await command(linux, 'exit', '');
}

async function checkLocalAgent(page, command, oldShell) {
  const service = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', '(Get-Service ssh-agent).Status'],
    { encoding: 'utf8', windowsHide: true },
  ).stdout.trim();
  console.log(`This PC's ssh-agent service: ${service}`);
  if (spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0) {
    console.log('Docker unavailable: local agent push checks pending.');
    return;
  }
  const keys = await realpath(await mkdtemp(path.join(directory, 'agent-')));
  const key = path.join(keys, 'id_local');
  const made = spawnSync(
    openssh('ssh-keygen.exe'),
    ['-q', '-t', 'ed25519', '-N', '', '-C', 'dachsterm-local-test', '-f', key],
    { windowsHide: true },
  );
  assert.equal(made.status, 0, 'test key');
  const fingerprint = spawnSync(openssh('ssh-keygen.exe'), ['-lf', `${key}.pub`], {
    encoding: 'utf8',
    windowsHide: true,
  }).stdout.split(' ')[1];
  const port = await startGitServer(await readFile(`${key}.pub`, 'utf8'));
  const config = path.join(keys, 'empty_config');
  const knownHosts = path.join(keys, 'known_hosts');
  await writeFile(config, '');
  const sshOptions = `-F '${config}' -o UserKnownHostsFile='${knownHosts}' -o StrictHostKeyChecking=accept-new -o IdentityFile=NONE -o BatchMode=yes`;
  const remote = `ssh://probe@127.0.0.1:${port}/home/probe/local.git`;

  // Settings › Agents. The tab already open keeps what it started with.
  await page.getByRole('button', { name: '설정', exact: true }).click();
  const settings = page.getByRole('dialog', { name: '설정' });
  await settings.getByRole('tab', { name: '에이전트', exact: true }).click();
  const section = settings.getByRole('region', { name: '로컬 탭의 SSH 키' });
  await section.getByLabel('로컬 탭에 이 앱의 SSH 키 제공', { exact: true }).check();
  await expect(section.getByRole('status')).toContainText('저장했습니다');
  await section.getByLabel('추가할 키 파일 경로', { exact: true }).fill(key);
  await section.getByLabel('추가할 키 파일 경로', { exact: true }).press('Enter');
  await expect(section.getByRole('list', { name: '추가 키' })).toContainText(fingerprint);
  await expect(section.getByRole('status')).toContainText('저장했습니다');
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await page.getByRole('tab', { name: /Windows PowerShell/ }).click();
  await command(
    oldShell,
    "Write-Output ('OLD' + 'SOCK:[' + $env:SSH_AUTH_SOCK + ']')",
    /OLDSOCK:\[/,
  );
  expect(await oldShell.locator('.xterm-accessibility-tree').innerText()).not.toContain(
    'dachsterm-agent-',
  );
  console.log('PASS the setting applies to tabs opened afterwards');

  // A new PowerShell tab: the pipe, the system ssh.exe for Git, and the app's key.
  const visible = page.locator('.pane-cell:not([hidden]) .terminal-pane');
  await page.locator('.local-targets').getByTitle('Windows PowerShell 새 터미널 열기').click();
  await expect(visible).toHaveCount(1);
  const shellId = await visible.getAttribute('data-connection-id');
  const shell = page.locator(`.terminal-pane[data-connection-id="${shellId}"]`);
  await expect(shell.locator('.xterm-accessibility-tree')).toContainText(/\S/, { timeout: 15000 });
  await command(
    shell,
    "Write-Output ('SO' + 'CK:' + $env:SSH_AUTH_SOCK)",
    /SOCK:\\\\\.\\pipe\\dachsterm-agent-[0-9a-f]{32}/,
  );
  const pipe = (await shell.locator('.xterm-accessibility-tree').innerText()).match(
    /SOCK:(\\\\\.\\pipe\\dachsterm-agent-[0-9a-f]{32})/,
  )[1];
  await command(
    shell,
    "Write-Output ('GIT' + 'SSH:' + $env:GIT_SSH)",
    /GITSSH:.*OpenSSH\\ssh\.exe/i,
  );
  await command(shell, 'ssh-add -l', fingerprint);
  assert(await pipeOpen(pipe), 'the tab pipe accepts this user');
  console.log('PASS PowerShell tab: SSH_AUTH_SOCK, GIT_SSH and ssh-add -l with the app key');

  const repo = path.join(keys, 'repo');
  await mkdir(repo);
  await command(
    shell,
    `Set-Location '${repo}'; git init -q; git -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m one; Write-Output ('RE' + 'PO_OK')`,
    'REPO_OK',
  );
  // GIT_SSH alone: the first-host question shows in the tab and is answered "no", so nothing is
  // written to ~/.ssh/known_hosts and no key is asked for.
  await command(shell, `git push ${remote} HEAD:refs/heads/question`, '');
  await expect(shell.locator('.xterm-accessibility-tree')).toContainText('(yes/no', {
    timeout: 30000,
  });
  // Typed, not pasted: the question reads the console, not the shell's paste handling.
  await shell.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('no');
  await page.keyboard.press('Enter');
  await expect(shell.locator('.xterm-accessibility-tree')).toContainText(
    'Host key verification failed',
    { timeout: 15000 },
  );
  console.log('PASS GIT_SSH runs the system ssh.exe and its first-host question can be answered');

  const card = shell.getByRole('alertdialog', { name: '키 서명 요청', exact: true });
  const push = (branch) =>
    command(
      shell,
      `git -c core.sshCommand="'${openssh('ssh.exe')}' ${sshOptions}" push -q ${remote} HEAD:refs/heads/${branch}; Write-Output ('PUSH' + '_${branch}:' + $LASTEXITCODE)`,
      '',
    );
  await push('win');
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(card.getByRole('heading')).toHaveText(
    '이 탭의 프로그램이 앱의 키로 서명하려고 합니다',
  );
  await expect(card).toContainText('Windows PowerShell');
  await expect(card).toContainText('dachsterm-local-test');
  await expect(card).toContainText('이 앱의 키 파일');
  await expect(card).not.toBeFocused();
  await card.getByRole('button', { name: '이번만 허용', exact: true }).click();
  await expect(shell.locator('.xterm-accessibility-tree')).toContainText('PUSH_win:0', {
    timeout: 30000,
  });
  expect(remoteRefs()).toContain('refs/heads/win');
  await push('denied');
  await expect(card).toBeVisible({ timeout: 30000 });
  await card.getByRole('button', { name: '거부', exact: true }).click();
  await expect(shell.locator('.xterm-accessibility-tree')).toContainText(/PUSH_denied:[1-9]/, {
    timeout: 30000,
  });
  expect(remoteRefs()).not.toContain('refs/heads/denied');
  console.log('PASS Git for Windows push through the tab pipe: allowed works, refused fails');

  await chooseTabMenu(page, '탭 닫기', shell);
  await expect(shell).toHaveCount(0);
  await expect.poll(() => pipeOpen(pipe), { timeout: 10000 }).toBe(false);
  console.log('PASS closing the tab removes its pipe');

  const wsl = page
    .locator('.local-targets .local-target')
    .filter({ hasText: 'WSL' })
    .filter({ hasNotText: 'docker-desktop' });
  if (!(await wsl.count())) {
    console.log('WSL user distribution absent: WSL agent checks pending.');
    return;
  }
  const openLinux = async () => {
    await wsl.first().click();
    await expect(visible).toHaveCount(1);
    const id = await visible.getAttribute('data-connection-id');
    const linux = page.locator(`.terminal-pane[data-connection-id="${id}"]`);
    await expect(linux.locator('.xterm-accessibility-tree')).toContainText(/[$#]/, {
      timeout: 15000,
    });
    return linux;
  };
  const linux = await openLinux();
  // Linux keeps its own agent setting; Windows programs started from the tab get the pipe.
  await command(linux, `printf 'LINUX%s[%s]\\n' _SOCK "\${SSH_AUTH_SOCK-}"`, /LINUX_SOCK\[/);
  expect(await linux.locator('.xterm-accessibility-tree').innerText()).not.toMatch(
    /LINUX_SOCK\[\\\\/,
  );
  await command(
    linux,
    `printf 'GIT%s:%s\\n' SSH "$GIT_SSH"`,
    /GITSSH:\/mnt\/.*\/OpenSSH\/ssh\.exe/i,
  );
  await command(linux, "ssh-add.exe -l | sed 's/^/WSLKEY /'", `WSLKEY 256 ${fingerprint}`);
  await command(
    linux,
    `cd "$(mktemp -d)" && git init -q && git -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m wsl && git -c core.sshCommand="$GIT_SSH ${sshOptions}" push -q ${remote} HEAD:refs/heads/wsl; printf 'PUSH%s:%s\\n' _wsl $?`,
    '',
  );
  const linuxCard = linux.getByRole('alertdialog', { name: '키 서명 요청', exact: true });
  await expect(linuxCard).toBeVisible({ timeout: 30000 });
  await linuxCard.getByRole('button', { name: '이번만 허용', exact: true }).click();
  await expect(linux.locator('.xterm-accessibility-tree')).toContainText('PUSH_wsl:0', {
    timeout: 30000,
  });
  expect(remoteRefs()).toContain('refs/heads/wsl');
  console.log(
    'PASS WSL git push through Windows ssh.exe and the tab pipe, Linux SSH_AUTH_SOCK kept',
  );

  // Two WSL tabs at once: each one's Windows programs see that tab's pipe.
  const pipeOf = async (tab) => {
    await command(tab, "cmd.exe /c 'echo WINSOCK:%SSH_AUTH_SOCK%' | tr -d '\\r'", /WINSOCK:\\\\/);
    // A narrow pane wraps the name over two rows.
    const text = await tab.locator('.xterm-accessibility-tree').innerText();
    return text
      .replaceAll('\n', '')
      .match(/WINSOCK:(\\\\\.\\pipe\\dachsterm-agent-[0-9a-f]{32})/)?.[1];
  };
  const first = await pipeOf(linux);
  // The same distribution again on the right, so both tabs are open and visible at once.
  const linuxId = await linux.getAttribute('data-connection-id');
  await page.keyboard.press('Control+Shift+Backslash');
  const second = page.locator(
    `.pane-cell:not([hidden]) .terminal-pane:not([data-connection-id="${linuxId}"])`,
  );
  await expect(second.locator('.xterm-accessibility-tree')).toContainText(/[$#]/, {
    timeout: 15000,
  });
  const other = await pipeOf(second);
  assert(first && other && first !== other, `separate pipes: ${first} ${other}`);
  assert((await pipeOpen(first)) && (await pipeOpen(other)), 'both pipes open together');
  await chooseTabMenu(page, '탭 닫기', second);
  await expect.poll(() => pipeOpen(other), { timeout: 10000 }).toBe(false);
  assert(await pipeOpen(first), 'the other tab keeps its pipe');
  await chooseTabMenu(page, '탭 닫기', linux);
  await expect(linux).toHaveCount(0);
  await expect.poll(() => pipeOpen(first), { timeout: 10000 }).toBe(false);
  console.log('PASS two WSL tabs keep separate pipes, and both close with their tabs');
}

// DX.14: WSL tabs' HTTPS Git credentials, against the HTTPS Git fixture used by run-phase1
// (Gitea, Basic auth). Its password is made in the container and only typed or put in the
// scratch store; it is never printed. WSL reaches the published port on 127.0.0.1.
const httpsServer = `dachsterm-wsl-credential-${randomUUID()}`;
let httpsServerUp = false;
const httpsAnswers = (port) =>
  new Promise((resolve) => {
    const request = https.get(
      { host: '127.0.0.1', port, path: '/', rejectUnauthorized: false, timeout: 2000 },
      (response) => {
        response.resume();
        resolve(true);
      },
    );
    request.once('error', () => resolve(false));
    request.once('timeout', () => request.destroy());
  });
async function startHttpsServer() {
  docker(['build', '-q', '-t', 'dachsterm-git-https', 'tests/git-https']);
  docker([
    'run',
    '-d',
    '--rm',
    '--name',
    httpsServer,
    '--label',
    'app.dachsterm.purpose=wsl-credential-native',
    '-p',
    '127.0.0.1::3000',
    'dachsterm-git-https',
  ]);
  httpsServerUp = true;
  const port = Number(docker(['port', httpsServer, '3000/tcp']).split(':').at(-1));
  for (let i = 0; i < 120; i++) {
    const made =
      spawnSync('docker', ['exec', httpsServer, 'test', '-s', '/var/lib/gitea/probe/password'])
        .status === 0;
    if (made && (await httpsAnswers(port))) {
      return {
        port,
        password: docker(['exec', httpsServer, 'cat', '/var/lib/gitea/probe/password']),
      };
    }
    await sleep(500);
  }
  throw new Error('HTTPS Git fixture startup timeout');
}

async function checkWslCredentials(page, command) {
  const wsl = page
    .locator('.local-targets .local-target')
    .filter({ hasText: 'WSL' })
    .filter({ hasNotText: 'docker-desktop' });
  if (!(await wsl.count())) {
    console.log('WSL user distribution absent: WSL HTTPS credential checks pending.');
    return;
  }
  if (spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0) {
    console.log('Docker unavailable: WSL HTTPS credential checks pending.');
    return;
  }
  const { port, password } = await startHttpsServer();
  const repository = `https://127.0.0.1:${port}/probe/wsl-credential.git`;
  const visible = page.locator('.pane-cell:not([hidden]) .terminal-pane');
  const openLinux = async () => {
    await wsl.first().click();
    await expect(visible).toHaveCount(1);
    const id = await visible.getAttribute('data-connection-id');
    const linux = page.locator(`.terminal-pane[data-connection-id="${id}"]`);
    await expect(linux.locator('.xterm-accessibility-tree')).toContainText(/[$#]/, {
      timeout: 15000,
    });
    await command(
      linux,
      `cd "$(mktemp -d)" && git init -q && git -c user.email=t@example.invalid -c user.name=t commit -q --allow-empty -m wsl && printf 'REPO%s\\n' _READY`,
      'REPO_READY',
    );
    return linux;
  };
  // No terminal question: a refusal or no helper ends the push at once. Linux git reads none of
  // the user's settings either, so a credential manager set up in WSL is never asked.
  const push = (linux, branch) =>
    command(
      linux,
      `GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_SSL_NO_VERIFY=1 GIT_TERMINAL_PROMPT=0 git push -q ${repository} HEAD:refs/heads/${branch} 2>/dev/null; printf 'PUSH%s:%s\\n' _${branch} $?`,
      '',
    );
  const pushed = (linux, branch, status) =>
    expect(linux.locator('.xterm-accessibility-tree')).toContainText(
      status === 0 ? `PUSH_${branch}:0` : new RegExp(`PUSH_${branch}:[1-9]`),
      { timeout: 60000 },
    );
  const remoteBranches = () =>
    docker([
      'exec',
      httpsServer,
      'git',
      '--git-dir',
      '/var/lib/gitea/git/repositories/probe/wsl-credential.git',
      'for-each-ref',
      '--format=%(refname)',
    ]);
  const settingsSection = async () => {
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '설정' });
    await settings.getByRole('tab', { name: '에이전트', exact: true }).click();
    return settings.getByRole('region', { name: 'WSL 탭의 HTTPS Git 자격 증명' });
  };
  const closeSettings = async () => {
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: '설정' })).toHaveCount(0);
  };

  let section = await settingsSection();
  const option = section.getByLabel('WSL 탭에 이 PC의 HTTPS Git 자격 증명 제공', { exact: true });
  await expect(option).not.toBeChecked();
  await option.check();
  await expect(section.getByRole('status')).toContainText('새로 여는 WSL 탭부터');
  await closeSettings();

  // This PC's value: the isolated `store` helper has it. The card names the tab, says the value
  // goes to git in that tab, and nothing is fetched before it is allowed.
  await writeFile(gitStore, `https://probe:${password}@127.0.0.1:${port}\n`);
  const first = await openLinux();
  await command(first, `printf 'LPIPE[%s]\\n' "\${DACHSTERM_CREDENTIAL_PIPE-}"`, 'LPIPE[]');
  await command(
    first,
    "cmd.exe /c 'echo WPIPE:%DACHSTERM_CREDENTIAL_PIPE%' | tr -d '\\r'",
    /WPIPE:\\\\\.\\pipe\\dachsterm-credential-[0-9a-f]{32}/,
  );
  const pipe = (await first.locator('.xterm-accessibility-tree').innerText())
    .replaceAll('\n', '')
    .match(/WPIPE:(\\\\\.\\pipe\\dachsterm-credential-[0-9a-f]{32})/)[1];
  await command(
    first,
    "GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null git config --get-all credential.helper | grep -c 'git-credential get' | sed 's/^/HELPERS:/'",
    'HELPERS:1',
  );
  await push(first, 'from-pc');
  const card = (linux) =>
    linux.getByRole('alertdialog', { name: 'Git 자격 증명 요청', exact: true });
  await expect(card(first)).toBeVisible({ timeout: 30000 });
  await expect(card(first)).toContainText('WSL의 git이 HTTPS 자격 증명을 요청합니다');
  await expect(card(first)).toContainText('이 WSL 탭의 git으로 전달됩니다');
  await expect(card(first)).toContainText(`https://127.0.0.1:${port}`);
  await expect(card(first)).not.toContainText('서버로 전달됩니다');
  await expect(card(first).getByRole('button', { name: '이 탭에서 10분 허용' })).toBeVisible();
  await mkdir('test-results-native', { recursive: true });
  await page.screenshot({ path: 'test-results-native/wsl-credential.png' });
  await card(first).getByRole('button', { name: '이번만 허용', exact: true }).click();
  await pushed(first, 'from-pc', 0);
  expect(remoteBranches()).toContain('refs/heads/from-pc');
  console.log("PASS WSL HTTPS push with this PC's credential after the tab's card");

  // Nothing saved on this PC: a refusal fails the push, and allowing turns the card into fields.
  await writeFile(gitStore, '');
  const second = await openLinux();
  await push(second, 'refused');
  await expect(card(second)).toBeVisible({ timeout: 30000 });
  await card(second).getByRole('button', { name: '거부', exact: true }).click();
  await pushed(second, 'refused', 1);
  await push(second, 'typed');
  await expect(card(second)).toBeVisible({ timeout: 30000 });
  await card(second).getByRole('button', { name: '이번만 허용', exact: true }).click();
  await expect(card(second).getByRole('status')).toContainText('저장된 값이 없습니다', {
    timeout: 30000,
  });
  await card(second).getByLabel('사용자 이름', { exact: true }).fill('probe');
  await card(second).getByLabel('토큰 또는 암호', { exact: true }).fill(password);
  await card(second).getByRole('button', { name: '확인', exact: true }).click();
  await pushed(second, 'typed', 0);
  const branches = remoteBranches();
  expect(branches).toContain('refs/heads/typed');
  expect(branches).not.toContain('refs/heads/refused');
  console.log('PASS WSL HTTPS push refused, then typed on the card when nothing is saved');

  // Off again: a new WSL tab is as before, with no helper and no card.
  section = await settingsSection();
  await section.getByLabel('WSL 탭에 이 PC의 HTTPS Git 자격 증명 제공', { exact: true }).uncheck();
  await expect(section.getByRole('status')).toContainText('저장했습니다');
  await closeSettings();
  const third = await openLinux();
  await command(third, `printf 'GCP[%s]\\n' "\${GIT_CONFIG_PARAMETERS-}"`, 'GCP[]');
  await push(third, 'off');
  await pushed(third, 'off', 1);
  await expect(card(third)).toHaveCount(0);
  expect(remoteBranches()).not.toContain('refs/heads/off');
  console.log('PASS with the setting off a new WSL tab gets no helper, and git fails as before');

  for (const tab of [third, second, first]) {
    await chooseTabMenu(page, '탭 닫기', tab);
    await expect(tab).toHaveCount(0);
  }
  await expect.poll(() => pipeOpen(pipe), { timeout: 10000 }).toBe(false);
  console.log('PASS closing the WSL tab removes its credential pipe');
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
  if (agentOnly || credentialsOnly || gitOnly || dropOnly || dragOnly) {
    if (agentOnly) await checkLocalAgent(page, command, pane);
    if (credentialsOnly) await checkWslCredentials(page, command);
    if (gitOnly) await checkLocalGit(page, command, pane);
    if (dropOnly) await checkLocalDrop(page, command, pane);
    if (dragOnly) await checkDragOut(page, command, pane);
    throw finished;
  }
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
  await checkLocalAgent(page, command, pane);
  await checkWslCredentials(page, command);
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
} catch (error) {
  if (error !== finished) throw error;
} finally {
  await shutdown();
  if (gitServerUp) spawnSync('docker', ['rm', '-f', gitServer], { stdio: 'ignore' });
  if (httpsServerUp) spawnSync('docker', ['rm', '-f', httpsServer], { stdio: 'ignore' });
}
