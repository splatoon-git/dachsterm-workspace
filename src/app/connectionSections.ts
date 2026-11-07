import { matchesSession } from '../features/sessions/model';
import type { Group, Profile } from '../lib/ipc';

/** A group as a folder: its own subgroups and the connections saved directly in it. */
export type TreeFolder = { group: Group; folders: TreeFolder[]; profiles: Profile[] };
export type ConnectionSections = {
  /** Every matching connection once, for the flat list a search shows. */
  matches: Profile[];
  favorites: Profile[];
  recent: Profile[];
  /** Saved connections by group, with ungrouped ones at the top level. */
  folders: TreeFolder[];
  profiles: Profile[];
};

/** How many recent connections the sidebar lists. The rest are a search away. */
export const RECENT_LIMIT = 5;

const byOrder = (
  a: { sortOrder?: number; name: string },
  b: { sortOrder?: number; name: string },
) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name);

const hasProfiles = (folder: TreeFolder): boolean =>
  folder.profiles.length > 0 || folder.folders.some(hasProfiles);

/**
 * The sections of the connection tree. A search keeps only matching connections and the folders
 * that lead to them; without one, empty folders stay so a new group can be seen and filled.
 * A group whose parent is missing, or that sits in a parent loop, is shown at the top level.
 */
export function connectionSections(
  all: Profile[],
  groups: Group[],
  query: string,
): ConnectionSections {
  const searching = query.trim() !== '';
  const profiles = all.filter((p) => matchesSession(p, query, groups)).sort(byOrder);
  const known = new Set(groups.map((g) => g.id));
  const children = new Map<string | null, Group[]>();
  const reachable = new Set<string>();
  const parentOf = (g: Group) => (g.parentId && known.has(g.parentId) ? g.parentId : null);
  for (const g of groups) children.set(parentOf(g), [...(children.get(parentOf(g)) ?? []), g]);
  const build = (group: Group): TreeFolder => {
    reachable.add(group.id);
    return {
      group,
      folders: (children.get(group.id) ?? [])
        .filter((g) => !reachable.has(g.id))
        .sort(byOrder)
        .map(build),
      profiles: profiles.filter((p) => p.groupId === group.id),
    };
  };
  const folders = (children.get(null) ?? []).sort(byOrder).map(build);
  // Groups only reachable through a loop never met the top level; give them one.
  for (const g of groups.filter((g) => !reachable.has(g.id)).sort(byOrder))
    if (!reachable.has(g.id)) folders.push(build(g));
  return {
    matches: profiles,
    favorites: profiles.filter((p) => p.favorite),
    recent: profiles
      .filter((p) => p.lastConnected)
      .sort((a, b) => (b.lastConnected ?? 0) - (a.lastConnected ?? 0))
      .slice(0, RECENT_LIMIT),
    folders: searching ? folders.filter(hasProfiles).map(prune) : folders,
    profiles: profiles.filter((p) => !p.groupId || !known.has(p.groupId)),
  };
}
const prune = (folder: TreeFolder): TreeFolder => ({
  ...folder,
  folders: folder.folders.filter(hasProfiles).map(prune),
});

/**
 * Sections and folders that the user folded: `favorites`, `recent`, `local`, `saved`, or a group
 * id. Recent starts folded, since its connections are also in their groups.
 */
const STORE = 'dachsterm.sidebar.folded';
export function readFolded(): Set<string> {
  try {
    const stored = localStorage.getItem(STORE);
    if (stored === null) return new Set(['recent']);
    const value: unknown = JSON.parse(stored);
    return new Set(
      Array.isArray(value)
        ? value.filter((k): k is string => typeof k === 'string' && k.length <= 100).slice(0, 500)
        : [],
    );
  } catch {
    // Unreadable or blocked storage: start with everything open.
    return new Set();
  }
}
export function writeFolded(folded: Set<string>) {
  try {
    localStorage.setItem(STORE, JSON.stringify([...folded]));
  } catch {
    // Blocked storage only loses the folding on the next start.
  }
}
