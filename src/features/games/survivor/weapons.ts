import {
  cooldownFactor,
  FIXED_STEP,
  LIMITS,
  WEAPON_IDS,
  WEAPON_RULES as RULES,
  weaponParameters,
} from './content';
import type { EnemyGrid } from './spatial';
import type { Point, SurvivorAttack, SurvivorEnemy, SurvivorRun } from './types';

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const distanceSquared = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
type AttackSpawn<T = SurvivorAttack> = T extends SurvivorAttack ? Omit<T, 'id'> : never;
const pools = new WeakMap<SurvivorRun, Partial<Record<SurvivorAttack['kind'], SurvivorAttack[]>>>();

function poolFor(run: SurvivorRun, kind: SurvivorAttack['kind']) {
  let pool = pools.get(run);
  if (!pool) {
    pool = {};
    pools.set(run, pool);
  }
  return pool[kind] ?? (pool[kind] = []);
}

function addAttack(run: SurvivorRun, data: AttackSpawn) {
  if (run.attacks.length >= LIMITS.attacks) return;
  const attack = Object.assign(poolFor(run, data.kind).pop() ?? {}, data, {
    id: run.nextAttackId++,
  }) as SurvivorAttack;
  run.attacks.push(attack);
}

function targets(run: SurvivorRun, grid: EnemyGrid, radius: number, includeBody = false) {
  const found: SurvivorEnemy[] = [];
  grid.visit(run.player.x, run.player.y, radius + (includeBody ? grid.maxRadius : 0), (e) => {
    if (e.hp > 0 && distanceSquared(run.player, e) <= (radius + (includeBody ? e.radius : 0)) ** 2)
      found.push(e);
  });
  return found.sort(
    (a, b) => distanceSquared(run.player, a) - distanceSquared(run.player, b) || a.id - b.id,
  );
}

function directionTo(origin: Point, target: Point, fallback: Point): Point {
  const length = Math.hypot(target.x - origin.x, target.y - origin.y);
  return length
    ? { x: (target.x - origin.x) / length, y: (target.y - origin.y) / length }
    : { ...fallback };
}

// Exact circle/sector intersection, including the radial edges and origin.
function inSector(
  origin: Point,
  direction: Point,
  e: SurvivorEnemy,
  radius: number,
  halfAngle: number,
) {
  const dx = e.x - origin.x;
  const dy = e.y - origin.y;
  const distance = Math.hypot(dx, dy);
  if (distance > radius + e.radius) return false;
  const forward = dx * direction.x + dy * direction.y;
  const sideways = Math.abs(dx * direction.y - dy * direction.x);
  const cos = Math.cos(halfAngle);
  const sin = Math.sin(halfAngle);
  if (!distance || forward >= distance * cos) return true;
  const alongEdge = clamp(forward * cos + sideways * sin, 0, radius);
  return (forward - alongEdge * cos) ** 2 + (sideways - alongEdge * sin) ** 2 <= e.radius ** 2;
}

function bite(run: SurvivorRun, grid: EnemyGrid) {
  const weapon = run.weapons.find((w) => w.id === 'bite');
  if (!weapon || run.tick < run.bite.nextReadyTick) return;
  const p = weaponParameters('bite', weapon.rank, weapon.evolved, run.player.stats);
  const target = targets(run, grid, p.radius, true)[0];
  if (!target) return;
  const direction = directionTo(run.player, target, run.player.facing);
  const attack = {
    id: run.nextAttackId++,
    tick: run.tick,
    origin: { x: run.player.x, y: run.player.y },
    direction,
    hitIds: [] as number[],
    radius: p.radius,
    halfAngle: p.halfAngle,
    damage: p.damage,
  };
  grid.visit(run.player.x, run.player.y, p.radius + grid.maxRadius, (e) => {
    if (e.hp <= 0 || !inSector(run.player, direction, e, p.radius, p.halfAngle)) return;
    e.hp = Math.max(0, e.hp - p.damage);
    attack.hitIds.push(e.id);
  });
  attack.hitIds.sort((a, b) => a - b);
  run.bite.sequence++;
  run.bite.lastAttack = attack;
  run.bite.nextReadyTick = run.tick + p.cooldownTicks;
}

function fireWeapons(run: SurvivorRun, grid: EnemyGrid) {
  bite(run, grid);
  for (const id of WEAPON_IDS) {
    if (id === 'bite') continue;
    const weapon = run.weapons.find((w) => w.id === id);
    if (!weapon) continue;
    const p = weaponParameters(id, weapon.rank, weapon.evolved, run.player.stats);
    if (id === 'orbit') {
      run.orbitAngle =
        (run.orbitAngle + (Math.PI * 2 * FIXED_STEP) / cooldownFactor(run.player.stats)) %
        (Math.PI * 2);
      for (let index = 0; index < p.count; index++) {
        if (run.attacks.some((a) => a.kind === 'orbit' && a.index === index)) continue;
        const angle = run.orbitAngle + (index * Math.PI * 2) / p.count;
        addAttack(run, {
          kind: 'orbit',
          index,
          count: p.count,
          x: run.player.x + Math.cos(angle) * RULES.orbitRadius,
          y: run.player.y + Math.sin(angle) * RULES.orbitRadius,
          damage: p.damage,
          radius: p.radius,
          hitIds: [],
        });
      }
      continue;
    }
    if (run.tick < run.weaponTimers[id]) continue;
    const aim = id === 'boomerang' || id === 'acorn' ? targets(run, grid, RULES.targetRadius) : [];
    if ((id === 'boomerang' || id === 'acorn') && !aim.length) continue;
    // Saturation consumes this launch: no deferred burst when slots become free.
    run.weaponTimers[id] = run.tick + p.cooldownTicks;
    const origin = { x: run.player.x, y: run.player.y };
    if (id === 'boomerang') {
      const direction = directionTo(origin, aim[0], run.player.facing);
      const angle = Math.atan2(direction.y, direction.x);
      for (let i = 0; i < p.count; i++) {
        const spread = angle + ((i - (p.count - 1) / 2) * Math.PI) / 15;
        addAttack(run, {
          kind: 'boomerang',
          ...origin,
          origin: { ...origin },
          direction: { x: Math.cos(spread), y: Math.sin(spread) },
          range: p.range,
          speed: RULES.boomerangSpeed,
          distance: 0,
          leg: 'out',
          readyTick: run.tick,
          repeats: p.repeats,
          radius: p.radius,
          damage: p.damage,
          hitIds: [],
        });
      }
    } else if (id === 'wave') {
      addAttack(run, {
        kind: 'wave',
        ...origin,
        maxRadius: p.radius,
        radius: 0,
        startTick: run.tick,
        waiting: false,
        repeats: p.repeats,
        damage: p.damage,
        hitIds: [],
      });
    } else if (id === 'trail') {
      addAttack(run, {
        kind: 'trail',
        ...origin,
        endTick: run.tick + p.durationTicks,
        radius: p.radius,
        damage: p.damage,
        hitIds: [],
      });
    } else if (id === 'acorn') {
      for (const target of aim.slice(0, p.count))
        addAttack(run, {
          kind: 'acorn',
          x: target.x,
          y: target.y,
          impactTick: run.tick + RULES.acornDelay,
          exploded: false,
          radius: p.radius,
          damage: p.damage,
          hitIds: [],
        });
    }
  }
}

function hitCircle(grid: EnemyGrid, attack: SurvivorAttack, onHit: (e: SurvivorEnemy) => void) {
  grid.visit(attack.x, attack.y, attack.radius + grid.maxRadius, (e) => {
    if (e.hp > 0 && distanceSquared(attack, e) <= (attack.radius + e.radius) ** 2) onHit(e);
  });
}

function hitSegment(
  grid: EnemyGrid,
  attack: SurvivorAttack,
  from: Point,
  onHit: (e: SurvivorEnemy) => void,
) {
  const dx = attack.x - from.x;
  const dy = attack.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  grid.visit(
    (from.x + attack.x) / 2,
    (from.y + attack.y) / 2,
    Math.sqrt(lengthSquared) / 2 + attack.radius + grid.maxRadius,
    (e) => {
      const t = lengthSquared
        ? clamp(((e.x - from.x) * dx + (e.y - from.y) * dy) / lengthSquared, 0, 1)
        : 0;
      if (
        e.hp > 0 &&
        (e.x - from.x - dx * t) ** 2 + (e.y - from.y - dy * t) ** 2 <=
          (e.radius + attack.radius) ** 2
      )
        onHit(e);
    },
  );
}

function damageOnce(attack: SurvivorAttack, e: SurvivorEnemy) {
  if (attack.hitIds.includes(e.id)) return false;
  attack.hitIds.push(e.id);
  e.hp = Math.max(0, e.hp - attack.damage);
  return true;
}

/** Called only by a fixed combat tick. All timers, telegraphs and echoes freeze with it. */
export function stepWeapons(run: SurvivorRun, grid: EnemyGrid) {
  fireWeapons(run, grid);
  const trailHits = new Map<SurvivorEnemy, number>();
  let remaining = 0;
  for (const attack of run.attacks) {
    let keep = true;
    if (attack.kind === 'boomerang') {
      if (attack.leg === 'waiting') {
        if (run.tick < attack.readyTick) {
          run.attacks[remaining++] = attack;
          continue;
        }
        attack.id = run.nextAttackId++;
        attack.origin = { x: run.player.x, y: run.player.y };
        attack.x = attack.origin.x;
        attack.y = attack.origin.y;
        attack.leg = 'out';
        attack.distance = 0;
        attack.hitIds.length = 0;
      }
      const from = { x: attack.x, y: attack.y };
      attack.distance = clamp(
        attack.distance + (attack.leg === 'out' ? 1 : -1) * attack.speed * FIXED_STEP,
        0,
        attack.range,
      );
      attack.x = attack.origin.x + attack.direction.x * attack.distance;
      attack.y = attack.origin.y + attack.direction.y * attack.distance;
      hitSegment(grid, attack, from, (e) => {
        damageOnce(attack, e);
      });
      if (attack.leg === 'out' && attack.distance === attack.range) {
        attack.leg = 'back';
        attack.hitIds.length = 0;
      } else if (attack.leg === 'back' && attack.distance === 0) {
        if (attack.repeats) {
          attack.repeats--;
          attack.leg = 'waiting';
          attack.readyTick = run.tick + RULES.boomerangRepeatDelay;
        } else keep = false;
      }
    } else if (attack.kind === 'wave') {
      if (attack.waiting) {
        if (run.tick < attack.startTick) {
          run.attacks[remaining++] = attack;
          continue;
        }
        attack.id = run.nextAttackId++;
        attack.waiting = false;
        attack.hitIds.length = 0;
      }
      attack.radius =
        attack.maxRadius * Math.min(1, (run.tick - attack.startTick + 1) / RULES.waveDuration);
      hitCircle(grid, attack, (e) => {
        if (damageOnce(attack, e) && !e.knockbackImmune) {
          const direction = directionTo(attack, e, run.player.facing);
          e.recoil = { x: direction.x * RULES.waveKnockback, y: direction.y * RULES.waveKnockback };
        }
      });
      if (run.tick - attack.startTick + 1 >= RULES.waveDuration) {
        if (attack.repeats) {
          attack.repeats--;
          attack.startTick += RULES.waveRepeatDelay;
          attack.waiting = true;
          attack.radius = 0;
        } else keep = false;
      }
    } else if (attack.kind === 'trail') {
      keep = run.tick < attack.endTick;
      if (keep)
        hitCircle(grid, attack, (e) => {
          if (run.tick >= (e.trailHitUntilTick ?? 0))
            trailHits.set(e, Math.max(trailHits.get(e) ?? 0, attack.damage));
        });
    } else if (attack.kind === 'acorn') {
      if (!attack.exploded && run.tick >= attack.impactTick) {
        attack.exploded = true;
        hitCircle(grid, attack, (e) => {
          damageOnce(attack, e);
        });
      }
      keep = run.tick < attack.impactTick + RULES.acornEffectDuration;
    } else {
      const weapon = run.weapons.find((w) => w.id === 'orbit');
      if (!weapon) keep = false;
      else {
        const p = weaponParameters('orbit', weapon.rank, false, run.player.stats);
        const from = { x: attack.x, y: attack.y };
        const angle = run.orbitAngle + (attack.index * Math.PI * 2) / p.count;
        attack.x = run.player.x + Math.cos(angle) * RULES.orbitRadius;
        attack.y = run.player.y + Math.sin(angle) * RULES.orbitRadius;
        attack.damage = p.damage;
        // Rank upgrades redistribute existing balls instantly, not as a damaging
        // sweep through the chord between the old and new orbit positions.
        if (attack.count !== p.count) {
          from.x = attack.x;
          from.y = attack.y;
          attack.count = p.count;
        }
        hitSegment(grid, attack, from, (e) => {
          if (run.tick < (e.orbitHitUntilTick ?? 0)) return;
          e.hp = Math.max(0, e.hp - attack.damage);
          e.orbitHitUntilTick = run.tick + RULES.sharedHitInterval;
        });
      }
    }
    if (keep) run.attacks[remaining++] = attack;
    else poolFor(run, attack.kind).push(attack);
  }
  run.attacks.length = remaining;
  for (const [enemy, damage] of trailHits) {
    if (enemy.hp <= 0) continue;
    enemy.hp = Math.max(0, enemy.hp - damage);
    enemy.trailHitUntilTick = run.tick + RULES.sharedHitInterval;
  }
}
