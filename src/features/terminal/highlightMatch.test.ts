import { describe, expect, it } from 'vitest';
import { matchLines, maxMatches } from './highlightMatch';

const rule = (pattern: string, ignoreCase = false) => ({ id: pattern, pattern, ignoreCase });

describe('matchLines', () => {
  it('finds every match of every rule with its line and offsets', () => {
    const matches = matchLines(
      [rule('error', true), rule('\\d+\\.\\d+\\.\\d+\\.\\d+')],
      ['ERROR at 10.0.0.1', 'ok', 'error error'],
    );
    expect(matches).toEqual([
      { line: 0, rule: 0, start: 0, end: 5 },
      { line: 2, rule: 0, start: 0, end: 5 },
      { line: 2, rule: 0, start: 6, end: 11 },
      { line: 0, rule: 1, start: 9, end: 17 },
    ]);
  });

  it('skips empty matches and patterns that do not compile', () => {
    expect(matchLines([rule('x*'), rule('(')], ['axxb'])).toEqual([
      { line: 0, rule: 0, start: 1, end: 3 },
    ]);
  });

  it('tells which rule runs before running it', () => {
    const started: string[] = [];
    matchLines([rule('a'), rule('b')], ['ab'], (r) => started.push(r.id));
    expect(started).toEqual(['a', 'b']);
  });

  it('stops at the match limit', () => {
    expect(matchLines([rule('a')], ['a'.repeat(maxMatches + 10)])).toHaveLength(maxMatches);
  });
});
