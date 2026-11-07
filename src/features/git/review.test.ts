import { describe, expect, it } from 'vitest';
import { noteLocation, promptText, type ReviewNote } from './review';

const note = (over: Partial<ReviewNote>): ReviewNote => ({
  id: 'n',
  path: 'src/foo.ts',
  side: 'new',
  start: 42,
  end: 47,
  text: '의견',
  ...over,
});

describe('promptText', () => {
  it('writes one "path:lines comment" line per note', () => {
    const notes = [
      note({}),
      note({ path: '새 폴더/a b.ts', start: 3, end: 3, text: '이름 바꾸기' }),
    ];
    expect(promptText(notes, true)).toBe('src/foo.ts:42-47 의견\n새 폴더/a b.ts:3 이름 바꾸기');
  });
  it('marks lines that exist only in the old file', () => {
    expect(noteLocation(note({ side: 'old', start: 5, end: 6 }))).toBe(
      'src/foo.ts:5-6 (삭제된 줄)',
    );
  });
  it('keeps everything on one line without bracketed paste, where a line break runs it', () => {
    const text = promptText([note({}), note({ text: 'b' })], false);
    expect(text).toBe('src/foo.ts:42-47 의견 / src/foo.ts:42-47 b');
    expect(text).not.toMatch(/[\r\n]/);
  });
  it('strips control characters a server name or comment could use to end a paste early', () => {
    const text = promptText(
      [note({ path: 'evil\u001b[201~\rrm.ts', text: '첫 줄\n둘째 줄\u0007\u009b' })],
      true,
    );
    expect(text).toBe('evil [201~ rm.ts:42-47 첫 줄 둘째 줄');
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});
