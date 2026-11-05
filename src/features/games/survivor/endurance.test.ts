import { describe, expect, it } from 'vitest';
import { simulate } from '../../../../tests/native/survivor-balance';
import { LIMITS, stageParameters } from './content';

describe('public-command survivor endurance (automated policy, not human difficulty)', () => {
  it.each([1, 42, 2026, 11305, 71037])(
    'unupgraded seed %s can defeat two bosses and enter stage 7',
    (seed) => {
      const r = simulate(seed);
      expect(r.stage).toBe(7);
      expect(r.bossGold).toBe(80);
      expect(r.stages.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(r.choices.length).toBeGreaterThan(10);
    },
    30000,
  );
  it('natural level 40 stops XP/cards and prolonged repeated bosses keep every cap', () => {
    const r = simulate(1, 31, 2700);
    expect(r.maxLevelSecond).not.toBeNull();
    expect(r.level).toBe(40);
    expect(r.xp).toBe(0);
    expect(r.choices).toHaveLength(39);
    expect(r.stage).toBeGreaterThan(15);
    expect(r.bossGold).toBe(Math.floor(r.stages.length / 3) * 40);
    expect(r.maxima.enemies).toBeLessThanOrEqual(LIMITS.enemies + LIMITS.elites + LIMITS.bosses);
    expect(r.maxima.attacks).toBeLessThanOrEqual(LIMITS.attacks);
    expect(r.maxima.drops).toBeLessThanOrEqual(LIMITS.drops);
    expect(r.maxima.bullets).toBeLessThanOrEqual(LIMITS.enemyProjectiles);
    expect(r.maxima.weapons).toBeLessThanOrEqual(4);
    expect(r.maxima.abilities).toBeLessThanOrEqual(4);
    expect(r.maxima.rank).toBeLessThanOrEqual(5);
    expect(r.maxima.evolutions).toBeLessThanOrEqual(2);
    expect(stageParameters(10000)).toEqual(stageParameters(100000));
  }, 60000);
});
