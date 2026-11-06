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
window.addEventListener('storage', (event) => {
  if (event.key === key || event.key === null) {
    current = read();
    notify();
  }
});
export function saveTerminalPreferences(patch: Partial<TerminalPreferences>) {
  const next = { ...current, ...patch };
  localStorage.setItem(key, JSON.stringify(next));
  current = next;
  notify();
}
export function useTerminalPreferences() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    () => current,
  );
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
