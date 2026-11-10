import { folderProblem } from '../../lib/shell';

/**
 * Where a new chat opens from the title bar (design §9.7): a workspace is a saved SSH session or
 * this PC, with a folder. An empty folder is the login or home folder.
 */
export type ChatWorkspace =
  { kind: 'ssh'; profileId: string; folder: string } | { kind: 'local'; folder: string };

/**
 * `follow` opens where the focused terminal tab is; `fixed` always opens in `fixed`. Both, and the
 * recent workspaces, are kept across restarts.
 */
export type ChatLaunch = {
  mode: 'follow' | 'fixed';
  fixed: ChatWorkspace | null;
  recent: ChatWorkspace[];
};

export const chatLaunchKey = 'dachsterm.chatLaunch';
const maxRecent = 6;
export const defaultLaunch: ChatLaunch = { mode: 'follow', fixed: null, recent: [] };

/** A folder on this PC: a Windows path is fine, a control character or a huge value is not. */
const localFolder = (folder: string) => folder.length <= 4096 && !/\p{Cc}/u.test(folder);

function workspace(value: unknown): ChatWorkspace | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, profileId, folder } = value as Record<string, unknown>;
  if (typeof folder !== 'string') return null;
  if (kind === 'local') return localFolder(folder) ? { kind, folder } : null;
  if (kind !== 'ssh' || typeof profileId !== 'string' || !profileId || profileId.length > 200)
    return null;
  return folderProblem(folder) ? null : { kind, profileId, folder };
}

export const sameWorkspace = (a: ChatWorkspace, b: ChatWorkspace) =>
  a.kind === b.kind &&
  a.folder === b.folder &&
  (a.kind === 'local' || (b.kind === 'ssh' && a.profileId === b.profileId));

/** Reads what was saved, dropping whatever does not check out. */
export function readLaunch(): ChatLaunch {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(chatLaunchKey) ?? 'null');
    if (!saved || typeof saved !== 'object') return defaultLaunch;
    const { mode, fixed, recent } = saved as Record<string, unknown>;
    const pinned = workspace(fixed);
    return {
      mode: mode === 'fixed' && pinned ? 'fixed' : 'follow',
      fixed: pinned,
      recent: Array.isArray(recent)
        ? recent.flatMap((r) => workspace(r) ?? []).slice(0, maxRecent)
        : [],
    };
  } catch {
    // Blocked storage or a damaged value: chats open where the focused tab is.
    return defaultLaunch;
  }
}

export function saveLaunch(launch: ChatLaunch) {
  try {
    localStorage.setItem(chatLaunchKey, JSON.stringify(launch));
  } catch {
    // The choice still holds until the app closes.
  }
}

/** Puts `opened` first among the recent workspaces. */
export const withRecent = (launch: ChatLaunch, opened: ChatWorkspace): ChatLaunch => ({
  ...launch,
  recent: [opened, ...launch.recent.filter((r) => !sameWorkspace(r, opened))].slice(0, maxRecent),
});

/** A saved session that was deleted takes its workspaces with it. */
export function withoutMissing(launch: ChatLaunch, profileIds: ReadonlySet<string>): ChatLaunch {
  const known = (w: ChatWorkspace) => w.kind === 'local' || profileIds.has(w.profileId);
  const fixed = launch.fixed && known(launch.fixed) ? launch.fixed : null;
  return {
    mode: fixed ? launch.mode : 'follow',
    fixed,
    recent: launch.recent.filter(known),
  };
}
