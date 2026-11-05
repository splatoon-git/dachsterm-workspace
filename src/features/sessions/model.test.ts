import { describe, expect, it } from 'vitest';
import { blankProfile } from '../../lib/ipc';
import { groupPath, importSelection, inGroup, matchesSession, routeNames } from './model';

describe('session hierarchy and selection', () => {
  const groups = [
    { id: 'root', name: '운영' },
    { id: 'child', name: '서울', parentId: 'root' },
    { id: 'other', name: '개발' },
  ];
  const hop = {
    ...blankProfile(),
    id: 'jump',
    name: 'Gateway',
    host: 'jump.example',
    groupId: 'root',
  };
  const target = {
    ...blankProfile(),
    id: 'end',
    name: 'Database',
    host: 'db.example',
    username: 'app',
    tags: ['critical', 'prod'],
    jumpIds: ['jump'],
    groupId: 'child',
  };
  it('matches compound fields and descendant groups', () => {
    expect(groupPath('child', groups)).toBe('운영 / 서울');
    expect(inGroup(target, 'root', groups)).toBe(true);
    expect(matchesSession(target, 'tag:prod host:db user:app group:서울', groups)).toBe(true);
    expect(matchesSession(target, 'tag:prod host:jump', groups)).toBe(false);
    expect(routeNames(target, [hop, target]).join(' → ')).toContain(
      'Gateway (jump.example:22) → Database',
    );
  });
  it('includes hop dependencies and ancestors without unrelated sessions or groups', () => {
    const bundle = {
      profiles: [hop, target, { ...blankProfile(), id: 'other' }],
      groups,
      tunnels: [{ profileId: 'end' }, { profileId: 'other' }],
    };
    const selected = importSelection(bundle, ['end']);
    expect(selected.profiles.map((p) => p.id)).toEqual(['jump', 'end']);
    expect(selected.groups.map((g) => g.id)).toEqual(['root', 'child']);
    expect(selected.tunnels).toEqual([{ profileId: 'end' }]);
  });
  it('bounds malformed cycles during preview', () => {
    const cyclic = { ...hop, jumpIds: ['end'] };
    expect(routeNames(target, [cyclic, target])).toContain('순환 참조');
    expect(
      importSelection({ profiles: [cyclic, target], groups, tunnels: [] }, ['end']).profiles,
    ).toHaveLength(2);
  });
});
