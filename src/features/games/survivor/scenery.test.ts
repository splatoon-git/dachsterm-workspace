import { describe, expect, it } from 'vitest';
import { createScenery, regionForStage } from './scenery';
import { FIXED_STEP, LIMITS, stageEnemyKind, WORLD } from './content';
import { newSurvivor, stepSurvivor } from './engine';

describe('survivor region composition and crowd pacing', () => {
  it('keeps an authored region stable for three stages, and varies later visits and seeds', () => {
    const forest = createScenery(42, 1);
    expect(createScenery(42, 2)).toEqual(forest);
    expect(createScenery(42, 3)).toEqual(forest);
    expect(createScenery(43, 1).props).not.toEqual(forest.props);
    expect(createScenery(42, 13).biome).toBe(forest.biome);
    expect(createScenery(42, 13).props).not.toEqual(forest.props);
    expect([1, 4, 7, 10, 13].map((s) => regionForStage(s).biome)).toEqual([0, 1, 2, 3, 0]);
  });
  it('bounds scenery memory and leaves start and persistent run state untouched', () => {
    const run = newSurvivor(42),
      before = structuredClone(run);
    for (let stage = 1; stage < 121; stage += 3) {
      const map = createScenery(run.seed, stage);
      expect(map.props.length).toBe(400);
      expect(map.landmarks.length).toBe(6);
      for (const p of [...map.props, ...map.landmarks]) {
        expect(p.x).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(WORLD.width);
        expect(p.y).toBeGreaterThan(0);
        expect(p.y).toBeLessThan(WORLD.height);
      }
    }
    expect(run).toEqual(before);
  });
  it('introduces two early silhouettes, three at stage 2 and distinct later regional mixes', () => {
    const kinds = (s: number) =>
      Array.from({ length: 100 }, (_, i) => stageEnemyKind(s, (i + 0.5) / 100));
    expect(new Set(kinds(1))).toEqual(new Set(['slime', 'bat']));
    expect(new Set(kinds(2))).toEqual(new Set(['slime', 'bat', 'mushroom']));
    for (const s of [5, 7, 10, 13]) expect(new Set(kinds(s)).size).toBe(5);
    expect(kinds(7)).not.toEqual(kinds(10));
  });
  it('provides a fuller opening crowd without raising simultaneous limits or touching reward RNG', () => {
    for (const seed of [1, 42, 11305]) {
      const run = newSurvivor(seed);
      run.bite.nextReadyTick = Infinity;
      run.player.invulnerableUntilTick = Infinity;
      const random = { ...run.random };
      for (let i = 0; i < 1200; i++) stepSurvivor(run, FIXED_STEP);
      expect(run.enemies.length).toBeGreaterThanOrEqual(27);
      expect(run.enemies.length).toBeLessThanOrEqual(28);
      expect(
        run.enemies.filter((e) => Math.hypot(e.x - run.player.x, e.y - run.player.y) < 270).length,
      ).toBeGreaterThan(12);
      expect(run.enemies.length).toBeLessThan(LIMITS.enemies);
      expect(run.random.cards).toBe(random.cards);
      expect(run.random.drops).toBe(random.drops);
    }
  });
});
