import { groupings, type Grouping } from './tree';

const MAX_COLLAPSED = 2000;
const storageKey = (session: string) => `dachsterm.kube.tree.${session}`;

export type TreePrefs = { grouping: Grouping; collapsed: string[] };
export const defaultTreePrefs = (): TreePrefs => ({ grouping: 'workload', collapsed: [] });

/** Anything that is not exactly what `writeTreePrefs` stored falls back to the defaults. */
export function parseTreePrefs(text: string | null): TreePrefs {
  if (!text) return defaultTreePrefs();
  try {
    const value = JSON.parse(text) as Partial<TreePrefs> | null;
    const grouping = groupings.find((item) => item.id === value?.grouping)?.id;
    if (!grouping || !Array.isArray(value?.collapsed)) return defaultTreePrefs();
    return {
      grouping,
      collapsed: value.collapsed
        .filter((id): id is string => typeof id === 'string')
        .slice(0, MAX_COLLAPSED),
    };
  } catch {
    return defaultTreePrefs();
  }
}

/** A session with no saved profile has no id to file this under. */
export function readTreePrefs(session: string): TreePrefs {
  if (!session) return defaultTreePrefs();
  try {
    return parseTreePrefs(localStorage.getItem(storageKey(session)));
  } catch {
    return defaultTreePrefs();
  }
}

export function writeTreePrefs(session: string, prefs: TreePrefs) {
  if (!session) return;
  try {
    localStorage.setItem(
      storageKey(session),
      JSON.stringify({ ...prefs, collapsed: prefs.collapsed.slice(0, MAX_COLLAPSED) }),
    );
  } catch {
    // Folding is a convenience; a full or blocked store must not disturb the screen.
  }
}
