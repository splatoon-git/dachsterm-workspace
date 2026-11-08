export type MenuPoint = { x: number; y: number };
export type MenuSize = { width: number; height: number };

const MARGIN = 4;

/**
 * Places a menu at the pointer, flipping to the other side of the pointer when it would leave the
 * viewport. A menu bigger than the viewport keeps its top-left corner on screen.
 */
export function placeMenu(at: MenuPoint, size: MenuSize, viewport: MenuSize): MenuPoint {
  const axis = (start: number, extent: number, limit: number) => {
    if (start + extent <= limit - MARGIN) return start;
    const flipped = start - extent;
    if (flipped >= MARGIN) return flipped;
    return Math.max(MARGIN, limit - MARGIN - extent);
  };
  return {
    x: axis(at.x, size.width, viewport.width),
    y: axis(at.y, size.height, viewport.height),
  };
}

/** Centered under an element, or above it when the window has no room below. */
export function placeTip(
  element: { left: number; right: number; top: number; bottom: number },
  size: MenuSize,
  viewport: MenuSize,
): MenuPoint {
  const gap = 4;
  const centered = (element.left + element.right - size.width) / 2;
  const below = element.bottom + gap;
  return {
    x: Math.max(MARGIN, Math.min(centered, viewport.width - MARGIN - size.width)),
    y:
      below + size.height <= viewport.height - MARGIN
        ? below
        : Math.max(MARGIN, element.top - gap - size.height),
  };
}

/** The next enabled item for a navigation key, wrapping around. -1 when nothing is enabled. */
export function nextEnabled(disabled: boolean[], current: number, key: string): number {
  const count = disabled.length;
  const enabled = (i: number) => !disabled[i];
  if (!disabled.some((d) => !d)) return -1;
  if (key === 'Home') return disabled.findIndex((d) => !d);
  if (key === 'End') return count - 1 - [...disabled].reverse().findIndex((d) => !d);
  const step = key === 'ArrowUp' ? -1 : 1;
  let index = current;
  for (let i = 0; i < count; i++) {
    index = (index + step + count) % count;
    if (enabled(index)) return index;
  }
  return current;
}
