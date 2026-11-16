// How fast xterm draws large output with the app's terminal options and its ACK pattern (one
// 32KiB frame at a time; the next frame is sent only after xterm's write callback), with the
// DOM renderer the app uses and with the WebGL addon. Chromium stands in for WebView2 and
// WebKit for WKWebView; neither is the app itself, and Tauri's IPC hop is not included.
// The WebGL addon is not an app dependency: it is installed into a temporary folder here.
// Usage: node scripts/measure-terminal-render.mjs [--mib 32] [--headed]
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, webkit } from '@playwright/test';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? fallback : process.argv[i + 1];
};
const mib = Number(arg('mib', '32'));
const headed = process.argv.includes('--headed');
const addonDir = mkdtempSync(path.join(tmpdir(), 'dachsterm-webgl-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const install = spawnSync(
  npm,
  ['install', '--ignore-scripts', '--no-save', '--prefix', addonDir, '@xterm/addon-webgl@0.19.0'],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);
if (install.status !== 0) throw new Error('could not install @xterm/addon-webgl');
const files = {
  '/xterm.mjs': ['node_modules/@xterm/xterm/lib/xterm.mjs', 'text/javascript'],
  '/xterm.css': ['node_modules/@xterm/xterm/css/xterm.css', 'text/css'],
  '/webgl.mjs': [
    path.join(addonDir, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs'),
    'text/javascript',
  ],
};
const page = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/xterm.css">
<style>html,body{margin:0;height:100%;background:#1e1e1e}#t{height:100%}</style><div id="t"></div>
<script type="module">
import { Terminal } from '/xterm.mjs';
import { WebglAddon } from '/webgl.mjs';
// Output like the endurance probe's: an ls -l line with colour and Korean, and a plain log line.
const line = 'drwxr-xr-x  2 probe probe  4096 Nov 16 12:00 \\x1b[1;34m한글 폴더 directory-name-0123456789\\x1b[0m\\r\\n'
  + '2026-11-16T12:00:00.000Z INFO worker[42] request served in 12ms path=/api/v1/items?page=7\\r\\n';
window.measure = async ({ renderer, screenReaderMode, mib }) => {
  const t = new Terminal({ fontSize: 14, scrollback: 5000, cursorBlink: true, screenReaderMode,
    fontFamily: 'Menlo, Consolas, monospace' });
  t.open(document.getElementById('t'));
  let gl = null;
  if (renderer === 'webgl') {
    const addon = new WebglAddon();
    t.loadAddon(addon);
    const c = document.createElement('canvas').getContext('webgl2');
    const info = c && c.getExtension('WEBGL_debug_renderer_info');
    gl = info ? c.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown';
  }
  const enc = new TextEncoder();
  // Frames of about 32KiB of UTF-8, as the backend sends them.
  let frame = '';
  while (enc.encode(frame).length < 32768 - 256) frame += line;
  const frameBytes = enc.encode(frame).length;
  const frames = Math.ceil((mib * 1048576) / frameBytes);
  // Main-thread responsiveness while drawing: gaps between animation frames.
  let last = performance.now(), maxGap = 0, paints = 0, running = true;
  const tick = (now) => { maxGap = Math.max(maxGap, now - last); last = now; paints++; if (running) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const hop = new MessageChannel();
  const started = performance.now();
  const perFrame = [];
  await new Promise((resolve) => {
    let n = 0;
    const next = () => {
      if (n++ === frames) return resolve();
      const s = performance.now();
      // The ACK goes back over IPC; a message hop stands in for it.
      t.write(frame, () => { perFrame.push(performance.now() - s); hop.port2.postMessage(0); });
    };
    hop.port1.onmessage = next;
    next();
  });
  const seconds = (performance.now() - started) / 1000;
  running = false;
  perFrame.sort((a, b) => a - b);
  const q = (p) => perFrame[Math.min(perFrame.length - 1, Math.floor(perFrame.length * p))];
  t.dispose();
  return { renderer, screenReaderMode, gl, frames, frameBytes, seconds,
    mibPerSecond: (frames * frameBytes) / 1048576 / seconds,
    frameMs: { p50: q(0.5), p95: q(0.95), max: perFrame.at(-1) },
    paints, maxPaintGapMs: maxGap };
};
window.ready = true;
</script>`;
const server = createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  const f = files[req.url];
  if (!f) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': f[1] });
  res.end(readFileSync(f[0]));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;
const results = [];
try {
  for (const [engine, type, options] of [
    ['chromium', chromium, { args: ['--enable-gpu', '--ignore-gpu-blocklist'] }],
    ['webkit', webkit, {}],
  ]) {
    const browser = await type.launch({ headless: !headed, ...options });
    for (const renderer of ['dom', 'webgl']) {
      for (const screenReaderMode of [true, false]) {
        // A fresh page per case, so one renderer's leftovers cannot slow the next.
        const p = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await p.goto(url);
        await p.waitForFunction(() => window.ready === true);
        const r = await p.evaluate((o) => window.measure(o), { renderer, screenReaderMode, mib });
        r.engine = engine;
        r.version = browser.version();
        results.push(r);
        console.log(
          `${engine} ${renderer} screenReader=${screenReaderMode}: ${r.mibPerSecond.toFixed(1)}MiB/s, frame p50 ${r.frameMs.p50.toFixed(1)}ms p95 ${r.frameMs.p95.toFixed(1)}ms, max paint gap ${r.maxPaintGapMs.toFixed(0)}ms${r.gl ? `, GL ${r.gl}` : ''}`,
        );
        await p.close();
      }
    }
    await browser.close();
  }
} finally {
  server.close();
  rmSync(addonDir, { recursive: true, force: true });
}
mkdirSync('target/verification', { recursive: true });
writeFileSync(
  'target/verification/terminal-render.json',
  JSON.stringify({ mib, headed, platform: process.platform, arch: process.arch, results }, null, 2),
);
