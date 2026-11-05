import { describe, expect, it } from 'vitest';
import {
  EVOLUTION_TICK,
  FIXED_STEP,
  LIMITS,
  STAGE,
  stageElite,
  stageEnemyKind,
  stageParameters,
} from './content';
import {
  continueSurvivorStage,
  finishSurvivor,
  newSurvivor,
  pauseSurvivor,
  resumeSurvivor,
  stepSurvivor,
} from './engine';
import { spawnEnemy } from './enemies';
import { addSurvivorDrop } from './drops';
import { chooseSurvivorCard, eligibleCards } from './progression';
import { initialStage, resolveStageTransition } from './stages';
import type { SurvivorRun } from './types';

function ticks(run: SurvivorRun, count: number) {
  for (let i = 0; i < count; i++) stepSurvivor(run, FIXED_STEP);
}
function fixture(index = 1): SurvivorRun {
  const run = newSurvivor(42);
  run.stage = initialStage(index);
  run.highestReachedStage = index;
  run.nextSpawnTick = Infinity;
  run.player.invulnerableUntilTick = Infinity;
  return run;
}
function endWave(run: SurvivorRun) {
  run.stage.waveTicks = STAGE.waveTicks - 1;
  ticks(run, 1);
}
function startBoss(run: SurvivorRun) {
  endWave(run);
  expect(run.stage.phase).toBe('bossWarning');
  ticks(run, STAGE.warningTicks);
  expect(run.stage.phase).toBe('boss');
  return run.enemies.find((e) => e.id === run.stage.bossId)!;
}
function selectAll(run: SurvivorRun) {
  while (run.choice)
    expect(chooseSurvivorCard(run, run.choice.id, run.choice.cards[0].id)).toBe(true);
}

describe('G.8.3 continuous stages', () => {
  it('ends a wave exactly at 3600 ticks and freezes the clear screen', () => {
    const run = fixture();
    ticks(run, 3599);
    expect(run.phase).toBe('playing');
    expect(stepSurvivor(run, 1)).toBe(1);
    expect(run.tick).toBe(3600);
    expect(run.stage.waveTicks).toBe(3600);
    expect(run.highestCompletedStage).toBe(1);
    expect(run.result).toBeNull();
    const snapshot = structuredClone(run);
    ticks(run, 100);
    pauseSurvivor(run);
    resumeSurvivor(run);
    expect(run).toEqual(snapshot);
  });

  it('retires enemies and bullets without kill loot while preserving player attacks and drops', () => {
    const run = fixture(2);
    spawnEnemy(run, 'giantSlime');
    spawnEnemy(run, 'slime');
    run.attacks.push({
      id: run.nextAttackId++,
      kind: 'trail',
      x: 100,
      y: 100,
      radius: 65,
      damage: 6,
      hitIds: [],
      endTick: 9999,
    });
    run.enemyProjectiles.push({
      id: run.nextEntityId++,
      x: 100,
      y: 100,
      radius: 8,
      damage: 10,
      velocity: { x: 0, y: 0 },
      endTick: 9999,
    });
    addSurvivorDrop(run, 'gold', 2.25, { x: 200, y: 200 });
    endWave(run);
    expect(run.enemies).toHaveLength(0);
    expect(run.enemyProjectiles).toHaveLength(0);
    expect(run.kills).toBe(0);
    expect(run.gold).toBe(0);
    expect(run.attacks).toHaveLength(1);
    expect(run.drops.map((d) => [d.kind, d.value])).toEqual([['gold', 2.25]]);
  });

  it('continues without resetting growth, timers, IDs, position, RNG or fractional rewards', () => {
    const run = fixture();
    run.tick = 3400;
    run.level = 20;
    run.xp = 1.75;
    run.gold = 12.25;
    run.rerolls = 0;
    run.weapons = [{ id: 'bite', rank: 5, evolved: true }];
    run.abilities = [{ id: 'fangs', rank: 4 }];
    run.player.hp = 37;
    run.player.x = 2010;
    run.bite.nextReadyTick = 9999;
    run.weaponTimers.wave = 4444;
    addSurvivorDrop(run, 'xp', 7.5, { x: 500, y: 500 });
    endWave(run);
    const before = structuredClone(run);
    expect(continueSurvivorStage(run, 2)).toBe(false);
    expect(continueSurvivorStage(run, 1)).toBe(true);
    for (const key of [
      'tick',
      'player',
      'level',
      'xp',
      'gold',
      'rerolls',
      'weapons',
      'abilities',
      'attacks',
      'drops',
      'bite',
      'weaponTimers',
      'random',
      'nextEntityId',
      'nextAttackId',
      'choiceSequence',
    ] as const)
      expect(run[key]).toEqual(before[key]);
    expect(run.stage).toEqual(initialStage(2));
    expect(run.highestReachedStage).toBe(2);
    expect(run.highestCompletedStage).toBe(1);
    expect(run.nextSpawnTick).toBeCloseTo(run.tick + 60 / 1.4);
    const next = structuredClone(run);
    expect(continueSurvivorStage(run, 1)).toBe(false);
    expect(run).toEqual(next);
    endWave(run);
    const clear2 = structuredClone(run);
    expect(continueSurvivorStage(run, 1)).toBe(false);
    expect(run).toEqual(clear2);
  });

  it.each([1, 3])(
    'resolves consecutive boundary cards without an extra tick (stage %i)',
    (index) => {
      const run = fixture(index);
      addSurvivorDrop(run, 'xp', 20, run.player);
      endWave(run);
      expect(run.phase).toBe('choosing');
      expect(run.pendingChoices).toBe(2);
      expect(run.highestCompletedStage).toBe(index === 1 ? 1 : 0);
      expect(run.stage.pendingTransition).toBe(index === 1 ? 'stageClear' : 'bossWarning');
      const tick = run.tick;
      pauseSurvivor(run);
      const frozen = structuredClone(run);
      ticks(run, 20);
      expect(run).toEqual(frozen);
      resumeSurvivor(run);
      selectAll(run);
      expect(run.tick).toBe(tick);
      expect(run.phase).toBe(index === 1 ? 'stageClear' : 'playing');
      expect(run.stage.warningTicks).toBe(index === 3 ? 90 : 0);
    },
  );

  it('pauses warning at a level-up and creates one boss immediately after its final card', () => {
    const run = fixture(3);
    endWave(run);
    ticks(run, 89);
    expect(run.stage.warningTicks).toBe(1);
    expect(run.enemies).toHaveLength(0);
    addSurvivorDrop(run, 'xp', 6, run.player);
    ticks(run, 1);
    expect(run.stage.pendingTransition).toBe('boss');
    expect(run.stage.bossSpawned).toBe(false);
    const tick = run.tick;
    selectAll(run);
    expect(run.tick).toBe(tick);
    expect(run.stage.bossTicks).toBe(0);
    expect(run.enemies).toHaveLength(1);
    resolveStageTransition(run);
    expect(run.enemies).toHaveLength(1);
    ticks(run, 1);
    expect(run.stage.bossTicks).toBe(1);
    expect(run.stage.waveTicks).toBe(3600);
  });

  it('continues through bosses 3 and 6 to stage 7, qualifying each fixed reward only once', () => {
    const run = fixture();
    run.player.stats.goldBonus = 10;
    run.gold = 25.75;
    for (let stage = 1; stage <= 6; stage++) {
      run.nextSpawnTick = Infinity;
      if (stage % 3 === 0) {
        const boss = startBoss(run);
        expect(boss.maxHp).toBe(stage === 3 ? 3000 : 4800);
        expect(boss.damage).toBeCloseTo(stage === 3 ? 25 : 28.75);
        boss.x = run.player.x + 80;
        boss.y = run.player.y;
        boss.hp = 1;
        run.bite.nextReadyTick = 0;
        addSurvivorDrop(run, 'xp', 20, run.player);
        ticks(run, 1);
        expect(run.highestCompletedStage).toBe(stage);
        expect(run.bossesDefeated).toBe(stage / 3);
        expect(run.bossRewardGold).toBe((stage / 3) * 40);
        expect(run.lastRewardedBossStage).toBe(stage);
        expect(run.result).toBeNull();
        const tick = run.tick;
        selectAll(run);
        expect(run.tick).toBe(tick);
      } else endWave(run);
      expect(run.phase).toBe('stageClear');
      const rewards = run.bossRewardGold;
      ticks(run, 20);
      resolveStageTransition(run);
      expect(run.bossRewardGold).toBe(rewards);
      expect(continueSurvivorStage(run, stage)).toBe(true);
      expect(continueSurvivorStage(run, stage)).toBe(false);
    }
    expect(run.stage.index).toBe(7);
    expect(run.highestCompletedStage).toBe(6);
    expect(run.gold).toBe(25.75);
    expect(run.bossRewardGold).toBe(80);
  });

  it('prioritizes a simultaneous lethal boss contact over healing, XP, clear and reward', () => {
    const run = fixture(3);
    const boss = startBoss(run);
    run.player.invulnerableUntilTick = 0;
    run.player.hp = 1;
    boss.x = run.player.x;
    boss.y = run.player.y;
    boss.hp = 1;
    addSurvivorDrop(run, 'heal', 100, run.player);
    addSurvivorDrop(run, 'xp', 1000, run.player);
    ticks(run, 1);
    expect(run.result).toBe('defeat');
    expect(run.player.hp).toBe(0);
    expect(run.level).toBe(1);
    expect(run.bossRewardGold).toBe(0);
    expect(run.bossesDefeated).toBe(0);
    expect(run.highestCompletedStage).toBe(0);
    expect(run.stage.pendingTransition).toBeNull();
    expect(run.enemies).toHaveLength(0);
  });

  it('prioritizes death at a wave boundary too', () => {
    const run = fixture();
    const enemy = spawnEnemy(run, 'golem')!;
    enemy.x = run.player.x;
    enemy.y = run.player.y;
    run.player.hp = 1;
    run.player.invulnerableUntilTick = 0;
    endWave(run);
    expect(run.result).toBe('defeat');
    expect(run.highestCompletedStage).toBe(0);
  });

  it('retains cumulative three-minute evolution eligibility through stage transitions', () => {
    const run = fixture();
    run.weapons[0].rank = 5;
    run.bite.nextReadyTick = Infinity;
    run.abilities = [{ id: 'fangs', rank: 3 }];
    for (let index = 1; index <= 3; index++) {
      run.nextSpawnTick = Infinity;
      ticks(run, 3599);
      if (index === 3) {
        expect(run.tick).toBe(EVOLUTION_TICK - 1);
        expect(eligibleCards(run).some((c) => c.kind === 'evolution')).toBe(false);
      }
      ticks(run, 1);
      if (index < 3) expect(continueSurvivorStage(run, index)).toBe(true);
    }
    expect(run.tick).toBe(EVOLUTION_TICK);
    expect(eligibleCards(run).some((c) => c.kind === 'evolution')).toBe(true);
  });

  it('spawns each scheduled alternating elite once, with capacity independent of ordinary enemies', () => {
    expect(Array.from({ length: 16 }, (_, i) => stageElite(i + 1))).toEqual([
      null,
      'giantSlime',
      null,
      'armoredBoar',
      null,
      null,
      null,
      'giantSlime',
      null,
      'armoredBoar',
      null,
      null,
      null,
      'giantSlime',
      null,
      'armoredBoar',
    ]);
    const run = fixture(2);
    for (let i = 0; i < LIMITS.enemies; i++) expect(spawnEnemy(run, 'slime')).not.toBeNull();
    expect(spawnEnemy(run, 'bat')).toBeNull();
    run.stage.waveTicks = 1798;
    ticks(run, 1);
    expect(run.enemies.some((e) => e.kind === 'giantSlime')).toBe(false);
    ticks(run, 1);
    expect(run.enemies.filter((e) => e.kind === 'giantSlime')).toHaveLength(1);
    const elite = run.enemies.find((e) => e.kind === 'giantSlime')!;
    expect(elite.maxHp).toBe(717);
    expect(elite.xp).toBe(40);
    expect(elite.damage).toBeCloseTo(21.2);
    expect(spawnEnemy(run, 'armoredBoar')).not.toBeNull();
    expect(spawnEnemy(run, 'giantSlime')).toBeNull();
    ticks(run, 10);
    expect(run.enemies).toHaveLength(182);
  });

  it('accumulates fractional spawn intervals and never banks capped or late spawns', () => {
    const run = fixture(2);
    run.nextSpawnTick = 60 / 1.4;
    run.bite.nextReadyTick = Infinity;
    ticks(run, 42);
    expect(run.enemies).toHaveLength(0);
    ticks(run, 1);
    expect(run.enemies).toHaveLength(1);
    ticks(run, 17);
    expect(run.nextSpawnTick).toBeCloseTo(120 / 1.4);
    ticks(run, 540);
    expect(run.enemies).toHaveLength(14);
    run.nextSpawnTick = 1;
    const count = run.enemies.length;
    ticks(run, 1);
    expect(run.enemies.length - count).toBe(1);
    expect(run.nextSpawnTick).toBeGreaterThan(run.tick);
    ticks(run, 1);
    expect(run.enemies).toHaveLength(count + 1);
  });

  it('caps scaling, retains speed and snapshots damage/XP at spawn', () => {
    expect(stageParameters(1000000)).toMatchObject({
      spawnRate: 4.8,
      hpScale: 20,
      damageScale: 3,
      xpScale: 2.5,
      bossHpScale: 10,
      bossDamageScale: 3,
    });
    expect([0, 0.15, 0.4, 0.6, 0.8].map((r) => stageEnemyKind(5, r))).toEqual([
      'slime',
      'bat',
      'mushroom',
      'golem',
      'boar',
    ]);
    const run = fixture(20);
    const enemy = spawnEnemy(run, 'mushroom')!;
    expect(enemy.speed).toBe(55);
    expect(enemy.xp).toBe(12.5);
    const before = structuredClone(enemy);
    run.stage.index = 200;
    expect(enemy).toEqual(before);
  });

  it('distinguishes retirement/abandonment, preserves earned totals and rejects repeated or stale finish input', () => {
    const run = fixture();
    expect(finishSurvivor(run, 'retired', 1)).toBe(false);
    run.gold = 12.75;
    run.bossRewardGold = 40;
    endWave(run);
    expect(finishSurvivor(run, 'retired', 0)).toBe(false);
    expect(finishSurvivor(run, 'retired', 1)).toBe(true);
    expect(run.result).toBe('retired');
    expect(run.gold).toBe(12.75);
    expect(run.bossRewardGold).toBe(40);
    const snapshot = structuredClone(run);
    expect(finishSurvivor(run, 'abandoned')).toBe(false);
    expect(continueSurvivorStage(run, 1)).toBe(false);
    expect(run).toEqual(snapshot);
    const abandoned = fixture();
    addSurvivorDrop(abandoned, 'xp', 100, abandoned.player);
    ticks(abandoned, 1);
    pauseSurvivor(abandoned);
    expect(finishSurvivor(abandoned, 'abandoned')).toBe(true);
    expect(abandoned.pendingChoices).toBe(0);
    expect(abandoned.choice).toBeNull();
    resumeSurvivor(abandoned);
    expect(abandoned.phase).toBe('result');
  });

  it('keeps long-run event state bounded through 120 cleared stages', () => {
    const run = fixture();
    run.level = 40;
    run.xp = 0;
    for (let s = 1; s <= 120; s++) {
      run.nextSpawnTick = Infinity;
      if (s % 3 === 0) {
        const boss = startBoss(run);
        boss.hp = 1;
        boss.x = run.player.x + 80;
        boss.y = run.player.y;
        run.bite.nextReadyTick = 0;
        ticks(run, 1);
      } else endWave(run);
      expect(run.phase).toBe('stageClear');
      expect(run.enemies).toHaveLength(0);
      expect(run.enemyProjectiles).toHaveLength(0);
      expect(continueSurvivorStage(run, s)).toBe(true);
      expect(Object.keys(run.stage)).toHaveLength(9);
    }
    expect(run.bossesDefeated).toBe(40);
    expect(run.bossRewardGold).toBe(1600);
    expect(run.highestReachedStage).toBe(121);
    expect(run.level).toBe(40);
    expect(run.pendingChoices).toBe(0);
    expect(run.drops.length).toBeLessThanOrEqual(LIMITS.drops);
  });

  it('retries a failed safe boss search without duplicating the warning, boss or reward', () => {
    let retries = 0;
    for (let seed = 0; seed < 50; seed++) {
      const run = newSurvivor(seed);
      run.stage = initialStage(3);
      run.player.x = run.player.y = 20;
      endWave(run);
      ticks(run, 90);
      if (!run.stage.bossSpawned) {
        retries++;
        expect(run.stage.pendingTransition).toBe('boss');
        expect(run.stage.warningTicks).toBe(0);
        for (let attempt = 0; attempt < 60 && !run.stage.bossSpawned; attempt++) ticks(run, 1);
      }
      expect(run.stage.bossSpawned).toBe(true);
      expect(run.enemies.filter((e) => e.kind === 'boss')).toHaveLength(1);
      expect(run.bossRewardGold).toBe(0);
    }
    expect(retries).toBeGreaterThan(0);
  });

  it('reproduces six full stage clocks, mixed spawns and two scripted boss kills at 30/60/120Hz', () => {
    const simulate = (hz: number) => {
      const run = newSurvivor(42);
      run.player.invulnerableUntilTick = Infinity;
      run.level = 40;
      run.bite.nextReadyTick = Infinity;
      let frames = 0;
      while (run.stage.index < 7 && frames++ < hz * 400) {
        const boss = run.enemies.find((e) => e.id === run.stage.bossId);
        if (boss) {
          boss.hp = 1;
          boss.x = run.player.x + 80;
          boss.y = run.player.y;
          run.bite.nextReadyTick = 0;
        }
        stepSurvivor(run, 1 / hz);
        if (run.phase === 'stageClear') {
          expect(continueSurvivorStage(run, run.stage.index)).toBe(true);
          run.bite.nextReadyTick = Infinity;
        }
      }
      expect(run.stage.index).toBe(7);
      expect(run.bossRewardGold).toBe(80);
      return run;
    };
    const expected = simulate(60);
    expect(simulate(30)).toEqual(expected);
    expect(simulate(120)).toEqual(expected);
  });
});
