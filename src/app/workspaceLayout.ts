import type { GameId } from '../features/games/catalog';

/**
 * Pure layout operations for the workspace. Every function returns a new value and leaves its input
 * untouched. Unchanged calls return the same object, so callers can skip saving and rendering.
 */
export type TabRef =
  { kind: 'session'; tabId: string } | { kind: 'game'; id: GameId } | { kind: 'preview' };
export type GroupNode = {
  type: 'group';
  id: string;
  tabs: TabRef[];
  /** Key of the shown tab, or '' when the group shows nothing. */
  active: string;
  /** Key of the tab shown before this one, so leaving a game returns to the previous work. */
  previous?: string;
};
export type SplitNode = {
  type: 'split';
  dir: 'row' | 'column';
  sizes: number[];
  children: LayoutNode[];
};
export type LayoutNode = GroupNode | SplitNode;
export type Layout = { root: LayoutNode; focused: string };
export type Preset = 'single' | 'columns' | 'rows' | 'grid';
export type Side = 'left' | 'right' | 'top' | 'bottom';
export type Size = { width: number; height: number };
export type MakeId = () => string;

export const TAB_BAR_HEIGHT = 34;
export const MIN_GROUP: Size = { width: 240, height: 120 };
export const EDGE_ZONE = 0.25;
const MAX_SAVED_DEPTH = 8;
const MAX_SAVED_GROUPS = 64;

const defaultId: MakeId = () => crypto.randomUUID();
const emptyGroup = (id: string): GroupNode => ({ type: 'group', id, tabs: [], active: '' });

export const tabKey = (tab: TabRef) =>
  tab.kind === 'session'
    ? `session:${tab.tabId}`
    : tab.kind === 'game'
      ? `game:${tab.id}`
      : 'preview';

export function groups(node: LayoutNode): GroupNode[] {
  return node.type === 'group' ? [node] : node.children.flatMap(groups);
}
export const findGroup = (root: LayoutNode, id: string) => groups(root).find((g) => g.id === id);
export const groupOfTab = (root: LayoutNode, key: string) =>
  groups(root).find((g) => g.tabs.some((tab) => tabKey(tab) === key));
export const allTabs = (root: LayoutNode) => groups(root).flatMap((g) => g.tabs);
export const singleGroupLayout = (makeId: MakeId = defaultId): Layout => {
  const id = makeId();
  return { root: emptyGroup(id), focused: id };
};

function replaceGroup(
  node: LayoutNode,
  id: string,
  update: (group: GroupNode) => LayoutNode,
): LayoutNode {
  if (node.type === 'group') return node.id === id ? update(node) : node;
  let changed = false;
  const children = node.children.map((child) => {
    const next = replaceGroup(child, id, update);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

const withActive = (group: GroupNode, key: string): GroupNode =>
  group.active === key ? group : { ...group, active: key, previous: group.active || undefined };

/** Drops a group, closes the splits left with one child and merges same-direction nesting. */
function removeNode(node: LayoutNode, id: string): LayoutNode | null {
  if (node.type === 'group') return node.id === id ? null : node;
  const kept = node.children
    .map((child, index) => ({ child: removeNode(child, id), size: node.sizes[index] }))
    .filter((item): item is { child: LayoutNode; size: number } => item.child !== null);
  if (kept.length === node.children.length && kept.every((k, i) => k.child === node.children[i]))
    return node;
  if (!kept.length) return null;
  if (kept.length === 1) return kept[0].child;
  const total = kept.reduce((sum, item) => sum + item.size, 0);
  const sizes: number[] = [];
  const children: LayoutNode[] = [];
  for (const { child, size } of kept) {
    if (child.type === 'split' && child.dir === node.dir) {
      child.children.forEach((nested, i) => {
        children.push(nested);
        sizes.push((size / total) * child.sizes[i]);
      });
    } else {
      children.push(child);
      sizes.push(size / total);
    }
  }
  return { ...node, sizes, children };
}

function nearestGroup(root: LayoutNode, id: string) {
  const list = groups(root);
  const index = list.findIndex((g) => g.id === id);
  return list[index + 1] ?? list[index - 1];
}

function withoutTab(group: GroupNode, key: string): GroupNode {
  const index = group.tabs.findIndex((tab) => tabKey(tab) === key);
  const tabs = group.tabs.filter((tab) => tabKey(tab) !== key);
  if (group.active !== key) return { ...group, tabs };
  const earlier = tabs.find((tab) => tabKey(tab) === group.previous);
  const next = earlier ?? tabs[Math.min(index, tabs.length - 1)];
  return { ...group, tabs, active: next ? tabKey(next) : '', previous: undefined };
}

/** Takes the tab out of its group. A group left empty disappears unless it is the last one. */
function detachTab(layout: Layout, group: GroupNode, key: string): Layout {
  const next = withoutTab(group, key);
  if (next.tabs.length || groups(layout.root).length === 1)
    return { ...layout, root: replaceGroup(layout.root, group.id, () => next) };
  const focused =
    layout.focused === group.id ? nearestGroup(layout.root, group.id).id : layout.focused;
  return { root: removeNode(layout.root, group.id)!, focused };
}

export function selectTab(layout: Layout, groupId: string, key: string): Layout {
  const group = findGroup(layout.root, groupId);
  if (!group || !group.tabs.some((tab) => tabKey(tab) === key)) return layout;
  if (group.active === key && layout.focused === groupId) return layout;
  return { root: replaceGroup(layout.root, groupId, (g) => withActive(g, key)), focused: groupId };
}

export const focusGroup = (layout: Layout, groupId: string): Layout =>
  layout.focused === groupId || !findGroup(layout.root, groupId)
    ? layout
    : { ...layout, focused: groupId };

/** Empty groups fill first, so a restored shape fills from the front. Otherwise the focused group. */
export function openTab(layout: Layout, tab: TabRef): Layout {
  const key = tabKey(tab);
  const existing = groupOfTab(layout.root, key);
  if (existing) return selectTab(layout, existing.id, key);
  const list = groups(layout.root);
  const target = list.find((g) => !g.tabs.length) ?? findGroup(layout.root, layout.focused)!;
  return {
    root: replaceGroup(layout.root, target.id, (g) => ({
      ...withActive(g, key),
      tabs: [...g.tabs, tab],
    })),
    focused: target.id,
  };
}

export function closeTab(layout: Layout, key: string): Layout {
  const group = groupOfTab(layout.root, key);
  return group ? detachTab(layout, group, key) : layout;
}

export function closeEmptyGroup(layout: Layout, groupId: string): Layout {
  const group = findGroup(layout.root, groupId);
  if (!group || group.tabs.length || groups(layout.root).length === 1) return layout;
  const focused =
    layout.focused === groupId ? nearestGroup(layout.root, groupId).id : layout.focused;
  return { root: removeNode(layout.root, groupId)!, focused };
}

/** Moves off a game tab to the previous work tab, or to nothing when the group holds only games. */
export function leaveTab(layout: Layout, groupId: string): Layout {
  const group = findGroup(layout.root, groupId);
  if (!group) return layout;
  const work = group.tabs.filter((tab) => tab.kind !== 'game');
  const previous = work.find((tab) => tabKey(tab) === group.previous);
  const index = group.tabs.findIndex((tab) => tabKey(tab) === group.active);
  const before = group.tabs.slice(0, Math.max(index, 0)).reverse();
  const nearest = before.find((tab) => tab.kind !== 'game') ?? work[0];
  const next = previous ?? nearest;
  return {
    root: replaceGroup(layout.root, groupId, (g) => withActive(g, next ? tabKey(next) : '')),
    focused: groupId,
  };
}

/**
 * Moves a tab to another position or group. `index` counts positions before the move, which is what
 * a pointer over a tab bar reports. Without an index the tab goes last.
 */
export function moveTab(layout: Layout, key: string, targetId: string, index?: number): Layout {
  const source = groupOfTab(layout.root, key);
  const target = findGroup(layout.root, targetId);
  if (!source || !target) return layout;
  const tab = source.tabs.find((item) => tabKey(item) === key)!;
  if (source.id === targetId) {
    const from = source.tabs.indexOf(tab);
    const raw = index ?? source.tabs.length;
    const to = raw > from ? raw - 1 : raw;
    const tabs = source.tabs.filter((item) => item !== tab);
    tabs.splice(to, 0, tab);
    const unchanged = to === from && source.active === key && layout.focused === targetId;
    if (unchanged) return layout;
    return {
      root: replaceGroup(layout.root, targetId, (g) => ({ ...withActive(g, key), tabs })),
      focused: targetId,
    };
  }
  const detached = detachTab(layout, source, key);
  return {
    root: replaceGroup(detached.root, targetId, (g) => {
      const tabs = [...g.tabs];
      tabs.splice(index ?? tabs.length, 0, tab);
      return { ...withActive(g, key), tabs };
    }),
    focused: targetId,
  };
}

const sideDir = (side: Side): SplitNode['dir'] =>
  side === 'left' || side === 'right' ? 'row' : 'column';
const sideFirst = (side: Side) => side === 'left' || side === 'top';

function insertBeside(
  node: LayoutNode,
  targetId: string,
  side: Side,
  created: GroupNode,
): LayoutNode {
  if (node.type === 'group') {
    if (node.id !== targetId) return node;
    return {
      type: 'split',
      dir: sideDir(side),
      sizes: [0.5, 0.5],
      children: sideFirst(side) ? [created, node] : [node, created],
    };
  }
  const index = node.children.findIndex((c) => c.type === 'group' && c.id === targetId);
  if (index >= 0 && node.dir === sideDir(side)) {
    const half = node.sizes[index] / 2;
    const at = sideFirst(side) ? index : index + 1;
    const sizes = node.sizes.map((size, i) => (i === index ? half : size));
    const children = [...node.children];
    sizes.splice(at, 0, half);
    children.splice(at, 0, created);
    return { ...node, sizes, children };
  }
  return {
    ...node,
    children: node.children.map((child) => insertBeside(child, targetId, side, created)),
  };
}

/** Puts a tab in a new group beside the target. A group's only tab cannot split its own group. */
export function splitWith(
  layout: Layout,
  key: string,
  targetId: string,
  side: Side,
  makeId: MakeId = defaultId,
): Layout {
  const source = groupOfTab(layout.root, key);
  const target = findGroup(layout.root, targetId);
  if (!source || !target) return layout;
  if (source.id === targetId && source.tabs.length === 1) return layout;
  if (!target.tabs.length) return moveTab(layout, key, targetId);
  const tab = source.tabs.find((item) => tabKey(item) === key)!;
  const created: GroupNode = { type: 'group', id: makeId(), tabs: [tab], active: key };
  const inserted = insertBeside(layout.root, targetId, side, created);
  const detached = detachTab({ ...layout, root: inserted }, findGroup(inserted, source.id)!, key);
  return { root: detached.root, focused: created.id };
}

const presetShape = (preset: Preset, makeId: MakeId): LayoutNode => {
  const leaf = () => emptyGroup(makeId());
  const pair = (dir: SplitNode['dir'], a: LayoutNode, b: LayoutNode): SplitNode => ({
    type: 'split',
    dir,
    sizes: [0.5, 0.5],
    children: [a, b],
  });
  if (preset === 'columns') return pair('row', leaf(), leaf());
  if (preset === 'rows') return pair('column', leaf(), leaf());
  if (preset === 'grid')
    return pair('column', pair('row', leaf(), leaf()), pair('row', leaf(), leaf()));
  return leaf();
};

/** Rebuilds the tree and deals every tab out in order, keeping the focused tab on screen. */
export function applyPreset(layout: Layout, preset: Preset, makeId: MakeId = defaultId): Layout {
  const tabs = allTabs(layout.root);
  const focusedKey = findGroup(layout.root, layout.focused)?.active ?? '';
  const shape = presetShape(preset, makeId);
  const slots = groups(shape);
  let root = shape;
  let focused = slots[0].id;
  slots.forEach((slot, i) => {
    const dealt = tabs.filter((_, index) => index % slots.length === i);
    const holdsFocus = dealt.some((tab) => tabKey(tab) === focusedKey);
    if (holdsFocus) focused = slot.id;
    const active = holdsFocus ? focusedKey : dealt[0] ? tabKey(dealt[0]) : '';
    root = replaceGroup(root, slot.id, (g) => ({ ...g, tabs: dealt, active }));
  });
  return { root, focused };
}

/** What a restart restores: the shape and sizes, since no tab survives one. */
export function serialize(root: LayoutNode): string {
  const shape = (node: LayoutNode): unknown =>
    node.type === 'group'
      ? { type: 'group' }
      : {
          type: 'split',
          dir: node.dir,
          sizes: node.sizes.map((size) => Math.round(size * 10000) / 10000),
          children: node.children.map(shape),
        };
  return JSON.stringify({ v: 1, root: shape(root) });
}

function readShape(value: unknown, depth: number, makeId: MakeId): LayoutNode {
  if (depth > MAX_SAVED_DEPTH || !value || typeof value !== 'object') throw new Error('shape');
  const { type, dir, sizes, children } = value as Record<string, unknown>;
  if (type === 'group') return emptyGroup(makeId());
  if (type !== 'split' || (dir !== 'row' && dir !== 'column')) throw new Error('shape');
  if (!Array.isArray(sizes) || !Array.isArray(children)) throw new Error('shape');
  if (children.length < 2 || sizes.length !== children.length) throw new Error('shape');
  if (!sizes.every((size) => typeof size === 'number' && Number.isFinite(size) && size > 0))
    throw new Error('shape');
  const total: number = sizes.reduce((sum: number, size: number) => sum + size, 0);
  return {
    type: 'split',
    dir,
    sizes: sizes.map((size: number) => size / total),
    children: children.map((child) => readShape(child, depth + 1, makeId)),
  };
}

/** Accepts the current format and the old layout names. Anything else starts with one group. */
export function parseSaved(saved: string | null, makeId: MakeId = defaultId): Layout {
  if (saved === 'single' || saved === 'columns' || saved === 'rows' || saved === 'grid') {
    const root = presetShape(saved, makeId);
    return { root, focused: groups(root)[0].id };
  }
  if (saved) {
    try {
      const parsed = JSON.parse(saved) as { v?: unknown; root?: unknown };
      if (parsed?.v === 1) {
        const root = readShape(parsed.root, 0, makeId);
        if (groups(root).length <= MAX_SAVED_GROUPS) return { root, focused: groups(root)[0].id };
      }
    } catch {
      // A damaged preference is not user data: starting with one group loses only the arrangement.
    }
  }
  return singleGroupLayout(makeId);
}
