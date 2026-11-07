import {
  MIN_GROUP,
  type LayoutNode,
  type Side,
  type Size,
  type SplitNode,
} from './workspaceLayout';

export type Rect = { x: number; y: number; w: number; h: number };
export type GroupRect = Rect & { id: string };
export type Divider = {
  /** Child indexes from the root down to the split that owns this divider. */
  path: number[];
  /** The divider sits between children `index` and `index + 1`. */
  index: number;
  dir: SplitNode['dir'];
  /** Position and length as a fraction of the whole workspace. */
  x: number;
  y: number;
  length: number;
};

const EPSILON = 1e-6;
const WHOLE: Rect = { x: 0, y: 0, w: 1, h: 1 };

function childBox(node: SplitNode, box: Rect, index: number): Rect {
  const before = node.sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
  const size = node.sizes[index];
  return node.dir === 'row'
    ? { x: box.x + box.w * before, y: box.y, w: box.w * size, h: box.h }
    : { x: box.x, y: box.y + box.h * before, w: box.w, h: box.h * size };
}

/** Fractions of the workspace for each group, in tree order. */
export function rects(node: LayoutNode, box: Rect = WHOLE): GroupRect[] {
  if (node.type === 'group') return [{ id: node.id, ...box }];
  return node.children.flatMap((child, i) => rects(child, childBox(node, box, i)));
}

export function dividers(node: LayoutNode, box: Rect = WHOLE, path: number[] = []): Divider[] {
  if (node.type === 'group') return [];
  return node.children.flatMap((child, i) => {
    const part = childBox(node, box, i);
    const nested = dividers(child, part, [...path, i]);
    if (i === node.children.length - 1) return nested;
    const divider: Divider =
      node.dir === 'row'
        ? { path, index: i, dir: 'row', x: part.x + part.w, y: part.y, length: part.h }
        : { path, index: i, dir: 'column', x: part.x, y: part.y + part.h, length: part.w };
    return [...nested, divider];
  });
}

function minSize(node: LayoutNode): Size {
  if (node.type === 'group') return MIN_GROUP;
  const sizes = node.children.map(minSize);
  const total = (pick: (size: Size) => number) => sizes.reduce((sum, s) => sum + pick(s), 0);
  const largest = (pick: (size: Size) => number) => Math.max(...sizes.map(pick));
  return node.dir === 'row'
    ? { width: total((s) => s.width), height: largest((s) => s.height) }
    : { width: largest((s) => s.width), height: total((s) => s.height) };
}

function splitAt(root: LayoutNode, path: number[]): { node: SplitNode; box: Rect } | null {
  let node = root;
  let box = WHOLE;
  for (const index of path) {
    if (node.type !== 'split' || !node.children[index]) return null;
    box = childBox(node, box, index);
    node = node.children[index];
  }
  return node.type === 'split' ? { node, box } : null;
}

function replaceSplit(node: LayoutNode, path: number[], next: SplitNode): LayoutNode {
  if (!path.length) return next;
  if (node.type !== 'split') return node;
  const [head, ...rest] = path;
  return {
    ...node,
    children: node.children.map((child, i) =>
      i === head ? replaceSplit(child, rest, next) : child,
    ),
  };
}

/** Pixel size and limits of the child before a divider, for the handle's value and range. */
export function dividerRange(
  root: LayoutNode,
  divider: Pick<Divider, 'path' | 'index'>,
  canvas: Size,
) {
  const found = splitAt(root, divider.path);
  if (!found) return null;
  const { node, box } = found;
  const row = node.dir === 'row';
  const span = row ? box.w * canvas.width : box.h * canvas.height;
  const pair = (node.sizes[divider.index] + node.sizes[divider.index + 1]) * span;
  const measure = (child: LayoutNode) => (row ? minSize(child).width : minSize(child).height);
  const min = measure(node.children[divider.index]);
  const max = pair - measure(node.children[divider.index + 1]);
  return { value: node.sizes[divider.index] * span, min, max, span, pair };
}

/** Sets the size of the child before a divider. Only its neighbour gives up or takes the space. */
export function resize(
  root: LayoutNode,
  divider: Pick<Divider, 'path' | 'index'>,
  px: number,
  canvas: Size,
): LayoutNode {
  const found = splitAt(root, divider.path);
  const range = dividerRange(root, divider, canvas);
  if (!found || !range || range.span <= 0 || range.max < range.min) return root;
  const value = Math.max(range.min, Math.min(range.max, px));
  const { node } = found;
  const sizes = [...node.sizes];
  sizes[divider.index] = value / range.span;
  sizes[divider.index + 1] = (range.pair - value) / range.span;
  if (sizes.every((size, i) => Math.abs(size - node.sizes[i]) < EPSILON)) return root;
  return replaceSplit(root, divider.path, { ...node, sizes });
}

export function equalize(root: LayoutNode, path: number[]): LayoutNode {
  const found = splitAt(root, path);
  if (!found) return root;
  const { node } = found;
  const sizes = node.children.map(() => 1 / node.children.length);
  return replaceSplit(root, path, { ...node, sizes });
}

/** Geometric neighbour used by the focus shortcut. */
export function adjacentGroup(root: LayoutNode, fromId: string, direction: Side) {
  const list = rects(root);
  const from = list.find((rect) => rect.id === fromId);
  if (!from) return undefined;
  const horizontal = direction === 'left' || direction === 'right';
  const scored = list.flatMap((rect) => {
    if (rect.id === fromId) return [];
    const gap = {
      left: from.x - (rect.x + rect.w),
      right: rect.x - (from.x + from.w),
      top: from.y - (rect.y + rect.h),
      bottom: rect.y - (from.y + from.h),
    }[direction];
    const overlap = horizontal
      ? Math.min(from.y + from.h, rect.y + rect.h) - Math.max(from.y, rect.y)
      : Math.min(from.x + from.w, rect.x + rect.w) - Math.max(from.x, rect.x);
    return gap > -EPSILON && overlap > EPSILON ? [{ id: rect.id, gap, overlap }] : [];
  });
  scored.sort((a, b) => a.gap - b.gap || b.overlap - a.overlap);
  return scored[0]?.id;
}
