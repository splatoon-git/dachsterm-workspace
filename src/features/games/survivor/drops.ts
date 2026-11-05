import { DROP_RULES, LIMITS, MAX_LEVEL, isElite, xpToNextLevel } from './content';
import { distanceSquared } from './geometry';
import { collectSurvivorGold } from './progression';
import { nextRandom } from './random';
import type { DropKind, Point, SurvivorDrop, SurvivorEnemy, SurvivorRun } from './types';

const pools = new WeakMap<SurvivorRun, SurvivorDrop[]>();
function poolFor(run: SurvivorRun): SurvivorDrop[] {
  let pool = pools.get(run);
  if (!pool) {
    pool = [];
    pools.set(run, pool);
  }
  return pool;
}
function nearestDrop(run: SurvivorRun, kind: DropKind, point: Point): SurvivorDrop | undefined {
  let nearest: SurvivorDrop | undefined;
  let distance = Infinity;
  for (const drop of run.drops) {
    if (drop.kind !== kind) continue;
    const d = distanceSquared(drop, point);
    if (d < distance || (d === distance && (!nearest || drop.id < nearest.id))) {
      nearest = drop;
      distance = d;
    }
  }
  return nearest;
}

export function addSurvivorDrop(
  run: SurvivorRun,
  kind: DropKind,
  value: number,
  point: Point,
): void {
  if (!Number.isFinite(value) || value <= 0) return;
  if (run.drops.length >= LIMITS.drops) {
    const nearest = nearestDrop(run, kind, point);
    if (nearest) {
      nearest.value += value;
      return;
    }
    // First drop of a missing kind: consolidate the closest same-kind pair to make room.
    // With 250 drops and three kinds a pair always exists; never mix XP/gold/healing.
    let pair: [number, number] | undefined;
    let distance = Infinity;
    let ids = [Infinity, Infinity];
    for (let i = 0; i < run.drops.length; i++)
      for (let j = i + 1; j < run.drops.length; j++) {
        const a = run.drops[i];
        const b = run.drops[j];
        if (a.kind !== b.kind) continue;
        const d = distanceSquared(a, b);
        const low = Math.min(a.id, b.id);
        const high = Math.max(a.id, b.id);
        if (
          d < distance ||
          (d === distance && (low < ids[0] || (low === ids[0] && high < ids[1])))
        ) {
          pair = a.id < b.id ? [i, j] : [j, i];
          distance = d;
          ids = [low, high];
        }
      }
    if (pair) {
      run.drops[pair[0]].value += run.drops[pair[1]].value;
      poolFor(run).push(run.drops.splice(pair[1], 1)[0]);
    }
  }
  const drop = poolFor(run).pop() ?? ({} as SurvivorDrop);
  Object.assign(drop, {
    id: run.nextEntityId++,
    kind,
    value,
    x: point.x,
    y: point.y,
  } satisfies SurvivorDrop);
  run.drops.push(drop);
}
export function dropEnemyLoot(run: SurvivorRun, enemy: SurvivorEnemy): void {
  if (enemy.kind === 'boss') return;
  addSurvivorDrop(run, 'xp', enemy.xp, enemy);
  if (isElite(enemy.kind)) {
    addSurvivorDrop(run, 'gold', DROP_RULES.eliteGold, enemy);
    addSurvivorDrop(run, 'heal', 1, enemy);
  } else {
    const gold = nextRandom(run.random.drops);
    const heal = nextRandom(gold.state);
    run.random.drops = heal.state;
    if (gold.value < DROP_RULES.goldChance) addSurvivorDrop(run, 'gold', 1, enemy);
    if (heal.value < DROP_RULES.healChance) addSurvivorDrop(run, 'heal', 1, enemy);
  }
}
export function collectSurvivorDrops(run: SurvivorRun): void {
  let remaining = 0;
  let xp = 0;
  for (const drop of run.drops) {
    if (distanceSquared(run.player, drop) <= run.player.stats.pickupRadius ** 2) {
      if (drop.kind === 'xp') xp += drop.value;
      else if (drop.kind === 'gold') collectSurvivorGold(run, drop.value);
      else
        run.player.hp = Math.min(
          run.player.stats.maxHp,
          run.player.hp + run.player.stats.maxHp * DROP_RULES.healFraction * drop.value,
        );
      poolFor(run).push(drop);
    } else run.drops[remaining++] = drop;
  }
  run.drops.length = remaining;
  if (run.level >= MAX_LEVEL) return;
  run.xp += xp * (1 + run.player.stats.experienceBonus);
  while (run.level < MAX_LEVEL && run.xp >= xpToNextLevel(run.level)) {
    run.xp -= xpToNextLevel(run.level);
    run.level++;
    run.pendingChoices++;
  }
  if (run.level === MAX_LEVEL) run.xp = 0;
}
