/** How large a preview is drawn: to the width of its pane, or at a chosen scale (1 is 100%). */
export type Zoom = { kind: 'fit' } | { kind: 'scale'; value: number };

export const zoomSteps = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4] as const;
const smallest = zoomSteps[0];
const largest = zoomSteps[zoomSteps.length - 1];

/** The next step up or down from any scale, including one that fitting the width produced. */
export function steppedZoom(current: number, direction: 1 | -1) {
  // A fitted scale can sit a hair from a step, and that must not count as a step of its own.
  const near = 0.005;
  if (direction > 0) return zoomSteps.find((step) => step > current + near) ?? largest;
  return [...zoomSteps].reverse().find((step) => step < current - near) ?? smallest;
}

/** The scale that makes `width` fill `room`, kept inside what the steps allow. */
export function fittedScale(room: number, width: number) {
  if (!(room > 0) || !(width > 0)) return 1;
  return Math.min(largest, Math.max(smallest, room / width));
}

export const scaleOf = (zoom: Zoom, fitted: number) => (zoom.kind === 'fit' ? fitted : zoom.value);

export const percent = (scale: number) => `${Math.round(scale * 100)}%`;
