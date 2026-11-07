// Wall-clock keyboard play of the built product. Observes only DOM and rendered pixels.
// No engine imports/state edits, seed overrides, clock acceleration or profile grants.
// This automated pilot does not certify human enjoyment or substitute for manual play.
import { chromium, expect } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { openGame } from './native-workspace.mjs';
const binary = process.env.DACHSTERM_TEST_BINARY ?? path.resolve('target/debug/dachsterm.exe');
const directory = await mkdtemp(path.join(tmpdir(), 'dachsterm-survivor-play-'));
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
const runs = [];
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
  await mkdir('target/verification', { recursive: true });
  const names = [
    '왕와앙',
    '황금 뼈다귀',
    '사자후',
    '뼈다귀 부메랑',
    '수호 공',
    '멍멍 파동',
    '빠른 꼬리',
    '와앙 물기',
    '날카로운 이빨',
    '튼튼한 심장',
    '복슬복슬 털',
    '예민한 코',
    '똑똑한 닥스',
    '빠른 발',
    '행운의 발바닥',
  ];
  for (let trial = 0; trial < 2; trial++) {
    await page.getByRole('button', { name: '새 도전 시작', exact: true }).click();
    const report = { trial, seed: null, stages: [], choices: [], end: null },
      held = new Set();
    const begin = Date.now();
    let previous = '',
      lastReport = 0;
    async function keys(next) {
      for (const key of held)
        if (!next.includes(key)) {
          await page.keyboard.up(key);
          held.delete(key);
        }
      for (const key of next)
        if (!held.has(key)) {
          await page.keyboard.down(key);
          held.add(key);
        }
    }
    while (Date.now() - begin < 20 * 60 * 1000) {
      const o = await page.evaluate(() => {
        const root = document.querySelector('.survivor-game'),
          c = root?.querySelector('canvas');
        const phase = root?.getAttribute('data-phase'),
          hud = root?.querySelector('.survivor-hud')?.textContent;
        const profile = JSON.parse(localStorage.getItem('dachsterm.games.survivor.v1'));
        const base = {
          phase,
          hud,
          tick: Number(c?.getAttribute('data-tick')),
          seed: profile?.checkpoint?.seed,
          stage: Number(hud?.match(/스테이지 (\d+)/)?.[1]),
          hp: Number(document.querySelector('#survivor-hp')?.getAttribute('value')),
          cards: Array.from(document.querySelectorAll('.survivor-card strong')).map(
            (e) => e.textContent,
          ),
        };
        if (phase !== 'playing' || !c) return base;
        const p = { x: Number(c.getAttribute('data-x')), y: Number(c.getAttribute('data-y')) };
        const cam = {
          x: Math.max(0, Math.min(2240, p.x - 480)),
          y: Math.max(0, Math.min(2660, p.y - 270)),
        };
        const px = p.x - cam.x,
          py = p.y - cam.y;
        const ctx = c.getContext('2d'),
          data = ctx.getImageData(0, 0, c.width, c.height).data;
        const scale = c.width / 960,
          step = 4,
          w = 240,
          h = 135,
          mask = new Uint8Array(w * h);
        const colors = [0x468150, 0xb54137, 0x87600d, 0x80519c, 0x58626c, 0x2e807e];
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const i =
              (Math.min(c.height - 1, Math.floor(y * step * scale)) * c.width +
                Math.min(c.width - 1, Math.floor(x * step * scale))) *
              4;
            const color = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
            const k = colors.indexOf(color);
            if (k >= 0) mask[y * w + x] = k + 1;
          }
        const enemies = [],
          loot = [];
        for (let i = 0; i < mask.length; i++) {
          const k = mask[i];
          if (!k) continue;
          mask[i] = 0;
          const stack = [i];
          let count = 0,
            sx = 0,
            sy = 0;
          while (stack.length) {
            const v = stack.pop(),
              x = v % w,
              y = Math.floor(v / w);
            count++;
            sx += x * step;
            sy += y * step;
            for (const n of [
              x > 0 ? v - 1 : -1,
              x < w - 1 ? v + 1 : -1,
              y > 0 ? v - w : -1,
              y < h - 1 ? v + w : -1,
            ])
              if (n >= 0 && mask[n] === k) {
                mask[n] = 0;
                stack.push(n);
              }
          }
          const item = {
            x: sx / count,
            y: sy / count,
            r: Math.sqrt((count * step * step) / Math.PI),
          };
          if (k === 6 && count >= 1 && count < 15) loot.push(item);
          else if (k === 3 && count >= 2 && count < 18) loot.push(item);
          else if ((k === 1 && count >= 22) || (k > 1 && k < 6 && count >= 5)) enemies.push(item);
        }
        const target = loot.sort(
          (a, b) => Math.hypot(a.x - px, a.y - py) - Math.hypot(b.x - px, b.y - py),
        )[0];
        let best = { x: 0, y: 0 },
          bs = -Infinity;
        for (let y = -1; y <= 1; y++)
          for (let x = -1; x <= 1; x++) {
            const len = Math.hypot(x, y) || 1,
              nx = px + (x / len) * 60,
              ny = py + (y / len) * 60;
            let score = target ? -Math.hypot(target.x - nx, target.y - ny) * 0.2 : 0;
            if (
              p.x + (x / len) * 60 < 150 ||
              p.y + (y / len) * 60 < 150 ||
              p.x + (x / len) * 60 > 3050 ||
              p.y + (y / len) * 60 > 3050
            )
              score -= 400;
            for (const e of enemies) {
              const dist = Math.hypot(e.x - nx, e.y - ny) - e.r - 20;
              if (dist < 60) score -= (60 - dist) * (dist < 10 ? 8 : 2);
            }
            if (score > bs) {
              bs = score;
              best = { x, y };
            }
          }
        return { ...base, move: best };
      });
      report.seed ??= o.seed;
      if (o.phase !== 'playing') await keys([]);
      if (o.phase === 'choosing') {
        const order = o.cards
          .map((name, i) => ({ i, score: names.indexOf(name) < 0 ? 999 : names.indexOf(name) }))
          .sort((a, b) => a.score - b.score);
        report.choices.push({ tick: o.tick, cards: o.cards, selected: order[0].i });
        await page.keyboard.press(String(order[0].i + 1));
      } else if (o.phase === 'stageClear') {
        report.stages.push({ stage: o.stage, tick: o.tick, hp: o.hp, hud: o.hud });
        await page.screenshot({
          path: `target/verification/survivor-play-${trial}-stage-${o.stage}.png`,
        });
        await page
          .getByRole('button', { name: `다음 스테이지 ${o.stage + 1}`, exact: true })
          .click();
      } else if (o.phase === 'paused')
        await page.getByRole('button', { name: '계속하기', exact: true }).click();
      else if (o.phase === 'result') {
        report.end = o;
        break;
      } else if (o.phase === 'playing') {
        if (o.stage >= 7) {
          report.end = o;
          await page.keyboard.press('p');
          break;
        }
        await keys([
          ...(o.move.x < 0 ? ['a'] : o.move.x > 0 ? ['d'] : []),
          ...(o.move.y < 0 ? ['w'] : o.move.y > 0 ? ['s'] : []),
        ]);
      }
      const key = `${o.phase}:${o.stage}`;
      if (key !== previous || Date.now() - lastReport > 30000) {
        console.log(
          JSON.stringify({
            trial,
            elapsed: Math.round((Date.now() - begin) / 1000),
            ...o,
            move: undefined,
            cards: undefined,
          }),
        );
        previous = key;
        lastReport = Date.now();
      }
      await page.waitForTimeout(180);
    }
    await keys([]);
    if (!report.end) throw Error('Play timeout');
    report.wallSeconds = (Date.now() - begin) / 1000;
    await page.screenshot({ path: `target/verification/survivor-play-${trial}-end.png` });
    if (report.end.phase !== 'result')
      await page.getByRole('button', { name: '도전 포기하고 정산', exact: true }).click();
    await page.getByRole('button', { name: '쉼터', exact: true }).click();
    runs.push(report);
    await writeFile(
      'target/verification/survivor-play-native.json',
      JSON.stringify(
        {
          binary,
          sha256: createHash('sha256')
            .update(await readFile(binary))
            .digest('hex'),
          method:
            'wall-clock automated keyboard pilot, observes rendered pixels and public HUD only; no human play claim',
          runs,
        },
        null,
        2,
      ),
    );
  }
  await page
    .evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }))
    .catch(() => {});
  await expect.poll(() => app.exitCode).toBe(0);
} finally {
  await browser?.close();
  if (app.pid && app.exitCode === null)
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
}
