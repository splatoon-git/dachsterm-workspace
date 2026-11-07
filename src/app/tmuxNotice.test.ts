import { describe, expect, it } from 'vitest';
import { blankProfile } from '../lib/ipc';
import { tmuxCloseNotice } from './tmuxNotice';

function memoryStorage(fails = false) {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => {
      if (fails) throw new Error('blocked');
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => void values.set(key, value),
  } as unknown as Storage;
}

describe('tmux close notice', () => {
  const profile = { ...blankProfile(), tmuxSession: 'work' };

  it('says nothing for a session without tmux', () => {
    expect(tmuxCloseNotice(blankProfile(), memoryStorage())).toBeNull();
  });

  it('says it once', () => {
    const storage = memoryStorage();
    expect(tmuxCloseNotice(profile, storage)).toContain('work');
    expect(tmuxCloseNotice(profile, storage)).toBeNull();
  });

  it('still says it when storage is unavailable', () => {
    expect(tmuxCloseNotice(profile, memoryStorage(true))).toContain('work');
  });
});
