import { describe, expect, it } from 'vitest';
import { TerminalDecoder } from './encoding';
describe('SSH streaming character encoding', () => {
  it('preserves split Korean, emoji and ANSI UTF-8 sequences', () => {
    const text = '\x1b[32m한글 😀\x1b[0m\r\n';
    const bytes = new TextEncoder().encode(text);
    const decoder = new TerminalDecoder();
    expect(Array.from(bytes, (b) => decoder.push([b])).join('') + decoder.finish()).toBe(text);
  });
  it('decodes CP949 across packet boundaries without replacing Korean', () => {
    const decoder = new TerminalDecoder('euc-kr');
    expect(
      [0xc7, 0xd1, 0xb1, 0xdb, 13, 10].map((b) => decoder.push([b])).join('') + decoder.finish(),
    ).toBe('한글\r\n');
  });
  it('surfaces malformed output instead of silently deleting bytes', () => {
    const decoder = new TerminalDecoder();
    expect(decoder.push([255])).toContain('\uFFFD');
  });
});
