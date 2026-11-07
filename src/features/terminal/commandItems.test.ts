import { describe, expect, it } from 'vitest';
import {
  basicSections,
  checkedBody,
  NO_GROUP,
  previewParts,
  snippetBody,
  snippetSections,
} from './commandItems';
import { emptySnippet, type Snippet } from './snippets';

const snippet = (name: string, group = '', body = 'echo hi'): Snippet => ({
  ...emptySnippet(),
  name,
  group,
  body,
});

describe('command panel', () => {
  it('groups snippets by group, with ungrouped ones last', () => {
    const sections = snippetSections(
      [snippet('b', '배포'), snippet('z'), snippet('a', '배포'), snippet('c', '로그')],
      '',
    );
    expect(sections.map((s) => s.title)).toEqual(['로그', '배포', NO_GROUP]);
    expect(sections[1].items.map((s) => s.name)).toEqual(['a', 'b']);
  });

  it('filters snippets and basic commands by every word', () => {
    expect(snippetSections([snippet('로그 보기', '', 'tail -f')], 'tail 로그')).toHaveLength(1);
    expect(snippetSections([snippet('로그 보기')], 'tail')).toHaveLength(0);
    const found = basicSections('grep 제외').flatMap((s) => s.items);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((c) => c.command.includes('grep'))).toBe(true);
  });

  it('turns the parts to replace into variables when a basic command is saved', () => {
    expect(snippetBody("grep -F -C 3 -- '검색어' 파일명")).toBe(
      "grep -F -C 3 -- '{{검색어}}' {{파일명}}",
    );
  });

  it('shows variables by value once typed and by name until then', () => {
    expect(previewParts('ls {{경로}} | grep {{검색어}}', { 경로: '/var' })).toEqual([
      { text: 'ls ' },
      { text: '/var', variable: '경로', filled: true },
      { text: ' | grep ' },
      { text: '검색어', variable: '검색어', filled: false },
    ]);
  });

  it('refuses empty bodies and control characters', () => {
    expect(() => checkedBody('  ')).toThrow();
    expect(() => checkedBody('echo \u0007')).toThrow();
    expect(checkedBody('echo a\n\techo b')).toBe('echo a\n\techo b');
  });
});
