import { chromium } from '@playwright/test';
import { build } from 'vite';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
if (process.platform !== 'win32') throw Error('Windows WebView2 required');
const bundle = await build({
  configFile: false,
  logLevel: 'warn',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    write: false,
    lib: {
      entry: 'tests/native/survivor-performance.ts',
      formats: ['iife'],
      name: 'SurvivorPerformance',
    },
  },
});
const code = (Array.isArray(bundle) ? bundle : [bundle])
  .flatMap((r) => r.output)
  .find((o) => o.type === 'chunk').code;
const binary = process.env.DACHSTERM_TEST_BINARY ?? path.resolve('target/debug/dachsterm.exe');
const evidenceDirectory = process.env.DACHSTERM_VERIFICATION_DIR ?? 'target/verification';
const seconds = process.argv.includes('--smoke') ? 2 : 60;
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-survivor-perf-'));
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
  if (!endpoint) throw Error('WebView endpoint unavailable');
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
  if (!page) throw Error('App page unavailable');
  await page.evaluate(code);
  const styles = (Array.isArray(bundle) ? bundle : [bundle])
    .flatMap((r) => r.output)
    .filter((o) => o.type === 'asset' && o.fileName.endsWith('.css'))
    .map((o) => o.source)
    .join('\n');
  if (styles) await page.addStyleTag({ content: styles });
  await page.bringToFront();
  const session = await page.context().newCDPSession(page);
  await session.send('HeapProfiler.collectGarbage');
  const heap = async () => {
    await session.send('HeapProfiler.collectGarbage');
    return (await session.send('Runtime.getHeapUsage')).usedSize;
  };
  const result = {
    binary,
    sha256: createHash('sha256')
      .update(await readFile(binary))
      .digest('hex'),
    runtime: await page.evaluate(() => navigator.userAgent),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    ramBytes: totalmem(),
    load: await page.evaluate(
      (seconds) => globalThis.SurvivorPerformance.measure(seconds),
      seconds,
    ),
    fullUi: await page.evaluate(
      (seconds) => globalThis.SurvivorPerformance.measureUi(seconds),
      seconds,
    ),
    heaps: [],
  };
  console.log(JSON.stringify(result.load));
  console.log(JSON.stringify(result.fullUi));
  for (let i = 0; i < 11; i++) {
    const counts = await page.evaluate((i) => globalThis.SurvivorPerformance.churn(i + 1), i);
    result.heaps.push({ round: i, usedBytes: await heap(), counts });
  }
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    path.join(
      evidenceDirectory,
      `survivor-performance-native${seconds === 2 ? '-smoke' : ''}.json`,
    ),
    JSON.stringify(result, null, 2),
  );
  console.log(
    JSON.stringify({
      heaps: result.heaps,
      p95Passed: result.load.p95 <= 16.7 && result.fullUi.p95 <= 16.7,
    }),
  );
  if (result.load.p95 > 16.7 || result.fullUi.p95 > 16.7) process.exitCode = 1;
} finally {
  await browser?.close();
  if (app.pid && app.exitCode === null)
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
}
