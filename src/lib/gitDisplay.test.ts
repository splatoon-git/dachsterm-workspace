// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const key = 'dachsterm.gitDisplay';
const load = async () => {
  vi.resetModules();
  return import('./gitDisplay');
};

describe('git display settings', () => {
  beforeEach(() => localStorage.clear());

  it('starts with what the app showed before the setting existed', async () => {
    const { gitDisplay } = await load();
    expect(gitDisplay()).toEqual({
      detail: 'changes',
      treeMarks: 'letter',
      statusBar: true,
      untracked: 'folders',
    });
  });

  it('keeps valid values and replaces invalid ones one by one', async () => {
    localStorage.setItem(
      key,
      JSON.stringify({ detail: 'sync', treeMarks: 'rainbow', statusBar: 'no', untracked: 'files' }),
    );
    const { gitDisplay } = await load();
    expect(gitDisplay()).toEqual({
      detail: 'sync',
      treeMarks: 'letter',
      statusBar: true,
      untracked: 'files',
    });
  });

  it('falls back on a damaged value', async () => {
    localStorage.setItem(key, '{broken');
    const { gitDisplay } = await load();
    expect(gitDisplay().detail).toBe('changes');
  });

  it('saves what changed and leaves the rest', async () => {
    const { gitDisplay, saveGitDisplay } = await load();
    saveGitDisplay({ statusBar: false });
    expect(gitDisplay()).toMatchObject({ statusBar: false, detail: 'changes' });
    expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ statusBar: false });
  });
});
