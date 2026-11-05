import { describe, expect, it } from 'vitest';
import { ABILITY_IDS, BASE_STATS, EVOLUTION_TICK, FIXED_STEP, WEAPON_IDS } from './content';
import { newSurvivor, pauseSurvivor, resumeSurvivor, stepSurvivor } from './engine';
import {
  calculateStats,
  chooseSurvivorCard,
  collectSurvivorGold,
  eligibleCards,
  openSurvivorChoice,
  rerollSurvivorCards,
} from './progression';
import type { AbilityId, SurvivorCard, SurvivorRun, WeaponId } from './types';

function choosing(run = newSurvivor(), count = 1) {
  run.phase = 'choosing';
  run.pendingChoices = count;
  openSurvivorChoice(run);
  return run;
}
// Isolate card application from random offering; the card still must be eligible.
function apply(run: SurvivorRun, id: string) {
  const card = eligibleCards(run).find((c) => c.id === id);
  expect(card, id).toBeDefined();
  run.phase = 'choosing';
  run.pendingChoices = 1;
  run.choice = { id: ++run.choiceSequence, cards: [card!] };
  expect(chooseSurvivorCard(run, run.choice.id, id)).toBe(true);
  return card!;
}
function exhausted(hp = 100) {
  const run = newSurvivor();
  run.weapons = ['bite', 'boomerang', 'wave', 'orbit'].map((id) => ({
    id: id as WeaponId,
    rank: 5,
    evolved: false,
  }));
  run.abilities = ['heart', 'feet', 'nose', 'wisdom'].map((id) => ({
    id: id as AbilityId,
    rank: 5,
  }));
  run.player.hp = hp;
  return run;
}
const ids = (cards: SurvivorCard[]) => cards.map((c) => c.id);

describe('G.8.2 카드 후보와 선택', () => {
  it('offers three distinct cards with an owned upgrade and new weapon across seeds', () => {
    const appearances = new Set<string>();
    for (let seed = 0; seed < 500; seed++) {
      const run = choosing(newSurvivor(seed));
      const cards = run.choice!.cards;
      expect(new Set(ids(cards)).size).toBe(3);
      expect(ids(cards)).toContain('weapon:bite');
      expect(cards.some((c) => c.kind === 'weapon' && c.fromRank === 0)).toBe(true);
      for (const c of cards) appearances.add(c.id);
      const old = run.choice!.id;
      expect(rerollSurvivorCards(run, old)).toBe(true);
      expect(ids(run.choice!.cards)).toContain('weapon:bite');
      expect(run.choice!.cards.some((c) => c.kind === 'weapon' && c.fromRank === 0)).toBe(true);
      expect(new Set(ids(run.choice!.cards)).size).toBe(3);
    }
    expect(appearances.size).toBe(12); // Four default weapons and all eight abilities.
  });

  it('enforces separate four-slot limits, unlocks, rank five and evolved exclusions', () => {
    const run = newSurvivor();
    expect(ids(eligibleCards(run))).not.toContain('weapon:trail');
    expect(ids(eligibleCards(run))).not.toContain('weapon:acorn');
    const unlocked = newSurvivor(1, { unlockedWeapons: ['trail', 'acorn', 'trail'] });
    expect(unlocked.unlockedWeapons).toEqual(WEAPON_IDS);
    for (const id of ['boomerang', 'wave', 'trail']) apply(unlocked, `weapon:${id}`);
    expect(unlocked.weapons).toHaveLength(4);
    expect(ids(eligibleCards(unlocked))).not.toContain('weapon:acorn');
    expect(ids(eligibleCards(unlocked))).not.toContain('weapon:orbit');
    expect(ids(eligibleCards(unlocked))).toContain('weapon:trail');
    for (const id of ['heart', 'fur', 'feet', 'nose']) apply(unlocked, `ability:${id}`);
    expect(unlocked.abilities).toHaveLength(4);
    expect(ids(eligibleCards(unlocked))).not.toContain('ability:luck');
    for (let i = 1; i < 5; i++) apply(unlocked, 'ability:heart');
    expect(ids(eligibleCards(unlocked))).not.toContain('ability:heart');
    unlocked.weapons[0].rank = 5;
    expect(ids(eligibleCards(unlocked))).not.toContain('weapon:bite');
    unlocked.weapons[1].evolved = true;
    expect(ids(eligibleCards(unlocked))).not.toContain('weapon:boomerang');
  });

  it('freezes the offered cards across inspection, ticks, pause and resume', () => {
    const run = choosing(newSurvivor(42), 2);
    const before = structuredClone(run);
    for (let i = 0; i < 10; i++) {
      openSurvivorChoice(run);
      eligibleCards(run);
      stepSurvivor(run, 1);
    }
    expect(run).toEqual(before);
    pauseSurvivor(run);
    expect(chooseSurvivorCard(run, run.choice!.id, run.choice!.cards[0].id)).toBe(false);
    expect(rerollSurvivorCards(run, run.choice!.id)).toBe(false);
    resumeSurvivor(run);
    expect(run).toEqual(before);
  });

  it('applies one queued level at a time and rejects stale, foreign and double selections', () => {
    const run = choosing(newSurvivor(7), 3);
    const first = run.choice!;
    expect(chooseSurvivorCard(run, first.id, 'weapon:acorn')).toBe(false);
    expect(chooseSurvivorCard(run, first.id, 'weapon:bite')).toBe(true);
    expect(run.weapons[0].rank).toBe(2);
    expect(run.pendingChoices).toBe(2);
    expect(run.phase).toBe('choosing');
    expect(run.choice!.id).not.toBe(first.id);
    const after = structuredClone(run);
    expect(chooseSurvivorCard(run, first.id, 'weapon:bite')).toBe(false);
    expect(run).toEqual(after);
    const upgrade = run.choice!.cards.find((c) => c.id === 'weapon:bite');
    expect(upgrade?.fromRank).toBe(2);
    expect(upgrade?.toRank).toBe(3);
    for (let i = 0; i < 2; i++)
      expect(chooseSurvivorCard(run, run.choice!.id, run.choice!.cards[0].id)).toBe(true);
    expect(run.phase).toBe('playing');
    expect(run.pendingChoices).toBe(0);
    expect(run.choice).toBeNull();
    expect(run.tick).toBe(0);
    stepSurvivor(run, FIXED_STEP);
    expect(run.tick).toBe(1);
  });

  it('limits rerolls to one or two, invalidates old offers and only consumes cards RNG', () => {
    for (const extraReroll of [false, true]) {
      const a = choosing(newSurvivor(22, { extraReroll }));
      const b = choosing(newSurvivor(22, { extraReroll }));
      const random = { ...a.random };
      for (let i = 0; i < (extraReroll ? 2 : 1); i++) {
        const old = a.choice!;
        expect(rerollSurvivorCards(a, old.id)).toBe(true);
        rerollSurvivorCards(b, b.choice!.id);
        expect(rerollSurvivorCards(a, old.id)).toBe(false);
        expect(chooseSurvivorCard(a, old.id, old.cards[0].id)).toBe(false);
      }
      expect(a).toEqual(b);
      expect(a.pendingChoices).toBe(1);
      expect(a.rerolls).toBe(0);
      expect(a.random.spawn).toBe(random.spawn);
      expect(a.random.drops).toBe(random.drops);
      expect(a.random.cards).not.toBe(random.cards);
      const before = structuredClone(a);
      expect(rerollSurvivorCards(a, a.choice!.id)).toBe(false);
      expect(a).toEqual(before);
    }
  });

  it('fills candidate shortages without duplicates and can always finish an exhausted choice', () => {
    const full = choosing(exhausted());
    expect(ids(full.choice!.cards)).toEqual(['reward:gold']);
    chooseSurvivorCard(full, full.choice!.id, 'reward:gold');
    expect(full.gold).toBe(8);
    expect(full.phase).toBe('playing');
    const hurt = choosing(exhausted(90));
    expect(new Set(ids(hurt.choice!.cards))).toEqual(new Set(['reward:heal', 'reward:gold']));
    chooseSurvivorCard(hurt, hurt.choice!.id, 'reward:heal');
    expect(hurt.player.hp).toBe(100);
    const one = exhausted(10);
    one.weapons[0].rank = 4;
    choosing(one);
    expect(new Set(ids(one.choice!.cards))).toEqual(
      new Set(['weapon:bite', 'reward:heal', 'reward:gold']),
    );
    chooseSurvivorCard(one, one.choice!.id, 'reward:heal');
    expect(one.player.hp).toBe(35);
    const two = exhausted(10);
    two.weapons[0].rank = two.weapons[1].rank = 4;
    choosing(two);
    expect(new Set(ids(two.choice!.cards))).toEqual(
      new Set(['weapon:bite', 'weapon:boomerang', 'reward:heal']),
    );
  });

  it('checks all evolution gates at the exact combat-time boundary and caps evolutions at two', () => {
    const run = newSurvivor();
    run.weapons = ['bite', 'boomerang', 'wave'].map((id) => ({
      id: id as WeaponId,
      rank: 5,
      evolved: false,
    }));
    run.abilities = ['fangs', 'tail', 'fur'].map((id) => ({ id: id as AbilityId, rank: 3 }));
    run.tick = EVOLUTION_TICK - 1;
    expect(eligibleCards(run).filter((c) => c.kind === 'evolution')).toHaveLength(0);
    run.tick++;
    expect(eligibleCards(run).filter((c) => c.kind === 'evolution')).toHaveLength(3);
    run.weapons[0].rank = 4;
    run.abilities[1].rank = 2;
    expect(ids(eligibleCards(run).filter((c) => c.kind === 'evolution'))).toEqual([
      'evolution:lion-roar',
    ]);
    run.weapons[0].rank = 5;
    run.abilities[1].rank = 3;
    apply(run, 'evolution:king-bite');
    expect(run.weapons[0]).toEqual({ id: 'bite', rank: 5, evolved: true });
    expect(run.weapons).toHaveLength(3);
    expect(ids(eligibleCards(run))).not.toContain('evolution:king-bite');
    apply(run, 'evolution:golden-bone');
    expect(eligibleCards(run).filter((c) => c.kind === 'evolution')).toHaveLength(0);
    expect(run.weapons[2].evolved).toBe(false);
  });

  it('executes actual XP -> offers -> 39 sequential choices -> combat without a skip path', () => {
    const run = newSurvivor(42, { unlockedWeapons: ['trail', 'acorn'] });
    run.drops.push({
      id: run.nextEntityId++,
      kind: 'xp',
      x: run.player.x,
      y: run.player.y,
      value: 100000,
    });
    stepSurvivor(run, 1 / 30);
    expect(run.pendingChoices).toBe(39);
    let count = 0;
    while (run.choice) {
      const card = run.choice.cards[count % run.choice.cards.length];
      expect(chooseSurvivorCard(run, run.choice.id, card.id)).toBe(true);
      expect(run.tick).toBe(1);
      expect(run.weapons.length).toBeLessThanOrEqual(4);
      expect(run.abilities.length).toBeLessThanOrEqual(4);
      count++;
      expect(count).toBeLessThanOrEqual(39);
    }
    expect(count).toBe(39);
    expect(run.level).toBe(40);
    expect(run.phase).toBe('playing');
    stepSurvivor(run, FIXED_STEP);
    expect(run.tick).toBe(2);
  });

  it('earns and selects multiple cards in untouched seeded runs using movement and automatic attacks', () => {
    for (const seed of [0, 42, 4294967295]) {
      const run = newSurvivor(seed);
      let choices = 0;
      const priority = ['weapon:orbit', 'weapon:bite', 'ability:fangs', 'ability:heart'];
      for (let frame = 0; frame < 60 * 90 && run.phase !== 'result'; frame++) {
        if (run.choice) {
          const card = [...run.choice.cards].sort(
            (a, b) =>
              (priority.includes(a.id) ? priority.indexOf(a.id) : 100) -
              (priority.includes(b.id) ? priority.indexOf(b.id) : 100),
          )[0];
          expect(chooseSurvivorCard(run, run.choice.id, card.id)).toBe(true);
          choices++;
        }
        const distance = (p: { x: number; y: number }) =>
          Math.hypot(p.x - run.player.x, p.y - run.player.y);
        const danger = [...run.enemies].sort((a, b) => distance(a) - distance(b))[0];
        const fleeing = danger && distance(danger) < 48;
        const target = fleeing
          ? danger
          : [...(run.drops.length ? run.drops : run.enemies)].sort(
              (a, b) => distance(a) - distance(b),
            )[0];
        const length = target ? distance(target) : 0;
        const moving = length > 0 && (fleeing || run.drops.length > 0 || length > 82);
        stepSurvivor(run, FIXED_STEP, {
          moveX: moving ? ((target.x - run.player.x) / length) * (fleeing ? -1 : 1) : 0,
          moveY: moving ? ((target.y - run.player.y) / length) * (fleeing ? -1 : 1) : 0,
        });
      }
      expect(choices, `seed=${seed}, tick=${run.tick}, level=${run.level}`).toBeGreaterThanOrEqual(
        3,
      );
      expect(run.kills).toBeGreaterThanOrEqual(10);
      expect(run.choice?.cards.length ?? 1).toBeGreaterThan(0);
    }
  });
});

describe('G.8.2 능력과 변화량', () => {
  it('applies all eight rank-five abilities additively and only heart heals on acquisition', () => {
    const expected: Record<AbilityId, Partial<typeof BASE_STATS>> = {
      fangs: { attackBonus: 0.5 },
      tail: { cooldownReduction: 0.4 },
      heart: { maxHp: 175 },
      fur: { armor: 5 },
      feet: { moveSpeed: 262.5 },
      nose: { pickupRadius: 144 },
      wisdom: { experienceBonus: 0.5 },
      luck: { goldBonus: 0.75 },
    };
    for (const id of ABILITY_IDS) {
      const run = newSurvivor();
      run.player.hp = 30;
      for (let rank = 1; rank <= 5; rank++) {
        const beforeHp = run.player.hp;
        const card = apply(run, `ability:${id}`);
        expect(card.fromRank).toBe(rank - 1);
        expect(card.toRank).toBe(rank);
        if (id === 'heart')
          expect(card.effects.find((e) => e.label === '현재 HP')).toEqual({
            label: '현재 HP',
            before: beforeHp,
            after: beforeHp + 15,
            unit: '',
          });
      }
      expect(run.player.stats).toEqual({ ...BASE_STATS, ...expected[id] });
      expect(run.player.hp).toBe(id === 'heart' ? 105 : 30);
    }
  });

  it('adds run-start bonuses once, validates inputs and caps movement/cooldown at 50 percent', () => {
    const run = newSurvivor(0, {
      bonuses: { hp: 0.25, attack: 0.15, pickup: 0.3, gold: 0.15, move: 0.4, cooldown: 0.4 },
    });
    expect(run.player.hp).toBe(125);
    const stats = calculateStats(run.startBonuses, [
      { id: 'heart', rank: 5 },
      { id: 'fangs', rank: 5 },
      { id: 'feet', rank: 5 },
      { id: 'tail', rank: 5 },
    ]);
    expect(stats.maxHp).toBe(200);
    expect(stats.attackBonus).toBeCloseTo(0.65);
    expect(stats.moveSpeed).toBe(315);
    expect(stats.cooldownReduction).toBe(0.5);
    expect(stats.pickupRadius).toBeCloseTo(83.2);
    expect(stats.goldBonus).toBe(0.15);
    const invalid = newSurvivor(0, { bonuses: { hp: NaN, attack: -1, gold: Infinity } });
    expect(invalid.player.stats).toEqual(BASE_STATS);
    const card = apply(run, 'weapon:bite');
    expect(card.effects.find((e) => e.label === '피해')).toEqual({
      label: '피해',
      before: 21,
      after: 27,
      unit: '',
    });
    for (let i = 0; i < 3; i++) apply(run, 'ability:tail');
    expect(eligibleCards(run).find((c) => c.id === 'ability:tail')?.effects).toEqual([
      { label: '공격 주기 감소', before: 50, after: 50, unit: '%' },
    ]);
  });

  it('preserves fractional gold, applies luck only on collection, including fallback cards', () => {
    const run = newSurvivor(1, { bonuses: { gold: 0.05 } });
    collectSurvivorGold(run, 1);
    expect(run.gold).toBeCloseTo(1.05);
    apply(run, 'ability:luck');
    expect(run.gold).toBeCloseTo(1.05);
    collectSurvivorGold(run, 1);
    expect(run.gold).toBeCloseTo(2.25);
    for (const invalid of [-1, 0, NaN, Infinity]) collectSurvivorGold(run, invalid);
    expect(run.gold).toBeCloseTo(2.25);
    const full = exhausted();
    full.player.stats.goldBonus = 0.2;
    choosing(full);
    expect(full.choice!.cards[0].effects[0].after).toBe(9.6);
    chooseSurvivorCard(full, full.choice!.id, 'reward:gold');
    expect(full.gold).toBeCloseTo(9.6);
  });
});
