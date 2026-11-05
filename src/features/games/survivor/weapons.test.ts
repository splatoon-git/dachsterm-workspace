import { describe, expect, it } from 'vitest';
import {
  BASE_STATS,
  FIXED_STEP,
  LIMITS,
  WEAPON_IDS,
  WEAPON_RULES,
  weaponParameters,
} from './content';
import { newSurvivor, pauseSurvivor, resumeSurvivor, stepSurvivor } from './engine';
import { chooseSurvivorCard } from './progression';
import type { SurvivorEnemy, SurvivorRun, WeaponId } from './types';

function ticks(run: SurvivorRun, count: number) {
  for (let i = 0; i < count; i++) stepSurvivor(run, FIXED_STEP);
}
function armed(id: WeaponId, rank = 1, evolved = false) {
  const run = newSurvivor();
  run.weapons = [{ id, rank, evolved }];
  run.nextSpawnTick = Number.MAX_SAFE_INTEGER;
  return run;
}
function enemy(run: SurvivorRun, dx: number, dy = 0, props: Partial<SurvivorEnemy> = {}) {
  const e: SurvivorEnemy = {
    id: run.nextEntityId++,
    kind: 'slime',
    x: run.player.x + dx,
    y: run.player.y + dy,
    radius: 18,
    hp: 1000,
    maxHp: 1000,
    speed: 0,
    damage: 10,
    xp: 3,
    ...props,
  };
  run.enemies.push(e);
  return e;
}
function oneLaunch(run: SurvivorRun) {
  ticks(run, 1);
  for (const id of ['boomerang', 'wave', 'trail', 'acorn'] as const)
    run.weaponTimers[id] = Number.MAX_SAFE_INTEGER;
}

describe('G.8.2 여섯 무기의 전투 규칙', () => {
  it('defines rank damage and rank-three/five ranges, counts and lifetimes', () => {
    const base = [18, 16, 22, 10, 6, 26];
    for (let i = 0; i < WEAPON_IDS.length; i++) {
      for (let rank = 1; rank <= 5; rank++) {
        const p = weaponParameters(WEAPON_IDS[i], rank, false, BASE_STATS);
        expect(p.damage).toBe(Math.round(base[i] * [1, 1.3, 1.65, 2.05, 2.5][rank - 1]));
        if (['boomerang', 'orbit', 'acorn'].includes(WEAPON_IDS[i]))
          expect(p.count).toBe(rank >= 5 ? 3 : rank >= 3 ? 2 : 1);
      }
    }
    expect([1, 3, 5].map((r) => weaponParameters('bite', r, false, BASE_STATS).radius)).toEqual([
      90, 105, 125,
    ]);
    expect([1, 3, 5].map((r) => weaponParameters('wave', r, false, BASE_STATS).radius)).toEqual([
      150, 180, 220,
    ]);
    expect(
      [1, 3, 5].map((r) => weaponParameters('trail', r, false, BASE_STATS).durationTicks),
    ).toEqual([180, 240, 240]);
    expect([1, 3, 5].map((r) => weaponParameters('trail', r, false, BASE_STATS).radius)).toEqual([
      65, 65, 85,
    ]);
  });

  it('upgrades bite geometry and evolves to a 180-degree sector with final rounded damage', () => {
    const base = armed('bite', 5);
    const out = enemy(base, 149, 0, { radius: 1 });
    ticks(base, 1);
    expect(out.hp).toBe(1000);
    const run = armed('bite', 5, true);
    run.player.stats.attackBonus = 0.1;
    const front = enemy(run, 100, 0, { radius: 1 });
    const side = enemy(run, 0, 140, { radius: 1 });
    const behind = enemy(run, -20, 140, { radius: 1 });
    ticks(run, 1);
    expect(front.hp).toBe(921); // round(18 * 2.5 * 1.6 * 1.1)
    expect(side.hp).toBe(921);
    expect(behind.hp).toBe(1000);
    expect(run.bite.lastAttack?.radius).toBe(150);
    expect(run.bite.lastAttack?.halfAngle).toBe(Math.PI / 2);
  });

  it('waits for a target within 520, uses nearest/id ordering and launches rank-count boomerangs', () => {
    const run = armed('boomerang', 5);
    const left = enemy(run, -521);
    ticks(run, 10);
    expect(run.attacks).toHaveLength(0);
    expect(run.weaponTimers.boomerang).toBe(0);
    left.x = run.player.x - 520;
    enemy(run, 520);
    run.enemies.reverse();
    ticks(run, 1);
    expect(run.attacks).toHaveLength(3);
    expect(run.attacks.every((a) => a.kind === 'boomerang' && a.direction.x < 0)).toBe(true);
    expect(run.weaponTimers.boomerang).toBe(run.tick + 84);
  });

  it('hits only once on each boomerang leg and removes it at the launch origin', () => {
    const run = armed('boomerang');
    const e = enemy(run, 210);
    oneLaunch(run);
    const hits: number[] = [];
    let hp = e.hp;
    for (let i = 1; i < 120; i++) {
      ticks(run, 1);
      if (e.hp !== hp) {
        hits.push(run.tick);
        hp = e.hp;
      }
    }
    expect(hits).toHaveLength(2);
    expect(hits[0]).toBeLessThan(60);
    expect(hits[1]).toBeGreaterThan(60);
    expect(e.hp).toBe(968);
    expect(run.attacks).toHaveLength(0);
  });

  it('uses swept projectile collisions even when a step crosses the entire enemy', () => {
    const run = armed('boomerang');
    const e = enemy(run, 210, 0, { radius: 1 });
    oneLaunch(run);
    const attack = run.attacks[0];
    if (attack.kind !== 'boomerang') throw new Error('expected boomerang');
    attack.speed = 60000;
    ticks(run, 1);
    expect(e.hp).toBe(984);
    ticks(run, 1);
    expect(e.hp).toBe(968);
    expect(run.attacks).toHaveLength(0);
  });

  it('gives golden bones exactly one extra round trip after 30 ticks, with new attack IDs', () => {
    const run = armed('boomerang', 5, true);
    const e = enemy(run, 210, 0, { radius: 1 });
    oneLaunch(run);
    const originalIds = run.attacks.map((a) => a.id);
    ticks(run, 149);
    expect(run.attacks.every((a) => a.kind === 'boomerang' && a.leg === 'waiting')).toBe(true);
    expect(e.hp).toBe(888);
    ticks(run, 29);
    expect(run.attacks.map((a) => a.id)).toEqual(originalIds);
    ticks(run, 1);
    expect(run.attacks.every((a) => !originalIds.includes(a.id))).toBe(true);
    ticks(run, 149);
    expect(e.hp).toBe(776);
    expect(run.attacks).toHaveLength(0);
  });

  it('emits waves without a target, hits each enemy once and respects knockback immunity', () => {
    const empty = armed('wave');
    ticks(empty, 1);
    expect(empty.attacks[0].kind).toBe('wave');
    const run = armed('wave');
    const regular = enemy(run, 100);
    const immune = enemy(run, -100, 0, { knockbackImmune: true });
    const beyond = enemy(run, 170);
    oneLaunch(run);
    ticks(run, 17);
    expect(regular.hp).toBe(978);
    expect(immune.hp).toBe(978);
    expect(beyond.hp).toBe(1000);
    expect(regular.x).toBeGreaterThan(run.player.x + 100);
    expect(immune.x).toBe(run.player.x - 100);
    expect(immune.recoil).toBeUndefined();
    expect(run.attacks).toHaveLength(0);
  });

  it('repeats lion roar at +24 ticks with independent hits and no third pulse', () => {
    const run = armed('wave', 5, true);
    const e = enemy(run, 100, 0, { knockbackImmune: true });
    oneLaunch(run);
    const firstId = run.attacks[0].id;
    ticks(run, 23);
    expect(e.hp).toBe(917);
    expect(run.attacks[0].id).toBe(firstId);
    ticks(run, 1);
    expect(run.attacks[0].id).not.toBe(firstId);
    ticks(run, 17);
    expect(e.hp).toBe(834);
    expect(run.attacks).toHaveLength(0);
  });

  it('shares a 30-tick gate across all orbit balls even with 50% cooldown reduction', () => {
    const run = armed('orbit', 5);
    run.player.stats.cooldownReduction = 0.5;
    const e = enemy(run, 0, 0, { radius: 120, damage: 0 });
    run.player.invulnerableUntilTick = 10000;
    ticks(run, 1);
    expect(run.attacks).toHaveLength(3);
    expect(e.hp).toBe(975);
    ticks(run, 29);
    expect(e.hp).toBe(975);
    ticks(run, 1);
    expect(e.hp).toBe(950);
    expect(e.orbitHitUntilTick).toBe(61);
  });

  it('orbits at radius 95, follows player movement and scales angular speed without changing damage gates', () => {
    const normal = armed('orbit');
    const fast = armed('orbit');
    fast.player.stats.cooldownReduction = 0.5;
    stepSurvivor(normal, FIXED_STEP, { moveX: 1, moveY: 0 });
    stepSurvivor(fast, FIXED_STEP, { moveX: 1, moveY: 0 });
    expect(normal.orbitAngle).toBeCloseTo((Math.PI * 2) / 60);
    expect(fast.orbitAngle).toBeCloseTo(normal.orbitAngle * 2);
    for (const run of [normal, fast])
      expect(
        Math.hypot(run.attacks[0].x - run.player.x, run.attacks[0].y - run.player.y),
      ).toBeCloseTo(95);
    const e = enemy(normal, -95);
    ticks(normal, 29);
    expect(e.hp).toBe(990);
  });

  it('shares trail damage between overlapping areas, chooses the stronger hit and keeps fixed duration', () => {
    const run = armed('trail');
    run.player.stats.cooldownReduction = 0.5;
    const e = enemy(run, 50);
    oneLaunch(run);
    expect(e.hp).toBe(994);
    const first = run.attacks[0];
    expect(first.kind).toBe('trail');
    run.attacks.push({ ...first, id: run.nextAttackId++, damage: 15, hitIds: [] });
    ticks(run, 29);
    expect(e.hp).toBe(994);
    ticks(run, 1);
    expect(e.hp).toBe(979);
    ticks(run, 149);
    expect(run.tick).toBe(180);
    expect(run.attacks).toHaveLength(2);
    expect(e.hp).toBe(919); // Six shared ticks: 6 + 5*15.
    ticks(run, 1);
    expect(run.attacks).toHaveLength(0);
  });

  it('does not turn rank-up ball redistribution into a damaging teleport across the orbit', () => {
    const run = armed('orbit', 3);
    ticks(run, 1);
    const old = run.attacks[1];
    const nextAngle = run.orbitAngle + (Math.PI * 2) / 60 + (Math.PI * 2) / 3;
    const nextX = run.player.x + Math.cos(nextAngle) * 95;
    const nextY = run.player.y + Math.sin(nextAngle) * 95;
    const e = enemy(run, (old.x + nextX) / 2 - run.player.x, (old.y + nextY) / 2 - run.player.y, {
      radius: 1,
    });
    run.weapons[0].rank = 5;
    ticks(run, 1);
    expect(run.attacks).toHaveLength(3);
    expect(e.hp).toBe(1000);
  });

  it('creates trail areas every reduced cooldown while leaving them at their original positions', () => {
    const run = armed('trail', 3);
    run.player.stats.cooldownReduction = 0.5;
    ticks(run, 1);
    const first = structuredClone(run.attacks[0]);
    for (let i = 0; i < 35; i++) stepSurvivor(run, FIXED_STEP, { moveX: 1, moveY: 0 });
    expect(run.attacks).toHaveLength(1);
    ticks(run, 1);
    expect(run.attacks).toHaveLength(2);
    expect(run.attacks[0]).toEqual(first);
    expect(run.attacks[1].x).toBeGreaterThan(first.x);
    expect(run.attacks[0].kind === 'trail' && run.attacks[0].endTick).toBe(241);
  });

  it('locks distinct acorn targets, waits 30 ticks and explodes only once at telegraphed positions', () => {
    const run = armed('acorn', 5);
    const a = enemy(run, 200);
    const b = enemy(run, -200);
    const c = enemy(run, 0, 400);
    enemy(run, 0, -521);
    run.enemies.reverse();
    oneLaunch(run);
    expect(run.attacks.map((attack) => [attack.x, attack.y])).toEqual([
      [a.x, a.y],
      [b.x, b.y],
      [c.x, c.y],
    ]);
    c.y += 100; // Evades the fixed warning circle.
    ticks(run, 29);
    expect(a.hp).toBe(1000);
    expect(run.attacks.every((attack) => attack.kind === 'acorn' && !attack.exploded)).toBe(true);
    ticks(run, 1);
    expect(a.hp).toBe(935);
    expect(b.hp).toBe(935);
    expect(c.hp).toBe(1000);
    ticks(run, 6);
    expect(a.hp).toBe(935);
    expect(run.attacks).toHaveLength(0);
  });

  it('launches fewer acorns when distinct targets run out and waits when there are none', () => {
    const run = armed('acorn', 5);
    ticks(run, 50);
    expect(run.attacks).toHaveLength(0);
    expect(run.weaponTimers.acorn).toBe(0);
    enemy(run, 520);
    ticks(run, 1);
    expect(run.attacks).toHaveLength(1);
  });

  it('reaps a simultaneous multi-weapon kill only once and resets pooled enemy damage gates', () => {
    const run = armed('bite');
    run.weapons.push(
      { id: 'boomerang', rank: 5, evolved: false },
      { id: 'trail', rank: 5, evolved: false },
    );
    const e = enemy(run, 70, 0, {
      hp: 1,
      orbitHitUntilTick: 999,
      trailHitUntilTick: 999,
      recoil: { x: 1, y: 0 },
    });
    ticks(run, 1);
    expect(run.kills).toBe(1);
    expect(run.drops).toHaveLength(1);
    expect(run.drops[0].value).toBe(3);
    run.nextSpawnTick = 2;
    ticks(run, 1);
    const spawned = run.enemies[0];
    expect(spawned).toBe(e); // Pool reuse is intentional.
    expect(spawned.orbitHitUntilTick).toBe(0);
    expect(spawned.trailHitUntilTick).toBe(0);
    expect(spawned.recoil).toBeUndefined();
    expect(run.kills).toBe(1);
  });

  it('freezes projectiles, warnings, echoes and RNG while choosing or paused', () => {
    const run = armed('boomerang', 5, true);
    run.weapons.push(
      { id: 'wave', rank: 5, evolved: true },
      { id: 'acorn', rank: 5, evolved: false },
    );
    enemy(run, 300);
    ticks(run, 5);
    pauseSurvivor(run);
    const snapshot = structuredClone(run);
    stepSurvivor(run, 300);
    expect(run).toEqual(snapshot);
    resumeSurvivor(run);
    run.drops.push({
      id: run.nextEntityId++,
      x: run.player.x,
      y: run.player.y,
      kind: 'xp',
      value: 6,
    });
    ticks(run, 1);
    expect(run.phase).toBe('choosing');
    const choosing = structuredClone(run);
    stepSurvivor(run, 300);
    expect(run).toEqual(choosing);
    chooseSurvivorCard(run, run.choice!.id, run.choice!.cards[0].id);
    ticks(run, 1);
    expect(run.tick).toBe(7);
    expect(run.attacks).not.toEqual(choosing.attacks);
  });

  it('caps attacks at 240 and skips a saturated launch without accumulating a burst', () => {
    const run = armed('trail');
    for (let i = 0; i < LIMITS.attacks; i++)
      run.attacks.push({
        id: run.nextAttackId++,
        kind: 'trail',
        x: 100,
        y: 100,
        endTick: 2,
        radius: 65,
        damage: 6,
        hitIds: [],
      });
    ticks(run, 1);
    expect(run.attacks).toHaveLength(240);
    expect(run.weaponTimers.trail).toBe(73);
    ticks(run, 1);
    expect(run.attacks).toHaveLength(0);
    ticks(run, 70);
    expect(run.attacks).toHaveLength(0);
    ticks(run, 1);
    expect(run.attacks).toHaveLength(1);
    expect(run.nextAttackId).toBe(242);
  });

  it('keeps physical states equal at 30/60/120Hz across all weapons and evolved echoes', () => {
    const simulate = (hz: number, weaponIds: WeaponId[]) => {
      const run = newSurvivor(42);
      run.weapons = weaponIds.map((id) => ({
        id,
        rank: 5,
        evolved: id === 'boomerang' || id === 'wave',
      }));
      run.player.invulnerableUntilTick = 10000;
      for (let i = 0; i < 12; i++)
        enemy(run, Math.cos(i) * 220, Math.sin(i) * 220, { hp: 10000, knockbackImmune: true });
      for (let frame = 0; frame < hz * 10; frame++) stepSurvivor(run, 1 / hz);
      return run;
    };
    for (const loadout of [
      ['bite', 'boomerang', 'wave', 'orbit'],
      ['trail', 'acorn', 'orbit', 'boomerang'],
    ] as WeaponId[][]) {
      const expected = simulate(60, loadout);
      expect(simulate(30, loadout)).toEqual(expected);
      expect(simulate(120, loadout)).toEqual(expected);
      expect(expected.tick).toBe(600);
      expect(expected.attacks.length).toBeLessThan(LIMITS.attacks);
      expect(expected.enemies.some((e) => e.hp < 10000)).toBe(true);
    }
  });

  it('does not mutate existing attack snapshots when a weapon or damage stat is upgraded', () => {
    const run = armed('boomerang');
    enemy(run, 300);
    ticks(run, 1);
    expect(run.attacks[0].damage).toBe(16);
    run.weapons[0].rank = 5;
    run.player.stats.attackBonus = 0.5;
    ticks(run, 84);
    expect(run.attacks[0].damage).toBe(16);
    expect(run.attacks.slice(1).every((a) => a.damage === 60)).toBe(true);
    expect(run.attacks).toHaveLength(4);
    expect(WEAPON_RULES.sharedHitInterval).toBe(30);
  });
});
