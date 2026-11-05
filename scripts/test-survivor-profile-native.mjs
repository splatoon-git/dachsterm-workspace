// Source-level profile probe in the real Windows WebView2 runtime; no gameplay/SSH claims.
import { chromium, expect } from '@playwright/test';
import { build } from 'vite';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';

if (process.platform !== 'win32') throw Error('Windows WebView2 required.');
const bundle = await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    write: false,
    minify: false,
    lib: { entry: 'tests/native/survivor-profile.ts', formats: ['iife'], name: 'SurvivorNative' },
  },
});
const code = (Array.isArray(bundle) ? bundle : [bundle])
  .flatMap((result) => result.output)
  .find((item) => item.type === 'chunk').code;
const directory = await mkdtemp(path.join(tmpdir(), 'daxterm-survivor-profile-'));
const binary = process.env.DAXTERM_TEST_BINARY ?? path.resolve('target/debug/daxterm.exe');
let app, browser;
async function launch() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  app = spawn(binary, [], {
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      DAXTERM_TEST_DATA_DIR: directory,
      DAXTERM_TEST_CDP_PORT: String(port),
      WEBVIEW2_USER_DATA_FOLDER: path.join(directory, 'webview'),
    },
  });
  let endpoint;
  for (let i = 0; i < 80; i++) {
    try {
      endpoint = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!endpoint) throw Error('Native debug endpoint unavailable.');
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  let page;
  for (let i = 0; i < 40; i++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().includes('tauri.localhost'));
    if (page) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) throw Error('Native app origin unavailable.');
  await page.evaluate(code);
  return page;
}
async function stop() {
  await browser?.close();
  browser = null;
  if (app?.pid)
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
  app = null;
}
try {
  let page = await launch();
  const capabilities = await page.evaluate(async () => {
    const lib = globalThis.SurvivorNative;
    const store = new lib.SurvivorProfileStore();
    await store.connect();
    globalThis.profileStore = store;
    globalThis.profileSession = new lib.SurvivorSession(store);
    return {
      origin: location.origin,
      secureContext: isSecureContext,
      locks: !!navigator.locks,
      uuid: typeof crypto.randomUUID === 'function',
      mode: store.getSnapshot().mode,
      userAgent: navigator.userAgent,
    };
  });
  expect(capabilities.mode).toBe('owner');
  expect(capabilities.locks).toBe(true);
  expect(capabilities.uuid).toBe(true);
  // A second same-origin document verifies real lock contention and storage events.
  await page.evaluate(() => {
    const f = document.createElement('iframe');
    f.name = 'profile-peer';
    f.srcdoc = '<!doctype html><title>profile peer</title>';
    document.body.append(f);
  });
  await expect.poll(() => page.frames().some((f) => f.name() === 'profile-peer')).toBe(true);
  const peer = page.frame({ name: 'profile-peer' });
  await peer.evaluate(code);
  expect(
    await peer.evaluate(async () => {
      globalThis.profileStore = new globalThis.SurvivorNative.SurvivorProfileStore();
      await globalThis.profileStore.connect();
      return globalThis.profileStore.getSnapshot().mode;
    }),
  ).toBe('readonly');
  expect(
    await page.evaluate(() => {
      const s = globalThis.profileSession;
      if (!s.start(42, 0)) return false;
      const r = s.run;
      r.gold = 25.75;
      r.tick = 21600;
      r.stage.index = 6;
      r.highestReachedStage = 6;
      r.highestCompletedStage = 6;
      r.bossesDefeated = 2;
      r.bossRewardGold = 80;
      r.lastRewardedBossStage = 6;
      r.phase = 'stageClear';
      return s.finish('retired', 6);
    }),
  ).toBe(true);
  await expect
    .poll(() => peer.evaluate(() => globalThis.profileStore.getSnapshot().profile.gold))
    .toBe(135);
  expect(
    await page.evaluate(() =>
      globalThis.profileStore.purchase(
        { kind: 'upgrade', id: 'hp' },
        globalThis.profileStore.getSnapshot().profile.revision,
      ),
    ),
  ).toBe(true);
  await expect
    .poll(() => peer.evaluate(() => globalThis.profileStore.getSnapshot().profile.gold))
    .toBe(105);
  expect(
    await page.evaluate(() => {
      const s = globalThis.profileSession;
      if (!s.start(7, globalThis.profileStore.getSnapshot().profile.revision)) return false;
      s.run.gold = 2.75;
      s.run.tick = 300;
      return s.sync(true);
    }),
  ).toBe(true);
  // Web Storage acknowledges renderer visibility before Chromium flushes to disk.
  // Leave the normal checkpoint interval before killing the entire process tree.
  await page.waitForTimeout(6000);
  await stop(); // Abrupt process loss with a checkpoint, intentionally no dispose/settlement.
  page = await launch();
  const recovered = await page.evaluate(async () => {
    const store = new globalThis.SurvivorNative.SurvivorProfileStore();
    await store.connect();
    const p = store.getSnapshot().profile;
    return {
      gold: p.gold,
      hpRank: p.upgrades.hp.rank,
      checkpoint: p.checkpoint,
      settlements: p.settlements.length,
      latestReason: p.settlements[0]?.reason,
      firstBossRewarded: p.firstBossRewarded,
    };
  });
  expect(recovered).toEqual({
    gold: 107,
    hpRank: 1,
    checkpoint: null,
    settlements: 2,
    latestReason: 'interrupted',
    firstBossRewarded: true,
  });
  await mkdir('target/verification', { recursive: true });
  await writeFile(
    'target/verification/survivor-profile-native.json',
    JSON.stringify(
      {
        capabilities,
        recovered,
        binary,
        scope:
          'Current profile/session source injected into existing debug WebView2; peer iframe, process restart after 6s idle. Not production gameplay integration or native multi-window UI. Immediate kill of the whole process tree can lose acknowledged localStorage writes before disk flush.',
      },
      null,
      2,
    ),
  );
  console.log(
    'WebView2 profile probe passed: Web Locks contention, storage event, atomic settlement/purchase, process-restart checkpoint recovery.',
  );
} finally {
  await stop();
}
