import { describe, expect, it } from 'vitest';
import { newSurvivor, pauseSurvivor, resumeSurvivor } from './engine';
import { eligibleCards } from './progression';
import {
  GOLD_CAP,
  PROFILE_KEY,
  UPGRADE_IDS,
  UPGRADES,
  checkpointFor,
  isSurvivorProfile,
  newSurvivorProfile,
  parseSurvivorProfile,
  profileStartOptions,
  refundAmount,
  type SurvivorProfile,
} from './profile';
import { SurvivorProfileStore, type ProfileEnvironment } from './profileStore';
import { SurvivorSession } from './session';
import { continueSurvivorStage, finishSurvivor } from './stages';
import type { SurvivorRun } from './types';

function harness(initial: SurvivorProfile | string | null = null) {
  let raw = typeof initial === 'string' || initial === null ? initial : JSON.stringify(initial);
  let locked = false,
    writes = 0,
    ids = 0,
    readFails = false,
    writeFails = false,
    now = 1000;
  const listeners = new Set<() => void>();
  const env: ProfileEnvironment = {
    storage: {
      getItem: (key) => {
        expect(key).toBe(PROFILE_KEY);
        if (readFails) throw Error('denied');
        return raw;
      },
      setItem: (key, value) => {
        expect(key).toBe(PROFILE_KEY);
        if (writeFails) throw Error('quota');
        raw = value;
        writes++;
      },
    },
    acquire: async () => {
      if (locked) return null;
      locked = true;
      return () => {
        locked = false;
      };
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    now: () => now,
    uuid: () => `run-${++ids}`,
  };
  return {
    env,
    store: () => new SurvivorProfileStore(env),
    get raw() {
      return raw;
    },
    get writes() {
      return writes;
    },
    get locked() {
      return locked;
    },
    get listeners() {
      return listeners.size;
    },
    set raw(v: string | null) {
      raw = v;
    },
    set writeFails(v: boolean) {
      writeFails = v;
    },
    set readFails(v: boolean) {
      readFails = v;
    },
    set now(v: number) {
      now = v;
    },
    emit: () => listeners.forEach((f) => f()),
  };
}
function funded(gold = 2000) {
  const p = newSurvivorProfile();
  p.gold = gold;
  return p;
}
function totals(run: SurvivorRun, completed = 6, gold = 25.75) {
  run.highestCompletedStage = completed;
  run.highestReachedStage = Math.max(1, completed);
  run.stage.index = Math.max(1, completed);
  run.tick = completed * 3600;
  run.bossesDefeated = Math.floor(completed / 3);
  run.bossRewardGold = run.bossesDefeated * 40;
  run.lastRewardedBossStage = run.bossesDefeated * 3;
  run.gold = gold;
  run.level = 4;
  run.kills = 50;
  run.phase = 'stageClear';
  run.pendingChoices = 0;
  run.choice = null;
}
function mutate(p: SurvivorProfile, path: string, value: unknown) {
  const parts = path.split('.');
  let node = p as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) node = node[part] as Record<string, unknown>;
  node[parts.at(-1)!] = value;
}

describe('profile schema and run-start effects', () => {
  it('accepts absent storage without writing, validates a complete round trip', () => {
    const p = newSurvivorProfile();
    expect(parseSurvivorProfile(null)).toEqual({ ok: true, profile: p });
    expect(parseSurvivorProfile(JSON.stringify(p))).toEqual({ ok: true, profile: p });
  });
  it.each([
    ['gold', -1],
    ['gold', 1.5],
    ['gold', GOLD_CAP + 1],
    ['gold', NaN],
    ['gold', Infinity],
    ['upgrades.hp.rank', 6],
    ['upgrades.pickup.rank', 4],
    ['upgrades.hp.paid', [30]],
    ['unlocks', ['unknown']],
    ['unlocks', ['trail', 'trail']],
    ['settings.muted', 1],
    ['settings.motion', 'auto'],
    ['records.highestLevel', 41],
    ['records.totalBosses', 1],
    ['firstBossRewarded', true],
    ['revision', -1],
    ['schemaVersion', 0],
    ['unexpected', true],
  ])('rejects invalid %s = %s', (path, value) => {
    const p = newSurvivorProfile();
    mutate(p, path, value);
    expect(isSurvivorProfile(p)).toBe(false);
  });
  it('preserves malformed and future records as errors', () => {
    for (const raw of ['{', 'null', '[]', '', 'x'.repeat(100_001)])
      expect(parseSurvivorProfile(raw).ok).toBe(false);
    expect(parseSurvivorProfile('{"schemaVersion":2}')).toEqual({ ok: false, error: 'future' });
  });
  it('maps all purchased maximum ranks to engine stats and actual candidate unlocks', () => {
    const p = funded();
    for (const id of UPGRADE_IDS)
      p.upgrades[id] = { rank: UPGRADES[id].costs.length, paid: [...UPGRADES[id].costs] };
    p.unlocks = ['trail', 'acorn', 'reroll'];
    const run = newSurvivor(1, profileStartOptions(p));
    expect(run.player.hp).toBe(125);
    expect(run.player.stats.attackBonus).toBeCloseTo(0.15);
    expect(run.player.stats.pickupRadius).toBeCloseTo(83.2);
    expect(run.player.stats.goldBonus).toBeCloseTo(0.15);
    expect(run.rerolls).toBe(2);
    expect(run.weapons).toHaveLength(1);
    expect(
      eligibleCards(run)
        .filter((c) => c.kind === 'weapon')
        .map((c) => c.target),
    ).toContain('acorn');
    expect(newSurvivor(1).unlockedWeapons).not.toContain('acorn');
  });
  it.each([
    'bossRewardGold',
    'bossesDefeated',
    'lastRewardedBossStage',
    'firstBossEligible',
    'highestCompletedStage',
    'tick',
  ])('rejects inconsistent checkpoint %s', (key) => {
    const p = newSurvivorProfile(),
      r = newSurvivor();
    totals(r);
    p.checkpoint = checkpointFor('test', r, 1);
    expect(isSurvivorProfile(p)).toBe(true);
    mutate(p, `checkpoint.${key}`, key === 'firstBossEligible' ? false : 0);
    expect(isSurvivorProfile(p)).toBe(false);
  });
});

describe('atomic purchases and refunds', () => {
  it('serializes rapid old-revision clicks, rejects insufficient balance/max rank and live-run shopping', async () => {
    const h = harness(funded(600)),
      s = h.store();
    await s.connect();
    const revision = s.getSnapshot().profile.revision;
    expect(s.purchase({ kind: 'upgrade', id: 'hp' }, revision)).toBe(true);
    for (let i = 0; i < 20; i++)
      expect(s.purchase({ kind: 'upgrade', id: 'hp' }, revision)).toBe(false);
    for (let i = 1; i < 5; i++)
      expect(s.purchase({ kind: 'upgrade', id: 'hp' }, s.getSnapshot().profile.revision)).toBe(
        true,
      );
    expect(s.getSnapshot().profile.gold).toBe(140);
    expect(s.purchase({ kind: 'upgrade', id: 'hp' }, s.getSnapshot().profile.revision)).toBe(false);
    expect(s.purchase({ kind: 'unlock', id: 'acorn' }, s.getSnapshot().profile.revision)).toBe(
      false,
    );
    expect(s.begin(newSurvivor(), s.getSnapshot().profile.revision)).toBeTruthy();
    expect(s.purchase({ kind: 'unlock', id: 'trail' }, s.getSnapshot().profile.revision)).toBe(
      false,
    );
    expect(s.refund(s.getSnapshot().profile.revision)).toBe(false);
    expect(s.recover()).toBe(false); // Never recover a live run as an interrupted run.
  });
  it('refunds historic amounts, excludes permanent unlocks, and cannot refund twice', async () => {
    const p = funded(100);
    p.upgrades.hp = { rank: 2, paid: [7, 11] };
    p.unlocks = ['trail', 'reroll'];
    const h = harness(p),
      s = h.store();
    await s.connect();
    expect(refundAmount(p)).toBe(18);
    expect(s.refund(0)).toBe(true);
    expect(s.getSnapshot().profile.gold).toBe(118);
    expect(s.getSnapshot().profile.unlocks).toEqual(['trail', 'reroll']);
    expect(s.refund(0)).toBe(false);
    expect(s.refund(1)).toBe(false);
    expect(h.writes).toBe(1);
  });
  it('caps refund balance and keeps reroll unlocked', async () => {
    const p = funded(GOLD_CAP);
    p.upgrades.attack = { rank: 1, paid: [40] };
    p.unlocks = ['reroll'];
    const h = harness(p),
      s = h.store();
    await s.connect();
    expect(s.refund(0)).toBe(true);
    expect(s.getSnapshot().profile.gold).toBe(GOLD_CAP);
    expect(profileStartOptions(s.getSnapshot().profile).extraReroll).toBe(true);
  });
  it.each(['purchase', 'refund', 'settings'] as const)(
    'does not publish %s until the single write succeeds',
    async (op) => {
      const p = funded();
      p.upgrades.hp = { rank: 1, paid: [30] };
      const h = harness(p),
        s = h.store();
      await s.connect();
      const before = s.getSnapshot().profile,
        raw = h.raw;
      const action = () =>
        op === 'purchase'
          ? s.purchase({ kind: 'upgrade', id: 'attack' }, 0)
          : op === 'refund'
            ? s.refund(0)
            : s.settings({ muted: false, motion: 'reduced' }, 0);
      h.writeFails = true;
      expect(action()).toBe(false);
      expect(s.getSnapshot().profile).toBe(before);
      expect(h.raw).toBe(raw);
      h.writeFails = false;
      expect(action()).toBe(true);
      expect(h.writes).toBe(1);
      expect(s.getSnapshot().error).toBeNull();
    },
  );
  it('persists a single weapon unlock and rejects its duplicate', async () => {
    const h = harness(funded()),
      s = h.store();
    await s.connect();
    expect(s.purchase({ kind: 'unlock', id: 'trail' }, 0)).toBe(true);
    expect(s.purchase({ kind: 'unlock', id: 'trail' }, 1)).toBe(false);
    expect(s.getSnapshot().profile.gold).toBe(1900);
  });
});

describe('checkpoints and exactly-once settlement', () => {
  it.each(['defeat', 'retired', 'abandoned'] as const)(
    'settles %s with one floor and fixed rewards in a single write',
    async (reason) => {
      const h = harness(),
        s = h.store();
      await s.connect();
      const r = newSurvivor(),
        id = s.begin(r, 0)!;
      totals(r);
      expect(s.checkpoint(id, r)).toBe(true);
      expect(s.getSnapshot().profile.gold).toBe(0);
      if (reason === 'defeat') {
        r.phase = 'result';
        r.result = reason;
      } else finishSurvivor(r, reason, r.stage.index);
      const writes = h.writes;
      expect(s.settle(id, r)).toBe(true);
      expect(h.writes).toBe(writes + 1);
      const p = s.getSnapshot().profile;
      expect(p.gold).toBe(135);
      expect(p.firstBossRewarded).toBe(true);
      expect(p.records.totalBosses).toBe(2);
      expect(p.checkpoint).toBeNull();
      expect(p.settlements[0]).toMatchObject({
        collectedGold: 25.75,
        bossRewardGold: 80,
        firstBossGold: 30,
        earnedGold: 135,
      });
      for (let i = 0; i < 10; i++) expect(s.settle(id, r)).toBe(false);
      expect(s.getSnapshot().profile).toBe(p);
    },
  );
  it('never settles stage clear, keeps fractions across checkpoints, and never repays first boss', async () => {
    const h = harness(),
      s = h.store();
    await s.connect();
    const r = newSurvivor(),
      id = s.begin(r, 0)!;
    totals(r, 3, 1.25);
    expect(s.checkpoint(id, r)).toBe(true);
    expect(s.settle(id, r)).toBe(false);
    continueSurvivorStage(r, 3);
    r.gold += 0.75;
    expect(s.checkpoint(id, r)).toBe(true);
    finishSurvivor(r, 'abandoned');
    expect(s.settle(id, r)).toBe(true);
    expect(s.getSnapshot().profile.gold).toBe(72);
    const r2 = newSurvivor(),
      id2 = s.begin(r2, s.getSnapshot().profile.revision)!;
    totals(r2, 3, 0);
    finishSurvivor(r2, 'retired', 3);
    expect(s.settle(id2, r2)).toBe(true);
    expect(s.getSnapshot().profile.gold).toBe(112);
    expect(s.getSnapshot().profile.settlements[0].firstBossGold).toBe(0);
  });
  it.each([0, 2, 3, 6])(
    'recovers stage %i checkpoint once after owner loss, without resuming combat',
    async (stage) => {
      const h = harness(),
        first = h.store();
      await first.connect();
      const r = newSurvivor(),
        id = first.begin(r, 0)!;
      totals(r, stage);
      if (stage === 0) r.phase = 'choosing';
      expect(first.checkpoint(id, r)).toBe(true);
      first.dispose();
      const next = h.store();
      await next.connect();
      expect(next.getSnapshot().profile.gold).toBe(
        25 + Math.floor(stage / 3) * 40 + (stage >= 3 ? 30 : 0),
      );
      expect(next.getSnapshot().profile.settlements[0].reason).toBe('interrupted');
      expect(next.getSnapshot().profile.checkpoint).toBeNull();
      next.dispose();
      const again = h.store();
      await again.connect();
      expect(again.getSnapshot().profile.settlements).toHaveLength(1);
    },
  );
  it('retains current result on write failure and retries the same atomic settlement', async () => {
    const h = harness(),
      s = h.store();
    await s.connect();
    const session = new SurvivorSession(s);
    expect(session.start(12, 0)).toBe(true);
    totals(session.run!);
    h.writeFails = true;
    expect(session.finish('retired', 6)).toBe(false);
    expect(session.run!.phase).toBe('result');
    expect(session.run!.gold).toBe(25.75);
    expect(s.getSnapshot().profile.gold).toBe(0);
    expect(session.start(3, s.getSnapshot().profile.revision)).toBe(false);
    expect(session.close()).toBe(false);
    expect(h.locked).toBe(true);
    h.writeFails = false;
    expect(session.retrySave()).toBe(true);
    expect(session.retrySave()).toBe(true);
    expect(s.getSnapshot().profile.gold).toBe(135);
    expect(session.close()).toBe(true);
    expect(h.locked).toBe(false);
  });
  it('retains interrupted checkpoint after recovery write failure and blocks new runs', async () => {
    const r = newSurvivor();
    totals(r, 3);
    const p = funded(0);
    p.checkpoint = checkpointFor('old', r, 1);
    const h = harness(p);
    h.writeFails = true;
    const s = h.store();
    await s.connect();
    expect(s.getSnapshot().profile.checkpoint?.runId).toBe('old');
    expect(s.begin(newSurvivor(), 0)).toBeNull();
    h.writeFails = false;
    expect(s.recover()).toBe(true);
    expect(s.getSnapshot().profile.gold).toBe(95);
  });
  it('rejects regressed checkpoints, wrong seed/run and inconsistent boss proofs', async () => {
    const h = harness(),
      s = h.store();
    await s.connect();
    const r = newSurvivor(5),
      id = s.begin(r, 0)!;
    totals(r, 3);
    expect(s.checkpoint(id, r)).toBe(true);
    const snapshot = s.getSnapshot().profile;
    expect(s.checkpoint('old', r)).toBe(false);
    r.gold--;
    expect(s.checkpoint(id, r)).toBe(false);
    r.gold++;
    r.seed++;
    expect(s.checkpoint(id, r)).toBe(false);
    r.seed--;
    r.bossRewardGold++;
    expect(s.checkpoint(id, r)).toBe(false);
    expect(s.getSnapshot().profile).toBe(snapshot);
  });
  it('checks boss proof even while card selection delays the clear screen', async () => {
    const h = harness(),
      s = h.store();
    await s.connect();
    const r = newSurvivor(),
      id = s.begin(r, 0)!;
    totals(r, 3);
    r.phase = 'choosing';
    r.stage.pendingTransition = 'stageClear';
    r.pendingChoices = 2;
    expect(s.checkpoint(id, r)).toBe(true);
    s.dispose();
    const recovered = h.store();
    await recovered.connect();
    expect(recovered.getSnapshot().profile.gold).toBe(95);
  });
  it('caps total gold but still records first-boss flag and total bosses', async () => {
    const h = harness(funded(GOLD_CAP - 1)),
      s = h.store();
    await s.connect();
    const r = newSurvivor(),
      id = s.begin(r, 0)!;
    totals(r);
    finishSurvivor(r, 'retired', 6);
    expect(s.settle(id, r)).toBe(true);
    expect(s.getSnapshot().profile.gold).toBe(GOLD_CAP);
    expect(s.getSnapshot().profile.settlements[0].creditedGold).toBe(1);
    expect(s.getSnapshot().profile.firstBossRewarded).toBe(true);
  });
  it('keeps only 20 settlements and rejects an expired old run event even during a new run', async () => {
    const h = harness(),
      s = h.store();
    await s.connect();
    let oldId = '',
      oldRun = newSurvivor();
    for (let i = 0; i < 25; i++) {
      const r = newSurvivor(i),
        id = s.begin(r, s.getSnapshot().profile.revision)!;
      r.gold = 1.9;
      finishSurvivor(r, 'abandoned');
      expect(s.settle(id, r)).toBe(true);
      if (!i) {
        oldId = id;
        oldRun = r;
      }
    }
    expect(s.getSnapshot().profile.settlements).toHaveLength(20);
    expect(s.getSnapshot().profile.gold).toBe(25);
    expect(s.settle(oldId, oldRun)).toBe(false);
    s.begin(newSurvivor(), s.getSnapshot().profile.revision);
    expect(s.settle(oldId, oldRun)).toBe(false);
    expect(s.getSnapshot().profile.gold).toBe(25);
  });
});

describe('ownership, fallbacks and save scheduling', () => {
  it('allows one writer, syncs read-only balance and releases ownership without effect-cleanup settlement', async () => {
    const h = harness(funded()),
      a = h.store(),
      b = h.store();
    await Promise.all([a.connect(), b.connect()]);
    expect(a.getSnapshot().mode).toBe('owner');
    expect(b.getSnapshot().mode).toBe('readonly');
    expect(b.purchase({ kind: 'upgrade', id: 'hp' }, 0)).toBe(false);
    a.purchase({ kind: 'upgrade', id: 'hp' }, 0);
    h.emit();
    expect(b.getSnapshot().profile.gold).toBe(1970);
    const r = newSurvivor(),
      id = a.begin(r, 1)!;
    r.gold = 7.5;
    a.checkpoint(id, r);
    const writes = h.writes;
    a.dispose();
    expect(h.writes).toBe(writes);
    await b.connect();
    expect(b.getSnapshot().mode).toBe('owner');
    expect(b.getSnapshot().profile.gold).toBe(1977);
    b.dispose();
    expect(h.listeners).toBe(0);
  });
  it.each(['unsupported', 'denied', 'future', 'corrupt'] as const)(
    'preserves raw data and permits explicit temporary play for %s',
    async (mode) => {
      const raw =
        mode === 'future'
          ? '{"schemaVersion":8}'
          : mode === 'corrupt'
            ? '{broken'
            : JSON.stringify(funded());
      const h = harness(raw);
      if (mode === 'unsupported') h.env.acquire = null;
      if (mode === 'denied') h.readFails = true;
      const s = h.store();
      await s.connect();
      const session = new SurvivorSession(s);
      expect(s.purchase({ kind: 'upgrade', id: 'hp' }, 0)).toBe(false);
      expect(session.startTemporary(1)).toBe(true);
      session.run!.gold = 100;
      expect(session.finish('abandoned')).toBe(true);
      expect(h.raw).toBe(raw);
      expect(h.writes).toBe(0);
    },
  );
  it('refuses a stale owner after out-of-band storage changes', async () => {
    const h = harness(funded()),
      s = h.store();
    await s.connect();
    h.raw = JSON.stringify(funded(500));
    expect(s.purchase({ kind: 'upgrade', id: 'hp' }, 0)).toBe(false);
    expect(s.getSnapshot().mode).toBe('blocked');
    expect(parseSurvivorProfile(h.raw)).toMatchObject({ profile: { gold: 500 } });
  });
  it('releases a late-acquired lock when disposed during async connection', async () => {
    const h = harness();
    let resolve!: (release: () => void) => void;
    h.env.acquire = () =>
      new Promise((r) => {
        resolve = r;
      });
    const s = h.store(),
      pending = s.connect();
    s.dispose();
    let released = false;
    resolve(() => {
      released = true;
    });
    await pending;
    expect(released).toBe(true);
    expect(s.getSnapshot().mode).toBe('closed');
    expect(h.writes).toBe(0);
  });
  it('checkpoints at 5 seconds, on cards/pauses/stages, and pauses on failed checkpoints until explicit retry', async () => {
    const h = harness(),
      s = h.store();
    await s.connect();
    let now = 0;
    const session = new SurvivorSession(s, () => now);
    expect(session.start(1, 0)).toBe(true);
    const r = session.run!;
    r.tick = 299;
    r.gold = 2.75;
    now = 4999;
    session.sync();
    expect(h.writes).toBe(1);
    now = 5000;
    session.sync();
    expect(h.writes).toBe(2);
    expect(s.getSnapshot().profile.checkpoint?.collectedGold).toBe(2.75);
    r.phase = 'choosing';
    r.pendingChoices = 1;
    r.choice = { id: 1, cards: [] };
    session.sync();
    expect(h.writes).toBe(3);
    session.pause();
    expect(h.writes).toBe(4);
    resumeSurvivor(r);
    r.choice.id++;
    session.sync();
    expect(h.writes).toBe(5);
    totals(r, 1);
    session.sync();
    expect(h.writes).toBe(6);
    expect(s.getSnapshot().profile.gold).toBe(0);
    continueSurvivorStage(r, 1);
    session.sync();
    expect(h.writes).toBe(7);
    r.phase = 'playing';
    r.pendingChoices = 0;
    h.writeFails = true;
    now += 5000;
    expect(session.sync()).toBe(false);
    expect(r.phase).toBe('paused');
    expect(session.sync()).toBe(false);
    h.writeFails = false;
    expect(session.retrySave()).toBe(true);
    expect(r.phase).toBe('paused');
    pauseSurvivor(r);
    expect(s.getSnapshot().profile.checkpoint?.collectedGold).toBe(25.75);
  });
  it('does not start combat when its initial checkpoint write fails', async () => {
    const h = harness(),
      s = h.store();
    await s.connect();
    h.writeFails = true;
    const session = new SurvivorSession(s);
    expect(session.start(1, 0)).toBe(false);
    expect(session.run).toBeNull();
    h.writeFails = false;
    expect(session.start(1, 0)).toBe(true);
  });
  it('permits explicit temporary play after denied writes, without modifying the profile', async () => {
    const h = harness(funded()),
      s = h.store();
    await s.connect();
    h.writeFails = true;
    const session = new SurvivorSession(s);
    expect(session.start(1, 0)).toBe(false);
    expect(session.startTemporary(1)).toBe(true);
    session.run!.gold = 123;
    expect(session.finish('abandoned')).toBe(true);
    expect(s.getSnapshot().profile.gold).toBe(2000);
    expect(h.writes).toBe(0);
  });
  it('pauses immediately on lost ownership even before the checkpoint timer', async () => {
    const h = harness(),
      s = h.store();
    await s.connect();
    const session = new SurvivorSession(s, () => 0);
    session.start(1, 0);
    h.raw = JSON.stringify(funded());
    h.emit();
    expect(session.sync()).toBe(false);
    expect(session.run!.phase).toBe('paused');
  });
});
