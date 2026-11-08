import { useSyncExternalStore } from 'react';

/**
 * How Git shows up around the app (Settings → Git). `promptBranch` and `gitStatus` stay in the
 * terminal preferences, since the shell hook injected at connect time depends on them.
 */
export type GitDisplay = {
  /** What follows the branch on the prompt line and in the status bar. */
  detail: 'branch' | 'changes' | 'sync';
  treeMarks: 'letter' | 'color' | 'both';
  statusBar: boolean;
  /** How a query counts new files. The Git view always lists them one by one. */
  untracked: 'folders' | 'files';
};

const key = 'dachsterm.gitDisplay';
export const gitDisplayDefaults: GitDisplay = {
  detail: 'changes',
  treeMarks: 'letter',
  statusBar: true,
  untracked: 'folders',
};

const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T) =>
  allowed.includes(value as T) ? (value as T) : fallback;

function read(): GitDisplay {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    return {
      detail: pick(saved.detail, ['branch', 'changes', 'sync'], gitDisplayDefaults.detail),
      treeMarks: pick(saved.treeMarks, ['letter', 'color', 'both'], gitDisplayDefaults.treeMarks),
      statusBar: typeof saved.statusBar === 'boolean' ? saved.statusBar : true,
      untracked: pick(saved.untracked, ['folders', 'files'], gitDisplayDefaults.untracked),
    };
  } catch {
    // Blocked storage or a damaged value: the defaults are what the app showed before this setting.
    return gitDisplayDefaults;
  }
}

let current = read();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

// Storage events reach other windows only, so this window relies on notify().
window.addEventListener('storage', (event) => {
  if (event.key === key || event.key === null) {
    current = read();
    notify();
  }
});

export const gitDisplay = () => current;

/** Throws when storage is blocked, for the settings screen to say so. */
export function saveGitDisplay(patch: Partial<GitDisplay>) {
  const next = { ...current, ...patch };
  localStorage.setItem(key, JSON.stringify(next));
  current = next;
  notify();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useGitDisplay = () => useSyncExternalStore(subscribe, gitDisplay);
