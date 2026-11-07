import { useSyncExternalStore } from 'react';
export type TerminalPreferences = {
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  followDirectory: boolean;
  backspace: 'del' | 'bs';
  /** Off by default: on a Mac, Option also types special characters. */
  macOptionAsMeta: boolean;
  /** Answers OSC 7501 and shows what the running program reports on its tab. */
  programStatus: boolean;
  /** Lets the focused program copy through OSC 52. Reading is never allowed. */
  clipboardWrite: boolean;
  /** OS notifications for status changes and notification sequences. */
  osNotifications: boolean;
  /** Treats the terminal bell as a notification too. */
  bellNotifications: boolean;
  /** Shows the keys of vi, vim, less and tail in the status bar while they run. */
  programGuide: boolean;
};
const defaults: TerminalPreferences = {
  copyOnSelect: true,
  rightClickPaste: true,
  followDirectory: true,
  backspace: 'del',
  macOptionAsMeta: false,
  programStatus: true,
  clipboardWrite: true,
  osNotifications: true,
  bellNotifications: true,
  programGuide: true,
};
export { isMac as isMacPlatform } from '../../lib/platform';
const key = 'dachsterm.terminalPreferences';
function read(): TerminalPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    return {
      copyOnSelect: typeof saved.copyOnSelect === 'boolean' ? saved.copyOnSelect : true,
      rightClickPaste: typeof saved.rightClickPaste === 'boolean' ? saved.rightClickPaste : true,
      followDirectory: typeof saved.followDirectory === 'boolean' ? saved.followDirectory : true,
      backspace: saved.backspace === 'bs' ? 'bs' : 'del',
      macOptionAsMeta: saved.macOptionAsMeta === true,
      programStatus: typeof saved.programStatus === 'boolean' ? saved.programStatus : true,
      clipboardWrite: typeof saved.clipboardWrite === 'boolean' ? saved.clipboardWrite : true,
      osNotifications: typeof saved.osNotifications === 'boolean' ? saved.osNotifications : true,
      bellNotifications:
        typeof saved.bellNotifications === 'boolean' ? saved.bellNotifications : true,
      programGuide: typeof saved.programGuide === 'boolean' ? saved.programGuide : true,
    };
  } catch {
    return defaults;
  }
}
let current = read();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
export type TerminalDisplay = { fontSize: number; scrollback: number };
const fontSizeKey = 'dachsterm.fontSize';
const scrollbackKey = 'dachsterm.scrollback';
export const minFontSize = 8;
export const maxFontSize = 32;
export const clampFontSize = (size: number) =>
  Math.min(maxFontSize, Math.max(minFontSize, Math.round(size)));
const fontSizePresets = [12, 14, 16, 18, 20, 24];
// Ctrl/Cmd+wheel can reach sizes between presets, and a select must still show the current one.
export const fontSizeChoices = (current: number) =>
  fontSizePresets.includes(current)
    ? fontSizePresets
    : [...fontSizePresets, current].sort((a, b) => a - b);
function readDisplay(): TerminalDisplay {
  try {
    return {
      fontSize: clampFontSize(Number(localStorage.getItem(fontSizeKey)) || 14),
      scrollback: Number(localStorage.getItem(scrollbackKey)) || 5000,
    };
  } catch {
    return { fontSize: 14, scrollback: 5000 };
  }
}
let display = readDisplay();
window.addEventListener('storage', (event) => {
  if (event.key === key || event.key === null) current = read();
  if (event.key === fontSizeKey || event.key === scrollbackKey || event.key === null)
    display = readDisplay();
  notify();
});
export const terminalDisplay = () => display;
// Storage events reach other windows only, so panes in this window rely on notify().
export function saveTerminalDisplay(patch: Partial<TerminalDisplay>) {
  if (patch.fontSize) localStorage.setItem(fontSizeKey, String(patch.fontSize));
  if (patch.scrollback) localStorage.setItem(scrollbackKey, String(patch.scrollback));
  display = { ...display, ...patch };
  notify();
}
export const subscribeTerminalPreferences = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const useTerminalDisplay = () =>
  useSyncExternalStore(subscribeTerminalPreferences, terminalDisplay);
export function saveTerminalPreferences(patch: Partial<TerminalPreferences>) {
  const next = { ...current, ...patch };
  localStorage.setItem(key, JSON.stringify(next));
  current = next;
  notify();
}
export const terminalPreferences = () => current;
export function useTerminalPreferences() {
  return useSyncExternalStore(subscribeTerminalPreferences, () => current);
}
/** `windowsPaths` is for local Windows shells, which report a drive or network share. */
export function directoryFromOsc(value: string, uri = true, windowsPaths = false): string | null {
  try {
    let path = value;
    if (uri) {
      const url = new URL(value);
      if (url.protocol !== 'file:' || url.username || url.password || url.search || url.hash)
        return null;
      path = decodeURIComponent(url.pathname);
      if (windowsPaths && /^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    }
    return (path.startsWith('/') || (windowsPaths && /^([A-Za-z]:[\\/]|\\\\)/.test(path))) &&
      path.length <= 4096 &&
      !Array.from(path).some((c) => c.charCodeAt(0) < 32 || c === '\x7f' || c === '\ufffd')
      ? path
      : null;
  } catch {
    return null;
  }
}
export const needsPasteConfirmation = (text: string) =>
  Array.from(text).some((c) => {
    const code = c.charCodeAt(0);
    return (code < 32 && code !== 9) || code === 127;
  });
