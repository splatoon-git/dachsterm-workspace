export const DACHS_HEIGHT = 360;
export const SNACK_SECONDS = 45;
export const SNACK_FLOOR = DACHS_HEIGHT - 35;
const clamp = (x: number, width: number) => Math.max(44, Math.min(width - 44, x));
export type SnackInput = { direction: number; target: number | null };
export type Treat = {
  id: number;
  x: number;
  y: number;
  speed: number;
  kind: 'bone' | 'star' | 'onion';
};
export type Snack = {
  x: number;
  velocity: number;
  facing: number;
  stride: number;
  reaction: number;
  reactionKind: 'bone' | 'star' | 'hurt';
  caught: number;
  stars: number;
  combo: number;
  bestCombo: number;
  effects: { id: number; x: number; kind: Treat['kind']; life: number }[];
  elapsed: number;
  score: number;
  lives: number;
  shield: number;
  spawn: number;
  sequence: number;
  items: Treat[];
  over: boolean;
};
export function newSnack(width = 600): Snack {
  return {
    x: width / 2,
    velocity: 0,
    facing: 1,
    stride: 0,
    reaction: 0,
    reactionKind: 'bone',
    caught: 0,
    stars: 0,
    combo: 0,
    bestCombo: 0,
    effects: [],
    elapsed: 0,
    score: 0,
    lives: 3,
    shield: 0,
    spawn: 0.3,
    sequence: 0,
    items: [],
    over: false,
  };
}
export function stepSnack(
  previous: Snack,
  seconds: number,
  width: number,
  input: SnackInput,
  random = Math.random,
): Snack {
  if (previous.over) return previous;
  // Small physics steps keep acceleration and catches stable at 30/60/120 Hz.
  let remaining = Math.max(0, Math.min(seconds, 0.1, SNACK_SECONDS - previous.elapsed));
  let state = previous;
  while (remaining > 1e-9 && !state.over) {
    const dt = Math.min(remaining, 1 / 120);
    state = snackFrame(state, dt, width, input, random);
    remaining -= dt;
  }
  return state;
}

export function snackMotion(s: Snack) {
  if (s.reaction > 0)
    return s.reactionKind === 'hurt' ? 'hurt' : s.reactionKind === 'star' ? 'jump' : 'eat';
  return Math.abs(s.velocity) > 20 ? 'run' : 'idle';
}

export function resizeSnack(s: Snack, from: number, to: number): Snack {
  const ratio = to / from;
  return {
    ...s,
    x: clamp(s.x * ratio, to),
    velocity: 0,
    items: s.items.map((item) => ({ ...item, x: item.x * ratio })),
    effects: s.effects.map((effect) => ({ ...effect, x: effect.x * ratio })),
  };
}

function snackFrame(
  previous: Snack,
  dt: number,
  width: number,
  input: SnackInput,
  random: () => number,
): Snack {
  const s = {
    ...previous,
    elapsed: Math.min(SNACK_SECONDS, previous.elapsed + dt),
    shield: Math.max(0, previous.shield - dt),
    reaction: Math.max(0, previous.reaction - dt),
    effects: previous.effects.map((e) => ({ ...e, life: e.life - dt })).filter((e) => e.life > 0),
    items: previous.items.map((i) => ({ ...i })),
  };
  const target = input.target === null ? null : clamp(input.target, width);
  const desired = input.direction
    ? Math.sign(input.direction) * 410
    : target === null
      ? 0
      : Math.max(-410, Math.min(410, (target - s.x) * 12));
  const acceleration = desired === 0 ? 3200 : 2800;
  s.velocity +=
    Math.sign(desired - s.velocity) * Math.min(Math.abs(desired - s.velocity), acceleration * dt);
  const oldX = s.x;
  s.x = clamp(s.x + s.velocity * dt, width);
  if (s.x === 44 || s.x === width - 44) s.velocity = 0;
  if (Math.abs(s.velocity) > 20) s.facing = Math.sign(s.velocity);
  s.stride += Math.abs(s.x - oldX) / 32;
  if (s.elapsed >= SNACK_SECONDS - 1e-8) {
    s.elapsed = SNACK_SECONDS;
  }
  s.spawn -= dt;
  if (s.spawn <= 0) {
    const chance = random();
    s.items.push({
      id: s.sequence++,
      x: 24 + random() * (width - 48),
      y: -20,
      speed: 110 + s.elapsed * 2 + random() * 45,
      kind: chance < 0.22 ? 'onion' : chance > 0.91 ? 'star' : 'bone',
    });
    s.spawn = 0.58 - s.elapsed * 0.005;
  }
  const catchY = DACHS_HEIGHT - 77;
  s.items = s.items.filter((item) => {
    const oldY = item.y;
    item.y += item.speed * dt;
    // Interpolate the dog's position where the falling item crosses the catch line.
    const crossing = (catchY - oldY) / (item.y - oldY);
    const catchX = oldX + (s.x - oldX) * crossing;
    if (oldY < catchY && item.y >= catchY && Math.abs(item.x - catchX) < 39) {
      if (item.kind === 'onion') {
        if (s.shield === 0) {
          s.lives--;
          s.shield = 1.1;
          s.combo = 0;
          s.reaction = 0.42;
          s.reactionKind = 'hurt';
          s.effects.push({ id: item.id, x: item.x, kind: item.kind, life: 0.7 });
        }
      } else {
        s.score += item.kind === 'star' ? 30 : 10;
        s.caught++;
        if (item.kind === 'star') s.stars++;
        s.combo++;
        s.bestCombo = Math.max(s.bestCombo, s.combo);
        // A simultaneous treat must not hide the hurt response.
        if (s.reactionKind !== 'hurt' || s.reaction === 0) {
          s.reaction = item.kind === 'star' ? 0.5 : 0.32;
          s.reactionKind = item.kind;
        }
        s.effects.push({ id: item.id, x: item.x, kind: item.kind, life: 0.7 });
      }
      return false;
    }
    if (oldY < catchY && item.y >= catchY && item.kind !== 'onion') s.combo = 0;
    return item.y < DACHS_HEIGHT + 25;
  });
  s.effects = s.effects.slice(-12);
  s.over = s.lives === 0 || s.elapsed >= SNACK_SECONDS;
  return s;
}
