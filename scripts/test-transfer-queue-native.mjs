// Real Windows WebView2 + temporary FTPS. Never log UI errors containing secrets.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, open, readFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { openNewConnectionForm } from './native-workspace.mjs';
const root = await mkdtemp(path.join(tmpdir(), 'dachsterm-queue-native-'));
const evidence = path.resolve('target/verification/transfer-queue-native');
await mkdir(evidence, { recursive: true });
const binary = process.env.DACHSTERM_TEST_BINARY ?? path.resolve('target/debug/dachsterm.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app,
  browser,
  page,
  stage = 'launch';
const errors = [];
let stderr = '';
const invoke = (command, args = {}) =>
  page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), {
    command,
    args,
  });
async function hash(file) {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}
async function launch() {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  app = spawn(binary, [], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      DACHSTERM_TEST_DATA_DIR: root,
      DACHSTERM_TEST_CDP_PORT: String(port),
      WEBVIEW2_USER_DATA_FOLDER: path.join(root, 'webview'),
    },
  });
  app.stderr.on('data', (data) => {
    stderr = (stderr + data.toString()).slice(-4000);
  });
  let endpoint;
  for (let i = 0; i < 100; i++) {
    try {
      endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await sleep(200);
    }
  }
  if (!endpoint) throw new Error('CDP unavailable');
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  for (let i = 0; i < 60; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('tauri.localhost'));
    if (page) break;
    await sleep(100);
  }
  if (!page) throw new Error('app page unavailable');
  page.on('pageerror', () => errors.push('pageerror'));
  page.on('crash', () => errors.push('renderer-crash'));
  page.setDefaultTimeout(20000);
  await expect(page.getByRole('heading', { name: '서버 작업의 편안한 시작' })).toBeVisible();
}
async function stop(force = false) {
  if (app?.pid && app.exitCode === null) {
    spawnSync('taskkill', [...(force ? ['/F', '/T'] : []), '/PID', String(app.pid)], {
      windowsHide: true,
      stdio: 'ignore',
    });
    for (let i = 0; i < 60 && app.exitCode === null; i++) await sleep(100);
    if (app.exitCode === null) throw new Error('test process did not exit');
  }
  await browser?.close().catch(() => {});
  browser = undefined;
  page = undefined;
}
try {
  await launch();
  stage = 'create FTPS profile';
  await openNewConnectionForm(page);
  const form = page.getByRole('dialog');
  await form.getByLabel('이름', { exact: true }).fill('Queue native fixture');
  await form.getByLabel('프로토콜').selectOption('ftps');
  await form.getByLabel('호스트', { exact: true }).fill('127.0.0.1');
  await form.getByLabel('포트', { exact: true }).fill(process.env.DACHSTERM_FTPS_PORT);
  await form.getByLabel('사용자', { exact: true }).fill('fixture');
  await form.getByLabel('비밀번호', { exact: true }).fill(process.env.DACHSTERM_FTP_PASSWORD);
  await form.getByLabel('인증정보 보관', { exact: true }).selectOption('forget');
  await form.locator('summary', { hasText: '고급 옵션' }).click();
  await form.getByLabel('추가 CA 인증서 경로 (선택)').fill(process.env.DACHSTERM_FTP_CA);
  await form.getByRole('button', { name: '저장 후 연결', exact: true }).click();
  let pane = page.locator('.pane-cell:not([hidden]) .ftp-pane');
  await expect(pane.getByRole('status')).toContainText('연결됨');
  let connection = await pane.getAttribute('data-connection-id');
  const source = path.join(root, '한글 큐');
  await mkdir(path.join(source, '중첩', '빈 폴더'), { recursive: true });
  await writeFile(path.join(source, '00-completed.txt'), 'completed item survives restart');
  await writeFile(path.join(source, '중첩', '한글 파일.txt'), '원본 내용\n');
  const large = await open(path.join(source, '01-large.bin'), 'w');
  await large.truncate(256 * 1024 * 1024);
  await large.close();
  stage = 'queue drop IPC and active crash';
  const [job] = await invoke('transfer_batch', {
    id: connection,
    path: '/',
    mode: 'drop',
    paths: [source],
    conflict: 'skip',
  });
  await expect
    .poll(async () => (await invoke('transfer_list')).find((t) => t.id === job)?.done, {
      timeout: 60000,
      intervals: [10],
    })
    .toBeGreaterThan(1024 * 1024);
  const completedBefore = (await invoke('transfer_items', { id: job, offset: 0 })).filter(
    (n) => n.status === 'completed',
  );
  assert(completedBefore.some((n) => n.name.endsWith('00-completed.txt')));
  const originalListing = await invoke('sftp_list', { id: connection, path: '/한글 큐' });
  const originalTime = originalListing.entries.find((e) => e.name === '00-completed.txt').modified;
  await stop(true);
  stage = 'restart remains paused';
  await launch();
  const recovered = (await invoke('transfer_list')).find((t) => t.id === job);
  assert.equal(recovered.status, 'paused');
  const before = recovered.done;
  await sleep(1200);
  assert.equal((await invoke('transfer_list')).find((t) => t.id === job).done, before);
  await page.locator('.profile-target').filter({ hasText: 'Queue native fixture' }).dblclick();
  const auth = page.getByRole('dialog', { name: 'Queue native fixture 인증' });
  await auth.getByLabel('비밀번호', { exact: true }).fill(process.env.DACHSTERM_FTP_PASSWORD);
  await auth.getByRole('button', { name: '연결', exact: true }).click();
  pane = page.locator('.pane-cell:not([hidden]) .ftp-pane');
  await expect(pane.getByRole('status')).toContainText('연결됨');
  const nextConnection = await pane.getAttribute('data-connection-id');
  assert.notEqual(nextConnection, connection);
  connection = nextConnection;
  stage = 'explicit UI resume';
  await page.screenshot({ path: path.join(evidence, 'before-resume.png') });
  const resumeButton = pane.getByRole('button', { name: '확인 후 이어서 보내기' });
  await resumeButton.focus();
  await page.keyboard.press('Enter');
  stage = 'await resumed queue completion';
  await expect
    .poll(async () => (await invoke('transfer_list')).find((t) => t.id === job)?.status, {
      timeout: 180000,
    })
    .toBe('completed');
  const finalListing = await invoke('sftp_list', { id: connection, path: '/한글 큐' });
  stage = 'verify completed bytes and files';
  assert.equal(
    finalListing.entries.find((e) => e.name === '00-completed.txt').modified,
    originalTime,
  );
  const remoteHome = path.join(process.env.DACHSTERM_FTP_ROOT, 'home', '한글 큐');
  assert.equal(
    await hash(path.join(source, '01-large.bin')),
    await hash(path.join(remoteHome, '01-large.bin')),
  );
  assert.equal(
    await readFile(path.join(remoteHome, '중첩', '한글 파일.txt'), 'utf8'),
    '원본 내용\n',
  );
  const result = (await invoke('transfer_list')).find((t) => t.id === job);
  assert.equal(result.finished, 6);
  await pane.getByRole('button', { name: /전송 작업$/ }).click();
  await page.getByRole('menuitem', { name: '파일별 결과' }).click();
  stage = 'verify native results view';
  await expect(pane.getByRole('button', { name: '다음 결과' })).toBeDisabled();
  await page.screenshot({ path: path.join(evidence, 'queue.png') });
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(evidence, 'result.json'),
    JSON.stringify(
      {
        binarySha256: await hash(binary),
        protocol: 'ftps',
        activeCrashRecoveredPaused: true,
        newConnectionRequired: true,
        explicitUiResume: true,
        completedItemTimestampUnchanged: true,
        exact256MiB: true,
        finished: result.finished,
        pageErrors: errors.length,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS native queue real FTPS folder, 256MiB active process crash/relaunch, explicit UI resume, completed-file preservation and exact bytes',
  );
} catch (error) {
  console.error(
    `FAIL queue native stage=${stage} type=${error.name} exit=${app?.exitCode} (details redacted)`,
  );
  if (stage === 'explicit UI resume' || stage === 'await resumed queue completion')
    console.error(String(error.message).slice(0, 1500));
  if (page && !stage.includes('profile'))
    await page
      .screenshot({
        path: path.join(evidence, 'failure.png'),
        mask: [page.locator('input[type=password]')],
      })
      .catch(() => {});
  console.error('runtime context panic:', stderr.includes('there is no reactor running'));
  process.exitCode = 1;
} finally {
  if (page) {
    try {
      for (const p of (await invoke('sessions')).profiles)
        await invoke('delete_session', { id: p.id });
    } catch {
      /* No secrets are logged. */
    }
  }
  await stop(true);
  const absolute = path.resolve(root);
  if (
    path.dirname(absolute) !== path.resolve(tmpdir()) ||
    !path.basename(absolute).startsWith('dachsterm-queue-native-')
  ) {
    console.error('unsafe fixture cleanup');
    process.exitCode = 1;
  } else await rm(absolute, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
