import { describe, expect, it } from 'vitest';
import { conflictKind } from './fileSave';

describe('conflictKind', () => {
  it('tells a changed file from a removed one and a taken name', () => {
    expect(conflictKind({ expected: 'a', hash: 'b' })).toBe('changed');
    expect(conflictKind({ expected: 'a', hash: null })).toBe('removed');
    expect(conflictKind({ expected: null, hash: 'b' })).toBe('taken');
  });
});
