// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  diffTabTitle,
  editsWorktree,
  mergeRefresh,
  readDiffLayout,
  saveDiffLayout,
  sideLabels,
  unshownReason,
  type DiffSide,
} from './gitFileDiff';

const text = (value: string, hash = value): DiffSide => ({
  kind: 'text',
  text: value,
  encoding: 'utf-8',
  lossy: false,
  hash,
});

describe('what a diff tab compares', () => {
  it('names the sides of each comparison', () => {
    expect(sideLabels({ kind: 'headIndex' })).toEqual(['HEAD', '인덱스']);
    expect(sideLabels({ kind: 'indexWorktree', deleted: false })).toEqual(['인덱스', '작업 트리']);
    expect(sideLabels({ kind: 'untracked' })).toEqual(['없음', '작업 트리']);
  });

  it('titles the tab', () => {
    expect(diffTabTitle('a.ts', { kind: 'headIndex' })).toBe('a.ts ↔ HEAD');
    expect(diffTabTitle('a.ts', { kind: 'indexWorktree', deleted: false })).toBe('a.ts ↔ 인덱스');
    expect(diffTabTitle('a.ts', { kind: 'untracked' })).toBe('a.ts (새 파일)');
  });

  it('edits only the working tree', () => {
    expect(editsWorktree({ kind: 'headIndex' })).toBe(false);
    expect(editsWorktree({ kind: 'indexWorktree', deleted: false })).toBe(true);
    expect(editsWorktree({ kind: 'untracked' })).toBe(true);
  });
});

describe('a refresh after the Git view changed the repository', () => {
  const old = { original: text('old left'), modified: text('right', 'h1') };

  it('updates the left side and keeps the editor when the right did not change', () => {
    const next = { original: text('new left'), modified: text('right', 'h1') };
    const merged = mergeRefresh(old, next, false);
    expect(merged.remount).toBe(false);
    expect(merged.diff).toEqual({ original: next.original, modified: old.modified });
  });

  it('replaces a right side that changed when nothing is unsaved', () => {
    const next = { original: text('new left'), modified: text('other', 'h2') };
    expect(mergeRefresh(old, next, false)).toEqual({ diff: next, remount: true });
  });

  it('never replaces unsaved edits', () => {
    const next = { original: text('new left'), modified: text('other', 'h2') };
    const merged = mergeRefresh(old, next, true);
    expect(merged.remount).toBe(false);
    expect(merged.diff.modified).toBe(old.modified);
    expect(merged.diff.original).toBe(next.original);
  });

  it('notices a right side that disappeared', () => {
    const next = { original: text('new left'), modified: { kind: 'absent' } as const };
    expect(mergeRefresh(old, next, false).remount).toBe(true);
  });
});

describe('sides that are not text', () => {
  it('shows text and absent sides', () => {
    expect(unshownReason({ original: { kind: 'absent' }, modified: text('a') })).toBeNull();
  });

  it('prefers the size reason, since the other side may simply not have been read', () => {
    expect(
      unshownReason({ original: { kind: 'binary', format: 'x' }, modified: { kind: 'tooLarge' } }),
    ).toBe('tooLarge');
    expect(unshownReason({ original: { kind: 'binary', format: 'x' }, modified: text('a') })).toBe(
      'binary',
    );
  });
});

describe('the remembered layout', () => {
  afterEach(() => localStorage.clear());

  it('defaults to side by side and ignores anything it did not write', () => {
    expect(readDiffLayout()).toBe('split');
    localStorage.setItem('dachsterm.gitDiff.layout', 'wide');
    expect(readDiffLayout()).toBe('split');
  });

  it('remembers one line', () => {
    saveDiffLayout('inline');
    expect(readDiffLayout()).toBe('inline');
  });
});
