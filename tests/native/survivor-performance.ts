// Artificial cap load, not gameplay. Injected only by the native performance runner.
import { LIMITS, MAX_LEVEL } from '../../src/features/games/survivor/content';
import {
  newSurvivor,
  pauseSurvivor,
  resumeSurvivor,
  stepSurvivor,
} from '../../src/features/games/survivor/engine';
import { spawnEnemy } from '../../src/features/games/survivor/enemies';
import { addSurvivorDrop } from '../../src/features/games/survivor/drops';
import { drawSurvivor, loadSurvivorAtlas } from '../../src/features/games/survivor/renderer';
import { defaultTheme } from '../../src/themes/registry';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { SurvivorController } from '../../src/features/games/survivor/controller';
import { SurvivorGame } from '../../src/features/games/survivor/SurvivorGame';

export function capRun(seed: number) {
  const r = newSurvivor(seed);
  r.level = MAX_LEVEL;
  r.weapons = [
    { id: 'bite', rank: 5, evolved: true },
    { id: 'boomerang', rank: 5, evolved: true },
    { id: 'wave', rank: 5, evolved: false },
    { id: 'orbit', rank: 5, evolved: false },
  ];
  r.abilities = [
    { id: 'fangs', rank: 5 },
    { id: 'tail', rank: 5 },
    { id: 'fur', rank: 5 },
    { id: 'heart', rank: 3 },
  ];
  r.player.invulnerableUntilTick = Number.MAX_SAFE_INTEGER;
  // Hold the wave open; prevent scenario preparation from entering measured samples.
  r.stage.waveTicks = -1_000_000;
  r.nextSpawnTick = Number.MAX_SAFE_INTEGER;
  for (let i = 0; i < LIMITS.enemies + LIMITS.elites + LIMITS.bosses; i++) {
    const e = spawnEnemy(
      r,
      i < LIMITS.enemies
        ? (['slime', 'bat', 'mushroom', 'golem', 'boar'] as const)[i % 5]
        : i === LIMITS.enemies
          ? 'giantSlime'
          : i === LIMITS.enemies + 1
            ? 'armoredBoar'
            : 'boss',
    );
    if (!e) throw Error('Cap fixture spawn failed');
    e.x = r.player.x - 430 + (i % 19) * 47;
    e.y = r.player.y - 220 + Math.floor(i / 19) * 47;
    e.hp = e.maxHp = 1e12;
  }
  for (let i = 0; i < LIMITS.attacks; i++)
    r.attacks.push({
      id: r.nextAttackId++,
      kind: 'trail',
      x: r.player.x - 400 + (i % 20) * 42,
      y: r.player.y - 210 + Math.floor(i / 20) * 36,
      radius: 85,
      damage: 1,
      hitIds: [],
      endTick: Number.MAX_SAFE_INTEGER,
    });
  for (let i = 0; i < LIMITS.drops; i++)
    addSurvivorDrop(r, (['xp', 'gold', 'heal'] as const)[i % 3], 1, {
      x: r.player.x - 430 + (i % 25) * 36,
      y: r.player.y - 230 + Math.floor(i / 25) * 49,
    });
  for (let i = 0; i < LIMITS.enemyProjectiles; i++)
    r.enemyProjectiles.push({
      id: r.nextEntityId++,
      x: r.player.x - 440 + (i % 20) * 45,
      y: r.player.y - 240 + Math.floor(i / 20) * 100,
      radius: 8,
      velocity: { x: 0, y: 0 },
      damage: 1,
      endTick: Number.MAX_SAFE_INTEGER,
    });
  for (const d of r.drops) if (Math.hypot(d.x - r.player.x, d.y - r.player.y) < 100) d.x = 1200;
  for (const b of r.enemyProjectiles)
    if (Math.hypot(b.x - r.player.x, b.y - r.player.y) < 100) b.x = 1200;
  return r;
}

export async function measure(seconds = 60) {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:1280px;aspect-ratio:16/9;display:block';
  const parent = document.createElement('div');
  parent.style.cssText = 'position:fixed;inset:0;z-index:99999;background:white;overflow:auto';
  parent.append(canvas);
  document.body.append(parent);
  const atlas = loadSurvivorAtlas(() => {});
  await atlas.decode();
  const r = capRun(2026),
    samples: number[] = [],
    intervals: number[] = [];
  // Keep every category at cap for every measured frame. Collection and bullets are reset
  // outside the timed callback; simulation, collision, draw command submission are inside.
  const drops = [...r.drops],
    bullets = [...r.enemyProjectiles];
  const start = performance.now();
  let previous = start;
  try {
    await new Promise<void>((resolve) => {
      const tick = (now: number) => {
        intervals.push(now - previous);
        previous = now;
        r.drops = [...drops];
        r.enemyProjectiles = [...bullets];
        // Fixed fixtures otherwise collect indefinitely and inflate pools artificially.
        for (const d of r.drops) {
          if (Math.hypot(d.x - r.player.x, d.y - r.player.y) < 100) d.x = 1200;
        }
        for (const b of r.enemyProjectiles) {
          if (Math.hypot(b.x - r.player.x, b.y - r.player.y) < 100) b.x = 1200;
        }
        const before = performance.now();
        stepSurvivor(r, 1 / 60);
        drawSurvivor(canvas, r, defaultTheme, atlas, false);
        samples.push(performance.now() - before);
        if (now - start >= seconds * 1000) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const before = { tick: r.tick, spawn: r.nextSpawnTick, enemies: r.enemies.length };
    pauseSurvivor(r);
    stepSurvivor(r, 3600);
    resumeSurvivor(r);
    stepSurvivor(r, 1 / 60);
    if (r.tick !== before.tick + 1 || r.nextSpawnTick !== before.spawn)
      throw Error('Pause backlog');
    const percentile = (a: number[], p: number) =>
      [...a].sort((x, y) => x - y)[Math.ceil(a.length * p) - 1];
    return {
      method:
        'source probe: one 60Hz engine tick + Canvas2D submission, no GPU/compositor/React time',
      seconds: (performance.now() - start) / 1000,
      frames: samples.length,
      cssWidth: canvas.clientWidth,
      dpr: devicePixelRatio,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
      max: Math.max(...samples),
      rafP95: percentile(intervals, 0.95),
      pauseBacklog: false,
      counts: {
        enemies: r.enemies.length,
        attacks: r.attacks.length,
        drops: r.drops.length,
        bullets: r.enemyProjectiles.length,
      },
    };
  } finally {
    parent.remove();
  }
}

export function churn(seed: number) {
  // Leave no strong reference to the old run, grids, or pools between rounds.
  const r = capRun(seed);
  for (let i = 0; i < 600; i++) stepSurvivor(r, 1 / 60);
  return { tick: r.tick, enemies: r.enemies.length, attacks: r.attacks.length };
}

export async function measureUi(seconds = 60) {
  const parent = document.createElement('div');
  parent.style.cssText =
    'position:fixed;inset:0;z-index:99999;overflow:auto;background:var(--terminal-background)';
  const host = document.createElement('main');
  host.className = 'game-terminal';
  host.style.cssText = 'width:1280px;padding:0';
  parent.append(host);
  document.body.append(parent);
  const controller = new SurvivorController();
  const root = createRoot(host);
  root.render(createElement(SurvivorGame, { active: true, controller }));
  const wait = async (test: () => boolean) => {
    for (let i = 0; i < 200; i++) {
      if (test()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error('Full UI load fixture timeout');
  };
  const originalRaf = window.requestAnimationFrame;
  const durations: number[] = [],
    intervals: number[] = [];
  let last = 0,
    measuring = false;
  try {
    await wait(() => controller.store.getSnapshot().mode === 'owner');
    if (!controller.start(controller.store.getSnapshot().profile.revision))
      throw Error('Full UI start failed');
    const r = capRun(controller.session.run!.seed);
    controller.session.run = r;
    controller.publish();
    await wait(() => !!host.querySelector('canvas'));
    (host.querySelector('.survivor-game') as HTMLElement).style.maxWidth = 'none';
    // Exclude setup and warm the atlas/HUD once. Production owns RAF, audio, sync and DOM.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    window.requestAnimationFrame = (callback) =>
      originalRaf.call(window, (now) => {
        const start = performance.now();
        callback(now);
        if (measuring) {
          durations.push(performance.now() - start);
          if (last) intervals.push(now - last);
          last = now;
        }
      });
    measuring = true;
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    measuring = false;
    const field = host.querySelector('canvas')!;
    const p95 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.ceil(a.length * 0.95) - 1];
    if (r.phase !== 'playing' || durations.length < seconds * 30)
      throw Error('Full UI probe lost active combat');
    return {
      method:
        'production SurvivorGame/controller/session/store/audio/HUD source mounted in WebView2 with artificial cap run; RAF callback CPU includes engine/sync/audio/draw, excludes async compositor/GPU',
      seconds,
      frames: durations.length,
      p95: p95(durations),
      max: Math.max(...durations),
      rafP95: p95(intervals),
      cssWidth: field.clientWidth,
      tick: r.tick,
      counts: {
        enemies: r.enemies.length,
        attacks: r.attacks.length,
        drops: r.drops.length,
        bullets: r.enemyProjectiles.length,
      },
    };
  } finally {
    measuring = false;
    window.requestAnimationFrame = originalRaf;
    controller.close();
    root.unmount();
    parent.remove();
  }
}
