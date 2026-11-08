import { describe, expect, it } from 'vitest';
import { isJson, isMarkdown, languageOf } from './fileKinds';
import { indentation, lineEnding, prettyJson, textFacts } from './fileText';

describe('languageOf', () => {
  it.each([
    ['app.ts', 'typescript'],
    ['App.TSX', 'typescript'],
    ['deploy.sh', 'shell'],
    ['Dockerfile', 'dockerfile'],
    ['.bashrc', 'shell'],
    ['config.yaml', 'yaml'],
    ['.env', 'plaintext'],
    ['notes', 'plaintext'],
    ['archive.unknown', 'plaintext'],
  ])('%s is %s', (name, language) => {
    expect(languageOf(name)).toBe(language);
  });

  it('knows which files have an extra view', () => {
    expect(isMarkdown('README.MD')).toBe(true);
    expect(isMarkdown('a.txt')).toBe(false);
    expect(isJson('package.json')).toBe(true);
    expect(isJson('a.yaml')).toBe(false);
  });
});

describe('lineEnding', () => {
  it.each([
    ['a\nb\n', 'LF'],
    ['a\r\nb\r\n', 'CRLF'],
    ['a\nb\r\n', '혼합'],
    ['one line', '없음'],
    ['', '없음'],
    ['\n', 'LF'],
    ['\r\n', 'CRLF'],
  ])('%j is %s', (text, expected) => {
    expect(lineEnding(text)).toBe(expected);
  });
});

describe('indentation', () => {
  it('finds tabs', () => {
    expect(indentation('a\n\tb\n\t\tc\n')).toBe('탭');
  });

  it('finds the most common step', () => {
    expect(indentation('a\n  b\n    c\n  d\n')).toBe('공백 2');
    expect(indentation('a\n    b\n        c\n    d\n')).toBe('공백 4');
  });

  it('reports none for text with no indent', () => {
    expect(indentation('a\nb\n')).toBe('없음');
    expect(indentation('')).toBe('없음');
  });

  it('ignores blank lines', () => {
    expect(indentation('a\n\n  b\n\n  c\n')).toBe('공백 2');
  });

  it('gives both facts together', () => {
    expect(textFacts('a\r\n  b\r\n')).toEqual({ eol: 'CRLF', indent: '공백 2' });
  });
});

describe('prettyJson', () => {
  it('indents objects and arrays', () => {
    expect(prettyJson('{"a":1,"b":[true,null]}')).toBe(
      '{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}',
    );
  });

  it('keeps numbers exactly, which parsing and printing would change', () => {
    const big = '{"id":12345678901234567890,"n":1.10}';
    expect(prettyJson(big)).toContain('12345678901234567890');
    expect(prettyJson(big)).toContain('1.10');
  });

  it('keeps repeated keys', () => {
    expect(prettyJson('{"a":1,"a":2}')).toBe('{\n  "a": 1,\n  "a": 2\n}');
  });

  it('leaves punctuation inside strings alone', () => {
    expect(prettyJson('{"a":"x,{y}:\\"z\\"  "}')).toBe('{\n  "a": "x,{y}:\\"z\\"  "\n}');
  });

  it('keeps empty containers on one line', () => {
    expect(prettyJson('{ "a" : { } , "b" : [ ] }')).toBe('{\n  "a": {},\n  "b": []\n}');
  });

  it('handles a bare value', () => {
    expect(prettyJson(' 12 ')).toBe('12');
  });

  it('gives the same result for text that is already tidy', () => {
    const tidy = prettyJson('{"a":[1,{"b":2}]}')!;
    expect(prettyJson(tidy)).toBe(tidy);
  });

  it('refuses invalid JSON', () => {
    expect(prettyJson('{a:1}')).toBeNull();
    expect(prettyJson('')).toBeNull();
  });
});
