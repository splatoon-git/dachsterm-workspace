import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readLastScreen, writeLastScreen } from './screenPref';

const memory = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => memory.set(key, value),
});

beforeEach(() => memory.clear());

describe('last screen', () => {
  it('starts on the tree and remembers the last screen of each session', () => {
    expect(readLastScreen('a')).toBe('tree');
    writeLastScreen('a', 'ingress');
    expect(readLastScreen('a')).toBe('ingress');
    expect(readLastScreen('b')).toBe('tree');
    expect([...memory.keys()]).toEqual(['dachsterm.kube.screen.a']);
  });

  it('ignores a value that is not a screen and a session without an id', () => {
    memory.set('dachsterm.kube.screen.a', 'terminal');
    expect(readLastScreen('a')).toBe('tree');
    writeLastScreen('', 'logs');
    expect(memory.size).toBe(1);
    expect(readLastScreen('')).toBe('tree');
  });
});
