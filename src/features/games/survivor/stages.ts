import { STAGE, stageElite, stageEnemyKind, stageParameters } from './content';
import { clearEnemies, clearEnemyProjectiles, spawnEnemy, spawnRandom } from './enemies';
import type { SurvivorRun, SurvivorStage } from './types';

export function initialStage(index = 1): SurvivorStage {
  return {
    index,
    phase: 'wave',
    waveTicks: 0,
    bossTicks: 0,
    warningTicks: 0,
    eliteSpawned: false,
    bossSpawned: false,
    bossId: null,
    pendingTransition: null,
  };
}
export function advanceStageClock(run: SurvivorRun): void {
  if (run.stage.phase === 'wave') run.stage.waveTicks++;
  else if (run.stage.phase === 'boss') run.stage.bossTicks++;
  else run.stage.warningTicks = Math.max(0, run.stage.warningTicks - 1);
}

/** Record qualification before presenting cards, so a checkpoint is self-consistent. */
export function evaluateStage(run: SurvivorRun, bossKilled: boolean): void {
  const stage = run.stage;
  if (run.player.hp <= 0 || stage.pendingTransition) return;
  if (stage.phase === 'wave' && stage.waveTicks >= STAGE.waveTicks) {
    if (stage.index % 3 === 0) stage.pendingTransition = 'bossWarning';
    else {
      run.highestCompletedStage = stage.index;
      stage.pendingTransition = 'stageClear';
    }
  } else if (stage.phase === 'bossWarning' && stage.warningTicks === 0) {
    stage.pendingTransition = 'boss';
  } else if (
    stage.phase === 'boss' &&
    bossKilled &&
    stage.bossSpawned &&
    stage.index > run.lastRewardedBossStage
  ) {
    run.bossRewardGold += STAGE.bossReward;
    run.bossesDefeated++;
    run.lastRewardedBossStage = stage.index;
    run.highestCompletedStage = stage.index;
    stage.pendingTransition = 'stageClear';
    clearEnemyProjectiles(run);
  }
}

/** Also called by the last card selection. Never advances a combat tick. */
export function resolveStageTransition(run: SurvivorRun): void {
  const stage = run.stage;
  if (run.phase !== 'playing' || run.pendingChoices || !stage.pendingTransition) return;
  const next = stage.pendingTransition;
  if (next === 'boss') {
    if (stage.bossSpawned) return;
    const boss = spawnEnemy(run, 'boss');
    // Keep warning active and retry next tick if the bounded safety search failed.
    if (!boss) return;
    stage.bossSpawned = true;
    stage.bossId = boss.id;
    stage.phase = 'boss';
  } else {
    clearEnemies(run); // Retirement is not a kill and gives no XP or drops.
    if (next === 'bossWarning') {
      stage.phase = 'bossWarning';
      stage.warningTicks = STAGE.warningTicks;
    } else run.phase = 'stageClear';
  }
  stage.pendingTransition = null;
}

export function spawnStageEnemies(run: SurvivorRun): void {
  const stage = run.stage;
  if (stage.phase !== 'wave' || stage.pendingTransition || stage.waveTicks >= STAGE.waveTicks)
    return;
  const elite = stageElite(stage.index);
  if (elite && !stage.eliteSpawned && stage.waveTicks >= STAGE.eliteTick) {
    stage.eliteSpawned = true; // A skipped unsafe/capped spawn is not banked.
    spawnEnemy(run, elite);
  }
  if (run.tick + 1e-9 < run.nextSpawnTick) return;
  const interval = 60 / stageParameters(stage.index).spawnRate;
  run.nextSpawnTick += interval;
  if (run.nextSpawnTick <= run.tick) run.nextSpawnTick = run.tick + interval;
  spawnEnemy(run, stageEnemyKind(stage.index, spawnRandom(run)));
}

export function continueSurvivorStage(run: SurvivorRun, expectedStageIndex: number): boolean {
  if (
    run.phase !== 'stageClear' ||
    run.pendingChoices ||
    run.stage.pendingTransition ||
    expectedStageIndex !== run.stage.index ||
    !Number.isSafeInteger(expectedStageIndex + 1)
  )
    return false;
  clearEnemies(run);
  run.stage = initialStage(expectedStageIndex + 1);
  run.highestReachedStage = run.stage.index;
  run.nextSpawnTick = run.tick + 60 / stageParameters(run.stage.index).spawnRate;
  run.phase = 'playing';
  run.accumulator = 0;
  return true;
}

/** Retirement requires the current clear-screen number; abandonment works while paused/choosing. */
export function finishSurvivor(
  run: SurvivorRun,
  reason: 'retired' | 'abandoned',
  expectedStageIndex?: number,
): boolean {
  if (
    run.phase === 'result' ||
    (reason === 'retired' && (run.phase !== 'stageClear' || expectedStageIndex !== run.stage.index))
  )
    return false;
  endSurvivorRun(run, reason);
  return true;
}

/** Engine-only finalization; the public UI command cannot manufacture a defeat. */
export function endSurvivorRun(run: SurvivorRun, reason: NonNullable<SurvivorRun['result']>): void {
  run.result = reason;
  run.phase = 'result';
  run.pausedFrom = null;
  run.accumulator = 0;
  run.pendingChoices = 0;
  run.choice = null;
  run.stage.pendingTransition = null;
  // Uncollected drops are discarded only at run end. Totals remain for G.8.4 settlement.
  run.drops.length = 0;
  clearEnemies(run);
}
