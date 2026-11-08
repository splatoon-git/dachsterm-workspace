import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTreePrefs, parseTreePrefs, readTreePrefs, writeTreePrefs } from './treePrefs';

const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
});

beforeEach(() => memory.clear());

describe('tree preferences', () => {
  it('keeps the saved grouping and folding for each session', () => {
    writeTreePrefs('a', { grouping: 'node', collapsed: ['ns:web'] });
    expect(readTreePrefs('a')).toEqual({ grouping: 'node', collapsed: ['ns:web'] });
    expect(readTreePrefs('b')).toEqual(defaultTreePrefs());
    expect([...memory.keys()]).toEqual(['dachsterm.kube.tree.a']);
  });

  it.each([
    null,
    '',
    'not json',
    'null',
    '[]',
    '{"grouping":"other","collapsed":[]}',
    '{"grouping":"node"}',
    '{"grouping":"node","collapsed":"x"}',
  ])('falls back to the defaults for %j', (text) => {
    expect(parseTreePrefs(text)).toEqual(defaultTreePrefs());
  });

  it('drops entries that are not ids and caps a list that grew too long', () => {
    expect(parseTreePrefs('{"grouping":"node","collapsed":["a",1,null]}').collapsed).toEqual(['a']);
    const long = JSON.stringify({
      grouping: 'node',
      collapsed: Array.from({ length: 3000 }, (_, at) => `id${at}`),
    });
    expect(parseTreePrefs(long).collapsed).toHaveLength(2000);
  });

  it('does not store anything without a session', () => {
    writeTreePrefs('', { grouping: 'node', collapsed: [] });
    expect(memory.size).toBe(0);
    expect(readTreePrefs('')).toEqual(defaultTreePrefs());
  });

  it('survives a store that refuses to work', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    });
    expect(readTreePrefs('a')).toEqual(defaultTreePrefs());
    expect(() => writeTreePrefs('a', defaultTreePrefs())).not.toThrow();
  });
});
