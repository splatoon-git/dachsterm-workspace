import { STAGE } from './content';
import type { SurvivorRun, SurvivorStartOptions } from './types';

export const PROFILE_KEY = 'daxterm.games.survivor.v1';
export const GOLD_CAP = 9_999_999;
export const FIRST_BOSS_GOLD = 30;
export const UPGRADES = {
  hp: { name: '든든한 몸', costs: [30, 50, 80, 120, 180], perRank: 5, effect: '최대 HP' },
  attack: { name: '튼튼한 이빨', costs: [40, 65, 100, 150, 220], perRank: 3, effect: '공격력' },
  pickup: { name: '간식 탐지', costs: [30, 60, 100], perRank: 10, effect: '수집 반경' },
  gold: { name: '저금 습관', costs: [50, 90, 150], perRank: 5, effect: '획득 골드' },
} as const;
export const UNLOCKS = {
  trail: { name: '발자국 장판', cost: 100, effect: '레벨업 카드에 추가' },
  acorn: { name: '도토리 소나기', cost: 150, effect: '레벨업 카드에 추가' },
  reroll: { name: '한 번 더 고민', cost: 150, effect: '다시 뽑기 1 → 2회/판' },
} as const;
export type UpgradeId = keyof typeof UPGRADES;
export type UnlockId = keyof typeof UNLOCKS;
export const UPGRADE_IDS = Object.keys(UPGRADES) as UpgradeId[];
export const UNLOCK_IDS = Object.keys(UNLOCKS) as UnlockId[];
export type RunSummary = {
  collectedGold: number;
  bossRewardGold: number;
  bossesDefeated: number;
  lastRewardedBossStage: number;
  highestReachedStage: number;
  highestCompletedStage: number;
  tick: number;
  level: number;
  kills: number;
  firstBossEligible: boolean;
};
export type RunCheckpoint = RunSummary & {
  runId: string;
  seed: number;
  savedAt: number;
};
export type Settlement = RunCheckpoint & {
  reason: 'defeat' | 'retired' | 'abandoned' | 'interrupted';
  firstBossGold: number;
  earnedGold: number;
  creditedGold: number;
};
export type SurvivorProfile = {
  schemaVersion: 1;
  revision: number;
  gold: number;
  upgrades: Record<UpgradeId, { rank: number; paid: number[] }>;
  unlocks: UnlockId[];
  firstBossRewarded: boolean;
  settings: { muted: boolean; motion: 'system' | 'reduced' | 'full' };
  records: {
    highestReachedStage: number;
    highestCompletedStage: number;
    longestTicks: number;
    highestLevel: number;
    mostKills: number;
    totalBosses: number;
  };
  checkpoint: RunCheckpoint | null;
  settlements: Settlement[];
};

export function newSurvivorProfile(): SurvivorProfile {
  return {
    schemaVersion: 1,
    revision: 0,
    gold: 0,
    upgrades: {
      hp: { rank: 0, paid: [] },
      attack: { rank: 0, paid: [] },
      pickup: { rank: 0, paid: [] },
      gold: { rank: 0, paid: [] },
    },
    unlocks: [],
    firstBossRewarded: false,
    settings: { muted: true, motion: 'system' },
    records: {
      highestReachedStage: 0,
      highestCompletedStage: 0,
      longestTicks: 0,
      highestLevel: 0,
      mostKills: 0,
      totalBosses: 0,
    },
    checkpoint: null,
    settlements: [],
  };
}

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
const keys = (v: ObjectValue, expected: string[]) =>
  Object.keys(v).length === expected.length && expected.every((k) => Object.hasOwn(v, k));
const summaryKeys = [
  'collectedGold',
  'bossRewardGold',
  'bossesDefeated',
  'lastRewardedBossStage',
  'highestReachedStage',
  'highestCompletedStage',
  'tick',
  'level',
  'kills',
  'firstBossEligible',
];
const checkpointKeys = [...summaryKeys, 'runId', 'seed', 'savedAt'];
const runIdValid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);

function validSummary(v: ObjectValue): boolean {
  if (
    !finite(v.collectedGold) ||
    !integer(v.bossRewardGold) ||
    !integer(v.bossesDefeated) ||
    !integer(v.lastRewardedBossStage) ||
    !integer(v.highestReachedStage, 1) ||
    !integer(v.highestCompletedStage) ||
    !integer(v.tick) ||
    !integer(v.level, 1, 40) ||
    !integer(v.kills)
  )
    return false;
  return (
    v.highestReachedStage >= v.highestCompletedStage &&
    v.highestReachedStage <= v.highestCompletedStage + 1 &&
    v.bossesDefeated === Math.floor(v.highestCompletedStage / 3) &&
    v.bossRewardGold === v.bossesDefeated * STAGE.bossReward &&
    v.lastRewardedBossStage === v.bossesDefeated * 3 &&
    v.firstBossEligible === v.bossesDefeated > 0 &&
    v.tick >= v.highestCompletedStage * STAGE.waveTicks &&
    Number.isSafeInteger(Math.floor(v.collectedGold) + v.bossRewardGold + FIRST_BOSS_GOLD)
  );
}
function validCheckpoint(v: unknown, settled = false): v is RunCheckpoint {
  return (
    object(v) &&
    keys(
      v,
      settled
        ? [...checkpointKeys, 'reason', 'firstBossGold', 'earnedGold', 'creditedGold']
        : checkpointKeys,
    ) &&
    runIdValid(v.runId) &&
    integer(v.seed, 0, 0xffffffff) &&
    integer(v.savedAt) &&
    validSummary(v)
  );
}
function validSettlement(v: unknown): v is Settlement {
  if (!validCheckpoint(v, true)) return false;
  const s = v as Settlement;
  return (
    ['defeat', 'retired', 'abandoned', 'interrupted'].includes(s.reason) &&
    (s.reason !== 'retired' || s.highestReachedStage === s.highestCompletedStage) &&
    (s.firstBossGold === 0 || (s.firstBossEligible && s.firstBossGold === FIRST_BOSS_GOLD)) &&
    integer(s.earnedGold) &&
    s.earnedGold === Math.floor(s.collectedGold) + s.bossRewardGold + s.firstBossGold &&
    integer(s.creditedGold, 0, Math.min(s.earnedGold, GOLD_CAP))
  );
}

/** Reject the whole record, never repair by silently discarding money or future data. */
export function isSurvivorProfile(v: unknown): v is SurvivorProfile {
  if (
    !object(v) ||
    !keys(v, [
      'schemaVersion',
      'revision',
      'gold',
      'upgrades',
      'unlocks',
      'firstBossRewarded',
      'settings',
      'records',
      'checkpoint',
      'settlements',
    ]) ||
    v.schemaVersion !== 1 ||
    !integer(v.revision) ||
    !integer(v.gold, 0, GOLD_CAP) ||
    !object(v.upgrades) ||
    !keys(v.upgrades, UPGRADE_IDS) ||
    typeof v.firstBossRewarded !== 'boolean'
  )
    return false;
  for (const id of UPGRADE_IDS) {
    const u = v.upgrades[id];
    if (
      !object(u) ||
      !keys(u, ['rank', 'paid']) ||
      !integer(u.rank, 0, UPGRADES[id].costs.length) ||
      !Array.isArray(u.paid) ||
      u.paid.length !== u.rank ||
      !u.paid.every((n) => integer(n, 0, GOLD_CAP))
    )
      return false;
  }
  if (
    !Array.isArray(v.unlocks) ||
    v.unlocks.some((id) => !UNLOCK_IDS.includes(id)) ||
    new Set(v.unlocks).size !== v.unlocks.length ||
    !object(v.settings) ||
    !keys(v.settings, ['muted', 'motion']) ||
    typeof v.settings.muted !== 'boolean' ||
    !['system', 'reduced', 'full'].includes(v.settings.motion as string) ||
    !object(v.records) ||
    !keys(v.records, [
      'highestReachedStage',
      'highestCompletedStage',
      'longestTicks',
      'highestLevel',
      'mostKills',
      'totalBosses',
    ]) ||
    !Object.values(v.records).every((n) => integer(n)) ||
    !integer(v.records.highestLevel, 0, 40)
  )
    return false;
  const records = v.records as SurvivorProfile['records'];
  if (
    records.highestReachedStage < records.highestCompletedStage ||
    records.highestReachedStage > records.highestCompletedStage + 1 ||
    records.longestTicks < records.highestCompletedStage * STAGE.waveTicks ||
    records.totalBosses < Math.floor(records.highestCompletedStage / 3) ||
    v.firstBossRewarded !== records.totalBosses > 0
  )
    return false;
  if (
    !Array.isArray(v.settlements) ||
    v.settlements.length > 20 ||
    !v.settlements.every(validSettlement)
  )
    return false;
  const recent = v.settlements as Settlement[];
  if (
    new Set(recent.map((s) => s.runId)).size !== recent.length ||
    recent.filter((s) => s.firstBossGold > 0).length > 1 ||
    recent.reduce((n, s) => n + s.bossesDefeated, 0) > records.totalBosses ||
    recent.some(
      (s) =>
        s.highestCompletedStage > records.highestCompletedStage ||
        s.highestReachedStage > records.highestReachedStage ||
        s.tick > records.longestTicks ||
        s.level > records.highestLevel ||
        s.kills > records.mostKills,
    )
  )
    return false;
  const cp = v.checkpoint;
  return cp === null || (validCheckpoint(cp) && !recent.some((s) => s.runId === cp.runId));
}

export type ProfileRead =
  { ok: true; profile: SurvivorProfile } | { ok: false; error: 'future' | 'corrupt' };
export function parseSurvivorProfile(raw: string | null): ProfileRead {
  if (raw === null) return { ok: true, profile: newSurvivorProfile() };
  try {
    if (raw.length > 100_000) return { ok: false, error: 'corrupt' };
    const data: unknown = JSON.parse(raw);
    if (object(data) && integer(data.schemaVersion, 2)) return { ok: false, error: 'future' };
    return isSurvivorProfile(data) ? { ok: true, profile: data } : { ok: false, error: 'corrupt' };
  } catch {
    return { ok: false, error: 'corrupt' };
  }
}

export function profileStartOptions(p: SurvivorProfile): SurvivorStartOptions {
  return {
    bonuses: Object.fromEntries(
      UPGRADE_IDS.map((id) => [id, (p.upgrades[id].rank * UPGRADES[id].perRank) / 100]),
    ),
    unlockedWeapons: p.unlocks.filter((id): id is 'trail' | 'acorn' => id !== 'reroll'),
    extraReroll: p.unlocks.includes('reroll'),
  };
}
export function summarizeRun(run: SurvivorRun): RunSummary {
  return {
    collectedGold: run.gold,
    bossRewardGold: run.bossRewardGold,
    bossesDefeated: run.bossesDefeated,
    lastRewardedBossStage: run.lastRewardedBossStage,
    highestReachedStage: run.highestReachedStage,
    highestCompletedStage: run.highestCompletedStage,
    tick: run.tick,
    level: run.level,
    kills: run.kills,
    firstBossEligible: run.bossesDefeated > 0,
  };
}
export function checkpointFor(runId: string, run: SurvivorRun, savedAt: number): RunCheckpoint {
  return { runId, seed: run.seed, savedAt, ...summarizeRun(run) };
}
export function checkpointAdvances(before: RunCheckpoint, after: RunCheckpoint): boolean {
  return (
    validCheckpoint(after) &&
    before.runId === after.runId &&
    before.seed === after.seed &&
    after.savedAt >= before.savedAt &&
    summaryKeys.every((k) => {
      if (k === 'firstBossEligible') return !before.firstBossEligible || after.firstBossEligible;
      const key = k as Exclude<keyof RunSummary, 'firstBossEligible'>;
      return after[key] >= before[key];
    })
  );
}
export function refundAmount(p: SurvivorProfile): number {
  return UPGRADE_IDS.reduce(
    (total, id) => total + p.upgrades[id].paid.reduce((a, b) => a + b, 0),
    0,
  );
}

export type Purchase = { kind: 'upgrade'; id: UpgradeId } | { kind: 'unlock'; id: UnlockId };
export function purchaseQuote(p: SurvivorProfile, item: Purchase) {
  const rank =
    item.kind === 'upgrade' ? p.upgrades[item.id].rank : Number(p.unlocks.includes(item.id));
  const cost =
    item.kind === 'upgrade'
      ? UPGRADES[item.id].costs[rank]
      : rank
        ? undefined
        : UNLOCKS[item.id].cost;
  return {
    rank,
    cost,
    balanceAfter: cost === undefined ? p.gold : p.gold - cost,
    available: !p.checkpoint && cost !== undefined && p.gold >= cost,
  };
}
/** Pure transaction proposals. The store publishes them only after successful persistence. */
export function purchaseProfile(p: SurvivorProfile, item: Purchase): SurvivorProfile | null {
  const q = purchaseQuote(p, item);
  if (!q.available || q.cost === undefined) return null;
  const next = structuredClone(p);
  next.gold -= q.cost;
  if (item.kind === 'upgrade') {
    next.upgrades[item.id].rank++;
    next.upgrades[item.id].paid.push(q.cost);
  } else next.unlocks.push(item.id);
  return next;
}
export function refundProfile(p: SurvivorProfile): SurvivorProfile | null {
  if (p.checkpoint || !UPGRADE_IDS.some((id) => p.upgrades[id].rank)) return null;
  const next = structuredClone(p);
  next.gold = Math.min(GOLD_CAP, p.gold + refundAmount(p));
  for (const id of UPGRADE_IDS) next.upgrades[id] = { rank: 0, paid: [] };
  return next;
}
export function settleProfile(
  p: SurvivorProfile,
  cp: RunCheckpoint,
  reason: Settlement['reason'],
): SurvivorProfile | null {
  if (
    !p.checkpoint ||
    !checkpointAdvances(p.checkpoint, cp) ||
    p.settlements.some((s) => s.runId === cp.runId)
  )
    return null;
  const next = structuredClone(p);
  const firstBossGold = cp.firstBossEligible && !p.firstBossRewarded ? FIRST_BOSS_GOLD : 0;
  const earnedGold = Math.floor(cp.collectedGold) + cp.bossRewardGold + firstBossGold;
  const creditedGold = Math.min(GOLD_CAP - p.gold, earnedGold);
  next.gold += creditedGold;
  next.firstBossRewarded ||= cp.firstBossEligible;
  next.records = {
    highestReachedStage: Math.max(p.records.highestReachedStage, cp.highestReachedStage),
    highestCompletedStage: Math.max(p.records.highestCompletedStage, cp.highestCompletedStage),
    longestTicks: Math.max(p.records.longestTicks, cp.tick),
    highestLevel: Math.max(p.records.highestLevel, cp.level),
    mostKills: Math.max(p.records.mostKills, cp.kills),
    totalBosses: p.records.totalBosses + cp.bossesDefeated,
  };
  next.settlements = [
    { ...cp, reason, firstBossGold, earnedGold, creditedGold },
    ...p.settlements,
  ].slice(0, 20);
  next.checkpoint = null;
  return next;
}
