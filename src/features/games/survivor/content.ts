import type { SurvivorStats } from './types';

export const SURVIVOR_CONTENT_VERSION = 1;
export const TICKS_PER_SECOND = 60;
export const FIXED_STEP = 1 / TICKS_PER_SECOND;
export const MAX_CATCH_UP_TICKS = 5;
export const MAX_LEVEL = 40;
export const LIMITS = { enemies: 180, drops: 250 } as const;
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
};
export const BITE = { damage: 18, radius: 90, halfAngle: Math.PI / 3, cooldownTicks: 51 } as const;
export const SLIME = { hp: 24, speed: 70, damage: 10, xp: 3, radius: 18 } as const;
export const SPAWN = {
  intervalTicks: 75, // Starting slime cadence only; the five-minute director is G.8.3.
  minDistance: 240,
  ringMin: 600,
  ringMax: 720,
  attempts: 16,
} as const;

export function xpToNextLevel(level: number): number {
  if (level >= MAX_LEVEL) return 0;
  const n = Math.max(1, Math.floor(level)) - 1;
  return 6 + 3 * n + Math.floor((n * n) / 4);
}
