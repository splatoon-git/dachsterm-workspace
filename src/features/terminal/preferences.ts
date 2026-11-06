import { useSyncExternalStore } from 'react';
export type TerminalPreferences = {
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  followDirectory: boolean;
  backspace: 'del' | 'bs';
};
const defaults: TerminalPreferences = {
  copyOnSelect: true,
  rightClickPaste: true,
  followDirectory: true,
  backspace: 'del',
};
const key = 'dachsterm.terminalPreferences';
function read(): TerminalPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
    return {
      copyOnSelect: typeof saved.copyOnSelect === 'boolean' ? saved.copyOnSelect : true,
      rightClickPaste: typeof saved.rightClickPaste === 'boolean' ? saved.rightClickPaste : true,
      followDirectory: typeof saved.followDirectory === 'boolean' ? saved.followDirectory : true,
      backspace: saved.backspace === 'bs' ? 'bs' : 'del',
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
export function useTerminalPreferences() {
  return useSyncExternalStore(subscribeTerminalPreferences, () => current);
}
export function directoryFromOsc(value: string, uri = true): string | null {
  try {
    let path = value;
    if (uri) {
      const url = new URL(value);
      if (url.protocol !== 'file:' || url.username || url.password || url.search || url.hash)
        return null;
      path = decodeURIComponent(url.pathname);
    }
    return path.startsWith('/') &&
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

// A session-only prompt hook. No dotfiles or server settings are written.
export const directoryHook = `if [ -n "$BASH_VERSION" ]; then eval '__dachsterm_cwd() { printf "\\033]1337;CurrentDir=%s\\007" "$PWD"; }; [[ ";\${PROMPT_COMMAND[*]};" == *"__dachsterm_cwd"* ]] || PROMPT_COMMAND+=(__dachsterm_cwd)'; elif [ -n "$ZSH_VERSION" ]; then eval '__dachsterm_cwd() { printf "\\033]1337;CurrentDir=%s\\007" "$PWD"; }; (( \${precmd_functions[(Ie)__dachsterm_cwd]} )) || precmd_functions+=(__dachsterm_cwd)'; else printf '%s\\n' 'DachsTerm: 이 셸은 OSC 7 경로 알림을 별도로 설정해야 합니다.'; fi`;
