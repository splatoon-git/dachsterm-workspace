import { describe, expect, it } from 'vitest';
import { commitMessage, fileTotals, placeCard, relativeTime } from './commitCard';

describe('commitMessage', () => {
  it('moves co-authors out of the message and keeps everything else', () => {
    expect(commitMessage('제목\n\n본문\n\nCo-Authored-By: Claude <noreply@example.com>\n')).toEqual(
      { body: '제목\n\n본문', coAuthors: ['Claude'] },
    );
    expect(commitMessage('co-authored-by: A B\nCo-Authored-By:C <c@d>').coAuthors).toEqual([
      'A B',
      'C',
    ]);
    expect(commitMessage('plain').coAuthors).toEqual([]);
  });

  it('leaves a line that only mentions the trailer alone', () => {
    expect(commitMessage('fix: Co-Authored-By: parsing').body).toBe('fix: Co-Authored-By: parsing');
  });
});

describe('relativeTime', () => {
  const now = 1_700_000_000_000;
  const ago = (seconds: number) => relativeTime(now / 1000 - seconds, now);
  it.each([
    [20, '방금'],
    [60, '1분 전'],
    [59 * 60, '59분 전'],
    [3600, '1시간 전'],
    [86400, '1일 전'],
    [29 * 86400, '29일 전'],
    [30 * 86400, '1개월 전'],
    [365 * 86400, '1년 전'],
  ])('%d seconds ago', (seconds, text) => expect(ago(seconds)).toBe(text));

  it('a clock behind the commit is not a future time', () => {
    expect(ago(-500)).toBe('방금');
  });
});

it('fileTotals counts the files and skips what has no line counts', () => {
  expect(
    fileTotals([
      { added: 3, removed: 1 },
      { added: null, removed: null },
    ]),
  ).toEqual({ files: 2, added: 3, removed: 1 });
});

describe('placeCard', () => {
  const row = { left: 0, right: 300, top: 200 };
  const card = { width: 320, height: 200 };
  it('sits beside the row', () => {
    expect(placeCard(row, card, { width: 1000, height: 800 })).toEqual({ x: 304, y: 200 });
  });
  it('stays inside a low window', () => {
    expect(placeCard({ ...row, top: 700 }, card, { width: 1000, height: 800 }).y).toBe(596);
  });
  it('moves to the other side when the right has no room', () => {
    expect(placeCard({ left: 600, right: 900, top: 0 }, card, { width: 1000, height: 800 }).x).toBe(
      276,
    );
  });
  it('never leaves the window', () => {
    expect(placeCard(row, card, { width: 340, height: 100 })).toEqual({ x: 4, y: 4 });
  });
});
