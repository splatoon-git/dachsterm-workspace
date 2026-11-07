import { rects, type Rect } from './workspaceGeometry';
import {
  EDGE_ZONE,
  findGroup,
  MIN_GROUP,
  moveTab,
  splitWith,
  TAB_BAR_HEIGHT,
  tabKey,
  type Layout,
  type LayoutNode,
  type MakeId,
  type Side,
  type Size,
} from './workspaceLayout';

export type TabEdge = { left: number; right: number };
export type DropTarget =
  | { zone: 'tabbar'; groupId: string; index: number }
  | { zone: 'center'; groupId: string }
  | { zone: Side; groupId: string }
  | { zone: 'outside' };
export type HitQuery = {
  /** Only the groups on screen: one group while zoomed or in a narrow window. */
  root: LayoutNode;
  /** Pointer position in pixels, relative to the workspace. */
  x: number;
  y: number;
  canvas: Size;
  /** The app window in the same coordinates. A pointer beyond it is outside the app. */
  viewport: { left: number; top: number; right: number; bottom: number };
  source: { groupId: string; key: string };
  /** Measured tab positions per group, in the same coordinates. */
  tabEdges: Record<string, TabEdge[]>;
  allowSplit: boolean;
};

const nearestEdge = (u: number, v: number): Side | null => {
  const edges: [Side, number][] = [
    ['left', u],
    ['right', 1 - u],
    ['top', v],
    ['bottom', 1 - v],
  ];
  edges.sort((a, b) => a[1] - b[1]);
  return edges[0][1] < EDGE_ZONE ? edges[0][0] : null;
};

/** Returns where a dropped tab would land, or null when dropping there would change nothing. */
export function hitTest(query: HitQuery): DropTarget | null {
  const { root, x, y, canvas, viewport, source, tabEdges } = query;
  if (x < viewport.left || x >= viewport.right || y < viewport.top || y >= viewport.bottom)
    return { zone: 'outside' };
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
  const hit = rects(root).find(
    (r) =>
      x >= r.x * canvas.width &&
      x < (r.x + r.w) * canvas.width &&
      y >= r.y * canvas.height &&
      y < (r.y + r.h) * canvas.height,
  );
  const group = hit && findGroup(root, hit.id);
  if (!hit || !group) return null;
  const own = group.id === source.groupId;
  const alone = own && group.tabs.length === 1;
  if (alone) return null;
  const width = hit.w * canvas.width;
  const height = hit.h * canvas.height;
  const left = hit.x * canvas.width;
  const top = hit.y * canvas.height;
  if (y < top + TAB_BAR_HEIGHT) {
    const edges = tabEdges[group.id] ?? [];
    const found = edges.findIndex((edge) => x < (edge.left + edge.right) / 2);
    const index = found < 0 ? edges.length : found;
    if (own) {
      const from = group.tabs.findIndex((tab) => tabKey(tab) === source.key);
      if (index === from || index === from + 1) return null;
    }
    return { zone: 'tabbar', groupId: group.id, index };
  }
  const center: DropTarget | null = own ? null : { zone: 'center', groupId: group.id };
  if (!query.allowSplit || !group.tabs.length) return center;
  const bodyHeight = Math.max(height - TAB_BAR_HEIGHT, 1);
  const edge = nearestEdge((x - left) / width, (y - top - TAB_BAR_HEIGHT) / bodyHeight);
  if (!edge) return center;
  const fits =
    edge === 'left' || edge === 'right'
      ? width / 2 >= MIN_GROUP.width
      : height / 2 >= MIN_GROUP.height;
  return fits ? { zone: edge, groupId: group.id } : center;
}

/** Fractions of the workspace to highlight. A tab bar target shows an insertion bar instead. */
export function dropPreviewRect(root: LayoutNode, target: DropTarget): Rect | null {
  if (target.zone === 'outside' || target.zone === 'tabbar') return null;
  const rect = rects(root).find((r) => r.id === target.groupId);
  if (!rect) return null;
  const half = { w: rect.w / 2, h: rect.h / 2 };
  switch (target.zone) {
    case 'left':
      return { x: rect.x, y: rect.y, w: half.w, h: rect.h };
    case 'right':
      return { x: rect.x + half.w, y: rect.y, w: half.w, h: rect.h };
    case 'top':
      return { x: rect.x, y: rect.y, w: rect.w, h: half.h };
    case 'bottom':
      return { x: rect.x, y: rect.y + half.h, w: rect.w, h: half.h };
    default:
      return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  }
}

/** Applies a drop. The caller handles 'outside', which leaves the layout for another window. */
export function applyDrop(
  layout: Layout,
  key: string,
  target: DropTarget,
  makeId?: MakeId,
): Layout {
  switch (target.zone) {
    case 'outside':
      return layout;
    case 'tabbar':
      return moveTab(layout, key, target.groupId, target.index);
    case 'center':
      return moveTab(layout, key, target.groupId);
    default:
      return splitWith(layout, key, target.groupId, target.zone, makeId);
  }
}
