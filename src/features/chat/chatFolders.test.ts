// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { chatFoldersKey, recentFolders, rememberFolder } from './chatFolders';

describe('recent chat folders', () => {
  beforeEach(() => localStorage.clear());

  it('keeps the newest first without repeats, per session', () => {
    rememberFolder('a', '/srv/one');
    rememberFolder('a', '/srv/two');
    rememberFolder('a', '/srv/one');
    rememberFolder('b', '/home/b');
    expect(recentFolders('a')).toEqual(['/srv/one', '/srv/two']);
    expect(recentFolders('b')).toEqual(['/home/b']);
  });

  it('ignores the login folder and folders the server would refuse', () => {
    rememberFolder('a', '');
    rememberFolder('a', 'relative');
    rememberFolder('a', '/x\ny');
    expect(recentFolders('a')).toEqual([]);
  });

  it('keeps at most eight', () => {
    for (let i = 0; i < 10; i++) rememberFolder('a', `/srv/${i}`);
    expect(recentFolders('a')).toHaveLength(8);
    expect(recentFolders('a')[0]).toBe('/srv/9');
  });

  it('drops damaged values instead of offering them', () => {
    localStorage.setItem(
      chatFoldersKey,
      JSON.stringify({ a: ['/ok', 3, 'bad', '/x\ny'], b: 'no' }),
    );
    expect(recentFolders('a')).toEqual(['/ok']);
    expect(recentFolders('b')).toEqual([]);
    localStorage.setItem(chatFoldersKey, '{');
    expect(recentFolders('a')).toEqual([]);
  });
});
