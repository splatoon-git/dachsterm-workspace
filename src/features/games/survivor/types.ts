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
  goldBonus: number;
};

export type SurvivorPlayer = Point & {
  radius: number;
  hp: number;
  stats: SurvivorStats;
  facing: Point;
  recoil: Point;
  invulnerableUntilTick: number;
};

// Enemy kinds and physical drops expand in G.8.3.
export type SurvivorEnemy = Point & {
  id: number;
  kind: 'slime';
  radius: number;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  xp: number;
  recoil?: Point;
  knockbackImmune?: boolean;
  orbitHitUntilTick?: number;
  trailHitUntilTick?: number;
};
export type SurvivorDrop = Point & { id: number; kind: 'xp'; value: number };
export type BiteAttack = {
  id: number;
  tick: number;
  origin: Point;
  direction: Point;
  hitIds: number[];
  radius: number;
  halfAngle: number;
  damage: number;
};

export type WeaponId = 'bite' | 'boomerang' | 'wave' | 'orbit' | 'trail' | 'acorn';
export type AbilityId = 'fangs' | 'tail' | 'heart' | 'fur' | 'feet' | 'nose' | 'wisdom' | 'luck';
export type EvolutionId = 'king-bite' | 'golden-bone' | 'lion-roar';
export type OwnedWeapon = { id: WeaponId; rank: number; evolved: boolean };
export type OwnedAbility = { id: AbilityId; rank: number };
/** Validated run-start values; persistence and purchases belong to G.8.4. */
export type SurvivorStartOptions = {
  unlockedWeapons?: readonly WeaponId[];
  extraReroll?: boolean;
  bonuses?: Partial<{
    hp: number;
    attack: number;
    pickup: number;
    gold: number;
    move: number;
    cooldown: number;
  }>;
};
export type CardEffect = { label: string; before: number; after: number; unit: string };
export type SurvivorCard = {
  id: string;
  name: string;
  fromRank: number;
  toRank: number;
  effects: CardEffect[];
} & (
  | { kind: 'weapon'; target: WeaponId }
  | { kind: 'ability'; target: AbilityId }
  | { kind: 'evolution'; target: EvolutionId }
  | { kind: 'reward'; target: 'heal' | 'gold' }
);
export type CardChoice = { id: number; cards: SurvivorCard[] };

type AttackBase = { id: number; damage: number; radius: number; hitIds: number[] };
export type BoomerangAttack = AttackBase &
  Point & {
    kind: 'boomerang';
    origin: Point;
    direction: Point;
    range: number;
    speed: number;
    distance: number;
    leg: 'out' | 'back' | 'waiting';
    readyTick: number;
    repeats: number;
  };
export type WaveAttack = AttackBase &
  Point & {
    kind: 'wave';
    maxRadius: number;
    startTick: number;
    repeats: number;
    waiting: boolean;
  };
export type TrailAttack = AttackBase & Point & { kind: 'trail'; endTick: number };
export type AcornAttack = AttackBase &
  Point & {
    kind: 'acorn';
    impactTick: number;
    exploded: boolean;
  };
export type OrbitAttack = AttackBase & Point & { kind: 'orbit'; index: number; count: number };
export type SurvivorAttack = BoomerangAttack | WaveAttack | TrailAttack | AcornAttack | OrbitAttack;

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
  weapons: OwnedWeapon[];
  abilities: OwnedAbility[];
  startBonuses: Required<NonNullable<SurvivorStartOptions['bonuses']>>;
  unlockedWeapons: WeaponId[];
  weaponTimers: Record<Exclude<WeaponId, 'bite' | 'orbit'>, number>;
  orbitAngle: number;
  attacks: SurvivorAttack[];
  nextAttackId: number;
  choice: CardChoice | null;
  choiceSequence: number;
  rerolls: number;
  gold: number;
  kills: number;
  level: number;
  xp: number;
  pendingChoices: number;
  lastDamage: { tick: number; amount: number } | null;
  result: 'defeat' | null;
};
