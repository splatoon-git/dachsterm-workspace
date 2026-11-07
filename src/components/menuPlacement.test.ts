import { describe, expect, it } from 'vitest';
import { nextEnabled, placeMenu } from './menuPlacement';

const viewport = { width: 800, height: 600 };
const size = { width: 200, height: 300 };

describe('placeMenu', () => {
  it('opens at the pointer when it fits', () => {
    expect(placeMenu({ x: 10, y: 20 }, size, viewport)).toEqual({ x: 10, y: 20 });
  });
  it('flips left and up near the right and bottom edges', () => {
    expect(placeMenu({ x: 700, y: 500 }, size, viewport)).toEqual({ x: 500, y: 200 });
  });
  it('keeps a menu that fits neither way inside the viewport', () => {
    expect(placeMenu({ x: 150, y: 250 }, { width: 200, height: 500 }, viewport)).toEqual({
      x: 150,
      y: 96,
    });
  });
  it('pins an oversized menu to the top-left margin', () => {
    expect(placeMenu({ x: 50, y: 50 }, { width: 900, height: 700 }, viewport)).toEqual({
      x: 4,
      y: 4,
    });
  });
});

describe('nextEnabled', () => {
  const disabled = [false, true, false, true];
  it('skips disabled items and wraps', () => {
    expect(nextEnabled(disabled, 0, 'ArrowDown')).toBe(2);
    expect(nextEnabled(disabled, 2, 'ArrowDown')).toBe(0);
    expect(nextEnabled(disabled, 0, 'ArrowUp')).toBe(2);
  });
  it('jumps to the first and last enabled item', () => {
    expect(nextEnabled(disabled, 2, 'Home')).toBe(0);
    expect(nextEnabled(disabled, 0, 'End')).toBe(2);
  });
  it('starts from nothing focused', () => {
    expect(nextEnabled(disabled, -1, 'ArrowDown')).toBe(0);
    expect(nextEnabled(disabled, -1, 'ArrowUp')).toBe(2);
  });
  it('reports a menu with nothing enabled', () => {
    expect(nextEnabled([true, true], 0, 'ArrowDown')).toBe(-1);
  });
});
