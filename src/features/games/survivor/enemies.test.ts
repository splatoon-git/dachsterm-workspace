import { describe, expect, it } from 'vitest';
import { ENEMIES, FIXED_STEP, LIMITS, SPAWN, VIEW, WORLD } from './content';
import { newSurvivor, pauseSurvivor, resumeSurvivor, stepSurvivor, survivorCamera } from './engine';
import { clearEnemies, clearEnemyProjectiles, spawnEnemy, stepEnemies } from './enemies';
import { addSurvivorDrop, collectSurvivorDrops, dropEnemyLoot } from './drops';
import { nextRandom } from './random';
import type { DropKind, EnemyKind, SurvivorRun } from './types';

function fixture(kind: EnemyKind, dx = 250) {
  const run = newSurvivor(42);
  run.nextSpawnTick = Infinity;
  run.bite.nextReadyTick = Infinity;
  const enemy = spawnEnemy(run, kind)!;
  enemy.x = run.player.x + dx;
  enemy.y = run.player.y;
  if (enemy.behavior) enemy.behavior.readyTick = 1;
  return { run, enemy };
}
function ticks(run: SurvivorRun, count: number) {
  for (let i = 0; i < count; i++) stepSurvivor(run, FIXED_STEP);
}
function enemyTicks(run: SurvivorRun, count: number) {
  for (let i = 0; i < count; i++) {
    run.tick++;
    stepEnemies(run);
  }
}
function totals(run: SurvivorRun) {
  const result = { xp: 0, gold: 0, heal: 0 };
  for (const d of run.drops) result[d.kind] += d.value;
  return result;
}

describe('G.8.3 enemy patterns and shared damage', () => {
  it('safely spawns all eight kinds at the center and four world corners', () => {
    let spawned = 0;
    for (let seed = 0; seed < 40; seed++)
      for (const [x, y] of [
        [1600, 1600],
        [20, 20],
        [3180, 20],
        [20, 3180],
        [3180, 3180],
      ])
        for (const kind of Object.keys(ENEMIES) as EnemyKind[]) {
          const run = newSurvivor(seed);
          run.player.x = x;
          run.player.y = y;
          const e = spawnEnemy(run, kind);
          if (!e) continue;
          spawned++;
          const camera = survivorCamera(run);
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
    expect(spawned).toBeGreaterThan(1200); // Unsafe bounded searches may legitimately skip.
  });

  it('skips unsafe spawn searches and keeps boss capacity separate', () => {
    const run = newSurvivor();
    run.player.x = run.player.y = 20;
    // Degenerate RNG always proposes the top edge, which intersects the clamped view.
    run.random.spawn = 0;
    expect(spawnEnemy(run, 'slime')).toBeNull();
    const bossRun = newSurvivor();
    expect(spawnEnemy(bossRun, 'boss')).not.toBeNull();
    expect(spawnEnemy(bossRun, 'boss')).toBeNull();
    expect(spawnEnemy(bossRun, 'giantSlime')).not.toBeNull();
  });

  it.each(['bat', 'golem'] as const)('%s pursues at its unscaled speed', (kind) => {
    const { run, enemy } = fixture(kind, 400);
    const x = enemy.x;
    ticks(run, 1);
    expect(enemy.x).toBeCloseTo(x - ENEMIES[kind].speed / 60);
  });

  it('mushrooms hold medium range, telegraph and fire once per three-second cycle', () => {
    const { run, enemy } = fixture('mushroom', 300);
    ticks(run, 1);
    expect(enemy.behavior?.mode).toBe('windup');
    expect(enemy.behavior?.untilTick).toBe(31);
    const x = enemy.x;
    ticks(run, 29);
    expect(run.enemyProjectiles).toHaveLength(0);
    ticks(run, 1);
    expect(run.enemyProjectiles).toHaveLength(1);
    expect(enemy.x).toBe(x);
    expect(run.enemyProjectiles[0]).toMatchObject({ damage: 10, endTick: 211 });
    run.player.y += 200;
    expect(run.enemyProjectiles[0].velocity.y).toBeCloseTo(0); // Shot aimed at windup start.
    clearEnemyProjectiles(run);
    enemyTicks(run, 100);
    expect(run.enemyProjectiles).toHaveLength(0);
  });

  it.each([
    ['boar', 42, 36, 300, 60],
    ['armoredBoar', 48, 48, 330, 72],
  ] as const)(
    '%s locks its charge direction through warning, dash and recovery',
    (kind, warning, duration, speed, recovery) => {
      const { run, enemy } = fixture(kind, 400);
      ticks(run, 1);
      const x = enemy.x;
      run.player.y += 100;
      ticks(run, warning - 1);
      expect(enemy.x).toBe(x);
      ticks(run, 1);
      expect(enemy.x).toBeCloseTo(x - speed / 60);
      expect(enemy.y).toBe(1600);
      ticks(run, duration - 1);
      expect(enemy.x).toBeCloseTo(x - (speed * duration) / 60);
      ticks(run, 1);
      expect(enemy.behavior?.mode).toBe('recovery');
      expect(enemy.behavior?.untilTick).toBe(run.tick + recovery);
    },
  );

  it('giant slime targets a landing position and hits the radius without damaging its teleport path', () => {
    const { run, enemy } = fixture('giantSlime', 400);
    ticks(run, 1);
    expect(enemy.behavior?.target).toEqual({ x: 1600, y: 1600 });
    run.player.x = 1800; // Between start and landing, but outside landing radius.
    ticks(run, 48);
    expect(enemy.x).toBe(1600);
    expect(run.player.hp).toBe(100);
    const other = fixture('giantSlime', 400);
    ticks(other.run, 1);
    other.run.player.y += 110;
    ticks(other.run, 48);
    expect(other.run.player.hp).toBe(80);
  });

  it('runs the complete boss charge/shoot/leap pattern with fixed warning lengths', () => {
    const { run, enemy } = fixture('boss', 400);
    run.stage.phase = 'boss';
    run.player.invulnerableUntilTick = Infinity;
    ticks(run, 1);
    expect(enemy.behavior?.untilTick).toBe(55);
    ticks(run, 54);
    expect(enemy.behavior?.mode).toBe('charge');
    ticks(run, 54);
    expect(enemy.behavior?.mode).toBe('recovery');
    ticks(run, 72);
    expect(enemy.behavior?.action).toBe('shoot');
    expect(enemy.behavior?.untilTick).toBe(run.tick + 48);
    ticks(run, 48);
    expect(run.enemyProjectiles).toHaveLength(5);
    ticks(run, 72);
    expect(enemy.behavior?.action).toBe('leap');
    expect(enemy.behavior?.untilTick).toBe(run.tick + 60);
    const target = { ...enemy.behavior!.target };
    run.player.y += 300;
    ticks(run, 60);
    expect({ x: enemy.x, y: enemy.y }).toEqual(target);
    expect(enemy.behavior?.untilTick).toBe(run.tick + 90);
    ticks(run, 90);
    expect(enemy.behavior?.action).toBe('charge');
  });

  it('uses seven half-health boss seeds, 20% shorter recovery and one 15% speed increase after 90s', () => {
    const { run, enemy } = fixture('boss', 400);
    enemy.hp = enemy.maxHp / 2;
    enemy.behavior!.action = 'shoot';
    ticks(run, 1);
    expect(enemy.behavior?.untilTick).toBe(49);
    ticks(run, 48);
    expect(run.enemyProjectiles).toHaveLength(7);
    expect(enemy.behavior?.untilTick).toBe(run.tick + 58);
    const travel = (bossTicks: number) => {
      const f = fixture('boss', 1000);
      f.run.stage.phase = 'boss';
      f.run.stage.bossTicks = bossTicks;
      const before = f.enemy.x;
      ticks(f.run, 1);
      return before - f.enemy.x;
    };
    expect(travel(5398)).toBeCloseTo(75 / 60);
    expect(travel(5399)).toBeCloseTo((75 * 1.15) / 60);
    expect(travel(20000)).toBeCloseTo((75 * 1.15) / 60);
  });

  it('shares armor and invulnerability between swept projectiles, contact and landing damage', () => {
    const { run, enemy } = fixture('slime', 0);
    enemy.hp = 1000;
    run.player.stats.armor = 3;
    run.enemyProjectiles.push({
      id: run.nextEntityId++,
      x: run.player.x - 100,
      y: run.player.y,
      velocity: { x: 12000, y: 0 },
      radius: 8,
      damage: 20,
      endTick: 100,
    });
    ticks(run, 1);
    expect(run.player.hp).toBe(83);
    expect(run.enemyProjectiles).toHaveLength(0); // Swept collision crosses the entire player.
    run.player.recoil = { x: 0, y: 0 };
    enemy.kind = 'giantSlime';
    enemy.behavior = {
      mode: 'windup',
      action: 'leap',
      untilTick: 2,
      readyTick: 100,
      direction: { x: 1, y: 0 },
      target: { x: run.player.x, y: run.player.y },
    };
    ticks(run, 1);
    expect(run.player.hp).toBe(83);
    ticks(run, 44);
    expect(run.player.hp).toBe(76);
  });

  it('caps bullets without backlog, expires them and fully resets pooled fields', () => {
    const { run, enemy } = fixture('boss', 400);
    enemy.behavior!.action = 'shoot';
    for (let i = 0; i < 99; i++)
      run.enemyProjectiles.push({
        id: run.nextEntityId++,
        x: 100,
        y: 100,
        radius: 8,
        velocity: { x: 0, y: 0 },
        damage: 999,
        endTick: 10000,
      });
    ticks(run, 49);
    expect(run.enemyProjectiles).toHaveLength(LIMITS.enemyProjectiles);
    clearEnemyProjectiles(run);
    ticks(run, 1);
    expect(run.enemyProjectiles).toHaveLength(0);
    enemy.behavior!.mode = 'windup';
    enemy.behavior!.action = 'shoot';
    enemy.behavior!.untilTick = run.tick + 1;
    ticks(run, 1);
    expect(run.enemyProjectiles).toHaveLength(5);
    expect(run.enemyProjectiles.every((p) => p.damage === 15 && p.endTick === run.tick + 180)).toBe(
      true,
    );
    run.enemies.length = 0;
    enemyTicks(run, 180);
    expect(run.enemyProjectiles).toHaveLength(0);
    run.enemyProjectiles.push({
      id: run.nextEntityId++,
      x: 1,
      y: 1,
      radius: 8,
      velocity: { x: -160, y: 0 },
      damage: 1,
      endTick: run.tick + 100,
    });
    enemyTicks(run, 1);
    expect(run.enemyProjectiles).toHaveLength(0);
  });

  it('resets pooled boss behavior, immunity, scaling and damage gates when reusing it as a slime', () => {
    const { run, enemy } = fixture('boss');
    enemy.recoil = { x: 12, y: 34 };
    enemy.orbitHitUntilTick = 1000;
    enemy.trailHitUntilTick = 1000;
    clearEnemies(run);
    const slime = spawnEnemy(run, 'slime')!;
    expect(slime).toBe(enemy);
    expect(slime.behavior).toBeUndefined();
    expect(slime.knockbackImmune).toBe(false);
    expect(slime.recoil).toBeUndefined();
    expect(slime.damageScale).toBe(1);
    expect(slime.orbitHitUntilTick).toBe(0);
    expect(slime.trailHitUntilTick).toBe(0);
  });

  it('freezes enemy warnings, bullets and stage time in paused and choosing phases', () => {
    const { run } = fixture('boss');
    ticks(run, 1);
    pauseSurvivor(run);
    const paused = structuredClone(run);
    ticks(run, 100);
    expect(run).toEqual(paused);
    resumeSurvivor(run);
    addSurvivorDrop(run, 'xp', 6, run.player);
    ticks(run, 1);
    const choosing = structuredClone(run);
    ticks(run, 100);
    expect(run).toEqual(choosing);
  });

  it('reproduces mixed encounters at 30/60/120Hz with independent spawn/drop/card streams', () => {
    const simulate = (hz: number) => {
      const run = newSurvivor(99);
      run.stage.index = 5;
      run.level = 40;
      run.player.invulnerableUntilTick = Infinity;
      run.weapons = [
        { id: 'wave', rank: 5, evolved: true },
        { id: 'orbit', rank: 5, evolved: false },
      ];
      for (const kind of Object.keys(ENEMIES) as EnemyKind[]) spawnEnemy(run, kind);
      for (let s = 0; s < 10; s++)
        for (let f = 0; f < hz; f++) stepSurvivor(run, 1 / hz, { moveX: s % 2 ? 1 : -1, moveY: 0 });
      return run;
    };
    expect(simulate(30)).toEqual(simulate(60));
    expect(simulate(120)).toEqual(simulate(60));
  });
});

describe('G.8.3 XP/gold/healing loot', () => {
  it('uses independent 10%/2% draws, allows both drops, and consumes only the drop stream', () => {
    let both = 0;
    let goldCount = 0;
    let healCount = 0;
    for (let seed = 0; seed < 1000; seed++) {
      const run = newSurvivor(seed);
      const before = { ...run.random };
      const enemy = spawnEnemy(run, 'slime')!;
      const spawn = run.random.spawn;
      const gold = nextRandom(before.drops);
      const heal = nextRandom(gold.state);
      dropEnemyLoot(run, enemy);
      expect(totals(run)).toEqual({
        xp: 3,
        gold: gold.value < 0.1 ? 1 : 0,
        heal: heal.value < 0.02 ? 1 : 0,
      });
      expect(run.random.drops).toBe(heal.state);
      expect(run.random.spawn).toBe(spawn);
      expect(run.random.cards).toBe(before.cards);
      goldCount += totals(run).gold;
      healCount += totals(run).heal;
      if (gold.value < 0.1 && heal.value < 0.02) both++;
    }
    expect(both).toBeGreaterThan(0);
    expect(goldCount).toBeGreaterThan(70);
    expect(goldCount).toBeLessThan(130);
    expect(healCount).toBeGreaterThan(5);
    expect(healCount).toBeLessThan(40);
  });

  it.each(['giantSlime', 'armoredBoar'] as const)(
    '%s guarantees XP40, gold15 and one snack without a drop roll',
    (kind) => {
      const { run, enemy } = fixture(kind);
      const random = { ...run.random };
      dropEnemyLoot(run, enemy);
      expect(totals(run)).toEqual({ xp: 40, gold: 15, heal: 1 });
      expect(run.random).toEqual(random);
    },
  );

  it('preserves every kind under the shared 250-object cap, including a newly introduced kind', () => {
    const run = newSurvivor();
    const point = { x: 100, y: 100 };
    for (let i = 0; i < 250; i++) addSurvivorDrop(run, 'xp', 1, { x: 100 + i, y: 100 });
    addSurvivorDrop(run, 'gold', 15, point);
    addSurvivorDrop(run, 'heal', 1, point);
    for (let i = 0; i < 2000; i++) {
      const kind: DropKind = i % 3 === 0 ? 'xp' : i % 3 === 1 ? 'gold' : 'heal';
      addSurvivorDrop(run, kind, 0.25, point);
    }
    expect(run.drops).toHaveLength(250);
    expect(totals(run)).toEqual({ xp: 416.75, gold: 181.75, heal: 167.5 });
    const snapshot = structuredClone(run.drops);
    ticks(run, 60);
    expect(run.drops).toEqual(snapshot);
  });

  it('merges into the nearest same-kind drop with deterministic ID ties', () => {
    const run = newSurvivor();
    for (let i = 0; i < 250; i++)
      addSurvivorDrop(run, i % 2 ? 'gold' : 'xp', 1, { x: i % 2 ? 100 : 300, y: 100 });
    const first = run.drops[0];
    run.drops.reverse();
    addSurvivorDrop(run, 'xp', 12, { x: 100, y: 100 });
    expect(first.value).toBe(13);
    expect(totals(run)).toEqual({ xp: 137, gold: 125, heal: 0 });
  });

  it('collects fractional gold with the current bonus and healing at current maximum HP, even at MAX level', () => {
    const run = newSurvivor();
    run.level = 40;
    run.player.hp = 20;
    run.player.stats.maxHp = 200;
    run.player.stats.goldBonus = 0.25;
    addSurvivorDrop(run, 'xp', 100, run.player);
    addSurvivorDrop(run, 'gold', 1, run.player);
    addSurvivorDrop(run, 'heal', 2, run.player);
    collectSurvivorDrops(run);
    expect(run.xp).toBe(0);
    expect(run.pendingChoices).toBe(0);
    expect(run.gold).toBe(1.25);
    expect(run.player.hp).toBe(100);
    run.player.stats.goldBonus = 0.5;
    addSurvivorDrop(run, 'gold', 1, run.player);
    addSurvivorDrop(run, 'heal', 100, run.player);
    collectSurvivorDrops(run);
    expect(run.gold).toBe(2.75);
    expect(run.player.hp).toBe(200);
    addSurvivorDrop(run, 'gold', 100, { x: run.player.x + 64.01, y: run.player.y });
    collectSurvivorDrops(run);
    expect(run.gold).toBe(2.75);
  });

  it('fully resets pooled drop kind, position, ID and value', () => {
    const run = newSurvivor();
    addSurvivorDrop(run, 'heal', 5, run.player);
    const old = run.drops[0];
    const id = old.id;
    collectSurvivorDrops(run);
    addSurvivorDrop(run, 'gold', 0.5, { x: 50, y: 60 });
    expect(run.drops[0]).toBe(old);
    expect(old.id).toBeGreaterThan(id);
    expect(old).toMatchObject({ kind: 'gold', value: 0.5, x: 50, y: 60 });
  });

  it('keeps a projectile hit snapshot when the same pooled object is reused for a new shot', () => {
    const { run, enemy } = fixture('mushroom', 300);
    const projectile = {
      id: run.nextEntityId++,
      x: run.player.x,
      y: run.player.y,
      radius: 8,
      velocity: { x: 0, y: 0 },
      damage: 40,
      endTick: 1000,
    };
    run.enemyProjectiles.push(projectile);
    enemy.behavior!.mode = 'windup';
    enemy.behavior!.untilTick = 1;
    ticks(run, 1);
    expect(run.enemyProjectiles[0]).toBe(projectile);
    expect(projectile.damage).toBe(10);
    expect(run.player.hp).toBe(60);
  });

  it('retains spawn-time projectile damage scaling and native boss knockback immunity', () => {
    const run = newSurvivor(42);
    run.stage.index = 6;
    run.nextSpawnTick = Infinity;
    const mushroom = spawnEnemy(run, 'mushroom')!;
    mushroom.x = run.player.x + 300;
    mushroom.y = run.player.y;
    mushroom.behavior!.mode = 'windup';
    mushroom.behavior!.untilTick = 1;
    run.stage.index = 100;
    ticks(run, 1);
    expect(run.enemyProjectiles[0].damage).toBeCloseTo(13);
    clearEnemies(run);
    const boss = spawnEnemy(run, 'boss')!;
    boss.x = run.player.x + 120;
    boss.y = run.player.y;
    boss.behavior!.mode = 'recovery';
    boss.behavior!.untilTick = 1000;
    run.weapons = [{ id: 'wave', rank: 1, evolved: false }];
    const position = { x: boss.x, y: boss.y };
    ticks(run, 18);
    expect(boss.hp).toBeLessThan(boss.maxHp);
    expect(boss.recoil).toBeUndefined();
    expect({ x: boss.x, y: boss.y }).toEqual(position);
  });
});
