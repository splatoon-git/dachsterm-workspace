import { describe, expect, it } from 'vitest';
import {
  DAX_HEIGHT,
  newSnack,
  stepSnack,
  snackMotion,
  resizeSnack,
  type Treat,
} from './daxEngines';
const idle = { direction: 0, target: null };
const treat = (id: number, kind: Treat['kind']): Treat => ({
  id,
  kind,
  x: 300,
  y: DAX_HEIGHT - 78,
  speed: 120,
});

describe('닥스의 간식 타임', () => {
  it('awards bone/star scores and only one damage during the shield window', () => {
    const original = {
      ...newSnack(),
      items: [treat(1, 'bone'), treat(2, 'star'), treat(3, 'onion'), treat(4, 'onion')],
    };
    const next = stepSnack(original, 0.02, 600, idle);
    expect(next.score).toBe(40);
    expect(next.lives).toBe(2);
    expect(next.items).toHaveLength(0);
    expect(original.items[0].y).toBe(DAX_HEIGHT - 78);
    expect(
      stepSnack({ ...next, shield: 0, lives: 1, items: [treat(5, 'onion')] }, 0.02, 600, idle).over,
    ).toBe(true);
  });
  it('ends at 45 seconds and freezes the completed round', () => {
    const next = stepSnack({ ...newSnack(), elapsed: 44.99 }, 0.02, 600, idle);
    expect(next.elapsed).toBe(45);
    expect(next.over).toBe(true);
    expect(stepSnack(next, 0.05, 600, { direction: 1, target: null })).toBe(next);
  });
  it('keeps movement inside narrow boards and does not penalize missed food', () => {
    let s = { ...newSnack(300), items: [{ ...treat(1, 'bone'), x: 20, y: 324 }] };
    for (let i = 0; i < 50; i++)
      s = stepSnack(s, 0.02, 300, { direction: 1, target: null }, () => 0.5);
    expect(s.x).toBe(256);
    expect(s.score).toBe(0);
    expect(s.lives).toBe(3);
    s = stepSnack(s, 0.05, 300, { direction: 0, target: -100 });
    expect(s.x).toBeLessThan(256);
    expect(s.x).toBeGreaterThanOrEqual(44);
  });
  it('accelerates, reverses, brakes and keeps the last facing direction', () => {
    let s = stepSnack(newSnack(900), 0.05, 900, { direction: 1, target: null });
    expect(s.velocity).toBeGreaterThan(0);
    expect(s.velocity).toBeLessThan(410);
    expect(snackMotion(s)).toBe('run');
    for (let i = 0; i < 10; i++) s = stepSnack(s, 0.05, 900, { direction: -1, target: null });
    expect(s.facing).toBe(-1);
    for (let i = 0; i < 4; i++) s = stepSnack(s, 0.05, 900, idle);
    expect(s.velocity).toBe(0);
    expect(s.facing).toBe(-1);
    expect(snackMotion(s)).toBe('idle');
  });
  it('counts catches without changing score rules, expires effects and resets streak on a miss', () => {
    let s = stepSnack({ ...newSnack(), items: [treat(10, 'bone')] }, 0.02, 600, idle);
    expect(snackMotion(s)).toBe('eat');
    s = stepSnack({ ...s, items: [treat(11, 'star')] }, 0.02, 600, idle);
    expect(snackMotion(s)).toBe('jump');
    expect([s.score, s.caught, s.stars, s.combo, s.bestCombo]).toEqual([40, 2, 1, 2, 2]);
    expect(s.effects).toHaveLength(2);
    s = stepSnack({ ...s, items: [{ ...treat(12, 'bone'), x: 50 }] }, 0.02, 600, idle);
    expect([s.score, s.combo, s.bestCombo, s.lives]).toEqual([40, 0, 2, 3]);
    for (let i = 0; i < 8; i++) s = stepSnack(s, 0.1, 600, idle);
    expect(s.effects).toHaveLength(0);
    expect(snackMotion(s)).toBe('idle');
  });
  it('keeps hurt visible for simultaneous catches and respects the shield duration', () => {
    let s = stepSnack(
      { ...newSnack(), items: [treat(10, 'onion'), treat(11, 'bone')] },
      0.02,
      600,
      idle,
    );
    expect(snackMotion(s)).toBe('hurt');
    expect(s.lives).toBe(2);
    for (let i = 0; i < 10; i++)
      s = stepSnack({ ...s, items: [treat(i + 20, 'onion')] }, 0.1, 600, idle);
    expect(s.lives).toBe(2);
    s = stepSnack({ ...s, items: [] }, 0.1, 600, idle);
    s = stepSnack({ ...s, items: [treat(40, 'onion')] }, 0.02, 600, idle);
    expect(s.lives).toBe(1);
  });
  it('preserves falling items, records and the relative player location on resize', () => {
    const s = { ...newSnack(), score: 50, items: [treat(1, 'bone')] };
    const next = resizeSnack(s, 600, 360);
    expect(next.x).toBe(180);
    expect(next.items[0].x).toBe(180);
    expect(next.items[0].y).toBe(s.items[0].y);
    expect(next.score).toBe(50);
    expect(s.x).toBe(300);
  });
  it('gives the same movement and catches at 30 and 120 Hz', () => {
    const simulate = (hz: number) => {
      let s = newSnack(900);
      for (let i = 0; i < hz * 5; i++)
        s = stepSnack(
          s,
          1 / hz,
          900,
          { direction: i < hz / 2 ? 1 : 0, target: i < hz / 2 ? null : 450 },
          () => 0.5,
        );
      return s;
    };
    const slow = simulate(30),
      fast = simulate(120);
    expect(slow.x).toBeCloseTo(fast.x, 5);
    expect(slow.score).toBeGreaterThan(0);
    expect(slow.score).toBe(fast.score);
    expect(slow.combo).toBe(fast.combo);
  });
});
