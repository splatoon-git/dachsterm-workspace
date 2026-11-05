// Test-only policy. It issues public movement/card/stage commands; never changes run stats.
import { newSurvivor, stepSurvivor } from '../../src/features/games/survivor/engine';
import { chooseSurvivorCard } from '../../src/features/games/survivor/progression';
import { continueSurvivorStage } from '../../src/features/games/survivor/stages';
import type { SurvivorCard, SurvivorRun } from '../../src/features/games/survivor/types';

export function cardScore(card: SurvivorCard, run: SurvivorRun) {
  if (card.kind === 'evolution') return 100;
  if (card.kind === 'reward') return card.target === 'heal' && run.player.hp < 65 ? 90 : 0;
  if (card.kind === 'weapon')
    return (
      { bite: 35, boomerang: 60, wave: 48, orbit: 58, trail: 40, acorn: 45 }[card.target] +
      (card.fromRank === 0 ? 15 : card.toRank * 2)
    );
  return {
    fangs: 44,
    tail: 50,
    heart: run.player.hp < 60 ? 70 : 30,
    fur: 32,
    feet: 18,
    nose: 24,
    wisdom: 26,
    luck: 10,
  }[card.target];
}

export function policyInput(run: SurvivorRun) {
  const p = run.player;
  const target = run.drops.reduce<(typeof run.drops)[number] | null>((best, d) => {
    const score = (v: typeof d) =>
      Math.hypot(v.x - p.x, v.y - p.y) / (v.kind === 'heal' && p.hp < p.stats.maxHp * 0.6 ? 3 : 1);
    return !best || score(d) < score(best) ? d : best;
  }, null);
  const boss = run.enemies.find((e) => e.kind === 'boss');
  // A close circle permits ranged attacks while avoiding the frozen telegraph target.
  const goal = boss
    ? {
        x: boss.x + Math.cos(run.tick / 85) * 180,
        y: boss.y + Math.sin(run.tick / 85) * 180,
      }
    : (target ?? p);
  let best = { moveX: 0, moveY: 0 },
    bestScore = -Infinity;
  for (let y = -1; y <= 1; y++)
    for (let x = -1; x <= 1; x++) {
      const len = Math.hypot(x, y) || 1;
      const nx = p.x + (x / len) * p.stats.moveSpeed * 0.28;
      const ny = p.y + (y / len) * p.stats.moveSpeed * 0.28;
      let score = -Math.hypot(goal.x - nx, goal.y - ny) * 0.15;
      if (nx < 120 || ny < 120 || nx > 3080 || ny > 3080) score -= 500;
      for (const e of run.enemies) {
        const dist = Math.hypot(e.x - nx, e.y - ny) - e.radius - p.radius;
        if (dist < 65) score -= (65 - dist) * (dist < 12 ? 8 : 1.5);
        if (e.behavior?.mode === 'windup' && e.behavior.action === 'leap') {
          const d = Math.hypot(e.behavior.target.x - nx, e.behavior.target.y - ny);
          if (d < 150) score -= (150 - d) * 5;
        }
      }
      for (const b of run.enemyProjectiles) {
        const d = Math.hypot(b.x + b.velocity.x * 0.2 - nx, b.y + b.velocity.y * 0.2 - ny);
        if (d < 60) score -= (60 - d) * 5;
      }
      if (score > bestScore) {
        bestScore = score;
        best = { moveX: x, moveY: y };
      }
    }
  return best;
}

export function simulate(seed: number, untilStage = 7, maxSeconds = 1200) {
  const run = newSurvivor(seed);
  const choices: { second: number; id: string }[] = [];
  const stages: {
    index: number;
    second: number;
    hp: number;
    level: number;
    gold: number;
    bossSeconds: number;
  }[] = [];
  const maxima = {
    enemies: 0,
    attacks: 0,
    drops: 0,
    bullets: 0,
    weapons: 0,
    abilities: 0,
    rank: 0,
    evolutions: 0,
  };
  let maxLevelSecond: number | null = null;
  let input = policyInput(run);
  while (run.phase !== 'result' && run.tick < maxSeconds * 60 && run.stage.index < untilStage) {
    if (run.phase === 'choosing' && run.choice) {
      const card = [...run.choice.cards].sort((a, b) => cardScore(b, run) - cardScore(a, run))[0];
      choices.push({ second: run.tick / 60, id: card.id });
      chooseSurvivorCard(run, run.choice.id, card.id);
    } else if (run.phase === 'stageClear') {
      stages.push({
        index: run.stage.index,
        second: run.tick / 60,
        hp: run.player.hp,
        level: run.level,
        gold: run.gold + run.bossRewardGold,
        bossSeconds: run.stage.bossTicks / 60,
      });
      continueSurvivorStage(run, run.stage.index);
    } else {
      if (run.tick % 12 === 0) input = policyInput(run);
      stepSurvivor(run, 1 / 60, input);
      maxima.enemies = Math.max(maxima.enemies, run.enemies.length);
      maxima.attacks = Math.max(maxima.attacks, run.attacks.length);
      maxima.drops = Math.max(maxima.drops, run.drops.length);
      maxima.bullets = Math.max(maxima.bullets, run.enemyProjectiles.length);
      maxima.weapons = Math.max(maxima.weapons, run.weapons.length);
      maxima.abilities = Math.max(maxima.abilities, run.abilities.length);
      maxima.rank = Math.max(
        maxima.rank,
        ...run.weapons.map((w) => w.rank),
        ...run.abilities.map((a) => a.rank),
      );
      maxima.evolutions = Math.max(maxima.evolutions, run.weapons.filter((w) => w.evolved).length);
      if (run.level === 40 && maxLevelSecond === null) maxLevelSecond = run.tick / 60;
    }
  }
  return {
    seed,
    phase: run.phase,
    second: run.tick / 60,
    stage: run.stage.index,
    hp: run.player.hp,
    level: run.level,
    kills: run.kills,
    collectedGold: run.gold,
    bossGold: run.bossRewardGold,
    goldPerHour: (run.gold + run.bossRewardGold) / (run.tick / 216000),
    weapons: run.weapons,
    abilities: run.abilities,
    choices,
    stages,
    maxima,
    maxLevelSecond,
    xp: run.xp,
  };
}
