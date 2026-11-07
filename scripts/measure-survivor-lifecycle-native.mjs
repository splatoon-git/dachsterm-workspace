// A single page-side driver avoids per-locator CDP allocation in the measured lifecycle.
import { chromium } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { openGame } from './native-workspace.mjs';
const binary = process.env.DACHSTERM_TEST_BINARY ?? path.resolve('target/debug/dachsterm.exe');
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-survivor-memory-'));
const server = net.createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
await new Promise((r) => server.close(r));
const app = spawn(binary, [], {
  stdio: 'ignore',
  windowsHide: true,
  env: {
    ...process.env,
    DACHSTERM_TEST_DATA_DIR: directory,
    DACHSTERM_TEST_CDP_PORT: String(port),
    WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview'),
  },
});
let browser;
try {
  let endpoint;
  for (let i = 0; i < 100; i++) {
    try {
      endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!endpoint) throw Error('Native endpoint unavailable');
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  let page;
  for (let i = 0; i < 80; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('tauri.localhost'));
    if (page) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) throw Error('Native page unavailable');
  await openGame(page, '닥스의 서바이버');
  await page.getByRole('button', { name: '새 도전 시작', exact: true }).waitFor();
  await page.getByRole('button', { name: '닥스의 서바이버 탭 닫기', exact: true }).click();
  await page.evaluate(() => {
    window.memoryRound = async (count) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const button = (text) =>
        Array.from(
          document.querySelectorAll('.survivor-game button,.toolbar-menu-items button'),
        ).find((e) => e.textContent.trim() === text && !e.disabled);
      const wait = async (fn) => {
        for (let i = 0; i < 200; i++) {
          const v = fn();
          if (v) return v;
          await sleep(25);
        }
        throw Error('Lifecycle UI timeout');
      };
      for (let i = 0; i < count; i++) {
        (await wait(() => button('닥스의 서바이버'))).click();
        (await wait(() => button('새 도전 시작'))).click();
        await wait(() => document.querySelector('.survivor-game[data-phase=playing]'));
        // Observe real RAF for a short round; no engine/source/clock hooks.
        await sleep(200);
        const field = document.querySelector('.survivor-game canvas');
        field.focus();
        field.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { key: 'p', bubbles: true }));
        await wait(() => document.querySelector('.survivor-game[data-phase=paused]'));
        document.querySelector('[aria-label="닥스의 서바이버 탭 닫기"]').click();
        await wait(() => !document.querySelector('.survivor-game'));
        await sleep(25);
      }
    };
  });
  const cdp = await page.context().newCDPSession(page);
  const samples = [];
  const summaries = [];
  const summarizeHeap = async () => {
    const chunks = [];
    const listener = ({ chunk }) => chunks.push(chunk);
    cdp.on('HeapProfiler.addHeapSnapshotChunk', listener);
    try {
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      const dump = JSON.parse(chunks.join(''));
      const fields = dump.snapshot.meta.node_fields,
        stride = fields.length;
      const types = dump.snapshot.meta.node_types[fields.indexOf('type')];
      const groups = {};
      for (let i = 0; i < dump.nodes.length; i += stride) {
        const type = types[dump.nodes[i + fields.indexOf('type')]];
        // Only constructor/type labels, never string contents or raw snapshot data.
        const name = ['object', 'closure', 'native'].includes(type)
          ? dump.strings[dump.nodes[i + fields.indexOf('name')]]
          : '';
        const key = `${type}:${name}`;
        const g = (groups[key] ??= { count: 0, bytes: 0 });
        g.count++;
        g.bytes += dump.nodes[i + fields.indexOf('self_size')];
      }
      return groups;
    } finally {
      cdp.off('HeapProfiler.addHeapSnapshotChunk', listener);
    }
  };
  const sample = async (round) => {
    await page.waitForTimeout(100);
    await cdp.send('HeapProfiler.collectGarbage');
    samples.push({
      round,
      heap: await cdp.send('Runtime.getHeapUsage'),
      dom: await cdp.send('Memory.getDOMCounters'),
    });
  };
  // Warm ten short full lifecycles, then observe six additional blocks of ten.
  for (let i = 0; i < 7; i++) {
    await page.evaluate(() => window.memoryRound(10));
    await sample((i + 1) * 10);
    if (i === 0 || i === 6) summaries.push(await summarizeHeap());
  }
  const heapChanges = Object.entries(summaries[1])
    .map(([name, value]) => ({
      name,
      count: value.count - (summaries[0][name]?.count ?? 0),
      bytes: value.bytes - (summaries[0][name]?.bytes ?? 0),
    }))
    .filter((v) => v.count > 0 || v.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 25);
  const result = {
    binary,
    sha256: createHash('sha256')
      .update(await readFile(binary))
      .digest('hex'),
    method:
      '70 short real UI mount/start/pause/settle/unmount cycles, first 10 warmup; one page-side event driver; post-GC samples',
    samples,
    heapChanges,
  };
  await mkdir('target/verification', { recursive: true });
  await writeFile(
    'target/verification/survivor-lifecycle-native.json',
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  await page
    .evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }))
    .catch(() => {});
} finally {
  await browser?.close();
  if (app.pid && app.exitCode === null)
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
}
