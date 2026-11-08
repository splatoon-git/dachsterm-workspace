import { describe, expect, it } from 'vitest';
import {
  changesOf,
  currentValue,
  fieldsFor,
  trustsEverything,
  type GitConfigEntry,
} from './gitConfigModel';

const global = { kind: 'global' } as const;
const fields = fieldsFor(global);
const entries: GitConfigEntry[] = [
  { key: 'user.name', values: ['Kim'], hidden: false },
  { key: 'pull.rebase', values: ['true'], hidden: false },
  { key: 'core.editor', values: ['vim', 'nano'], hidden: false },
  { key: 'credential.helper', values: ['', 'manager'], hidden: false },
  { key: 'safe.directory', values: ['/a'], hidden: false },
];

describe('git config changes', () => {
  it('finds nothing to do for an empty draft or the same value', () => {
    expect(changesOf(fields, entries, {})).toEqual([]);
    expect(
      changesOf(fields, entries, {
        'user.name': ' Kim ',
        'pull.rebase': 'true',
        'rerere.enabled': '',
      }),
    ).toEqual([]);
  });

  it('writes only the key that changed', () => {
    expect(changesOf(fields, entries, { 'user.name': 'Lee', 'pull.rebase': 'true' })).toEqual([
      { op: 'set', key: 'user.name', value: 'Lee', all: false },
    ]);
  });

  it('clears a setting that had a value', () => {
    expect(changesOf(fields, entries, { 'pull.rebase': '' })).toEqual([
      { op: 'unset', key: 'pull.rebase', all: false },
    ]);
  });

  it('replaces or clears every value of a setting that has several', () => {
    expect(changesOf(fields, entries, { 'core.editor': 'code' })).toEqual([
      { op: 'set', key: 'core.editor', value: 'code', all: true },
    ]);
    expect(changesOf(fields, entries, { 'core.editor': '' })).toEqual([
      { op: 'unset', key: 'core.editor', all: true },
    ]);
  });

  it('never clears the credential helper, and replaces it only when typed', () => {
    expect(changesOf(fields, entries, { 'credential.helper': '  ' })).toEqual([]);
    expect(changesOf(fields, entries, { 'credential.helper': 'manager' })).toEqual([]);
    expect(changesOf(fields, entries, { 'credential.helper': 'store' })).toEqual([
      { op: 'set', key: 'credential.helper', value: 'store', all: true },
    ]);
  });

  it('adds a new safe directory and skips one already listed', () => {
    expect(changesOf(fields, entries, { 'safe.directory': '/a' })).toEqual([]);
    expect(changesOf(fields, entries, { 'safe.directory': '/b' })).toEqual([
      { op: 'add', key: 'safe.directory', value: '/b' },
    ]);
  });

  it('warns about the wildcard only', () => {
    expect(trustsEverything([{ op: 'add', key: 'safe.directory', value: '*' }])).toBe(true);
    expect(trustsEverything([{ op: 'add', key: 'safe.directory', value: '/srv/*' }])).toBe(false);
    expect(trustsEverything([{ op: 'set', key: 'core.editor', value: '*', all: false }])).toBe(
      false,
    );
  });

  it('leaves the safe directory out of a repository scope', () => {
    expect(fieldsFor({ kind: 'local', folder: '/r' }).map((f) => f.key)).not.toContain(
      'safe.directory',
    );
    expect(fields.map((f) => f.key)).toContain('safe.directory');
  });

  it('reads the value in effect', () => {
    expect(currentValue(entries[2])).toBe('nano');
    expect(currentValue(undefined)).toBe('');
  });
});
