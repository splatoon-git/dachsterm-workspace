import { describe, expect, it } from 'vitest';
import {
  childPath,
  flattenTree,
  selectionAfterClick,
  visibleEntries,
  withoutNested,
  type FileEntry,
} from './fileList';

const entry = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  name,
  directory: false,
  symlink: false,
  size: 0,
  modified: 0,
  permissions: null,
  ...extra,
});
const names = (entries: FileEntry[]) => entries.map((e) => e.name);
const view = { showHidden: false, filter: '', sort: 'name' };
const plainClick = { ctrlKey: false, metaKey: false, shiftKey: false };

describe('visibleEntries', () => {
  it('uses the dot convention unless the OS reported a hidden attribute', () => {
    const entries = [entry('.dot'), entry('NTUSER.DAT', { hidden: true }), entry('shown')];
    expect(names(visibleEntries(entries, view))).toEqual(['shown']);
    expect(names(visibleEntries(entries, { ...view, showHidden: true }))).toHaveLength(3);
    expect(names(visibleEntries([entry('.config', { hidden: false })], view))).toEqual(['.config']);
  });
  it('lists folders first and applies the chosen sort', () => {
    const entries = [
      entry('small', { size: 1 }),
      entry('big', { size: 9 }),
      entry('dir', { directory: true }),
    ];
    expect(names(visibleEntries(entries, { ...view, sort: 'size' }))).toEqual([
      'dir',
      'big',
      'small',
    ]);
  });
  it('filters without regard to case and leaves the input order alone', () => {
    const entries = [entry('b.TXT'), entry('a.txt'), entry('c.log')];
    expect(names(visibleEntries(entries, { ...view, filter: 'txt' }))).toEqual(['a.txt', 'b.TXT']);
    expect(names(entries)).toEqual(['b.TXT', 'a.txt', 'c.log']);
  });
});

describe('flattenTree', () => {
  const folder = entry('src', { directory: true });
  const children = new Map([['src', [entry('main.ts'), entry('lib', { directory: true })]]]);
  it('lists only open folders, with paths relative to the root and their depth', () => {
    expect(flattenTree([folder], children, new Set(), view).map((r) => r.name)).toEqual(['src']);
    const rows = flattenTree([folder], children, new Set(['src']), view);
    expect(rows.map((r) => [r.name, r.label, r.depth, r.expanded])).toEqual([
      ['src', 'src', 0, true],
      ['src/lib', 'lib', 1, false],
      ['src/main.ts', 'main.ts', 1, false],
    ]);
  });
  it('keeps an open folder when only its contents match the filter', () => {
    const rows = flattenTree([folder, entry('other')], children, new Set(['src']), {
      ...view,
      filter: 'main',
    });
    expect(rows.map((r) => r.name)).toEqual(['src', 'src/main.ts']);
    expect(flattenTree([folder], children, new Set(), { ...view, filter: 'main' })).toEqual([]);
  });
  it('shows an open folder as empty until its contents arrive', () => {
    expect(flattenTree([folder], new Map(), new Set(['src']), view).map((r) => r.name)).toEqual([
      'src',
    ]);
  });
});

describe('withoutNested', () => {
  it('drops items already covered by a selected folder', () => {
    expect(withoutNested(['src', 'src/a', 'src/b/c', 'srcx', 'd'])).toEqual(['src', 'srcx', 'd']);
  });
});

describe('selectionAfterClick', () => {
  const visible = ['a', 'b', 'c', 'd'];
  it('replaces, toggles and extends the selection', () => {
    expect(selectionAfterClick(visible, ['a'], 'b', 'a', plainClick)).toEqual(['b']);
    expect(selectionAfterClick(visible, ['a'], 'b', 'a', { ...plainClick, ctrlKey: true })).toEqual(
      ['a', 'b'],
    );
    expect(selectionAfterClick(visible, ['a'], 'a', 'a', { ...plainClick, metaKey: true })).toEqual(
      [],
    );
    expect(
      selectionAfterClick(visible, ['b'], 'd', 'b', { ...plainClick, shiftKey: true }),
    ).toEqual(['b', 'c', 'd']);
  });
});

describe('childPath', () => {
  it('joins under Linux, drive and share roots without doubling separators', () => {
    expect(childPath('/', 'a')).toBe('/a');
    expect(childPath('/app/mesim', 'a')).toBe('/app/mesim/a');
    expect(childPath('C:\\', 'a')).toBe('C:/a');
    expect(childPath('C:\\Users\\me', 'a')).toBe('C:\\Users\\me/a');
  });
});
