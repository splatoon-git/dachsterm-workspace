import type { Health } from './treePods';

export const statusMark: Record<Health, string> = { ok: '●', warn: '▲', error: '✕' };

/** The first and one-past-last row to render, with a margin so fast scrolling shows no gap. */
export function visibleRange(
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  count: number,
  overscan = 10,
) {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return { first, last: Math.max(first, last) };
}

export function formatCpu(millis: number) {
  if (millis < 1000) return `${millis}m`;
  return `${(millis / 1000).toFixed(millis % 1000 ? 2 : 0)}`;
}

export function formatMemory(bytes: number) {
  const units: [number, string][] = [
    [2 ** 40, 'Ti'],
    [2 ** 30, 'Gi'],
    [2 ** 20, 'Mi'],
    [2 ** 10, 'Ki'],
  ];
  for (const [size, unit] of units)
    if (bytes >= size) return `${(bytes / size).toFixed(bytes / size < 10 ? 1 : 0)}${unit}`;
  return `${bytes}B`;
}

export function formatAge(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** Live use when the cluster reports it, otherwise the requested and limited amounts. */
export function resourceCell(
  use: number | null,
  request: number | null,
  limit: number | null,
  format: (value: number) => string,
  metrics: boolean,
) {
  const text = (value: number | null) => (value === null ? '-' : format(value));
  const title = `요청 ${text(request)} · 제한 ${text(limit)}`;
  return { text: metrics ? text(use) : `${text(request)} / ${text(limit)}`, title };
}

/** A node's use against what it can give; the use is unknown without metrics-server. */
export function usedOfTotal(
  use: number | null,
  total: number | null,
  format: (value: number) => string,
) {
  const text = (value: number | null) => (value === null ? '-' : format(value));
  return { text: `${text(use)} / ${text(total)}`, title: '사용량 / 할당 가능량' };
}
