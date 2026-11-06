import { describe, expect, it } from 'vitest';
import { describePaste } from './pastePreview';

describe('describePaste', () => {
  it('shows each line break, including a trailing one that would run the command', () => {
    expect(describePaste('ls\npwd\n')).toEqual({
      segments: [
        { kind: 'text', text: 'ls' },
        { kind: 'lineBreak' },
        { kind: 'text', text: 'pwd' },
        { kind: 'lineBreak' },
      ],
      lineBreaks: 2,
      hiddenCharacters: 0,
      omitted: 0,
    });
  });
  it('counts CRLF as one line break and a lone CR as another', () => {
    const preview = describePaste('a\r\nb\rc');
    expect(preview.lineBreaks).toBe(2);
    expect(preview.segments.filter((s) => s.kind === 'lineBreak')).toHaveLength(2);
  });
  it('names control characters and keeps tabs as text', () => {
    expect(describePaste('\x1b[A\x03\x00\x7f\ta').segments).toEqual([
      { kind: 'hidden', label: 'ESC' },
      { kind: 'text', text: '[A' },
      { kind: 'hidden', label: '^C' },
      { kind: 'hidden', label: 'NUL' },
      { kind: 'hidden', label: 'DEL' },
      { kind: 'text', text: '\ta' },
    ]);
  });
  it('exposes characters that could make the preview misleading', () => {
    const preview = describePaste('rm‮ -rf​\u009b');
    expect(preview.hiddenCharacters).toBe(3);
    expect(preview.segments).toContainEqual({ kind: 'hidden', label: 'U+202E' });
    expect(preview.segments).toContainEqual({ kind: 'hidden', label: 'U+200B' });
    expect(preview.segments).toContainEqual({ kind: 'hidden', label: 'U+009B' });
  });
  it('limits the preview but still counts what it leaves out', () => {
    const preview = describePaste('x'.repeat(20_000) + 'y\nz\x1b');
    expect(preview.segments).toEqual([{ kind: 'text', text: 'x'.repeat(20_000) }]);
    expect(preview).toMatchObject({ lineBreaks: 1, hiddenCharacters: 1, omitted: 4 });
  });
  it('does not split a character outside the basic plane at the limit', () => {
    const preview = describePaste('x'.repeat(19_999) + '😀😀');
    expect(preview.segments).toEqual([{ kind: 'text', text: 'x'.repeat(19_999) + '😀' }]);
    expect(preview.omitted).toBe(1);
  });
});
