import { describe, expect, it } from 'vitest';
import {
  newAdventure,
  nextAdventure,
  stepAdventure,
  jumpAdventure,
  biteAdventure,
  stompAdventure,
  adventureCamera,
  platformAvailable,
  type Adventure,
  type AdventureInput,
} from './adventureEngine';
import { generateLevel, platformPosition, BIOMES, ventPhase } from './adventureLevels';
const frames = (state: Adventure, count: number, input: AdventureInput = { direction: 0 }) => {
  for (let i = 0; i < count; i++) state = stepAdventure(state, 1 / 60, input);
  return state;
};
const enemy = (x: number) => ({ ...newAdventure().enemies[0], x, origin: x, range: 0 });
const empty = (): Adventure => {
  const s = newAdventure();
  return {
    ...s,
    enemies: [],
    pickups: [],
    level: {
      ...s.level,
      gaps: [],
      spikes: [],
      platforms: [],
      vents: [],
      springs: [],
      gates: [],
      ice: [],
    },
  };
};
function pilot(s: Adventure): AdventureInput {
  const jump =
    s.grounded &&
    (s.level.spikes.some((p) => p.x - s.x > 0 && p.x - s.x < 65) ||
      s.level.gaps.some((g) => g.x - s.x > 0 && g.x - s.x < 30) ||
      s.level.vents.some((v) => v.x - s.x > 0 && v.x - s.x < 70) ||
      s.enemies.some((e) => e.alive && e.kind === 'bat' && e.x > s.x && e.x - s.x < 115));
  return {
    direction: 1,
    jump,
    bite:
      s.enemies.some((e) => e.alive && e.x > s.x && e.x - s.x < 92) ||
      s.level.gates.some(
        (g) => !s.switches.includes(g.id) && g.switchX >= s.x && g.switchX - s.x < 85,
      ),
  };
}
describe('닥스 랜덤 모험', () => {
  it('reproduces seeds and levels, varies layouts and keeps safe chunk/gap bounds', () => {
    expect(generateLevel(42, 2)).toEqual(generateLevel(42, 2));
    expect(generateLevel(42, 2)).not.toEqual(generateLevel(43, 2));
    for (let seed = 0; seed < 200; seed++)
      for (let index = 0; index < 4; index++) {
        const l = generateLevel(seed, index);
        expect(l.biome).toBe(BIOMES[index].id);
        for (const g of l.gaps) {
          expect(g.width).toBeLessThanOrEqual(160);
          expect(l.checkpoints.every((x) => x < g.x || x > g.x + g.width)).toBe(true);
        }
        for (const p of l.platforms) expect(p.y).toBeLessThanOrEqual(125);
        for (const enemy of l.enemies)
          for (const checkpoint of l.checkpoints)
            expect(Math.abs(enemy.x - checkpoint) - enemy.range).toBeGreaterThan(43);
        expect(l.chunks).toHaveLength(6);
      }
  });
  it('moves both directions, stops, and keeps the camera and distance bounded', () => {
    const start = empty();
    expect(frames(start, 90).x).toBe(100);
    const right = frames(start, 50, { direction: 1 });
    expect(right.x).toBeGreaterThan(280);
    expect(adventureCamera(right, 480)).toBeGreaterThan(0);
    const left = frames(right, 40, { direction: -1 });
    expect(left.x).toBeLessThan(right.x);
    expect(left.facing).toBe(-1);
    expect(frames(left, 20).vx).toBe(0);
    expect(frames(left, 150, { direction: -1 }).x).toBe(42);
    expect(left.distance).toBeGreaterThanOrEqual(right.distance);
    expect(adventureCamera({ ...start, x: 9999 }, 480)).toBe(start.level.end - 480);
    expect(start.x).toBe(100);
  });
  it('jumps and lands on platforms; buffered requests expire instead of becoming auto-jumps', () => {
    const base = empty();
    let s = jumpAdventure({
      ...base,
      level: { ...base.level, platforms: [{ id: 0, x: 50, y: 65, width: 120, kind: 'stone' }] },
    });
    s = frames(s, 12);
    expect(s.y).toBeGreaterThan(70);
    expect(jumpAdventure(s).velocity).toBe(s.velocity);
    s = frames(s, 40);
    expect(s.y).toBe(65);
    expect(s.grounded).toBe(true);
    const falling = { ...base, y: 3, velocity: -100, grounded: false, coyote: 0 };
    expect(
      frames(stepAdventure(falling, 1 / 60, { direction: 0, jump: true }), 5).velocity,
    ).toBeGreaterThan(0);
    expect(frames(jumpAdventure(frames(jumpAdventure(base), 12)), 60).grounded).toBe(true);
  });
  it('bites in the facing direction, handles airborne targets, and does not duplicate rewards', () => {
    const s = { ...empty(), enemies: [enemy(170), { ...enemy(30), id: 1 }] };
    const hit = stepAdventure(biteAdventure(s), 0.02);
    expect(hit.enemies[0].alive).toBe(false);
    expect(hit.enemies[1].alive).toBe(true);
    expect(hit.score).toBe(50);
    expect(biteAdventure(hit)).toBe(hit);
    expect(frames(hit, 5).score).toBe(50);
    expect(stepAdventure(biteAdventure({ ...s, facing: -1 }), 0.02).enemies[1].alive).toBe(false);
    expect(stepAdventure(biteAdventure({ ...s, y: 80 }), 0.02).enemies[0].alive).toBe(true);
    expect(s.enemies[0].alive).toBe(true);
  });
  it('stomps on a descending head crossing and bounces without taking side damage', () => {
    const s = {
      ...empty(),
      enemies: [enemy(100)],
      y: 40,
      velocity: -180,
      grounded: false,
      coyote: 0,
    };
    const hit = frames(s, 4);
    expect(hit.enemies[0].alive).toBe(false);
    expect(hit.health).toBe(5);
    expect(hit.score).toBe(75);
    expect(hit.velocity).toBeGreaterThan(0);
    expect(frames(hit, 5).score).toBe(75);
    const fast = stepAdventure(stompAdventure({ ...s, y: 42 }), 0.05);
    expect(fast.score).toBe(75);
    expect(fast.stomping).toBe(false);
    expect(fast.velocity).toBeGreaterThan(0);
    const side = stepAdventure({ ...s, y: 12 }, 0.02);
    expect(side.health).toBe(4);
    expect(side.enemies[0].alive).toBe(true);
    const rising = stepAdventure({ ...s, y: 20, velocity: 300 }, 0.02);
    expect(rising.enemies[0].alive).toBe(true);
  });
  it('fast descent is airborne only, has no ground shockwave, and lands normally', () => {
    const s = empty();
    expect(stompAdventure(s)).toBe(s);
    const down = stompAdventure({ ...s, y: 80, grounded: false });
    expect(down.velocity).toBe(-780);
    const landed = frames({ ...down, enemies: [enemy(170)] }, 20);
    expect(landed.grounded).toBe(true);
    expect(landed.stomping).toBe(false);
    expect(landed.enemies[0].alive).toBe(true);
  });
  it('carries the player on moving platforms and restores collapsed platforms', () => {
    const base = empty();
    const p = { id: 0, x: 100, y: 65, width: 150, kind: 'moving' as const, travel: 60, phase: 0 };
    const carried = frames(
      { ...base, x: 150, y: 65, platformId: 0, level: { ...base.level, platforms: [p] } },
      30,
    );
    expect(carried.x - 150).toBeCloseTo(platformPosition(p, 0.5).x - p.x, 2);
    expect(carried.y).toBe(65);
    const crumble = { ...p, kind: 'crumble' as const };
    const cracked = frames(
      { ...base, x: 150, y: 65, level: { ...base.level, platforms: [crumble] } },
      45,
    );
    expect(platformAvailable(crumble, cracked)).toBe(false);
    expect(cracked.y).toBeLessThan(65);
    expect(platformAvailable(crumble, frames(cracked, 190))).toBe(true);
  });
  it('requires a nearby bite to open a gate and preserves switches after a fall', () => {
    const base = empty();
    const s = {
      ...base,
      x: 220,
      level: { ...base.level, gates: [{ id: 0, x: 300, switchX: 250 }] },
    };
    expect(frames(s, 50, { direction: 1 }).x).toBe(263);
    const open = stepAdventure(s, 0.02, { direction: 0, bite: true });
    expect(open.switches).toEqual([0]);
    expect(frames(open, 50, { direction: 1 }).x).toBeGreaterThan(300);
    expect(stepAdventure({ ...open, y: -170 }, 0.02).switches).toEqual([0]);
  });
  it('launches springs, makes ice slippery and gives steam a visible warning period', () => {
    const base = empty();
    const spring = stepAdventure({ ...base, level: { ...base.level, springs: [100] } }, 0.02);
    expect(spring.velocity).toBeGreaterThan(700);
    const ground = { ...base, vx: 255 };
    const ice = { ...ground, level: { ...base.level, ice: [{ x: 50, width: 500 }] } };
    expect(frames(ice, 15).vx).toBeGreaterThan(100);
    expect(frames(ground, 15).vx).toBe(0);
    expect(ventPhase(2.2, 0)).toBe('warning');
    expect(ventPhase(2.7, 0)).toBe('active');
    const v = { ...base, level: { ...base.level, vents: [{ x: 100, phase: 0 }] } };
    expect(stepAdventure({ ...v, elapsed: 2.2 }, 0.02).health).toBe(5);
    expect(stepAdventure({ ...v, elapsed: 2.7 }, 0.02).health).toBe(4);
  });
  it('distinguishes hopping, flight and telegraphed charging', () => {
    const base = empty();
    const s = {
      ...base,
      enemies: [
        { ...enemy(280), kind: 'boar' as const, range: 100 },
        { ...enemy(700), kind: 'hopper' as const, id: 1 },
        { ...enemy(900), kind: 'bat' as const, id: 2 },
      ],
    };
    const warning = frames(s, 10);
    expect(warning.enemies[0].mode).toBe('windup');
    const charge = frames(warning, 32);
    expect(charge.enemies[0].mode).toBe('charge');
    expect(warning.enemies[1].y).toBeGreaterThan(0);
    expect(warning.enemies[2].y).toBeGreaterThan(40);
  });
  it('handles invulnerability, checkpoints, death, restart and explicit stage transitions', () => {
    const s = { ...empty(), enemies: [enemy(110), { ...enemy(90), id: 1 }] };
    const hit = stepAdventure(s, 0.02);
    expect(hit.health).toBe(4);
    expect(frames(hit, 10).health).toBe(4);
    const dead = stepAdventure({ ...s, health: 1 }, 0.02);
    expect(dead.over).toBe(true);
    expect(stepAdventure(dead, 0.05)).toBe(dead);
    const rest = stepAdventure({ ...empty(), x: 1620, health: 3 }, 0.02);
    expect(rest.checkpoint).toBe(1620);
    expect(rest.health).toBe(4);
    const fall = stepAdventure({ ...rest, x: 2000, y: -170 }, 0.02);
    expect(fall.x).toBe(1620);
    expect(fall.health).toBe(3);
    const finish = stepAdventure({ ...empty(), x: 3760, score: 100 }, 0.02);
    expect(finish.won).toBe(true);
    expect(finish.score).toBe(300);
    expect(stepAdventure(finish, 1)).toBe(finish);
    const next = nextAdventure(finish);
    expect(next.level.index).toBe(1);
    expect(next.score).toBe(300);
    expect(next.distance).toBe(finish.distance);
    expect(next.over).toBe(false);
    expect(newAdventure(next.level.seed, next.level.index).score).toBe(0);
    expect(nextAdventure(hit)).toBe(hit);
  });
  it('completes generated maps across all biomes using only normal controls', () => {
    for (const seed of [0, 1, 42, 314159, 4294967295])
      for (let index = 0; index < 4; index++) {
        let s = newAdventure(seed, index);
        for (let i = 0; i < 3600 && !s.over; i++) s = stepAdventure(s, 1 / 60, pilot(s));
        expect(s.won, `seed=${seed} biome=${index} x=${Math.round(s.x)} health=${s.health}`).toBe(
          true,
        );
      }
  });
  it('keeps movement consistent across refresh rates', () => {
    const run = (hz: number) => {
      let s = jumpAdventure(empty());
      for (let i = 0; i < hz / 2; i++) s = stepAdventure(s, 1 / hz, { direction: 1 });
      return s;
    };
    expect(Math.abs(run(30).x - run(120).x)).toBeLessThan(1);
    expect(Math.abs(run(30).y - run(120).y)).toBeLessThan(1);
  });
});
