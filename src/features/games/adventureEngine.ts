import {
  generateLevel,
  platformPosition,
  ventPhase,
  type Level,
  type EnemyKind,
  type Platform,
} from './adventureLevels';
export const ADVENTURE_HEIGHT = 360;
export const ADVENTURE_FLOOR = 300;
export type AdventureInput = { direction: number; jump?: boolean; bite?: boolean; stomp?: boolean };
export type AdventureEnemy = {
  id: number;
  x: number;
  y: number;
  origin: number;
  range: number;
  direction: number;
  alive: boolean;
  kind: EnemyKind;
  mode: 'patrol' | 'windup' | 'charge';
  timer: number;
};
export type AdventurePickup = { id: number; x: number; y: number; taken: boolean };
export type AdventureEffect = {
  id: number;
  x: number;
  y: number;
  life: number;
  kind: 'hit' | 'treat' | 'dust' | 'rest' | 'stomp' | 'switch';
};
export type Adventure = {
  level: Level;
  x: number;
  y: number;
  vx: number;
  velocity: number;
  facing: number;
  grounded: boolean;
  elapsed: number;
  distance: number;
  distanceOffset: number;
  furthest: number;
  score: number;
  health: number;
  shield: number;
  hurt: number;
  attack: number;
  cooldown: number;
  coyote: number;
  jumpBuffer: number;
  checkpoint: number;
  stomping: boolean;
  bounce: number;
  platformId: number | null;
  crumbling: Record<number, number>;
  switches: number[];
  enemies: AdventureEnemy[];
  pickups: AdventurePickup[];
  effects: AdventureEffect[];
  sequence: number;
  over: boolean;
  won: boolean;
};
export function newAdventure(seed = 1, index = 0): Adventure {
  const level = generateLevel(seed, index);
  return {
    level,
    x: 100,
    y: 0,
    vx: 0,
    velocity: 0,
    facing: 1,
    grounded: true,
    elapsed: 0,
    distance: 0,
    distanceOffset: 0,
    furthest: 100,
    score: 0,
    health: 5,
    shield: 0,
    hurt: 0,
    attack: 0,
    cooldown: 0,
    coyote: 0.1,
    jumpBuffer: 0,
    checkpoint: 100,
    stomping: false,
    bounce: 0,
    platformId: null,
    crumbling: {},
    switches: [],
    enemies: level.enemies.map((e, id) => ({
      ...e,
      id,
      y: e.kind === 'bat' ? 75 : 0,
      origin: e.x,
      direction: -1,
      alive: true,
      mode: 'patrol',
      timer: 0,
    })),
    pickups: level.treats.map((p, id) => ({ ...p, id, taken: false })),
    effects: [],
    sequence: 0,
    over: false,
    won: false,
  };
}
export function nextAdventure(s: Adventure): Adventure {
  if (!s.won) return s;
  const next = newAdventure(s.level.seed, s.level.index + 1);
  return {
    ...next,
    score: s.score,
    health: Math.min(5, s.health + 1),
    distance: s.distance,
    distanceOffset: s.distance,
  };
}
export function jumpAdventure(s: Adventure): Adventure {
  if (s.over || s.stomping) return s;
  if (!s.grounded && s.coyote <= 0) return { ...s, jumpBuffer: 0.12 };
  return {
    ...s,
    grounded: false,
    platformId: null,
    coyote: 0,
    jumpBuffer: 0,
    velocity: 570,
    y: s.y + 0.1,
  };
}
export function biteAdventure(s: Adventure): Adventure {
  return s.over || s.cooldown > 0 || s.stomping ? s : { ...s, attack: 0.24, cooldown: 0.44 };
}
export function stompAdventure(s: Adventure): Adventure {
  return s.over || s.grounded || s.stomping
    ? s
    : { ...s, stomping: true, velocity: -780, attack: 0, coyote: 0, jumpBuffer: 0 };
}
export function platformAvailable(p: Platform, s: Adventure) {
  const trigger = s.crumbling[p.id];
  return trigger === undefined || s.elapsed - trigger < 0.65 || s.elapsed - trigger >= 3.65;
}
const groundAt = (x: number, level: Level) => !level.gaps.some((g) => x > g.x && x < g.x + g.width);
export const adventureCamera = (s: Adventure, width: number) =>
  Math.max(0, Math.min(s.level.end - width, s.x - width * 0.36));
export function adventureMotion(s: Adventure) {
  return s.hurt > 0
    ? 'hurt'
    : s.stomping
      ? 'stomp'
      : s.attack > 0
        ? 'bite'
        : !s.grounded
          ? s.velocity > 0
            ? 'jump'
            : 'fall'
          : Math.abs(s.vx) > 15
            ? 'run'
            : 'idle';
}
export function stepAdventure(
  previous: Adventure,
  seconds: number,
  input: AdventureInput = { direction: 0 },
): Adventure {
  if (previous.over || seconds <= 0) return previous;
  let s = previous;
  let remaining = Math.min(seconds, 0.05);
  while (remaining > 0.000001) {
    const dt = Math.min(remaining, 1 / 120);
    s = advance(s, dt, input);
    input = { direction: input.direction };
    remaining -= dt;
    if (s.over) break;
  }
  return s;
}
function advance(previous: Adventure, dt: number, input: AdventureInput): Adventure {
  let s: Adventure = {
    ...previous,
    elapsed: previous.elapsed + dt,
    shield: Math.max(0, previous.shield - dt),
    hurt: Math.max(0, previous.hurt - dt),
    bounce: Math.max(0, previous.bounce - dt),
    attack: Math.max(0, previous.attack - dt),
    cooldown: Math.max(0, previous.cooldown - dt),
    coyote: previous.grounded ? 0.1 : Math.max(0, previous.coyote - dt),
    jumpBuffer: Math.max(0, previous.jumpBuffer - dt),
    enemies: previous.enemies.map((e) => ({ ...e })),
    pickups: previous.pickups.map((p) => ({ ...p })),
    crumbling: { ...previous.crumbling },
    switches: [...previous.switches],
    effects: previous.effects.filter((e) => e.life > dt).map((e) => ({ ...e, life: e.life - dt })),
  };
  const level = s.level;
  const effect = (x: number, y: number, kind: AdventureEffect['kind']) =>
    s.effects.push({ id: s.sequence++, x, y, kind, life: 0.4 });
  for (const [id, time] of Object.entries(s.crumbling))
    if (s.elapsed - time >= 3.65) delete s.crumbling[Number(id)];
  if (previous.platformId !== null && previous.grounded) {
    const platform = level.platforms.find((p) => p.id === previous.platformId);
    if (platform && platformAvailable(platform, s))
      s.x +=
        platformPosition(platform, s.elapsed).x - platformPosition(platform, previous.elapsed).x;
  }
  const direction = Math.sign(input.direction);
  const onIce = s.grounded && s.y === 0 && level.ice.some((p) => s.x > p.x && s.x < p.x + p.width);
  if (s.hurt <= 0) {
    const target = direction * 255;
    const acceleration = s.grounded ? (onIce ? 360 : 2000) : 1350;
    s.vx += Math.sign(target - s.vx) * Math.min(Math.abs(target - s.vx), acceleration * dt);
    if (direction) s.facing = direction;
  }
  if (input.jump || (s.jumpBuffer > 0 && (s.grounded || s.coyote > 0))) s = jumpAdventure(s);
  if (input.stomp) s = stompAdventure(s);
  if (input.bite) s = biteAdventure(s);
  s.x = Math.max(42, Math.min(level.end - 42, s.x + s.vx * dt));
  for (const gate of level.gates) {
    if (
      s.attack > 0 &&
      !s.switches.includes(gate.id) &&
      Math.abs(gate.switchX - s.x) < 95 &&
      (gate.switchX - s.x) * s.facing >= -8 &&
      s.y < 60
    ) {
      s.switches.push(gate.id);
      effect(gate.switchX, 50, 'switch');
    }
    if (!s.switches.includes(gate.id) && s.y < 180 && Math.abs(s.x - gate.x) < 37) {
      s.x = previous.x < gate.x ? gate.x - 37 : gate.x + 37;
      s.vx = 0;
    }
  }
  const oldY = s.y;
  s.velocity -= 1500 * dt;
  s.y += s.velocity * dt;
  s.grounded = false;
  s.platformId = null;
  const surfaces = level.platforms
    .filter((p) => platformAvailable(p, s))
    .map((p) => platformPosition(p, s.elapsed))
    .filter((p) => s.x + 18 > p.x && s.x - 18 < p.x + p.width)
    .map((p) => ({ y: p.y, id: p.id }));
  if (groundAt(s.x, level)) surfaces.push({ y: 0, id: -1 });
  const landing = surfaces
    .filter((p) => s.velocity <= 0 && oldY >= p.y && s.y <= p.y)
    .sort((a, b) => b.y - a.y)[0];
  if (landing) {
    s.y = landing.y;
    s.velocity = 0;
    s.grounded = true;
    s.stomping = false;
    s.platformId = landing.id === -1 ? null : landing.id;
    if (!previous.grounded) effect(s.x, s.y, 'dust');
    const platform = level.platforms.find((p) => p.id === landing.id);
    if (platform?.kind === 'crumble' && s.crumbling[platform.id] === undefined)
      s.crumbling[platform.id] = s.elapsed;
  }
  const damage = (from: number) => {
    if (s.shield > 0) return;
    s.health--;
    s.shield = 1.25;
    s.hurt = 0.25;
    s.stomping = false;
    s.vx = s.x < from ? -200 : 200;
    s.velocity = 240;
    s.grounded = false;
    s.platformId = null;
    effect(s.x, s.y + 30, 'hit');
  };
  for (const e of s.enemies) {
    if (!e.alive) continue;
    const enemyOldY = e.y;
    e.timer = Math.max(0, e.timer - dt);
    if (e.kind === 'boar') {
      if (
        e.mode === 'patrol' &&
        e.timer === 0 &&
        Math.abs(s.x - e.x) < 210 &&
        Math.abs(s.x - e.x) > 50
      ) {
        e.mode = 'windup';
        e.timer = 0.65;
        e.direction = s.x < e.x ? -1 : 1;
      } else if (e.mode === 'windup' && e.timer === 0) {
        e.mode = 'charge';
        e.timer = 0.6;
      } else if (e.mode === 'charge' && e.timer === 0) {
        e.mode = 'patrol';
        e.timer = 1.5;
      }
    }
    if (e.mode !== 'windup')
      e.x += e.direction * (e.mode === 'charge' ? 230 : 65 + Math.min(level.index, 8) * 3) * dt;
    const patrolRange = e.range;
    if (Math.abs(e.x - e.origin) >= patrolRange) {
      e.x = e.origin + Math.sign(e.x - e.origin) * patrolRange;
      e.direction *= -1;
      if (e.mode === 'charge') {
        e.mode = 'patrol';
        e.timer = 1.5;
      }
    }
    if (e.kind === 'hopper') e.y = Math.max(0, Math.sin(s.elapsed * 3.4 + e.id)) * 60;
    else if (e.kind === 'bat') e.y = 75 + Math.sin(s.elapsed * 2.7 + e.id) * 28;
    const top = e.y + (e.kind === 'bat' ? 24 : 34);
    const oldTop = enemyOldY + (e.kind === 'bat' ? 24 : 34);
    const horizontal = Math.abs(e.x - s.x) < 44;
    // Crossing an enemy's head while descending is a stomp, even without Down.
    // Resolve before side damage; fast descent uses swept vertical collision.
    if (horizontal && s.velocity <= 0 && oldY >= oldTop - 2 && s.y <= top && !previous.grounded) {
      e.alive = false;
      s.score += 75;
      s.y = top + 1;
      s.velocity = 440;
      s.grounded = false;
      s.platformId = null;
      s.stomping = false;
      s.coyote = 0;
      s.bounce = 0.22;
      effect(e.x, top, 'stomp');
      continue;
    }
    const ahead = (e.x - s.x) * s.facing;
    if (s.attack > 0 && ahead > 0 && ahead < 100 && Math.abs(s.y + 28 - (e.y + 20)) < 43) {
      e.alive = false;
      s.score += 50;
      effect(e.x, e.y + 25, 'hit');
    } else if (horizontal && s.y < top && s.y + 60 > e.y) damage(e.x);
  }
  for (const spike of level.spikes)
    if (s.x + 18 > spike.x && s.x - 18 < spike.x + spike.width && s.y < 22 && s.y > -30)
      damage(spike.x + spike.width / 2);
  for (const vent of level.vents)
    if (
      ventPhase(s.elapsed, vent.phase) === 'active' &&
      Math.abs(s.x - vent.x) < 38 &&
      s.y < 85 &&
      s.y > -20
    )
      damage(vent.x);
  if (s.grounded && s.y === 0 && level.springs.some((x) => Math.abs(s.x - x) < 26)) {
    s.velocity = 810;
    s.grounded = false;
    s.stomping = false;
    s.coyote = 0;
    s.bounce = 0.22;
    effect(s.x, 8, 'dust');
  }
  for (const p of s.pickups)
    if (!p.taken && Math.abs(p.x - s.x) < 37 && Math.abs(p.y - (s.y + 32)) < 43) {
      p.taken = true;
      s.score += 25;
      effect(p.x, p.y, 'treat');
    }
  for (const x of level.checkpoints)
    if (s.x >= x && s.checkpoint < x && s.grounded) {
      s.checkpoint = x;
      s.health = Math.min(5, s.health + 1);
      effect(x, 60, 'rest');
    }
  if (s.y < -160) {
    s.health--;
    s.x = s.checkpoint;
    s.y = 0;
    s.vx = 0;
    s.velocity = 0;
    s.grounded = true;
    s.platformId = null;
    s.shield = 1.5;
    s.hurt = 0;
    s.attack = 0;
    s.jumpBuffer = 0;
    s.stomping = false;
  }
  s.health = Math.max(0, s.health);
  s.furthest = Math.max(s.furthest, s.x);
  s.distance = s.distanceOffset + (s.furthest - 100) / 20;
  if (s.health === 0) s.over = true;
  else if (s.x >= level.goal && s.grounded) {
    s.won = true;
    s.over = true;
    s.score += 200;
  }
  return s;
}
