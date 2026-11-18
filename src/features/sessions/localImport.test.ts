import { describe, expect, it } from 'vitest';
import { blankProfile, type Group, type Profile } from '../../lib/ipc';
import { alreadySaved, foundText, importable, placeUnder, previewable } from './localImport';

const profile = (id: string, extra: Partial<Profile> = {}): Profile => ({
  ...blankProfile(),
  id,
  name: id,
  host: `${id}.example`,
  username: 'u',
  ...extra,
});

describe('placeUnder', () => {
  it('puts top-level folders and loose sessions under the program group', () => {
    const groups: Group[] = [
      { id: 'dev', name: '개발', parentId: null },
      { id: 'seoul', name: '서울', parentId: 'dev' },
    ];
    const bundle = {
      groups,
      profiles: [profile('a', { groupId: 'seoul' }), profile('b')],
    };
    const placed = placeUnder(bundle, 'PuTTY', 'root');
    expect(placed.groups.map((g) => [g.id, g.name, g.parentId])).toEqual([
      ['root', 'PuTTY', null],
      ['dev', '개발', 'root'],
      ['seoul', '서울', 'dev'],
    ]);
    expect(placed.profiles.map((p) => p.groupId)).toEqual(['seoul', 'root']);
    expect(bundle.groups[0].parentId).toBeNull();
  });

  it('adds no empty group when nothing is imported', () => {
    const bundle = { groups: [], profiles: [] };
    expect(placeUnder(bundle, 'PuTTY', 'root')).toBe(bundle);
  });
});

describe('alreadySaved', () => {
  const saved = [profile('lab', { host: 'Lab.Example', port: 22 })];
  it('matches the same protocol, host, port and account', () => {
    expect(alreadySaved(profile('copy', { host: 'lab.example' }), saved)).toBe(true);
  });
  it('treats another account, port or protocol as a new session', () => {
    expect(alreadySaved(profile('x', { host: 'lab.example', username: 'root' }), saved)).toBe(
      false,
    );
    expect(alreadySaved(profile('x', { host: 'lab.example', port: 2222 }), saved)).toBe(false);
    expect(alreadySaved(profile('x', { host: 'lab.example', protocol: 'telnet' }), saved)).toBe(
      false,
    );
  });
});

describe('importable and previewable', () => {
  const base = { source: 'bookmarks', place: 'x', include: false, problem: null } as const;
  it('opens a source whose entries were all left out, without offering it on the empty list', () => {
    const leftOut = { ...base, count: 0, skipped: 3 };
    expect(previewable(leftOut)).toBe(true);
    expect(importable(leftOut)).toBe(false);
  });
  it('opens nothing for an empty or unreadable source', () => {
    expect(previewable({ ...base, count: 0, skipped: 0 })).toBe(false);
    expect(previewable({ ...base, count: 0, skipped: 3, problem: '오류' })).toBe(false);
    expect(previewable({ ...base, count: 2, skipped: 0 })).toBe(true);
  });
});

describe('foundText', () => {
  it('names the source and its count', () => {
    const base = { place: 'x', include: false, problem: null, skipped: 0 };
    expect(foundText({ ...base, source: 'putty', count: 12 })).toBe('PuTTY 세션 12개');
    expect(foundText({ ...base, source: 'bookmarks', count: 0, skipped: 1 })).toBe(
      '세션 북마크 0개 · 제외 1개',
    );
    expect(foundText({ ...base, source: 'openssh', count: 1, include: true })).toBe(
      'OpenSSH config 호스트 1개 + Include 파일',
    );
    expect(foundText({ ...base, source: 'bookmarks', count: 0, problem: '오류' })).toBe(
      '세션 북마크 (읽지 못함)',
    );
  });
});
