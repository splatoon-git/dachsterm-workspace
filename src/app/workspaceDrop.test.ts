import { describe, expect, it } from 'vitest';
import {
  applyDrop,
  dropPreviewRect,
  hitTest,
  type DropTarget,
  type HitQuery,
} from './workspaceDrop';
import { rects } from './workspaceGeometry';
import {
  applyPreset,
  groups,
  openTab,
  singleGroupLayout,
  splitWith,
  tabKey,
  type Layout,
  type LayoutNode,
  type TabRef,
} from './workspaceLayout';

const session = (tabId: string): TabRef => ({ kind: 'session', tabId });
const key = (tabId: string) => tabKey(session(tabId));
const ids = () => {
  let next = 0;
  return () => `g${next++}`;
};
function withTabs(...names: string[]): Layout {
  return names.reduce(
    (layout, name) => openTab(layout, session(name)),
    singleGroupLayout(() => 'root'),
  );
}
/** left: tabs a, b. right: tab c. Each half is 500 × 800. */
function twoGroups() {
  const make = ids();
  const layout = splitWith(withTabs('a', 'b', 'c'), key('c'), 'root', 'right', make);
  const [left, right] = groups(layout.root);
  return { layout, left: left.id, right: right.id };
}
const canvas = { width: 1000, height: 800 };
const viewport = { left: -300, top: -100, right: 1000, bottom: 830 };
function query(root: LayoutNode, x: number, y: number, extra: Partial<HitQuery> = {}): HitQuery {
  return {
    root,
    x,
    y,
    canvas,
    viewport,
    source: { groupId: 'root', key: key('a') },
    tabEdges: {},
    allowSplit: true,
    ...extra,
  };
}

describe('hit testing the drop zones', () => {
  const { layout, left, right } = twoGroups();
  const fromLeft = { source: { groupId: left, key: key('a') } };
  const body = (u: number, v: number) => ({ x: 500 + u * 500, y: 34 + v * 766 });

  it.each([
    ['left', 0.1, 0.5],
    ['right', 0.9, 0.5],
    ['top', 0.5, 0.1],
    ['bottom', 0.5, 0.9],
  ] as const)('reports the %s edge of another group', (zone, u, v) => {
    const { x, y } = body(u, v);
    expect(hitTest(query(layout.root, x, y, fromLeft))).toEqual({ zone, groupId: right });
  });

  it('reports the middle of another group as a merge', () => {
    const { x, y } = body(0.5, 0.5);
    expect(hitTest(query(layout.root, x, y, fromLeft))).toEqual({ zone: 'center', groupId: right });
  });

  it('treats the outer quarter as an edge and the rest as the middle', () => {
    const just = body(0.24, 0.5);
    const past = body(0.26, 0.5);
    expect(hitTest(query(layout.root, just.x, just.y, fromLeft))?.zone).toBe('left');
    expect(hitTest(query(layout.root, past.x, past.y, fromLeft))?.zone).toBe('center');
  });

  it('picks the closer edge in a corner', () => {
    const { x, y } = body(0.05, 0.2);
    expect(hitTest(query(layout.root, x, y, fromLeft))?.zone).toBe('left');
  });

  it('reports a position in a tab bar from the tab centres', () => {
    const tabEdges = {
      [right]: [
        { left: 500, right: 600 },
        { left: 600, right: 700 },
      ],
    };
    const at = (x: number) => hitTest(query(layout.root, x, 10, { ...fromLeft, tabEdges }));
    expect(at(520)).toEqual({ zone: 'tabbar', groupId: right, index: 0 });
    expect(at(580)).toEqual({ zone: 'tabbar', groupId: right, index: 1 });
    expect(at(680)).toEqual({ zone: 'tabbar', groupId: right, index: 2 });
    expect(at(900)).toEqual({ zone: 'tabbar', groupId: right, index: 2 });
  });

  it('reports a pointer beyond the window as outside', () => {
    for (const [x, y] of [
      [-301, 100],
      [1000, 100],
      [100, -101],
      [100, 830],
    ])
      expect(hitTest(query(layout.root, x, y, fromLeft))).toEqual({ zone: 'outside' });
  });

  it('ignores the app outside the workspace', () => {
    expect(hitTest(query(layout.root, -10, 100, fromLeft))).toBeNull();
    expect(hitTest(query(layout.root, 100, 810, fromLeft))).toBeNull();
  });
});

describe('drops that change nothing', () => {
  const { layout, left, right } = twoGroups();

  it('refuses every zone of a group holding only the dragged tab', () => {
    const source = { groupId: right, key: key('c') };
    for (const [x, y] of [
      [750, 10],
      [750, 400],
      [510, 400],
      [990, 400],
      [750, 60],
      [750, 790],
    ])
      expect(hitTest(query(layout.root, x, y, { source }))).toBeNull();
  });

  it('allows a group to split with one of several tabs but not merge into itself', () => {
    const source = { groupId: left, key: key('a') };
    expect(hitTest(query(layout.root, 250, 400, { source }))).toBeNull();
    expect(hitTest(query(layout.root, 10, 400, { source }))).toEqual({
      zone: 'left',
      groupId: left,
    });
  });

  it('refuses to reorder a tab onto its own position', () => {
    const source = { groupId: left, key: key('a') };
    const tabEdges = {
      [left]: [
        { left: 0, right: 100 },
        { left: 100, right: 200 },
      ],
    };
    const at = (x: number) => hitTest(query(layout.root, x, 10, { source, tabEdges }));
    expect(at(20)).toBeNull();
    expect(at(120)).toBeNull();
    expect(at(180)).toEqual({ zone: 'tabbar', groupId: left, index: 2 });
  });
});

describe('minimum sizes and limited drops', () => {
  it('turns an edge into a merge when a half would be too narrow', () => {
    const { layout, left, right } = twoGroups();
    const small = { width: 800, height: 800 };
    const source = { groupId: left, key: key('a') };
    const hit = hitTest(query(layout.root, 420, 400, { canvas: small, source }));
    expect(hit).toEqual({ zone: 'center', groupId: right });
  });

  it('turns an edge into a merge when a half would be too short', () => {
    const { layout, left, right } = twoGroups();
    const small = { width: 1000, height: 200 };
    const source = { groupId: left, key: key('a') };
    const hit = hitTest(query(layout.root, 750, 190, { canvas: small, source }));
    expect(hit).toEqual({ zone: 'center', groupId: right });
  });

  it('keeps an edge that leaves exactly the minimum', () => {
    const { layout, left, right } = twoGroups();
    const exact = { width: 960, height: 240 };
    const source = { groupId: left, key: key('a') };
    expect(hitTest(query(layout.root, 950, 120, { canvas: exact, source }))).toEqual({
      zone: 'right',
      groupId: right,
    });
    expect(hitTest(query(layout.root, 720, 235, { canvas: exact, source }))).toEqual({
      zone: 'bottom',
      groupId: right,
    });
  });

  it('does nothing inside its own group when an edge shrinks to the middle', () => {
    const layout = withTabs('a', 'b');
    const small = { width: 400, height: 800 };
    const source = { groupId: 'root', key: key('a') };
    expect(hitTest(query(layout.root, 10, 400, { canvas: small, source }))).toBeNull();
  });

  it('only merges when splitting is off', () => {
    const { layout, left, right } = twoGroups();
    const source = { groupId: left, key: key('a') };
    expect(hitTest(query(layout.root, 990, 400, { allowSplit: false, source }))).toEqual({
      zone: 'center',
      groupId: right,
    });
  });

  it('merges into an empty group from any position', () => {
    const empty = applyPreset(withTabs('a', 'b'), 'grid', ids());
    const groupsList = groups(empty.root);
    const source = { groupId: groupsList[0].id, key: key('a') };
    const hit = hitTest(query(empty.root, 10, 700, { source }));
    expect(hit).toEqual({ zone: 'center', groupId: groupsList[2].id });
  });
});

describe('the drop preview', () => {
  const { layout, right } = twoGroups();
  const preview = (target: DropTarget) => dropPreviewRect(layout.root, target);

  it('highlights half of the group for an edge', () => {
    expect(preview({ zone: 'left', groupId: right })).toEqual({ x: 0.5, y: 0, w: 0.25, h: 1 });
    expect(preview({ zone: 'right', groupId: right })).toEqual({ x: 0.75, y: 0, w: 0.25, h: 1 });
    expect(preview({ zone: 'top', groupId: right })).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(preview({ zone: 'bottom', groupId: right })).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it('highlights the whole group for a merge', () => {
    expect(preview({ zone: 'center', groupId: right })).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it('draws no area for a tab bar, outside or an unknown group', () => {
    expect(preview({ zone: 'tabbar', groupId: right, index: 0 })).toBeNull();
    expect(preview({ zone: 'outside' })).toBeNull();
    expect(preview({ zone: 'center', groupId: 'missing' })).toBeNull();
  });
});

describe('applying a drop', () => {
  it('moves, merges and splits according to the zone', () => {
    const { layout, left, right } = twoGroups();
    const tabs = (next: Layout) => groups(next.root).map((g) => g.tabs.map(tabKey));
    expect(tabs(applyDrop(layout, key('a'), { zone: 'center', groupId: right }))).toEqual([
      [key('b')],
      [key('c'), key('a')],
    ]);
    expect(tabs(applyDrop(layout, key('a'), { zone: 'tabbar', groupId: right, index: 0 }))).toEqual(
      [[key('b')], [key('a'), key('c')]],
    );
    expect(tabs(applyDrop(layout, key('b'), { zone: 'tabbar', groupId: left, index: 0 }))).toEqual([
      [key('b'), key('a')],
      [key('c')],
    ]);
    const split = applyDrop(layout, key('a'), { zone: 'right', groupId: right }, () => 'new');
    expect(tabs(split)).toEqual([[key('b')], [key('c')], [key('a')]]);
    expect(rects(split.root).map((r) => r.w)).toEqual([0.5, 0.25, 0.25]);
  });

  it('leaves the layout alone for a drop outside the app', () => {
    const { layout } = twoGroups();
    expect(applyDrop(layout, key('a'), { zone: 'outside' })).toBe(layout);
  });
});
