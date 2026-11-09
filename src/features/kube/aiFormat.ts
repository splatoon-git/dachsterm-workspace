import type { ScrapeStatus } from './aiTypes';

export const statusText: Record<ScrapeStatus, string> = {
  ok: '',
  forbidden: '권한 없음 (pods/proxy 또는 엔드포인트 인증)',
  unreachable: '조회 불가 (포트·경로·네트워크)',
  noSupported: '지원하는 메트릭 없음',
  invalidTarget: '허용되지 않는 메트릭 포트·경로',
};

/** `1234`, `12.3k`, `4.5M`. Unknown is `-`, never zero. */
export function formatCount(value: number | null) {
  if (value === null) return '-';
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatSeconds(value: number | null) {
  if (value === null) return '-';
  if (value < 10) return `${value.toFixed(2)}s`;
  if (value < 100) return `${value.toFixed(1)}s`;
  return `${Math.round(value)}s`;
}

export const formatPercent = (value: number | null) =>
  value === null ? '-' : `${Math.round(value)}%`;

/** `used/total` in GiB from MiB. */
export function formatMemory(used: number | null, total: number | null) {
  if (used === null || total === null || total <= 0) return '-';
  const gib = (mib: number) => (mib / 1024).toFixed(mib >= 102400 ? 0 : 1);
  return `${gib(used)}/${gib(total)}G`;
}

export const formatPlain = (value: number | null, unit: string) =>
  value === null ? '-' : `${Math.round(value)}${unit}`;
