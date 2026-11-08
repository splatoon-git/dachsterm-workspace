import { describe, expect, it } from 'vitest';
import { placeTip } from './menuPlacement';

describe('placeTip', () => {
  const window = { width: 800, height: 600 };
  const tip = { width: 100, height: 24 };
  const at = (left: number, top: number) => ({ left, right: left + 20, top, bottom: top + 20 });

  it('centers under the element', () => {
    expect(placeTip(at(400, 100), tip, window)).toEqual({ x: 360, y: 124 });
  });
  it('goes above when there is no room below', () => {
    expect(placeTip(at(400, 570), tip, window).y).toBe(542);
  });
  it('stays inside the window at both sides', () => {
    expect(placeTip(at(0, 100), tip, window).x).toBe(4);
    expect(placeTip(at(780, 100), tip, window).x).toBe(696);
  });
});
