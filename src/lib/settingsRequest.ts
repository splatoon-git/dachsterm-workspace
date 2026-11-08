import type { Source } from './source';

export type SettingsSection =
  'appearance' | 'terminal' | 'git' | 'agents' | 'vault' | 'sessions' | 'transfer' | 'recovery';

/** A repository whose own `git config` the Git category opens on. */
export type SettingsRepo = { source: Source; folder: string };
export type SettingsRequest = { section: SettingsSection; repo?: SettingsRepo };

let listener: ((request: SettingsRequest) => void) | null = null;

/**
 * Opens the app's settings on a category from anywhere in the app. Windows without app settings
 * (a detached terminal) have no listener, and do not offer these links.
 */
export function requestSettings(request: SettingsRequest) {
  listener?.(request);
}

export function onSettingsRequest(handle: (request: SettingsRequest) => void) {
  listener = handle;
  return () => {
    if (listener === handle) listener = null;
  };
}
