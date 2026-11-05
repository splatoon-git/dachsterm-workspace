import {
  ENEMIES,
  ENEMY_RULES,
  FIXED_STEP,
  LIMITS,
  RECOIL_DECAY,
  SPAWN,
  VIEW,
  WORLD,
  isElite,
  stageParameters,
} from './content';
import { clamp, distanceSquared, segmentHitsCircle, survivorCamera } from './geometry';
import { nextRandom } from './random';
import type {
  EnemyBehavior,
  EnemyHit,
  EnemyKind,
  EnemyProjectile,
  SurvivorEnemy,
  SurvivorRun,
} from './types';

type Pool = { enemies: SurvivorEnemy[]; projectiles: EnemyProjectile[] };
const pools = new WeakMap<SurvivorRun, Pool>();
function poolFor(run: SurvivorRun): Pool {
  let pool = pools.get(run);
  if (!pool) {
    pool = { enemies: [], projectiles: [] };
    pools.set(run, pool);
  }
  return pool;
}
export function spawnRandom(run: SurvivorRun): number {
  const next = nextRandom(run.random.spawn);
  run.random.spawn = next.state;
  return next.value;
}
export function recycleEnemy(run: SurvivorRun, enemy: SurvivorEnemy): void {
  poolFor(run).enemies.push(enemy);
}
export function clearEnemyProjectiles(run: SurvivorRun): void {
  poolFor(run).projectiles.push(...run.enemyProjectiles);
  run.enemyProjectiles.length = 0;
}
export function clearEnemies(run: SurvivorRun): void {
  poolFor(run).enemies.push(...run.enemies);
  run.enemies.length = 0;
  clearEnemyProjectiles(run);
}
function initialBehavior(kind: EnemyKind, tick: number): EnemyBehavior | undefined {
  if (kind === 'slime' || kind === 'bat' || kind === 'golem') return undefined;
  return {
    mode: 'chase',
    action: kind === 'mushroom' ? 'shoot' : kind === 'giantSlime' ? 'leap' : 'charge',
    untilTick: 0,
    readyTick: tick + (kind === 'boss' ? 0 : ENEMY_RULES[kind].cooldown),
    direction: { x: 1, y: 0 },
    target: { x: 0, y: 0 },
  };
}

/** All categories use the same off-screen safety test; elites have reserved capacity. */
export function spawnEnemy(run: SurvivorRun, kind: EnemyKind): SurvivorEnemy | null {
  const category = (k: EnemyKind) => (k === 'boss' ? 'bosses' : isElite(k) ? 'elites' : 'enemies');
  const group = category(kind);
  if (run.enemies.filter((e) => category(e.kind) === group).length >= LIMITS[group]) return null;
  const camera = survivorCamera(run);
  const base = ENEMIES[kind];
  const r = base.radius;
  for (let attempt = 0; attempt < SPAWN.attempts; attempt++) {
    const angle = spawnRandom(run) * Math.PI * 2;
    const distance = SPAWN.ringMin + spawnRandom(run) * (SPAWN.ringMax - SPAWN.ringMin);
    const x = run.player.x + Math.cos(angle) * distance;
    const y = run.player.y + Math.sin(angle) * distance;
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
    const params = stageParameters(run.stage.index);
    const damageScale = kind === 'boss' ? params.bossDamageScale : params.damageScale;
    const hp = Math.round(base.hp * (kind === 'boss' ? params.bossHpScale : params.hpScale));
    const enemy = poolFor(run).enemies.pop() ?? ({} as SurvivorEnemy);
    Object.assign(enemy, {
      id: run.nextEntityId++,
      kind,
      x,
      y,
      radius: r,
      hp,
      maxHp: hp,
      speed: base.speed,
      damage: base.damage * damageScale,
      damageScale,
      xp: isElite(kind) ? base.xp : base.xp * params.xpScale,
      recoil: undefined,
      knockbackImmune: kind === 'boss',
      orbitHitUntilTick: 0,
      trailHitUntilTick: 0,
      behavior: initialBehavior(kind, run.tick),
    } satisfies SurvivorEnemy);
    run.enemies.push(enemy);
    return enemy;
  }
  return null;
}

function move(enemy: SurvivorEnemy, dx: number, dy: number) {
  enemy.x = clamp(enemy.x + dx, enemy.radius, WORLD.width - enemy.radius);
  enemy.y = clamp(enemy.y + dy, enemy.radius, WORLD.height - enemy.radius);
}
function pursue(run: SurvivorRun, enemy: SurvivorEnemy, speed: number, stopAt = 0) {
  const dx = run.player.x - enemy.x;
  const dy = run.player.y - enemy.y;
  const distance = Math.hypot(dx, dy);
  const travel = Math.min(Math.max(0, distance - stopAt), speed * FIXED_STEP);
  if (distance) move(enemy, (dx / distance) * travel, (dy / distance) * travel);
}
function recovery(run: SurvivorRun, enemy: SurvivorEnemy, ticks: number) {
  const ai = enemy.behavior!;
  ai.mode = 'recovery';
  ai.untilTick =
    run.tick + Math.ceil(ticks * (enemy.kind === 'boss' && enemy.hp <= enemy.maxHp / 2 ? 0.8 : 1));
}
function fire(run: SurvivorRun, enemy: SurvivorEnemy) {
  const boss = enemy.kind === 'boss';
  const rules = ENEMY_RULES.boss;
  const count = boss ? (enemy.hp <= enemy.maxHp / 2 ? 7 : 5) : 1;
  const direction = enemy.behavior!.direction;
  const angle = Math.atan2(direction.y, direction.x);
  for (let i = 0; i < count; i++) {
    if (run.enemyProjectiles.length >= LIMITS.enemyProjectiles) break;
    const a = angle + (count > 1 ? (i / (count - 1) - 0.5) * rules.spread : 0);
    const speed = boss ? rules.projectileSpeed : ENEMY_RULES.mushroom.projectileSpeed;
    const projectile = poolFor(run).projectiles.pop() ?? ({} as EnemyProjectile);
    Object.assign(projectile, {
      id: run.nextEntityId++,
      x: enemy.x,
      y: enemy.y,
      radius: ENEMY_RULES.projectileRadius,
      velocity: { x: Math.cos(a) * speed, y: Math.sin(a) * speed },
      damage:
        (boss ? rules.projectileDamage : ENEMY_RULES.mushroom.damage) * (enemy.damageScale ?? 1),
      endTick: run.tick + ENEMY_RULES.projectileLifetime,
    } satisfies EnemyProjectile);
    run.enemyProjectiles.push(projectile);
  }
}

/** Telegraph target/direction are fixed at windup start, available to the renderer. */
function behave(run: SurvivorRun, enemy: SurvivorEnemy, hit: (value: EnemyHit) => void): boolean {
  const ai = enemy.behavior;
  if (!ai) {
    pursue(run, enemy, enemy.speed);
    return false;
  }
  const kind = enemy.kind;
  if (kind === 'slime' || kind === 'bat' || kind === 'golem') return false;
  const rules = ENEMY_RULES[kind];
  const boss = kind === 'boss';
  const speedFactor = boss && run.stage.bossTicks >= ENEMY_RULES.boss.enrageTick ? 1.15 : 1;
  if (ai.mode === 'recovery' && run.tick >= ai.untilTick) {
    ai.mode = 'chase';
    if (boss) {
      ai.action = ai.action === 'charge' ? 'shoot' : ai.action === 'shoot' ? 'leap' : 'charge';
      ai.readyTick = run.tick;
    }
  }
  if (ai.mode === 'chase') {
    const distance = Math.sqrt(distanceSquared(run.player, enemy));
    if (run.tick >= ai.readyTick && distance <= rules.trigger) {
      ai.mode = 'windup';
      const dx = run.player.x - enemy.x;
      const dy = run.player.y - enemy.y;
      const length = Math.hypot(dx, dy);
      ai.direction = { x: length ? dx / length : 1, y: length ? dy / length : 0 };
      ai.target = {
        x: clamp(run.player.x, enemy.radius, WORLD.width - enemy.radius),
        y: clamp(run.player.y, enemy.radius, WORLD.height - enemy.radius),
      };
      const warning = boss
        ? ai.action === 'charge'
          ? ENEMY_RULES.boss.chargeWarning
          : ai.action === 'shoot'
            ? ENEMY_RULES.boss.shootWarning
            : ENEMY_RULES.boss.leapWarning
        : ENEMY_RULES[kind].warning;
      ai.untilTick = run.tick + warning;
      if (!boss) ai.readyTick = run.tick + ENEMY_RULES[kind].cooldown;
    } else
      pursue(
        run,
        enemy,
        enemy.speed * speedFactor,
        kind === 'mushroom' ? ENEMY_RULES.mushroom.range : 0,
      );
  } else if (ai.mode === 'windup' && run.tick >= ai.untilTick) {
    if (ai.action === 'charge') {
      ai.mode = 'charge';
      ai.untilTick =
        run.tick +
        (boss
          ? ENEMY_RULES.boss.charge
          : kind === 'armoredBoar'
            ? ENEMY_RULES.armoredBoar.charge
            : ENEMY_RULES.boar.charge);
    } else if (ai.action === 'shoot') {
      fire(run, enemy);
      recovery(run, enemy, boss ? ENEMY_RULES.boss.recovery : 1);
    } else {
      enemy.x = ai.target.x;
      enemy.y = ai.target.y;
      const radius = boss ? ENEMY_RULES.boss.leapRadius : ENEMY_RULES.giantSlime.radius;
      if (distanceSquared(run.player, enemy) <= (radius + run.player.radius) ** 2)
        hit({
          id: enemy.id,
          x: enemy.x,
          y: enemy.y,
          damage: boss ? ENEMY_RULES.boss.leapDamage * (enemy.damageScale ?? 1) : enemy.damage,
        });
      recovery(run, enemy, boss ? ENEMY_RULES.boss.leapRecovery : ENEMY_RULES.giantSlime.recovery);
      return true; // Teleport path is not a charging/contact segment.
    }
  }
  if (ai.mode === 'charge') {
    if (run.tick >= ai.untilTick)
      recovery(
        run,
        enemy,
        boss
          ? ENEMY_RULES.boss.recovery
          : kind === 'armoredBoar'
            ? ENEMY_RULES.armoredBoar.recovery
            : ENEMY_RULES.boar.recovery,
      );
    else {
      const speed =
        (boss
          ? ENEMY_RULES.boss.chargeSpeed
          : kind === 'armoredBoar'
            ? ENEMY_RULES.armoredBoar.speed
            : ENEMY_RULES.boar.speed) * speedFactor;
      move(enemy, ai.direction.x * speed * FIXED_STEP, ai.direction.y * speed * FIXED_STEP);
    }
  }
  return false;
}

/** Resolve enemy attacks before weapon kills: simultaneous lethal boss hits remain lethal. */
export function stepEnemies(run: SurvivorRun): EnemyHit | null {
  let strongest: EnemyHit | null = null;
  const hit = (value: EnemyHit) => {
    if (
      !strongest ||
      value.damage > strongest.damage ||
      (value.damage === strongest.damage && value.id < strongest.id)
    )
      strongest = { id: value.id, x: value.x, y: value.y, damage: value.damage };
  };
  // Advance existing bullets first. New shots start travelling on the following tick.
  let remaining = 0;
  for (const projectile of run.enemyProjectiles) {
    const from = { x: projectile.x, y: projectile.y };
    projectile.x += projectile.velocity.x * FIXED_STEP;
    projectile.y += projectile.velocity.y * FIXED_STEP;
    const expired = run.tick >= projectile.endTick;
    const collision =
      !expired &&
      segmentHitsCircle(from, projectile, run.player, projectile.radius + run.player.radius);
    if (collision) hit(projectile);
    if (
      expired ||
      collision ||
      projectile.x < 0 ||
      projectile.y < 0 ||
      projectile.x > WORLD.width ||
      projectile.y > WORLD.height
    )
      poolFor(run).projectiles.push(projectile);
    else run.enemyProjectiles[remaining++] = projectile;
  }
  run.enemyProjectiles.length = remaining;
  for (const enemy of run.enemies) {
    if (enemy.hp <= 0) continue;
    const from = { x: enemy.x, y: enemy.y };
    const leaped = behave(run, enemy, hit);
    if (enemy.recoil && !enemy.knockbackImmune) {
      move(enemy, enemy.recoil.x * FIXED_STEP, enemy.recoil.y * FIXED_STEP);
      enemy.recoil.x *= RECOIL_DECAY;
      enemy.recoil.y *= RECOIL_DECAY;
    }
    if (
      segmentHitsCircle(leaped ? enemy : from, enemy, run.player, enemy.radius + run.player.radius)
    )
      hit({ id: enemy.id, x: enemy.x, y: enemy.y, damage: enemy.damage });
  }
  // Copy: a hit projectile may already be pooled and reused by a shot this tick.
  return strongest;
}
