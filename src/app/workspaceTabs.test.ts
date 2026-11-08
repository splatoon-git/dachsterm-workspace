import { describe, expect, it } from 'vitest';
import {
  findGroup,
  groups,
  moveTab,
  tabKey,
  type GroupNode,
  type Layout,
  type TabRef,
} from './workspaceLayout';
import { openDocument, pinDocument, replacedPreview, type DocumentRef } from './workspaceTabs';

const preview = (id: string): DocumentRef => ({ kind: 'file', id, preview: true });
const pinned = (id: string): DocumentRef => ({ kind: 'file', id });
const session = (tabId: string): TabRef => ({ kind: 'session', tabId });
const group = (id: string, tabs: TabRef[], active = tabs[0]): GroupNode => ({
  type: 'group',
  id,
  tabs,
  active: active ? tabKey(active) : '',
});
const one = (g: GroupNode): Layout => ({ root: g, focused: g.id });
const two = (a: GroupNode, b: GroupNode, focused = a.id): Layout => ({
  root: { type: 'split', dir: 'row', sizes: [0.5, 0.5], children: [a, b] },
  focused,
});
const keys = (layout: Layout, id: string) => findGroup(layout.root, id)!.tabs.map(tabKey);
const previews = (layout: Layout, id: string) =>
  findGroup(layout.root, id)!
    .tabs.filter((tab) => tab.kind === 'file' && tab.preview)
    .map(tabKey);

describe('preview tabs', () => {
  it('shares one preview between files and diffs', () => {
    const diff: DocumentRef = { kind: 'diff', id: 'd', preview: true };
    const layout = one(group('a', [session('t'), preview('f')], preview('f')));
    expect(replacedPreview(layout, diff)).toBe('file:f');
    expect(keys(openDocument(layout, diff), 'a')).toEqual(['session:t', 'diff:d']);
  });

  it('pins a diff like a file', () => {
    const diff: DocumentRef = { kind: 'diff', id: 'd', preview: true };
    const opened = openDocument(one(group('a', [session('t')])), diff);
    const tab = () => findGroup(pinDocument(opened, 'diff:d').root, 'a')!.tabs[1];
    expect(tab()).toEqual({ kind: 'diff', id: 'd', preview: false });
  });

  it('opens a preview next to the terminal and selects it', () => {
    const next = openDocument(one(group('g', [session('t')])), preview('a'));
    expect(keys(next, 'g')).toEqual(['session:t', 'file:a']);
    expect(findGroup(next.root, 'g')!.active).toBe('file:a');
    expect(findGroup(next.root, 'g')!.previous).toBe('session:t');
  });

  it('the next click replaces the preview in the same position', () => {
    const start = group('g', [preview('a'), session('t')], preview('a'));
    const next = openDocument(one(start), preview('b'));
    expect(keys(next, 'g')).toEqual(['file:b', 'session:t']);
    expect(findGroup(next.root, 'g')!.active).toBe('file:b');
  });

  it('does not make a replaced preview what the group returns to', () => {
    const start = group('g', [session('t'), preview('a')], preview('a'));
    const shown = { ...start, previous: 'session:t' };
    const next = findGroup(openDocument(one(shown), preview('b')).root, 'g')!;
    expect(next.previous).toBe('session:t');
  });

  it('reports which tab it will replace, and only that', () => {
    const layout = one(group('g', [session('t'), preview('a')]));
    expect(replacedPreview(layout, preview('b'))).toBe('file:a');
    expect(replacedPreview(layout, preview('a'))).toBeUndefined();
    expect(replacedPreview(layout, pinned('b'))).toBeUndefined();
    expect(replacedPreview(one(group('g', [pinned('a')])), preview('b'))).toBeUndefined();
  });

  it('a pinned tab is never replaced', () => {
    const next = openDocument(one(group('g', [pinned('a')])), preview('b'));
    expect(keys(next, 'g')).toEqual(['file:a', 'file:b']);
  });

  it('a pinned open leaves the preview in place', () => {
    const next = openDocument(one(group('g', [preview('a')])), pinned('b'));
    expect(keys(next, 'g')).toEqual(['file:a', 'file:b']);
    expect(previews(next, 'g')).toEqual(['file:a']);
  });

  it('each group has its own preview', () => {
    const layout = two(group('l', [preview('a')]), group('r', [preview('b')]), 'r');
    const next = openDocument(layout, preview('c'));
    expect(keys(next, 'l')).toEqual(['file:a']);
    expect(keys(next, 'r')).toEqual(['file:c']);
  });

  it('keeps one preview per group after a move brought in a second', () => {
    const layout = two(group('l', [preview('a')]), group('r', [preview('b'), session('t')]));
    const moved = moveTab(layout, 'file:b', 'l');
    expect(previews(moved, 'l')).toHaveLength(2);
    const next = openDocument(moved, preview('c'));
    expect(previews(next, 'l')).toEqual(['file:c']);
    expect(keys(next, 'l')).toEqual(['file:a', 'file:c']);
  });

  it('selects a file that is already open instead of opening it again', () => {
    const start = group('g', [pinned('a'), session('t')], session('t'));
    const next = openDocument(one(start), preview('a'));
    expect(keys(next, 'g')).toEqual(['file:a', 'session:t']);
    expect(findGroup(next.root, 'g')!.active).toBe('file:a');
    expect(previews(next, 'g')).toEqual([]);
  });

  it('returns the same layout when the open file is already shown', () => {
    const layout = one(group('g', [pinned('a')]));
    expect(openDocument(layout, preview('a'))).toBe(layout);
  });

  it('moves focus to a file open in another group', () => {
    const layout = two(group('l', [session('t')]), group('r', [pinned('a')]));
    expect(openDocument(layout, preview('a')).focused).toBe('r');
  });

  it('fills an empty group first', () => {
    const layout = two(group('l', [session('t')]), group('r', []));
    const next = openDocument(layout, preview('a'));
    expect(keys(next, 'r')).toEqual(['file:a']);
    expect(next.focused).toBe('r');
  });
});

describe('pinning', () => {
  it('turns a preview into a normal tab', () => {
    const layout = one(group('g', [preview('a')]));
    const next = pinDocument(layout, 'file:a');
    expect(previews(next, 'g')).toEqual([]);
    expect(keys(next, 'g')).toEqual(['file:a']);
    expect(keys(openDocument(next, preview('b')), 'g')).toEqual(['file:a', 'file:b']);
  });

  it('does nothing for a tab that is not a preview', () => {
    const layout = one(group('g', [pinned('a'), session('t')]));
    expect(pinDocument(layout, 'file:a')).toBe(layout);
    expect(pinDocument(layout, 'session:t')).toBe(layout);
    expect(pinDocument(layout, 'file:none')).toBe(layout);
  });
});

describe('keeping the FTP list on screen', () => {
  const placement = { keepVisible: 'session:ftp', makeId: () => 'new' };

  it('opens beside the list when it is the only group', () => {
    const next = openDocument(one(group('g', [session('ftp')])), preview('a'), placement);
    expect(groups(next.root).map((g) => g.id)).toEqual(['g', 'new']);
    expect(keys(next, 'g')).toEqual(['session:ftp']);
    expect(keys(next, 'new')).toEqual(['file:a']);
    expect(next.focused).toBe('new');
  });

  it('reuses the group that already holds the preview', () => {
    const layout = two(group('g', [session('ftp')]), group('p', [preview('a')]));
    expect(replacedPreview(layout, preview('b'), placement)).toBe('file:a');
    const next = openDocument(layout, preview('b'), placement);
    expect(keys(next, 'g')).toEqual(['session:ftp']);
    expect(keys(next, 'p')).toEqual(['file:b']);
  });

  it('uses another group rather than splitting again', () => {
    const layout = two(group('g', [session('ftp')]), group('p', [session('t')]));
    const next = openDocument(layout, pinned('a'), placement);
    expect(keys(next, 'g')).toEqual(['session:ftp']);
    expect(keys(next, 'p')).toEqual(['session:t', 'file:a']);
    expect(groups(next.root)).toHaveLength(2);
  });

  it('opens in the focused group when the list is in another one', () => {
    const layout = two(group('g', [session('ftp')]), group('p', [session('t')]), 'p');
    expect(openDocument(layout, preview('a'), placement).focused).toBe('p');
  });
});
