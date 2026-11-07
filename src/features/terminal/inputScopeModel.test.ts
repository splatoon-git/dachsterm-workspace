import { describe, expect, it } from 'vitest';
import {
  paneRole,
  releaseReason,
  scopeCandidates,
  scopeIds,
  togglePick,
  type BroadcastStatus,
} from './inputScopeModel';

const target = (id: string) => ({ id, name: id, host: 'h', username: 'u' });
const status = (targets: string[], selected: string[] = []): BroadcastStatus => ({
  targets: targets.map(target),
  selected,
});

describe('input scope', () => {
  it('offers only visible panes the backend can reach, in screen order', () => {
    // `g1` is a game or an empty group, `ftp` has no terminal, `hidden` is not on screen.
    expect(scopeCandidates(['b', 'g1', 'a', 'ftp'], status(['a', 'b', 'hidden']).targets)).toEqual([
      'b',
      'a',
    ]);
  });

  it('sends nothing until two panes take part', () => {
    expect(scopeIds({ mode: 'all' }, ['a'])).toEqual([]);
    expect(scopeIds({ mode: 'all' }, ['a', 'b'])).toEqual(['a', 'b']);
    expect(scopeIds({ mode: 'pick', ids: ['a'] }, ['a', 'b'])).toEqual([]);
    expect(scopeIds({ mode: 'pick', ids: ['a', 'b', 'gone'] }, ['a', 'b'])).toEqual(['a', 'b']);
    expect(scopeIds({ mode: 'pick', ids: ['a', 'gone'] }, ['a', 'b'])).toEqual([]);
    expect(scopeIds({ mode: 'off' }, ['a', 'b'])).toEqual([]);
  });

  it('starts a pick from nothing and toggles one pane at a time', () => {
    const one = togglePick({ mode: 'all' }, 'a', true);
    expect(one).toEqual({ mode: 'pick', ids: ['a'] });
    const two = togglePick(one, 'b', true);
    expect(two).toEqual({ mode: 'pick', ids: ['a', 'b'] });
    expect(togglePick(two, 'a', false)).toEqual({ mode: 'pick', ids: ['b'] });
    expect(togglePick(two, 'a', true)).toEqual({ mode: 'pick', ids: ['b', 'a'] });
  });

  it('marks pick boxes, targets and the panes left out', () => {
    const on = status(['a', 'b', 'c'], ['a', 'b']);
    expect(paneRole('a', { mode: 'all' }, on, ['a', 'b', 'c'], true)).toBe('target');
    expect(paneRole('c', { mode: 'all' }, on, ['a', 'b', 'c'], true)).toBe('outside');
    expect(paneRole('c', { mode: 'pick', ids: [] }, on, ['a', 'b', 'c'], true)).toBe('pick');
    // PodTree and FTP are never candidates, so they get no box.
    expect(paneRole('ftp', { mode: 'pick', ids: [] }, on, ['a', 'b'], true)).toBe('outside');
    expect(paneRole('a', { mode: 'off' }, status(['a', 'b']), ['a', 'b'], false)).toBeNull();
  });

  it('tells a lost connection from a group stopped elsewhere', () => {
    expect(releaseReason(['a', 'b'], status(['a'], []))).toBe('disconnected');
    expect(releaseReason(['a', 'b'], status(['a', 'b'], []))).toBe('stopped');
    expect(releaseReason(['a', 'b'], status(['a', 'b'], ['a', 'b']))).toBeNull();
    expect(releaseReason([], status(['a'], []))).toBeNull();
  });
});
