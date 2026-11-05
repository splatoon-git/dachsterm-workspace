import {
  FIXED_STEP,
  INVULNERABLE_TICKS,
  MAX_CATCH_UP_TICKS,
  PLAYER_RADIUS,
  RECOIL_DECAY,
  RECOIL_SPEED,
  SPAWN,
  SURVIVOR_CONTENT_VERSION,
  WORLD,
} from './content';
import { seedStreams } from './random';
import { initialProgression, openSurvivorChoice } from './progression';
import { stepWeapons } from './weapons';
import { EnemyGrid } from './spatial';
import { clamp } from './geometry';
import { recycleEnemy, stepEnemies } from './enemies';
import { collectSurvivorDrops, dropEnemyLoot } from './drops';
import {
  advanceStageClock,
  evaluateStage,
  endSurvivorRun,
  initialStage,
  resolveStageTransition,
  spawnStageEnemies,
} from './stages';
import type { EnemyHit, SurvivorInput, SurvivorRun, SurvivorStartOptions } from './types';
export { survivorCamera } from './geometry';
export { continueSurvivorStage, finishSurvivor } from './stages';

const IDLE: SurvivorInput = { moveX: 0, moveY: 0 };
const EPSILON = 1e-12;
const grids = new WeakMap<SurvivorRun, EnemyGrid>();
function gridFor(run: SurvivorRun): EnemyGrid {
  let grid = grids.get(run);
  if (!grid) {
    grid = new EnemyGrid();
    grids.set(run, grid);
  }
  return grid;
}

export function newSurvivor(seed = 1, options: SurvivorStartOptions = {}): SurvivorRun {
  const start = initialProgression(options);
  const normalizedSeed = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 1;
  return {
    contentVersion: SURVIVOR_CONTENT_VERSION,
    seed: normalizedSeed,
    phase: 'playing',
    pausedFrom: null,
    tick: 0,
    stage: initialStage(),
    highestReachedStage: 1,
    highestCompletedStage: 0,
    bossRewardGold: 0,
    bossesDefeated: 0,
    lastRewardedBossStage: 0,
    accumulator: 0,
    nextSpawnTick: SPAWN.intervalTicks,
    random: seedStreams(normalizedSeed),
    nextEntityId: 1,
    player: {
      x: WORLD.width / 2,
      y: WORLD.height / 2,
      radius: PLAYER_RADIUS,
      hp: start.stats.maxHp,
      stats: start.stats,
      facing: { x: 1, y: 0 },
      recoil: { x: 0, y: 0 },
      invulnerableUntilTick: 0,
    },
    enemies: [],
    enemyProjectiles: [],
    drops: [],
    bite: { nextReadyTick: 0, sequence: 0, lastAttack: null },
    weapons: [{ id: 'bite', rank: 1, evolved: false }],
    abilities: [],
    startBonuses: start.bonuses,
    unlockedWeapons: start.unlockedWeapons,
    weaponTimers: { boomerang: 0, wave: 0, trail: 0, acorn: 0 },
    orbitAngle: 0,
    attacks: [],
    nextAttackId: 1,
    choice: null,
    choiceSequence: 0,
    rerolls: start.rerolls,
    gold: 0,
    kills: 0,
    level: 1,
    xp: 0,
    pendingChoices: 0,
    lastDamage: null,
    result: null,
  };
}

export function pauseSurvivor(run: SurvivorRun): void {
  if (run.phase !== 'playing' && run.phase !== 'choosing') return;
  run.pausedFrom = run.phase;
  run.phase = 'paused';
  run.accumulator = 0;
}

export function resumeSurvivor(run: SurvivorRun): void {
  if (run.phase !== 'paused' || !run.pausedFrom) return;
  run.phase = run.pausedFrom;
  run.pausedFrom = null;
  run.accumulator = 0;
}

/** Advances owned state in place. Input is held for this frame; dt is in seconds.
 * At most five 60Hz ticks are processed. Excess time is discarded, never queued.
 * A caller must stop its RAF while inactive and reset its wall-clock on resume.
 */
export function stepSurvivor(run: SurvivorRun, dt: number, input: SurvivorInput = IDLE): number {
  if (run.phase !== 'playing' || !Number.isFinite(dt) || dt <= 0) return 0;
  const available = Math.min(run.accumulator + dt, FIXED_STEP * MAX_CATCH_UP_TICKS);
  const count = Math.floor((available + EPSILON) / FIXED_STEP);
  run.accumulator = Math.max(0, available - count * FIXED_STEP);
  if (run.accumulator < EPSILON) run.accumulator = 0;
  let processed = 0;
  while (processed < count && run.phase === 'playing') {
    tickSurvivor(run, input);
    processed++;
  }
  if (run.phase !== 'playing') run.accumulator = 0;
  return processed;
}

function movePlayer(run: SurvivorRun, input: SurvivorInput) {
  const p = run.player;
  let dx = Number.isFinite(input.moveX) ? clamp(input.moveX, -1, 1) : 0;
  let dy = Number.isFinite(input.moveY) ? clamp(input.moveY, -1, 1) : 0;
  const magnitude = Math.hypot(dx, dy);
  if (magnitude > 1) {
    dx /= magnitude;
    dy /= magnitude;
  }
  if (magnitude > 0) {
    const length = Math.hypot(dx, dy);
    p.facing.x = dx / length;
    p.facing.y = dy / length;
  }
  p.x = clamp(
    p.x + (dx * p.stats.moveSpeed + p.recoil.x) * FIXED_STEP,
    p.radius,
    WORLD.width - p.radius,
  );
  p.y = clamp(
    p.y + (dy * p.stats.moveSpeed + p.recoil.y) * FIXED_STEP,
    p.radius,
    WORLD.height - p.radius,
  );
  p.recoil.x *= RECOIL_DECAY;
  p.recoil.y *= RECOIL_DECAY;
}

function reapEnemies(run: SurvivorRun): boolean {
  let alive = 0;
  let bossKilled = false;
  for (const enemy of run.enemies) {
    if (enemy.hp > 0) run.enemies[alive++] = enemy;
    else {
      run.kills++;
      if (enemy.kind === 'boss' && enemy.id === run.stage.bossId) bossKilled = true;
      dropEnemyLoot(run, enemy);
      recycleEnemy(run, enemy);
    }
  }
  run.enemies.length = alive;
  return bossKilled;
}

function damagePlayer(run: SurvivorRun, source: EnemyHit | null) {
  const p = run.player;
  if (!source || run.tick < p.invulnerableUntilTick) return;
  const amount = Math.max(1, Math.round(source.damage) - p.stats.armor);
  p.hp = Math.max(0, p.hp - amount);
  p.invulnerableUntilTick = run.tick + INVULNERABLE_TICKS;
  run.lastDamage = { tick: run.tick, amount };
  const dx = p.x - source.x;
  const dy = p.y - source.y;
  const length = Math.hypot(dx, dy);
  p.recoil.x = (length ? dx / length : -p.facing.x) * RECOIL_SPEED;
  p.recoil.y = (length ? dy / length : -p.facing.y) * RECOIL_SPEED;
}

function tickSurvivor(run: SurvivorRun, input: SurvivorInput) {
  const grid = gridFor(run);
  run.tick++;
  advanceStageClock(run);
  movePlayer(run, input);
  const hit = stepEnemies(run);
  grid.rebuild(run.enemies);
  stepWeapons(run, grid);
  damagePlayer(run, hit);
  const bossKilled = reapEnemies(run);
  if (run.player.hp <= 0) {
    endSurvivorRun(run, 'defeat');
    return; // Death precedes healing, XP, stage qualification and boss rewards.
  }
  collectSurvivorDrops(run);
  evaluateStage(run, bossKilled);
  // Schedule this tick's spawns before choosing, so the card screen cannot skip events.
  spawnStageEnemies(run);
  if (run.pendingChoices > 0) {
    run.phase = 'choosing';
    openSurvivorChoice(run);
  }
  resolveStageTransition(run);
}
