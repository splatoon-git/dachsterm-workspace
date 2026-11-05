import { VIEW, WORLD } from './content';
import type { Point, SurvivorRun } from './types';

export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
export const distanceSquared = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export function survivorCamera(run: SurvivorRun): Point {
  return {
    x: clamp(run.player.x - VIEW.width / 2, 0, WORLD.width - VIEW.width),
    y: clamp(run.player.y - VIEW.height / 2, 0, WORLD.height - VIEW.height),
  };
}
export function segmentHitsCircle(from: Point, to: Point, center: Point, radius: number): boolean {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = dx * dx + dy * dy;
  const t = length
    ? clamp(((center.x - from.x) * dx + (center.y - from.y) * dy) / length, 0, 1)
    : 0;
  return (from.x + t * dx - center.x) ** 2 + (from.y + t * dy - center.y) ** 2 <= radius ** 2;
}
