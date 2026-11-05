import {
  ABILITIES,
  ABILITY_IDS,
  BASE_STATS,
  CARD_REWARDS,
  EVOLUTIONS,
  EVOLUTION_TICK,
  MAX_EVOLUTIONS,
  MAX_RANK,
  MAX_SLOTS,
  WEAPONS,
  WEAPON_IDS,
  weaponParameters,
} from './content';
import { nextRandom } from './random';
import { resolveStageTransition } from './stages';
import type {
  CardEffect,
  EvolutionId,
  OwnedAbility,
  SurvivorCard,
  SurvivorRun,
  SurvivorStartOptions,
  SurvivorStats,
} from './types';

type Bonuses = SurvivorRun['startBonuses'];
const finiteBonus = (value: number | undefined, max: number) =>
  Number.isFinite(value) ? Math.max(0, Math.min(max, value!)) : 0;

export function initialProgression(options: SurvivorStartOptions) {
  const b = options.bonuses;
  const bonuses: Bonuses = {
    hp: finiteBonus(b?.hp, 0.25),
    attack: finiteBonus(b?.attack, 0.15),
    pickup: finiteBonus(b?.pickup, 0.3),
    gold: finiteBonus(b?.gold, 0.15),
    move: finiteBonus(b?.move, 0.5),
    cooldown: finiteBonus(b?.cooldown, 0.5),
  };
  return {
    bonuses,
    stats: calculateStats(bonuses, []),
    unlockedWeapons: WEAPON_IDS.filter(
      (id) => WEAPONS[id].unlocked || options.unlockedWeapons?.includes(id),
    ),
    rerolls: options.extraReroll === true ? 2 : 1,
  };
}

/** Recompute from run-start bonuses, never compound a previously modified stat. */
export function calculateStats(b: Bonuses, abilities: readonly OwnedAbility[]): SurvivorStats {
  const effect = (id: OwnedAbility['id']) =>
    (abilities.find((a) => a.id === id)?.rank ?? 0) * ABILITIES[id].perRank;
  return {
    maxHp: Math.round(BASE_STATS.maxHp * (1 + b.hp)) + effect('heart'),
    moveSpeed: BASE_STATS.moveSpeed * (1 + Math.min(0.5, b.move + effect('feet'))),
    armor: effect('fur'),
    pickupRadius: BASE_STATS.pickupRadius * (1 + b.pickup + effect('nose')),
    attackBonus: b.attack + effect('fangs'),
    cooldownReduction: Math.min(0.5, b.cooldown + effect('tail')),
    experienceBonus: effect('wisdom'),
    goldBonus: b.gold + effect('luck'),
  };
}

const effect = (label: string, before: number, after: number, unit = ''): CardEffect => ({
  label,
  before: Number(before.toFixed(6)),
  after: Number(after.toFixed(6)),
  unit,
});

function weaponEffects(
  run: SurvivorRun,
  id: SurvivorRun['weapons'][number]['id'],
  rank: number,
  evolved: boolean,
) {
  const previous = run.weapons.find((w) => w.id === id);
  const before = previous
    ? weaponParameters(id, previous.rank, previous.evolved, run.player.stats)
    : null;
  const after = weaponParameters(id, rank, evolved, run.player.stats);
  const changes = [
    effect('피해', before?.damage ?? 0, after.damage),
    effect(
      id === 'orbit' ? '회전 주기' : '공격 주기',
      (before?.cooldownTicks ?? 0) / 60,
      after.cooldownTicks / 60,
      '초',
    ),
    effect('반경', before?.radius ?? 0, after.radius),
    effect('개수', before?.count ?? 0, after.count),
  ];
  if (id === 'bite')
    changes.push(
      effect(
        '공격 각도',
        ((before?.halfAngle ?? 0) * 360) / Math.PI,
        (after.halfAngle * 360) / Math.PI,
        '도',
      ),
    );
  if (id === 'boomerang') changes.push(effect('최대 거리', before?.range ?? 0, after.range));
  if (id === 'trail')
    changes.push(
      effect('지속 시간', (before?.durationTicks ?? 0) / 60, after.durationTicks / 60, '초'),
    );
  if (after.repeats) changes.push(effect('추가 발동', before?.repeats ?? 0, after.repeats, '회'));
  return changes.filter((e) => e.before !== e.after);
}

function abilityEffects(run: SurvivorRun, id: OwnedAbility['id'], rank: number) {
  const abilities = [...run.abilities.filter((a) => a.id !== id), { id, rank }];
  const before = run.player.stats;
  const after = calculateStats(run.startBonuses, abilities);
  const changes = [
    effect('최대 HP', before.maxHp, after.maxHp),
    effect(
      '현재 HP',
      run.player.hp,
      Math.min(after.maxHp, run.player.hp + Math.max(0, after.maxHp - before.maxHp)),
    ),
    effect('공격력 보너스', before.attackBonus * 100, after.attackBonus * 100, '%'),
    effect('공격 주기 감소', before.cooldownReduction * 100, after.cooldownReduction * 100, '%'),
    effect('방어력', before.armor, after.armor),
    effect('이동 속도', before.moveSpeed, after.moveSpeed),
    effect('수집 반경', before.pickupRadius, after.pickupRadius),
    effect('경험치 보너스', before.experienceBonus * 100, after.experienceBonus * 100, '%'),
    effect('골드 보너스', before.goldBonus * 100, after.goldBonus * 100, '%'),
  ];
  const cappedLabel = id === 'feet' ? '이동 속도' : id === 'tail' ? '공격 주기 감소' : '';
  return changes.filter((e) => e.before !== e.after || e.label === cappedLabel);
}

/** No randomness here: candidates can be inspected without changing an offer. */
export function eligibleCards(run: SurvivorRun): SurvivorCard[] {
  const cards: SurvivorCard[] = [];
  for (const id of WEAPON_IDS) {
    const owned = run.weapons.find((w) => w.id === id);
    if (
      owned
        ? owned.rank >= MAX_RANK || owned.evolved
        : run.weapons.length >= MAX_SLOTS || !run.unlockedWeapons.includes(id)
    )
      continue;
    const rank = owned?.rank ?? 0;
    cards.push({
      id: `weapon:${id}`,
      name: WEAPONS[id].name,
      kind: 'weapon',
      target: id,
      fromRank: rank,
      toRank: rank + 1,
      effects: weaponEffects(run, id, rank + 1, false),
    });
  }
  for (const id of ABILITY_IDS) {
    const rank = run.abilities.find((a) => a.id === id)?.rank ?? 0;
    if (rank >= MAX_RANK || (!rank && run.abilities.length >= MAX_SLOTS)) continue;
    cards.push({
      id: `ability:${id}`,
      name: ABILITIES[id].name,
      kind: 'ability',
      target: id,
      fromRank: rank,
      toRank: rank + 1,
      effects: abilityEffects(run, id, rank + 1),
    });
  }
  if (run.tick >= EVOLUTION_TICK && run.weapons.filter((w) => w.evolved).length < MAX_EVOLUTIONS) {
    for (const id of Object.keys(EVOLUTIONS) as EvolutionId[]) {
      const e = EVOLUTIONS[id];
      const weapon = run.weapons.find((w) => w.id === e.weapon);
      const ability = run.abilities.find((a) => a.id === e.ability);
      if (!weapon || weapon.rank !== MAX_RANK || weapon.evolved || !ability || ability.rank < 3)
        continue;
      cards.push({
        id: `evolution:${id}`,
        name: e.name,
        kind: 'evolution',
        target: id,
        fromRank: MAX_RANK,
        toRank: MAX_RANK,
        effects: weaponEffects(run, e.weapon, MAX_RANK, true),
      });
    }
  }
  return cards;
}

function reward(run: SurvivorRun, target: 'heal' | 'gold'): SurvivorCard {
  return {
    id: `reward:${target}`,
    name: target === 'heal' ? '든든한 간식' : '골드 주머니',
    kind: 'reward',
    target,
    fromRank: 0,
    toRank: 0,
    effects: [
      target === 'heal'
        ? effect(
            '현재 HP',
            run.player.hp,
            Math.min(
              run.player.stats.maxHp,
              run.player.hp + run.player.stats.maxHp * CARD_REWARDS.healFraction,
            ),
          )
        : effect(
            '이번 판 골드',
            run.gold,
            run.gold + CARD_REWARDS.gold * (1 + run.player.stats.goldBonus),
          ),
    ],
  };
}

function drawChoice(run: SurvivorRun) {
  const pool = eligibleCards(run);
  const selected: SurvivorCard[] = [];
  const randomIndex = (length: number) => {
    const next = nextRandom(run.random.cards);
    run.random.cards = next.state;
    return Math.floor(next.value * length);
  };
  const pick = (candidates: SurvivorCard[]) => {
    if (!candidates.length) return;
    const card = candidates[randomIndex(candidates.length)];
    selected.push(card);
    pool.splice(pool.indexOf(card), 1);
  };
  pick(pool.filter((c) => c.kind === 'evolution' || c.fromRank > 0));
  if (run.weapons.length < 2) pick(pool.filter((c) => c.kind === 'weapon' && c.fromRank === 0));
  while (selected.length < 3 && pool.length) pick(pool);
  if (selected.length < 3 && run.player.hp < run.player.stats.maxHp)
    selected.push(reward(run, 'heal'));
  if (selected.length < 3) selected.push(reward(run, 'gold'));
  for (let i = selected.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [selected[i], selected[j]] = [selected[j], selected[i]];
  }
  run.choice = { id: ++run.choiceSequence, cards: selected };
}

export function openSurvivorChoice(run: SurvivorRun): void {
  if (run.phase === 'choosing' && run.pendingChoices > 0 && !run.choice) drawChoice(run);
}

/** The offer ID is required so an old click/key event cannot spend the next choice. */
export function chooseSurvivorCard(run: SurvivorRun, choiceId: number, cardId: string): boolean {
  if (run.phase !== 'choosing' || run.pendingChoices <= 0 || run.choice?.id !== choiceId)
    return false;
  const offered = run.choice.cards.find((c) => c.id === cardId);
  if (!offered) return false;
  const card =
    offered.kind === 'reward' ? offered : eligibleCards(run).find((c) => c.id === cardId);
  if (!card) return false;
  if (card.kind === 'weapon') {
    const owned = run.weapons.find((w) => w.id === card.target);
    if (owned) owned.rank++;
    else run.weapons.push({ id: card.target, rank: 1, evolved: false });
  } else if (card.kind === 'ability') {
    const oldMax = run.player.stats.maxHp;
    const owned = run.abilities.find((a) => a.id === card.target);
    if (owned) owned.rank++;
    else run.abilities.push({ id: card.target, rank: 1 });
    run.player.stats = calculateStats(run.startBonuses, run.abilities);
    run.player.hp = Math.min(
      run.player.stats.maxHp,
      run.player.hp + Math.max(0, run.player.stats.maxHp - oldMax),
    );
  } else if (card.kind === 'evolution') {
    run.weapons.find((w) => w.id === EVOLUTIONS[card.target].weapon)!.evolved = true;
  } else if (card.target === 'heal') {
    run.player.hp = Math.min(
      run.player.stats.maxHp,
      run.player.hp + run.player.stats.maxHp * CARD_REWARDS.healFraction,
    );
  } else {
    collectSurvivorGold(run, CARD_REWARDS.gold);
  }
  run.pendingChoices--;
  run.choice = null;
  run.accumulator = 0;
  if (run.pendingChoices) drawChoice(run);
  else {
    run.phase = 'playing';
    resolveStageTransition(run);
  }
  return true;
}

export function rerollSurvivorCards(run: SurvivorRun, choiceId: number): boolean {
  if (
    run.phase !== 'choosing' ||
    run.pendingChoices <= 0 ||
    run.choice?.id !== choiceId ||
    run.rerolls <= 0
  )
    return false;
  run.rerolls--;
  drawChoice(run);
  return true;
}

/** Only collected gold/card rewards use this multiplier; clear bonuses do not. */
export function collectSurvivorGold(run: SurvivorRun, baseAmount: number): void {
  if (Number.isFinite(baseAmount) && baseAmount > 0)
    run.gold += baseAmount * (1 + run.player.stats.goldBonus);
}
