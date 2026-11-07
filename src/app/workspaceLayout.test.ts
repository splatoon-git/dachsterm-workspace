import { describe, expect, it } from 'vitest';
import {
  adjacentGroup,
  dividerRange,
  dividers,
  equalize,
  rects,
  resize,
} from './workspaceGeometry';
import {
  allTabs,
  applyPreset,
  closeEmptyGroup,
  closeTab,
  displayRoot,
  findGroup,
  focusGroup,
  groupOfTab,
  groups,
  leaveTab,
  moveTab,
  openBeside,
  openTab,
  parseSaved,
  selectTab,
  serialize,
  singleGroupLayout,
  splitWith,
  tabKey,
  type Layout,
  type LayoutNode,
  type TabRef,
} from './workspaceLayout';

const ids = () => {
  let next = 0;
  return () => `g${next++}`;
};
const session = (tabId: string): TabRef => ({ kind: 'session', tabId });
const key = (tabId: string) => tabKey(session(tabId));
const canvas = { width: 1000, height: 800 };

function withTabs(...names: string[]): Layout {
  return names.reduce(
    (layout, name) => openTab(layout, session(name)),
    singleGroupLayout(() => 'root'),
  );
}
function shape(node: LayoutNode): unknown {
  return node.type === 'group'
    ? node.tabs.map((tab) => (tab.kind === 'session' ? tab.tabId : tabKey(tab)))
    : { [node.dir]: node.children.map(shape) };
}
function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

describe('opening and closing tabs', () => {
  it('appends to the focused group and shows the new tab', () => {
    const layout = withTabs('a', 'b');
    expect(shape(layout.root)).toEqual(['a', 'b']);
    expect(findGroup(layout.root, 'root')!.active).toBe(key('b'));
  });

  it('fills empty groups from the front before the focused group', () => {
    const empty = parseSaved('grid', ids());
    const first = openTab(empty, session('a'));
    const second = openTab(first, session('b'));
    expect(shape(second.root)).toEqual({ column: [{ row: [['a'], ['b']] }, { row: [[], []] }] });
    expect(second.focused).toBe(groups(second.root)[1].id);
  });

  it('selects an already open tab instead of opening it twice', () => {
    const layout = openTab(withTabs('a', 'b'), session('a'));
    expect(allTabs(layout.root)).toHaveLength(2);
    expect(findGroup(layout.root, 'root')!.active).toBe(key('a'));
  });

  it('moves to the previously shown tab, then a neighbour, when the active tab closes', () => {
    let layout = withTabs('a', 'b', 'c');
    layout = selectTab(layout, 'root', key('a'));
    layout = selectTab(layout, 'root', key('c'));
    layout = closeTab(layout, key('c'));
    expect(findGroup(layout.root, 'root')!.active).toBe(key('a'));
    layout = closeTab(layout, key('a'));
    expect(findGroup(layout.root, 'root')!.active).toBe(key('b'));
    layout = closeTab(layout, key('b'));
    expect(shape(layout.root)).toEqual([]);
    expect(findGroup(layout.root, 'root')!.active).toBe('');
  });

  it('keeps the active tab when another tab closes', () => {
    const layout = closeTab(withTabs('a', 'b', 'c'), key('a'));
    expect(findGroup(layout.root, 'root')!.active).toBe(key('c'));
  });

  it('removes a group when its last tab leaves and collapses the tree', () => {
    let layout = withTabs('a', 'b');
    layout = splitWith(layout, key('b'), 'root', 'right', ids());
    expect(shape(layout.root)).toEqual({ row: [['a'], ['b']] });
    layout = closeTab(layout, key('b'));
    expect(shape(layout.root)).toEqual(['a']);
    expect(layout.root.type).toBe('group');
    expect(layout.focused).toBe('root');
  });

  it('leaves a game for the previous work tab and keeps the game tab open', () => {
    let layout = withTabs('a', 'b');
    layout = selectTab(layout, 'root', key('a'));
    layout = openTab(layout, { kind: 'game', id: 'blocks' });
    layout = leaveTab(layout, 'root');
    expect(findGroup(layout.root, 'root')!.active).toBe(key('a'));
    expect(allTabs(layout.root)).toHaveLength(3);
  });

  it('shows nothing after leaving a game in a group of games', () => {
    let layout = singleGroupLayout(() => 'root');
    layout = openTab(layout, { kind: 'game', id: 'blocks' });
    layout = openTab(layout, { kind: 'game', id: 'tiles' });
    expect(findGroup(leaveTab(layout, 'root').root, 'root')!.active).toBe('');
  });

  it('closes an empty group only', () => {
    const empty = parseSaved('columns', ids());
    const [first, second] = groups(empty.root);
    const filled = openTab(empty, session('a'));
    expect(closeEmptyGroup(filled, first.id)).toBe(filled);
    expect(shape(closeEmptyGroup(filled, second.id).root)).toEqual(['a']);
    const single = singleGroupLayout(() => 'root');
    expect(closeEmptyGroup(single, 'root')).toBe(single);
  });

  it('returns the same layout when nothing changes', () => {
    const layout = withTabs('a');
    expect(closeTab(layout, key('missing'))).toBe(layout);
    expect(selectTab(layout, 'root', key('a'))).toBe(layout);
    expect(focusGroup(layout, 'root')).toBe(layout);
    expect(focusGroup(layout, 'missing')).toBe(layout);
  });
});

describe('moving tabs', () => {
  it('reorders inside a group using positions from before the move', () => {
    const layout = withTabs('a', 'b', 'c');
    expect(shape(moveTab(layout, key('a'), 'root', 3).root)).toEqual(['b', 'c', 'a']);
    expect(shape(moveTab(layout, key('a'), 'root', 2).root)).toEqual(['b', 'a', 'c']);
    expect(shape(moveTab(layout, key('c'), 'root', 0).root)).toEqual(['c', 'a', 'b']);
  });

  it('moves between groups at a position and shows the tab', () => {
    let layout = withTabs('a', 'b', 'c');
    layout = splitWith(layout, key('c'), 'root', 'right', ids());
    const right = groupOfTab(layout.root, key('c'))!.id;
    const moved = moveTab(layout, key('a'), right, 0);
    expect(shape(moved.root)).toEqual({ row: [['b'], ['a', 'c']] });
    expect(findGroup(moved.root, right)!.active).toBe(key('a'));
    expect(moved.focused).toBe(right);
  });

  it('collapses the source group when its last tab moves away', () => {
    let layout = withTabs('a', 'b');
    layout = splitWith(layout, key('b'), 'root', 'bottom', ids());
    const moved = moveTab(layout, key('b'), 'root');
    expect(shape(moved.root)).toEqual(['a', 'b']);
    expect(moved.root.type).toBe('group');
  });

  it('ignores a tab or group that does not exist', () => {
    const layout = withTabs('a');
    expect(moveTab(layout, key('missing'), 'root')).toBe(layout);
    expect(moveTab(layout, key('a'), 'missing')).toBe(layout);
  });
});

describe('splitting', () => {
  it.each([
    ['left', { row: [['b'], ['a']] }],
    ['right', { row: [['a'], ['b']] }],
    ['top', { column: [['b'], ['a']] }],
    ['bottom', { column: [['a'], ['b']] }],
  ] as const)('places the new group on the %s', (side, expected) => {
    const layout = splitWith(withTabs('a', 'b'), key('b'), 'root', side, ids());
    expect(shape(layout.root)).toEqual(expected);
    expect(groupOfTab(layout.root, key('b'))!.id).toBe(layout.focused);
  });

  it('refuses to split a group with its only tab', () => {
    const layout = withTabs('a');
    expect(splitWith(layout, key('a'), 'root', 'right')).toBe(layout);
  });

  it('adds to a split of the same direction without nesting', () => {
    let layout = withTabs('a', 'b', 'c');
    layout = splitWith(layout, key('c'), 'root', 'right', ids());
    layout = splitWith(layout, key('b'), 'root', 'right', ids());
    expect(shape(layout.root)).toEqual({ row: [['a'], ['b'], ['c']] });
    expect(layout.root.type === 'split' && layout.root.sizes).toEqual([0.25, 0.25, 0.5]);
  });

  it('nests across directions', () => {
    let layout = withTabs('a', 'b', 'c');
    layout = splitWith(layout, key('c'), 'root', 'right', ids());
    layout = splitWith(layout, key('b'), 'root', 'bottom', ids());
    expect(shape(layout.root)).toEqual({ row: [{ column: [['a'], ['b']] }, ['c']] });
  });

  it('merges same-direction nesting when a middle split collapses', () => {
    let layout = withTabs('a', 'b', 'c', 'd');
    const make = ids();
    layout = splitWith(layout, key('d'), 'root', 'right', make);
    layout = splitWith(layout, key('c'), groupOfTab(layout.root, key('d'))!.id, 'bottom', make);
    layout = splitWith(layout, key('b'), groupOfTab(layout.root, key('c'))!.id, 'right', make);
    expect(shape(layout.root)).toEqual({
      row: [['a'], { column: [['d'], { row: [['c'], ['b']] }] }],
    });
    const closed = closeTab(layout, key('d'));
    expect(shape(closed.root)).toEqual({ row: [['a'], ['c'], ['b']] });
    expect(closed.root.type === 'split' && sum(closed.root.sizes)).toBeCloseTo(1);
  });

  it('fills an empty target instead of splitting it', () => {
    const filled = applyPreset(withTabs('a', 'b'), 'grid', ids());
    const empty = groups(filled.root)[2];
    const moved = splitWith(filled, key('b'), empty.id, 'right', ids());
    expect(shape(moved.root)).toEqual({ column: [['a'], { row: [['b'], []] }] });
    expect(moved.focused).toBe(empty.id);
  });

  it('splits a group using one of its own tabs when more remain', () => {
    const layout = splitWith(withTabs('a', 'b', 'c'), key('c'), 'root', 'left', ids());
    expect(shape(layout.root)).toEqual({ row: [['c'], ['a', 'b']] });
  });
});

describe('opening beside a group', () => {
  it('puts a new tab in a new group on the chosen side and focuses it', () => {
    const layout = openBeside(withTabs('a'), session('b'), 'root', 'right', ids());
    expect(shape(layout.root)).toEqual({ row: [['a'], ['b']] });
    expect(groupOfTab(layout.root, key('b'))!.id).toBe(layout.focused);
    const below = openBeside(withTabs('a'), session('b'), 'root', 'bottom', ids());
    expect(shape(below.root)).toEqual({ column: [['a'], ['b']] });
  });

  it('leaves empty restored groups for later tabs', () => {
    const restored = applyPreset(withTabs('a'), 'columns', ids());
    const layout = openBeside(restored, session('b'), groups(restored.root)[0].id, 'bottom', ids());
    expect(shape(layout.root)).toEqual({ row: [{ column: [['a'], ['b']] }, []] });
  });

  it('falls back to a plain open when the target is gone or the tab is open', () => {
    const layout = withTabs('a');
    expect(shape(openBeside(layout, session('b'), 'missing', 'right').root)).toEqual(['a', 'b']);
    expect(openBeside(layout, session('a'), 'root', 'right')).toBe(layout);
  });
});

describe('coordinates and resizing', () => {
  const tree = (): Layout => {
    let layout = withTabs('a', 'b', 'c');
    const make = ids();
    layout = splitWith(layout, key('c'), 'root', 'right', make);
    return splitWith(layout, key('b'), 'root', 'bottom', make);
  };

  it('computes fractions that cover the workspace', () => {
    const [topLeft, bottomLeft, right] = rects(tree().root);
    expect(topLeft).toMatchObject({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(bottomLeft).toMatchObject({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    expect(right).toMatchObject({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it('lists a divider for every boundary with its own path', () => {
    const list = dividers(tree().root);
    expect(list).toHaveLength(2);
    expect(list).toContainEqual({ path: [0], index: 0, dir: 'column', x: 0, y: 0.5, length: 0.5 });
    expect(list).toContainEqual({ path: [], index: 0, dir: 'row', x: 0.5, y: 0, length: 1 });
  });

  it('moves only the two groups beside a divider', () => {
    let layout = withTabs('a', 'b', 'c');
    layout = splitWith(layout, key('c'), 'root', 'right', ids());
    layout = splitWith(layout, key('b'), 'root', 'right', ids());
    const wide = { width: 2000, height: 800 };
    const root = resize(layout.root, { path: [], index: 0 }, 600, wide);
    expect(root.type === 'split' && root.sizes[0]).toBeCloseTo(0.3);
    expect(root.type === 'split' && root.sizes[1]).toBeCloseTo(0.2);
    expect(root.type === 'split' && root.sizes[2]).toBeCloseTo(0.5);
  });

  it('keeps each side at the minimum group size', () => {
    let layout = withTabs('a', 'b');
    layout = splitWith(layout, key('b'), 'root', 'right', ids());
    const left = resize(layout.root, { path: [], index: 0 }, 10, canvas);
    expect(left.type === 'split' && left.sizes[0]).toBeCloseTo(0.24);
    const right = resize(layout.root, { path: [], index: 0 }, 990, canvas);
    expect(right.type === 'split' && right.sizes[0]).toBeCloseTo(0.76);
  });

  it('counts the minimum of a nested split', () => {
    const { root } = tree();
    const divider = dividers(root).find((d) => d.dir === 'row')!;
    expect(dividerRange(root, divider, canvas)).toMatchObject({ value: 500, min: 240, max: 760 });
    const inner = dividers(root).find((d) => d.dir === 'column')!;
    expect(dividerRange(root, inner, canvas)).toMatchObject({ value: 400, min: 120, max: 680 });
  });

  it('resizes a nested split without touching its parent', () => {
    const { root } = tree();
    const next = resize(root, { path: [0], index: 0 }, 200, canvas);
    if (next.type !== 'split' || next.children[0].type !== 'split') throw new Error('shape');
    expect(next.sizes).toEqual([0.5, 0.5]);
    expect(next.children[0].sizes[0]).toBeCloseTo(0.25);
    expect(next.children[0].sizes[1]).toBeCloseTo(0.75);
  });

  it('leaves the tree alone when the sizes cannot change', () => {
    const { root } = tree();
    expect(resize(root, { path: [], index: 0 }, 500, canvas)).toBe(root);
    expect(resize(root, { path: [], index: 0 }, 100, { width: 0, height: 0 })).toBe(root);
    expect(resize(root, { path: [9], index: 0 }, 100, canvas)).toBe(root);
    const small = { width: 300, height: 800 };
    expect(resize(root, { path: [], index: 0 }, 100, small)).toBe(root);
  });

  it('returns to equal sizes', () => {
    let layout = withTabs('a', 'b');
    layout = splitWith(layout, key('b'), 'root', 'right', ids());
    const moved = resize(layout.root, { path: [], index: 0 }, 300, canvas);
    const equal = equalize(moved, []);
    expect(equal.type === 'split' && equal.sizes).toEqual([0.5, 0.5]);
    expect(equalize(moved, [5])).toBe(moved);
  });

  it('finds the group beside another in each direction', () => {
    const { root } = tree();
    const [topLeft, bottomLeft, right] = groups(root);
    expect(adjacentGroup(root, topLeft.id, 'right')).toBe(right.id);
    expect(adjacentGroup(root, topLeft.id, 'bottom')).toBe(bottomLeft.id);
    expect(adjacentGroup(root, bottomLeft.id, 'top')).toBe(topLeft.id);
    expect(adjacentGroup(root, topLeft.id, 'left')).toBeUndefined();
    expect(adjacentGroup(root, right.id, 'bottom')).toBeUndefined();
    expect(adjacentGroup(root, 'missing', 'left')).toBeUndefined();
  });
});

describe('presets', () => {
  it('deals tabs in order and shows the first of each group', () => {
    const layout = applyPreset(withTabs('a', 'b', 'c', 'd'), 'grid', ids());
    expect(shape(layout.root)).toEqual({
      column: [{ row: [['a'], ['b']] }, { row: [['c'], ['d']] }],
    });
  });

  it('keeps the focused tab on screen', () => {
    const layout = applyPreset(withTabs('a', 'b', 'c'), 'columns', ids());
    expect(shape(layout.root)).toEqual({ row: [['a', 'c'], ['b']] });
    const left = groups(layout.root)[0];
    expect(left.active).toBe(key('c'));
    expect(layout.focused).toBe(left.id);
  });

  it('merges everything into one group', () => {
    let layout = applyPreset(withTabs('a', 'b', 'c'), 'grid', ids());
    layout = applyPreset(layout, 'single', ids());
    expect(shape(layout.root)).toEqual(['a', 'b', 'c']);
    expect(groups(layout.root)[0].active).toBe(key('c'));
  });

  it('leaves spare groups empty for the next tabs', () => {
    const layout = applyPreset(withTabs('a'), 'rows', ids());
    expect(shape(layout.root)).toEqual({ column: [['a'], []] });
    expect(shape(openTab(layout, session('b')).root)).toEqual({ column: [['a'], ['b']] });
  });

  it('keeps games and the preview in the deal', () => {
    let layout = withTabs('a');
    layout = openTab(layout, { kind: 'preview' });
    layout = openTab(layout, { kind: 'game', id: 'tiles' });
    layout = applyPreset(layout, 'columns', ids());
    expect(allTabs(layout.root).map(tabKey)).toEqual([key('a'), 'game:tiles', 'preview']);
    expect(findGroup(layout.root, layout.focused)!.active).toBe('game:tiles');
  });
});

describe('what is on screen', () => {
  const split = () => splitWith(withTabs('a', 'b'), key('b'), 'root', 'right', ids());

  it('shows the whole tree normally', () => {
    const layout = split();
    expect(displayRoot(layout, { zoomed: false, narrow: false })).toBe(layout.root);
  });

  it('shows only the focused group while zoomed or narrow', () => {
    const layout = split();
    const focused = findGroup(layout.root, layout.focused);
    expect(displayRoot(layout, { zoomed: true, narrow: false })).toBe(focused);
    expect(displayRoot(layout, { zoomed: false, narrow: true })).toBe(focused);
  });

  it('shows one group while no tab fills a restored shape', () => {
    const layout = parseSaved('grid', ids());
    expect(displayRoot(layout, { zoomed: false, narrow: false })).toBe(groups(layout.root)[0]);
  });
});

describe('saved layouts', () => {
  it.each([
    ['single', []],
    ['columns', { row: [[], []] }],
    ['rows', { column: [[], []] }],
    ['grid', { column: [{ row: [[], []] }, { row: [[], []] }] }],
  ])('converts the old value %s', (saved, expected) => {
    const layout = parseSaved(saved, ids());
    expect(shape(layout.root)).toEqual(expected);
    expect(findGroup(layout.root, layout.focused)).toBeDefined();
  });

  it('round-trips the shape and sizes but no tabs', () => {
    let layout = withTabs('a', 'b', 'c');
    const make = ids();
    layout = splitWith(layout, key('c'), 'root', 'right', make);
    layout = splitWith(layout, key('b'), 'root', 'bottom', make);
    const resized = resize(layout.root, { path: [], index: 0 }, 300, canvas);
    const restored = parseSaved(serialize(resized), make);
    expect(shape(restored.root)).toEqual({ row: [{ column: [[], []] }, []] });
    expect(rects(restored.root).map((r) => [r.w, r.h])).toEqual(
      rects(resized).map((r) => [r.w, r.h]),
    );
    expect(serialize(resized)).not.toContain('session');
  });

  it('gives restored groups new ids', () => {
    const layout = parseSaved('columns', ids());
    const restored = parseSaved(serialize(layout.root), ids());
    expect(new Set(groups(restored.root).map((g) => g.id)).size).toBe(2);
  });

  it('rescales saved sizes that do not add up to one', () => {
    const saved = JSON.stringify({
      v: 1,
      root: {
        type: 'split',
        dir: 'row',
        sizes: [1, 3],
        children: [{ type: 'group' }, { type: 'group' }],
      },
    });
    const { root } = parseSaved(saved, ids());
    expect(root.type === 'split' && root.sizes).toEqual([0.25, 0.75]);
  });

  const nested = (depth: number): unknown =>
    depth === 0
      ? { type: 'group' }
      : {
          type: 'split',
          dir: 'row',
          sizes: [1, 1],
          children: [nested(depth - 1), { type: 'group' }],
        };
  it.each<[string, string | null]>([
    ['nothing', null],
    ['an empty string', ''],
    ['an unknown name', 'cinema'],
    ['broken JSON', '{"v":1'],
    ['JSON null', 'null'],
    ['an unknown version', JSON.stringify({ v: 2, root: { type: 'group' } })],
    ['a missing root', JSON.stringify({ v: 1 })],
    ['an unknown node', JSON.stringify({ v: 1, root: { type: 'tab' } })],
    [
      'one child',
      JSON.stringify({
        v: 1,
        root: { type: 'split', dir: 'row', sizes: [1], children: [{ type: 'group' }] },
      }),
    ],
    [
      'sizes that do not match the children',
      JSON.stringify({
        v: 1,
        root: {
          type: 'split',
          dir: 'row',
          sizes: [1],
          children: [{ type: 'group' }, { type: 'group' }],
        },
      }),
    ],
    [
      'a negative size',
      JSON.stringify({
        v: 1,
        root: {
          type: 'split',
          dir: 'row',
          sizes: [-1, 2],
          children: [{ type: 'group' }, { type: 'group' }],
        },
      }),
    ],
    [
      'a text size',
      JSON.stringify({
        v: 1,
        root: {
          type: 'split',
          dir: 'row',
          sizes: ['1', 1],
          children: [{ type: 'group' }, { type: 'group' }],
        },
      }),
    ],
    [
      'an unknown direction',
      JSON.stringify({
        v: 1,
        root: {
          type: 'split',
          dir: 'grid',
          sizes: [1, 1],
          children: [{ type: 'group' }, { type: 'group' }],
        },
      }),
    ],
    ['a tree too deep', JSON.stringify({ v: 1, root: nested(20) })],
  ])('starts with one group for %s', (_, saved) => {
    const layout = parseSaved(saved, ids());
    expect(layout.root.type).toBe('group');
    expect(layout.focused).toBe(groups(layout.root)[0].id);
  });
});
