import type { Source } from './source';

/**
 * What the Git view and open editor tabs tell each other. They sit in different features and
 * different parts of the window, and neither runs without the other being open.
 */
export type GitChange =
  /** A file was saved from a tab, so the Git view's list may be out of date. */
  | { kind: 'saved'; source: Source }
  /** The Git view changed the repository, so an open diff may compare with something else now. */
  | { kind: 'index'; source: Source; root: string };

const listeners = new Set<(change: GitChange) => void>();

export function notifyGitChange(change: GitChange) {
  listeners.forEach((listener) => listener(change));
}

export function subscribeGitChanges(listener: (change: GitChange) => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}
