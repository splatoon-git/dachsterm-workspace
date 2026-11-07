import { programStateLabels, type ProgramSummary } from '../features/terminal/programStatus';

/**
 * The agent list (DX.8): the program state every tab reports, gathered in one place. Nothing here
 * reads the screen or asks a server; rows only repeat what the tabs already show.
 */
export type AgentState = ProgramSummary['state'];

/** What one tab reports. Each field is display text, a fixed state word, or a time. */
export type AgentReport = {
  name: string;
  state: AgentState;
  /** When the current state began, in milliseconds since the epoch. */
  since: number;
  /** Branch and change count as the status bar writes it (`main ●3`), or empty. */
  git: string;
  /** The tab's tooltip text: state, kind and the program's own words. */
  detail: string;
};

export type AgentRow = AgentReport & {
  /** `tab:<tabId>` for a tab in this window, `window:<label>` for an independent window. */
  key: string;
  /** The independent window to focus, when the tab lives in one. */
  window?: string;
};

/** The independent windows' reports reach the main window as this Tauri event. */
export const agentStatusEvent = 'agent-status';
export type AgentStatusMessage = { window: string; report: AgentReport | null };

const order: AgentState[] = ['blocked', 'error', 'working', 'done'];
const windowLabel = /^terminal-[A-Za-z0-9_-]{1,96}$/;
const limits = { name: 200, git: 200, detail: 400 };

export const tabRowKey = (tabId: string) => `tab:${tabId}`;

/** Waiting for input first, then errors, running work and finished work; older first within. */
export function sortRows(rows: readonly AgentRow[]) {
  return [...rows].sort(
    (a, b) =>
      order.indexOf(a.state) - order.indexOf(b.state) ||
      a.since - b.since ||
      a.key.localeCompare(b.key),
  );
}

/** The status bar text, such as `입력 대기 2 · 작업 중 1`. States with no tab are left out. */
export function boardCounts(rows: readonly AgentRow[]) {
  return order
    .map((state) => ({ state, count: rows.filter((row) => row.state === state).length }))
    .filter(({ count }) => count > 0)
    .map(({ state, count }) => ({ state, text: `${programStateLabels[state]} ${count}` }));
}

export function elapsedText(ms: number) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '1분 미만';
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours}시간 ${minutes % 60}분` : `${hours}시간`;
}

/** The waiting row after the current one in list order, wrapping around. Null when none waits. */
export function nextBlocked(rows: readonly AgentRow[], current?: string) {
  const blocked = rows.filter((row) => row.state === 'blocked');
  if (!blocked.length) return null;
  const at = blocked.findIndex((row) => row.key === current);
  return blocked[(at + 1) % blocked.length];
}

const text = (value: unknown, limit: number) =>
  typeof value === 'string' ? value.slice(0, limit) : null;

/**
 * Checks an event payload before it becomes a row. Only the app's own windows send it, but any
 * page in the app could emit the event name, so nothing is taken on trust.
 */
export function parseAgentStatus(payload: unknown): AgentStatusMessage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { window, report } = payload as Record<string, unknown>;
  if (typeof window !== 'string' || !windowLabel.test(window)) return null;
  if (report === null) return { window, report: null };
  if (typeof report !== 'object' || report === undefined) return null;
  const r = report as Record<string, unknown>;
  const name = text(r.name, limits.name);
  const git = text(r.git, limits.git);
  const detail = text(r.detail, limits.detail);
  const state = order.find((s) => s === r.state);
  const since = r.since;
  if (name === null || git === null || detail === null || !state) return null;
  if (typeof since !== 'number' || !Number.isFinite(since) || since <= 0) return null;
  return { window, report: { name, state, since, git, detail } };
}
