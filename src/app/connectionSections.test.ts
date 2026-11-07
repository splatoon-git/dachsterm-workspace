// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { blankProfile, type Group, type Profile } from '../lib/ipc';
import { connectionSections, readFolded, RECENT_LIMIT, writeFolded } from './connectionSections';

const profile = (name: string, extra: Partial<Profile> = {}): Profile => ({
  ...blankProfile(),
  id: name,
  name,
  host: `${name}.example`,
  username: 'ops',
  ...extra,
});
const groups: Group[] = [
  { id: 'prod', name: '운영' },
  { id: 'web', name: '웹', parentId: 'prod' },
  { id: 'empty', name: '빈 그룹' },
];

describe('connectionSections', () => {
  it('nests groups and keeps ungrouped connections at the top level', () => {
    const all = [
      profile('db', { groupId: 'prod' }),
      profile('web1', { groupId: 'web' }),
      profile('lab'),
      profile('lost', { groupId: 'deleted' }),
    ];
    const tree = connectionSections(all, groups, '');
    expect(tree.folders.map((f) => f.group.id)).toEqual(['empty', 'prod']);
    const prod = tree.folders[1];
    expect(prod.profiles.map((p) => p.name)).toEqual(['db']);
    expect(prod.folders[0].profiles.map((p) => p.name)).toEqual(['web1']);
    expect(tree.profiles.map((p) => p.name)).toEqual(['lab', 'lost']);
  });

  it('keeps only matching connections and the folders that lead to them while searching', () => {
    const all = [profile('db', { groupId: 'prod' }), profile('web1', { groupId: 'web' })];
    const tree = connectionSections(all, groups, 'web1');
    expect(tree.folders.map((f) => f.group.id)).toEqual(['prod']);
    expect(tree.folders[0].profiles).toEqual([]);
    expect(tree.folders[0].folders[0].profiles.map((p) => p.name)).toEqual(['web1']);
  });

  it('lists favorites and the most recent connections', () => {
    const all = Array.from({ length: RECENT_LIMIT + 2 }, (_, i) =>
      profile(`s${i}`, { lastConnected: i + 1, favorite: i === 0 }),
    );
    const tree = connectionSections(all, [], '');
    expect(tree.favorites.map((p) => p.name)).toEqual(['s0']);
    expect(tree.recent).toHaveLength(RECENT_LIMIT);
    expect(tree.recent[0].name).toBe(`s${RECENT_LIMIT + 1}`);
  });

  it('survives a parent loop by showing the groups at the top level', () => {
    const loop: Group[] = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
    ];
    const tree = connectionSections([profile('x', { groupId: 'a' })], loop, '');
    expect(tree.folders.map((f) => f.group.id)).toEqual(['a']);
    expect(tree.folders[0].folders.map((f) => f.group.id)).toEqual(['b']);
    expect(tree.folders[0].profiles.map((p) => p.name)).toEqual(['x']);
  });
});

describe('folded sections', () => {
  beforeEach(() => localStorage.clear());
  it('round-trips and ignores what it cannot use', () => {
    expect([...readFolded()]).toEqual(['recent']);
    writeFolded(new Set(['local', 'prod']));
    expect([...readFolded()]).toEqual(['local', 'prod']);
    localStorage.setItem('dachsterm.sidebar.folded', '{"local":true}');
    expect(readFolded().size).toBe(0);
    localStorage.setItem('dachsterm.sidebar.folded', 'not json');
    expect(readFolded().size).toBe(0);
  });
});
