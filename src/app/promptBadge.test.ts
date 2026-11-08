import { describe, expect, it } from 'vitest';
import {
  badgeFits,
  badgeText,
  cells,
  lineEnd,
  middleEllipsis,
  promptShowsBranch,
} from './promptBadge';

describe('branch badge text', () => {
  it('counts East Asian characters as two cells', () => {
    expect(cells('main')).toBe(4);
    expect(cells('기능/한글')).toBe(9);
  });

  it('leaves a name that fits and shortens the middle of one that does not', () => {
    expect(middleEllipsis('main', 10)).toBe('main');
    const short = middleEllipsis('feature/very-long-branch-name', 12);
    expect(cells(short)).toBeLessThanOrEqual(12);
    expect(short.startsWith('featur')).toBe(true);
    expect(short.endsWith('name')).toBe(true);
    expect(short).toContain('…');
  });

  it('does not split a wide character at the limit', () => {
    const short = middleEllipsis('가나다라마바사아자차', 9);
    expect(cells(short)).toBeLessThanOrEqual(9);
    expect(short).toContain('…');
  });

  it('keeps the whole badge within 24 cells, count included', () => {
    expect(badgeText('main', null)).toBe('⎇ main');
    expect(badgeText('main', '3')).toBe('⎇ main ●3');
    expect(cells(badgeText('feature/a-very-long-branch-name-here', '5000+'))).toBeLessThanOrEqual(
      24,
    );
  });
});

describe('prompt line', () => {
  const row = (text: string) => ({
    getCell: (x: number) => {
      const chars = Array.from(text);
      let at = 0;
      for (const char of chars) {
        const width = cells(char);
        if (x === at) return { getChars: () => char, getWidth: () => width };
        if (width === 2 && x === at + 1) return { getChars: () => '', getWidth: () => 0 };
        at += width;
      }
      return { getChars: () => '', getWidth: () => 1 };
    },
  });

  it('finds where the text ends, wide characters included', () => {
    expect(lineEnd(row('user@host:~$'), 80)).toBe(12);
    expect(lineEnd(row('한글$'), 80)).toBe(5);
    expect(lineEnd(row('끝가'), 80)).toBe(4);
    expect(lineEnd(row(''), 80)).toBe(0);
  });

  it('needs the badge width and two blank cells, and at least 40 columns', () => {
    expect(badgeFits(80, 70, 8)).toBe(true);
    expect(badgeFits(80, 71, 8)).toBe(false);
    expect(badgeFits(39, 0, 8)).toBe(false);
    expect(badgeFits(40, 0, 8)).toBe(true);
  });

  it('sees a branch a prompt theme already shows', () => {
    expect(promptShowsBranch('~/app (main) $', 'main')).toBe(true);
    expect(promptShowsBranch('~/app on main', 'main')).toBe(true);
    expect(promptShowsBranch('git:(feature/x)$', 'feature/x')).toBe(true);
  });

  it('does not take a folder or a longer word for the branch', () => {
    expect(promptShowsBranch('me@pc:~/work/main$', 'main')).toBe(false);
    expect(promptShowsBranch('~/main/src $', 'main')).toBe(false);
    expect(promptShowsBranch('~/app (maintenance) $', 'main')).toBe(false);
    expect(promptShowsBranch('~/app $', 'main')).toBe(false);
  });
});
