import { folderProblem } from '../../lib/shell';

/** Recent chat folders by saved session ID, newest first. Only folders a chat was opened in. */
export const chatFoldersKey = 'dachsterm.chatFolders';
const maxFolders = 8;
const maxSessions = 200;

type Saved = Record<string, string[]>;

function read(): Saved {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(chatFoldersKey) ?? 'null');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(
      Object.entries(saved).map(([id, folders]) => [
        id,
        Array.isArray(folders)
          ? folders
              .filter((f): f is string => typeof f === 'string' && !!f && !folderProblem(f))
              .slice(0, maxFolders)
          : [],
      ]),
    );
  } catch {
    // Blocked storage or a damaged value: the dialog still accepts a typed folder.
    return {};
  }
}

export const recentFolders = (profileId: string) => read()[profileId] ?? [];

/** Puts `folder` first for the session. The login folder (empty) is not worth remembering. */
export function rememberFolder(profileId: string, folder: string) {
  if (!folder || folderProblem(folder)) return;
  const saved = read();
  const folders = [folder, ...(saved[profileId] ?? []).filter((f) => f !== folder)];
  const next: Saved = { ...saved, [profileId]: folders.slice(0, maxFolders) };
  const ids = Object.keys(next);
  for (const id of ids.slice(0, Math.max(0, ids.length - maxSessions))) delete next[id];
  try {
    localStorage.setItem(chatFoldersKey, JSON.stringify(next));
  } catch {
    // Not remembering a folder costs only a retype next time.
  }
}
