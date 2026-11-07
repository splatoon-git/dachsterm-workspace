// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentPresetsKey,
  defaultAgentPresets,
  folderProblem,
  nameProblem,
  presetCommand,
  readAgentPresets,
  writeAgentPresets,
} from './presets';
import { startLine } from '../../lib/shell';

const worktree = defaultAgentPresets[3];

describe('agent presets', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('starts from the four default presets', () => {
    expect(readAgentPresets().map((p) => p.command)).toEqual([
      'claude',
      'claude --continue',
      'claude --resume',
      'claude --worktree {name}',
    ]);
  });

  it('keeps valid saved entries and drops the rest', () => {
    localStorage.setItem(
      agentPresetsKey,
      JSON.stringify([
        { name: ' 검토 ', command: ' cli --review ' },
        { name: '', command: 'x' },
        { name: 'line', command: 'a\nb' },
        { name: 3, command: 'x' },
        null,
      ]),
    );
    expect(readAgentPresets()).toEqual([{ name: '검토', command: 'cli --review' }]);
  });

  it('falls back to the defaults for damaged, empty or blocked storage', () => {
    for (const value of ['{', '{}', '[]', JSON.stringify([{ name: '', command: '' }])]) {
      localStorage.setItem(agentPresetsKey, value);
      expect(readAgentPresets()).toEqual(defaultAgentPresets);
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readAgentPresets()).toEqual(defaultAgentPresets);
  });

  it('saves only a list that is valid as a whole', () => {
    expect(writeAgentPresets([{ name: 'a', command: 'cli' }])).toBe(true);
    expect(readAgentPresets()).toEqual([{ name: 'a', command: 'cli' }]);
    expect(writeAgentPresets([])).toBe(false);
    expect(writeAgentPresets([{ name: 'a', command: 'cli\r' }])).toBe(false);
    expect(readAgentPresets()).toEqual([{ name: 'a', command: 'cli' }]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(writeAgentPresets([{ name: 'b', command: 'cli' }])).toBe(false);
  });

  it('accepts only names that cannot be options, paths or shell syntax', () => {
    for (const good of ['feat-1', 'a.b_c', 'X', '9'.repeat(64)])
      expect(nameProblem(good)).toBe(null);
    for (const bad of [
      '',
      '-rf',
      '.',
      '..',
      '.x',
      'a b',
      'a/b',
      '$(id)',
      'a;b',
      '한글',
      'a'.repeat(65),
    ])
      expect(nameProblem(bad), bad).not.toBe(null);
  });

  it('fills {name} only with a valid name', () => {
    expect(presetCommand(worktree, 'feat-1')).toBe('claude --worktree feat-1');
    expect(presetCommand(worktree, '-rf')).toBe(null);
    expect(presetCommand({ name: 'x', command: 'cli {name} {name}' }, 'a')).toBe('cli a a');
    expect(presetCommand(defaultAgentPresets[0], '')).toBe('claude');
  });

  it('checks the folder and quotes it in the typed line', () => {
    expect(folderProblem('')).toBe(null);
    expect(folderProblem('~/src')).not.toBe(null);
    expect(folderProblem('src')).not.toBe(null);
    expect(folderProblem('/srv/a\nb')).not.toBe(null);
    expect(startLine({ folder: '/srv/app', command: 'cli' })).toBe('cd /srv/app && cli');
    expect(startLine({ folder: "/srv/it's 한글", command: 'cli' })).toBe(
      "cd '/srv/it'\\''s 한글' && cli",
    );
    expect(startLine({ folder: '', command: 'cli' })).toBe('cli');
  });
});
