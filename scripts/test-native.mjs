// Windows WebView2 integration test against the built app and real fixture.
// Never print Playwright errors: locator traces can contain entered credentials.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import {
  arrangeTabs,
  chooseProfileMenu,
  chooseTabMenu,
  closeTerminalSettings,
  dragTab,
  expectPtyMatchesTerminal,
  inputPick,
  inputScope,
  openNewConnectionForm,
  openTerminalSearch,
  openTerminalSettings,
  showSidebarView,
} from './native-workspace.mjs';
import { verifyTerminalBasics } from './verify-terminal-basics.mjs';
import { verifyAgentTerminal } from './verify-agent-terminal.mjs';
import { verifyTunnels } from './verify-tunnels.mjs';
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-native-'));
const screenshots = path.resolve('test-results-native');
await mkdir(screenshots, { recursive: true });
const probe = (key) => process.env[`DACHSTERM_PROBE_${key}`];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Argon2 in the debug build takes about 1s when idle and over 4s on a busy machine.
const kdfWait = { timeout: 20000 };
// Ends a run limited to the agent checks. The cleanup in `finally` still runs.
const finishedEarly = new Error('agent checks only');
let app,
  browser,
  page,
  stage = 'launch',
  paused = false;
async function port() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
async function launch() {
  const debugPort = await port();
  app = spawn(process.env.DACHSTERM_TEST_BINARY ?? path.resolve('target/debug/dachsterm.exe'), [], {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      DACHSTERM_TEST_DATA_DIR: directory,
      DACHSTERM_TEST_CDP_PORT: String(debugPort),
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
    },
  });
  let endpoint;
  for (let i = 0; i < 80; i++) {
    try {
      endpoint = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!endpoint) throw new Error('debug endpoint unavailable');
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  for (let i = 0; i < 40; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('tauri.localhost'));
    if (page) break;
    await sleep(250);
  }
  assert(page);
  page.setDefaultTimeout(12000);
  await expect(page.getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
}
async function invoke(command, args = {}) {
  return page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
}
async function shutdown() {
  let graceful = true;
  if (app) {
    // Without /F taskkill requests normal window closure on this test-owned PID.
    const closing = spawnSync('taskkill', ['/PID', String(app.pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (closing.status !== 0) app.kill();
    for (let i = 0; i < 40 && app.exitCode === null; i++) await sleep(100);
    graceful = closing.status === 0 && app.exitCode === 0;
    if (!graceful)
      console.error(`Native close result: request=${closing.status}, exit=${app.exitCode}`);
    if (app.exitCode === null) app.kill();
    app = null;
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  await webviewExit();
  return graceful;
}
// On a busy machine WebView2 outlives the app. Launching again with the same data folder
// then opens the debug port late or never, so wait for this test's own processes to end.
async function webviewExit() {
  const filter = `*${path.basename(directory)}*`;
  for (let i = 0; i < 30; i++) {
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `@(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '${filter}' }).Count`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.stdout.trim() === '0') return;
    await sleep(500);
  }
  console.error('WebView2 processes still running after 15s or more');
}
function pane() {
  return page.locator(
    '.pane-cell.focused .terminal-pane:not([hidden]), .detached-grid > .terminal-pane',
  );
}
async function typeInput(text) {
  for (const chunk of text.match(/[^\u0080-\uFFFF]+|[\u0080-\uFFFF]+/g) ?? []) {
    if (chunk.charCodeAt(0) < 128) await page.keyboard.type(chunk, { delay: 5 });
    else {
      // WebView2 CDP does not commit IME text reliably. Exercise xterm's real
      // composition handlers; physical Windows IME still requires manual QA.
      await pane()
        .locator('.xterm-helper-textarea')
        .evaluate(async (input, text) => {
          input.value = '';
          input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          input.value += text;
          input.dispatchEvent(
            new CompositionEvent('compositionupdate', { data: text, bubbles: true }),
          );
          input.dispatchEvent(
            new CompositionEvent('compositionend', { data: text, bubbles: true }),
          );
          await new Promise((resolve) => setTimeout(resolve, 50));
        }, chunk);
      await sleep(30);
    }
  }
}
async function command(text, target = pane()) {
  const input = target.locator('.xterm-helper-textarea');
  await input.focus();
  await expect(input).toBeFocused();
  if (/^[\x20-\x7e]*$/.test(text)) {
    // One real paste event avoids WebView2's per-key focus races during layout updates.
    await input.evaluate((element, value) => {
      const clipboard = new DataTransfer();
      clipboard.setData('text/plain', value);
      element.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }),
      );
    }, text);
  } else await typeInput(text);
  await input.press('Enter');
}
async function output(text, target = pane()) {
  // Search the real terminal buffer: accessibility text covers only the viewport,
  // which may move when a split is resized or an old tab becomes active.
  const search = await openTerminalSearch(page, target);
  await search.fill(text);
  await expect
    .poll(
      async () => {
        await search.press('Enter');
        return target.locator('.xterm-accessibility-tree').innerText();
      },
      { timeout: 12000 },
    )
    .toContain(text);
  await search.press('Escape');
}
async function connected() {
  await expect(pane().locator('.connection-message')).toContainText('연결됨', { timeout: 15000 });
  await command('stty -echo');
  await sleep(150);
}
// A server connection switches the sidebar to its files.
const showConnections = () => showSidebarView(page, '연결');
// The click returns before the tab exists because connecting first awaits vault_status.
// Until then pane() is the previous connected tab, so connected() alone would pass early.
async function connectNewTab() {
  const tabs = page.locator('.tab-strip').getByRole('tab');
  const count = await tabs.count();
  const previousId = await pane().getAttribute('data-connection-id');
  await showConnections();
  await page.locator('.profile-card .profile-target').dblclick();
  await expect(tabs).toHaveCount(count + 1);
  await expect.poll(() => pane().getAttribute('data-connection-id')).not.toBe(previousId);
  await connected();
}
function docker(args) {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) throw new Error('fixture operation failed');
  return r.stdout;
}
try {
  await launch();
  console.log('PASS native packaged WebView2 starts without Vite');
  stage = 'group and profile';
  await page.getByRole('button', { name: '그룹 추가', exact: true }).click();
  await page.getByLabel('그룹 이름', { exact: true }).fill('개발');
  await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click();
  await openNewConnectionForm(page);
  const form = page.getByRole('dialog');
  await form.getByLabel('이름', { exact: true }).fill('OpenSSH 테스트');
  await form.getByLabel('호스트', { exact: true }).fill('127.0.0.1');
  await form.getByLabel('포트', { exact: true }).fill(probe('PORT'));
  await form.getByLabel('사용자', { exact: true }).fill('probe');
  await form.getByLabel('비밀번호', { exact: true }).fill(probe('PASSWORD'));
  await form.getByLabel('인증정보 보관', { exact: true }).selectOption('replace');
  await form.locator('summary', { hasText: '고급 옵션' }).click();
  await form.getByLabel('그룹', { exact: true }).selectOption({ label: '개발' });
  await form.getByLabel('즐겨찾기', { exact: true }).check();
  await form.getByLabel('KeepAlive (초)', { exact: true }).fill('5');
  await form.getByRole('button', { name: '저장 후 연결', exact: true }).click();
  stage = 'first host trust';
  await expect(page.getByRole('alert', { name: '최초 호스트키 확인' })).toBeVisible();
  const fingerprint = docker([
    'exec',
    probe('CONTAINER'),
    'ssh-keygen',
    '-lf',
    '/run/probe/host.pub',
  ]).split(/\s+/)[1];
  await expect(page.locator('.trust-card code')).toHaveText(fingerprint);
  await page.getByRole('button', { name: '지문 확인 · 신뢰하고 연결', exact: true }).click();
  await connected();
  await command('locale charmap');
  await command("printf 'NATIVE_한글_OK\\n'");
  await output('NATIVE_한글_OK');
  await page.screenshot({ path: path.join(screenshots, 'connected.png') });
  console.log('PASS native UI -> IPC -> host trust -> password -> Korean PTY output');
  stage = 'U3 tunnel visual editor and real forwarding';
  await verifyTunnels({ page, invoke, docker, probe, screenshots });
  stage = 'AT agent terminal';
  await verifyAgentTerminal({
    page,
    pane,
    invoke,
    docker,
    probe,
    command,
    output,
    connected,
    typeInput,
    showConnections,
    directory,
    screenshots,
    setStage: (value) => {
      stage = value;
    },
  });
  if (process.env.DACHSTERM_AGENT_ONLY === '1') throw finishedEarly;
  stage = 'S1 terminal and authentication basics';
  if (process.env.DACHSTERM_UI_REGRESSION_ONLY === '1')
    console.log('SKIP S1 parallel authentication/terminal-basics extension (UI regression only)');
  else
    await verifyTerminalBasics({
      page,
      pane,
      command,
      output,
      directory,
      probe,
      setStage: (value) => {
        stage = value;
      },
    });
  stage = 'embedded games preserve SSH';
  const gameConnection = await pane().getAttribute('data-connection-id');
  await command("sleep 2; printf 'OUTPUT_DURING_GAME\\n'");
  await page.locator('.sidebar-games summary').click();
  await page
    .getByRole('navigation', { name: '게임 목록' })
    .getByRole('button', { name: '블록 퍼즐', exact: true })
    .click();
  const gamePanel = page.getByRole('tabpanel', { name: '블록 퍼즐', exact: true });
  await gamePanel.getByRole('button', { name: '게임 시작', exact: true }).click();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');
  await page.keyboard.press('p');
  await expect(page.locator('.terminal-pane')).toBeHidden();
  await sleep(2300);
  await page.screenshot({ path: path.join(screenshots, 'games-with-ssh.png') });
  await page.keyboard.press('Escape');
  await expect(pane()).toHaveAttribute('data-connection-id', gameConnection);
  await output('OUTPUT_DURING_GAME');
  // Read the shell's pending input: game keys must never reach the PTY.
  await command('IFS= read -r game_input; printf \'GAME_INPUT<%s>\\n\' "$game_input"');
  await page.getByRole('tab', { name: '블록 퍼즐', exact: true }).click();
  await gamePanel.getByRole('button', { name: '계속하기', exact: true }).click();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Space');
  await page.keyboard.press('Escape');
  await pane().locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Enter');
  await output('GAME_INPUT<>');
  await page.getByRole('button', { name: '블록 퍼즐 탭 닫기', exact: true }).click();
  await page.locator('.sidebar-games summary').click();
  await command("printf 'SSH_AFTER_GAME\\n'");
  await output('SSH_AFTER_GAME');
  console.log(
    'PASS native embedded game / background SSH output / isolated game keys / original connection',
  );
  stage = 'five tabs';
  for (let i = 0; i < 4; i++) {
    stage = `five tabs open ${i + 2}`;
    await connectNewTab();
    await command(`printf 'TAB_${i}\\n'`);
    await output(`TAB_${i}`);
  }
  stage = 'five tabs isolation and close';
  await expect(page.locator('.tab-strip').getByRole('tab')).toHaveCount(5);
  await page.screenshot({ path: path.join(screenshots, 'five-tabs.png') });
  await page.locator('.tab-strip').getByRole('tab').first().click();
  await output('NATIVE_한글_OK');
  await page.getByRole('button', { name: 'OpenSSH 테스트 탭 닫기', exact: true }).nth(2).click();
  await expect(page.locator('.tab-strip').getByRole('tab')).toHaveCount(4);
  await command("printf 'SURVIVED_CLOSE\\n'");
  await output('SURVIVED_CLOSE');
  console.log('PASS native five tabs / isolated scrollback / individual close');
  stage = 'selective multi input';
  const firstBroadcastId = await pane().getAttribute('data-connection-id');
  await page.locator('.tab-strip').getByRole('tab').nth(1).click();
  const secondBroadcastId = await pane().getAttribute('data-connection-id');
  await arrangeTabs(page, '2 × 2');
  await expect(inputScope(page, '선택')).toBeEnabled();
  await inputScope(page, '선택').check();
  await inputPick(page, firstBroadcastId).check();
  await inputPick(page, secondBroadcastId).check();
  await expect.poll(async () => (await invoke('broadcast_status')).selected.length).toBe(2);
  await command("printf 'BROADCAST_SELECTED_ONLY\\n'");
  await output('BROADCAST_SELECTED_ONLY');
  await page.locator('.tab-strip').getByRole('tab').first().click();
  await output('BROADCAST_SELECTED_ONLY');
  await page.locator('.tab-strip').getByRole('tab').nth(2).click();
  assert(
    !(await pane().locator('.xterm-accessibility-tree').innerText()).includes(
      'BROADCAST_SELECTED_ONLY',
    ),
  );
  await page.locator('.tab-strip').getByRole('tab').nth(1).click();
  await chooseTabMenu(page, '연결 종료');
  await expect.poll(async () => (await invoke('broadcast_status')).selected.length).toBe(0);
  await pane().getByRole('button', { name: '재접속', exact: true }).click();
  await connected();
  assert.equal((await invoke('broadcast_status')).selected.length, 0);
  console.log(
    'PASS native selected broadcast delivered to two shells only, disconnect stops group',
  );
  stage = 'selective multi input';
  // A new tab opens in the focused group, so focus the last group to keep the first on screen.
  await page.locator('.tab-strip').getByRole('tab').nth(3).click();
  await showConnections();
  await page.locator('.local-targets').getByTitle('명령 프롬프트 새 터미널 열기').click();
  const mixedLocal = page.getByRole('region', { name: '명령 프롬프트 터미널', exact: true });
  await expect(mixedLocal.locator('.connection-message')).toContainText('로컬 ·');
  await expect(mixedLocal.locator('.xterm-accessibility-tree')).toContainText('>');
  const mixedLocalId = await mixedLocal.getAttribute('data-connection-id');
  await expect(inputScope(page, '선택')).toBeEnabled();
  await inputScope(page, '선택').check();
  for (const id of [firstBroadcastId, mixedLocalId]) await inputPick(page, id).check();
  await expect.poll(async () => (await invoke('broadcast_status')).selected.length).toBe(2);
  await command('echo MIXED_FROM_LOCAL');
  await output(
    'MIXED_FROM_LOCAL',
    page.locator(`.terminal-pane[data-connection-id="${firstBroadcastId}"]`),
  );
  await page.locator('.tab-strip').getByRole('tab').first().click();
  await command('echo MIXED_FROM_SSH');
  await output('MIXED_FROM_SSH', mixedLocal);
  await page.getByRole('button', { name: '명령 프롬프트 탭 닫기' }).click();
  await expect.poll(async () => (await invoke('broadcast_status')).selected.length).toBe(0);
  console.log('PASS native mixed local/SSH input in both directions and local close resets group');
  await arrangeTabs(page, '하나로');
  stage = 'workspace SFTP and monitoring';
  await showSidebarView(page, '파일');
  const workspaceId = await pane().getAttribute('data-connection-id');
  const listing = await invoke('sftp_list', { id: workspaceId, path: '.' });
  assert(listing.path.startsWith('/'));
  await page.getByLabel('숨김 파일 표시').check();
  await expect(page.locator('.file-row').filter({ hasText: '.ssh' })).toBeVisible();
  const { writeFile: writeLocal } = await import('node:fs/promises');
  const uploadFile = path.join(directory, '한글 upload.txt');
  await writeLocal(uploadFile, 'native upload revision');
  const [transferId] = await invoke('transfer_batch', {
    id: workspaceId,
    path: listing.path,
    mode: 'drop',
    paths: [uploadFile],
    conflict: 'error',
  });
  await expect
    .poll(async () => (await invoke('transfer_list')).find((t) => t.id === transferId)?.status)
    .toBe('completed');
  await page.getByRole('button', { name: '파일 새로 고침', exact: true }).click();
  await expect(page.locator('.file-row').filter({ hasText: '한글 upload.txt' })).toBeVisible();
  await expect
    .poll(async () => (await invoke('monitor_get', { id: workspaceId }))?.history.length ?? 0, {
      timeout: 15000,
    })
    .toBeGreaterThan(1);
  await page.locator('.monitor-bar').click();
  await expect(page.getByRole('region', { name: '서버 모니터링 상세' })).toBeVisible();
  await page.screenshot({ path: path.join(screenshots, 'workspace-monitoring.png') });
  await page.getByRole('button', { name: '모니터링 상세 닫기' }).click();
  console.log('PASS native SFTP listing/upload and live CPU/RAM/NET/disk panel');
  stage = 'file permissions archive and editor';
  const files = page.locator('.files');
  const uploadedRow = () => files.locator('.file-row').filter({ hasText: '한글 upload.txt' });
  await uploadedRow().click();
  await files.getByRole('button', { name: '권한', exact: true }).click();
  stage = 'file permission form';
  await page.getByRole('dialog').getByLabel('권한 (000~777)').fill('640');
  await page.getByRole('dialog').getByRole('button', { name: '적용', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  assert.equal(
    (await invoke('sftp_list', { id: workspaceId, path: listing.path })).entries.find(
      (e) => e.name === '한글 upload.txt',
    ).permissions & 0o777,
    0o640,
  );
  await uploadedRow().click();
  await files.getByRole('button', { name: '압축', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '적용', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(files.locator('.file-row').filter({ hasText: 'archive.zip' })).toBeVisible();
  await files.locator('.file-row').filter({ hasText: 'archive.zip' }).click();
  await files.getByRole('button', { name: '압축 해제', exact: true }).click();
  await page.getByRole('dialog').getByLabel('ZIP 파일명 인코딩').selectOption('auto');
  await page.getByRole('dialog').getByRole('button', { name: '적용', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(files.locator('.file-row').filter({ hasText: 'archive.zip 추출' })).toBeVisible();
  const helper = path.join(directory, 'editor-helper.cjs');
  await writeLocal(
    helper,
    "require('fs').writeFileSync(process.argv[2], 'external executable saved revision', 'utf8');",
  );
  stage = 'external editor form';
  await uploadedRow().dblclick();
  const editorForm = page.getByRole('dialog');
  await editorForm.getByLabel('프로그램 경로', { exact: true }).fill(process.execPath);
  stage = 'external editor args';
  await editorForm.getByLabel('추가 인자 (JSON 배열)').fill(JSON.stringify([helper]));
  await editorForm.getByLabel('저장 후 동작').selectOption('ask');
  await editorForm.getByRole('button', { name: '편집 시작', exact: true }).click();
  await expect(editorForm).not.toBeVisible();
  const edited = files.locator('.edit-item').filter({ hasText: '한글 upload.txt' });
  await expect(edited).toContainText('업로드할까요?', { timeout: 15000 });
  assert.equal(
    docker(['exec', probe('CONTAINER'), 'cat', `${listing.path}/한글 upload.txt`]),
    'native upload revision',
  );
  await edited.getByRole('button', { name: '취소 · 수정본 보존' }).click();
  await expect.poll(async () => (await invoke('edit_list'))[0]?.status).toBe('recovery');
  const editRecord = (await invoke('edit_list'))[0];
  assert.equal(await readFile(editRecord.local, 'utf8'), 'external executable saved revision');
  await edited.getByText('수정본 · 복구', { exact: true }).click();
  await edited.getByRole('button', { name: '재시도', exact: true }).click();
  await expect
    .poll(() => docker(['exec', probe('CONTAINER'), 'cat', `${listing.path}/한글 upload.txt`]))
    .toBe('external executable saved revision');
  await edited.getByLabel('저장 후 동작').selectOption('auto');
  await writeLocal(editRecord.local, 'automatic saved revision');
  await expect
    .poll(() => docker(['exec', probe('CONTAINER'), 'cat', `${listing.path}/한글 upload.txt`]), {
      timeout: 15000,
    })
    .toBe('automatic saved revision');
  await page.screenshot({ path: path.join(screenshots, 'files-editor.png') });
  const { panelScrolls, treeShare, toolbarRows } = await files.evaluate((panel) => ({
    panelScrolls: panel.scrollHeight > panel.clientHeight,
    treeShare: panel.querySelector('.file-list').offsetHeight / panel.clientHeight,
    toolbarRows: new Set(
      [...panel.querySelector('.file-actions').querySelectorAll('button')].map((b) => b.offsetTop),
    ).size,
  }));
  assert(!panelScrolls, 'The panel must not scroll as a whole while the tray is open');
  assert(treeShare > 0.25, `Tree share with the tray open: ${treeShare}`);
  assert.equal(toolbarRows, 1);
  const preservedPath = await files.getByLabel('원격 경로').inputValue();
  await showSidebarView(page, '연결');
  await expect(files).toBeHidden();
  await showSidebarView(page, '파일');
  await expect(files.getByLabel('원격 경로')).toHaveValue(preservedPath);
  await expect(edited).toBeVisible();
  const fileBounds = await files.boundingBox();
  const terminalBounds = await pane().boundingBox();
  assert(fileBounds.x < terminalBounds.x, 'SFTP must occupy the unified left sidebar');
  await showSidebarView(page, '연결');
  console.log(
    'PASS native permissions, archive/extract, external executable launch, save prompt/cancel/preserve/retry and automatic upload',
  );

  stage = 'legacy terminal encoding';
  await showConnections();
  await chooseProfileMenu(page, page.locator('.profile-card'), '수정');
  await page.getByRole('dialog').locator('summary', { hasText: '고급 옵션' }).click();
  await page.getByRole('dialog').getByLabel('터미널 인코딩').selectOption('euc-kr');
  await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click();
  await connectNewTab();
  await command(`python3 -c "import sys;sys.stdout.buffer.write(bytes.fromhex('c7d1b1db'))"`);
  await output('한글');
  await command(
    `python3 -c "import sys;print('LEGACY_INPUT_READY',flush=True);print(sys.stdin.buffer.readline().hex())"`,
  );
  await output('LEGACY_INPUT_READY');
  await typeInput('한글');
  await page.keyboard.press('Enter');
  await output('c7d1b1db0a');
  await page.getByRole('button', { name: 'OpenSSH 테스트 탭 닫기', exact: true }).last().click();
  await showConnections();
  await chooseProfileMenu(page, page.locator('.profile-card'), '수정');
  await page.getByRole('dialog').getByLabel('터미널 인코딩').selectOption('utf-8');
  await page.getByRole('dialog').getByRole('button', { name: '저장', exact: true }).click();
  await page.locator('.tab-strip').getByRole('tab').first().click();
  console.log('PASS native CP949 Korean output and exact encoded input bytes');
  stage = 'split layout';
  const connections = await page
    .locator('.terminal-pane')
    .evaluateAll((panes) => panes.map((p) => p.dataset.connectionId));
  await page.locator('.terminal-pane .xterm').evaluateAll((terminals) => {
    for (const terminal of terminals) terminal.dataset.instance = 'original';
  });
  await arrangeTabs(page, '2 × 2');
  await expect(page.locator('.terminal-pane:not([hidden])')).toHaveCount(4);
  const before = [];
  for (let i = 0; i < 4; i++) {
    stage = `split layout pane ${i}`;
    const splitPane = page.locator('.terminal-pane:not([hidden])').nth(i);
    await command(`printf 'SPLIT_${i}\\n'`, splitPane);
    await output(`SPLIT_${i}`, splitPane);
    before.push(await expectPtyMatchesTerminal(splitPane, command));
  }
  await page.screenshot({ path: path.join(screenshots, 'split-grid.png') });
  stage = 'split layout divider resize';
  const divider = page.getByRole('separator', { name: '칸 크기 조절' }).first();
  const handle = await divider.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 120, handle.y + handle.height / 2, { steps: 12 });
  await page.mouse.up();
  await sleep(200);
  const after = [];
  for (let i = 0; i < 4; i++)
    after.push(
      await expectPtyMatchesTerminal(page.locator('.terminal-pane:not([hidden])').nth(i), command),
    );
  assert(
    after.filter((size, i) => size.cols !== before[i].cols).length === 2,
    'dragging a divider resizes exactly the two groups beside it',
  );
  await page.screenshot({ path: path.join(screenshots, 'split-divider.png') });
  stage = 'split layout tab drag';
  // Group 1 moves into group 2, then group 2 splits with a tab of its own beside group 3.
  const firstTab = page.locator('.tab-strip').first().getByRole('tab');
  const secondCell = await page.locator('.terminal-pane:not([hidden])').nth(1).boundingBox();
  await dragTab(
    page,
    firstTab,
    secondCell.x + secondCell.width / 2,
    secondCell.y + secondCell.height / 2,
  );
  await expect(page.locator('.tab-strip')).toHaveCount(3);
  await expect(page.locator('.terminal-pane:not([hidden])')).toHaveCount(3);
  await page.mouse.move(5, 5);
  await sleep(200);
  const moved = page.locator('.pane-cell.focused .terminal-pane');
  await expect(moved).toHaveAttribute('data-connection-id', connections[0]);
  await expectPtyMatchesTerminal(moved, command);
  const lastCell = await page.locator('.terminal-pane:not([hidden])').last().boundingBox();
  await dragTab(
    page,
    page.locator('.tab-strip').first().getByRole('tab').first(),
    lastCell.x + lastCell.width - 8,
    lastCell.y + lastCell.height / 2,
  );
  await expect(page.locator('.terminal-pane:not([hidden])')).toHaveCount(4);
  await sleep(200);
  await page.screenshot({ path: path.join(screenshots, 'tab-drag.png') });
  for (let i = 0; i < 4; i++)
    await expectPtyMatchesTerminal(page.locator('.terminal-pane:not([hidden])').nth(i), command);
  // Keys pressed over a terminal the drag crossed must not have reached it as mouse reports.
  await command("printf 'AFTER_TAB_DRAG\\n'", moved);
  await output('AFTER_TAB_DRAG', moved);
  await arrangeTabs(page, '하나로');
  assert.deepEqual(
    await page
      .locator('.terminal-pane')
      .evaluateAll((panes) => panes.map((p) => p.dataset.connectionId)),
    connections,
    'arranging tabs keeps every connection',
  );
  await expect(page.locator('.terminal-pane .xterm[data-instance="original"]')).toHaveCount(
    connections.length,
  );
  await page.locator('.tab-strip').getByRole('tab').first().click();
  console.log(
    'PASS native 2x2 independent PTY input, per-group stty size after divider and tab drag, same connections and terminals',
  );
  stage = 'terminal controls';
  // The tab menu path, where the shortcut is used elsewhere.
  await chooseTabMenu(page, '터미널 검색');
  await pane().getByLabel('터미널 검색', { exact: true }).fill('NATIVE_한글_OK');
  await pane().getByRole('button', { name: '이전 검색 결과', exact: true }).click();
  stage = 'clipboard';
  const clipboardSession = await page.context().newCDPSession(page);
  await clipboardSession.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const previousClipboard = await page.evaluate(() => navigator.clipboard.readText());
  try {
    await pane().locator('.xterm-helper-textarea').focus();
    await page.keyboard.press('Control+Shift+C');
    // Copying writes asynchronously, so an immediate read can see the old value.
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe('NATIVE_한글_OK');
    await pane().locator('.xterm-helper-textarea').focus();
    await typeInput("printf '");
    await page.keyboard.press('Control+Shift+V');
    await pane().locator('.xterm-helper-textarea').focus();
    await typeInput("\\n'");
    await page.keyboard.press('Enter');
    await output('NATIVE_한글_OK');
  } finally {
    await page.evaluate((text) => navigator.clipboard.writeText(text), previousClipboard);
    await clipboardSession.detach();
  }
  console.log('PASS native clipboard copy/paste (previous clipboard restored)');
  stage = 'terminal controls';
  const settings = await openTerminalSettings(page);
  await settings.getByLabel('글꼴 크기', { exact: true }).selectOption('18');
  await settings.getByLabel('스크롤백', { exact: true }).selectOption('1000');
  await closeTerminalSettings(page);
  await command("stty size; printf 'SIZE_DONE\\n'");
  await output('SIZE_DONE');
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await page.setViewportSize({ width: 800, height: 650 });
  await sleep(300);
  await command("stty size; printf 'RESIZE_DONE\\n'");
  await output('RESIZE_DONE');
  await page.screenshot({ path: path.join(screenshots, 'narrow-terminal.png') });
  await page.setViewportSize(viewport);
  stage = 'TUI';
  await command('top');
  await output('Tasks:');
  await page.screenshot({ path: path.join(screenshots, 'top.png') });
  await page.keyboard.press('q');
  await sleep(250);
  await command("printf 'AFTER_TOP\\n'");
  await output('AFTER_TOP');
  await command('htop');
  await output('Help');
  await output('Tree');
  await sleep(300);
  await page.screenshot({ path: path.join(screenshots, 'htop.png') });
  await page.keyboard.press('q');
  await sleep(250);
  await command("vi -c 'set showmode' /tmp/dachsterm-native.txt");
  await output('dachsterm-native.txt');
  await page.keyboard.press('i');
  await output('INSERT');
  await typeInput('한글 편집 확인');
  await output('한글 편집 확인');
  await page.screenshot({ path: path.join(screenshots, 'vim.png') });
  await page.keyboard.press('Escape');
  await page.keyboard.type(':wq');
  await page.keyboard.press('Enter');
  await command('cat /tmp/dachsterm-native.txt');
  await output('한글 편집 확인');
  assert.equal(
    docker(['exec', probe('CONTAINER'), 'cat', '/tmp/dachsterm-native.txt']).trim(),
    '한글 편집 확인',
  );
  console.log('PASS native search/font/scrollback/resize / top/htop/vim Korean editing');
  stage = 'detached window ownership';
  await command("printf 'BEFORE_DETACH\\n'");
  await output('BEFORE_DETACH');
  const mainPage = page;
  const detachedId = await pane().getAttribute('data-connection-id');
  // Beyond the window edge. CDP reports the position, so a real OS drag remains a manual check.
  const selectedTab = page.locator('.tab-strip').getByRole('tab', { selected: true });
  await dragTab(page, selectedTab, -40, 300);
  let detachedPage;
  for (let i = 0; i < 60; i++) {
    detachedPage = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes(`detached=${detachedId}`));
    if (detachedPage) break;
    await sleep(200);
  }
  assert(detachedPage);
  page = detachedPage;
  await connected();
  await output('BEFORE_DETACH');
  await command("printf 'AFTER_DETACH\\n'");
  await output('AFTER_DETACH');
  assert((await page.locator('.files').boundingBox()).x < (await pane().boundingBox()).x);
  await page.keyboard.press('F11');
  await expect.poll(() => invoke('plugin:window|is_fullscreen')).toBe(true);
  await expect(page.locator('.files')).toBeHidden();
  await expect(page.locator('footer.status-bar')).toBeVisible();
  await page.keyboard.press('F11');
  await expect.poll(() => invoke('plugin:window|is_fullscreen')).toBe(false);
  await expect(page.locator('.files')).toBeVisible();
  await mainPage.getByRole('button', { name: '설정', exact: true }).click();
  await mainPage.getByRole('radio', { name: /Terminal Green/ }).check();
  await expect
    .poll(() => detachedPage.evaluate(() => localStorage.getItem('dachsterm.theme')))
    .toBe('terminal-green');
  await expect
    .poll(() => detachedPage.evaluate(() => document.documentElement.dataset.theme))
    .toBe(await mainPage.evaluate(() => document.documentElement.dataset.theme));
  await command("printf 'THEME_KEEP_CONNECTION\\n'");
  await output('THEME_KEEP_CONNECTION');
  await mainPage.getByRole('radio', { name: /DachsTerm Classic/ }).check();
  await mainPage.keyboard.press('Escape');
  console.log('PASS native SSH detached window theme synchronization without disconnect');

  // One title bar: no system frame, the app's own buttons and the connection's name.
  expect(await invoke('plugin:window|is_decorated')).toBe(false);
  await expect(page.locator('header.toolbar')).toContainText('OpenSSH 테스트');
  await page.getByRole('button', { name: '최대화', exact: true }).click();
  await expect.poll(() => invoke('plugin:window|is_maximized')).toBe(true);
  await page.getByRole('button', { name: '이전 크기로', exact: true }).click();
  await expect.poll(() => invoke('plugin:window|is_maximized')).toBe(false);
  await page.screenshot({ path: path.join(screenshots, 'detached-window.png') });
  const closedWindow = page.waitForEvent('close');
  await page
    .getByRole('button', { name: '닫기', exact: true })
    .click()
    .catch((error) => {
      if (!page.isClosed()) throw error;
    });
  await closedWindow;
  page = mainPage;
  await expect
    .poll(async () => (await invoke('monitor_get', { id: detachedId }))?.status)
    .toBe('disconnected');
  await page.locator('.tab-strip').getByRole('tab').first().click();
  await connected();
  console.log(
    'PASS native independent window keeps SSH output/input, own title bar buttons, closed window cleanup',
  );
  stage = 'disconnect reconnect';
  await chooseTabMenu(page, '연결 종료');
  await expect(pane().getByRole('button', { name: '재접속', exact: true })).toBeVisible();
  await pane().getByRole('button', { name: '재접속', exact: true }).click();
  await connected();
  stage = 'network interruption';
  docker(['pause', probe('CONTAINER')]);
  paused = true;
  await expect(pane().getByRole('button', { name: '재접속', exact: true })).toBeVisible({
    timeout: 35000,
  });
  docker(['unpause', probe('CONTAINER')]);
  paused = false;
  await pane().getByRole('button', { name: '재접속', exact: true }).click();
  await connected();
  console.log('PASS native KeepAlive detects network silence / reconnect with stored credential');
  stage = 'restart';
  assert(await shutdown(), 'native shutdown required forced termination');
  let liveShells = [];
  for (let i = 0; i < 25; i++) {
    liveShells = docker(['exec', probe('CONTAINER'), 'ps', '-eo', 'user=,stat=,comm='])
      .trim()
      .split('\n')
      .filter((line) => /^probe\s+[^Z]\S*\s+-?bash$/.test(line.trim()));
    if (!liveShells.length) break;
    await sleep(200);
  }
  assert.equal(liveShells.length, 0, 'remote shell survived app exit');
  console.log('PASS native graceful shutdown / remote shells released');
  await launch();
  await expect(page.locator('.profile-card')).toHaveCount(1);
  await page.locator('.profile-target').dblclick();
  await connected();
  console.log('PASS native app restart / SQLite sessions / OS stored credential / double-click');
  stage = 'master vault migration and reveal';
  const { randomBytes } = await import('node:crypto');
  const master = randomBytes(32).toString('base64url');
  const replacementMaster = randomBytes(32).toString('base64url');
  await page.getByRole('button', { name: '설정', exact: true }).click();
  await page.getByRole('button', { name: '마스터 패스워드 · 암호 보관함' }).click();
  let vaultDialog = page.getByRole('dialog', { name: '마스터 패스워드', exact: true });
  await vaultDialog.getByLabel('새 마스터 패스워드', { exact: true }).fill(master);
  await vaultDialog.getByLabel('새 마스터 패스워드 확인', { exact: true }).fill(master);
  await vaultDialog.getByRole('button', { name: '마스터 패스워드 저장', exact: true }).click();
  await expect(
    vaultDialog.getByText('마스터 패스워드를 저장했습니다.', { exact: true }),
  ).toBeVisible(kdfWait);
  assert.equal((await invoke('vault_status')).enabled, true);
  await vaultDialog.getByRole('button', { name: '대화상자 닫기' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '대화상자 닫기' }).click();
  await showConnections();
  await chooseProfileMenu(page, page.locator('.profile-card'), '수정');
  await page.getByRole('dialog').locator('summary', { hasText: '고급 옵션' }).click();
  await page.getByRole('button', { name: '저장된 암호 보기', exact: true }).click();
  vaultDialog = page.getByRole('dialog').last();
  await vaultDialog
    .getByLabel('현재 마스터 패스워드', { exact: true })
    .fill('invalid-master-password');
  await vaultDialog.getByRole('button', { name: '확인 후 암호 표시' }).click();
  await expect(vaultDialog.getByRole('alert')).toContainText('일치하지 않거나', kdfWait);
  await sleep(1100);
  await vaultDialog.getByLabel('현재 마스터 패스워드', { exact: true }).fill(master);
  await vaultDialog.getByRole('button', { name: '확인 후 암호 표시' }).click();
  await expect(vaultDialog.getByLabel('저장된 암호', { exact: true })).toBeVisible(kdfWait);
  const revealed = await vaultDialog.getByLabel('저장된 암호', { exact: true }).inputValue();
  await vaultDialog.getByRole('button', { name: '암호 숨기기', exact: true }).click();
  assert(revealed === probe('PASSWORD'), 'master reveal roundtrip mismatch');
  assert.equal(await vaultDialog.getByLabel('저장된 암호', { exact: true }).inputValue(), '');
  await sleep(1100);
  await vaultDialog.getByLabel('현재 마스터 패스워드', { exact: true }).fill(master);
  await vaultDialog.getByRole('button', { name: '확인 후 암호 표시' }).click();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(vaultDialog.getByRole('button', { name: '확인 후 암호 표시' })).toBeEnabled(kdfWait);
  await expect(vaultDialog.getByLabel('저장된 암호', { exact: true })).not.toBeVisible();
  assert.equal(await vaultDialog.getByLabel('저장된 암호', { exact: true }).inputValue(), '');

  await vaultDialog.getByRole('button', { name: '대화상자 닫기' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
  await invoke('vault_lock');
  await chooseTabMenu(page, '연결 종료');
  await pane().getByRole('button', { name: '재접속', exact: true }).click();
  vaultDialog = page.getByRole('dialog', { name: '마스터 패스워드', exact: true });
  // vault.rs rejects a second verification within 1s; the path here takes only about 1.1s.
  await sleep(1100);
  await vaultDialog.getByLabel('현재 마스터 패스워드', { exact: true }).fill(master);
  await vaultDialog.getByRole('button', { name: '잠금 해제', exact: true }).click();
  await connected();
  await command("printf 'MASTER_UNLOCK_CONNECTION_OK\\n'");
  await output('MASTER_UNLOCK_CONNECTION_OK');
  await sleep(1100);
  await invoke('vault_action', {
    action: 'configure',
    password: master,
    newPassword: replacementMaster,
    profileId: null,
  });
  assert.equal((await invoke('vault_status')).unlocked, false);
  await sleep(1100);
  let oldRejected = false;
  try {
    await invoke('vault_action', {
      action: 'unlock',
      password: master,
      newPassword: null,
      profileId: null,
    });
  } catch {
    oldRejected = true;
  }
  assert(oldRejected, 'old master was accepted after change');
  assert(await shutdown());
  await launch();
  assert.equal((await invoke('vault_status')).unlocked, false);
  await page.locator('.profile-target').dblclick();
  vaultDialog = page.getByRole('dialog', { name: '마스터 패스워드', exact: true });
  await vaultDialog.getByLabel('현재 마스터 패스워드', { exact: true }).fill(replacementMaster);
  await vaultDialog.getByRole('button', { name: '잠금 해제', exact: true }).click();
  await connected();
  console.log(
    'PASS native master encryption migration, reauthenticated reveal/hide, wrong password, lock, change and restart reconnect',
  );
  stage = 'bad authentication';
  await chooseTabMenu(page, '연결 종료');
  await expect(pane().getByRole('button', { name: '재접속', exact: true })).toBeVisible();
  await showConnections();
  await chooseProfileMenu(page, page.locator('.profile-card'), '수정');
  await page
    .getByRole('dialog')
    .getByLabel('비밀번호', { exact: true })
    .fill('fixture-invalid-input');
  await page.getByRole('dialog').getByRole('button', { name: '저장 후 연결', exact: true }).click();
  await expect(pane().locator('.connection-message')).toContainText('인증이 거부');
  stage = 'CRUD and secret deletion';
  await page.getByLabel('세션 검색', { exact: true }).fill('missing');
  await expect(page.locator('.profile-card')).toHaveCount(0);
  await page.getByLabel('세션 검색', { exact: true }).fill('OpenSSH');
  await showConnections();
  await chooseProfileMenu(page, page.locator('.profile-card'), '복제');
  await expect(page.locator('.profile-card')).toHaveCount(2);
  const snapshot = await invoke('sessions');
  assert.equal(snapshot.profiles.filter((p) => p.hasSecret).length, 1);
  assert.equal(snapshot.groups.length, 1);
  const db = await readFile(path.join(directory, 'sessions.sqlite3'));
  assert(!db.includes(Buffer.from(probe('PASSWORD'))));
  for (const p of snapshot.profiles) await invoke('delete_session', { id: p.id });
  assert.equal((await invoke('sessions')).profiles.length, 0);
  console.log(
    'PASS native edit / search / duplicate without credential / delete / DB no plaintext',
  );
  stage = 'host key changed';
  // Same endpoint, a conflicting locally recorded key: the app must not offer trust override.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    path.join(directory, 'known_hosts'),
    `[127.0.0.1]:${probe('PORT')} ${probe('RSA_HOST_KEY')}\n`,
  );
  const p = await invoke('save_session', {
    profile: { ...snapshot.profiles[0], id: '', hasSecret: false },
    secretAction: 'keep',
    secret: null,
  });
  await page.reload();
  await page.locator('.profile-target').dblclick();
  await page.getByRole('dialog').getByLabel('비밀번호', { exact: true }).fill(probe('PASSWORD'));
  await page.getByRole('dialog').getByRole('button', { name: '연결', exact: true }).click();
  await expect(pane().locator('.connection-message')).toContainText('호스트키가 변경');
  assert.equal(await page.locator('.trust-card').count(), 0);
  await invoke('delete_session', { id: p.id });
  console.log('PASS native changed-host-key blocks connection with no override button');
  console.log(
    process.env.DACHSTERM_UI_REGRESSION_ONLY === '1'
      ? 'PASS Windows UI/native regression (S1 extension explicitly omitted)'
      : 'PASS all Phase 1 Windows native integration checks',
  );
} catch (error) {
  if (error === finishedEarly) console.log('PASS agent terminal checks only');
  else await reportFailure(error);
} finally {
  if (paused) docker(['unpause', probe('CONTAINER')]);
  if (page) {
    try {
      for (const p of (await invoke('sessions')).profiles)
        await invoke('delete_session', { id: p.id });
    } catch {
      /* OS entries remain discoverable through the isolated DB if cleanup failed. */
    }
  }
  await shutdown();
  // Only the temporary directory created above can be removed.
  if (
    path.dirname(directory) === path.resolve(tmpdir()) &&
    path.basename(directory).startsWith('dachsterm-native-')
  ) {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  } else {
    console.error('unsafe test cleanup path');
    process.exitCode = 1;
  }
}
async function reportFailure(error) {
  if (
    stage === 'launch' ||
    stage === 'detached window ownership' ||
    stage.startsWith('five tabs') ||
    stage.startsWith('split layout') ||
    stage.startsWith('file ') ||
    stage.startsWith('AT.') ||
    stage.startsWith('DX.4') ||
    stage.startsWith('external editor') ||
    stage === 'selective multi input' ||
    stage === 'embedded games preserve SSH'
  )
    console.error(String(error.message));
  else
    console.error(
      `${error.name}: ${String(error.message).match(/locator\.[a-zA-Z]+/)?.[0] ?? 'assertion or operation'} failed`,
    );
  console.error(`FAIL native integration stage: ${stage} (details redacted)`);
  // File and line only: helper frames alone do not identify the failing step.
  console.error(
    String(error.stack)
      .match(/test-native\.mjs:\d+:\d+/g)
      ?.join(' <- ') ?? 'native assertion',
  );
  // Alerts and connection status are app-authored strings, never entered credentials.
  if (page)
    console.error(
      'UI states:',
      await page
        .locator('[role=alert], .connection-message')
        .allTextContents()
        .catch(() => []),
    );
  if (stage.startsWith('U3'))
    console.error(String(error.stack).match(/verify-tunnels\.mjs:\d+:\d+/)?.[0] ?? 'U3 failure');
  if (stage.startsWith('AT') || stage.startsWith('DX'))
    console.error(
      String(error.stack).match(/verify-agent-terminal\.mjs:\d+:\d+/)?.[0] ?? 'agent failure',
    );
  if (stage.startsWith('S1'))
    console.error(
      String(error.stack).match(/verify-terminal-basics\.mjs:\d+:\d+/)?.[0] ?? 'S1 failure',
    );
  process.exitCode = 1;
  // A failure may occur while the master-password reveal is visible. Never capture
  // arbitrary failure UI; only known non-authentication stages are eligible.
  if (
    page &&
    (stage.startsWith('S1 terminal') ||
      stage === 'launch' ||
      stage === 'detached window ownership' ||
      stage === 'legacy terminal encoding' ||
      stage.startsWith('split layout') ||
      stage.startsWith('file ') ||
      stage === 'selective multi input' ||
      stage.startsWith('AT.'))
  )
    await page.screenshot({ path: path.join(screenshots, 'failure.png') }).catch(() => {});
}
