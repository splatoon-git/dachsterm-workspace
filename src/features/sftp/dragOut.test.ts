import { describe, expect, it } from 'vitest';
import { dragNames, farEnough } from './dragOut';

describe('dragging files out', () => {
  it('waits for a real movement before starting', () => {
    const from = { x: 10, y: 10 };
    expect(farEnough(from, { x: 12, y: 13 })).toBe(false);
    expect(farEnough(from, { x: 15, y: 10 })).toBe(true);
    expect(farEnough(from, { x: 6, y: 6 })).toBe(true);
  });

  it('carries the selection only when the drag starts on it', () => {
    expect(dragNames('a', ['a', 'b'])).toEqual(['a', 'b']);
    expect(dragNames('c', ['a', 'b'])).toEqual(['c']);
    expect(dragNames('a', [])).toEqual(['a']);
  });

  it('does not carry a file together with the folder that holds it', () => {
    expect(dragNames('src', ['src', 'src/a.ts', 'b.ts'])).toEqual(['src', 'b.ts']);
  });
});
