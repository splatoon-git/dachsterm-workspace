import { folderProblem } from '../../lib/shell';

/** The agent CLIs a chat runs, by their command names (design §1). */
export type ChatProgram = 'claude' | 'codex';
export const chatPrograms: readonly ChatProgram[] = ['claude', 'codex'];
const isProgram = (value: unknown): value is ChatProgram =>
  chatPrograms.includes(value as ChatProgram);

/**
 * Where a new chat opens from the title bar (design §9.7): a workspace is a saved SSH session or
 * this PC, with a folder, and the agent that ran there. An empty folder is the login or home folder.
 */
export type ChatWorkspace = { program: ChatProgram; folder: string } & (
  { kind: 'ssh'; profileId: string } | { kind: 'local' }
);

/**
 * `follow` opens where the focused terminal tab is; `fixed` always opens in `fixed`. Both, the
 * agent a new chat runs, and the recent workspaces are kept across restarts.
 */
export type ChatLaunch = {
  mode: 'follow' | 'fixed';
  fixed: ChatWorkspace | null;
  recent: ChatWorkspace[];
  program: ChatProgram;
};

export const chatLaunchKey = 'dachsterm.chatLaunch';
const maxRecent = 6;
export const defaultLaunch: ChatLaunch = {
  mode: 'follow',
  fixed: null,
  recent: [],
  program: 'claude',
};

/** A folder on this PC: a Windows path is fine, a control character or a huge value is not. */
const localFolder = (folder: string) => folder.length <= 4096 && !/\p{Cc}/u.test(folder);

function workspace(value: unknown): ChatWorkspace | null {
  if (!value || typeof value !== 'object') return null;
  const { kind, profileId, folder, program: saved } = value as Record<string, unknown>;
  if (typeof folder !== 'string') return null;
  // Saved before codex chats: those were all claude.
  const program = saved === undefined ? 'claude' : saved;
  if (!isProgram(program)) return null;
  if (kind === 'local') return localFolder(folder) ? { kind, folder, program } : null;
  if (kind !== 'ssh' || typeof profileId !== 'string' || !profileId || profileId.length > 200)
    return null;
  return folderProblem(folder) ? null : { kind, profileId, folder, program };
}

export const sameWorkspace = (a: ChatWorkspace, b: ChatWorkspace) =>
  a.kind === b.kind &&
  a.folder === b.folder &&
  a.program === b.program &&
  (a.kind === 'local' || (b.kind === 'ssh' && a.profileId === b.profileId));

/** Reads what was saved, dropping whatever does not check out. */
export function readLaunch(): ChatLaunch {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(chatLaunchKey) ?? 'null');
    if (!saved || typeof saved !== 'object') return defaultLaunch;
    const { mode, fixed, recent, program } = saved as Record<string, unknown>;
    const pinned = workspace(fixed);
    return {
      program: isProgram(program) ? program : 'claude',
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
    ...launch,
    mode: fixed ? launch.mode : 'follow',
    fixed,
    recent: launch.recent.filter(known),
  };
}

/** Takes a workspace off the recent list. The fixed one stays: it is chosen, not remembered. */
export const withoutRecent = (launch: ChatLaunch, gone: ChatWorkspace): ChatLaunch => ({
  ...launch,
  recent: launch.recent.filter((r) => !sameWorkspace(r, gone)),
});
