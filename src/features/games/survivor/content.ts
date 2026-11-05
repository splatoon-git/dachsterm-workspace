import type { AbilityId, EnemyKind, EvolutionId, SurvivorStats, WeaponId } from './types';

export const SURVIVOR_CONTENT_VERSION = 4;
export const TICKS_PER_SECOND = 60;
export const FIXED_STEP = 1 / TICKS_PER_SECOND;
export const MAX_CATCH_UP_TICKS = 5;
export const MAX_LEVEL = 40;
export const LIMITS = {
  enemies: 180,
  elites: 2,
  bosses: 1,
  enemyProjectiles: 100,
  drops: 250,
  attacks: 240,
} as const;
export const MAX_SLOTS = 4;
export const MAX_RANK = 5;
export const MAX_EVOLUTIONS = 2;
export const EVOLUTION_TICK = 180 * TICKS_PER_SECOND;
export const CARD_REWARDS = { healFraction: 0.25, gold: 8 } as const;

// Logical dimensions are independent of CSS pixels. The future renderer should
// scale this view uniformly; resizing must not change combat or spawn distances.
export const WORLD = { width: 3200, height: 3200 } as const;
export const VIEW = { width: 960, height: 540 } as const;
export const PLAYER_RADIUS = 20;
export const INVULNERABLE_TICKS = 45;
export const RECOIL_SPEED = 120;
export const RECOIL_DECAY = 0.75;
export const BASE_STATS: Readonly<SurvivorStats> = {
  maxHp: 100,
  moveSpeed: 210,
  armor: 0,
  pickupRadius: 64,
  attackBonus: 0,
  cooldownReduction: 0,
  experienceBonus: 0,
  goldBonus: 0,
};
export const BITE = { damage: 18, radius: 90, halfAngle: Math.PI / 3, cooldownTicks: 51 } as const;
export const RANK_DAMAGE = [1, 1.3, 1.65, 2.05, 2.5] as const;
export const WEAPON_IDS: readonly WeaponId[] = [
  'bite',
  'boomerang',
  'wave',
  'orbit',
  'trail',
  'acorn',
];
export const WEAPONS = {
  bite: {
    name: '와앙 물기',
    damage: BITE.damage,
    cooldownTicks: BITE.cooldownTicks,
    unlocked: true,
  },
  boomerang: { name: '뼈다귀 부메랑', damage: 16, cooldownTicks: 84, unlocked: true },
  wave: { name: '멍멍 파동', damage: 22, cooldownTicks: 156, unlocked: true },
  orbit: { name: '수호 공', damage: 10, cooldownTicks: 60, unlocked: true },
  trail: { name: '발자국 장판', damage: 6, cooldownTicks: 72, unlocked: false },
  acorn: { name: '도토리 소나기', damage: 26, cooldownTicks: 120, unlocked: false },
} as const;
export const ABILITY_IDS: readonly AbilityId[] = [
  'fangs',
  'tail',
  'heart',
  'fur',
  'feet',
  'nose',
  'wisdom',
  'luck',
];
export const ABILITIES = {
  fangs: { name: '날카로운 이빨', perRank: 0.1 },
  tail: { name: '빠른 꼬리', perRank: 0.08 },
  heart: { name: '튼튼한 심장', perRank: 15 },
  fur: { name: '복슬복슬 털', perRank: 1 },
  feet: { name: '빠른 발', perRank: 0.05 },
  nose: { name: '예민한 코', perRank: 0.25 },
  wisdom: { name: '똑똑한 닥스', perRank: 0.1 },
  luck: { name: '행운의 발바닥', perRank: 0.15 },
} as const;
export const EVOLUTIONS: Readonly<
  Record<
    EvolutionId,
    {
      name: string;
      weapon: WeaponId;
      ability: AbilityId;
      multiplier: number;
    }
  >
> = {
  'king-bite': { name: '왕와앙', weapon: 'bite', ability: 'fangs', multiplier: 1.6 },
  'golden-bone': { name: '황금 뼈다귀', weapon: 'boomerang', ability: 'tail', multiplier: 1.4 },
  'lion-roar': { name: '사자후', weapon: 'wave', ability: 'fur', multiplier: 1.5 },
};
export const WEAPON_RULES = {
  targetRadius: 520,
  boomerangSpeed: 420,
  boomerangRadius: 12,
  boomerangRepeatDelay: 30,
  waveDuration: 18,
  waveRepeatDelay: 24,
  waveKnockback: 180,
  orbitRadius: 95,
  ballRadius: 14,
  sharedHitInterval: 30,
  acornDelay: 30,
  acornEffectDuration: 6,
} as const;

export function cooldownFactor(stats: SurvivorStats): number {
  return Math.max(0.5, 1 - stats.cooldownReduction);
}

/** Attack parameters are sampled at launch, except orbit's live contact stats. */
export function weaponParameters(
  id: WeaponId,
  rank: number,
  evolved: boolean,
  stats: SurvivorStats,
) {
  const evolution = Object.values(EVOLUTIONS).find((e) => e.weapon === id);
  const damage = Math.round(
    WEAPONS[id].damage *
      RANK_DAMAGE[rank - 1] *
      (evolved && evolution ? evolution.multiplier : 1) *
      (1 + stats.attackBonus),
  );
  return {
    damage,
    cooldownTicks:
      id === 'orbit'
        ? WEAPONS[id].cooldownTicks * cooldownFactor(stats)
        : Math.ceil(WEAPONS[id].cooldownTicks * cooldownFactor(stats)),
    radius:
      id === 'bite'
        ? evolved
          ? 150
          : rank >= 5
            ? 125
            : rank >= 3
              ? 105
              : 90
        : id === 'wave'
          ? rank >= 5
            ? 220
            : rank >= 3
              ? 180
              : 150
          : id === 'trail'
            ? rank >= 5
              ? 85
              : 65
            : id === 'acorn'
              ? 70
              : id === 'orbit'
                ? WEAPON_RULES.ballRadius
                : WEAPON_RULES.boomerangRadius,
    halfAngle: evolved && id === 'bite' ? Math.PI / 2 : BITE.halfAngle,
    count: ['boomerang', 'orbit', 'acorn'].includes(id) ? (rank >= 5 ? 3 : rank >= 3 ? 2 : 1) : 1,
    range: id === 'boomerang' ? (evolved ? 520 : 420) : 0,
    durationTicks: id === 'trail' ? (rank >= 3 ? 240 : 180) : 0,
    repeats: evolved && (id === 'boomerang' || id === 'wave') ? 1 : 0,
  };
}
export const SLIME = { hp: 24, speed: 70, damage: 10, xp: 3, radius: 18 } as const;
export const SPAWN = {
  intervalTicks: 60 / 1.4, // Stage 1; later stages retain fractional spawn intervals.
  minDistance: 240,
  ringMin: 600,
  ringMax: 720,
  attempts: 16,
} as const;

export const STAGE = {
  waveTicks: 3600,
  warningTicks: 90,
  eliteTick: 1800,
  bossReward: 40,
} as const;
export const DROP_RULES = {
  goldChance: 0.1,
  healChance: 0.02,
  eliteGold: 15,
  healFraction: 0.2,
} as const;
export const ENEMIES = {
  slime: SLIME,
  bat: { hp: 18, speed: 135, damage: 10, xp: 4, radius: 14 },
  mushroom: { hp: 32, speed: 55, damage: 12, xp: 5, radius: 20 },
  golem: { hp: 100, speed: 45, damage: 18, xp: 8, radius: 28 },
  boar: { hp: 45, speed: 75, damage: 15, xp: 4, radius: 22 },
  giantSlime: { hp: 600, speed: 55, damage: 20, xp: 40, radius: 42 },
  armoredBoar: { hp: 1000, speed: 70, damage: 25, xp: 40, radius: 38 },
  boss: { hp: 3000, speed: 75, damage: 25, xp: 0, radius: 48 },
} as const;
export const ENEMY_RULES = {
  mushroom: {
    range: 300,
    trigger: 360,
    cooldown: 180,
    warning: 30,
    projectileSpeed: 160,
    damage: 10,
  },
  boar: { trigger: 420, cooldown: 180, warning: 42, charge: 36, speed: 300, recovery: 60 },
  giantSlime: { trigger: 420, cooldown: 240, warning: 48, radius: 100, recovery: 48 },
  armoredBoar: { trigger: 600, cooldown: 240, warning: 48, charge: 48, speed: 330, recovery: 72 },
  boss: {
    trigger: 520,
    chargeWarning: 54,
    charge: 54,
    chargeSpeed: 320,
    recovery: 72,
    shootWarning: 48,
    projectileSpeed: 160,
    projectileDamage: 15,
    spread: (Math.PI * 2) / 3,
    leapWarning: 60,
    leapRadius: 110,
    leapDamage: 30,
    leapRecovery: 90,
    enrageTick: 5400,
  },
  projectileRadius: 8,
  projectileLifetime: 180,
} as const;

export function isElite(kind: EnemyKind): boolean {
  return kind === 'giantSlime' || kind === 'armoredBoar';
}
export function stageParameters(index: number) {
  const n = Math.max(0, index - 1);
  const b = Math.max(0, index / 3 - 1);
  return {
    spawnRate: Math.min(5.8, 1.4 + 0.6 * n),
    hpScale: Math.min(20, 1 + 0.18 * n + 0.015 * n * n),
    damageScale: Math.min(3, 1 + 0.06 * n),
    xpScale: Math.min(2.5, 1 + 0.15 * n),
    bossHpScale: Math.min(10, 1 + 0.6 * b),
    bossDamageScale: Math.min(3, 1 + 0.15 * b),
  };
}
export function stageEnemyKind(index: number, roll: number): EnemyKind {
  const weights =
    index === 1
      ? [85, 15, 0, 0, 0]
      : index === 2
        ? [60, 25, 15, 0, 0]
        : index === 3
          ? [40, 30, 20, 0, 10]
          : index === 4
            ? [20, 25, 25, 30, 0]
            : [
                [30, 20, 25, 10, 15], // Forest: soft crowds and spores.
                [15, 25, 20, 20, 20], // Ruins: balanced mixed encounters.
                [15, 35, 15, 25, 10], // Cavern: wings and stone.
                [25, 15, 15, 15, 30], // Snow: charging packs.
              ][Math.floor((index - 1) / 3) % 4];
  const kinds: EnemyKind[] = ['slime', 'bat', 'mushroom', 'golem', 'boar'];
  let sum = 0;
  for (let i = 0; i < weights.length; i++) {
    sum += weights[i];
    if (roll * 100 < sum) return kinds[i];
  }
  return 'boar';
}
export function stageElite(index: number): EnemyKind | null {
  if (index % 2 !== 0 || index % 3 === 0) return null;
  return index % 6 === 2 ? 'giantSlime' : 'armoredBoar';
}

export function xpToNextLevel(level: number): number {
  if (level >= MAX_LEVEL) return 0;
  const n = Math.max(1, Math.floor(level)) - 1;
  return 6 + 3 * n + Math.floor((n * n) / 4);
}
