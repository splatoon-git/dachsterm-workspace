import type { Group, Profile } from '../../lib/ipc';
import type { ImportSource } from '../../lib/settingsRequest';

/** A session source `config_detect` found on this PC (I.2). */
export type Found = {
  source: ImportSource;
  /** A file path or the registry key, to recognise it by. */
  place: string;
  count: number;
  /** Entries left out: other session kinds or settings the import does not take. */
  skipped: number;
  /** The SSH config has `Include` lines, picked on the preview. */
  include: boolean;
  problem: string | null;
};

const names: Record<ImportSource, [string, string]> = {
  putty: ['PuTTY', '세션'],
  bookmarks: ['세션 북마크', ''],
  openssh: ['OpenSSH config', '호스트'],
};

/** Something to preview: sessions, or Include files that may hold some. */
export const importable = (f: Found) => !f.problem && (f.count > 0 || f.include);

/** "PuTTY 세션 12개". With Include files, the count is the main file's only. */
export function foundText(f: Found): string {
  const [name, unit] = names[f.source];
  if (f.problem) return `${name} (읽지 못함)`;
  const include = f.include ? ' + Include 파일' : '';
  const skipped = f.skipped ? ` · 제외 ${f.skipped}개` : '';
  return `${[name, unit].filter(Boolean).join(' ')} ${f.count}개${include}${skipped}`;
}

/** Already saved: the same place and account, whatever the session is called. */
export function alreadySaved(p: Profile, saved: Profile[]): boolean {
  return saved.some(
    (s) =>
      (s.protocol ?? 'ssh') === (p.protocol ?? 'ssh') &&
      s.host.toLowerCase() === p.host.toLowerCase() &&
      s.port === p.port &&
      s.username === p.username,
  );
}

/**
 * Puts a whole import under one new top-level group named after the program it came from. The
 * program's own folders stay below it as they were.
 */
export function placeUnder<T extends { profiles: Profile[]; groups: Group[] }>(
  bundle: T,
  name: string,
  id: string = crypto.randomUUID(),
): T {
  if (!bundle.profiles.length) return bundle;
  return {
    ...bundle,
    groups: [
      { id, name, parentId: null, sortOrder: 0 },
      ...bundle.groups.map((g) => (g.parentId ? g : { ...g, parentId: id })),
    ],
    profiles: bundle.profiles.map((p) => (p.groupId ? p : { ...p, groupId: id })),
  };
}

const dismissedKey = 'dachsterm.importOffer.dismissed';

/** The connection list stops offering found sessions once the user said so. */
export function offerDismissed(): boolean {
  try {
    return localStorage.getItem(dismissedKey) === '1';
  } catch {
    // Without storage the offer shows again next time, which is harmless.
    return false;
  }
}
export function dismissOffer() {
  try {
    localStorage.setItem(dismissedKey, '1');
  } catch {
    // Without storage the offer is hidden only until the app restarts.
  }
}
