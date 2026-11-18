import { describe, expect, it } from 'vitest';
import { blankProfile, type Group, type Profile } from '../../lib/ipc';
import {
  addBlocker,
  alreadySaved,
  foundText,
  importable,
  placeUnder,
  previewable,
} from './localImport';

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

describe('addBlocker', () => {
  it('names the FTP sessions that still need a user name', () => {
    const nameless = ['a', 'b', 'c', 'd'].map((id) =>
      profile(id, { username: ' ', protocol: 'ftp' }),
    );
    expect(addBlocker([profile('ok'), ...nameless], 0, [])).toBe(
      '사용자명이 비어 있는 세션이 4개 있습니다(a, b, c 외 1개). 사용자명을 입력하거나 선택을 해제하면 추가할 수 있습니다.',
    );
  });
  it('lets SSH and Telnet through without a user name: they ask when they connect', () => {
    const telnet = profile('t', { username: '', protocol: 'telnet' });
    const ssh = profile('s', { username: '' });
    expect(addBlocker([profile('ok'), telnet, ssh], 0, [])).toBe('');
  });
  it('asks for a selection or a command approval', () => {
    expect(addBlocker([], 0, [])).toBe('추가할 세션을 선택하세요.');
    expect(addBlocker([], 1, [])).toBe('');
    expect(addBlocker([profile('ok')], 0, [profile('hop')])).toContain('명령을 실행하는 세션(hop)');
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
