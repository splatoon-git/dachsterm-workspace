import {
  BASE_STATS,
  BITE,
  FIXED_STEP,
  INVULNERABLE_TICKS,
  LIMITS,
  MAX_CATCH_UP_TICKS,
  MAX_LEVEL,
  PLAYER_RADIUS,
  RECOIL_DECAY,
  RECOIL_SPEED,
  SLIME,
  SPAWN,
  SURVIVOR_CONTENT_VERSION,
  VIEW,
  WORLD,
  xpToNextLevel,
} from './content';
import { nextRandom, seedStreams } from './random';
import { EnemyGrid } from './spatial';
import type {
  Point,
  SurvivorDrop,
  SurvivorEnemy,
  SurvivorInput,
  SurvivorRun,
} from './types';

const IDLE: SurvivorInput = { moveX: 0, moveY: 0 };
const EPSILON = 1e-12;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const distanceSquared = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

// Scratch/pools are not gameplay state and never affect random draws or ordering.
// Weak ownership lets a closed game release the entire simulation and its buffers.
type Scratch = { grid: EnemyGrid; enemies: SurvivorEnemy[]; drops: SurvivorDrop[] };
const scratchByRun = new WeakMap<SurvivorRun, Scratch>();
function scratchFor(run: SurvivorRun): Scratch {
  let scratch = scratchByRun.get(run);
  if (!scratch) {
    scratch = { grid: new EnemyGrid(), enemies: [], drops: [] };
    scratchByRun.set(run, scratch);
  }
  return scratch;
}

export function newSurvivor(seed = 1): SurvivorRun {
  const normalizedSeed = Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 1;
  return {
    contentVersion: SURVIVOR_CONTENT_VERSION,
    seed: normalizedSeed,
    phase: 'playing',
    pausedFrom: null,
    tick: 0,
    accumulator: 0,
    nextSpawnTick: SPAWN.intervalTicks,
    random: seedStreams(normalizedSeed),
    nextEntityId: 1,
    player: {
      x: WORLD.width / 2,
      y: WORLD.height / 2,
      radius: PLAYER_RADIUS,
      hp: BASE_STATS.maxHp,
      stats: { ...BASE_STATS },
      facing: { x: 1, y: 0 },
      recoil: { x: 0, y: 0 },
      invulnerableUntilTick: 0,
    },
    enemies: [],
    drops: [],
    bite: { nextReadyTick: 0, sequence: 0, lastAttack: null },
    kills: 0,
    level: 1,
    xp: 0,
    pendingChoices: 0,
    lastDamage: null,
    result: null,
  };
}

export function survivorCamera(run: SurvivorRun): Point {
  return {
    x: clamp(run.player.x - VIEW.width / 2, 0, WORLD.width - VIEW.width),
    y: clamp(run.player.y - VIEW.height / 2, 0, WORLD.height - VIEW.height),
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

function chasePlayer(run: SurvivorRun) {
  for (const e of run.enemies) {
    const dx = run.player.x - e.x;
    const dy = run.player.y - e.y;
    const distance = Math.hypot(dx, dy);
    if (!distance) continue;
    const travel = Math.min(distance, e.speed * FIXED_STEP);
    e.x = clamp(e.x + (dx / distance) * travel, e.radius, WORLD.width - e.radius);
    e.y = clamp(e.y + (dy / distance) * travel, e.radius, WORLD.height - e.radius);
  }
}

// Exact circle/sector intersection, including either radial edge and the tip.
function inBite(origin: Point, direction: Point, e: SurvivorEnemy): boolean {
  const dx = e.x - origin.x;
  const dy = e.y - origin.y;
  const distance = Math.hypot(dx, dy);
  if (distance > BITE.radius + e.radius) return false;
  const forward = dx * direction.x + dy * direction.y;
  const sideways = Math.abs(dx * direction.y - dy * direction.x);
  const cos = Math.cos(BITE.halfAngle);
  const sin = Math.sin(BITE.halfAngle);
  if (distance === 0 || forward >= distance * cos) return true;
  const alongEdge = clamp(forward * cos + sideways * sin, 0, BITE.radius);
  return (forward - alongEdge * cos) ** 2 + (sideways - alongEdge * sin) ** 2 <= e.radius ** 2;
}

function bite(run: SurvivorRun, grid: EnemyGrid) {
  if (run.tick < run.bite.nextReadyTick) return;
  let target: SurvivorEnemy | undefined;
  let nearest = Infinity;
  grid.visit(run.player.x, run.player.y, BITE.radius + SLIME.radius, (e) => {
    const distance = distanceSquared(run.player, e);
    if (e.hp <= 0 || distance > (BITE.radius + e.radius) ** 2) return;
    if (distance < nearest || (distance === nearest && (!target || e.id < target.id))) {
      target = e;
      nearest = distance;
    }
  });
  if (!target) return; // Waiting for a target does not spend or bank attacks.
  const distance = Math.sqrt(nearest);
  const direction = distance
    ? { x: (target.x - run.player.x) / distance, y: (target.y - run.player.y) / distance }
    : { ...run.player.facing };
  const attack = {
    id: ++run.bite.sequence,
    tick: run.tick,
    origin: { x: run.player.x, y: run.player.y },
    direction,
    hitIds: [] as number[],
  };
  const damage = Math.round(BITE.damage * (1 + run.player.stats.attackBonus));
  grid.visit(run.player.x, run.player.y, BITE.radius + SLIME.radius, (e) => {
    if (e.hp <= 0 || !inBite(run.player, direction, e)) return;
    e.hp = Math.max(0, e.hp - damage);
    attack.hitIds.push(e.id);
  });
  attack.hitIds.sort((a, b) => a - b);
  run.bite.lastAttack = attack;
  run.bite.nextReadyTick =
    run.tick +
    Math.ceil(BITE.cooldownTicks * Math.max(0.5, 1 - run.player.stats.cooldownReduction));
}

function addXpDrop(run: SurvivorRun, enemy: SurvivorEnemy, scratch: Scratch) {
  if (run.drops.length >= LIMITS.drops) {
    let nearest = run.drops[0];
    let distance = distanceSquared(nearest, enemy);
    for (const drop of run.drops) {
      const candidate = distanceSquared(drop, enemy);
      if (candidate < distance || (candidate === distance && drop.id < nearest.id)) {
        nearest = drop;
        distance = candidate;
      }
    }
    nearest.value += enemy.xp;
    return;
  }
  const drop = scratch.drops.pop() ?? ({} as SurvivorDrop);
  Object.assign(drop, {
    id: run.nextEntityId++,
    kind: 'xp',
    x: enemy.x,
    y: enemy.y,
    value: enemy.xp,
  } satisfies SurvivorDrop);
  run.drops.push(drop);
}

function reapEnemies(run: SurvivorRun, scratch: Scratch) {
  let alive = 0;
  for (const enemy of run.enemies) {
    if (enemy.hp > 0) run.enemies[alive++] = enemy;
    else {
      run.kills++;
      addXpDrop(run, enemy, scratch);
      scratch.enemies.push(enemy);
    }
  }
  run.enemies.length = alive;
}

function contactDamage(run: SurvivorRun, grid: EnemyGrid) {
  const p = run.player;
  if (run.tick < p.invulnerableUntilTick) return;
  let source: SurvivorEnemy | undefined;
  grid.visit(p.x, p.y, p.radius + SLIME.radius, (e) => {
    if (e.hp <= 0 || distanceSquared(p, e) > (p.radius + e.radius) ** 2) return;
    // One shared damage window; deterministic strongest contact wins this tick.
    if (!source || e.damage > source.damage || (e.damage === source.damage && e.id < source.id))
      source = e;
  });
  if (!source) return;
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

function collectXp(run: SurvivorRun, scratch: Scratch) {
  let remaining = 0;
  let xp = 0;
  for (const drop of run.drops) {
    if (distanceSquared(run.player, drop) <= run.player.stats.pickupRadius ** 2) {
      xp += drop.value;
      scratch.drops.push(drop);
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
  if (run.pendingChoices > 0) run.phase = 'choosing';
}

function spawnSlime(run: SurvivorRun, scratch: Scratch) {
  if (run.tick < run.nextSpawnTick) return;
  run.nextSpawnTick += SPAWN.intervalTicks;
  if (run.enemies.length >= LIMITS.enemies) return;
  const camera = survivorCamera(run);
  const random = () => {
    const next = nextRandom(run.random.spawn);
    run.random.spawn = next.state;
    return next.value;
  };
  for (let attempt = 0; attempt < SPAWN.attempts; attempt++) {
    const angle = random() * Math.PI * 2;
    const distance = SPAWN.ringMin + random() * (SPAWN.ringMax - SPAWN.ringMin);
    const x = run.player.x + Math.cos(angle) * distance;
    const y = run.player.y + Math.sin(angle) * distance;
    const r = SLIME.radius;
    if (x < r || x > WORLD.width - r || y < r || y > WORLD.height - r) continue;
    if (
      x + r >= camera.x &&
      x - r <= camera.x + VIEW.width &&
      y + r >= camera.y &&
      y - r <= camera.y + VIEW.height
    )
      continue;
    if (Math.hypot(x - run.player.x, y - run.player.y) < SPAWN.minDistance + r + run.player.radius)
      continue;
    const enemy = scratch.enemies.pop() ?? ({} as SurvivorEnemy);
    Object.assign(enemy, {
      id: run.nextEntityId++,
      kind: 'slime',
      x,
      y,
      radius: r,
      hp: SLIME.hp,
      maxHp: SLIME.hp,
      speed: SLIME.speed,
      damage: SLIME.damage,
      xp: SLIME.xp,
    } satisfies SurvivorEnemy);
    run.enemies.push(enemy);
    return;
  }
}

function tickSurvivor(run: SurvivorRun, input: SurvivorInput) {
  const scratch = scratchFor(run);
  run.tick++;
  movePlayer(run, input);
  chasePlayer(run);
  scratch.grid.rebuild(run.enemies);
  bite(run, scratch.grid);
  contactDamage(run, scratch.grid);
  reapEnemies(run, scratch);
  if (run.player.hp <= 0) {
    run.phase = 'result';
    run.result = 'defeat';
    return; // Death precedes pickups/level choices in the same tick.
  }
  collectXp(run, scratch);
  if (run.phase === 'playing') spawnSlime(run, scratch);
}
