import { getTheme } from './registry';

export const themeStorageKey = 'daxterm.theme';
function readTheme() {
  try {
    return getTheme(localStorage.getItem(themeStorageKey));
  } catch {
    return getTheme();
  }
}
let current = readTheme();
const listeners = new Set<() => void>();
export const getCurrentTheme = () => current;
function notify() {
  for (const listener of listeners) listener();
}
function sync(event: StorageEvent) {
  if (event.key === themeStorageKey || event.key === null) {
    current = readTheme();
    notify();
  }
}
export function subscribeTheme(listener: () => void) {
  if (!listeners.size) {
    window.addEventListener('storage', sync);
    // Catch changes between opening the window and React subscribing.
    current = readTheme();
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener('storage', sync);
  };
}
/** Apply in this window even if storage is unavailable; report persistence failure to the UI. */
export function selectTheme(id: string): boolean {
  current = getTheme(id);
  let saved = true;
  try {
    localStorage.setItem(themeStorageKey, current.id);
  } catch {
    saved = false;
  }
  notify();
  return saved;
}
