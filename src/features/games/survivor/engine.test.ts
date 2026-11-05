import { describe, expect, it } from 'vitest';
import {
  BASE_STATS,
  BITE,
  FIXED_STEP,
  LIMITS,
  MAX_LEVEL,
  SLIME,
  SPAWN,
  VIEW,
  WORLD,
  xpToNextLevel,
} from './content';
import { newSurvivor, pauseSurvivor, resumeSurvivor, stepSurvivor, survivorCamera } from './engine';
import { nextRandom } from './random';
import type { SurvivorEnemy, SurvivorInput, SurvivorRun } from './types';

function ticks(run: SurvivorRun, count: number, input?: SurvivorInput) {
  for (let i = 0; i < count; i++) stepSurvivor(run, FIXED_STEP, input);
  return run;
}
function enemy(run: SurvivorRun, dx: number, dy = 0, overrides: Partial<SurvivorEnemy> = {}) {
  const e: SurvivorEnemy = {
    id: run.nextEntityId++,
    kind: 'slime',
    x: run.player.x + dx,
    y: run.player.y + dy,
    radius: SLIME.radius,
    hp: SLIME.hp,
    maxHp: SLIME.hp,
    speed: 0,
    damage: SLIME.damage,
    xp: SLIME.xp,
    ...overrides,
  };
  run.enemies.push(e);
  return e;
}
function drop(run: SurvivorRun, value: number, dx = 0, dy = 0) {
  run.drops.push({
    id: run.nextEntityId++,
    kind: 'xp',
    x: run.player.x + dx,
    y: run.player.y + dy,
    value,
  });
}
function totalXp(run: SurvivorRun) {
  return run.drops.reduce((sum, d) => sum + d.value, 0);
}

describe('닥스 서바이버 G.8.1 전투 엔진', () => {
  it('starts independent seeded runs with base HP, level and starting bite', () => {
    const a = newSurvivor(0);
    const b = newSurvivor(0);
    expect(a).toEqual(b);
    expect(a.player.hp).toBe(100);
    expect(a.player.stats).toEqual(BASE_STATS);
    expect(a.level).toBe(1);
    expect(a.xp).toBe(0);
    expect(a.pendingChoices).toBe(0);
    expect(a.random.spawn).not.toBe(0);
    expect(new Set(Object.values(a.random)).size).toBe(3);
    a.player.stats.maxHp = 200;
    expect(b.player.stats.maxHp).toBe(100);
    expect(BASE_STATS.maxHp).toBe(100);
    expect(newSurvivor(NaN).seed).toBe(1);
    expect(newSurvivor(-1).seed).toBe(4294967295);
  });

  it('normalizes all eight movement directions and preserves facing when stopped', () => {
    for (const [moveX, moveY] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const run = ticks(newSurvivor(), 60, { moveX, moveY });
      expect(Math.hypot(run.player.x - 1600, run.player.y - 1600)).toBeCloseTo(210, 8);
      const before = structuredClone(run.player);
      ticks(run, 1);
      expect(run.player).toEqual(before);
    }
    const analog = ticks(newSurvivor(), 60, { moveX: 0.5, moveY: 0 });
    expect(analog.player.x).toBeCloseTo(1705);
  });

  it('clamps world/camera edges and rejects non-finite input and time', () => {
    const run = newSurvivor();
    run.player.x = run.player.y = 21;
    ticks(run, 10, { moveX: -1, moveY: -1 });
    expect(run.player.x).toBe(20);
    expect(run.player.y).toBe(20);
    expect(survivorCamera(run)).toEqual({ x: 0, y: 0 });
    run.player.x = WORLD.width - 21;
    run.player.y = WORLD.height - 21;
    ticks(run, 10, { moveX: 1, moveY: 1 });
    expect(run.player.x).toBe(WORLD.width - 20);
    expect(run.player.y).toBe(WORLD.height - 20);
    expect(survivorCamera(run)).toEqual({
      x: WORLD.width - VIEW.width,
      y: WORLD.height - VIEW.height,
    });
    ticks(run, 1, { moveX: NaN, moveY: Infinity });
    const before = structuredClone(run);
    for (const dt of [NaN, Infinity, -1, 0]) expect(stepSurvivor(run, dt)).toBe(0);
    expect(run).toEqual(before);
    expect(Number.isFinite(run.player.x + run.player.y)).toBe(true);
  });

  it('produces the same combat state at 30/60/120Hz with aligned input changes', () => {
    const simulate = (hz: number) => {
      const run = newSurvivor(42);
      // Seeded pursuit/spawns and the starting weapon, including any level-up stop.
      enemy(run, 80, 0);
      for (let second = 0; second < 20; second++) {
        const direction = second % 4;
        const input = {
          moveX: direction === 0 ? 1 : direction === 2 ? -1 : 0,
          moveY: direction === 1 ? 1 : direction === 3 ? -1 : 0,
        };
        for (let frame = 0; frame < hz; frame++) stepSurvivor(run, 1 / hz, input);
      }
      return run;
    };
    const expected = simulate(60);
    expect(expected.tick).toBeGreaterThan(60);
    expect(expected.bite.sequence).toBeGreaterThan(0);
    expect(expected.random.spawn).not.toBe(newSurvivor(42).random.spawn);
    expect(simulate(30)).toEqual(expected);
    expect(simulate(120)).toEqual(expected);
  });

  it('accumulates sub-ticks, limits catch-up to five ticks and discards excess delay', () => {
    const run = newSurvivor();
    expect(stepSurvivor(run, FIXED_STEP / 2)).toBe(0);
    expect(stepSurvivor(run, FIXED_STEP / 2)).toBe(1);
    expect(stepSurvivor(run, 600)).toBe(5);
    expect(run.tick).toBe(6);
    expect(run.accumulator).toBe(0);
    expect(run.enemies).toHaveLength(0);
    expect(stepSurvivor(run, FIXED_STEP)).toBe(1);
    expect(run.tick).toBe(7);
  });

  it('freezes all simulation and random state while paused and resumes explicitly', () => {
    const run = ticks(newSurvivor(7), 100, { moveX: 1, moveY: 0 });
    stepSurvivor(run, FIXED_STEP / 2);
    pauseSurvivor(run);
    expect(run.accumulator).toBe(0);
    const before = structuredClone(run);
    expect(stepSurvivor(run, 300, { moveX: 1, moveY: 1 })).toBe(0);
    pauseSurvivor(run);
    expect(run).toEqual(before);
    resumeSurvivor(run);
    expect(run.phase).toBe('playing');
    ticks(run, 1);
    expect(run.tick).toBe(before.tick + 1);
    expect(run.enemies).toHaveLength(before.enemies.length);
  });

  it('chases without overshoot and handles an exactly overlapping target', () => {
    const run = newSurvivor();
    run.bite.nextReadyTick = 1000;
    const far = enemy(run, 200, 0, { speed: SLIME.speed });
    const near = enemy(run, 0.1, 0, { speed: SLIME.speed });
    ticks(run, 1);
    expect(far.x).toBeCloseTo(1800 - SLIME.speed / 60);
    expect(near.x).toBe(run.player.x);
    expect(near.y).toBe(run.player.y);
    run.player.recoil = { x: 0, y: 0 };
    ticks(run, 1);
    expect(Number.isFinite(near.x + near.y)).toBe(true);
  });

  it('waits for an in-range target then bites once per cooldown without banking attacks', () => {
    const run = newSurvivor();
    const e = enemy(run, 150, 0, { hp: 1000 });
    ticks(run, 60);
    expect(run.bite.sequence).toBe(0);
    e.x = run.player.x + BITE.radius;
    ticks(run, 1);
    expect(e.hp).toBe(982);
    expect(run.bite.sequence).toBe(1);
    ticks(run, BITE.cooldownTicks - 1);
    expect(e.hp).toBe(982);
    ticks(run, 1);
    expect(e.hp).toBe(964);
    expect(run.bite.sequence).toBe(2);
  });

  it('targets nearest then lowest ID, independently of array/grid traversal order', () => {
    const run = newSurvivor();
    const left = enemy(run, -80);
    const right = enemy(run, 80);
    run.enemies.reverse();
    ticks(run, 1);
    expect(run.bite.lastAttack?.direction).toEqual({ x: -1, y: 0 });
    expect(left.hp).toBe(6);
    expect(right.hp).toBe(24);
    const nearer = newSurvivor();
    enemy(nearer, -90);
    enemy(nearer, 70);
    ticks(nearer, 1);
    expect(nearer.bite.lastAttack?.direction.x).toBe(1);
  });

  it('hits each intersecting circle in the 120-degree sector once, including radial/arc edges', () => {
    const run = newSurvivor();
    const target = enemy(run, 30, 0, { hp: 100 });
    const inside = enemy(run, 60, 50, { hp: 100 });
    const radialEdge = enemy(run, 35, 75, { hp: 100 });
    const arcEdge = enemy(run, 107, 0, { hp: 100 });
    const outside = enemy(run, 0, 80, { hp: 100 });
    const behind = enemy(run, -80, 0, { hp: 100 });
    const tooFar = enemy(run, 109, 0, { hp: 100 });
    ticks(run, 1);
    for (const e of [target, inside, radialEdge, arcEdge]) expect(e.hp).toBe(82);
    for (const e of [outside, behind, tooFar]) expect(e.hp).toBe(100);
    expect(run.bite.lastAttack?.hitIds).toHaveLength(4);
    ticks(run, 1);
    expect(inside.hp).toBe(82);
  });

  it('applies attack bonuses and limits cooldown reduction to 50 percent', () => {
    const run = newSurvivor();
    run.player.stats.attackBonus = 0.1;
    run.player.stats.cooldownReduction = 0.9;
    const e = enemy(run, 80, 0, { hp: 100 });
    ticks(run, 1);
    expect(e.hp).toBe(80);
    expect(run.bite.nextReadyTick - run.tick).toBe(26);
  });

  it('reaps simultaneous kills once and preserves uncollected XP without expiry', () => {
    const run = newSurvivor();
    enemy(run, 80, -10, { hp: 18 });
    enemy(run, 80, 10, { hp: 18 });
    ticks(run, 1);
    expect(run.kills).toBe(2);
    expect(run.enemies).toHaveLength(0);
    expect(run.drops).toHaveLength(2);
    expect(totalXp(run)).toBe(6);
    ticks(run, 60);
    expect(run.kills).toBe(2);
    expect(totalXp(run)).toBe(6);
    expect(run.level).toBe(1);
  });

  it('shares a 45-tick contact shield, selects one strongest hit and keeps control during recoil', () => {
    const run = newSurvivor();
    run.bite.nextReadyTick = 1000;
    enemy(run, 0, 0, { damage: 10, hp: 1000 });
    enemy(run, 0, 0, { damage: 12, hp: 1000 });
    ticks(run, 1);
    expect(run.player.hp).toBe(88);
    expect(run.lastDamage).toEqual({ tick: 1, amount: 12 });
    expect(run.player.recoil.x).toBe(-120);
    ticks(run, 44);
    expect(run.player.hp).toBe(88);
    ticks(run, 1);
    expect(run.player.hp).toBe(76);
    const x = run.player.x;
    ticks(run, 1, { moveX: 1, moveY: 0 });
    expect(run.player.x).toBeGreaterThan(x);
  });

  it('subtracts armor with minimum damage one and clamps lethal HP at zero', () => {
    const armored = newSurvivor();
    armored.player.stats.armor = 100;
    enemy(armored, 0);
    ticks(armored, 1);
    expect(armored.player.hp).toBe(99);
    const dead = newSurvivor();
    dead.player.hp = 3;
    enemy(dead, 0);
    ticks(dead, 1);
    expect(dead.player.hp).toBe(0);
    expect(dead.phase).toBe('result');
    expect(dead.result).toBe('defeat');
    const snapshot = structuredClone(dead);
    ticks(dead, 100, { moveX: 1, moveY: 0 });
    pauseSurvivor(dead);
    resumeSurvivor(dead);
    expect(dead).toEqual(snapshot);
  });

  it('resolves death before same-tick XP collection or level-up', () => {
    const run = newSurvivor();
    run.player.hp = 1;
    enemy(run, 0);
    enemy(run, 70, 0, { hp: 18 });
    drop(run, 100);
    stepSurvivor(run, 1 / 30);
    expect(run.phase).toBe('result');
    expect(run.tick).toBe(1);
    expect(run.accumulator).toBe(0);
    expect(run.level).toBe(1);
    expect(run.xp).toBe(0);
    expect(run.pendingChoices).toBe(0);
    expect(totalXp(run)).toBe(103);
    expect(run.kills).toBe(1);
  });

  it('collects only in radius, carries fractional XP and queues consecutive levels before freezing', () => {
    const run = newSurvivor();
    run.player.stats.experienceBonus = 0.1;
    drop(run, 5, 64);
    drop(run, 99, 64.01);
    ticks(run, 1);
    expect(run.xp).toBeCloseTo(5.5);
    expect(run.drops).toHaveLength(1);
    drop(run, 20);
    expect(stepSurvivor(run, 1 / 30)).toBe(1);
    expect(run.level).toBe(3);
    expect(run.xp).toBeCloseTo(12.5);
    expect(run.pendingChoices).toBe(2);
    expect(run.phase).toBe('choosing');
    expect(run.accumulator).toBe(0);
    const snapshot = structuredClone(run);
    ticks(run, 100);
    expect(run).toEqual(snapshot);
    pauseSurvivor(run);
    expect(run.pausedFrom).toBe('choosing');
    resumeSurvivor(run);
    expect(run).toEqual(snapshot);
  });

  it('uses the specified XP curve, caps at level 40 and never turns excess XP into gold', () => {
    const cumulative = (level: number) =>
      Array.from({ length: level - 1 }, (_, i) => xpToNextLevel(i + 1)).reduce((a, b) => a + b, 0);
    expect(cumulative(16)).toBe(657);
    expect(cumulative(20)).toBe(1152);
    expect(cumulative(22)).toBe(1471);
    const run = newSurvivor();
    drop(run, 100000);
    ticks(run, 1);
    expect(run.level).toBe(MAX_LEVEL);
    expect(run.xp).toBe(0);
    expect(run.pendingChoices).toBe(39);
    expect(xpToNextLevel(MAX_LEVEL)).toBe(0);
    const capped = newSurvivor();
    capped.level = MAX_LEVEL;
    drop(capped, 100);
    ticks(capped, 1);
    expect(capped.xp).toBe(0);
    expect(capped.pendingChoices).toBe(0);
    expect(capped.phase).toBe('playing');
  });

  it('bounds drops by merging into the nearest crystal without losing XP value', () => {
    const run = newSurvivor();
    for (let i = 0; i < LIMITS.drops; i++) drop(run, 1, 200 + i);
    const nearest = run.drops[0];
    enemy(run, 80, 0, { hp: 18 });
    enemy(run, 80, 5, { hp: 18 });
    ticks(run, 1);
    expect(run.drops).toHaveLength(LIMITS.drops);
    expect(totalXp(run)).toBe(LIMITS.drops + 6);
    expect(nearest.value).toBe(7);
    expect(run.kills).toBe(2);
  });

  it('spawns deterministic slimes fully outside the logical view and inside the world, including corners', () => {
    let spawned = 0;
    for (let seed = 0; seed < 100; seed++) {
      for (const [x, y] of [
        [1600, 1600],
        [20, 20],
        [3180, 20],
        [20, 3180],
        [3180, 3180],
      ]) {
        const run = newSurvivor(seed);
        run.player.x = x;
        run.player.y = y;
        ticks(run, SPAWN.intervalTicks);
        const camera = survivorCamera(run);
        expect(run.enemies.length).toBeLessThanOrEqual(1);
        for (const e of run.enemies) {
          spawned++;
          expect(e.x).toBeGreaterThanOrEqual(e.radius);
          expect(e.y).toBeGreaterThanOrEqual(e.radius);
          expect(e.x + e.radius).toBeLessThanOrEqual(WORLD.width);
          expect(e.y + e.radius).toBeLessThanOrEqual(WORLD.height);
          expect(
            Math.hypot(e.x - x, e.y - y) - e.radius - run.player.radius,
          ).toBeGreaterThanOrEqual(SPAWN.minDistance);
          expect(
            e.x + e.radius < camera.x ||
              e.x - e.radius > camera.x + VIEW.width ||
              e.y + e.radius < camera.y ||
              e.y - e.radius > camera.y + VIEW.height,
          ).toBe(true);
        }
      }
    }
    expect(spawned).toBeGreaterThan(400);
    const simulate = (seed: number) => ticks(newSurvivor(seed), 150).enemies;
    expect(simulate(42)).toEqual(simulate(42));
    expect(simulate(42)).not.toEqual(simulate(43));
  });

  it('skips a capped spawn without backlog and isolates spawn randomness from cards/drops', () => {
    const full = newSurvivor();
    for (let i = 0; i < LIMITS.enemies; i++) enemy(full, 600, i);
    ticks(full, 75);
    expect(full.enemies).toHaveLength(LIMITS.enemies);
    expect(full.nextSpawnTick).toBe(150);
    full.enemies.length = 0;
    ticks(full, 74);
    expect(full.enemies).toHaveLength(0);
    ticks(full, 1);
    expect(full.enemies).toHaveLength(1);
    const a = newSurvivor(9);
    const b = newSurvivor(9);
    for (let i = 0; i < 100; i++) {
      b.random.cards = nextRandom(b.random.cards).state;
      b.random.drops = nextRandom(b.random.drops).state;
    }
    ticks(a, 150);
    ticks(b, 150);
    expect(a.enemies).toEqual(b.enemies);
    expect(a.random.spawn).toBe(b.random.spawn);
  });

  it('reaches the first level-up from an untouched run using only movement and automatic bites', () => {
    for (const seed of [0, 42, 4294967295]) {
      const run = newSurvivor(seed);
      for (let i = 0; i < 60 * 30 && run.phase === 'playing'; i++) {
        const targets = run.drops.length ? run.drops : run.enemies;
        const nearest = [...targets].sort(
          (a, b) =>
            Math.hypot(a.x - run.player.x, a.y - run.player.y) -
            Math.hypot(b.x - run.player.x, b.y - run.player.y),
        )[0];
        const dx = nearest ? nearest.x - run.player.x : 0;
        const dy = nearest ? nearest.y - run.player.y : 0;
        const distance = Math.hypot(dx, dy);
        stepSurvivor(run, FIXED_STEP, {
          moveX: distance > 0 ? dx / distance : 0,
          moveY: distance > 0 ? dy / distance : 0,
        });
      }
      expect(run.phase, `seed=${seed} tick=${run.tick} hp=${run.player.hp}`).toBe('choosing');
      expect(run.level).toBe(2);
      expect(run.kills).toBeGreaterThanOrEqual(2);
      expect(run.player.hp).toBeGreaterThan(0);
      expect(run.pendingChoices).toBe(1);
      expect(run.bite.sequence).toBeGreaterThanOrEqual(4);
    }
  });
});
