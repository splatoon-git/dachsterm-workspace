export type Point = { x: number; y: number };
export type SurvivorInput = { moveX: number; moveY: number };
export type SurvivorPhase = 'playing' | 'choosing' | 'paused' | 'result';

export type SurvivorStats = {
  maxHp: number;
  moveSpeed: number;
  armor: number;
  pickupRadius: number;
  attackBonus: number;
  cooldownReduction: number;
  experienceBonus: number;
};

export type SurvivorPlayer = Point & {
  radius: number;
  hp: number;
  stats: SurvivorStats;
  facing: Point;
  recoil: Point;
  invulnerableUntilTick: number;
};

// G.8.1 only implements the starting weapon/enemy/drop. Extend these unions with
// their implementations in G.8.2/G.8.3, rather than advertising unavailable content.
export type SurvivorEnemy = Point & {
  id: number;
  kind: 'slime';
  radius: number;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  xp: number;
};
export type SurvivorDrop = Point & { id: number; kind: 'xp'; value: number };
export type BiteAttack = {
  id: number;
  tick: number;
  origin: Point;
  direction: Point;
  hitIds: number[];
};

/** Owned mutable simulation state, intended for a ref, not per-frame React state.
 * Read entity objects only during the current tick: removed entities are pooled.
 * This is not the persistent profile/checkpoint format (G.8.4).
 */
export type SurvivorRun = {
  contentVersion: number;
  seed: number;
  phase: SurvivorPhase;
  pausedFrom: 'playing' | 'choosing' | null;
  tick: number;
  accumulator: number;
  nextSpawnTick: number;
  random: { spawn: number; drops: number; cards: number };
  nextEntityId: number;
  player: SurvivorPlayer;
  enemies: SurvivorEnemy[];
  drops: SurvivorDrop[];
  bite: { nextReadyTick: number; sequence: number; lastAttack: BiteAttack | null };
  kills: number;
  level: number;
  xp: number;
  pendingChoices: number;
  lastDamage: { tick: number; amount: number } | null;
  result: 'defeat' | null;
};
