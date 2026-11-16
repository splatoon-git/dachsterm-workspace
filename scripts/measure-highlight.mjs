// What highlight rules cost while a terminal draws output (CG.7). Runs the app's own terminal pane
// (tests/ui/fixtures/terminal-pane) in Chromium (WebView2's engine) and WebKit (WKWebView's) with
// the ACK pattern: one 32KiB frame at a time, the next only after xterm's write callback.
// - burst: as fast as frames are drawn. Above 4MiB/s highlighting pauses, so this shows the pause.
// - paced: frames at a fixed rate under the pause line, so every line is matched. Reports the
//   frame latency (write to callback) and how far matching lags behind.
// Neither engine is the app itself, and Tauri's IPC hop is not included.
// Usage: node scripts/measure-highlight.mjs [--mib 32] [--paced-mib 3] [--seconds 5]
import { spawn } from 'node:child_process';
import { chromium, webkit } from '@playwright/test';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return Number(i < 0 ? fallback : process.argv[i + 1]);
};
const mib = arg('mib', 32);
const pacedMib = arg('paced-mib', 3);
const seconds = arg('seconds', 5);
const base = 'http://127.0.0.1:1420';

/** Ten rules of the kinds people add: words, levels, addresses, numbers with units. */
const rules = [
  ['error', '\\b(error|fail(ed|ure)?|fatal)\\b', 'danger'],
  ['warn', '\\bwarn(ing)?\\b', 'warning'],
  ['ok', '\\b(ok|success|passed)\\b', 'success'],
  ['ipv4', '\\b\\d{1,3}(\\.\\d{1,3}){3}\\b', 'info'],
  ['ms', '\\b\\d+ms\\b', 'accent'],
  ['http', 'https?://\\S+', 'info'],
  ['path', '(/[\\w.-]+){2,}', 'accent'],
  ['iso', '\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z', 'info'],
  ['worker', 'worker\\[\\d+\\]', 'success'],
  ['korean', '한글', 'warning'],
].map(([id, pattern, color]) => ({
  id,
  name: id,
  pattern,
  ignoreCase: true,
  scope: { kind: 'all' },
  color,
  notify: false,
  send: null,
  enabled: true,
}));

async function serverUp() {
  try {
    return (await fetch(base)).ok;
  } catch {
    return false;
  }
}

let server = null;
if (!(await serverUp())) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  server = spawn(npm, ['run', 'dev'], { stdio: 'ignore', shell: process.platform === 'win32' });
  for (let i = 0; i < 120 && !(await serverUp()); i++) await new Promise((r) => setTimeout(r, 500));
}

async function measure(browserType, highlight) {
  const browser = await browserType.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/tests/ui/fixtures/terminal-pane.html`);
  await page.locator('.xterm-rows').waitFor();
  const result = await page.evaluate(
    async ({ rules, highlight, mib, pacedMib, seconds }) => {
      const pane = window.__terminalPane;
      pane.highlight(highlight ? rules : []);
      const { session } = pane;
      const line =
        'drwxr-xr-x  2 probe probe  4096 Nov 16 12:00 \x1b[1;34m한글 폴더 directory-name-0123456789\x1b[0m\r\n' +
        '2026-11-16T12:00:00.000Z INFO worker[42] request served in 12ms path=/api/v1/items?page=7 from 10.0.0.12 error=none\r\n';
      const enc = new TextEncoder();
      let frame = '';
      while (enc.encode(frame).length < 32768 - 256) frame += line;
      const bytes = enc.encode(frame).length;
      const write = () =>
        new Promise((done) => {
          session.highlighter.output(bytes);
          session.terminal.write(frame, done);
        });
      let paused = false;
      const stop = session.subscribe(() => {
        if (session.snapshot().highlightPaused) paused = true;
      });
      const frames = Math.ceil((mib * 1024 * 1024) / bytes);
      let start = performance.now();
      for (let i = 0; i < frames; i++) await write();
      const burst = (frames * bytes) / 1024 / 1024 / ((performance.now() - start) / 1000);
      const burstPaused = paused;
      // Let the pause end before pacing.
      await new Promise((r) => setTimeout(r, 1500));
      paused = false;
      const interval = (bytes / (pacedMib * 1024 * 1024)) * 1000;
      const latencies = [];
      start = performance.now();
      for (let i = 0; performance.now() - start < seconds * 1000; i++) {
        const due = start + i * interval;
        const wait = due - performance.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const t = performance.now();
        await write();
        latencies.push(performance.now() - t);
      }
      const achieved =
        (latencies.length * bytes) / 1024 / 1024 / ((performance.now() - start) / 1000);
      // Matching runs after the frame is drawn; wait for the last batch to land.
      const drained = performance.now();
      const row = () => session.terminal.buffer.active;
      const decorated = () => document.querySelectorAll('.xterm-rows span[style*="color"]').length;
      let before = -1;
      while (performance.now() - drained < 3000 && decorated() !== before) {
        before = decorated();
        await new Promise((r) => setTimeout(r, 100));
      }
      stop();
      latencies.sort((a, b) => a - b);
      return {
        burst: burst.toFixed(1),
        burstPaused,
        paced: achieved.toFixed(2),
        pacedPaused: paused,
        p50: latencies[Math.floor(latencies.length * 0.5)].toFixed(1),
        p95: latencies[Math.floor(latencies.length * 0.95)].toFixed(1),
        coloredSpans: decorated(),
        rows: row().length,
      };
    },
    { rules, highlight, mib, pacedMib, seconds },
  );
  await browser.close();
  return result;
}

try {
  console.log(`burst ${mib}MiB, paced ${pacedMib}MiB/s for ${seconds}s, 32KiB frames`);
  for (const [name, type] of [
    ['chromium', chromium],
    ['webkit', webkit],
  ]) {
    for (const highlight of [false, true]) {
      const r = await measure(type, highlight);
      console.log(
        `${name.padEnd(8)} rules=${highlight ? 10 : 0}  burst ${r.burst} MiB/s (paused ${r.burstPaused})` +
          `  paced ${r.paced} MiB/s (paused ${r.pacedPaused}) frame p50 ${r.p50}ms p95 ${r.p95}ms` +
          `  colored spans on screen ${r.coloredSpans}`,
      );
    }
  }
} finally {
  server?.kill();
}
