import { describe, expect, it } from 'vitest';
import { emptySnippet, expand, matchesSnippet, variables } from './snippets';
import { commands, programMetadata } from './guideData';
describe('snippet literal expansion and metadata boundaries', () => {
  it('deduplicates Unicode placeholders and never recursively evaluates replacements', () => {
    expect(variables('{{경로}} {{경로}} {{name}}')).toEqual(['경로', 'name']);
    expect(expand('{{경로}} {{name}}', { 경로: '$(echo example)', name: '{{경로}}' })).toBe(
      '$(echo example) {{경로}}',
    );
    expect(() => expand('{{missing}}', {})).toThrow();
    expect(expand('echo $HOME `pwd`', {})).toBe('echo $HOME `pwd`');
  });
  it('searches all metadata using AND terms', () => {
    const s = {
      ...emptySnippet(),
      name: '로그',
      body: 'tail app.log',
      group: '운영',
      tags: 'linux',
    };
    expect(matchesSnippet(s, '운영 TAIL linux')).toBe(true);
    expect(matchesSnippet(s, '운영 windows')).toBe(false);
  });
  it('accepts only explicit allowlisted metadata, with no arguments', () => {
    expect(programMetadata('DachsTerm;program;vim')).toBe('vim');
    expect(programMetadata('DachsTerm;end')).toBe(null);
    for (const value of [
      'vim secret',
      'DachsTerm;program;vim file',
      'DachsTerm;program;sudo',
      '133;C',
    ])
      expect(programMetadata(value)).toBeUndefined();
  });
  it('keeps catalog copy text plain and without a trailing Enter', () => {
    expect(commands.filter((c) => c.group !== '로그 필터')).toHaveLength(26);
    expect(new Set(commands.map((c) => c.title)).size).toBe(commands.length);
    for (const c of commands) expect(c.command).not.toMatch(/[\r\n]|<mark>/);
  });
});
